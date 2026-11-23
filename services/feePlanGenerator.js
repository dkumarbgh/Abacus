const db = require("../config/database");

/**
 * Fee Plans generate a STUDENT'S OWN fee periods starting from their
 * actual Date of Joining, rather than a fixed calendar template applied
 * to everyone in a Level - see config/database.js (fee_plans table) for
 * the "why".
 *
 * Every student on a plan gets the SAME LENGTH of schedule (duration_months,
 * default 12), counted from their own Date of Joining - joining in July
 * means periods run July through the following June, not to some shared
 * calendar date. That means correcting a student's Date of Joining (or
 * re-running "Assign to Missing Students") needs to be able to reshape
 * their schedule, not just add to it.
 *
 * Safety rule: assignPlanToStudent() SYNCS a student's periods to match
 * their current Date of Joining, but a period is only ever removed if it
 * has NO payment and NO discount recorded against it. A period that's
 * already been paid or discounted is never touched, even if it no longer
 * matches what the corrected schedule says - so fixing a join date can
 * reshape someone's upcoming/unpaid periods, but can never silently
 * erase money already collected.
 */

const SPAN_MONTHS_BY_MODE = { monthly: 1, bimonthly: 2, quarterly: 3, half_yearly: 6 };
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** "2026-2027" -> Date for March 31, 2027 (Indian academic-year convention) - only used as a fallback for plans created before duration_months/end_date existed. */
function academicYearEnd(academicYear) {
    const parts = academicYear.split("-");
    const endYear = parseInt(parts[1] || parts[0]);
    return new Date(`${endYear}-03-31T00:00:00`);
}

function addMonths(date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
}

function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatPeriodLabel(startDate, spanMonths) {
    if (spanMonths === 1) return `${MONTH_NAMES[startDate.getMonth()]} ${startDate.getFullYear()}`;
    const endDate = addMonths(startDate, spanMonths - 1);
    return `${MONTH_NAMES[startDate.getMonth()]} ${startDate.getFullYear()} - ${MONTH_NAMES[endDate.getMonth()]} ${endDate.getFullYear()}`;
}

/**
 * Computes the list of {label, amount} periods a student on this plan
 * owes, starting from their OWN join date and running for the plan's
 * duration (default 12 months) - so every student gets a full year of
 * their own periods, regardless of when they joined. Pure computation,
 * no DB access - easy to unit-test.
 */
function computePeriods(plan, joinDateStr) {
    const spanMonths = SPAN_MONTHS_BY_MODE[plan.payment_mode];
    if (!spanMonths) return []; // 'single' plans don't apply here - see the existing "One Amount" tab instead

    const startDate = new Date(`${joinDateStr}T00:00:00`);
    if (isNaN(startDate.getTime())) return [];

    let periodCount;
    if (plan.duration_months) {
        periodCount = Math.max(1, Math.round(plan.duration_months / spanMonths));
    } else {
        // Fallback for a plan created before duration_months existed -
        // count how many periods fit between the join date and the
        // plan's old-style end_date/academic-year cutoff.
        const cutoff = plan.end_date ? new Date(`${plan.end_date}T00:00:00`) : academicYearEnd(plan.academic_year);
        if (isNaN(cutoff.getTime())) return [];
        periodCount = 0;
        let cursor = new Date(startDate.getTime());
        while (cursor <= cutoff && periodCount < 60) {
            cursor = addMonths(cursor, spanMonths);
            periodCount++;
        }
    }

    const periods = [];
    let cursor = new Date(startDate.getTime());
    for (let i = 0; i < periodCount; i++) {
        // dueDate = the day this period starts (join date + N months). Without it,
        // plan installments never appeared in the Fees Due report and every
        // future month counted as "pending" straight away.
        periods.push({ label: formatPeriodLabel(cursor, spanMonths), amount: plan.amount_per_period, dueDate: toYMD(cursor) });
        cursor = addMonths(cursor, spanMonths);
    }
    return periods;
}

function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

/**
 * Syncs one student's periods for one plan to match their CURRENT Date
 * of Joining. Adds whatever periods are missing, and removes any
 * existing period that no longer matches the current schedule (e.g. left
 * over from before a join-date correction) - but ONLY if that period has
 * no payment or discount recorded against it. Safe to call repeatedly.
 * Returns { inserted, removed } (both 0 if the student has no join date,
 * isn't in the plan's Level, or already matches exactly).
 */
/*
 * One student's installments must never be generated by two calls at the
 * same time. Each call reads "which months exist?" and then inserts the
 * missing ones - two overlapping calls (e.g. the same student file imported
 * twice in parallel, or a double-clicked Save) both saw "none" and both
 * inserted a full year, which tripled one school's fees in production.
 * The app runs as a single Node process, so a per-student promise chain is
 * enough to make the calls run one after another.
 */
const studentLocks = new Map();
function withStudentLock(studentId, fn) {
    const key = String(studentId);
    const prev = studentLocks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    studentLocks.set(key, tail);
    tail.then(() => { if (studentLocks.get(key) === tail) studentLocks.delete(key); });
    return next;
}

function assignPlanToStudent(studentId, plan, schoolId) {
    return withStudentLock(studentId, () => assignPlanToStudentUnlocked(studentId, plan, schoolId));
}

async function assignPlanToStudentUnlocked(studentId, plan, schoolId) {

    const student = await dbGet("SELECT date_of_joining, level_id FROM students WHERE id=? AND school_id=?", [studentId, schoolId]);
    if (!student || !student.date_of_joining) return { inserted: 0, removed: 0 };
    if (String(student.level_id) !== String(plan.level_id)) return { inserted: 0, removed: 0 };

    let wanted = computePeriods(plan, student.date_of_joining);

    // Promoted INTO this plan's Level? Then this plan only applies from the
    // promotion date - months before that were billed under the old Level.
    const promo = await dbGet(
        "SELECT MAX(changed_date) AS d FROM level_history WHERE school_id=? AND student_id=? AND new_level_id=?",
        [schoolId, studentId, plan.level_id]);
    if (promo && promo.d) {
        wanted = wanted.filter(p => p.dueDate >= promo.d);
        // ...and never bill a month twice: skip a month this student already
        // has for the same fee from another plan (e.g. their old Level's).
        const otherMonths = await dbAll(
            `SELECT installment_label FROM fee_structure
             WHERE student_id=? AND fee_category_id=? AND installment_label IS NOT NULL
               AND (fee_plan_id IS NULL OR fee_plan_id <> ?)`,
            [studentId, plan.fee_category_id, plan.id]);
        const taken = new Set(otherMonths.map(r => r.installment_label));
        wanted = wanted.filter(p => !taken.has(p.label));
    }
    const wantedLabels = new Set(wanted.map(p => p.label));

    let existing = await dbAll(
        "SELECT id, installment_label, due_date FROM fee_structure WHERE student_id=? AND fee_plan_id=? ORDER BY id",
        [studentId, plan.id]
    );

    // Self-heal duplicates left by the old race: if the same month exists more
    // than once, keep one copy (preferring one with a payment/discount) and
    // delete the extra copies that have no financial activity.
    let removed = 0;
    const byLabel = new Map();
    for (const row of existing) {
        if (!byLabel.has(row.installment_label)) byLabel.set(row.installment_label, []);
        byLabel.get(row.installment_label).push(row);
    }
    for (const rows of byLabel.values()) {
        if (rows.length < 2) continue;
        const withMoney = [];
        for (const row of rows) {
            const hasPayment = await dbGet("SELECT id FROM fee_payments WHERE fee_structure_id=?", [row.id]);
            const hasDiscount = await dbGet("SELECT id FROM fee_discounts WHERE fee_structure_id=?", [row.id]);
            if (hasPayment || hasDiscount) withMoney.push(row.id);
        }
        const keepId = withMoney.length ? withMoney[0] : rows[0].id;
        for (const row of rows) {
            if (row.id === keepId || withMoney.includes(row.id)) continue;
            await dbRun("DELETE FROM fee_structure WHERE id=?", [row.id]);
            removed++;
        }
    }
    if (removed) {
        existing = await dbAll(
            "SELECT id, installment_label, due_date FROM fee_structure WHERE student_id=? AND fee_plan_id=? ORDER BY id",
            [studentId, plan.id]
        );
    }

    // Remove periods that no longer match the current schedule (e.g. the
    // join date was corrected) - but only ones with zero financial
    // activity, so a correction can reshape upcoming/unpaid periods
    // without ever touching money already collected.
    for (const row of existing) {
        if (wantedLabels.has(row.installment_label)) continue; // still part of the current schedule - keep
        const hasPayment = await dbGet("SELECT id FROM fee_payments WHERE fee_structure_id=?", [row.id]);
        const hasDiscount = await dbGet("SELECT id FROM fee_discounts WHERE fee_structure_id=?", [row.id]);
        if (hasPayment || hasDiscount) continue; // preserve - never delete anything with financial activity
        await dbRun("DELETE FROM fee_structure WHERE id=?", [row.id]);
        removed++;
    }

    // Give existing rows of the current schedule their due date if they were
    // created before due dates existed (or the join date changed).
    const dueByLabel = new Map(wanted.map(p => [p.label, p.dueDate]));
    for (const row of existing) {
        const want = dueByLabel.get(row.installment_label);
        if (want && row.due_date !== want) {
            await dbRun("UPDATE fee_structure SET due_date=? WHERE id=?", [want, row.id]);
        }
    }

    // Add whatever the current schedule calls for that isn't there yet.
    const stillExistingLabels = new Set(existing.filter(r => wantedLabels.has(r.installment_label)).map(r => r.installment_label));
    let inserted = 0;
    for (const period of wanted) {
        if (stillExistingLabels.has(period.label)) continue; // already there
        await dbRun(
            `INSERT INTO fee_structure
             (student_id, fee_category_id, academic_year, amount, installment_label, payment_mode, fee_plan_id, school_id, due_date)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [studentId, plan.fee_category_id, plan.academic_year, period.amount, period.label, plan.payment_mode, plan.id, schoolId, period.dueDate]
        );
        inserted++;
    }

    return { inserted, removed };
}

/**
 * Runs assignPlanToStudent() for every student currently in the plan's
 * Level - used both right after a new Fee Plan is created, and for the
 * "Assign to Missing Students" button (covers students who joined, or
 * had their join date filled in/corrected, since the plan was created).
 * Returns { assignedStudents, totalPeriods, totalRemoved, skippedNoJoinDate }.
 */
async function assignPlanToLevel(plan, schoolId) {

    const students = await dbAll("SELECT id, date_of_joining FROM students WHERE school_id=? AND level_id=?", [schoolId, plan.level_id]);

    let assignedStudents = 0;
    let totalPeriods = 0;
    let totalRemoved = 0;
    let skippedNoJoinDate = 0;

    for (const student of students) {
        if (!student.date_of_joining) { skippedNoJoinDate++; continue; }
        const { inserted, removed } = await assignPlanToStudent(student.id, plan, schoolId);
        if (inserted > 0 || removed > 0) assignedStudents++;
        totalPeriods += inserted;
        totalRemoved += removed;
    }

    return { assignedStudents, totalPeriods, totalRemoved, skippedNoJoinDate };
}

/**
 * Called after a student is created/edited (see routes/students.js) -
 * finds any active Fee Plan(s) for their current Level and syncs their
 * periods to match their current Date of Joining. A no-op if they have
 * no join date or their Level has no plan.
 */
async function assignActivePlansForStudent(studentId, schoolId) {
    const student = await dbGet("SELECT level_id FROM students WHERE id=? AND school_id=?", [studentId, schoolId]);
    if (!student || !student.level_id) return;

    const plans = await dbAll(
        "SELECT * FROM fee_plans WHERE school_id=? AND level_id=?",
        [schoolId, student.level_id]
    );
    for (const plan of plans) {
        await assignPlanToStudent(studentId, plan, schoolId);
    }
}

/**
 * Called after a student is created/edited (see routes/students.js). If
 * the Add/Edit Student form had an explicit Fee Plan chosen, syncs
 * periods for JUST that plan - the modern path, letting different
 * families on the same Level pick different frequencies (e.g. Monthly vs
 * Quarterly for "Annual Fees"). If no plan was explicitly chosen, falls
 * back to assignActivePlansForStudent() for backward compatibility with
 * schools that only ever set up one plan per Level and rely on it being
 * picked up automatically.
 */
async function assignExplicitOrActivePlans(studentId, schoolId, explicitPlanId) {
    if (explicitPlanId) {
        const plan = await dbGet("SELECT * FROM fee_plans WHERE id=? AND school_id=?", [explicitPlanId, schoolId]);
        if (plan) {
            await dbRun("UPDATE students SET fee_plan_id=? WHERE id=? AND school_id=?", [plan.id, studentId, schoolId]);
            await assignPlanToStudent(studentId, plan, schoolId);
            return;
        }
    }
    await assignActivePlansForStudent(studentId, schoolId);
}

/**
 * Called when a student is promoted to a new Level (routes/levelPromotion.js).
 * Their old Level's plan installments that fall due ON or AFTER the
 * promotion date and have no payment/discount are removed, then the new
 * Level's plan(s) are applied from the promotion date onward (see the
 * level_history check in assignPlanToStudentUnlocked). Paid or discounted
 * installments are never touched. Returns { removed, inserted }.
 */
async function switchPlansOnPromotion(studentId, schoolId, oldLevelId, newLevelId, fromDate) {
    let removed = 0, inserted = 0;
    if (oldLevelId && String(oldLevelId) !== String(newLevelId)) {
        const res = await dbRun(
            `DELETE FROM fee_structure
             WHERE school_id=? AND student_id=? AND due_date >= ?
               AND fee_plan_id IN (SELECT id FROM fee_plans WHERE school_id=? AND level_id=?)
               AND NOT EXISTS (SELECT 1 FROM fee_payments p WHERE p.fee_structure_id = fee_structure.id)
               AND NOT EXISTS (SELECT 1 FROM fee_discounts d WHERE d.fee_structure_id = fee_structure.id)`,
            [schoolId, studentId, fromDate, schoolId, oldLevelId]);
        removed = res.changes || 0;
    }
    // A Fee Plan chosen for the OLD Level no longer applies.
    await dbRun(
        `UPDATE students SET fee_plan_id=NULL WHERE id=? AND school_id=? AND fee_plan_id IS NOT NULL
           AND fee_plan_id NOT IN (SELECT id FROM fee_plans WHERE level_id=?)`,
        [studentId, schoolId, newLevelId]);
    const plans = await dbAll("SELECT * FROM fee_plans WHERE school_id=? AND level_id=?", [schoolId, newLevelId]);
    for (const plan of plans) {
        const r = await assignPlanToStudent(studentId, plan, schoolId);
        inserted += r.inserted;
    }
    return { removed, inserted };
}

/**
 * One-time, idempotent backfill run at startup: gives every per-student
 * installment that has a "Month YYYY ..." label but no due date one, so
 * installments created before due dates existed (including ones left behind
 * by a deleted plan) show in Fees Due and are counted correctly in "due now".
 * Due day = the student's Date of Joining day-of-month (clamped to the
 * month's length), or the 1st if there is no join date. Only rows with an
 * empty due_date are touched.
 */
async function backfillDueDates() {
    const rows = await dbAll(
        `SELECT fs.id, fs.installment_label, s.date_of_joining
         FROM fee_structure fs JOIN students s ON s.id = fs.student_id
         WHERE fs.student_id IS NOT NULL AND (fs.due_date IS NULL OR fs.due_date = '')
           AND fs.installment_label IS NOT NULL`, []);
    let updated = 0;
    for (const r of rows) {
        const m = /^([A-Za-z]+)\s+(\d{4})/.exec(r.installment_label.trim());
        if (!m) continue;
        const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === m[1].toLowerCase());
        if (monthIdx < 0) continue;
        const year = parseInt(m[2], 10);
        const joinDay = /^\d{4}-\d{2}-(\d{2})/.exec(r.date_of_joining || "");
        const lastDay = new Date(year, monthIdx + 1, 0).getDate();
        const day = Math.min(joinDay ? parseInt(joinDay[1], 10) : 1, lastDay);
        await dbRun("UPDATE fee_structure SET due_date=? WHERE id=?",
            [`${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, r.id]);
        updated++;
    }
    return updated;
}

module.exports = { switchPlansOnPromotion, backfillDueDates, computePeriods, assignPlanToStudent, assignPlanToLevel, assignActivePlansForStudent, assignExplicitOrActivePlans, SPAN_MONTHS_BY_MODE };
