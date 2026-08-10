const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   ASSIGNMENT HOME
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM teachers WHERE school_id=? ORDER BY name", [schoolId], (err, teachers) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

            if (err) return res.send(err.message);

            db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

                if (err) return res.send(err.message);

                const sql = `
                    SELECT
                        teacher_subjects.id,
                        teachers.name AS teacher_name,
                        subjects.subject_name,
                        classes.class_name
                    FROM teacher_subjects
                    INNER JOIN teachers
                        ON teacher_subjects.teacher_id = teachers.id
                    INNER JOIN subjects
                        ON teacher_subjects.subject_id = subjects.id
                    INNER JOIN classes
                        ON teacher_subjects.class_id = classes.id
                    WHERE teacher_subjects.school_id = ?
                    ORDER BY teachers.name
                `;

                db.all(sql, [schoolId], (err, assignments) => {

                    if (err) return res.send(err.message);

                    res.render("assignments", {
                        teachers,
                        subjects,
                        classes,
                        assignments
                    });

                });

            });

        });

    });

});


/* ===========================================
   SAVE ASSIGNMENT
=========================================== */
router.post("/add", (req, res) => {

    const { teacher_id, subject_id, class_id } = req.body;
    const schoolId = req.schoolId;

    db.get(
        `SELECT id
         FROM teacher_subjects
         WHERE teacher_id=?
         AND subject_id=?
         AND class_id=?
         AND school_id=?`,
        [teacher_id, subject_id, class_id, schoolId],
        (err, row) => {

            if (err) {
                return res.send(err.message);
            }

            if (row) {
                return res.send(
                    "<h2>This assignment already exists.</h2><br><a href='/assignments'>Back</a>"
                );
            }

            db.run(
                `INSERT INTO teacher_subjects
                (teacher_id, subject_id, class_id, school_id)
                VALUES (?,?,?,?)`,
                [teacher_id, subject_id, class_id, schoolId],
                function(err) {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.redirect("/assignments");

                });

        });

});


/* ===========================================
   DELETE ASSIGNMENT
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM teacher_subjects WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/assignments");

        });

});

module.exports = router;
