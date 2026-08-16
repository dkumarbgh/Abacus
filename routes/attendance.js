const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getFaceEncoding, findBestMatch } = require("../services/faceRecognition");
const { requireLogin, requireApiAuth, requireFeature } = require("../middleware/auth");

const upload = multer({
    dest: path.join(__dirname, "../public/uploads/tmp")
});

/**
 * Core face-match-and-mark-attendance logic, shared by the mobile app's
 * JWT endpoint (/face-mark) and the browser-webcam endpoint
 * (/face-mark-web) - same matching pipeline either way, just a different
 * way of capturing the photo (phone camera vs laptop webcam).
 *
 * @returns {Promise<object>} always resolves (never rejects) with a plain
 *   { ok, ...} object ready to send back as JSON - errors come back as
 *   { ok: false, error: "..." } rather than throwing, so callers don't
 *   need a try/catch around this.
 */
async function markAttendanceByFace({ imagePath, classId, schoolId, attendanceDate }) {

    const date = attendanceDate || new Date().toISOString().slice(0, 10);

    if (!classId) {
        return { ok: false, error: "class_id_required" };
    }

    const result = await getFaceEncoding(imagePath);

    if (result.error) {
        return { ok: false, error: result.error };
    }

    // Only match against students enrolled in the selected class AND this
    // school (keeps matching fast, more accurate, and tenant-isolated)
    const candidates = await new Promise((resolve, reject) => {
        db.all(
            `SELECT face_encodings.student_id, face_encodings.encoding
             FROM face_encodings
             JOIN students ON students.id = face_encodings.student_id
             WHERE students.class_id = ? AND students.school_id = ?`,
            [classId, schoolId],
            (err, rows) => err ? reject(err) : resolve(rows)
        );
    });

    if (candidates.length === 0) {
        return { ok: false, error: "no_enrolled_faces_in_class" };
    }

    const match = findBestMatch(result.encoding, candidates);

    if (!match) {
        return { ok: false, error: "no_match" };
    }

    const student = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM students WHERE id=? AND school_id=?", [match.studentId, schoolId], (err, row) => err ? reject(err) : resolve(row));
    });

    if (!student) {
        return { ok: false, error: "student_lookup_failed" };
    }

    // Upsert attendance for this student+date (avoid duplicate rows if scanned twice)
    const existing = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM attendance WHERE student_id=? AND attendance_date=?", [student.id, date], (err, row) => err ? reject(err) : resolve(row));
    });

    await new Promise((resolve, reject) => {
        if (existing) {
            db.run("UPDATE attendance SET status=? WHERE id=?", ["Present", existing.id], (err) => err ? reject(err) : resolve());
        } else {
            db.run(
                `INSERT INTO attendance (student_id, attendance_date, status, school_id) VALUES (?,?,?,?)`,
                [student.id, date, "Present", schoolId],
                (err) => err ? reject(err) : resolve()
            );
        }
    });

    return {
        ok: true,
        student: { id: student.id, name: student.name, admission_no: student.admission_no },
        confidence: Number(match.confidence.toFixed(2)),
        date
    };

}

/* ===========================================
   FACE-RECOGNITION ATTENDANCE (used by the mobile app)
   Auth: JWT bearer token (see /api/login), NOT the web session -
   this route must be defined BEFORE router.use(requireLogin) below.
   POST multipart: image, class_id, attendance_date (optional, default today)
   Returns JSON so the Flutter app can show a result.
=========================================== */
router.post("/face-mark", requireApiAuth, requireFeature("faceRecognition", { asJson: true }), upload.single("image"), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ ok: false, error: "no_image_uploaded" });
    }

    const result = await markAttendanceByFace({
        imagePath: req.file.path,
        classId: req.body.class_id,
        schoolId: req.schoolId,
        attendanceDate: req.body.attendance_date
    });

    fs.unlink(req.file.path, () => {});

    res.status(result.ok ? 200 : (result.error === "class_id_required" ? 400 : 200)).json(result);

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
   FACE-RECOGNITION ATTENDANCE VIA LAPTOP WEBCAM
   Same matching pipeline as the mobile app's /face-mark above, just
   session-authenticated instead of JWT, and the photo comes from the
   browser's webcam (getUserMedia) instead of a phone camera - handy for a
   reception-desk laptop instead of needing the Flutter app set up.
=========================================== */
router.get("/face-capture", requireFeature("faceRecognition"), (req, res) => {

    db.all(
        "SELECT * FROM classes WHERE school_id=? AND is_active=1 ORDER BY class_name",
        [req.schoolId],
        (err, classes) => {

            if (err) return res.send(err.message);

            res.render("faceCapture", { classes });

        });

});

router.post("/face-mark-web", requireFeature("faceRecognition", { asJson: true }), upload.single("image"), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ ok: false, error: "no_image_uploaded" });
    }

    const result = await markAttendanceByFace({
        imagePath: req.file.path,
        classId: req.body.class_id,
        schoolId: req.schoolId
    });

    fs.unlink(req.file.path, () => {});

    res.json(result);

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
