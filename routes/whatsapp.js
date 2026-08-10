const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { sendMessage, sendBulk, isReady, getDiagnostics, getRecentLogs, getLastQrImage } = require("../services/whatsappClient");
const { requireLogin, requireRole } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   MESSAGE CENTER - pick a student / class, compose, send
=========================================== */
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all(
            `SELECT students.id, students.name, students.guardian_phone, classes.class_name
             FROM students LEFT JOIN classes ON students.class_id = classes.id
             WHERE students.school_id = ?
             ORDER BY students.name`,
            [schoolId],
            (err, students) => {

                if (err) return res.send(err.message);

                db.all(
                    `SELECT message_logs.*, students.name AS student_name
                     FROM message_logs
                     LEFT JOIN students ON message_logs.student_id = students.id
                     WHERE message_logs.school_id = ?
                     ORDER BY message_logs.sent_at DESC
                     LIMIT 50`,
                    [schoolId],
                    (err, logs) => {

                        if (err) return res.send(err.message);

                        res.render("whatsapp", {
                            classes, students, logs,
                            ready: isReady(),
                            qrImage: getLastQrImage(),
                            diagnostics: getDiagnostics()
                        });

                    }
                );

            }
        );

    });

});


/* ===========================================
   SEND TO A SINGLE STUDENT'S GUARDIAN
=========================================== */
router.post("/send", async (req, res) => {

    const { student_id, message } = req.body;

    db.get("SELECT * FROM students WHERE id=? AND school_id=?", [student_id, req.schoolId], async (err, student) => {

        if (err || !student) return res.send("Student not found");

        await sendMessage({ phone: student.guardian_phone, message, studentId: student.id, type: "CUSTOM", schoolId: req.schoolId });

        res.redirect("/whatsapp");

    });

});


/* ===========================================
   BROADCAST TO AN ENTIRE CLASS
=========================================== */
router.post("/broadcast", (req, res) => {

    const { class_id, message } = req.body;

    db.all("SELECT * FROM students WHERE class_id=? AND school_id=?", [class_id, req.schoolId], (err, students) => {

        if (err) return res.send(err.message);

        const recipients = students.map(s => ({
            phone: s.guardian_phone,
            studentId: s.id,
            type: "CUSTOM",
            message,
            schoolId: req.schoolId
        }));

        // Respond immediately; the bulk send runs in the background with delays between messages.
        res.redirect("/whatsapp");
        sendBulk(recipients, 3000);

    });

});

/* ===========================================
   DEBUG / DIAGNOSTICS (Admin only)
   Everything needed to troubleshoot a broken WhatsApp connection without
   needing shell/host log access - current status, environment info, the
   most recent QR code (if one is pending), and a live-ish tail of recent
   WhatsApp-related log lines.
=========================================== */
router.get("/debug", requireRole("Admin"), (req, res) => {

    res.render("whatsappDebug", {
        diagnostics: getDiagnostics(),
        qrImage: getLastQrImage(),
        logs: getRecentLogs()
    });

});

module.exports = router;
