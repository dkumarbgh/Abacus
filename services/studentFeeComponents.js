const db = require("../config/database");

/**
 * Per-student FEE COMPONENTS (Tuition Fee, Books Fee, or any other named
 * component set up via the student's "Fees" tab - see routes/studentFees.js).
 *
 * This is a SEPARATE mechanism from:
 *  - services/enrollmentFee.js's "Total Fee" (Course Fee) - the single
 *    lump-sum + free-form installments-as-payments section that used to live
 *    on the Student Add/Edit forms. That UI was removed once schools moved
 *    onto per-component Tuition/Books fees below - the service function
 *    still exists (and old "Course Fee" records it created still show up
 *    wherever fee items are listed) but is no longer called from anywhere.
 *  - services/feePlanGenerator.js's per-Level Fee Plans - shared rates
 *    applied to every student in a Level. Left untouched.
 *
 * A component (e.g. "Tuition Fee" for one student) can be scheduled 3 ways:
 *   - single:  one lump amount, one due item
 *   - monthly: the total split evenly across N months from a start date
 *              (last period absorbs any rounding remainder)
 *   - custom:  staff enters each installment's own label/amount/due date -
 *              a one-off schedule for just this student
 *
 * Every mode ultimately just produces a list of "wanted" fee_structure rows
 * (student_id set, level_id/class_id/fee_plan_id left null) under the
 * component's fee_category_id. Re-saving a component (a different total,
 * a mode switch, an edited installment) re-syncs those rows using the same
 * safety rule as assignPlanToStudent() in feePlanGenerator.js: a row is
 * only ever removed if it has NO payment and NO discount recorded against
 * it - so correcting a schedule can never silently erase money already
 * collected. A row whose label is no longer part of the wanted schedule but
 * that CAN'T be removed (because it has financial activity) is left in
 * place exactly as-is - it just stops being "the current schedule" and
 * still shows up (paid) in Fee Collection and every report.
 */

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function addMonths(dateStr, months) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setMonth(d.getMonth() + months);
    return d;
}

function toIsoDate(d) {
    return d.toISOString().slice(0, 10);
}

/**
 * Finds (or creates) a fee_category by exact name for this school - e.g.
 * "Tuition Fee" / "Books Fee". If a school already has a category with
 * that name (created manually under Fee Categories, or used by a Level-
 * wide Fee Plan/Fee Structure entry), THAT category is reused - a
 * student's personalized items and any Level-wide items of the same name
 * share one category, and simply add together in every report, same as
 * "Course Fee" personalized items already do today.
 */
async function getOrCreateCategory(schoolId, name) {
    const existing = await dbGet("SELECT id FROM fee_categories WHERE fee_name=? AND school_id=?", [name, schoolId]);
    if (existing) return existing.id;
    const created = await dbRun("INSERT INTO fee_categories (fee_name, school_id) VALUES (?,?)", [name, schoolId]);
    return created.lastID;
}

/**
 * Pure computation - given the mode and its settings, returns the list of
 * { label, amount, due_date } items this schedule should consist of.
 * No DB access, easy to reason about/test.
 */
function computeWantedItems({ mode, totalAmount, singleDueDate, months, startDate, installments }) {

    if (mode === "single") {
        const amount = round2(totalAmount);
        if (!amount || amount <= 0) return [];
        return [{ label: null, amount, due_date: singleDueDate || null }];
    }

    if (mode === "monthly") {
        const total = round2(totalAmount);
        const n = Math.max(1, parseInt(months) || 0);
        if (!total || total <= 0 || !n || !startDate) return [];

        const base = Math.floor((total / n) * 100) / 100;
        const items = [];
        let runningTotal = 0;
        for (let i = 0; i < n; i++) {
            const periodStart = addMonths(startDate, i);
            const amount = (i === n - 1) ? round2(total - runningTotal) : base;
            runningTotal += amount;
            items.push({
                label: `${MONTH_NAMES[periodStart.getMonth()]} ${periodStart.getFullYear()}`,
                amount,
                due_date: toIsoDate(periodStart)
            });
        }
        return items;
    }

    if (mode === "custom") {
        // installments: [{label, amount, due_date}], already loosely
        // validated by the route (amount > 0). Blank labels are
        // auto-numbered so the sync logic always has something unique
        // to match rows on.
        const items = [];
        const usedLabels = new Set();
        installments.forEach((inst, i) => {
            const amount = round2(parseFloat(inst.amount));
            if (!amount || amount <= 0) return;
            let label = (inst.label || "").trim() || `Installment ${i + 1}`;
            let uniqueLabel = label;
            let suffix = 2;
            while (usedLabels.has(uniqueLabel)) { uniqueLabel = `${label} (${suffix++})`; }
            usedLabels.add(uniqueLabel);
            items.push({ label: uniqueLabel, amount, due_date: inst.due_date || null });
        });
        return items;
    }

    return [];
}

/**
 * Syncs one student's fee_structure rows for one component (category) to
 * match `wantedItems`. Safe to call repeatedly - see file header for the
 * preservation rule. Returns { inserted, updated, removed, preserved }.
 */
async function syncComponent({ schoolId, studentId, classId, categoryId, academicYear, mode, wantedItems }) {

    const existing = await dbAll(
        "SELECT id, installment_label, amount, due_date, payment_mode, academic_year FROM fee_structure WHERE student_id=? AND fee_category_id=? AND school_id=?",
        [studentId, categoryId, schoolId]
    );

    // Keyed by (academic_year + label) rather than label alone, so a new
    // academic year's schedule never collides with - or silently
    // overwrites - last year's, even for "single" mode where the label is
    // always null (e.g. two different years' one-shot Books Fee).
    const keyOf = (academicYearVal, label) => `${academicYearVal}||${label}`;
    const wantedByKey = new Map(wantedItems.map(w => [keyOf(academicYear, w.label), w]));

    let removed = 0;
    const preserved = [];
    const keptExistingByKey = new Map();
    for (const row of existing) {
        if (wantedByKey.has(keyOf(row.academic_year, row.installment_label))) {
            keptExistingByKey.set(keyOf(row.academic_year, row.installment_label), row);
            continue;
        }
        const hasPayment = await dbGet("SELECT id FROM fee_payments WHERE fee_structure_id=?", [row.id]);
        const hasDiscount = await dbGet("SELECT id FROM fee_discounts WHERE fee_structure_id=?", [row.id]);
        if (hasPayment || hasDiscount) {
            preserved.push(row);
            continue;
        }
        await dbRun("DELETE FROM fee_structure WHERE id=?", [row.id]);
        removed++;
    }

    let inserted = 0;
    let updated = 0;
    for (const item of wantedItems) {
        const existingRow = keptExistingByKey.get(keyOf(academicYear, item.label));
        if (existingRow) {
            // Even a row that's "kept" (its label+year still matches the
            // current schedule) must not have its amount/due_date silently
            // rewritten if money has already been recorded against it -
            // re-saving the same schedule with one tweaked number should
            // never retroactively change what an already-paid period says
            // it was worth.
            const hasPayment = await dbGet("SELECT id FROM fee_payments WHERE fee_structure_id=?", [existingRow.id]);
            const hasDiscount = await dbGet("SELECT id FROM fee_discounts WHERE fee_structure_id=?", [existingRow.id]);
            if (hasPayment || hasDiscount) {
                if (existingRow.amount !== item.amount || existingRow.due_date !== item.due_date) {
                    preserved.push(existingRow);
                }
                continue;
            }
            if (existingRow.amount !== item.amount || existingRow.due_date !== item.due_date || existingRow.payment_mode !== mode) {
                await dbRun(
                    "UPDATE fee_structure SET amount=?, due_date=?, payment_mode=? WHERE id=?",
                    [item.amount, item.due_date, mode, existingRow.id]
                );
                updated++;
            }
        } else {
            await dbRun(
                `INSERT INTO fee_structure
                 (student_id, class_id, fee_category_id, academic_year, amount, installment_label, payment_mode, due_date, school_id)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [studentId, classId, categoryId, academicYear, item.amount, item.label, mode, item.due_date, schoolId]
            );
            inserted++;
        }
    }

    return { inserted, updated, removed, preserved };
}

/**
 * High-level entry point used by routes/studentFees.js: resolves/creates
 * the named category, computes the wanted schedule, and syncs it.
 */
async function saveComponent({ schoolId, studentId, classId, categoryName, mode, totalAmount, singleDueDate, months, startDate, installments }) {

    const categoryId = await getOrCreateCategory(schoolId, categoryName);
    const wantedItems = computeWantedItems({ mode, totalAmount, singleDueDate, months, startDate, installments });
    const academicYear = String(new Date().getFullYear());

    const result = await syncComponent({ schoolId, studentId, classId, categoryId, academicYear, mode, wantedItems });
    return { categoryId, wantedItems, ...result };
}

/**
 * Loads the current state of a named component for one student - every
 * fee_structure row under that category for that student, each with
 * paid/due computed, plus totals. Used to render the Fees tab.
 */
async function loadComponent({ schoolId, studentId, categoryName }) {

    const emptyPrefill = { mode: "single", totalAmount: null, singleDueDate: null, months: null, startDate: null, installments: [] };

    const category = await dbGet("SELECT id FROM fee_categories WHERE fee_name=? AND school_id=?", [categoryName, schoolId]);
    if (!category) return { categoryId: null, items: [], totalAmount: 0, totalPaid: 0, totalDue: 0, mode: null, prefill: emptyPrefill };

    const rows = await dbAll(
        "SELECT * FROM fee_structure WHERE student_id=? AND fee_category_id=? AND school_id=? ORDER BY due_date IS NULL, due_date, id",
        [studentId, category.id, schoolId]
    );

    const payments = await dbAll(
        `SELECT fee_payments.* FROM fee_payments
         JOIN fee_structure ON fee_payments.fee_structure_id = fee_structure.id
         WHERE fee_structure.student_id=? AND fee_structure.fee_category_id=? AND fee_structure.school_id=?`,
        [studentId, category.id, schoolId]
    );
    const discounts = await dbAll(
        `SELECT fee_discounts.* FROM fee_discounts
         JOIN fee_structure ON fee_discounts.fee_structure_id = fee_structure.id
         WHERE fee_structure.student_id=? AND fee_structure.fee_category_id=? AND fee_structure.school_id=?`,
        [studentId, category.id, schoolId]
    );

    const { computeDiscountAmount, computeNetAmount } = require("./feeCalc");

    const items = rows.map(row => {
        const paid = payments.filter(p => p.fee_structure_id === row.id).reduce((sum, p) => sum + p.amount_paid, 0);
        const discount = discounts.find(d => d.fee_structure_id === row.id) || null;
        const netAmount = computeNetAmount(row.amount, discount);
        return {
            ...row,
            paid,
            discount,
            discountAmount: computeDiscountAmount(row.amount, discount),
            netAmount,
            due: Math.max(netAmount - paid, 0)
        };
    });

    const totalAmount = round2(items.reduce((sum, i) => sum + i.netAmount, 0));
    const totalPaid = round2(items.reduce((sum, i) => sum + i.paid, 0));
    const totalDue = round2(items.reduce((sum, i) => sum + i.due, 0));

    // Representative mode for prefilling the form - the most recently
    // added row's mode (rows are inserted in one batch per save, so the
    // highest id reflects the last schedule that was actually chosen).
    const latestRow = rows.length ? rows.reduce((a, b) => (a.id > b.id ? a : b)) : null;
    const mode = latestRow ? latestRow.payment_mode : null;

    // Prefill data for the reconfigure form - only the rows belonging to
    // THIS year's active schedule (same mode + same academic_year as the
    // latest row), so editing a current setup doesn't pull in a prior
    // year's now-historical periods.
    let prefill = emptyPrefill;
    if (latestRow) {
        const activeItems = items
            .filter(i => i.payment_mode === mode && i.academic_year === latestRow.academic_year)
            .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "") || a.id - b.id);

        if (mode === "single") {
            const only = activeItems[0];
            prefill = { mode, totalAmount: only ? only.amount : null, singleDueDate: only ? only.due_date : null, months: null, startDate: null, installments: [] };
        } else if (mode === "monthly") {
            prefill = {
                mode,
                totalAmount: round2(activeItems.reduce((sum, i) => sum + i.amount, 0)),
                singleDueDate: null,
                months: activeItems.length || null,
                startDate: activeItems.length ? activeItems[0].due_date : null,
                installments: []
            };
        } else if (mode === "custom") {
            prefill = {
                mode,
                totalAmount: null,
                singleDueDate: null,
                months: null,
                startDate: null,
                installments: activeItems.map(i => ({ label: i.installment_label, amount: i.amount, due_date: i.due_date }))
            };
        }
    }

    return { categoryId: category.id, items, totalAmount, totalPaid, totalDue, mode, prefill };
}

/**
 * FEE TEMPLATES - remembers the last schedule typed in for a Level +
 * component, so the next student at that Level doesn't start from a blank
 * form. See config/database.js for the fee_templates table and why due
 * dates/start dates are deliberately excluded from what's remembered.
 */

/**
 * Looks up the template for (school, level, category) - a Level-specific
 * template if one exists, else the school-wide default (level_id IS NULL),
 * else null. levelId may be null/undefined (student has no Level set),
 * in which case only the school-wide default is checked.
 */
async function getTemplate(schoolId, levelId, categoryName) {
    if (levelId) {
        const levelRow = await dbGet(
            "SELECT * FROM fee_templates WHERE school_id=? AND level_id=? AND category_name=?",
            [schoolId, levelId, categoryName]
        );
        if (levelRow) return levelRow;
    }
    const schoolWide = await dbGet(
        "SELECT * FROM fee_templates WHERE school_id=? AND level_id IS NULL AND category_name=?",
        [schoolId, categoryName]
    );
    return schoolWide || null;
}

/**
 * Converts a stored template row into the same {mode, totalAmount,
 * singleDueDate, months, startDate, installments} shape the Fees tab form
 * prefill uses - due dates/start date are always null here (never stored),
 * left for the person to fill in for this particular student.
 */
function templateToPrefill(template) {
    if (!template) return null;
    let installments = [];
    if (template.installments_json) {
        try { installments = JSON.parse(template.installments_json); } catch (e) { installments = []; }
    }
    return {
        mode: template.mode,
        totalAmount: template.total_amount,
        singleDueDate: null,
        months: template.months,
        startDate: null,
        installments
    };
}

/**
 * Upserts the template for (school, level, category) - one row per
 * combination. levelId null means "school-wide default".
 */
async function saveTemplate(schoolId, levelId, categoryName, { mode, totalAmount, months, installments }) {
    let findSql = "SELECT id FROM fee_templates WHERE school_id=? AND category_name=?";
    const findParams = [schoolId, categoryName];
    if (levelId) { findSql += " AND level_id=?"; findParams.push(levelId); }
    else { findSql += " AND level_id IS NULL"; }

    const existing = await dbGet(findSql, findParams);
    const installmentsJson = (installments && installments.length)
        ? JSON.stringify(installments.map(i => ({ label: i.label, amount: i.amount })))
        : null;

    if (existing) {
        await dbRun(
            "UPDATE fee_templates SET mode=?, total_amount=?, months=?, installments_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            [mode, totalAmount || null, months || null, installmentsJson, existing.id]
        );
    } else {
        await dbRun(
            `INSERT INTO fee_templates (school_id, level_id, category_name, mode, total_amount, months, installments_json)
             VALUES (?,?,?,?,?,?,?)`,
            [schoolId, levelId || null, categoryName, mode, totalAmount || null, months || null, installmentsJson]
        );
    }
}

module.exports = {
    getOrCreateCategory, computeWantedItems, syncComponent, saveComponent, loadComponent,
    getTemplate, templateToPrefill, saveTemplate, MONTH_NAMES
};
