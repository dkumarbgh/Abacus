const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { sendMessage } = require("../services/whatsappClient");
const { requireLogin } = require("../middleware/auth");
const { computeDiscountAmount, computeNetAmount } = require("../services/feeCalc");

router.use(requireLogin);

/* ==========================================
   SELECT STUDENT TO COLLECT FEES FOR
========================================== */
router.get("/", (req, res) => {

    const search = req.query.search || "";

    db.all(
        `SELECT students.id, students.name, students.admission_no, classes.class_name
         FROM students
         LEFT JOIN classes ON students.class_id = classes.id
         WHERE students.school_id = ? AND students.name LIKE ?
         ORDER BY students.name`,
        [req.schoolId, `%${search}%`],
        (err, students) => {

            if (err) return res.send(err.message);

            res.render("fees/payments", { students, search });

        }
    );

});


/* ==========================================
   STUDENT FEE DUES + PAYMENT HISTORY + PAY FORM
========================================== */
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
            `SELECT fs.id, fc.fee_name, fs.academic_year, fs.amount
             FROM fee_structure fs
             JOIN fee_categories fc ON fs.fee_category_id = fc.id
             WHERE fs.school_id = ?
               AND ((fs.student_id IS NULL AND fs.class_id = ?) OR fs.student_id = ?)
             ORDER BY fs.academic_year DESC, fc.fee_name`,
            [schoolId, student.class_id, studentId],
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
router.post("/pay", (req, res) => {

    const { student_id, fee_structure_id, amount_paid, mode, remarks } = req.body;
    const payment_date = new Date().toISOString().slice(0, 10);
    const receipt_no = `RCPT-${Date.now()}`;
    const schoolId = req.schoolId;

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
                 (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [student_id, fee_structure_id, amount_paid, payment_date, mode || "Cash", receipt_no, remarks, schoolId],
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

                                if (!err2 && student && student.guardian_phone) {
                                    const feeName = feeInfo ? feeInfo.fee_name : "school fee";
                                    const message = `Dear Parent, we have received Rs.${amount_paid} towards "${feeName}" for ${student.name}. Receipt No: ${receipt_no}. Thank you. - School Office`;
                                    sendMessage({ phone: student.guardian_phone, message, studentId: student_id, type: "FEE_REMINDER", schoolId });
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
router.post("/mark-paid", (req, res) => {

    const { student_id, fee_structure_id } = req.body;
    const schoolId = req.schoolId;

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
                        (discErr, discount) => {

                            if (discErr) return res.send(discErr.message);

                            const alreadyPaid = payments.reduce((sum, p) => sum + p.amount_paid, 0);
                            const netAmount = computeNetAmount(ok.amount, discount);
                            const due = Math.max(netAmount - alreadyPaid, 0);

                            if (due <= 0) {
                                return res.redirect(`/fee-payments/${student_id}`);
                            }

                            const payment_date = new Date().toISOString().slice(0, 10);
                            const receipt_no = `RCPT-${Date.now()}`;

                            db.run(
                                `INSERT INTO fee_payments
                                 (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
                                 VALUES (?,?,?,?,?,?,?,?)`,
                                [student_id, fee_structure_id, due, payment_date, "Cash", receipt_no, "Marked as Paid (Simple Fee Mode)", schoolId],
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

                                                if (!err2 && student && student.guardian_phone) {
                                                    const feeName = feeInfo ? feeInfo.fee_name : "school fee";
                                                    const message = `Dear Parent, we have received full payment towards "${feeName}" for ${student.name}. Receipt No: ${receipt_no}. Thank you. - School Office`;
                                                    sendMessage({ phone: student.guardian_phone, message, studentId: student_id, type: "FEE_REMINDER", schoolId });
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
           AND fee_structure.class_id = students.class_id`,
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

                    res.redirect(`/fee-payments/${student_id}`);

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

                    res.redirect(`/fee-payments/${discount.student_id}`);

                }
            );

        }
    );

});

module.exports = router;
