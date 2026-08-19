const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireLogin, requireRole } = require("../middleware/auth");
const { distributeDocument } = require("../services/distribution");

router.use(requireLogin);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads/sheets")),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`)
    }),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

/* ===========================================
   LIST + UPLOAD FORM
=========================================== */
router.get("/", (req, res) => {

    const { class_id, subject_id } = req.query;
    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

            if (err) return res.send(err.message);

            let sql = `
                SELECT practice_sheets.*, classes.class_name, subjects.subject_name
                FROM practice_sheets
                JOIN classes ON practice_sheets.class_id = classes.id
                JOIN subjects ON practice_sheets.subject_id = subjects.id
                WHERE practice_sheets.school_id = ?
            `;
            const params = [schoolId];

            if (class_id) { sql += " AND practice_sheets.class_id=?"; params.push(class_id); }
            if (subject_id) { sql += " AND practice_sheets.subject_id=?"; params.push(subject_id); }

            sql += " ORDER BY practice_sheets.uploaded_at DESC";

            db.all(sql, params, (err, sheets) => {

                if (err) return res.send(err.message);

                res.render("practiceSheets", { classes, subjects, sheets, class_id, subject_id });

            });

        });

    });

});


/* ===========================================
   UPLOAD A SHEET
=========================================== */
router.post("/upload", upload.single("file"), (req, res) => {

    if (!req.file) return res.send("<h4>Please choose a PDF to upload.</h4><a href='/practice-sheets'>Back</a>");

    const { title, class_id, subject_id } = req.body;
    const file_path = `/uploads/sheets/${req.file.filename}`;

    db.run(
        `INSERT INTO practice_sheets (class_id, subject_id, title, file_path, school_id)
         VALUES (?,?,?,?,?)`,
        [class_id, subject_id, title, file_path, req.schoolId],
        (err) => {

            if (err) return res.send(err.message);

            res.redirect("/practice-sheets");

        }
    );

});


/* ===========================================
   DELETE A SHEET
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.get("SELECT * FROM practice_sheets WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err, sheet) => {

        if (err) return res.send(err.message);

        db.run("DELETE FROM practice_sheets WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err) => {

            if (err) return res.send(err.message);

            if (sheet) {
                const filePath = path.join(__dirname, "../public", sheet.file_path);
                fs.unlink(filePath, () => {}); // ignore errors if file already gone
            }

            res.redirect("/practice-sheets");

        });

    });

});

/* ===========================================
   SEND AN EXISTING SHEET - same distribution mechanism as Test Papers,
   just with an already-uploaded file instead of a freshly generated one.
========================================== */
router.get("/:id/send", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    db.get(
        "SELECT * FROM practice_sheets WHERE id=? AND school_id=?",
        [req.params.id, schoolId],
        (err, sheet) => {

            if (err) return res.send(err.message);
            if (!sheet) return res.send("Sheet not found");

            Promise.all([
                dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
                dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
                Promise.resolve(require("../services/emailClient").isConfigured())
            ]).then(([classes, batches, emailConfigured]) => {
                res.render("practiceSheetSend", { sheet, classes, batches, emailConfigured });
            }).catch(err2 => res.send(err2.message));

        }
    );

});

router.get("/:id/students", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const { class_id, batch_id } = req.query;

    let sql = "SELECT id, name, admission_no, guardian_phone, guardian_email FROM students WHERE school_id=?";
    const params = [schoolId];
    if (class_id) { sql += " AND class_id=?"; params.push(class_id); }
    if (batch_id) { sql += " AND batch_id=?"; params.push(batch_id); }
    sql += " ORDER BY name";

    db.all(sql, params, (err, students) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, students });
    });

});

router.post("/:id/send", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const { via_whatsapp, via_email, caption, subject } = req.body;
    const studentIds = [].concat(req.body.student_ids || []);

    const viaWhatsapp = via_whatsapp === "on";
    const viaEmail = via_email === "on";

    if (!viaWhatsapp && !viaEmail) return res.send("Please choose at least one channel. <a href='/practice-sheets'>Back</a>");
    if (studentIds.length === 0) return res.send("No students selected. <a href='/practice-sheets'>Back</a>");

    const features = require("../config/features");
    if (viaWhatsapp && !features.whatsapp) return res.send("WhatsApp is turned off for this deployment. <a href='/practice-sheets'>Back</a>");
    if (viaEmail && !features.email) return res.send("Email is turned off for this deployment. <a href='/practice-sheets'>Back</a>");

    try {
        const sheet = await dbGet("SELECT * FROM practice_sheets WHERE id=? AND school_id=?", [req.params.id, schoolId]);
        if (!sheet) return res.send("Sheet not found");

        const students = await dbAll(
            `SELECT * FROM students WHERE school_id=? AND id IN (${studentIds.map(() => "?").join(",")})`,
            [schoolId, ...studentIds]
        );

        const absolutePath = path.join(__dirname, "../public", sheet.file_path);

        const results = await distributeDocument({
            students,
            absoluteFilePath: absolutePath,
            fileName: sheet.title ? `${sheet.title}.pdf` : path.basename(sheet.file_path),
            caption: caption || `Please find attached: ${sheet.title || "practice sheet"}.`,
            subject: subject || sheet.title || "Practice Sheet",
            viaWhatsapp, viaEmail,
            messageType: "PRACTICE_SHEET",
            schoolId
        });

        const sent = results.filter(r => r.status === "SENT").length;
        const skipped = results.filter(r => r.status.startsWith("SKIPPED")).length;
        const failed = results.filter(r => r.status === "FAILED").length;

        res.send(`
            <h4>Sent: ${sent}, Skipped (no contact info): ${skipped}, Failed: ${failed}</h4>
            <a href="/practice-sheets">Back to Practice Sheets</a>
        `);

    } catch (e) {
        res.status(500).send(e.message);
    }

});

function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

module.exports = router;
