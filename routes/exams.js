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

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT exams.*, classes.class_name
             FROM exams
             JOIN classes ON exams.class_id = classes.id
             WHERE exams.school_id = ?
             ORDER BY exams.exam_date DESC`,
            [schoolId],
            (err, exams) => {

                if (err) return res.send(err.message);

                res.render("exams", { classes, exams });

            }
        );

    });

});


/* ===========================================
   CREATE EXAM
=========================================== */
router.post("/add", (req, res) => {

    const { exam_name, class_id, academic_year, exam_date } = req.body;

    db.run(
        `INSERT INTO exams (exam_name, class_id, academic_year, exam_date, school_id)
         VALUES (?,?,?,?,?)`,
        [exam_name, class_id, academic_year, exam_date, req.schoolId],
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
=========================================== */
router.get("/marks/:examId", (req, res) => {

    const examId = req.params.examId;
    const schoolId = req.schoolId;

    db.get(
        `SELECT exams.*, classes.class_name
         FROM exams JOIN classes ON exams.class_id = classes.id
         WHERE exams.id=? AND exams.school_id=?`,
        [examId, schoolId],
        (err, exam) => {

            if (err) return res.send(err.message);
            if (!exam) return res.send("Exam not found");

            db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

                if (err) return res.send(err.message);

                const subject_id = req.query.subject_id;

                if (!subject_id) {
                    return res.render("examMarks", { exam, subjects, subject_id: null, students: [] });
                }

                db.all(
                    `SELECT students.id, students.name,
                            exam_results.marks_obtained, exam_results.max_marks
                     FROM students
                     LEFT JOIN exam_results
                        ON exam_results.student_id = students.id
                        AND exam_results.exam_id = ?
                        AND exam_results.subject_id = ?
                     WHERE students.class_id = ? AND students.school_id = ?
                     ORDER BY students.name`,
                    [examId, subject_id, exam.class_id, schoolId],
                    (err, students) => {

                        if (err) return res.send(err.message);

                        res.render("examMarks", { exam, subjects, subject_id, students });

                    }
                );

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
