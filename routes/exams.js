const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   EXAM LIST + CREATE FORM
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId], (err, levels) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT exams.*, level.name AS level_name
             FROM exams
             JOIN lookup_items level ON exams.level_id = level.id
             WHERE exams.school_id = ?
             ORDER BY exams.exam_date DESC`,
            [schoolId],
            (err, exams) => {

                if (err) return res.send(err.message);

                res.render("exams", { levels, exams });

            }
        );

    });

});


/* ===========================================
   CREATE EXAM
=========================================== */
router.post("/add", (req, res) => {

    const { exam_name, level_id, academic_year, exam_date } = req.body;

    db.run(
        `INSERT INTO exams (exam_name, level_id, academic_year, exam_date, school_id)
         VALUES (?,?,?,?,?)`,
        [exam_name, level_id, academic_year, exam_date, req.schoolId],
        function(err) {

            if (err) return res.send(err.message);

            res.redirect("/exams");

        }
    );

});


/* ===========================================
   DELETE EXAM
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.run("DELETE FROM exam_results WHERE exam_id=? AND school_id=?", [req.params.id, req.schoolId], () => {

        db.run("DELETE FROM exams WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err) => {

            if (err) return res.send(err.message);

            res.redirect("/exams");

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
