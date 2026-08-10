const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getFaceEncoding, findBestMatch } = require("../services/faceRecognition");
const { requireLogin, requireApiAuth } = require("../middleware/auth");

const upload = multer({
    dest: path.join(__dirname, "../public/uploads/tmp")
});

/* ===========================================
   FACE-RECOGNITION ATTENDANCE (used by the mobile app)
   Auth: JWT bearer token (see /api/login), NOT the web session -
   this route must be defined BEFORE router.use(requireLogin) below.
   POST multipart: image, class_id, attendance_date (optional, default today)
   Returns JSON so the Flutter app can show a result.
=========================================== */
router.post("/face-mark", requireApiAuth, upload.single("image"), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ ok: false, error: "no_image_uploaded" });
    }

    const class_id = req.body.class_id;
    const attendance_date = req.body.attendance_date || new Date().toISOString().slice(0, 10);
    const schoolId = req.schoolId;

    const cleanup = () => fs.unlink(req.file.path, () => {});

    if (!class_id) {
        cleanup();
        return res.status(400).json({ ok: false, error: "class_id_required" });
    }

    const result = await getFaceEncoding(req.file.path);

    if (result.error) {
        cleanup();
        return res.json({ ok: false, error: result.error });
    }

    // Only match against students enrolled in the selected class AND this
    // school (keeps matching fast, more accurate, and tenant-isolated)
    db.all(
        `SELECT face_encodings.student_id, face_encodings.encoding
         FROM face_encodings
         JOIN students ON students.id = face_encodings.student_id
         WHERE students.class_id = ? AND students.school_id = ?`,
        [class_id, schoolId],
        (err, candidates) => {

            cleanup();

            if (err) return res.status(500).json({ ok: false, error: err.message });

            if (candidates.length === 0) {
                return res.json({ ok: false, error: "no_enrolled_faces_in_class" });
            }

            const match = findBestMatch(result.encoding, candidates);

            if (!match) {
                return res.json({ ok: false, error: "no_match" });
            }

            db.get("SELECT * FROM students WHERE id=? AND school_id=?", [match.studentId, schoolId], (err2, student) => {

                if (err2 || !student) {
                    return res.status(500).json({ ok: false, error: "student_lookup_failed" });
                }

                // Upsert attendance for this student+date (avoid duplicate rows if scanned twice)
                db.get(
                    "SELECT id FROM attendance WHERE student_id=? AND attendance_date=?",
                    [student.id, attendance_date],
                    (err3, existing) => {

                        const respond = () => res.json({
                            ok: true,
                            student: { id: student.id, name: student.name, admission_no: student.admission_no },
                            confidence: Number(match.confidence.toFixed(2)),
                            date: attendance_date
                        });

                        if (existing) {
                            db.run(
                                "UPDATE attendance SET status=? WHERE id=?",
                                ["Present", existing.id],
                                () => respond()
                            );
                        } else {
                            db.run(
                                `INSERT INTO attendance (student_id, attendance_date, status, school_id)
                                 VALUES (?,?,?,?)`,
                                [student.id, attendance_date, "Present", schoolId],
                                () => respond()
                            );
                        }

                    }
                );

            });

        }
    );

});


// Everything below this line is the web admin interface (session auth).
router.use(requireLogin);


/* ===========================================
   Attendance Home
=========================================== */
router.get("/", (req, res) => {

    db.all(
        "SELECT * FROM classes WHERE school_id=? ORDER BY class_name",
        [req.schoolId],
        (err, classes) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("attendance", {
                classes,
                students: [],
                selectedClass: "",
                selectedDate: ""
            });

        });

});


/* ===========================================
   Load Students
=========================================== */
router.get("/load", (req, res) => {

    const class_id = req.query.class_id;
    const attendance_date = req.query.attendance_date;
    const schoolId = req.schoolId;

    db.all(
        "SELECT * FROM classes WHERE school_id=? ORDER BY class_name",
        [schoolId],
        (err, classes) => {

            if (err) {
                return res.send(err.message);
            }

            db.all(
                `
                SELECT *
                FROM students
                WHERE class_id=? AND school_id=?
                ORDER BY name
                `,
                [class_id, schoolId],
                (err, students) => {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.render("attendance", {
                        classes,
                        students,
                        selectedClass: class_id,
                        selectedDate: attendance_date
                    });

                });

        });

});


/* ===========================================
   Save Attendance
=========================================== */
router.post("/save", (req, res) => {

    const attendance_date = req.body.attendance_date;
    const class_id = req.body.class_id;
    const schoolId = req.schoolId;

    // req.body.student is an array when 2+ checkboxes are checked, but
    // becomes a plain string when exactly ONE is checked (how urlencoded
    // form bodies work) - normalize it so .includes/.forEach always work.
    const presentIds = [].concat(req.body.student || []).map(String);

    // Remove existing attendance for the selected date, scoped to THIS class
    // and school only (previously this cleared every class's attendance for
    // the date, which was a bug).
    db.run(
        `DELETE FROM attendance
         WHERE attendance_date=? AND school_id=?
           AND student_id IN (SELECT id FROM students WHERE class_id=? AND school_id=?)`,
        [attendance_date, schoolId, class_id, schoolId],
        (err) => {

            if (err) {
                return res.send(err.message);
            }

            // Previously, unchecked (absent) students got NO row written at
            // all - which silently broke every attendance % calculation,
            // since "present days / total marked" only ever counted days a
            // student was marked Present (absences were invisible, so
            // attendance always looked like 100%). Now we record the WHOLE
            // class roster for the day - Present for checked students,
            // Absent for everyone else - so reports are accurate.
            db.all(
                "SELECT id FROM students WHERE class_id=? AND school_id=?",
                [class_id, schoolId],
                (rosterErr, roster) => {

                    if (rosterErr) {
                        return res.send(rosterErr.message);
                    }

                    if (roster.length === 0) {
                        return res.redirect("/attendance");
                    }

                    roster.forEach(student => {

                        const status = presentIds.includes(String(student.id)) ? "Present" : "Absent";

                        db.run(
                            `INSERT INTO attendance
                            (student_id, attendance_date, status, school_id)
                            VALUES (?,?,?,?)`,
                            [student.id, attendance_date, status, schoolId]
                        );

                    });

                    res.redirect("/attendance");

                }
            );

        });

});

/* ===========================================
   Attendance History
=========================================== */

router.get("/history", (req, res) => {

    const sql = `
        SELECT
            attendance.attendance_date,
            students.name,
            classes.class_name,
            attendance.status
        FROM attendance
        INNER JOIN students
            ON attendance.student_id = students.id
        LEFT JOIN classes
            ON students.class_id = classes.id
        WHERE attendance.school_id = ?
        ORDER BY attendance.attendance_date DESC,
                 students.name
    `;

    db.all(sql, [req.schoolId], (err, rows) => {

        if (err) {
            return res.send(err.message);
        }

        res.render("attendanceHistory", {
            attendance: rows
        });

    });

});

module.exports = router;
