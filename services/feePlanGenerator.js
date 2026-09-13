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
        periods.push({ label: formatPeriodLabel(cursor, spanMonths), amount: plan.amount_per_period });
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
async function assignPlanToStudent(studentId, plan, schoolId) {

    const student = await dbGet("SELECT date_of_joining, level_id FROM students WHERE id=? AND school_id=?", [studentId, schoolId]);
    if (!student || !student.date_of_joining) return { inserted: 0, removed: 0 };
    if (String(student.level_id) !== String(plan.level_id)) return { inserted: 0, removed: 0 };

    const wanted = computePeriods(plan, student.date_of_joining);
    const wantedLabels = new Set(wanted.map(p => p.label));

    const existing = await dbAll(
        "SELECT id, installment_label FROM fee_structure WHERE student_id=? AND fee_plan_id=?",
        [studentId, plan.id]
    );

    // Remove periods that no longer match the current schedule (e.g. the
    // join date was corrected) - but only ones with zero financial
    // activity, so a correction can reshape upcoming/unpaid periods
    // without ever touching money already collected.
    let removed = 0;
    for (const row of existing) {
        if (wantedLabels.has(row.installment_label)) continue; // still part of the current schedule - keep
        const hasPayment = await dbGet("SELECT id FROM fee_payments WHERE fee_structure_id=?", [row.id]);
        const hasDiscount = await dbGet("SELECT id FROM fee_discounts WHERE fee_structure_id=?", [row.id]);
        if (hasPayment || hasDiscount) continue; // preserve - never delete anything with financial activity
        await dbRun("DELETE FROM fee_structure WHERE id=?", [row.id]);
        removed++;
    }

    // Add whatever the current schedule calls for that isn't there yet.
    const stillExistingLabels = new Set(existing.filter(r => wantedLabels.has(r.installment_label)).map(r => r.installment_label));
    let inserted = 0;
    for (const period of wanted) {
        if (stillExistingLabels.has(period.label)) continue; // already there
        await dbRun(
            `INSERT INTO fee_structure
             (student_id, fee_category_id, academic_year, amount, installment_label, payment_mode, fee_plan_id, school_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [studentId, plan.fee_category_id, plan.academic_year, period.amount, period.label, plan.payment_mode, plan.id, schoolId]
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

module.exports = { computePeriods, assignPlanToStudent, assignPlanToLevel, assignActivePlansForStudent, assignExplicitOrActivePlans, SPAN_MONTHS_BY_MODE };
