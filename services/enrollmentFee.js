const db = require("../config/database");

const dbGet = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbRun = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

const COURSE_FEE_CATEGORY_NAME = "Course Fee";

/**
 * Finds (or creates) the "Course Fee" fee_category for a school - the
 * category used for personalized, per-student fee items created from the
 * Total Fee section of the Student form (as opposed to the shared,
 * class-wide items set up under Fee Structure).
 */
async function getOrCreateCourseFeeCategory(schoolId) {
    const existing = await dbGet(
        "SELECT id FROM fee_categories WHERE fee_name=? AND school_id=?",
        [COURSE_FEE_CATEGORY_NAME, schoolId]
    );
    if (existing) return existing.id;

    const created = await dbRun(
        "INSERT INTO fee_categories (fee_name, school_id) VALUES (?,?)",
        [COURSE_FEE_CATEGORY_NAME, schoolId]
    );
    return created.lastID;
}

/**
 * Applies the Total Fee / Discount / Installments section of the Student
 * form to the real fee-collection system:
 *  - Total Fee -> a fee_structure row scoped to just this student
 *    (student_id set), under the "Course Fee" category, so it shows up
 *    alongside any class-wide fee items on the Fee Collection page and in
 *    every report - without affecting other students in the same class.
 *  - Discount -> a fee_discounts row against that fee item, same shape as
 *    the existing per-item discount/waiver feature.
 *  - Installments -> one fee_payments row per installment they entered at
 *    registration - real payments, immediately reflected as "paid" on the
 *    Fee Collection page and receipts.
 *
 * Safe to call with nothing set (does nothing) or to call again later on
 * an edit (updates the existing personalized item instead of duplicating
 * it, and only adds new installments - it never removes/edits ones already
 * saved, since those are real payment records by that point).
 *
 * @param {object} opts
 * @param {number} opts.studentId
 * @param {number} opts.classId
 * @param {number} opts.schoolId
 * @param {string|number} [opts.totalFee] - raw form value, may be "" 
 * @param {string} [opts.discountType] - "FLAT" | "PERCENT"
 * @param {string|number} [opts.discountValue] - raw form value, may be ""
 * @param {Array<{amount, date, mode}>} [opts.installments]
 */
async function saveEnrollmentFee({ studentId, classId, schoolId, totalFee, discountType, discountValue, installments = [] }) {

    const amount = parseFloat(totalFee);
    if (!amount || amount <= 0) {
        // Nothing to do - Total Fee wasn't filled in for this student.
        return null;
    }

    const categoryId = await getOrCreateCourseFeeCategory(schoolId);

    // One personalized fee_structure row per student, reused on edit
    // (never duplicated) - identified by (student_id, fee_category_id).
    let feeStructureId;
    const existingItem = await dbGet(
        "SELECT id FROM fee_structure WHERE student_id=? AND fee_category_id=? AND school_id=?",
        [studentId, categoryId, schoolId]
    );

    const academicYear = String(new Date().getFullYear());

    if (existingItem) {
        feeStructureId = existingItem.id;
        await dbRun(
            "UPDATE fee_structure SET amount=?, class_id=? WHERE id=?",
            [amount, classId, feeStructureId]
        );
    } else {
        const created = await dbRun(
            `INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, student_id, school_id)
             VALUES (?,?,?,?,?,?)`,
            [classId, categoryId, academicYear, amount, studentId, schoolId]
        );
        feeStructureId = created.lastID;
    }

    // Discount (optional) - upsert against the personalized fee item.
    const discountAmount = parseFloat(discountValue);
    if (discountType && discountAmount > 0) {
        const existingDiscount = await dbGet(
            "SELECT id FROM fee_discounts WHERE student_id=? AND fee_structure_id=? AND school_id=?",
            [studentId, feeStructureId, schoolId]
        );
        if (existingDiscount) {
            await dbRun(
                "UPDATE fee_discounts SET discount_type=?, discount_value=?, reason=? WHERE id=?",
                [discountType, discountAmount, "Enrollment discount", existingDiscount.id]
            );
        } else {
            await dbRun(
                `INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id)
                 VALUES (?,?,?,?,?,?)`,
                [studentId, feeStructureId, discountType, discountAmount, "Enrollment discount", schoolId]
            );
        }
    }

    // Installments (optional, can be zero, one, or several) - each becomes
    // a real payment record, exactly as if collected via Fee Collection.
    for (const inst of installments) {
        const instAmount = parseFloat(inst.amount);
        if (!instAmount || instAmount <= 0) continue;

        const paymentDate = inst.date || new Date().toISOString().slice(0, 10);
        const receiptNo = `RCPT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        await dbRun(
            `INSERT INTO fee_payments
             (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [studentId, feeStructureId, instAmount, paymentDate, inst.mode || "Cash", receiptNo, "Installment recorded at registration", schoolId]
        );
    }

    return feeStructureId;
}

/**
 * Pulls installment rows (amount/date/mode) out of a submitted form body,
 * normalizing the single-vs-array quirk of same-name form fields.
 */
function parseInstallmentsFromBody(body) {
    const amounts = [].concat(body.installment_amount || []);
    const dates = [].concat(body.installment_date || []);
    const modes = [].concat(body.installment_mode || []);
    return amounts.map((amount, i) => ({ amount, date: dates[i], mode: modes[i] }));
}

module.exports = { saveEnrollmentFee, parseInstallmentsFromBody };
