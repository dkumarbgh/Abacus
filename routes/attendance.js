const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getFaceEncoding, findBestMatch } = require("../services/faceRecognition");
const { getDefaultHoursAttended } = require("../services/schoolSettings");
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

    const schoolId = req.schoolId;

    Promise.all([
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        getDefaultHoursAttended(schoolId)
    ]).then(([levels, batches, defaultHours]) => {
        res.render("attendance", {
            levels, batches, defaultHours,
            roster: [],
            crossBatchEntries: [],
            selectedLevel: "",
            selectedBatch: "",
            selectedDate: "",
            highlightStudentId: ""
        });
    }).catch(err => res.send(err.message));

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

    const batch_id = req.query.batch_id;
    const attendance_date = req.query.attendance_date;
    const schoolId = req.schoolId;

    Promise.all([
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        // Home roster: everyone actually assigned to this batch.
        dbAll("SELECT * FROM students WHERE batch_id=? AND school_id=? ORDER BY name", [batch_id, schoolId]),
        // Every attendance row already saved for THIS batch+date, if any
        // (re-visiting an already-marked session) - covers both home-roster
        // members and any previously-added cross-batch visitors.
        dbAll(
            `SELECT attendance.*, students.name AS student_name, students.admission_no, students.photo_path
             FROM attendance JOIN students ON attendance.student_id = students.id
             WHERE attendance.batch_id=? AND attendance.attendance_date=? AND attendance.school_id=?`,
            [batch_id, attendance_date, schoolId]
        ),
        getDefaultHoursAttended(schoolId)
    ]).then(([levels, batches, homeRoster, existingRecords, defaultHours]) => {

        const presentIds = new Set(
            existingRecords.filter(r => r.status === "Present" && !r.is_different_batch).map(r => r.student_id)
        );
        const hoursById = {};
        existingRecords.forEach(r => { hoursById[r.student_id] = r.hours_attended; });

        const roster = homeRoster.map(s => ({ ...s, checked: presentIds.has(s.id), hours: hoursById[s.id] != null ? hoursById[s.id] : defaultHours }));

        const crossBatchEntries = existingRecords
            .filter(r => r.is_different_batch)
            .map(r => ({ id: r.student_id, name: r.student_name, admission_no: r.admission_no, photo_path: r.photo_path, hours: r.hours_attended != null ? r.hours_attended : defaultHours }));

        res.render("attendance", {
            levels, batches, roster, crossBatchEntries, defaultHours,
            selectedLevel: req.query.level_id || "",
            selectedBatch: batch_id || "",
            selectedDate: attendance_date || "",
            highlightStudentId: req.query.highlight_student_id || ""
        });

    }).catch(err => res.send(err.message));

});


/* ===========================================
   Search students by Roll Number or Name - used by the "add a student
   from a different batch" search box when marking attendance.
=========================================== */
router.get("/search-students", (req, res) => {

    const q = (req.query.q || "").trim();
    if (!q) return res.json({ ok: true, students: [] });

    db.all(
        `SELECT students.id, students.name, students.admission_no, students.batch_id, students.level_id, students.photo_path,
                batch.name AS batch_name, level.name AS level_name
         FROM students
         LEFT JOIN lookup_items batch ON students.batch_id = batch.id
         LEFT JOIN lookup_items level ON students.level_id = level.id
         WHERE students.school_id=? AND (students.name LIKE ? OR students.admission_no LIKE ?)
         ORDER BY students.name LIMIT 20`,
        [req.schoolId, `%${q}%`, `%${q}%`],
        (err, students) => {
            if (err) return res.status(500).json({ ok: false, error: err.message });
            res.json({ ok: true, students });
        }
    );

});

function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

/**
 * Parses an hours-attended value from the form, falling back to
 * fallbackHours (a full standard session, per the school's configured
 * default - see Settings) if left blank, and clamping to a sane 0-12
 * range so a typo can't silently produce something like -5 or 500 hours.
 */
function parseHours(raw, fallbackHours) {
    const n = parseFloat(raw);
    if (isNaN(n)) return fallbackHours;
    return Math.max(0, Math.min(12, n));
}


/* ===========================================
   Save Attendance
=========================================== */
router.post("/save", async (req, res) => {

    const attendance_date = req.body.attendance_date;
    const batch_id = req.body.batch_id;
    const schoolId = req.schoolId;

    // req.body.student / req.body.cross_batch_student is an array when 2+
    // checkboxes/entries exist, but becomes a plain string when exactly
    // ONE exists (how urlencoded form bodies work) - normalize both.
    const presentIds = [].concat(req.body.student || []).map(String);
    const crossBatchIds = [].concat(req.body.cross_batch_student || []).map(String);

    let defaultHours;
    try {
        defaultHours = await getDefaultHoursAttended(schoolId);
    } catch (err) {
        return res.send(err.message);
    }

    // Wipe out whatever was previously saved for THIS batch+date (scoped
    // by batch_id, not student - a student's OWN attendance record for a
    // DIFFERENT batch on the same day, if any, is untouched, since a
    // makeup session and a home session are two separate real sessions).
    db.run(
        `DELETE FROM attendance WHERE attendance_date=? AND school_id=? AND batch_id=?`,
        [attendance_date, schoolId, batch_id],
        (err) => {

            if (err) return res.send(err.message);

            db.all(
                "SELECT id FROM students WHERE batch_id=? AND school_id=?",
                [batch_id, schoolId],
                (rosterErr, homeRoster) => {

                    if (rosterErr) return res.send(rosterErr.message);

                    // Home roster - Present for checked students, Absent for
                    // everyone else (recording the whole roster, not just
                    // who's Present, is what makes attendance % accurate -
                    // see the historical note this replaced).
                    homeRoster.forEach(student => {
                        const isPresent = presentIds.includes(String(student.id));
                        const status = isPresent ? "Present" : "Absent";
                        const hours = isPresent ? parseHours(req.body[`hours_${student.id}`], defaultHours) : null;
                        db.run(
                            `INSERT INTO attendance (student_id, attendance_date, status, batch_id, is_different_batch, hours_attended, school_id)
                             VALUES (?,?,?,?,0,?,?)`,
                            [student.id, attendance_date, status, batch_id, hours, schoolId]
                        );
                    });

                    // Cross-batch visitors - always Present (there's no
                    // "absent from a batch you don't belong to"), flagged
                    // distinctly so reports can tell home vs. makeup apart.
                    crossBatchIds.forEach(studentId => {
                        const hours = parseHours(req.body[`hours_${studentId}`], defaultHours);
                        db.run(
                            `INSERT INTO attendance (student_id, attendance_date, status, batch_id, is_different_batch, hours_attended, school_id)
                             VALUES (?,?,'Present',?,1,?,?)`,
                            [studentId, attendance_date, batch_id, hours, schoolId]
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

    const schoolId = req.schoolId;
    const studentName = (req.query.student_name || "").trim();
    const rollNumber = (req.query.roll_number || "").trim();
    const date = req.query.date || "";
    const month = req.query.month || ""; // "YYYY-MM"
    const levelId = req.query.level_id || "";

    let sql = `
        SELECT
            attendance.attendance_date,
            students.name,
            students.admission_no,
            level.name AS level_name,
            attendance.status
        FROM attendance
        INNER JOIN students
            ON attendance.student_id = students.id
        LEFT JOIN lookup_items level
            ON students.level_id = level.id
        WHERE attendance.school_id = ?
    `;
    const params = [schoolId];
    if (studentName) { sql += " AND students.name LIKE ?"; params.push(`%${studentName}%`); }
    if (rollNumber) { sql += " AND students.admission_no LIKE ?"; params.push(`%${rollNumber}%`); }
    if (levelId) { sql += " AND students.level_id = ?"; params.push(levelId); }
    // A specific date takes precedence over a month range if both were
    // somehow submitted together.
    if (date) {
        sql += " AND attendance.attendance_date = ?"; params.push(date);
    } else if (month) {
        sql += " AND attendance.attendance_date LIKE ?"; params.push(`${month}%`);
    }
    sql += " ORDER BY attendance.attendance_date DESC, students.name";

    Promise.all([
        dbAll(sql, params),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId])
    ]).then(([rows, levels]) => {

        res.render("attendanceHistory", {
            attendance: rows, levels,
            studentName, rollNumber, date, month, levelId
        });

    }).catch(err => res.send(err.message));

});

module.exports = router;
