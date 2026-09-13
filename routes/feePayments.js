const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { sendToPhones } = require("../services/whatsappClient");
const { requireLogin, requireSchoolFeature, requireRole } = require("../middleware/auth");
const { logChange } = require("../services/auditLog");
const { computeDiscountAmount, computeNetAmount } = require("../services/feeCalc");
const { assignNextReceiptNo } = require("../services/schoolSettings");

const uploadSpreadsheet = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.use(requireLogin);

/* ==========================================
   SELECT STUDENT TO COLLECT FEES FOR
========================================== */
router.get("/", (req, res) => {

    const search = req.query.search || "";
    const rollNumber = (req.query.roll_number || "").trim();

    let sql = `SELECT students.id, students.name, students.admission_no, level.name AS level_name
         FROM students
         LEFT JOIN lookup_items level ON students.level_id = level.id
         WHERE students.school_id = ? AND students.name LIKE ?`;
    const params = [req.schoolId, `%${search}%`];
    if (rollNumber) { sql += " AND students.admission_no LIKE ?"; params.push(`%${rollNumber}%`); }
    sql += " ORDER BY students.name";

    Promise.all([
        new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))),
        new Promise((resolve, reject) => db.get("SELECT fees_import_export_enabled FROM schools WHERE id=?", [req.schoolId], (err, row) => err ? reject(err) : resolve(row)))
    ]).then(([students, schoolRow]) => {

        res.render("fees/payments", {
            students, search, rollNumber,
            importExportEnabled: !!(schoolRow && schoolRow.fees_import_export_enabled)
        });

    }).catch(err => res.send(err.message));

});


/* ==========================================
   STUDENT FEE DUES + PAYMENT HISTORY + PAY FORM
   NOTE: the three literal-path GET routes just above (export,
   import/template, import) MUST be registered before this /:studentId
   route - otherwise Express matches them as if "export"/"import" were a
   studentId, since route matching happens in registration order.
========================================== */
router.get("/export", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments"), (req, res) => {

    const schoolId = req.schoolId;
    const { from_date, to_date } = req.query;

    let sql = `
        SELECT fee_payments.payment_date, fee_payments.amount_paid, fee_payments.mode,
               fee_payments.reference_no, fee_payments.receipt_no, fee_payments.remarks,
               students.name AS student_name, students.admission_no,
               fee_categories.fee_name, fee_structure.academic_year
        FROM fee_payments
        JOIN students ON fee_payments.student_id = students.id
        JOIN fee_structure ON fee_payments.fee_structure_id = fee_structure.id
        JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
        WHERE fee_payments.school_id = ?
    `;
    const params = [schoolId];
    if (from_date) { sql += " AND fee_payments.payment_date >= ?"; params.push(from_date); }
    if (to_date) { sql += " AND fee_payments.payment_date <= ?"; params.push(to_date); }
    sql += " ORDER BY fee_payments.payment_date DESC, students.name";

    db.all(sql, params, async (err, rows) => {

        if (err) return res.send(err.message);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Fee Payments");
        sheet.columns = [
            { header: "Roll Number", key: "admission_no", width: 15 },
            { header: "Student Name", key: "student_name", width: 25 },
            { header: "Fee Category", key: "fee_name", width: 20 },
            { header: "Academic Year", key: "academic_year", width: 15 },
            { header: "Amount Paid", key: "amount_paid", width: 14 },
            { header: "Payment Date", key: "payment_date", width: 14 },
            { header: "Mode", key: "mode", width: 14 },
            { header: "Reference No.", key: "reference_no", width: 18 },
            { header: "Receipt No.", key: "receipt_no", width: 18 },
            { header: "Remarks", key: "remarks", width: 20 }
        ];
        sheet.getRow(1).font = { bold: true };
        rows.forEach(r => sheet.addRow(r));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="fee-payments-export-${new Date().toISOString().slice(0,10)}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    });

});

router.get("/import/template", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments"), async (req, res) => {

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Fee Payments");
    sheet.columns = [
        { header: "Roll Number", key: "admission_no", width: 15 },
        { header: "Student Name", key: "student_name", width: 25 },
        { header: "Fee Category", key: "fee_name", width: 20 },
        { header: "Academic Year", key: "academic_year", width: 15 },
        { header: "Amount Paid", key: "amount_paid", width: 14 },
        { header: "Payment Date", key: "payment_date", width: 14 },
        { header: "Mode", key: "mode", width: 14 },
        { header: "Reference No.", key: "reference_no", width: 18 },
        { header: "Receipt No.", key: "receipt_no", width: 18 },
        { header: "Remarks", key: "remarks", width: 20 }
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.addRow({
        admission_no: "2024-001", student_name: "Jane Doe", fee_name: "Tuition Fee", academic_year: "2025-2026",
        amount_paid: 5000, payment_date: "2026-01-15", mode: "Cash", reference_no: "", receipt_no: "", remarks: ""
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="fee-payments-import-template.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();

});

router.get("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments"), (req, res) => {
    res.render("importFeePayments", { result: null });
});

router.get("/:studentId", (req, res) => {

    const studentId = req.params.studentId;
    const schoolId = req.schoolId;

    db.get("SELECT * FROM students WHERE id=? AND school_id=?", [studentId, schoolId], (err, student) => {

        if (err) return res.send(err.message);
        if (!student) return res.send("Student not found");

        db.get("SELECT simple_fee_mode FROM schools WHERE id=?", [schoolId], (err, school) => {

        if (err) return res.send(err.message);

        const simpleFeeMode = !!(school && school.simple_fee_mode);

        db.all(
            `SELECT fs.id, fc.fee_name, fs.academic_year, fs.amount, fs.installment_label
             FROM fee_structure fs
             JOIN fee_categories fc ON fs.fee_category_id = fc.id
             WHERE fs.school_id = ?
               AND ((fs.student_id IS NULL AND fs.class_id = ?) OR (fs.student_id IS NULL AND fs.level_id = ?) OR fs.student_id = ?)
             ORDER BY fs.academic_year DESC, fc.fee_name`,
            [schoolId, student.class_id, student.level_id, studentId],
            (err, structures) => {

                if (err) return res.send(err.message);

                db.all(
                    `SELECT * FROM fee_payments WHERE student_id=? AND school_id=? ORDER BY payment_date DESC`,
                    [studentId, schoolId],
                    (err, payments) => {

                        if (err) return res.send(err.message);

                        db.all(
                            `SELECT * FROM fee_discounts WHERE student_id=? AND school_id=?`,
                            [studentId, schoolId],
                            (err, discounts) => {

                                if (err) return res.send(err.message);

                                const dues = structures.map(fs => {
                                    const paid = payments
                                        .filter(p => p.fee_structure_id === fs.id)
                                        .reduce((sum, p) => sum + p.amount_paid, 0);
                                    const discount = discounts.find(d => d.fee_structure_id === fs.id) || null;
                                    const discountAmount = computeDiscountAmount(fs.amount, discount);
                                    const netAmount = computeNetAmount(fs.amount, discount);
                                    return {
                                        ...fs,
                                        paid,
                                        discount,
                                        discountAmount,
                                        netAmount,
                                        due: Math.max(netAmount - paid, 0)
                                    };
                                });

                                res.render("fees/payments", {
                                    student,
                                    dues,
                                    payments,
                                    students: null,
                                    search: "",
                                    simpleFeeMode
                                });

                            }
                        );

                    }
                );

            }
        );

        });

    });

});


/* ==========================================
   RECORD A PAYMENT
========================================== */
router.post("/pay", async (req, res) => {

    const { student_id, fee_structure_id, amount_paid, mode, reference_no, remarks } = req.body;
    const payment_date = new Date().toISOString().slice(0, 10);
    const schoolId = req.schoolId;
    const receipt_no = await assignNextReceiptNo(schoolId);

    // Confirm the student and fee item both belong to this school AND that
    // the fee item actually applies to this student - either a class-wide
    // item (their class) or a personalized one created just for them.
    db.get(
        `SELECT students.id AS student_ok, fee_structure.id AS fs_ok
         FROM students, fee_structure
         WHERE students.id = ? AND students.school_id = ?
           AND fee_structure.id = ? AND fee_structure.school_id = ?
           AND (
                (fee_structure.student_id IS NULL AND fee_structure.class_id = students.class_id)
                OR (fee_structure.student_id IS NULL AND fee_structure.level_id = students.level_id)
                OR fee_structure.student_id = students.id
           )`,
        [student_id, schoolId, fee_structure_id, schoolId],
        (checkErr, ok) => {

            if (checkErr) return res.send(checkErr.message);
            if (!ok) return res.status(403).send("Invalid student or fee item for your school.");

            // If Simple Fee Mode is ON for this school, custom/partial amounts
            // aren't allowed - block this route even if hit directly and point
            // at /mark-paid instead, so the Settings toggle can't be bypassed.
            db.get("SELECT simple_fee_mode FROM schools WHERE id=?", [schoolId], (modeErr, school) => {

                if (modeErr) return res.send(modeErr.message);

                if (school && school.simple_fee_mode) {
                    return res.status(403).send(
                        "Simple Fee Mode is ON for this school - fees can only be marked Paid/Not Paid, not partial amounts. " +
                        "<a href='/fee-payments/" + student_id + "'>Go back</a>"
                    );
                }

            db.run(
                `INSERT INTO fee_payments
                 (student_id, fee_structure_id, amount_paid, payment_date, mode, reference_no, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [student_id, fee_structure_id, amount_paid, payment_date, mode || "Cash", reference_no || null, receipt_no, remarks, schoolId],
                function(err) {

                    if (err) return res.send(err.message);

                    // Notify guardian on WhatsApp with the payment confirmation.
                    db.get(
                        `SELECT fee_categories.fee_name
                         FROM fee_structure
                         JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
                         WHERE fee_structure.id = ?`,
                        [fee_structure_id],
                        (err, feeInfo) => {

                            db.get("SELECT * FROM students WHERE id=?", [student_id], (err2, student) => {

                                logChange({
                                    schoolId, branchId: student ? student.branch_id : null, req,
                                    entityType: "Fee Payment", entityName: student ? student.name : `Student #${student_id}`,
                                    action: "Paid",
                                    details: `₹${amount_paid} via ${mode || "Cash"} towards "${feeInfo ? feeInfo.fee_name : "fee"}" (Receipt ${receipt_no})`
                                });

                                if (!err2 && student && (student.guardian_phone || student.guardian_phone_2)) {
                                    const feeName = feeInfo ? feeInfo.fee_name : "school fee";
                                    const message = `Dear Parent, we have received Rs.${amount_paid} towards "${feeName}" for ${student.name}. Receipt No: ${receipt_no}. Thank you. - School Office`;
                                    sendToPhones([student.guardian_phone, student.guardian_phone_2], { message, studentId: student_id, type: "FEE_REMINDER", schoolId });
                                }

                                res.redirect(`/fee-payments/${student_id}`);

                            });

                        }
                    );

                }
            );

            });

        }
    );

});


/* ==========================================
   MARK AS PAID (Simple Fee Mode)
   No amount is accepted from the client - the full remaining net amount
   for this fee item (after any discount) is computed server-side and
   recorded as a single payment. Used instead of /pay when the school's
   Simple Fee Mode setting is ON (Settings > Fee Collection).
========================================== */
router.post("/mark-paid", async (req, res) => {

    const { student_id, fee_structure_id, mode, reference_no } = req.body;
    const schoolId = req.schoolId;
    const paymentMode = mode || "Cash";

    // Confirm the student and fee item both belong to this school AND that
    // the fee item actually applies to this student - either a class-wide
    // item (their class) or a personalized one created just for them -
    // and pull the amount at the same time.
    db.get(
        `SELECT students.id AS student_ok, fee_structure.id AS fs_ok, fee_structure.amount AS amount
         FROM students, fee_structure
         WHERE students.id = ? AND students.school_id = ?
           AND fee_structure.id = ? AND fee_structure.school_id = ?
           AND (
                (fee_structure.student_id IS NULL AND fee_structure.class_id = students.class_id)
                OR (fee_structure.student_id IS NULL AND fee_structure.level_id = students.level_id)
                OR fee_structure.student_id = students.id
           )`,
        [student_id, schoolId, fee_structure_id, schoolId],
        (checkErr, ok) => {

            if (checkErr) return res.send(checkErr.message);
            if (!ok) return res.status(403).send("Invalid student or fee item for your school.");

            db.all(
                `SELECT * FROM fee_payments WHERE student_id=? AND fee_structure_id=? AND school_id=?`,
                [student_id, fee_structure_id, schoolId],
                (payErr, payments) => {

                    if (payErr) return res.send(payErr.message);

                    db.get(
                        `SELECT * FROM fee_discounts WHERE student_id=? AND fee_structure_id=? AND school_id=?`,
                        [student_id, fee_structure_id, schoolId],
                        async (discErr, discount) => {

                            if (discErr) return res.send(discErr.message);

                            const alreadyPaid = payments.reduce((sum, p) => sum + p.amount_paid, 0);
                            const netAmount = computeNetAmount(ok.amount, discount);
                            const due = Math.max(netAmount - alreadyPaid, 0);

                            if (due <= 0) {
                                return res.redirect(`/fee-payments/${student_id}`);
                            }

                            const payment_date = new Date().toISOString().slice(0, 10);
                            const receipt_no = await assignNextReceiptNo(schoolId);

                            db.run(
                                `INSERT INTO fee_payments
                                 (student_id, fee_structure_id, amount_paid, payment_date, mode, reference_no, receipt_no, remarks, school_id)
                                 VALUES (?,?,?,?,?,?,?,?,?)`,
                                [student_id, fee_structure_id, due, payment_date, paymentMode, reference_no || null, receipt_no, "Marked as Paid (Simple Fee Mode)", schoolId],
                                function(err) {

                                    if (err) return res.send(err.message);

                                    db.get(
                                        `SELECT fee_categories.fee_name
                                         FROM fee_structure
                                         JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
                                         WHERE fee_structure.id = ?`,
                                        [fee_structure_id],
                                        (err, feeInfo) => {

                                            db.get("SELECT * FROM students WHERE id=?", [student_id], (err2, student) => {

                                                logChange({
                                                    schoolId, branchId: student ? student.branch_id : null, req,
                                                    entityType: "Fee Payment", entityName: student ? student.name : `Student #${student_id}`,
                                                    action: "Marked Paid",
                                                    details: `₹${due} via ${paymentMode} towards "${feeInfo ? feeInfo.fee_name : "fee"}" (Receipt ${receipt_no})`
                                                });

                                                if (!err2 && student && (student.guardian_phone || student.guardian_phone_2)) {
                                                    const feeName = feeInfo ? feeInfo.fee_name : "school fee";
                                                    const message = `Dear Parent, we have received full payment towards "${feeName}" for ${student.name}. Receipt No: ${receipt_no}. Thank you. - School Office`;
                                                    sendToPhones([student.guardian_phone, student.guardian_phone_2], { message, studentId: student_id, type: "FEE_REMINDER", schoolId });
                                                }

                                                res.redirect(`/fee-payments/${student_id}`);

                                            });

                                        }
                                    );

                                }
                            );

                        }
                    );

                }
            );

        }
    );

});


/* ==========================================
   APPLY / UPDATE A DISCOUNT OR WAIVER
   discount_type: FLAT (rupee amount) or PERCENT (0-100)
   A 100% PERCENT discount is a full waiver - no separate flag needed.
========================================== */
router.post("/discount", (req, res) => {

    const { student_id, fee_structure_id, discount_type, discount_value, reason, waive_full } = req.body;
    const schoolId = req.schoolId;

    // Confirm the student and fee item both belong to this school AND that
    // the fee item is actually one of this student's own class's fee items.
    db.get(
        `SELECT students.id AS student_ok, fee_structure.id AS fs_ok
         FROM students, fee_structure
         WHERE students.id = ? AND students.school_id = ?
           AND fee_structure.id = ? AND fee_structure.school_id = ?
           AND (
                fee_structure.class_id = students.class_id
                OR fee_structure.level_id = students.level_id
           )`,
        [student_id, schoolId, fee_structure_id, schoolId],
        (checkErr, ok) => {

            if (checkErr) return res.send(checkErr.message);
            if (!ok) return res.status(403).send("Invalid student or fee item for your school.");

            // "Waive Full Amount" is just shorthand for a 100% PERCENT discount.
            const type = waive_full ? "PERCENT" : (discount_type || "FLAT");
            const value = waive_full ? 100 : Number(discount_value);

            db.run(
                `INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(student_id, fee_structure_id) DO UPDATE SET
                    discount_type=excluded.discount_type,
                    discount_value=excluded.discount_value,
                    reason=excluded.reason`,
                [student_id, fee_structure_id, type, value, reason || null, schoolId],
                (err) => {

                    if (err) return res.send(err.message);

                    db.get("SELECT name, branch_id FROM students WHERE id=?", [student_id], (errS, student) => {
                        logChange({
                            schoolId, branchId: student ? student.branch_id : null, req,
                            entityType: "Fee Discount", entityName: student ? student.name : `Student #${student_id}`,
                            action: waive_full ? "Waived Full Amount" : "Discount Applied",
                            details: waive_full ? "100% waiver" : `${type === "PERCENT" ? value + "%" : "₹" + value}${reason ? " - " + reason : ""}`
                        });
                        res.redirect(`/fee-payments/${student_id}`);
                    });

                }
            );

        }
    );

});


/* ==========================================
   REMOVE A DISCOUNT / WAIVER
========================================== */
router.get("/discount/remove/:id", (req, res) => {

    db.get(
        "SELECT student_id FROM fee_discounts WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, discount) => {

            if (err) return res.send(err.message);
            if (!discount) return res.send("Discount not found");

            db.run(
                "DELETE FROM fee_discounts WHERE id=? AND school_id=?",
                [req.params.id, req.schoolId],
                (err2) => {

                    if (err2) return res.send(err2.message);

                    const schoolId = req.schoolId;
                    db.get("SELECT name, branch_id FROM students WHERE id=?", [discount.student_id], (errS, student) => {
                        logChange({
                            schoolId, branchId: student ? student.branch_id : null, req,
                            entityType: "Fee Discount", entityName: student ? student.name : `Student #${discount.student_id}`,
                            action: "Discount Removed"
                        });
                        res.redirect(`/fee-payments/${discount.student_id}`);
                    });

                }
            );

        }
    );

});


/* ===========================================
   EXPORT FEE PAYMENTS (Excel) - behind the per-school toggle in Settings
   (moved above /:studentId - see note there)
=========================================== */

/* ===========================================
   IMPORT TEMPLATE (blank, headers only)
   (moved above /:studentId - see note there)
=========================================== */

/* ===========================================
   IMPORT FEE PAYMENTS (Excel)
   Unlike Student or Attendance import, this always INSERTS - a fee
   payment is a historical financial record, not something that makes
   sense to "update" by re-importing. To keep a re-uploaded file from
   double-counting payments, a row is skipped as a likely duplicate if a
   payment already exists for the same Student + Fee Category + Academic
   Year + Date + Amount (Receipt No. is compared too when the row
   provides one).
   Receipt Numbers: if the row includes one, it's kept as-is (useful when
   migrating historical numbers from a previous system); if blank, a new
   one is auto-assigned using this school's configured format (see
   Settings > Receipt Number Format).
=========================================== */
router.post("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments"), uploadSpreadsheet.single("file"), async (req, res) => {

    if (!req.file) return res.render("importFeePayments", { result: { error: "Please choose a file to upload." } });

    const schoolId = req.schoolId;

    try {

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.worksheets[0];

        const headerRow = sheet.getRow(1);
        const colIndexByHeader = {};
        headerRow.eachCell((cell, colNumber) => {
            const norm = String(cell.value || "").trim().toLowerCase();
            const map = {
                "roll number": "admission_no", "student name": "student_name", "fee category": "fee_name",
                "academic year": "academic_year", "amount paid": "amount_paid", "payment date": "payment_date",
                "mode": "mode", "reference no.": "reference_no", "receipt no.": "receipt_no", "remarks": "remarks"
            };
            if (map[norm]) colIndexByHeader[map[norm]] = colNumber;
        });

        const required = ["student_name", "fee_name", "academic_year", "amount_paid", "payment_date"];
        if (required.some(k => !colIndexByHeader[k])) {
            return res.render("importFeePayments", { result: { error: "The sheet is missing one or more required columns: Student Name, Fee Category, Academic Year, Amount Paid, Payment Date. Download the template to check the expected format." } });
        }

        const cell = (row, key) => {
            const idx = colIndexByHeader[key];
            if (!idx) return "";
            const v = row.getCell(idx).value;
            if (v == null) return "";
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            if (typeof v === "object" && v.text) return String(v.text).trim();
            return String(v).trim();
        };

        const rowErrors = [];
        let imported = 0;
        let skippedDuplicates = 0;

        for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
            const row = sheet.getRow(rowNum);
            const studentName = cell(row, "student_name");
            const admissionNo = cell(row, "admission_no");
            const feeName = cell(row, "fee_name");
            const academicYear = cell(row, "academic_year");
            const amountPaid = parseFloat(cell(row, "amount_paid"));
            const paymentDate = cell(row, "payment_date");
            const mode = cell(row, "mode") || "Cash";
            const referenceNo = cell(row, "reference_no");
            const receiptNoGiven = cell(row, "receipt_no");
            const remarks = cell(row, "remarks");

            if (!studentName && !admissionNo) continue; // skip fully blank rows

            if (!feeName || !academicYear || !paymentDate || isNaN(amountPaid)) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): missing or invalid Fee Category, Academic Year, Amount Paid, or Payment Date.`);
                continue;
            }

            let student;
            if (admissionNo) {
                student = await feeDbGet("SELECT id, class_id FROM students WHERE school_id=? AND LOWER(TRIM(admission_no))=LOWER(TRIM(?))", [schoolId, admissionNo]);
            }
            if (!student && studentName) {
                const matches = await feeDbAll("SELECT id, class_id FROM students WHERE school_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))", [schoolId, studentName]);
                if (matches.length === 1) student = matches[0];
                else if (matches.length > 1) {
                    rowErrors.push(`Row ${rowNum} (${studentName}): more than one student has this name - add a Roll Number to this row to say which one.`);
                    continue;
                }
            }
            if (!student) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): no matching student found.`);
                continue;
            }

            // Fee Structure: matched by Fee Category + Academic Year, for
            // this student's Class OR the school-wide (class_id IS NULL)
            // fee item if no class-specific one exists - same lookup
            // logic used when a Fee Category applies to every class.
            const feeStructure = await feeDbGet(
                `SELECT fee_structure.id FROM fee_structure
                 JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
                 WHERE fee_structure.school_id=? AND LOWER(TRIM(fee_categories.fee_name))=LOWER(TRIM(?))
                   AND fee_structure.academic_year=? AND (fee_structure.class_id=? OR fee_structure.class_id IS NULL)
                 ORDER BY fee_structure.class_id IS NULL ASC LIMIT 1`,
                [schoolId, feeName, academicYear, student.class_id]
            );
            if (!feeStructure) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): no Fee Structure found for "${feeName}" / ${academicYear} matching this student's class.`);
                continue;
            }

            // Duplicate check - same student+fee+year+date+amount (and
            // receipt no. if the row gave one) already recorded.
            const dupe = await feeDbGet(
                `SELECT id FROM fee_payments WHERE school_id=? AND student_id=? AND fee_structure_id=? AND payment_date=? AND amount_paid=?
                 ${receiptNoGiven ? "AND receipt_no=?" : ""}`,
                receiptNoGiven
                    ? [schoolId, student.id, feeStructure.id, paymentDate, amountPaid, receiptNoGiven]
                    : [schoolId, student.id, feeStructure.id, paymentDate, amountPaid]
            );
            if (dupe) { skippedDuplicates++; continue; }

            const receiptNo = receiptNoGiven || await assignNextReceiptNo(schoolId);

            await feeDbRun(
                `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, reference_no, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [student.id, feeStructure.id, amountPaid, paymentDate, mode, referenceNo || null, receiptNo, remarks || null, schoolId]
            );
            imported++;
        }

        res.render("importFeePayments", { result: { imported, skippedDuplicates, rowErrors, total: sheet.rowCount - 1 } });

    } catch (e) {
        res.render("importFeePayments", { result: { error: "Could not read that file: " + e.message } });
    }

});

function feeDbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function feeDbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function feeDbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

module.exports = router;
