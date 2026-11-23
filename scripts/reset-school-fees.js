/**
 * Resets ONE school's fee data so it can be rebuilt cleanly:
 *   1. deletes all of the school's fee payments and fee discounts
 *   2. deletes all of the school's per-student fee installments
 *      (including duplicates and rows left behind by deleted fee plans)
 *   3. keeps fee categories, fee plans and Level-wide fee items
 *   4. regenerates installments ONCE from the school's current fee plans
 *   5. rewinds the school's receipt counter to its first old receipt
 *      number, so re-importing the same payment file in the same order
 *      gives the same receipt numbers parents already have
 *
 * Students, attendance, exams and every other school are not touched.
 *
 * Usage (from the app folder, e.g. /var/www/simpleschool):
 *   node scripts/reset-school-fees.js <schoolId>            preview only, changes nothing
 *   node scripts/reset-school-fees.js <schoolId> --apply    really do it
 *
 * Take a full backup first (Super Admin > Backup & Restore), and stop the
 * app while it runs (pm2 stop iqplus ... pm2 start iqplus).
 */
require("dotenv").config();
const db = require("../config/database");
const { assignPlanToLevel } = require("../services/feePlanGenerator");

const schoolId = Number(process.argv[2]);
const apply = process.argv.includes("--apply");

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function counts() {
    const one = async (sql) => (await get(sql, [schoolId])).n;
    return {
        payments: await one("SELECT COUNT(*) n FROM fee_payments WHERE school_id=?"),
        paymentTotal: await one("SELECT COALESCE(SUM(amount_paid),0) n FROM fee_payments WHERE school_id=?"),
        discounts: await one("SELECT COUNT(*) n FROM fee_discounts WHERE school_id=?"),
        studentInstallments: await one("SELECT COUNT(*) n FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL"),
        studentInstallmentTotal: await one("SELECT COALESCE(SUM(amount),0) n FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL"),
        levelWideItems: await one("SELECT COUNT(*) n FROM fee_structure WHERE school_id=? AND student_id IS NULL"),
        feePlans: await one("SELECT COUNT(*) n FROM fee_plans WHERE school_id=?")
    };
}

async function main() {
    await wait(1500); // let config/database.js finish its start-up migrations

    if (!schoolId) throw new Error("Give a school id, e.g. node scripts/reset-school-fees.js 3");
    const school = await get("SELECT id, name, receipt_no_next FROM schools WHERE id=?", [schoolId]);
    if (!school) throw new Error(`No school with id ${schoolId}`);

    console.log(`School ${school.id}: "${school.name.trim()}"`);
    console.log("Before:", await counts());

    // Exams can point at a fee item; refuse if any points at a row we would delete.
    const examRefs = await get(
        `SELECT COUNT(*) n FROM exams e JOIN fee_structure fs ON fs.id = e.fee_structure_id
         WHERE fs.school_id=? AND fs.student_id IS NOT NULL`, [schoolId]);
    if (examRefs.n > 0) throw new Error(`${examRefs.n} exam(s) reference per-student fee rows - stopping, nothing changed.`);

    const firstReceipt = await get(
        `SELECT MIN(CAST(SUBSTR(receipt_no, LENGTH(RTRIM(receipt_no, '0123456789')) + 1) AS INTEGER)) n
         FROM fee_payments WHERE school_id=? AND receipt_no IS NOT NULL`, [schoolId]);
    const rewindTo = firstReceipt && firstReceipt.n ? firstReceipt.n : school.receipt_no_next;
    console.log(`Receipt counter: ${school.receipt_no_next} -> ${rewindTo}`);

    if (!apply) {
        console.log("\nPREVIEW ONLY - nothing changed. Add --apply to run it.");
        return;
    }

    await run("BEGIN IMMEDIATE");
    try {
        await run("DELETE FROM fee_payments WHERE school_id=?", [schoolId]);
        await run("DELETE FROM fee_discounts WHERE school_id=?", [schoolId]);
        await run("DELETE FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL", [schoolId]);
        await run("UPDATE schools SET receipt_no_next=? WHERE id=?", [rewindTo, schoolId]);
        await run("COMMIT");
    } catch (e) {
        await run("ROLLBACK");
        throw e;
    }

    // Regenerate installments once per plan, one after another.
    const plans = await all("SELECT * FROM fee_plans WHERE school_id=? ORDER BY id", [schoolId]);
    for (const plan of plans) {
        const r = await assignPlanToLevel(plan, schoolId);
        console.log(`Plan ${plan.id}: ${r.totalPeriods} installments for ${r.assignedStudents} students (${r.skippedNoJoinDate} skipped, no Date of Joining)`);
    }

    const dupes = await get(
        `SELECT COUNT(*) n FROM (SELECT 1 FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL
         GROUP BY student_id, fee_category_id, installment_label HAVING COUNT(*) > 1)`, [schoolId]);
    console.log("After:", await counts());
    console.log(dupes.n === 0 ? "Check: no duplicate installments." : `WARNING: ${dupes.n} duplicate installment groups remain.`);
    console.log("\nDone. Now import the payment file ONCE from Collect Fees > Import.");
}

main().then(() => db.close()).catch(e => { console.error("FAILED:", e.message); db.close(); process.exitCode = 1; });
