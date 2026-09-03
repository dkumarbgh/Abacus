const express = require("express");
const router = express.Router();
const db = require("../config/database");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { sendBulk } = require("../services/whatsappClient");
const { requireLogin } = require("../middleware/auth");
const { computeDiscountAmount, computeNetAmount } = require("../services/feeCalc");
const { getSimpleFeeMode } = require("../services/schoolSettings");
const { getElapsedInfo, computeExpected, classifyRegularity } = require("../services/attendanceCalc");

router.use(requireLogin);

/* ===========================================
   ATTENDANCE AFTER DUE DATE
   For students whose Fee Due Date has already passed, counts how many
   classes they've attended SINCE that date - a collections/compliance
   view: are students continuing to attend despite an overdue fee? Only
   students with a Fee Due Date set are included (same "due-date-driven"
   scoping as the Fees Due Report), and only ones whose due date is
   actually in the past (a future due date has nothing to report yet).
=========================================== */
router.get("/attendance-after-due-date", (req, res) => {

    const schoolId = req.schoolId;
    const levelId = req.query.level_id || "";
    const batchId = req.query.batch_id || "";
    const classId = req.query.class_id || "";
    const branchId = req.query.branch_id || "";
    const studentName = (req.query.student_name || "").trim();
    const today = new Date().toISOString().slice(0, 10);

    Promise.all([
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId]),
        getSimpleFeeMode(schoolId)
    ]).then(([levels, batches, classes, branches, simpleFeeMode]) => {

        let sql = `
            SELECT students.id, students.name, students.admission_no, students.fee_due_date,
                   level.name AS level_name, classes.class_name, branch.name AS branch_name,
                   COUNT(CASE WHEN attendance.status='Present' AND attendance.attendance_date > students.fee_due_date THEN 1 END) AS attended_after_due
            FROM students
            LEFT JOIN lookup_items level ON students.level_id = level.id
            LEFT JOIN classes ON students.class_id = classes.id
            LEFT JOIN lookup_items branch ON students.branch_id = branch.id
            LEFT JOIN attendance ON attendance.student_id = students.id
            WHERE students.school_id = ?
              AND students.fee_due_date IS NOT NULL
              AND students.fee_due_date != ''
              AND students.fee_due_date < ?
        `;
        const params = [schoolId, today];

        if (levelId) { sql += " AND students.level_id = ?"; params.push(levelId); }
        if (batchId) { sql += " AND students.batch_id = ?"; params.push(batchId); }
        if (classId) { sql += " AND students.class_id = ?"; params.push(classId); }
        if (branchId) { sql += " AND students.branch_id = ?"; params.push(branchId); }
        if (studentName) { sql += " AND students.name LIKE ?"; params.push(`%${studentName}%`); }

        sql += " GROUP BY students.id ORDER BY attended_after_due DESC, students.name";

        db.all(sql, params, (err, rows) => {

            if (err) return res.send(err.message);

            if (rows.length === 0) {
                return res.render("attendanceAfterDueDateReport", {
                    levels, batches, classes, branches, rows: [], levelId, batchId, classId, branchId, studentName, simpleFeeMode
                });
            }

            // Whole-school dues in one pass (classId omitted = every
            // student), then just match each row to its total due by id -
            // reuses the exact same fee logic as every other fee report,
            // so "Pending"/"Paid" here always agrees with Fees Due/Pending.
            computeDuesByClass(schoolId, null, (err2, duesResults) => {

                if (err2) return res.send(err2.message);

                const duesById = {};
                duesResults.forEach(r => { duesById[r.student.id] = r.totalDue; });

                const withFeeStatus = rows.map(r => ({
                    ...r,
                    totalDue: duesById[r.id] || 0
                }));

                res.render("attendanceAfterDueDateReport", {
                    levels, batches, classes, branches, rows: withFeeStatus, levelId, batchId, classId, branchId, studentName, simpleFeeMode
                });

            });

        });

    }).catch(err => res.send(err.message));

});

/* ===========================================
   ATTENDANCE REGULARITY REPORT
   Student-wise, month-wise: how many classes each student attended so far
   this month vs. how many were expected, based on THEIR OWN batch's
   sessions/week (not a single shared value - two students in the same
   class can be in different batches with different schedules). Populates
   automatically for the whole school by month; Class, Batch, and Student
   Name are optional narrowing filters, not requirements. Reuses the same
   `attendance` table every other attendance feature already writes to
   (manual, face-recognition, webcam) - no separate batch-attendance
   system needed, this is just a different lens on the same data.
=========================================== */
/* ===========================================
   INACTIVE STUDENTS REPORT
   Students who haven't attended ANY class (Present, any batch) in the
   last N days - a follow-up list to catch someone quietly drifting away
   before they formally drop out, not just students who are merely
   "below their expected %" (that's what Attendance Regularity is for).
   Includes students with NO attendance record at all ("Never attended"),
   since a new admission who's never shown up is arguably the most urgent
   case to follow up on.
=========================================== */
router.get("/inactive-students", (req, res) => {

    const schoolId = req.schoolId;
    const days = Math.max(1, parseInt(req.query.days) || 14);
    const classId = req.query.class_id || "";
    const batchId = req.query.batch_id || "";
    const levelId = req.query.level_id || "";
    const branchId = req.query.branch_id || "";
    const studentName = (req.query.student_name || "").trim();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId])
    ]).then(async ([classes, batches, levels, branches]) => {

        let sql = `
            SELECT students.id, students.name, students.admission_no, students.guardian_phone, students.guardian_email,
                   classes.class_name, batch.name AS batch_name, level.name AS level_name, branch.name AS branch_name,
                   MAX(CASE WHEN attendance.status='Present' THEN attendance.attendance_date END) AS last_attended
            FROM students
            LEFT JOIN classes ON students.class_id = classes.id
            LEFT JOIN lookup_items batch ON students.batch_id = batch.id
            LEFT JOIN lookup_items level ON students.level_id = level.id
            LEFT JOIN lookup_items branch ON students.branch_id = branch.id
            LEFT JOIN attendance ON attendance.student_id = students.id
            WHERE students.school_id = ?
        `;
        const params = [schoolId];
        if (classId) { sql += " AND students.class_id = ?"; params.push(classId); }
        if (batchId) { sql += " AND students.batch_id = ?"; params.push(batchId); }
        if (levelId) { sql += " AND students.level_id = ?"; params.push(levelId); }
        if (branchId) { sql += " AND students.branch_id = ?"; params.push(branchId); }
        if (studentName) { sql += " AND students.name LIKE ?"; params.push(`%${studentName}%`); }
        sql += " GROUP BY students.id HAVING last_attended IS NULL OR last_attended < ? ORDER BY (last_attended IS NULL) DESC, last_attended ASC";
        params.push(cutoffStr);

        const students = await dbAll(sql, params);

        const withDaysSince = students.map(s => {
            let daysSince = null;
            if (s.last_attended) {
                daysSince = Math.floor((new Date(today) - new Date(s.last_attended)) / (1000 * 60 * 60 * 24));
            }
            return { ...s, daysSince };
        });

        res.render("inactiveStudentsReport", {
            classes, batches, levels, branches, students: withDaysSince, days,
            classId, batchId, levelId, branchId, studentName
        });

    }).catch(err => res.send(err.message));

});

router.post("/inactive-students/follow-up", (req, res) => {

    const schoolId = req.schoolId;
    const { class_id, batch_id, level_id, branch_id, student_name, days } = req.body;
    const studentIds = [].concat(req.body.student_ids || []);

    if (studentIds.length === 0) {
        const qs = new URLSearchParams({ class_id, batch_id, level_id, branch_id, student_name, days }).toString();
        return res.redirect(`/reports/inactive-students?${qs}`);
    }

    db.all(
        `SELECT id, name, guardian_phone, guardian_phone_2 FROM students WHERE school_id=? AND id IN (${studentIds.map(() => "?").join(",")})`,
        [schoolId, ...studentIds],
        (err, students) => {

            const qs = new URLSearchParams({ class_id, batch_id, level_id, branch_id, student_name, days }).toString();
            res.redirect(`/reports/inactive-students?${qs}`);

            if (err) return console.error("Inactive-students follow-up lookup failed:", err.message);

            const recipients = students.filter(s => s.guardian_phone || s.guardian_phone_2).map(s => ({
                phones: [s.guardian_phone, s.guardian_phone_2],
                studentId: s.id,
                type: "ATTENDANCE_ALERT",
                schoolId,
                message: `Dear Parent, we've noticed ${s.name} hasn't attended class recently. We'd love to have them back - please reach out to the school office if there's anything we can help with. - School Office`
            }));

            sendBulk(recipients, 3000);

        }
    );

});


/* ===========================================
   ATTENDANCE DETAIL REPORT
   For each matching student, one row per month (last N months): expected
   classes, how many were attended in their OWN batch, how many were
   attended in a DIFFERENT batch (makeup/visiting sessions), and the
   combined total + regularity status. This is the month-by-month,
   batch-source-aware companion to the single-month Attendance Regularity
   Report above - built specifically to answer "what was expected each
   month, what actually happened, and was any of it a different batch."
=========================================== */

// Shared by the HTML view and the Excel export below, so both stay in
// sync on filtering/calculation logic.
async function buildAttendanceDetailRows(schoolId, { classId, batchId, levelId, branchId, studentName, numMonths }) {

    let sql = `
        SELECT students.id, students.name, students.admission_no,
               classes.class_name, batch.name AS batch_name, batch.sessions_per_week,
               branch.name AS branch_name
        FROM students
        LEFT JOIN classes ON students.class_id = classes.id
        LEFT JOIN lookup_items batch ON students.batch_id = batch.id
        LEFT JOIN lookup_items branch ON students.branch_id = branch.id
        WHERE students.school_id = ?
    `;
    const params = [schoolId];
    if (classId) { sql += " AND students.class_id = ?"; params.push(classId); }
    if (batchId) { sql += " AND students.batch_id = ?"; params.push(batchId); }
    if (levelId) { sql += " AND students.level_id = ?"; params.push(levelId); }
    if (branchId) { sql += " AND students.branch_id = ?"; params.push(branchId); }
    // Field is labelled "Student Name / Roll No." on the form - it must
    // search BOTH columns, or a roll-number search silently returns
    // nothing (the bug this fixes: it previously only checked name).
    if (studentName) { sql += " AND (students.name LIKE ? OR students.admission_no LIKE ?)"; params.push(`%${studentName}%`, `%${studentName}%`); }
    sql += " ORDER BY students.name";

    const students = await dbAll(sql, params);

    // Weekly Attendance Schedule per student, so "expected" matches the
    // exact days set on the Student Edit page (falls back to sessions/week
    // averaging for any student without specific days set).
    const scheduleRows = await dbAll(`SELECT student_id, day_of_week FROM student_schedule WHERE school_id=?`, [schoolId]);
    const scheduleByStudent = {};
    scheduleRows.forEach(sr => {
        (scheduleByStudent[sr.student_id] = scheduleByStudent[sr.student_id] || []).push(sr.day_of_week);
    });

    // Last N months, oldest first, as "YYYY-MM" strings.
    const now = new Date();
    const months = [];
    for (let i = numMonths - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    const rows = [];

    for (const student of students) {
        for (const month of months) {

            const [y, mo] = month.split("-");
            const from = `${y}-${mo}-01`;
            const to = `${y}-${mo}-31`;

            const counts = await dbGet(
                `SELECT
                    COUNT(CASE WHEN status='Present' AND is_different_batch=0 THEN 1 END) AS home_attended,
                    COUNT(CASE WHEN status='Present' AND is_different_batch=1 THEN 1 END) AS different_attended
                 FROM attendance
                 WHERE student_id=? AND school_id=? AND attendance_date BETWEEN ? AND ?`,
                [student.id, schoolId, from, to]
            );

            const { daysElapsed, isCurrentMonth } = getElapsedInfo(month);
            const expected = computeExpected({
                sessionsPerWeek: student.sessions_per_week,
                daysElapsed, monthStart: from,
                scheduleDays: scheduleByStudent[student.id]
            });
            const totalAttended = (counts.home_attended || 0) + (counts.different_attended || 0);
            const { pct, status } = classifyRegularity(totalAttended, expected);

            rows.push({
                studentId: student.id,
                studentName: student.name,
                admissionNo: student.admission_no,
                className: student.class_name,
                batchName: student.batch_name,
                branchName: student.branch_name,
                month, isCurrentMonth,
                expected,
                homeAttended: counts.home_attended || 0,
                differentAttended: counts.different_attended || 0,
                totalAttended,
                pct, status
            });

        }
    }

    return rows;
}

router.get("/attendance-detail", (req, res) => {

    const schoolId = req.schoolId;
    const classId = req.query.class_id || "";
    const batchId = req.query.batch_id || "";
    const levelId = req.query.level_id || "";
    const branchId = req.query.branch_id || "";
    const studentName = (req.query.student_name || "").trim();
    const numMonths = Math.max(1, Math.min(12, parseInt(req.query.months) || 3));

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId])
    ]).then(async ([classes, batches, levels, branches]) => {

        const rows = await buildAttendanceDetailRows(schoolId, { classId, batchId, levelId, branchId, studentName, numMonths });

        res.render("attendanceDetailReport", {
            classes, batches, levels, branches, rows, numMonths,
            classId, batchId, levelId, branchId, studentName
        });

    }).catch(err => res.send(err.message));

});

/* ===========================================
   ATTENDANCE DETAIL REPORT - Excel export
   Same filters, same rows as the HTML view above.
=========================================== */
router.get("/attendance-detail/excel", async (req, res) => {

    const schoolId = req.schoolId;
    const classId = req.query.class_id || "";
    const batchId = req.query.batch_id || "";
    const levelId = req.query.level_id || "";
    const branchId = req.query.branch_id || "";
    const studentName = (req.query.student_name || "").trim();
    const numMonths = Math.max(1, Math.min(12, parseInt(req.query.months) || 3));

    try {

        const rows = await buildAttendanceDetailRows(schoolId, { classId, batchId, levelId, branchId, studentName, numMonths });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Attendance Detail");
        sheet.columns = [
            { header: "Student", key: "studentName", width: 25 },
            { header: "Roll Number", key: "admissionNo", width: 15 },
            { header: "Class", key: "className", width: 15 },
            { header: "Batch", key: "batchName", width: 15 },
            { header: "Branch/Centre", key: "branchName", width: 18 },
            { header: "Month", key: "month", width: 12 },
            { header: "Expected", key: "expected", width: 12 },
            { header: "Attended (Own Batch)", key: "homeAttended", width: 18 },
            { header: "Attended (Different Batch)", key: "differentAttended", width: 22 },
            { header: "Total Attended", key: "totalAttended", width: 15 },
            { header: "%", key: "pct", width: 10 },
            { header: "Status", key: "status", width: 15 }
        ];
        rows.forEach(r => sheet.addRow({
            studentName: r.studentName,
            admissionNo: r.admissionNo || "",
            className: r.className || "",
            batchName: r.batchName || "",
            branchName: r.branchName || "",
            month: r.month,
            expected: r.expected == null ? "-" : r.expected,
            homeAttended: r.expected == null ? "-" : r.homeAttended,
            differentAttended: r.differentAttended,
            totalAttended: r.expected == null ? "-" : r.totalAttended,
            pct: r.pct == null ? "-" : r.pct + "%",
            status: r.status
        }));
        sheet.getRow(1).font = { bold: true };

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=attendance-detail-report.xlsx");
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        res.send(err.message);
    }

});

/* ===========================================
   DAY-WISE DETAIL for one student, one month - the drill-down from the
   Attendance Detail Report above, for whenever a monthly summary isn't
   enough and someone needs to see the actual day-by-day record (which
   exact days were present/absent, and which specific days were a
   different-batch visit).
=========================================== */
router.get("/attendance-detail/:studentId/days", async (req, res) => {

    const schoolId = req.schoolId;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const student = await dbGet(
        "SELECT students.*, classes.class_name FROM students LEFT JOIN classes ON students.class_id = classes.id WHERE students.id=? AND students.school_id=?",
        [req.params.studentId, schoolId]
    );
    if (!student) return res.send("Student not found");

    const [y, mo] = month.split("-");
    const from = `${y}-${mo}-01`;
    const to = `${y}-${mo}-31`;

    const days = await dbAll(
        `SELECT attendance.attendance_date, attendance.status, attendance.is_different_batch, attendance.hours_attended,
                batch.name AS batch_name
         FROM attendance
         LEFT JOIN lookup_items batch ON attendance.batch_id = batch.id
         WHERE attendance.student_id=? AND attendance.school_id=? AND attendance.attendance_date BETWEEN ? AND ?
         ORDER BY attendance.attendance_date, attendance.id`,
        [req.params.studentId, schoolId, from, to]
    );

    res.render("attendanceDayDetail", { student, month, days });

});


router.get("/attendance-regularity", (req, res) => {

    const schoolId = req.schoolId;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const levelId = req.query.level_id || "";
    const batchId = req.query.batch_id || "";
    const classId = req.query.class_id || "";
    const branchId = req.query.branch_id || "";
    const studentName = (req.query.student_name || "").trim();

    // Expected classes so far: sessions/week x (days ELAPSED / 7), not the
    // whole month - a student checked mid-month shouldn't be marked
    // Irregular just because the month isn't over yet.
    const { daysElapsed, isCurrentMonth } = getElapsedInfo(month);
    const [year, mon] = month.split("-");
    const from = `${year}-${mon}-01`;
    const to = `${year}-${mon}-31`; // BETWEEN with a plain date string comparison is safe even for shorter months

    Promise.all([
        new Promise((resolve, reject) => {
            db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
        }),
        new Promise((resolve, reject) => {
            db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
        }),
        new Promise((resolve, reject) => {
            db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
        }),
        new Promise((resolve, reject) => {
            db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
        })
    ]).then(([levels, batches, classes, branches]) => {

        let sql = `
            SELECT students.id, students.name, students.admission_no,
                   level.name AS level_name,
                   batch.name AS batch_name, batch.sessions_per_week,
                   classes.class_name, branch.name AS branch_name,
                   COUNT(CASE WHEN attendance.status='Present' THEN 1 END) AS attended
            FROM students
            LEFT JOIN lookup_items level ON students.level_id = level.id
            LEFT JOIN lookup_items batch ON students.batch_id = batch.id
            LEFT JOIN classes ON students.class_id = classes.id
            LEFT JOIN lookup_items branch ON students.branch_id = branch.id
            LEFT JOIN attendance
                   ON attendance.student_id = students.id
                  AND attendance.attendance_date BETWEEN ? AND ?
            WHERE students.school_id = ?
        `;
        const params = [from, to, schoolId];

        if (levelId) { sql += " AND students.level_id = ?"; params.push(levelId); }
        if (batchId) { sql += " AND students.batch_id = ?"; params.push(batchId); }
        if (classId) { sql += " AND students.class_id = ?"; params.push(classId); }
        if (branchId) { sql += " AND students.branch_id = ?"; params.push(branchId); }
        if (studentName) { sql += " AND students.name LIKE ?"; params.push(`%${studentName}%`); }

        sql += " GROUP BY students.id ORDER BY students.name";

        db.all(sql, params, (err, rows) => {

            if (err) return res.send(err.message);

            // Weekly Attendance Schedule (from the Student Edit page) per
            // student, so "expected" below can match those exact days
            // instead of a rough sessions/week average.
            db.all(
                `SELECT student_id, day_of_week FROM student_schedule WHERE school_id=?`,
                [schoolId],
                (err2, scheduleRows) => {

                    if (err2) return res.send(err2.message);

                    const scheduleByStudent = {};
                    scheduleRows.forEach(sr => {
                        (scheduleByStudent[sr.student_id] = scheduleByStudent[sr.student_id] || []).push(sr.day_of_week);
                    });

                    const withStatus = rows.map(r => {
                        const expected = computeExpected({
                            sessionsPerWeek: r.sessions_per_week,
                            daysElapsed, monthStart: from,
                            scheduleDays: scheduleByStudent[r.id]
                        });
                        const { pct, status } = classifyRegularity(r.attended, expected);
                        return { ...r, expected, pct, status };
                    });

                    res.render("attendanceRegularityReport", {
                        levels, batches, classes, branches, month, rows: withStatus, isCurrentMonth, daysElapsed,
                        selectedLevel: levelId, selectedBatch: batchId, selectedClass: classId, selectedBranch: branchId, studentName
                    });

                }
            );

        });

    }).catch(err => res.send(err.message));

});





router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId], (err, levels) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT exams.*, level.name AS level_name FROM exams
             JOIN lookup_items level ON exams.level_id = level.id
             WHERE exams.school_id = ?
             ORDER BY exams.exam_date DESC`,
            [schoolId],
            (err, exams) => {

                if (err) return res.send(err.message);

                res.render("reportsHub", { levels, exams });

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
                            // class-wide item (student_id IS NULL, same class - the older
                            // way these were created), a LEVEL-wide item (student_id IS
                            // NULL, same level - how new ones are created now), or a
                            // personalized item created just for THIS student (e.g. the
                            // "Course Fee" from Total Fee on their profile) - never someone
                            // else's personalized item, even if they're in the same class/level.
                            const structures = allStructures.filter(fs =>
                                (fs.student_id == null && fs.class_id != null && fs.class_id === student.class_id) ||
                                (fs.student_id == null && fs.level_id != null && fs.level_id === student.level_id) ||
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

    const { level_id, month, class_id, branch_id } = req.query;
    const schoolId = req.schoolId;

    // Fetch everyone (not scoped by class/level in computeDuesByClass -
    // same safer pattern as Fees Pending: filter the RESULTS afterward
    // rather than changing computeDuesByClass's signature, since Fees Due,
    // Fees Pending, and the Student Report all depend on that helper).
    computeDuesByClass(schoolId, null, (err, results) => {

        if (err) return res.send(err.message);

        const today = new Date().toISOString().slice(0, 10);

        // Flatten to one row per (student, fee item) that still has a due amount and a due date
        const rows = [];
        results.forEach(r => {
            if (level_id && String(r.student.level_id) !== String(level_id)) return;
            if (class_id && String(r.student.class_id) !== String(class_id)) return;
            if (branch_id && String(r.student.branch_id) !== String(branch_id)) return;
            r.feeItems.forEach(f => {
                if (f.due > 0 && f.due_date) {
                    // Optional month filter - "which fees are due THIS
                    // month" rather than every pending due regardless of
                    // when, since the full list can get long/unfocused
                    // once a school's been running a while.
                    if (month && !f.due_date.startsWith(month)) return;
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

        Promise.all([
            dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
            dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId]),
            dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId])
        ]).then(([levels, branches, classes]) => {

            getSimpleFeeMode(schoolId)
                .then(simpleFeeMode => res.render("feesDueReport", {
                    rows, levels, branches, classes,
                    level_id: level_id || "", month: month || "",
                    class_id: class_id || "", branch_id: branch_id || "",
                    simpleFeeMode
                }))
                .catch(err3 => res.send(err3.message));

        }).catch(err2 => res.send(err2.message));

    });

});


/* ===========================================
   FEES PENDING REPORT (any outstanding balance)
   + bulk WhatsApp reminder
=========================================== */
router.get("/fees-pending", (req, res) => {

    const { batch_id, level_id, class_id, branch_id } = req.query;
    const schoolId = req.schoolId;

    computeDuesByClass(schoolId, null, (err, results) => {

        if (err) return res.send(err.message);

        // Batch, Level, Class(Standard) and Branch/Centre filters are applied
        // here, after computeDuesByClass, rather than passed into the helper -
        // computeDuesByClass is shared by Fees Due, Fees Pending, and the
        // Student Report, so narrowing it down here keeps that shared helper's
        // signature untouched.
        let pending = results.filter(r => r.totalDue > 0);
        if (batch_id) { pending = pending.filter(r => String(r.student.batch_id) === String(batch_id)); }
        if (level_id) { pending = pending.filter(r => String(r.student.level_id) === String(level_id)); }
        if (class_id) { pending = pending.filter(r => String(r.student.class_id) === String(class_id)); }
        if (branch_id) { pending = pending.filter(r => String(r.student.branch_id) === String(branch_id)); }

        Promise.all([
            dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
            dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
            dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId]),
            dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId])
        ]).then(([batches, levels, branches, classes]) => {

            getSimpleFeeMode(schoolId)
                .then(simpleFeeMode => res.render("feesPendingReport", {
                    pending, batches, levels, branches, classes,
                    batch_id: batch_id || "", level_id: level_id || "",
                    class_id: class_id || "", branch_id: branch_id || "",
                    simpleFeeMode
                }))
                .catch(err3 => res.send(err3.message));

        }).catch(err2 => res.send(err2.message));

    });

});

router.post("/fees-pending/remind", (req, res) => {

    const { batch_id, level_id, class_id, branch_id } = req.body;
    const schoolId = req.schoolId;

    computeDuesByClass(schoolId, null, (err, results) => {

        if (err) return res.send(err.message);

        let pending = results.filter(r => r.totalDue > 0 && (r.student.guardian_phone || r.student.guardian_phone_2));
        // Same post-filter as the GET route, so "remind all below" only
        // messages the guardians actually shown on the filtered page.
        if (batch_id) { pending = pending.filter(r => String(r.student.batch_id) === String(batch_id)); }
        if (level_id) { pending = pending.filter(r => String(r.student.level_id) === String(level_id)); }
        if (class_id) { pending = pending.filter(r => String(r.student.class_id) === String(class_id)); }
        if (branch_id) { pending = pending.filter(r => String(r.student.branch_id) === String(branch_id)); }

        getSimpleFeeMode(schoolId).then(simpleFeeMode => {

            const recipients = pending.map(r => ({
                phones: [r.student.guardian_phone, r.student.guardian_phone_2],
                studentId: r.student.id,
                type: "FEE_REMINDER",
                schoolId,
                message: simpleFeeMode
                    ? `Dear Parent, school fees are still pending for ${r.student.name}. Kindly clear the dues at the earliest. - School Office`
                    : `Dear Parent, a total of Rs.${r.totalDue} in school fees is pending for ${r.student.name}. Kindly clear the dues at the earliest. - School Office`
            }));

            const qs = new URLSearchParams();
            if (batch_id) qs.set("batch_id", batch_id);
            if (level_id) qs.set("level_id", level_id);
            if (class_id) qs.set("class_id", class_id);
            if (branch_id) qs.set("branch_id", branch_id);
            const qsStr = qs.toString();
            res.redirect(`/reports/fees-pending${qsStr ? "?" + qsStr : ""}`);
            sendBulk(recipients, 3000);

        }).catch(err2 => res.send(err2.message));

    });

});


/* ===========================================
   EXAM LEVEL RESULTS REPORT
=========================================== */
router.get("/exam-results/:examId", (req, res) => {

    const examId = req.params.examId;
    const schoolId = req.schoolId;

    db.get(
        `SELECT exams.*, level.name AS level_name FROM exams
         JOIN lookup_items level ON exams.level_id = level.id
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
        `SELECT students.*, classes.class_name, batch.name AS batch_name, batch.sessions_per_week
         FROM students
         LEFT JOIN classes ON students.class_id = classes.id
         LEFT JOIN lookup_items batch ON students.batch_id = batch.id
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

                    // Regularity trend: current month plus the previous 5,
                    // each using the student's own schedule - gives a
                    // fuller "progress over time" picture than a single
                    // month, useful when sharing this with a parent.
                    const now = new Date();
                    const months = [];
                    for (let i = 5; i >= 0; i--) {
                        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
                    }

                    const monthlyRegularity = [];

                    db.all(
                        "SELECT day_of_week FROM student_schedule WHERE student_id=? AND school_id=?",
                        [studentId, schoolId],
                        (errSched, scheduleRows) => {

                    const scheduleDays = (scheduleRows || []).map(r => r.day_of_week);

                    let monthsDone = 0;

                    if (months.length === 0) {
                        proceedAfterRegularity();
                    } else {
                        months.forEach(m => {
                            const [y, mo] = m.split("-");
                            const from = `${y}-${mo}-01`;
                            const to = `${y}-${mo}-31`;
                            db.get(
                                `SELECT COUNT(*) AS attended FROM attendance
                                 WHERE student_id=? AND school_id=? AND status='Present'
                                   AND attendance_date BETWEEN ? AND ?`,
                                [studentId, schoolId, from, to],
                                (err3, row) => {
                                    const { daysElapsed } = getElapsedInfo(m);
                                    const expected = computeExpected({
                                        sessionsPerWeek: student.sessions_per_week,
                                        daysElapsed, monthStart: from,
                                        scheduleDays
                                    });
                                    const { pct, status } = classifyRegularity(row ? row.attended : 0, expected);
                                    monthlyRegularity.push({ month: m, attended: row ? row.attended : 0, expected, pct, status });
                                    monthsDone++;
                                    if (monthsDone === months.length) {
                                        monthlyRegularity.sort((a, b) => a.month.localeCompare(b.month));
                                        proceedAfterRegularity();
                                    }
                                }
                            );
                        });
                    }

                        }
                    );

                    function proceedAfterRegularity() {

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
                                        simpleFeeMode,
                                        monthlyRegularity
                                    });
                                }).catch(err2 => res.send(err2.message));

                            }
                        );

                    });

                    }

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
            doc.text(`Roll Number: ${payment.admission_no || "-"}`);
            doc.moveDown();
            doc.text(`Fee: ${payment.fee_name}`);
            doc.text(`Amount Paid: Rs. ${payment.amount_paid}`);
            doc.text(`Mode: ${payment.mode}`);
            if (payment.reference_no) doc.text(`Reference No.: ${payment.reference_no}`);
            if (payment.remarks) doc.text(`Remarks: ${payment.remarks}`);

            doc.moveDown(3);
            doc.text("_______________________", { align: "right" });
            doc.text("Authorized Signatory", { align: "right" });

            doc.end();

        }
    );

});

function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

module.exports = router;
