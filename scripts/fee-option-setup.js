/**
 * One-off setup for the Fee Payment Option (Annual / Monthly) on ONE school:
 *
 *   --annual "<roll no or name>,..."      put these students on Annual fees
 *   --rest-monthly                         every other student with no option yet -> Monthly
 *   --for "<FEE CATEGORY>=Annual;<FEE CATEGORY>=Monthly;<FEE CATEGORY>=All"
 *                                          who each Level fee / Fee Plan of that category is for
 *   --annual-discount "<FEE CATEGORY>=<amount>"
 *                                          flat discount for every Annual student on that
 *                                          Level fee (e.g. "BOOK KIT FEE=2000")
 *   --delete-receipts "RCPT-0285,RCPT-0286"
 *                                          delete these payments (test entries). Stops if any
 *                                          receipt isn't found in this school.
 *
 * Afterwards every student's fee-plan periods are re-synced: periods are added
 * where a plan now applies, and UNPAID periods are removed where it no longer
 * does. Paid or discounted periods are never removed.
 *
 * Everything runs in ONE transaction. Without --apply it is rolled back, so
 * the preview shows exactly what would happen and changes nothing.
 *
 * Usage (from the app folder, e.g. /var/www/simpleschool):
 *   node scripts/fee-option-setup.js 3 --rest-monthly --for "ANNUAL PAYMENT=Annual;TUITION FEE=Monthly"
 *   ...same command... --apply
 *
 * Take a full backup first (Super Admin > Backup & Restore), and stop the app
 * while it runs (pm2 stop iqplus ... pm2 start iqplus).
 */
require("dotenv").config();
const db = require("../config/database");
const { assignExplicitOrActivePlans } = require("../services/feePlanGenerator");
const { normalizeFeeOption, feeAppliesToStudent } = require("../services/feeOption");
const { computeNetAmount } = require("../services/feeCalc");

const args = process.argv.slice(2);
const schoolId = Number(args[0]);
const apply = args.includes("--apply");
const opt = (name) => { const i = args.indexOf(name); return i > 0 && i + 1 < args.length ? args[i + 1] : null; };
const list = (v) => (v || "").split(/[,;]/).map(x => x.trim()).filter(Boolean);

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const rupees = (n) => "Rs " + Math.round(n).toLocaleString("en-IN");

// Total / Collected / Balance for the school, the same rule the reports use.
async function summary() {
    const students = await all("SELECT * FROM students WHERE school_id=? ORDER BY CAST(admission_no AS INTEGER), name", [schoolId]);
    const items = await all("SELECT fs.*, fc.fee_name FROM fee_structure fs JOIN fee_categories fc ON fc.id=fs.fee_category_id WHERE fs.school_id=?", [schoolId]);
    const pays = await all("SELECT * FROM fee_payments WHERE school_id=?", [schoolId]);
    const discs = await all("SELECT * FROM fee_discounts WHERE school_id=?", [schoolId]);
    const money = new Set([...pays, ...discs].map(x => x.student_id + "|" + x.fee_structure_id));
    const rows = [];
    let T = 0, P = 0, B = 0;
    for (const s of students) {
        const mine = items.filter(fs =>
            ((fs.student_id == null && fs.class_id != null && fs.class_id === s.class_id) ||
             (fs.student_id == null && fs.level_id != null && fs.level_id === s.level_id) ||
             fs.student_id === s.id) &&
            (feeAppliesToStudent(fs, s) || money.has(s.id + "|" + fs.id)));
        let total = 0, paid = 0, due = 0, excess = 0;
        const byFee = {};
        for (const fs of mine) {
            const d = discs.find(x => x.student_id === s.id && x.fee_structure_id === fs.id);
            const net = computeNetAmount(fs.amount, d);
            const p = pays.filter(x => x.student_id === s.id && x.fee_structure_id === fs.id).reduce((a, x) => a + x.amount_paid, 0);
            total += net; paid += p; due += Math.max(net - p, 0); excess += Math.max(p - net, 0);
            byFee[fs.fee_name] = (byFee[fs.fee_name] || 0) + net;
        }
        const bal = Math.max(due - excess, 0);
        T += total; P += paid; B += bal;
        rows.push({ s, total, paid, bal, byFee });
    }
    return { rows, T, P, B };
}

function printSummary(title, sm) {
    console.log(`\n${title}: Total ${rupees(sm.T)} | Collected ${rupees(sm.P)} | Balance ${rupees(sm.B)}`);
}

async function main() {
    await db.ready;
    if (!schoolId) throw new Error('Give a school id, e.g. node scripts/fee-option-setup.js 3 --rest-monthly');
    const school = await get("SELECT id, name FROM schools WHERE id=?", [schoolId]);
    if (!school) throw new Error(`No school with id ${schoolId}`);
    console.log(`School ${school.id}: "${school.name.trim()}"   (${apply ? "APPLYING" : "PREVIEW - nothing will be saved"})`);

    const before = await summary();
    printSummary("Before", before);

    await run("BEGIN IMMEDIATE");
    try {
        // 1. Delete test payments by receipt number.
        const receipts = list(opt("--delete-receipts"));
        if (receipts.length) {
            const found = await all(
                `SELECT p.id, p.receipt_no, p.amount_paid, p.payment_date, s.name, fc.fee_name
                 FROM fee_payments p JOIN students s ON s.id=p.student_id
                 JOIN fee_structure fs ON fs.id=p.fee_structure_id JOIN fee_categories fc ON fc.id=fs.fee_category_id
                 WHERE p.school_id=? AND p.receipt_no IN (${receipts.map(() => "?").join(",")})`, [schoolId, ...receipts]);
            const missing = receipts.filter(r => !found.some(f => f.receipt_no === r));
            if (missing.length) throw new Error(`Receipt(s) not found in this school: ${missing.join(", ")} - stopping, nothing changed.`);
            console.log(`\nDeleting ${found.length} payment(s), ${rupees(found.reduce((a, f) => a + f.amount_paid, 0))}:`);
            found.forEach(f => console.log(`  ${f.receipt_no}  ${f.name.padEnd(22)} ${f.fee_name.padEnd(16)} ${f.payment_date}  ${rupees(f.amount_paid)}`));
            await run(`DELETE FROM fee_payments WHERE school_id=? AND id IN (${found.map(() => "?").join(",")})`, [schoolId, ...found.map(f => f.id)]);
        }

        // 2. Who each fee category is for.
        for (const pair of list(opt("--for"))) {
            const [cat, who] = pair.split("=").map(x => (x || "").trim());
            const value = normalizeFeeOption(who);
            if (value === undefined) throw new Error(`"${who}" isn't Annual, Monthly or All (in --for)`);
            const fc = await get("SELECT id FROM fee_categories WHERE school_id=? AND LOWER(TRIM(fee_name))=LOWER(TRIM(?))", [schoolId, cat]);
            if (!fc) throw new Error(`No fee category "${cat}" in this school`);
            const a = await run("UPDATE fee_structure SET applies_to=? WHERE school_id=? AND fee_category_id=? AND student_id IS NULL", [value, schoolId, fc.id]);
            const b = await run("UPDATE fee_plans SET applies_to=? WHERE school_id=? AND fee_category_id=?", [value, schoolId, fc.id]);
            console.log(`\n${cat}: now for ${value || "All"} students (${a.changes} Level fee item(s), ${b.changes} Fee Plan(s))`);
        }

        // 3. Students' options.
        const annual = list(opt("--annual"));
        for (const who of annual) {
            const matches = await all(
                "SELECT id, name FROM students WHERE school_id=? AND (LOWER(TRIM(admission_no))=LOWER(TRIM(?)) OR LOWER(TRIM(name))=LOWER(TRIM(?)))",
                [schoolId, who, who]);
            if (matches.length !== 1) throw new Error(`"${who}" matches ${matches.length} students - use the roll number`);
            await run("UPDATE students SET fee_option='Annual' WHERE id=?", [matches[0].id]);
        }
        if (annual.length) console.log(`\nAnnual: ${annual.length} student(s)`);
        if (args.includes("--rest-monthly")) {
            const r = await run("UPDATE students SET fee_option='Monthly' WHERE school_id=? AND COALESCE(fee_option,'')=''", [schoolId]);
            console.log(`Monthly: ${r.changes} student(s) with no option yet`);
        }

        // 4. Discount for Annual students on a Level fee.
        const disc = opt("--annual-discount");
        if (disc) {
            const [cat, amt] = disc.split("=").map(x => (x || "").trim());
            const amount = Number(amt);
            if (!(amount > 0)) throw new Error(`Bad amount in --annual-discount "${disc}"`);
            const targets = await all(
                `SELECT s.id AS sid, s.name, fs.id AS fsid FROM students s
                 JOIN fee_structure fs ON fs.school_id=s.school_id AND fs.student_id IS NULL AND fs.level_id=s.level_id
                 JOIN fee_categories fc ON fc.id=fs.fee_category_id
                 WHERE s.school_id=? AND s.fee_option='Annual' AND LOWER(TRIM(fc.fee_name))=LOWER(TRIM(?))`, [schoolId, cat]);
            for (const t of targets) {
                await run(
                    `INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id)
                     VALUES (?,?,'FLAT',?,?,?)
                     ON CONFLICT(student_id, fee_structure_id) DO UPDATE SET discount_type='FLAT', discount_value=excluded.discount_value, reason=excluded.reason`,
                    [t.sid, t.fsid, amount, "Annual fee students", schoolId]);
            }
            console.log(`\n${cat}: ${rupees(amount)} discount for ${targets.length} Annual student(s)`);
        }

        // 5. Re-sync every student's fee-plan periods.
        const students = await all("SELECT id, fee_plan_id FROM students WHERE school_id=?", [schoolId]);
        const before5 = (await get("SELECT COUNT(*) n FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL", [schoolId])).n;
        for (const s of students) await assignExplicitOrActivePlans(s.id, schoolId, s.fee_plan_id);
        const after5 = (await get("SELECT COUNT(*) n FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL", [schoolId])).n;
        console.log(`\nFee-plan periods: ${before5} -> ${after5}`);

        const after = await summary();
        printSummary("After", after);
        console.log("\nPer student (after):");
        for (const r of after.rows) {
            const b = before.rows.find(x => x.s.id === r.s.id);
            const changed = !b || Math.round(b.total) !== Math.round(r.total) || Math.round(b.paid) !== Math.round(r.paid) || Math.round(b.bal) !== Math.round(r.bal);
            console.log(`  ${String(r.s.admission_no || "").padEnd(5)} ${r.s.name.padEnd(22)} ${(r.s.fee_option || "-").padEnd(8)} Total ${rupees(r.total).padStart(10)}  Paid ${rupees(r.paid).padStart(10)}  Balance ${rupees(r.bal).padStart(10)}${changed && b ? `   (was ${rupees(b.total)} / ${rupees(b.paid)} / ${rupees(b.bal)})` : ""}`);
        }

        if (apply) {
            await run(
                `INSERT INTO audit_logs (school_id, user_name, entity_type, entity_name, action, details)
                 VALUES (?, 'System (fee-option-setup script)', 'Fee Structure', 'Fee Payment Option', 'Updated', ?)`,
                [schoolId, `Options/fees set up: ${args.slice(1).filter(a => a !== "--apply").join(" ")}. Before: total ${rupees(before.T)}, collected ${rupees(before.P)}. After: total ${rupees(after.T)}, collected ${rupees(after.P)}.`]);
            await run("COMMIT");
            console.log("\nSaved.");
        }
        else { await run("ROLLBACK"); console.log("\nPreview only - nothing was saved. Add --apply to the same command to do it."); }
    } catch (e) {
        await run("ROLLBACK").catch(() => {});
        throw e;
    }
}

main().then(() => process.exit(0)).catch(e => { console.error("ERROR:", e.message); process.exit(1); });
