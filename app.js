// Loads .env (if present) and feature flags FIRST, before any other module
// (e.g. config/database.js reading DB_PATH) reads process.env.
const features = require("./config/features");

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const session = require("express-session");

const db = require("./config/database");
const { requireLogin } = require("./middleware/auth");
const fs = require("fs");

// Multer (file uploads) does NOT create its destination folder if it's
// missing - the first upload would just crash with ENOENT. Rather than
// relying on placeholder files surviving git/deployment, create every
// upload folder here on every startup - cheap, idempotent (no-op if it
// already exists), and works the same whether this is a fresh clone, a
// fresh Render deploy, or a folder someone accidentally deleted.
["students", "tmp", "sheets", "faces"].forEach(dir => {
    fs.mkdirSync(path.join(__dirname, "public/uploads", dir), { recursive: true });
});

const authRoutes = require("./routes/auth");
const studentRoutes = require("./routes/students");
const classRoutes = require("./routes/classes");
const teacherRoutes = require("./routes/teachers");
const attendanceRoutes = require("./routes/attendance");
const subjectRoutes = require("./routes/subjects");
const assignmentRoutes = require("./routes/assignments");
const timetableRoutes = require("./routes/timetable");
const feeRoutes = require("./routes/fees");
const feeStructureRoutes = require("./routes/feeStructure");
const feePaymentRoutes = require("./routes/feePayments");
const examRoutes = require("./routes/exams");
const practiceSheetRoutes = require("./routes/practiceSheets");
const whatsappRoutes = require("./routes/whatsapp");
const reportRoutes = require("./routes/reports");
const apiRoutes = require("./routes/api");
const settingsRoutes = require("./routes/settings");
const listsRoutes = require("./routes/lists");
const superAdminRoutes = require("./routes/superAdmin");




const app = express();
app.use((req, res, next) => {
    console.log(req.method, req.url);
    next();
});
// View Engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Sessions (web admin login). Using the default in-memory store - fine at
// this scale (a single small school's staff); it just means everyone is
// logged out if the server restarts. Swap in a persistent store (e.g.
// connect-sqlite3 or connect-redis) later if that becomes annoying.
app.use(session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Make the logged-in user available to every EJS view as `currentUser`
// (used by the navbar to show school name / user / admin-only links)
app.use((req, res, next) => {
    res.locals.currentUser = req.session && req.session.userId
        ? { name: req.session.name, role: req.session.role, schoolName: req.session.schoolName }
        : null;
    // When a Super Admin is viewing a school as if they were its Admin
    // (see routes/superAdmin.js login-as), this flags it for the navbar so
    // there's always a visible way back to /super-admin - never silently
    // "become" that school's Admin with no way out.
    res.locals.impersonating = !!(req.session && req.session.superAdminOriginal);
    res.locals.features = features;
    next();
});

// Static Files
app.use(express.static(path.join(__dirname, "public")));

// Auth routes (login, register-school, logout, user management) - public,
// except /users/* which requireLogin+requireRole internally
app.use("/", authRoutes);

// Mobile/API routes use their own JWT auth (see routes/api.js and the
// face-mark route in routes/attendance.js) - NOT the session-based
// requireLogin below, so they're mounted before that gate.
app.use("/api", apiRoutes);

// Routes (each of these applies requireLogin internally at the top of the
// file, scoping every query to req.schoolId)
app.use("/students", studentRoutes);
app.use("/classes", classRoutes);
app.use("/teachers", teacherRoutes);
app.use("/attendance", attendanceRoutes); // face-mark inside is JWT-only; rest is session-only
app.use("/subjects", subjectRoutes);
app.use("/assignments", assignmentRoutes);
app.use("/timetable", timetableRoutes);
app.use("/fees", feeRoutes);
app.use("/fee-structure", feeStructureRoutes);
app.use("/fee-payments", feePaymentRoutes);
app.use("/exams", examRoutes);
app.use("/practice-sheets", practiceSheetRoutes);
app.use("/whatsapp", whatsappRoutes);
app.use("/reports", reportRoutes);
app.use("/settings", settingsRoutes);
app.use("/lists", listsRoutes);
app.use("/super-admin", superAdminRoutes);

// Dashboard
app.get("/", requireLogin, (req, res) => {

    const schoolId = req.schoolId;

    db.get(
        "SELECT COUNT(*) totalStudents FROM students WHERE school_id=?",
        [schoolId],
        (err, studentCount) => {

            if (err) return res.send(err.message);

            db.get(
                "SELECT COUNT(*) totalClasses FROM classes WHERE school_id=?",
                [schoolId],
                (err, classCount) => {

                    if (err) return res.send(err.message);

                    db.get(
                        "SELECT COUNT(*) totalTeachers FROM teachers WHERE school_id=?",
                        [schoolId],
                        (err, teacherCount) => {

                            if (err) return res.send(err.message);

                            db.all(
                                `SELECT students.name,
                                        classes.class_name
                                 FROM students
                                 LEFT JOIN classes
                                 ON students.class_id = classes.id
                                 WHERE students.school_id = ?
                                 ORDER BY students.id DESC
                                 LIMIT 5`,
                                [schoolId],
                                (err, recentStudents) => {

                                    if (err) return res.send(err.message);

                                    db.all(
                                        `SELECT classes.class_name,
                                                COUNT(students.id) total
                                         FROM classes
                                         LEFT JOIN students
                                         ON students.class_id = classes.id AND students.school_id = ?
                                         WHERE classes.school_id = ?
                                         GROUP BY classes.id
                                         ORDER BY classes.class_name`,
                                        [schoolId, schoolId],
                                        (err, classSummary) => {

                                            if (err) return res.send(err.message);

                                            res.render("dashboard", {

                                                students: studentCount.totalStudents,

                                                classes: classCount.totalClasses,

                                                teachers: teacherCount.totalTeachers,

                                                recentStudents,

                                                classSummary

                                            });

                                        });

                                });

                        });

                });

        });

});

// 404 Page
app.use((req, res) => {
    res.status(404).send("404 - Page Not Found");
});

// Start Server
const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
