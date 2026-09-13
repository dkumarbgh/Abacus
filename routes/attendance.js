const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { getFaceEncoding, findBestMatch } = require("../services/faceRecognition");
const { getDefaultHoursAttended } = require("../services/schoolSettings");
const { requireLogin, requireApiAuth, requireFeature, requireSchoolFeature, requireRole } = require("../middleware/auth");
const { logChange } = require("../services/auditLog");

const upload = multer({
    dest: path.join(__dirname, "../public/uploads/tmp")
});

// Attendance import spreadsheets are small (a school's whole roster for a
// date range at most) - memory storage, same pattern as the Students
// import in routes/students.js.
const uploadSpreadsheet = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
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
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        getDefaultHoursAttended(schoolId),
        dbGetOne("SELECT attendance_import_export_enabled FROM schools WHERE id=?", [schoolId])
    ]).then(([batches, defaultHours, schoolRow]) => {
        res.render("attendance", {
            batches, defaultHours,
            roster: [],
            crossBatchEntries: [],
            selectedBatch: "",
            selectedDate: "",
            highlightStudentId: "",
            importExportEnabled: !!(schoolRow && schoolRow.attendance_import_export_enabled)
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
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        // Home roster: everyone actually assigned to this batch - a batch
        // can include students from different Levels, so each student's
        // own Level is looked up here (rather than assumed from the
        // batch) and shown in the roster.
        dbAll(
            `SELECT students.*, level.name AS level_name
             FROM students
             LEFT JOIN lookup_items level ON students.level_id = level.id
             WHERE students.batch_id=? AND students.school_id=?
             ORDER BY students.name`,
            [batch_id, schoolId]
        ),
        // Every attendance row already saved for THIS batch+date, if any
        // (re-visiting an already-marked session) - covers both home-roster
        // members and any previously-added cross-batch visitors.
        dbAll(
            `SELECT attendance.*, students.name AS student_name, students.admission_no, students.photo_path,
                    level.name AS level_name
             FROM attendance
             JOIN students ON attendance.student_id = students.id
             LEFT JOIN lookup_items level ON students.level_id = level.id
             WHERE attendance.batch_id=? AND attendance.attendance_date=? AND attendance.school_id=?`,
            [batch_id, attendance_date, schoolId]
        ),
        getDefaultHoursAttended(schoolId),
        dbGetOne("SELECT attendance_import_export_enabled FROM schools WHERE id=?", [schoolId])
    ]).then(([batches, homeRoster, existingRecords, defaultHours, schoolRow]) => {

        const presentIds = new Set(
            existingRecords.filter(r => r.status === "Present" && !r.is_different_batch).map(r => r.student_id)
        );
        const hoursById = {};
        existingRecords.forEach(r => { hoursById[r.student_id] = r.hours_attended; });

        const roster = homeRoster.map(s => ({ ...s, checked: presentIds.has(s.id), hours: hoursById[s.id] != null ? hoursById[s.id] : defaultHours }));

        const crossBatchEntries = existingRecords
            .filter(r => r.is_different_batch)
            .map(r => ({ id: r.student_id, name: r.student_name, admission_no: r.admission_no, photo_path: r.photo_path, level_name: r.level_name, hours: r.hours_attended != null ? r.hours_attended : defaultHours }));

        res.render("attendance", {
            batches, roster, crossBatchEntries, defaultHours,
            importExportEnabled: !!(schoolRow && schoolRow.attendance_import_export_enabled),
            selectedBatch: batch_id || "",
            selectedDate: attendance_date || "",
            highlightStudentId: req.query.highlight_student_id || ""
        });

    }).catch(err => res.send(err.message));

});


/* ===========================================
   List every student in a given batch - used by the "add several students
   from another batch at once" checklist when marking attendance, so
   someone doesn't have to search-and-click one name at a time for a
   whole group of makeup-class visitors.
=========================================== */
router.get("/batch-students", (req, res) => {

    const batchId = req.query.batch_id;
    if (!batchId) return res.json({ ok: true, students: [] });

    db.all(
        `SELECT students.id, students.name, students.admission_no, students.photo_path,
                level.name AS level_name
         FROM students
         LEFT JOIN lookup_items level ON students.level_id = level.id
         WHERE students.batch_id=? AND students.school_id=?
         ORDER BY students.name`,
        [batchId, req.schoolId],
        (err, students) => {
            if (err) return res.status(500).json({ ok: false, error: err.message });
            res.json({ ok: true, students });
        }
    );

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

                    // One summary entry per save action (not per student)
                    // to avoid flooding the log - branch_id is left NULL
                    // here since a batch can mix students from different
                    // branches; the per-student detail is still in the
                    // attendance records themselves for whoever needs it.
                    db.get("SELECT name FROM lookup_items WHERE id=?", [batch_id], (errB, batch) => {
                        logChange({
                            schoolId, branchId: null, req,
                            entityType: "Attendance", entityName: batch ? batch.name : `Batch #${batch_id}`,
                            action: "Saved",
                            details: `${attendance_date}: ${presentIds.length} present (home), ${homeRoster.length - presentIds.length} absent, ${crossBatchIds.length} cross-batch`
                        });
                    });

                }
            );

        });

});


/* ===========================================
   EXPORT ATTENDANCE (Excel) - behind the per-school toggle in Settings
=========================================== */
router.get("/export", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("attendance_import_export_enabled", "Attendance"), (req, res) => {

    const schoolId = req.schoolId;
    const { from_date, to_date } = req.query;

    let sql = `
        SELECT attendance.attendance_date, attendance.status, attendance.hours_attended, attendance.is_different_batch,
               students.name AS student_name, students.admission_no,
               batch.name AS batch_name
        FROM attendance
        JOIN students ON attendance.student_id = students.id
        LEFT JOIN lookup_items batch ON attendance.batch_id = batch.id
        WHERE attendance.school_id = ?
    `;
    const params = [schoolId];
    if (from_date) { sql += " AND attendance.attendance_date >= ?"; params.push(from_date); }
    if (to_date) { sql += " AND attendance.attendance_date <= ?"; params.push(to_date); }
    sql += " ORDER BY attendance.attendance_date DESC, students.name";

    db.all(sql, params, async (err, rows) => {

        if (err) return res.send(err.message);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Attendance");
        sheet.columns = [
            { header: "Roll Number", key: "admission_no", width: 15 },
            { header: "Student Name", key: "student_name", width: 25 },
            { header: "Batch", key: "batch_name", width: 18 },
            { header: "Date", key: "attendance_date", width: 14 },
            { header: "Status", key: "status", width: 12 },
            { header: "Hours Attended", key: "hours_attended", width: 15 },
            { header: "Different Batch", key: "different_batch", width: 15 }
        ];
        sheet.getRow(1).font = { bold: true };
        rows.forEach(r => sheet.addRow({
            admission_no: r.admission_no || "",
            student_name: r.student_name,
            batch_name: r.batch_name || "",
            attendance_date: r.attendance_date,
            status: r.status,
            hours_attended: r.hours_attended != null ? r.hours_attended : "",
            different_batch: r.is_different_batch ? "Yes" : "No"
        }));

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="attendance-export-${new Date().toISOString().slice(0,10)}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    });

});

/* ===========================================
   IMPORT TEMPLATE (blank, headers only)
=========================================== */
router.get("/import/template", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("attendance_import_export_enabled", "Attendance"), async (req, res) => {

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Attendance");
    sheet.columns = [
        { header: "Roll Number", key: "admission_no", width: 15 },
        { header: "Student Name", key: "student_name", width: 25 },
        { header: "Batch", key: "batch_name", width: 18 },
        { header: "Date", key: "attendance_date", width: 14 },
        { header: "Status", key: "status", width: 12 },
        { header: "Hours Attended", key: "hours_attended", width: 15 }
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.addRow({ admission_no: "2024-001", student_name: "Jane Doe", batch_name: "Monday-Saturday", attendance_date: "2026-01-15", status: "Present", hours_attended: 2 });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-import-template.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();

});

/* ===========================================
   IMPORT ATTENDANCE (Excel)
   Rows are grouped by (Batch, Date) and applied with the SAME
   delete-then-reinsert semantics as the normal Save Attendance flow
   (see /save above) - one full re-import of a (Batch, Date) group
   replaces whatever was there before for that batch+date, rather than
   piling up duplicate rows on a re-import of the same file.
   "Status" of Absent is honored for the home batch; any row whose Batch
   doesn't match a student's own batch_id is treated as a cross-batch
   (makeup-class) entry, same as the manual "add from a different batch" flow.
=========================================== */
router.post("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("attendance_import_export_enabled", "Attendance"), uploadSpreadsheet.single("file"), async (req, res) => {

    if (!req.file) return res.render("importAttendance", { result: { error: "Please choose a file to upload." } });

    const schoolId = req.schoolId;

    try {

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.worksheets[0];

        const headerRow = sheet.getRow(1);
        const colIndexByHeader = {};
        headerRow.eachCell((cell, colNumber) => {
            const norm = String(cell.value || "").trim().toLowerCase();
            const map = {
                "roll number": "admission_no", "student name": "student_name", "batch": "batch_name",
                "date": "attendance_date", "status": "status", "hours attended": "hours_attended"
            };
            if (map[norm]) colIndexByHeader[map[norm]] = colNumber;
        });

        if (!colIndexByHeader.student_name || !colIndexByHeader.attendance_date || !colIndexByHeader.batch_name) {
            return res.render("importAttendance", { result: { error: "The sheet is missing one or more required columns: Student Name, Batch, Date. Download the template to check the expected format." } });
        }

        const cell = (row, key) => {
            const idx = colIndexByHeader[key];
            if (!idx) return "";
            const v = row.getCell(idx).value;
            if (v == null) return "";
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            if (typeof v === "object" && v.text) return String(v.text).trim();
            return String(v).trim();
        };

        const defaultHours = await getDefaultHoursAttended(schoolId);
        const rowErrors = [];
        const parsedRows = [];

        for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
            const row = sheet.getRow(rowNum);
            const studentName = cell(row, "student_name");
            const admissionNo = cell(row, "admission_no");
            const batchName = cell(row, "batch_name");
            const attendanceDate = cell(row, "attendance_date");
            const status = cell(row, "status") || "Present";
            const hoursRaw = cell(row, "hours_attended");

            if (!studentName && !admissionNo) continue; // skip fully blank rows

            if (!batchName || !attendanceDate) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): missing Batch or Date.`);
                continue;
            }

            // Match by Roll Number first, falling back to an exact Name
            // match - same precedence rule as the Student import, for
            // the same reason (Roll Number is the more reliable key when
            // present).
            let student;
            if (admissionNo) {
                student = await dbGetOne("SELECT id, batch_id FROM students WHERE school_id=? AND LOWER(TRIM(admission_no))=LOWER(TRIM(?))", [schoolId, admissionNo]);
            }
            if (!student && studentName) {
                const matches = await dbAll("SELECT id, batch_id FROM students WHERE school_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))", [schoolId, studentName]);
                if (matches.length === 1) student = matches[0];
                else if (matches.length > 1) {
                    rowErrors.push(`Row ${rowNum} (${studentName}): more than one student has this name - add a Roll Number to this row to say which one.`);
                    continue;
                }
            }
            if (!student) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): no matching student found.`);
                continue;
            }

            const batch = await dbGetOne("SELECT id FROM lookup_items WHERE school_id=? AND list_type='batch' AND LOWER(TRIM(name))=LOWER(TRIM(?))", [schoolId, batchName]);
            if (!batch) {
                rowErrors.push(`Row ${rowNum} (${studentName || admissionNo}): batch "${batchName}" doesn't exist.`);
                continue;
            }

            const isDifferentBatch = String(student.batch_id) !== String(batch.id);
            const isPresent = status.toLowerCase().startsWith("p") || isDifferentBatch; // cross-batch visits are always "Present"
            const hours = isPresent ? (parseFloat(hoursRaw) || defaultHours) : null;

            parsedRows.push({
                studentId: student.id, batchId: batch.id, attendanceDate,
                status: isPresent ? "Present" : "Absent", hours, isDifferentBatch
            });
        }

        // Group by (batch, date) so each group can be applied with the
        // same delete-then-reinsert semantics as a normal manual Save.
        const groups = {};
        parsedRows.forEach(r => {
            const key = `${r.batchId}|${r.attendanceDate}`;
            (groups[key] = groups[key] || []).push(r);
        });

        let imported = 0;
        for (const key of Object.keys(groups)) {
            const [batchId, attendanceDate] = key.split("|");
            await dbRun("DELETE FROM attendance WHERE school_id=? AND batch_id=? AND attendance_date=?", [schoolId, batchId, attendanceDate]);
            for (const r of groups[key]) {
                await dbRun(
                    `INSERT INTO attendance (student_id, attendance_date, status, batch_id, is_different_batch, hours_attended, school_id)
                     VALUES (?,?,?,?,?,?,?)`,
                    [r.studentId, r.attendanceDate, r.status, batchId, r.isDifferentBatch ? 1 : 0, r.hours, schoolId]
                );
                imported++;
            }
        }

        res.render("importAttendance", { result: { imported, rowErrors, total: sheet.rowCount - 1 } });

    } catch (e) {
        res.render("importAttendance", { result: { error: "Could not read that file: " + e.message } });
    }

});

function dbGetOne(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

router.get("/import", requireRole("Admin", "SuperAdmin"), requireSchoolFeature("attendance_import_export_enabled", "Attendance"), (req, res) => {
    res.render("importAttendance", { result: null });
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
