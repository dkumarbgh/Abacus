const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   TIMETABLE HOME
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM teachers WHERE school_id=? ORDER BY name", [schoolId], (err, teachers) => {

            if (err) return res.send(err.message);

            db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

                if (err) return res.send(err.message);

                const sql = `
                    SELECT
                        timetable.id,
                        classes.class_name,
                        teachers.name AS teacher_name,
                        subjects.subject_name,
                        timetable.day,
                        timetable.period,
                        timetable.start_time,
                        timetable.end_time
                    FROM timetable
                    INNER JOIN classes
                        ON timetable.class_id = classes.id
                    INNER JOIN teachers
                        ON timetable.teacher_id = teachers.id
                    INNER JOIN subjects
                        ON timetable.subject_id = subjects.id
                    WHERE timetable.school_id = ?
                    ORDER BY
                        classes.class_name,
                        timetable.day,
                        timetable.period
                `;

                db.all(sql, [schoolId], (err, timetable) => {

                    if (err) return res.send(err.message);

                    res.render("timetable", {
                        classes,
                        teachers,
                        subjects,
                        timetable
                    });

                });

            });

        });

    });

});


/* ===========================================
   SAVE TIMETABLE
=========================================== */
router.post("/add", (req, res) => {

    const {
        class_id,
        teacher_id,
        subject_id,
        day,
        period,
        start_time,
        end_time
    } = req.body;
    const schoolId = req.schoolId;

    // Prevent duplicate period for the same class
    db.get(
        `SELECT id
         FROM timetable
         WHERE class_id=?
           AND day=?
           AND period=?
           AND school_id=?`,
        [class_id, day, period, schoolId],
        (err, row) => {

            if (err) return res.send(err.message);

            if (row) {
                return res.send(
                    "<h3>This class already has a timetable for the selected day and period.</h3><a href='/timetable'>Back</a>"
                );
            }

            // Prevent teacher conflict
            db.get(
                `SELECT id
                 FROM timetable
                 WHERE teacher_id=?
                   AND day=?
                   AND period=?
                   AND school_id=?`,
                [teacher_id, day, period, schoolId],
                (err, teacherConflict) => {

                    if (err) return res.send(err.message);

                    if (teacherConflict) {
                        return res.send(
                            "<h3>This teacher is already assigned during this period.</h3><a href='/timetable'>Back</a>"
                        );
                    }

                    db.run(
                        `INSERT INTO timetable
                        (class_id, teacher_id, subject_id, day, period, start_time, end_time, school_id)
                        VALUES (?,?,?,?,?,?,?,?)`,
                        [
                            class_id,
                            teacher_id,
                            subject_id,
                            day,
                            period,
                            start_time,
                            end_time,
                            schoolId
                        ],
                        function(err) {

                            if (err) return res.send(err.message);

                            res.redirect("/timetable");

                        }
                    );

                }
            );

        }
    );

});


/* ===========================================
   DELETE TIMETABLE
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM timetable WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) return res.send(err.message);

            res.redirect("/timetable");

        });

});

module.exports = router;
