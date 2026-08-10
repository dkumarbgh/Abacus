const express = require("express");
const router = express.Router();
const db = require("../config/database");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { sendBulk } = require("../services/whatsappClient");
const { requireLogin } = require("../middleware/auth");
const { computeDiscountAmount, computeNetAmount } = require("../services/feeCalc");
const { getSimpleFeeMode } = require("../services/schoolSettings");

router.use(requireLogin);

/* ===========================================
   REPORTS HUB
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT exams.*, classes.class_name FROM exams
             JOIN classes ON exams.class_id = classes.id
             WHERE exams.school_id = ?
             ORDER BY exams.exam_date DESC`,
            [schoolId],
            (err, exams) => {

                if (err) return res.send(err.message);

                res.render("reportsHub", { classes, exams });

            }
        );

    });

});


/* =========================================================
   Helper: compute dues for every student across all their
   class's fee_structure items. Returns array of
   { student, feeItems: [{...structure, paid, due}], totalDue }
========================================================= */
function computeDuesByClass(schoolId, classId, callback) {

    const params = [schoolId];
    let studentSql = `
        SELECT students.*, classes.class_name
        FROM students
        LEFT JOIN classes ON students.class_id = classes.id
        WHERE students.school_id = ?
    `;
    if (classId) { studentSql += " AND students.class_id=?"; params.push(classId); }

    db.all(studentSql, params, (err, students) => {

        if (err) return callback(err);

        db.all(
            `SELECT fs.*, fc.fee_name FROM fee_structure fs
             JOIN fee_categories fc ON fs.fee_category_id = fc.id
             WHERE fs.school_id = ?`,
            [schoolId],
            (err, allStructures) => {

                if (err) return callback(err);

                db.all("SELECT * FROM fee_payments WHERE school_id = ?", [schoolId], (err, allPayments) => {

                    if (err) return callback(err);

                    db.all("SELECT * FROM fee_discounts WHERE school_id = ?", [schoolId], (err, allDiscounts) => {

                        if (err) return callback(err);

                        const results = students.map(student => {

                            // A fee_structure row applies to this student if it's either a
                            // class-wide item (student_id IS NULL, same class) or a
                            // personalized item created just for THIS student (e.g. the
                            // "Course Fee" from Total Fee on their profile) - never someone
                            // else's personalized item, even if they're in the same class.
                            const structures = allStructures.filter(fs =>
                                (fs.student_id == null && fs.class_id === student.class_id) ||
                                fs.student_id === student.id
                            );

                            const feeItems = structures.map(fs => {
                                const paid = allPayments
                                    .filter(p => p.student_id === student.id && p.fee_structure_id === fs.id)
                                    .reduce((sum, p) => sum + p.amount_paid, 0);
                                const discount = allDiscounts.find(
                                    d => d.student_id === student.id && d.fee_structure_id === fs.id
                                ) || null;
                                const netAmount = computeNetAmount(fs.amount, discount);
                                return {
                                    ...fs,
                                    // Due date now comes from the student's own record, not the
                                    // (shared, class-wide) fee_structure row - see Student > Edit.
                                    due_date: student.fee_due_date || null,
                                    paid,
                                    discount,
                                    discountAmount: computeDiscountAmount(fs.amount, discount),
                                    netAmount,
                                    due: Math.max(netAmount - paid, 0)
                                };
                            });

                            const totalDue = feeItems.reduce((sum, f) => sum + f.due, 0);

                            return { student, feeItems, totalDue };

                        });

                        callback(null, results);

                    });

                });

            }
        );

    });

}


/* ===========================================
   FEES DUE REPORT (upcoming / overdue by due date)
=========================================== */
router.get("/fees-due", (req, res) => {

    const { class_id } = req.query;
    const schoolId = req.schoolId;

    computeDuesByClass(schoolId, class_id, (err, results) => {

        if (err) return res.send(err.message);

        const today = new Date().toISOString().slice(0, 10);

        // Flatten to one row per (student, fee item) that still has a due amount and a due date
        const rows = [];
        results.forEach(r => {
            r.feeItems.forEach(f => {
                if (f.due > 0 && f.due_date) {
                    rows.push({
                        student: r.student,
                        fee_name: f.fee_name,
                        due_date: f.due_date,
                        due: f.due,
                        overdue: f.due_date < today
                    });
                }
            });
        });

        rows.sort((a, b) => a.due_date.localeCompare(b.due_date));

        db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err2, classes) => {

            getSimpleFeeMode(schoolId)
                .then(simpleFeeMode => res.render("feesDueReport", { rows, classes, class_id, simpleFeeMode }))
                .catch(err3 => res.send(err3.message));

        });

    });

});


/* ===========================================
   FEES PENDING REPORT (any outstanding balance)
   + bulk WhatsApp reminder
=========================================== */
router.get("/fees-pending", (req, res) => {

    const { class_id } = req.query;
    const schoolId = req.schoolId;

    computeDuesByClass(schoolId, class_id, (err, results) => {

        if (err) return res.send(err.message);

        const pending = results.filter(r => r.totalDue > 0);

        db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err2, classes) => {

            getSimpleFeeMode(schoolId)
                .then(simpleFeeMode => res.render("feesPendingReport", { pending, classes, class_id, simpleFeeMode }))
                .catch(err3 => res.send(err3.message));

        });

    });

});

router.post("/fees-pending/remind", (req, res) => {

    const { class_id } = req.body;
    const schoolId = req.schoolId;

    computeDuesByClass(schoolId, class_id, (err, results) => {

        if (err) return res.send(err.message);

        const pending = results.filter(r => r.totalDue > 0 && r.student.guardian_phone);

        getSimpleFeeMode(schoolId).then(simpleFeeMode => {

            const recipients = pending.map(r => ({
                phone: r.student.guardian_phone,
                studentId: r.student.id,
                type: "FEE_REMINDER",
                schoolId,
                message: simpleFeeMode
                    ? `Dear Parent, school fees are still pending for ${r.student.name}. Kindly clear the dues at the earliest. - School Office`
                    : `Dear Parent, a total of Rs.${r.totalDue} in school fees is pending for ${r.student.name}. Kindly clear the dues at the earliest. - School Office`
            }));

            res.redirect(`/reports/fees-pending${class_id ? "?class_id=" + class_id : ""}`);
            sendBulk(recipients, 3000);

        }).catch(err2 => res.send(err2.message));

    });

});


/* ===========================================
   ATTENDANCE REPORT (by class + date range)
=========================================== */
router.get("/attendance", (req, res) => {

    const { class_id, from, to } = req.query;
    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        if (!class_id) {
            return res.render("attendanceReport", { classes, class_id: "", from: from || "", to: to || "", rows: null });
        }

        // IMPORTANT: params must be in the same order the ? placeholders
        // appear in the query text below - the date-range placeholders sit
        // inside the JOIN...ON clause, which comes BEFORE the WHERE clause's
        // class_id/school_id placeholders. (Previously class_id/school_id
        // were pushed first, so with a date range selected they'd silently
        // bind to the wrong placeholders and the report would come back
        // empty - "No students in this class" even though the class exists.)
        const params = [];
        let dateFilter = "";
        if (from && to) {
            dateFilter = " AND attendance.attendance_date BETWEEN ? AND ?";
            params.push(from, to);
        }
        params.push(class_id, schoolId);

        db.all(
            `SELECT students.id, students.name,
                    SUM(CASE WHEN attendance.status='Present' THEN 1 ELSE 0 END) present_days,
                    COUNT(attendance.id) total_marked
             FROM students
             LEFT JOIN attendance ON attendance.student_id = students.id ${dateFilter}
             WHERE students.class_id = ? AND students.school_id = ?
             GROUP BY students.id
             ORDER BY students.name`,
            params,
            (err, rows) => {

                if (err) return res.send(err.message);

                const withPct = rows.map(r => ({
                    ...r,
                    pct: r.total_marked > 0 ? ((r.present_days / r.total_marked) * 100).toFixed(1) : "N/A"
                }));

                res.render("attendanceReport", { classes, class_id, from: from || "", to: to || "", rows: withPct });

            }
        );

    });

});

router.get("/attendance/excel", (req, res) => {

    const { class_id, from, to } = req.query;
    const schoolId = req.schoolId;
    if (!class_id) return res.status(400).send("class_id is required");

    // Same param-order fix as /attendance above: date-range placeholders
    // appear first in the query text (inside JOIN...ON), so they must be
    // pushed first here too.
    const params = [];
    let dateFilter = "";
    if (from && to) {
        dateFilter = " AND attendance.attendance_date BETWEEN ? AND ?";
        params.push(from, to);
    }
    params.push(class_id, schoolId);

    db.all(
        `SELECT students.name,
                SUM(CASE WHEN attendance.status='Present' THEN 1 ELSE 0 END) present_days,
                COUNT(attendance.id) total_marked
         FROM students
         LEFT JOIN attendance ON attendance.student_id = students.id ${dateFilter}
         WHERE students.class_id = ? AND students.school_id = ?
         GROUP BY students.id
         ORDER BY students.name`,
        params,
        async (err, rows) => {

            if (err) return res.send(err.message);

            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet("Attendance");
            sheet.columns = [
                { header: "Student", key: "name", width: 25 },
                { header: "Present Days", key: "present_days", width: 15 },
                { header: "Total Marked", key: "total_marked", width: 15 },
                { header: "% Attendance", key: "pct", width: 15 }
            ];
            rows.forEach(r => sheet.addRow({
                ...r,
                pct: r.total_marked > 0 ? ((r.present_days / r.total_marked) * 100).toFixed(1) + "%" : "N/A"
            }));
            sheet.getRow(1).font = { bold: true };

            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", "attachment; filename=attendance-report.xlsx");
            await workbook.xlsx.write(res);
            res.end();

        }
    );

});


/* ===========================================
   EXAM LEVEL RESULTS REPORT
=========================================== */
router.get("/exam-results/:examId", (req, res) => {

    const examId = req.params.examId;
    const schoolId = req.schoolId;

    db.get(
        `SELECT exams.*, classes.class_name FROM exams
         JOIN classes ON exams.class_id = classes.id
         WHERE exams.id=? AND exams.school_id=?`,
        [examId, schoolId],
        (err, exam) => {

            if (err) return res.send(err.message);
            if (!exam) return res.send("Exam not found");

            db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, allSubjects) => {

                if (err) return res.send(err.message);

                db.all(
                    `SELECT exam_results.*, students.name AS student_name, subjects.subject_name
                     FROM exam_results
                     JOIN students ON exam_results.student_id = students.id
                     JOIN subjects ON exam_results.subject_id = subjects.id
                     WHERE exam_results.exam_id = ? AND exam_results.school_id = ?`,
                    [examId, schoolId],
                    (err, results) => {

                        if (err) return res.send(err.message);

                        // Which subjects actually have marks entered for this exam (keeps the table tidy)
                        const subjectIds = [...new Set(results.map(r => r.subject_id))];
                        const subjects = allSubjects.filter(s => subjectIds.includes(s.id));

                        // Pivot: one row per student with a column per subject, total, percentage
                        const byStudent = {};
                        results.forEach(r => {
                            if (!byStudent[r.student_id]) {
                                byStudent[r.student_id] = { student_name: r.student_name, marks: {}, total: 0, maxTotal: 0 };
                            }
                            byStudent[r.student_id].marks[r.subject_id] = r.marks_obtained;
                            byStudent[r.student_id].total += r.marks_obtained;
                            byStudent[r.student_id].maxTotal += r.max_marks;
                        });

                        let rows = Object.values(byStudent).map(r => ({
                            ...r,
                            percentage: r.maxTotal > 0 ? ((r.total / r.maxTotal) * 100).toFixed(1) : "0.0"
                        }));

                        // Rank by total marks, highest first
                        rows.sort((a, b) => b.total - a.total);
                        rows.forEach((r, i) => r.rank = i + 1);

                        res.render("examResultsReport", { exam, subjects, rows });

                    }
                );

            });

        }
    );

});


/* ===========================================
   STUDENT INDIVIDUAL REPORT (profile + attendance + fees + exams)
=========================================== */
router.get("/student/:id", (req, res) => {

    const studentId = req.params.id;
    const schoolId = req.schoolId;

    db.get(
        `SELECT students.*, classes.class_name FROM students
         LEFT JOIN classes ON students.class_id = classes.id
         WHERE students.id=? AND students.school_id=?`,
        [studentId, schoolId],
        (err, student) => {

            if (err) return res.send(err.message);
            if (!student) return res.send("Student not found");

            db.get(
                `SELECT
                    SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) present_days,
                    COUNT(*) total_marked
                 FROM attendance WHERE student_id=? AND school_id=?`,
                [studentId, schoolId],
                (err, attSummary) => {

                    if (err) return res.send(err.message);

                    computeDuesByClass(schoolId, student.class_id, (err, duesResults) => {

                        if (err) return res.send(err.message);

                        const feeInfo = duesResults.find(r => r.student.id == studentId) || { feeItems: [], totalDue: 0 };

                        db.all(
                            `SELECT exams.exam_name, exams.exam_date, subjects.subject_name,
                                    exam_results.marks_obtained, exam_results.max_marks
                             FROM exam_results
                             JOIN exams ON exam_results.exam_id = exams.id
                             JOIN subjects ON exam_results.subject_id = subjects.id
                             WHERE exam_results.student_id = ? AND exam_results.school_id = ?
                             ORDER BY exams.exam_date DESC`,
                            [studentId, schoolId],
                            (err, examResults) => {

                                if (err) return res.send(err.message);

                                const attendancePct = attSummary.total_marked > 0
                                    ? ((attSummary.present_days / attSummary.total_marked) * 100).toFixed(1)
                                    : "N/A";

                                getSimpleFeeMode(schoolId).then(simpleFeeMode => {
                                    res.render("studentReport", {
                                        student,
                                        attSummary,
                                        attendancePct,
                                        feeInfo,
                                        examResults,
                                        simpleFeeMode
                                    });
                                }).catch(err2 => res.send(err2.message));

                            }
                        );

                    });

                }
            );

        }
    );

});


/* ===========================================
   FEE RECEIPT (PDF)
=========================================== */
router.get("/receipt/:paymentId", (req, res) => {

    db.get(
        `SELECT fee_payments.*, students.name AS student_name, students.admission_no,
                fee_categories.fee_name
         FROM fee_payments
         JOIN students ON fee_payments.student_id = students.id
         JOIN fee_structure ON fee_payments.fee_structure_id = fee_structure.id
         JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
         WHERE fee_payments.id=? AND fee_payments.school_id=?`,
        [req.params.paymentId, req.schoolId],
        (err, payment) => {

            if (err) return res.send(err.message);
            if (!payment) return res.send("Payment not found");

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="${payment.receipt_no}.pdf"`);

            const doc = new PDFDocument({ margin: 50 });
            doc.pipe(res);

            doc.fontSize(18).text("School Fee Receipt", { align: "center" });
            doc.moveDown(2);

            doc.fontSize(11);
            doc.text(`Receipt No: ${payment.receipt_no}`);
            doc.text(`Date: ${payment.payment_date}`);
            doc.moveDown();
            doc.text(`Student: ${payment.student_name}`);
            doc.text(`Admission No: ${payment.admission_no || "-"}`);
            doc.moveDown();
            doc.text(`Fee: ${payment.fee_name}`);
            doc.text(`Amount Paid: Rs. ${payment.amount_paid}`);
            doc.text(`Mode: ${payment.mode}`);
            if (payment.remarks) doc.text(`Remarks: ${payment.remarks}`);

            doc.moveDown(3);
            doc.text("_______________________", { align: "right" });
            doc.text("Authorized Signatory", { align: "right" });

            doc.end();

        }
    );

});

module.exports = router;
