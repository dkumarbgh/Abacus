/**
 * Rebuild one school's fee records from a correction file (JSON) made from
 * the school's own register. ONE transaction; without --apply it is rolled
 * back, so the preview shows exactly what would happen and saves nothing.
 *
 *   node scripts/rebuild-fees-from-register.js <correction.json>            (preview)
 *   node scripts/rebuild-fees-from-register.js <correction.json> --apply
 *
 * The file says:
 *   tags          who each fee category is for       {"ANNUAL PAYMENT":"Annual", ...}
 *   students      corrections to existing students   [{match:{admission_no}, set:{date_of_joining, level, fee_option, guardian_phone?}}]
 *   new_students  students missing from the system   [{admission_no, name, date_of_joining, level, fee_option, guardian_phone, ...}]
 *   payments      every payment in the register      [{student:{admission_no}, category, amount, date, mode, remarks}]
 *
 * Steps: tag fees -> correct / add students -> delete ALL of the school's
 * payments, discounts and per-student installments -> regenerate each
 * student's installments from their (corrected) date of joining and Fee
 * Payment Option -> record the register's payments. A tuition payment goes
 * to the installment for the month it was paid in if that month is still
 * owed, otherwise to the earliest month still owed.
 *
 * Take a full backup first and stop the app while it runs:
 *   pm2 stop iqplus   ...   pm2 start iqplus
 */
require("dotenv").config();
const fs = require("fs");
const db = require("../config/database");
const { assignExplicitOrActivePlans } = require("../services/feePlanGenerator");
const { normalizeFeeOption, feeAppliesToStudent } = require("../services/feeOption");
const { computeNetAmount } = require("../services/feeCalc");
const { assignNextReceiptNo } = require("../services/schoolSettings");

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const rupees = (n) => "Rs " + Math.round(n).toLocaleString("en-IN");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function summary(schoolId) {
    const students = await all("SELECT * FROM students WHERE school_id=? ORDER BY CAST(admission_no AS INTEGER), name", [schoolId]);
    const items = await all("SELECT fs.*, fc.fee_name FROM fee_structure fs JOIN fee_categories fc ON fc.id=fs.fee_category_id WHERE fs.school_id=?", [schoolId]);
    const pays = await all("SELECT * FROM fee_payments WHERE school_id=?", [schoolId]);
    const discs = await all("SELECT * FROM fee_discounts WHERE school_id=?", [schoolId]);
    const money = new Set([...pays, ...discs].map(x => x.student_id + "|" + x.fee_structure_id));
    const today = new Date().toISOString().slice(0, 10);
    const rows = []; let T = 0, P = 0, B = 0, DN = 0;
    for (const s of students) {
        const mine = items.filter(fs =>
            ((fs.student_id == null && fs.class_id != null && fs.class_id === s.class_id) ||
             (fs.student_id == null && fs.level_id != null && fs.level_id === s.level_id) ||
             fs.student_id === s.id) &&
            (feeAppliesToStudent(fs, s) || money.has(s.id + "|" + fs.id)));
        let total = 0, paid = 0, due = 0, excess = 0, dueNow = 0;
        for (const fs of mine) {
            const d = discs.find(x => x.student_id === s.id && x.fee_structure_id === fs.id);
            const net = computeNetAmount(fs.amount, d);
            const p = pays.filter(x => x.student_id === s.id && x.fee_structure_id === fs.id).reduce((a, x) => a + x.amount_paid, 0);
            total += net; paid += p; due += Math.max(net - p, 0); excess += Math.max(p - net, 0);
            const dd = fs.due_date || s.fee_due_date || s.date_of_joining; // same order as the reports
            if (!dd || dd <= today) dueNow += Math.max(net - p, 0);
        }
        const bal = Math.max(due - excess, 0);
        T += total; P += paid; B += bal; DN += Math.max(dueNow - excess, 0);
        rows.push({ s, total, paid, bal, dueNow: Math.max(dueNow - excess, 0) });
    }
    return { rows, T, P, B, DN };
}

async function main() {
    await db.ready;
    if (!file) throw new Error("Give the correction file, e.g. node scripts/rebuild-fees-from-register.js siddharthanagar-correction.json");
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    const schoolId = Number(plan.school_id);
    const school = await get("SELECT id, name FROM schools WHERE id=?", [schoolId]);
    if (!school) throw new Error(`No school with id ${schoolId}`);
    console.log(`School ${school.id}: "${school.name.trim()}"   (${apply ? "APPLYING" : "PREVIEW - nothing will be saved"})`);

    const before = await summary(schoolId);
    console.log(`\nBefore: ${before.s ? "" : ""}Total ${rupees(before.T)} | Collected ${rupees(before.P)} | Balance ${rupees(before.B)}`);

    const examRefs = await get(
        `SELECT COUNT(*) n FROM exams e JOIN fee_structure fs ON fs.id = e.fee_structure_id
         WHERE fs.school_id=? AND fs.student_id IS NOT NULL`, [schoolId]);
    if (examRefs.n > 0) throw new Error(`${examRefs.n} exam(s) point at per-student fee rows - stopping, nothing changed.`);

    const levels = await all("SELECT id, name FROM lookup_items WHERE school_id=? AND list_type='level'", [schoolId]);
    const levelId = (name) => {
        if (name == null) return undefined;
        const l = levels.find(x => x.name.trim().toLowerCase() === String(name).trim().toLowerCase());
        if (!l) throw new Error(`No Level called "${name}" in this school`);
        return l.id;
    };
    const classes = await all("SELECT id, class_name FROM classes WHERE school_id=?", [schoolId]);
    const classFor = (std) => {
        const n = std && String(std).match(/\d+/);
        const c = n && classes.find(x => x.class_name.trim() === n[0]);
        return c ? c.id : null;
    };

    await run("BEGIN IMMEDIATE");
    try {
        // 1. Who each fee category is for.
        for (const [cat, who] of Object.entries(plan.tags || {})) {
            const value = normalizeFeeOption(who);
            if (value === undefined) throw new Error(`"${who}" isn't Annual, Monthly or All`);
            const fc = await get("SELECT id FROM fee_categories WHERE school_id=? AND LOWER(TRIM(fee_name))=LOWER(TRIM(?))", [schoolId, cat]);
            if (!fc) throw new Error(`No fee category "${cat}"`);
            await run("UPDATE fee_structure SET applies_to=? WHERE school_id=? AND fee_category_id=? AND student_id IS NULL", [value, schoolId, fc.id]);
            await run("UPDATE fee_plans SET applies_to=? WHERE school_id=? AND fee_category_id=?", [value, schoolId, fc.id]);
            console.log(`${cat}: for ${value || "All"} students`);
        }

        // 2. Correct existing students.
        console.log("\nStudent corrections:");
        for (const s of plan.students || []) {
            const st = await get("SELECT s.*, l.name AS level_name FROM students s LEFT JOIN lookup_items l ON l.id=s.level_id WHERE s.school_id=? AND s.admission_no=?", [schoolId, s.match.admission_no]);
            if (!st) throw new Error(`No student with roll number ${s.match.admission_no}`);
            const set = s.set || {};
            const changes = [];
            const lv = set.level !== undefined ? levelId(set.level) : st.level_id;
            const opt = set.fee_option !== undefined ? normalizeFeeOption(set.fee_option) : st.fee_option;
            const doj = set.date_of_joining || st.date_of_joining;
            const phone = set.guardian_phone || st.guardian_phone;
            if (doj !== st.date_of_joining) changes.push(`joined ${st.date_of_joining} -> ${doj}`);
            if (lv !== st.level_id) changes.push(`level ${st.level_name} -> ${set.level}`);
            if ((opt || null) !== (st.fee_option || null)) changes.push(`option -> ${opt}`);
            if (phone !== st.guardian_phone) changes.push(`phone ${st.guardian_phone} -> ${phone}`);
            await run("UPDATE students SET date_of_joining=?, level_id=?, fee_option=?, guardian_phone=? WHERE id=?", [doj, lv, opt || null, phone, st.id]);
            console.log(`  ${String(st.admission_no).padEnd(4)} ${st.name.padEnd(24)} ${changes.join("; ") || "no change"}`);
        }

        // 3. Add missing students.
        for (const n of plan.new_students || []) {
            const exists = await get("SELECT id FROM students WHERE school_id=? AND (admission_no=? OR LOWER(TRIM(name))=LOWER(TRIM(?)))", [schoolId, n.admission_no, n.name]);
            if (exists) throw new Error(`"${n.name}" / roll ${n.admission_no} already exists`);
            const fam = String(n.family || "");
            const father = (fam.match(/F\s*:\s*(.*?)\s*M\s*:/i) || [])[1] || null;
            const mother = (fam.match(/M\s*:\s*(.*)$/i) || [])[1] || null;
            await run(
                `INSERT INTO students (name, admission_no, date_of_joining, level_id, fee_option, guardian_phone, guardian_phone_2, father_name, mother_name, class_id, school_id)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [n.name, n.admission_no, n.date_of_joining, levelId(n.level), normalizeFeeOption(n.fee_option) || null, n.guardian_phone || null, n.guardian_phone_2 || null,
                 father && father.trim(), mother && mother.trim(), classFor(n.standard), schoolId]);
            console.log(`  NEW  ${n.name} (roll ${n.admission_no}), joined ${n.date_of_joining}, level ${n.level}, ${n.fee_option}`);
        }

        // 4. Clear the school's payments, discounts and per-student installments.
        const firstReceipt = await get(
            `SELECT MIN(CAST(SUBSTR(receipt_no, LENGTH(RTRIM(receipt_no, '0123456789')) + 1) AS INTEGER)) n
             FROM fee_payments WHERE school_id=? AND receipt_no IS NOT NULL`, [schoolId]);
        const delP = await run("DELETE FROM fee_payments WHERE school_id=?", [schoolId]);
        const delD = await run("DELETE FROM fee_discounts WHERE school_id=?", [schoolId]);
        const delI = await run("DELETE FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL", [schoolId]);
        if (firstReceipt && firstReceipt.n) await run("UPDATE schools SET receipt_no_next=? WHERE id=?", [firstReceipt.n, schoolId]);
        console.log(`\nCleared ${delP.changes} payments, ${delD.changes} discounts, ${delI.changes} installments`);

        // 5. Regenerate installments.
        const students = await all("SELECT id, fee_plan_id FROM students WHERE school_id=?", [schoolId]);
        for (const s of students) await assignExplicitOrActivePlans(s.id, schoolId, s.fee_plan_id);
        const inst = await get("SELECT COUNT(*) n FROM fee_structure WHERE school_id=? AND student_id IS NOT NULL", [schoolId]);
        console.log(`Regenerated ${inst.n} installments`);

        // 6. Record the register's payments.
        const paidOn = new Map(); // student|fee_structure_id -> amount recorded so far (Level fees are shared rows)
        let added = 0, addedAmt = 0;
        for (const p of plan.payments || []) {
            const st = await get("SELECT * FROM students WHERE school_id=? AND admission_no=?", [schoolId, p.student.admission_no]);
            if (!st) throw new Error(`Payment for unknown roll number ${p.student.admission_no} (${p.name})`);
            const fc = await get("SELECT id FROM fee_categories WHERE school_id=? AND LOWER(TRIM(fee_name))=LOWER(TRIM(?))", [schoolId, p.category]);
            if (!fc) throw new Error(`No fee category "${p.category}"`);
            const cands = (await all(
                `SELECT * FROM fee_structure WHERE school_id=? AND fee_category_id=?
                   AND (student_id=? OR (student_id IS NULL AND level_id=?))
                 ORDER BY COALESCE(due_date,''), id`, [schoolId, fc.id, st.id, st.level_id]))
                .filter(fs => feeAppliesToStudent(fs, st))
                .map(fs => ({ ...fs, left: fs.amount - (paidOn.get(st.id + "|" + fs.id) || 0) }))
                .filter(fs => fs.left > 0);
            if (!cands.length) throw new Error(`${st.name}: no ${p.category} still owed for the Rs ${p.amount} paid on ${p.date} - check the register`);
            const label = MONTHS[Number(p.date.slice(5, 7)) - 1] + " " + p.date.slice(0, 4);
            const target = cands.find(c => c.installment_label === label && c.left >= p.amount) || cands[0];
            if (p.amount > target.left) throw new Error(`${st.name}: Rs ${p.amount} on ${p.date} is more than the Rs ${target.left} left on ${p.category} ${target.installment_label || ""}`);
            const receipt = await assignNextReceiptNo(schoolId);
            await run(
                `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [st.id, target.id, p.amount, p.date, p.mode, receipt, p.remarks || null, schoolId]);
            paidOn.set(st.id + "|" + target.id, (paidOn.get(st.id + "|" + target.id) || 0) + p.amount);
            added++; addedAmt += p.amount;
        }
        console.log(`Recorded ${added} payments, ${rupees(addedAmt)}`);

        const after = await summary(schoolId);
        console.log(`\nAfter: Total ${rupees(after.T)} | Collected ${rupees(after.P)} | Balance ${rupees(after.B)} | Due as of today ${rupees(after.DN)}`);
        console.log("\nPer student (after):");
        for (const r of after.rows) {
            console.log(`  ${String(r.s.admission_no || "").padEnd(4)} ${r.s.name.padEnd(24)} ${(r.s.fee_option || "-").padEnd(8)} joined ${r.s.date_of_joining}  Total ${rupees(r.total).padStart(10)}  Paid ${rupees(r.paid).padStart(9)}  Balance ${rupees(r.bal).padStart(10)}  Due now ${rupees(r.dueNow).padStart(9)}`);
        }
        if (plan.notes && plan.notes.length) { console.log("\nAssumptions to confirm:"); plan.notes.forEach(n => console.log("  - " + n)); }

        if (apply) {
            await run(
                `INSERT INTO audit_logs (school_id, user_name, entity_type, entity_name, action, details)
                 VALUES (?, 'System (rebuild-fees-from-register)', 'Fee Payment', 'All payments', 'Updated', ?)`,
                [schoolId, `Fee records rebuilt from the school register (${file}). Before: collected ${rupees(before.P)}. After: ${added} payments, collected ${rupees(after.P)}, balance ${rupees(after.B)}.`]);
            await run("COMMIT");
            console.log("\nSaved.");
        } else {
            await run("ROLLBACK");
            console.log("\nPreview only - nothing was saved. Add --apply to the same command to do it.");
        }
    } catch (e) {
        await run("ROLLBACK").catch(() => {});
        throw e;
    }
}

main().then(() => process.exit(0)).catch(e => { console.error("ERROR:", e.message); process.exit(1); });
