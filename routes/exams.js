const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { computeNetAmount } = require("../services/feeCalc");
const { logChange } = require("../services/auditLog");

router.use(requireLogin);

/* ===========================================
   EXAM LIST + CREATE FORM
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId], (err, levels) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT exams.*, level.name AS level_name,
                    fee_structure.amount AS fee_amount
             FROM exams
             JOIN lookup_items level ON exams.level_id = level.id
             LEFT JOIN fee_structure ON exams.fee_structure_id = fee_structure.id
             WHERE exams.school_id = ?
             ORDER BY exams.exam_date DESC`,
            [schoolId],
            async (err, exams) => {

                if (err) return res.send(err.message);

                // For each exam that has a fee, show a quick "X of Y paid"
                // count - informational only, doesn't block anything (see
                // the note on the Exam Fee field itself). Computed in JS
                // rather than pure SQL so discounts/waivers are accounted
                // for correctly (a student who fully paid their DISCOUNTED
                // amount should count as paid, not show as still owing).
                for (const exam of exams) {
                    if (!exam.fee_structure_id) continue;

                    const [levelStudents, payments, discounts] = await Promise.all([
                        dbAllAsync("SELECT id FROM students WHERE school_id=? AND level_id=?", [schoolId, exam.level_id]),
                        dbAllAsync("SELECT student_id, amount_paid FROM fee_payments WHERE fee_structure_id=? AND school_id=?", [exam.fee_structure_id, schoolId]),
                        dbAllAsync("SELECT student_id, discount_type, discount_value FROM fee_discounts WHERE fee_structure_id=? AND school_id=?", [exam.fee_structure_id, schoolId])
                    ]);

                    let paidCount = 0;
                    levelStudents.forEach(s => {
                        const paid = payments.filter(p => p.student_id === s.id).reduce((sum, p) => sum + p.amount_paid, 0);
                        const discount = discounts.find(d => d.student_id === s.id) || null;
                        const netAmount = computeNetAmount(exam.fee_amount, discount);
                        if (paid >= netAmount) paidCount++;
                    });

                    exam.feePaidCount = paidCount;
                    exam.feeTotalCount = levelStudents.length;
                }

                res.render("exams", { levels, exams });

            }
        );

    });

});


/* ===========================================
   CREATE EXAM
   An optional Exam Fee amount, if given, is NOT tracked separately -
   it reuses the exact same fee_structure/fee_payments/fee_discounts
   machinery as every other fee, by auto-creating a Fee Category (named
   after this exam, so it's distinguishable from other exams' fees in
   reports) and a Fee Structure row for this exam's Level + Academic
   Year. That row then shows up automatically in Fee Dues, Fee
   Collection, Fee Collection Summary, and Student Payment History -
   and can be discounted or waived per student the same way any other
   fee already can, from the normal Fee Collection screen.
=========================================== */
router.post("/add", async (req, res) => {

    const { exam_name, level_id, academic_year, exam_date, fee_amount } = req.body;
    const schoolId = req.schoolId;

    try {

        let feeStructureId = null;
        const amount = parseFloat(fee_amount);

        if (!isNaN(amount) && amount > 0) {

            const categoryName = `Exam Fee: ${exam_name}`.slice(0, 190);

            // Reuse an existing category of this exact name if one
            // somehow already exists (e.g. two exams named identically),
            // rather than erroring - fee_categories has no hard DB-level
            // uniqueness constraint, just the manual check in routes/fees.js.
            let category = await dbGetOne("SELECT id FROM fee_categories WHERE school_id=? AND fee_name=?", [schoolId, categoryName]);
            if (!category) {
                const result = await dbRunAsync(
                    "INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)",
                    [categoryName, `Auto-created for the exam "${exam_name}"`, schoolId]
                );
                category = { id: result.lastID };
            }

            const structResult = await dbRunAsync(
                "INSERT INTO fee_structure (level_id, fee_category_id, academic_year, amount, school_id) VALUES (?,?,?,?,?)",
                [level_id, category.id, academic_year, amount, schoolId]
            );
            feeStructureId = structResult.lastID;

        }

        await dbRunAsync(
            `INSERT INTO exams (exam_name, level_id, academic_year, exam_date, fee_structure_id, school_id)
             VALUES (?,?,?,?,?,?)`,
            [exam_name, level_id, academic_year, exam_date, feeStructureId, schoolId]
        );

        logChange({
            schoolId, branchId: null, req,
            entityType: "Exam", entityName: exam_name, action: "Created",
            details: feeStructureId ? `${academic_year}, exam fee ₹${amount}` : academic_year
        });

        res.redirect("/exams");

    } catch (e) {
        res.send(e.message);
    }

});

function dbGetOne(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRunAsync(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}
function dbAllAsync(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}


/* ===========================================
   DELETE EXAM
=========================================== */
router.get("/delete/:id", (req, res) => {

    const schoolId = req.schoolId;

    db.get("SELECT exam_name FROM exams WHERE id=? AND school_id=?", [req.params.id, schoolId], (errLookup, exam) => {

        db.run("DELETE FROM exam_results WHERE exam_id=? AND school_id=?", [req.params.id, schoolId], () => {

            db.run("DELETE FROM exams WHERE id=? AND school_id=?", [req.params.id, schoolId], (err) => {

                if (err) return res.send(err.message);

                logChange({
                    schoolId, branchId: null, req,
                    entityType: "Exam", entityName: exam ? exam.exam_name : `#${req.params.id}`, action: "Deleted"
                });

                res.redirect("/exams");

            });

        });

    });

});


/* ===========================================
   MARKS ENTRY - pick subject for an exam
   Search: roll number and/or name narrow the student list shown for
   marks entry, without changing which students are eligible (still every
   student in the exam's Level).
=========================================== */
router.get("/marks/:examId", (req, res) => {

    const examId = req.params.examId;
    const schoolId = req.schoolId;
    const studentName = (req.query.student_name || "").trim();
    const rollNumber = (req.query.roll_number || "").trim();

    db.get(
        `SELECT exams.*, level.name AS level_name
         FROM exams JOIN lookup_items level ON exams.level_id = level.id
         WHERE exams.id=? AND exams.school_id=?`,
        [examId, schoolId],
        (err, exam) => {

            if (err) return res.send(err.message);
            if (!exam) return res.send("Exam not found");

            db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

                if (err) return res.send(err.message);

                const subject_id = req.query.subject_id;

                if (!subject_id) {
                    return res.render("examMarks", { exam, subjects, subject_id: null, students: [], studentName, rollNumber });
                }

                let sql = `
                    SELECT students.id, students.name, students.admission_no,
                           exam_results.marks_obtained, exam_results.max_marks
                    FROM students
                    LEFT JOIN exam_results
                       ON exam_results.student_id = students.id
                       AND exam_results.exam_id = ?
                       AND exam_results.subject_id = ?
                    WHERE students.level_id = ? AND students.school_id = ?
                `;
                const params = [examId, subject_id, exam.level_id, schoolId];
                if (studentName) { sql += " AND students.name LIKE ?"; params.push(`%${studentName}%`); }
                if (rollNumber) { sql += " AND students.admission_no LIKE ?"; params.push(`%${rollNumber}%`); }
                sql += " ORDER BY students.name";

                db.all(sql, params, (err, students) => {

                    if (err) return res.send(err.message);

                    res.render("examMarks", { exam, subjects, subject_id, students, studentName, rollNumber });

                });

            });

        }
    );

});


/* ===========================================
   SAVE MARKS FOR A SUBJECT
=========================================== */
router.post("/marks/:examId", (req, res) => {

    const examId = req.params.examId;
    const { subject_id, max_marks, student_id, marks } = req.body;
    const schoolId = req.schoolId;

    // student_id[] and marks[] arrive as parallel arrays from the form
    const ids = Array.isArray(student_id) ? student_id : [student_id];
    const marksArr = Array.isArray(marks) ? marks : [marks];

    let remaining = ids.length;
    if (remaining === 0) return res.redirect(`/exams/marks/${examId}?subject_id=${subject_id}`);

    ids.forEach((sid, i) => {

        const obtained = marksArr[i] === "" ? null : Number(marksArr[i]);

        if (obtained === null) {
            remaining--;
            if (remaining === 0) res.redirect(`/exams/marks/${examId}?subject_id=${subject_id}`);
            return;
        }

        db.run(
            `INSERT INTO exam_results (exam_id, student_id, subject_id, marks_obtained, max_marks, school_id)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(exam_id, student_id, subject_id) DO UPDATE SET
                marks_obtained=excluded.marks_obtained,
                max_marks=excluded.max_marks`,
            [examId, sid, subject_id, obtained, max_marks || 100, schoolId],
            () => {
                remaining--;
                if (remaining === 0) res.redirect(`/exams/marks/${examId}?subject_id=${subject_id}`);
            }
        );

    });

});

module.exports = router;
