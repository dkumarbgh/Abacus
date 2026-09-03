const express = require("express");
const router = express.Router();
const db = require("../config/database");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { requireLogin, requireRole } = require("../middleware/auth");
const { renderTestPaper } = require("../services/abacusTestGenerator");
const { distributeDocument } = require("../services/distribution");

router.use(requireLogin);

/* ==========================================
   CONFIGURATION PAGE - Paper Settings (incl. an editable Date) + the
   library of previously generated/saved papers below it.
========================================== */
router.get("/", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM test_papers_generated WHERE school_id=? ORDER BY created_at DESC LIMIT 50", [schoolId]),
        Promise.resolve(require("../services/emailClient").isConfigured())
    ]).then(([classes, batches, levels, savedPapers, emailConfigured]) => {
        res.render("testPapers", { classes, batches, levels, savedPapers, emailConfigured });
    }).catch(err => res.send(err.message));

});

/* ==========================================
   GENERATE & SAVE - creates a new randomized paper, saves the PDF to
   disk + a DB record (so it's available for reference/re-sending later,
   not just a one-time stream), then redirects to view it - opened in a
   new tab from the form, so this lands there as a normal PDF preview.
========================================== */
router.post("/generate", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const config = await resolveConfig(req.body, schoolId);
    if (config.error) return res.status(400).json({ ok: false, error: config.error });

    const fileName = `testpaper_${Date.now()}.pdf`;
    const absolutePath = path.join(__dirname, "../public/uploads/test-papers", fileName);

    try {
        await new Promise((resolve, reject) => {
            const dest = fs.createWriteStream(absolutePath);
            dest.on("finish", resolve);
            dest.on("error", reject);
            renderTestPaper({ ...config, destination: dest });
        });

        const result = await dbRun(
            `INSERT INTO test_papers_generated
             (school_id, level_id, level_name, source, digit_count, operand_count, problem_count, include_subtraction, paper_date, file_path, generated_by)
             VALUES (?,?,?, 'generated', ?,?,?,?,?,?,?)`,
            [
                schoolId, req.body.level_id, config.levelName,
                config.digitCount, config.operandCount, config.problemCount, config.includeSubtraction ? 1 : 0,
                config.paperDate, `/uploads/test-papers/${fileName}`, req.session.userId
            ]
        );

        // JSON instead of a redirect - the page that submitted this stays
        // put and updates its own Saved Papers list via JS, rather than
        // requiring a manual refresh to see the new paper appear. The
        // frontend opens the PDF preview itself via viewUrl.
        res.json({ ok: true, id: result.lastID, viewUrl: `/test-papers/${result.lastID}/view` });

    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }

});

/* ==========================================
   UPLOAD A TEST PAPER MANUALLY - for a pre-made/scanned paper rather than
   an auto-generated one. Shows up in the same Saved Test Papers list,
   sendable through the exact same Send flow - the Send/View/Delete
   routes above don't care whether a paper was generated or uploaded.
========================================== */
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads/test-papers")),
        filename: (req, file, cb) => cb(null, `uploaded_${Date.now()}${path.extname(file.originalname)}`)
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
});

router.post("/upload", requireRole("Admin"), upload.single("file"), async (req, res) => {

    if (!req.file) return res.status(400).json({ ok: false, error: "Please choose a file to upload." });

    const schoolId = req.schoolId;
    const level = await dbGet("SELECT * FROM lookup_items WHERE id=? AND school_id=? AND list_type='level'", [req.body.level_id, schoolId]);
    if (!level) return res.status(400).json({ ok: false, error: "Please select a valid Level." });

    try {
        const result = await dbRun(
            `INSERT INTO test_papers_generated
             (school_id, level_id, level_name, source, paper_date, file_path, generated_by)
             VALUES (?,?,?, 'uploaded', ?,?,?)`,
            [
                schoolId, level.id, level.name,
                req.body.paper_date || new Date().toISOString().slice(0, 10),
                `/uploads/test-papers/${req.file.filename}`, req.session.userId
            ]
        );

        res.json({ ok: true, id: result.lastID, viewUrl: `/test-papers/${result.lastID}/view` });

    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }

});

/* ==========================================
   Saved papers list as JSON - used to refresh the on-page table after a
   generate/upload, without a full page reload.
========================================== */
router.get("/list.json", requireRole("Admin"), async (req, res) => {
    const papers = await dbAll("SELECT * FROM test_papers_generated WHERE school_id=? ORDER BY created_at DESC LIMIT 50", [req.schoolId]);
    res.json({ ok: true, papers });
});

/* ==========================================
   VIEW a saved paper (inline PDF - for reference, or to double-check
   before sending).
========================================== */
router.get("/:id/view", async (req, res) => {

    const paper = await dbGet("SELECT * FROM test_papers_generated WHERE id=? AND school_id=?", [req.params.id, req.schoolId]);
    if (!paper) return res.status(404).send("Test paper not found.");

    const absolutePath = path.join(__dirname, "../public", paper.file_path);
    if (!fs.existsSync(absolutePath)) return res.status(404).send("That paper's file is missing on disk.");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="abacus-test-${paper.level_name.replace(/\s+/g, "_")}-${paper.paper_date}.pdf"`);
    fs.createReadStream(absolutePath).pipe(res);

});

router.get("/:id/delete", requireRole("Admin"), async (req, res) => {

    const paper = await dbGet("SELECT * FROM test_papers_generated WHERE id=? AND school_id=?", [req.params.id, req.schoolId]);
    if (paper) {
        const absolutePath = path.join(__dirname, "../public", paper.file_path);
        fs.unlink(absolutePath, () => {}); // ignore errors if already gone
        await dbRun("DELETE FROM test_papers_generated WHERE id=? AND school_id=?", [req.params.id, req.schoolId]);
    }
    res.redirect("/test-papers");

});

/* ==========================================
   SEND a specific SAVED paper - select students/channels here, the file
   itself is whatever was already generated (never regenerated on send,
   so what you previewed is exactly what gets sent).
========================================== */
router.get("/:id/send", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const paper = await dbGet("SELECT * FROM test_papers_generated WHERE id=? AND school_id=?", [req.params.id, schoolId]);
    if (!paper) return res.send("Test paper not found.");

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        Promise.resolve(require("../services/emailClient").isConfigured())
    ]).then(([classes, batches, levels, emailConfigured]) => {
        res.render("testPaperSend", { paper, classes, batches, levels, emailConfigured });
    }).catch(err => res.send(err.message));

});

router.get("/students", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const { class_id, batch_id, level_id } = req.query;

    let sql = "SELECT id, name, admission_no, guardian_phone, guardian_phone_2, guardian_email FROM students WHERE school_id=?";
    const params = [schoolId];
    if (class_id) { sql += " AND class_id=?"; params.push(class_id); }
    if (batch_id) { sql += " AND batch_id=?"; params.push(batch_id); }
    if (level_id) { sql += " AND level_id=?"; params.push(level_id); }
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

    if (!viaWhatsapp && !viaEmail) return res.send("Please choose at least one channel (WhatsApp and/or Email). <a href='/test-papers'>Back</a>");
    if (studentIds.length === 0) return res.send("No students selected. <a href='/test-papers'>Back</a>");

    const features = require("../config/features");
    if (viaWhatsapp && !features.whatsapp) return res.send("WhatsApp is turned off for this deployment. <a href='/test-papers'>Back</a>");
    if (viaEmail && !features.email) return res.send("Email is turned off for this deployment. <a href='/test-papers'>Back</a>");

    try {
        const paper = await dbGet("SELECT * FROM test_papers_generated WHERE id=? AND school_id=?", [req.params.id, schoolId]);
        if (!paper) return res.send("Test paper not found.");

        const absolutePath = path.join(__dirname, "../public", paper.file_path);
        if (!fs.existsSync(absolutePath)) return res.send("That paper's file is missing on disk - it may have been deleted.");

        const students = await dbAll(
            `SELECT * FROM students WHERE school_id=? AND id IN (${studentIds.map(() => "?").join(",")})`,
            [schoolId, ...studentIds]
        );

        const results = await distributeDocument({
            students,
            absoluteFilePath: absolutePath,
            fileName: `abacus-test-${paper.level_name.replace(/\s+/g, "_")}-${paper.paper_date}.pdf`,
            caption: caption || `Please find attached the ${paper.level_name} level abacus practice/test paper.`,
            subject: subject || `Abacus Test Paper - ${paper.level_name}`,
            viaWhatsapp, viaEmail,
            messageType: "TEST_PAPER",
            schoolId
        });

        const sent = results.filter(r => r.status === "SENT").length;
        const skipped = results.filter(r => r.status.startsWith("SKIPPED")).length;
        const failed = results.filter(r => r.status === "FAILED").length;

        res.send(`
            <h4>Sent: ${sent}, Skipped (no contact info): ${skipped}, Failed: ${failed}</h4>
            <a href="/test-papers">Back to Test Papers</a>
        `);

    } catch (e) {
        res.status(500).send(e.message);
    }

});

/**
 * Resolves the effective test-paper settings for a new generation: the
 * chosen Level's saved defaults, overridable per-generation by whatever
 * was submitted on the form (so a teacher can tweak difficulty, or the
 * paper's displayed Date, without changing the Level's permanent defaults).
 */
async function resolveConfig(body, schoolId) {

    const level = await dbGet("SELECT * FROM lookup_items WHERE id=? AND school_id=? AND list_type='level'", [body.level_id, schoolId]);
    if (!level) return { error: "Please select a valid Level." };

    const school = await dbGet("SELECT name FROM schools WHERE id=?", [schoolId]);

    const digitCount = parseInt(body.digit_count) || level.digit_count || 2;
    const operandCount = parseInt(body.operand_count) || level.operand_count || 5;
    const problemCount = parseInt(body.problem_count) || level.problem_count || 20;
    const includeSubtraction = body.include_subtraction === "on"
        ? true
        : (body.include_subtraction === "off" ? false : !!level.include_subtraction);
    const paperDate = body.paper_date || new Date().toISOString().slice(0, 10);

    return {
        levelName: level.name,
        digitCount, operandCount, problemCount, includeSubtraction, paperDate,
        schoolName: school ? school.name : ""
    };

}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}

module.exports = router;
