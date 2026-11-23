const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { sendToPhones } = require("../services/whatsappClient");
const { requireLogin, requireSchoolFeature, requireRole } = require("../middleware/auth");
const { requireCapability } = require("../services/capabilities");
const { logChange } = require("../services/auditLog");
const { computeDiscountAmount, computeNetAmount } = require("../services/feeCalc");
const { assignNextReceiptNo } = require("../services/schoolSettings");

const uploadSpreadsheet = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.use(requireLogin);
router.use(requireCapability("fee_payments"));

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
router.get("/export", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments Import/Export"), (req, res) => {

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

router.get("/import/template", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments Import/Export"), async (req, res) => {

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

router.get("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments Import/Export"), (req, res) => {
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

    const { student_id, fee_structure_id, mode, reference_no, remarks } = req.body;
    const payment_date = new Date().toISOString().slice(0, 10);
    const schoolId = req.schoolId;

    // The form's number input is only a browser check - a direct POST used
    // to store anything (-500, 0, "abc", "") as a payment with a receipt.
    const amount_paid = Number(String(req.body.amount_paid ?? "").trim());
    if (!Number.isFinite(amount_paid) || amount_paid <= 0) {
        return res.status(400).send(
            "Please enter a payment amount greater than zero. " +
            "<a href='/fee-payments/" + encodeURIComponent(student_id || "") + "'>Go back</a>"
        );
    }

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
            db.get("SELECT simple_fee_mode FROM schools WHERE id=?", [schoolId], async (modeErr, school) => {

                if (modeErr) return res.send(modeErr.message);

                if (school && school.simple_fee_mode) {
                    return res.status(403).send(
                        "Simple Fee Mode is ON for this school - fees can only be marked Paid/Not Paid, not partial amounts. " +
                        "<a href='/fee-payments/" + student_id + "'>Go back</a>"
                    );
                }

            // Only now, once every check has passed, take the next receipt
            // number - it advances the school's counter, so taking it any
            // earlier left a gap in the sequence for every refused payment.
            let receipt_no;
            try {
                receipt_no = await assignNextReceiptNo(schoolId);
            } catch (receiptErr) {
                return res.send(receiptErr.message);
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
    // the fee item applies to this student - the same rule as /pay and
    // /mark-paid: a class-wide or Level-wide item, or one of the student's
    // OWN installments (e.g. a fee-plan month). Fee-plan installments have no
    // class/level, so discounts and waivers on them used to be refused (403).
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
   IMPORT FEE PAYMENTS (Excel or CSV)
   Unlike Student or Attendance import, this always INSERTS - a fee
   payment is a historical financial record. Safe to re-upload: a row is
   skipped as already imported when the school already has a payment for
   the same Student + Fee Category + Academic Year + Date + Amount
   (+ Receipt No. when given) - regardless of which installment it landed
   on. All rows are checked first, then saved in one transaction.
   Receipt Numbers: if the row includes one, it's kept as-is (useful when
   migrating historical numbers from a previous system); if blank, a new
   one is auto-assigned using this school's configured format (see
   Settings > Receipt Number Format).
=========================================== */
router.post("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("fees_import_export_enabled", "Fee Payments Import/Export"), uploadSpreadsheet.single("file"), async (req, res) => {

    if (!req.file) return res.render("importFeePayments", { result: { error: "Please choose a file to upload." } });

    const schoolId = req.schoolId;
    let sheet;

    // ---- Read the file (.xlsx or .csv) ----
    try {
        const workbook = new ExcelJS.Workbook();
        if (req.file.originalname.toLowerCase().endsWith(".csv")) {
            // Same temp-file route the Student import uses for CSV.
            const os = require("os");
            const fs = require("fs");
            const path = require("path");
            const tempPath = path.join(os.tmpdir(), `fee-import-${Date.now()}.csv`);
            fs.writeFileSync(tempPath, req.file.buffer);
            try { await workbook.csv.readFile(tempPath); } finally { fs.unlink(tempPath, () => {}); }
        } else {
            await workbook.xlsx.load(req.file.buffer);
        }
        sheet = workbook.worksheets[0];
    } catch (e) {
        return res.render("importFeePayments", { result: { error: "Could not read that file. Please upload the .xlsx template (or a .csv with the same columns)." } });
    }
    if (!sheet || sheet.rowCount < 2) {
        return res.render("importFeePayments", { result: { error: "That file doesn't have any data rows." } });
    }

    const headerRow = sheet.getRow(1);
    const colIndexByHeader = {};
    headerRow.eachCell((c, colNumber) => {
        const norm = String(c.value || "").trim().toLowerCase();
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

    // Raw cell value, unwrapping formulas (their calculated result) and rich text.
    const rawCell = (row, key) => {
        const idx = colIndexByHeader[key];
        if (!idx) return null;
        let v = row.getCell(idx).value;
        if (v && typeof v === "object" && !(v instanceof Date)) {
            if ("result" in v) v = v.result;
            else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join("");
            else if (v.text != null) v = v.text;
        }
        return v == null ? null : v;
    };
    const cell = (row, key) => {
        const v = rawCell(row, key);
        if (v == null) return "";
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v).trim();
    };

    const today = new Date().toISOString().slice(0, 10);
    const rowErrors = [];

    // ---- Phase 1: check every row; nothing is written yet ----
    const valid = [];
    for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
        const row = sheet.getRow(rowNum);
        const studentName = cell(row, "student_name");
        const admissionNo = cell(row, "admission_no");
        if (!studentName && !admissionNo) continue; // skip fully blank rows
        const who = studentName || admissionNo;

        const feeName = cell(row, "fee_name");
        const academicYear = cell(row, "academic_year");
        const amountPaid = parseImportAmount(rawCell(row, "amount_paid"));
        const paymentDate = parseImportDate(rawCell(row, "payment_date"));
        const receiptNoGiven = cell(row, "receipt_no");

        const problems = [];
        if (!feeName) problems.push("Fee Category is empty");
        if (!academicYear) problems.push("Academic Year is empty");
        if (amountPaid == null) problems.push(`Amount Paid "${cell(row, "amount_paid")}" is not a number`);
        else if (amountPaid <= 0) problems.push("Amount Paid must be more than zero");
        if (!paymentDate) problems.push(`Payment Date "${cell(row, "payment_date")}" is not a valid date (use DD/MM/YYYY or YYYY-MM-DD)`);
        else if (paymentDate > today) problems.push(`Payment Date ${paymentDate} is in the future`);
        else if (paymentDate < "2000-01-01") problems.push(`Payment Date ${paymentDate} looks wrong`);
        if (problems.length) { rowErrors.push(`Row ${rowNum} (${who}): ${problems.join("; ")}.`); continue; }

        let student;
        if (admissionNo) {
            student = await feeDbGet("SELECT id, name, class_id, level_id FROM students WHERE school_id=? AND LOWER(TRIM(admission_no))=LOWER(TRIM(?))", [schoolId, admissionNo]);
        }
        if (!student && studentName) {
            const matches = await feeDbAll("SELECT id, name, class_id, level_id FROM students WHERE school_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))", [schoolId, studentName]);
            if (matches.length === 1) student = matches[0];
            else if (matches.length > 1) {
                rowErrors.push(`Row ${rowNum} (${studentName}): more than one student has this name - add a Roll Number to this row to say which one.`);
                continue;
            }
        }
        if (!student) { rowErrors.push(`Row ${rowNum} (${who}): no matching student found.`); continue; }

        // Fee items this row can be paid against: this student's own
        // installments -> their Level's items -> their Class's items (older
        // setups) -> a school-wide item. "2026-27" and "2026-2027" both match.
        const years = academicYearVariants(academicYear);
        const candidates = await feeDbAll(
            `SELECT fs.id, fs.amount, fs.installment_label, fs.due_date, fs.fee_category_id,
                    CASE WHEN fs.student_id IS NOT NULL THEN 0 WHEN fs.level_id IS NOT NULL THEN 1
                         WHEN fs.class_id IS NOT NULL THEN 2 ELSE 3 END AS tier
             FROM fee_structure fs
             JOIN fee_categories fc ON fs.fee_category_id = fc.id
             WHERE fs.school_id=? AND LOWER(TRIM(fc.fee_name))=LOWER(TRIM(?))
               AND fs.academic_year IN (${years.map(() => "?").join(",")})
               AND (fs.student_id = ?
                    OR (fs.student_id IS NULL AND fs.level_id IS NOT NULL AND fs.level_id = ?)
                    OR (fs.student_id IS NULL AND fs.level_id IS NULL AND fs.class_id IS NOT NULL AND fs.class_id = ?)
                    OR (fs.student_id IS NULL AND fs.level_id IS NULL AND fs.class_id IS NULL))
             ORDER BY tier, COALESCE(fs.due_date, ''), fs.id`,
            [schoolId, feeName, ...years, student.id, student.level_id, student.class_id]
        );
        if (!candidates.length) {
            rowErrors.push(`Row ${rowNum} (${who}): no fee item found for "${feeName}" / ${academicYear} for this student, their Level or their Class.`);
            continue;
        }

        valid.push({
            rowNum, who, student, feeName, years,
            feeCategoryIds: [...new Set(candidates.map(c => c.fee_category_id))],
            tierRows: candidates.filter(c => c.tier === candidates[0].tier),
            amountPaid, paymentDate,
            mode: cell(row, "mode") || "Cash",
            referenceNo: cell(row, "reference_no"),
            receiptNoGiven,
            remarks: cell(row, "remarks"),
            // What makes two rows "the same payment" - deliberately NOT which
            // installment it lands on, which can change between uploads.
            sig: [student.id, feeName.toLowerCase(), years.slice().sort().join("|"), paymentDate, amountPaid, receiptNoGiven.toLowerCase()].join("~")
        });
    }

    // Receipt numbers given in the file must be unique within the file.
    const seenReceipts = new Map();
    for (const v of valid) {
        if (!v.receiptNoGiven) continue;
        const key = v.receiptNoGiven.toLowerCase();
        if (seenReceipts.has(key)) {
            rowErrors.push(`Row ${v.rowNum} (${v.who}): Receipt No. ${v.receiptNoGiven} is also used on row ${seenReceipts.get(key)}.`);
            v.skip = true;
        } else seenReceipts.set(key, v.rowNum);
    }

    // ---- Phase 2: write everything in ONE transaction ----
    // If anything unexpected fails, nothing from this file is saved - no more
    // half-imported files.
    let imported = 0, skippedDuplicates = 0;
    try {
        await feeDbRun("BEGIN IMMEDIATE", []);
        const usedFromDb = new Map();   // sig -> existing payments already matched to rows of this file
        const addedThisFile = new Map(); // sig -> payments this upload has inserted so far

        for (const v of valid) {
            if (v.skip) continue;

            // Duplicate check by count: if the school already has N payments
            // with the same student, fee, year, date and amount, the first N
            // matching rows of this file are treated as already imported.
            // Re-uploading a file therefore never adds anything twice, while
            // two genuine identical payments in one file are both kept.
            const existingCount = (await feeDbGet(
                `SELECT COUNT(*) AS n FROM fee_payments p JOIN fee_structure fs ON fs.id = p.fee_structure_id
                 WHERE p.school_id=? AND p.student_id=? AND p.payment_date=? AND p.amount_paid=?
                   AND fs.fee_category_id IN (${v.feeCategoryIds.map(() => "?").join(",")})
                   AND fs.academic_year IN (${v.years.map(() => "?").join(",")})
                   ${v.receiptNoGiven ? "AND LOWER(p.receipt_no)=LOWER(?)" : ""}`,
                [schoolId, v.student.id, v.paymentDate, v.amountPaid, ...v.feeCategoryIds, ...v.years,
                    ...(v.receiptNoGiven ? [v.receiptNoGiven] : [])]
            )).n;
            // The count above also sees rows this upload already inserted (same
            // transaction) - take those off so only payments that existed
            // BEFORE this upload count as "already imported".
            const priorCount = existingCount - (addedThisFile.get(v.sig) || 0);
            const used = usedFromDb.get(v.sig) || 0;
            if (used < priorCount) { usedFromDb.set(v.sig, used + 1); skippedDuplicates++; continue; }

            // A given receipt number must not belong to any other payment
            // (receipt numbers are unique across the whole system).
            if (v.receiptNoGiven) {
                const taken = await feeDbGet("SELECT id FROM fee_payments WHERE LOWER(receipt_no)=LOWER(?)", [v.receiptNoGiven]);
                if (taken) {
                    rowErrors.push(`Row ${v.rowNum} (${v.who}): Receipt No. ${v.receiptNoGiven} is already used by another payment - leave it blank to get a new number.`);
                    continue;
                }
            }

            // Pick the installment: the one for the payment's month if it
            // still has something owing; otherwise the earliest one still
            // owing; otherwise the payment's month; otherwise the first.
            const owing = [];
            for (const c of v.tierRows) {
                const paid = (await feeDbGet("SELECT COALESCE(SUM(amount_paid),0) AS s FROM fee_payments WHERE fee_structure_id=? AND student_id=?", [c.id, v.student.id])).s;
                const disc = await feeDbGet("SELECT discount_type, discount_value FROM fee_discounts WHERE fee_structure_id=? AND student_id=?", [c.id, v.student.id]);
                const net = disc ? (disc.discount_type === "PERCENT" ? c.amount * (1 - disc.discount_value / 100) : Math.max(c.amount - disc.discount_value, 0)) : c.amount;
                if (Number(paid) < Number(net)) owing.push(c);
            }
            const monthLabel = (installmentLabelForDate(v.paymentDate) || "").toLowerCase();
            const isMonth = c => String(c.installment_label || "").trim().toLowerCase() === monthLabel;
            const feeStructure = owing.find(isMonth) || owing[0] || v.tierRows.find(isMonth) || v.tierRows[0];

            const receiptNo = v.receiptNoGiven || await assignNextReceiptNo(schoolId);
            await feeDbRun(
                `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, reference_no, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [v.student.id, feeStructure.id, v.amountPaid, v.paymentDate, v.mode, v.referenceNo || null, receiptNo, v.remarks || null, schoolId]
            );
            addedThisFile.set(v.sig, (addedThisFile.get(v.sig) || 0) + 1);
            imported++;
        }

        await feeDbRun("COMMIT", []);
    } catch (e) {
        await feeDbRun("ROLLBACK", []).catch(() => {});
        return res.render("importFeePayments", { result: {
            error: `Nothing was imported - the file was stopped part-way by an unexpected error, so all of its rows were undone. Please fix the file and upload it again. (${e.message})`
        } });
    }

    res.render("importFeePayments", { result: { imported, skippedDuplicates, rowErrors, total: sheet.rowCount - 1 } });

});

// Amount cell -> number, or null if it isn't one. Accepts 1600, "1600",
// "1,600", "1,600.50", "Rs 800", "Rs. 800", "INR 800", "₹800".
function parseImportAmount(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const cleaned = String(value).trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return parseFloat(cleaned);
}

// Date cell -> "YYYY-MM-DD", or null if it isn't a real date. Accepts real
// Excel dates, YYYY-MM-DD, and day-first DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY.
function parseImportDate(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    const v = String(value).trim();
    let y, m, d, mt;
    if ((mt = v.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) { [, y, m, d] = mt; }
    else if ((mt = v.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/))) { [, d, m, y] = mt; }
    else return null;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dt = new Date(`${iso}T00:00:00Z`);
    if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
    return iso;
}

function feeDbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function feeDbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function feeDbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

// "2026-2027", "2026-27", "2026/27" -> ["<as given>", "2026-27", "2026-2027"]
function academicYearVariants(year) {
    const raw = String(year || "").trim();
    const out = new Set([raw]);
    const m = raw.match(/^(\d{4})\s*[-\/]\s*(\d{2}|\d{4})$/);
    if (m) {
        const start = m[1];
        const endFull = m[2].length === 4 ? m[2] : start.slice(0, 2) + m[2];
        out.add(`${start}-${endFull.slice(2)}`);
        out.add(`${start}-${endFull}`);
    }
    return [...out];
}

// "2026-11-20" -> "November 2026" (matches fee_structure.installment_label)
function installmentLabelForDate(dateStr) {
    const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-\d{2}/);
    if (!m) return null;
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const idx = parseInt(m[2], 10) - 1;
    return months[idx] ? `${months[idx]} ${m[1]}` : null;
}

module.exports = router;
