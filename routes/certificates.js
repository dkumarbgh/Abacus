const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sizeOf = require("image-size");
const { requireLogin, requireRole } = require("../middleware/auth");
const { renderCertificates } = require("../services/certificateGenerator");

router.use(requireLogin);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads/certificates")),
        filename: (req, file, cb) => cb(null, `cert_${Date.now()}${path.extname(file.originalname)}`)
    }),
    limits: { fileSize: 8 * 1024 * 1024 } // 8MB - certificate backgrounds are often high-res
});

const CERTIFICATE_TYPES = {
    completion: "Course Completion",
    attendance: "Attendance",
    merit: "Merit / Achievement",
    transfer: "Transfer Certificate"
};

// Fields every template gets by default when created - Admin can add more
// (custom fields) afterward from the field editor.
const DEFAULT_FIELDS = [
    { field_key: "student_name", label: "Student Name", x_pct: 50, y_pct: 45, font_size: 28, bold: 1 },
    { field_key: "date", label: "Date", x_pct: 50, y_pct: 75, font_size: 14, bold: 0 }
];

/* ==========================================
   TEMPLATES: list / add / delete (Admin only)
========================================== */
router.get("/templates", requireRole("Admin"), (req, res) => {

    db.all(
        "SELECT * FROM certificate_templates WHERE school_id=? ORDER BY created_at DESC",
        [req.schoolId],
        (err, templates) => {
            if (err) return res.send(err.message);
            res.render("certificateTemplates", { templates, certificateTypes: CERTIFICATE_TYPES });
        }
    );

});

router.post("/templates/add", requireRole("Admin"), upload.single("background"), (req, res) => {

    if (!req.file) return res.send("Please choose a background image.");

    let dimensions;
    try {
        dimensions = sizeOf(req.file.path);
    } catch (e) {
        return res.send("Couldn't read that image's dimensions - try a different file (JPEG/PNG).");
    }

    const backgroundPath = `/uploads/certificates/${req.file.filename}`;
    const schoolId = req.schoolId;

    db.run(
        `INSERT INTO certificate_templates (school_id, name, certificate_type, background_path, image_width, image_height)
         VALUES (?,?,?,?,?,?)`,
        [schoolId, req.body.name, req.body.certificate_type, backgroundPath, dimensions.width, dimensions.height],
        function (err) {

            if (err) return res.send(err.message);

            const templateId = this.lastID;

            // Seed the two default fields (Student Name, Date) so there's
            // something to see/adjust immediately in the field editor,
            // rather than starting from a totally blank template.
            const stmt = db.prepare(
                `INSERT INTO certificate_fields (template_id, field_key, label, x_pct, y_pct, font_size, bold)
                 VALUES (?,?,?,?,?,?,?)`
            );
            DEFAULT_FIELDS.forEach(f => {
                stmt.run([templateId, f.field_key, f.label, f.x_pct, f.y_pct, f.font_size, f.bold]);
            });
            stmt.finalize(() => {
                res.redirect(`/certificates/templates/${templateId}/edit-fields`);
            });

        }
    );

});

router.get("/templates/:id/delete", requireRole("Admin"), (req, res) => {

    db.run("DELETE FROM certificate_fields WHERE template_id=?", [req.params.id], () => {
        db.run(
            "DELETE FROM certificate_templates WHERE id=? AND school_id=?",
            [req.params.id, req.schoolId],
            (err) => {
                if (err) return res.send(err.message);
                res.redirect("/certificates/templates");
            }
        );
    });

});

/* ==========================================
   FIELD EDITOR (Admin only) - click on the background image to place/move
   fields; positions save as % of image width/height.
========================================== */
router.get("/templates/:id/edit-fields", requireRole("Admin"), (req, res) => {

    db.get(
        "SELECT * FROM certificate_templates WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, template) => {

            if (err) return res.send(err.message);
            if (!template) return res.send("Template not found");

            db.all(
                "SELECT * FROM certificate_fields WHERE template_id=? ORDER BY id",
                [req.params.id],
                (err2, fields) => {
                    if (err2) return res.send(err2.message);
                    res.render("certificateFieldEditor", { template, fields });
                }
            );

        }
    );

});

// Bulk-saves every field's position/style in one call (the editor sends
// the whole current field list each time "Save Layout" is clicked).
router.post("/templates/:id/fields", requireRole("Admin"), (req, res) => {

    const templateId = req.params.id;
    const incoming = req.body.fields || [];

    db.get(
        "SELECT id FROM certificate_templates WHERE id=? AND school_id=?",
        [templateId, req.schoolId],
        (err, template) => {

            if (err) return res.status(500).json({ ok: false, error: err.message });
            if (!template) return res.status(404).json({ ok: false, error: "Template not found" });

            db.run("DELETE FROM certificate_fields WHERE template_id=?", [templateId], (delErr) => {

                if (delErr) return res.status(500).json({ ok: false, error: delErr.message });

                if (incoming.length === 0) return res.json({ ok: true });

                const stmt = db.prepare(
                    `INSERT INTO certificate_fields
                     (template_id, field_key, label, x_pct, y_pct, font_size, font_color, bold, text_align)
                     VALUES (?,?,?,?,?,?,?,?,?)`
                );
                incoming.forEach(f => {
                    stmt.run([
                        templateId, f.field_key, f.label, f.x_pct, f.y_pct,
                        f.font_size || 20, f.font_color || "#000000", f.bold ? 1 : 0, f.text_align || "center"
                    ]);
                });
                stmt.finalize((finErr) => {
                    if (finErr) return res.status(500).json({ ok: false, error: finErr.message });
                    res.json({ ok: true });
                });

            });

        }
    );

});

/* ==========================================
   Template's field list as JSON - used by the generation forms (single +
   bulk) to know which CUSTOM fields (beyond student_name/date) to show a
   text box for, since that varies per template.
========================================== */
router.get("/templates/:id/fields.json", (req, res) => {

    db.get(
        "SELECT id FROM certificate_templates WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, template) => {

            if (err) return res.status(500).json({ ok: false, error: err.message });
            if (!template) return res.status(404).json({ ok: false, error: "Template not found" });

            db.all(
                "SELECT field_key, label FROM certificate_fields WHERE template_id=? ORDER BY id",
                [req.params.id],
                (err2, fields) => {
                    if (err2) return res.status(500).json({ ok: false, error: err2.message });
                    // student_name and date are handled separately by the
                    // form already (name comes from the student record,
                    // date has its own dedicated date picker) - only the
                    // custom ones need a generic text box.
                    const custom = fields.filter(f => f.field_key !== "student_name" && f.field_key !== "date");
                    res.json({ ok: true, fields: custom });
                }
            );

        }
    );

});

/* ==========================================
   SINGLE-STUDENT GENERATION
========================================== */
router.get("/generate/:studentId", (req, res) => {

    const schoolId = req.schoolId;

    db.get(
        "SELECT * FROM students WHERE id=? AND school_id=?",
        [req.params.studentId, schoolId],
        (err, student) => {

            if (err) return res.send(err.message);
            if (!student) return res.send("Student not found");

            db.all(
                "SELECT * FROM certificate_templates WHERE school_id=? ORDER BY name",
                [schoolId],
                (err2, templates) => {
                    if (err2) return res.send(err2.message);
                    res.render("certificateGenerate", { student, templates, certificateTypes: CERTIFICATE_TYPES });
                }
            );

        }
    );

});

router.post("/generate/:studentId", async (req, res) => {

    const schoolId = req.schoolId;
    const { template_id } = req.body;

    try {
        const student = await dbGet("SELECT * FROM students WHERE id=? AND school_id=?", [req.params.studentId, schoolId]);
        if (!student) return res.status(404).send("Student not found");

        const template = await dbGet("SELECT * FROM certificate_templates WHERE id=? AND school_id=?", [template_id, schoolId]);
        if (!template) return res.status(404).send("Template not found");

        const fields = await dbAll("SELECT * FROM certificate_fields WHERE template_id=?", [template_id]);

        const values = buildValuesForStudent(student, fields, req.body);

        // Log this issuance for later reprinting/audit.
        await dbRun(
            `INSERT INTO certificates_issued (school_id, template_id, student_id, issued_date, custom_values, issued_by)
             VALUES (?,?,?,?,?,?)`,
            [schoolId, template_id, student.id, values.date || new Date().toISOString().slice(0, 10), JSON.stringify(values), req.session.userId]
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${template.certificate_type}_${student.name.replace(/\s+/g, "_")}.pdf"`);

        renderCertificates({ template, fields, valuesList: [values], destination: res });

    } catch (e) {
        res.status(500).send(e.message);
    }

});

/* ==========================================
   BULK GENERATION - pick students by class/batch, one multi-page PDF
========================================== */
router.get("/bulk", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='batch' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM certificate_templates WHERE school_id=? ORDER BY name", [schoolId])
    ]).then(([classes, batches, templates]) => {
        res.render("certificateBulk", { classes, batches, templates });
    }).catch(err => res.send(err.message));

});

router.get("/bulk/students", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const { class_id, batch_id } = req.query;

    let sql = "SELECT id, name, admission_no FROM students WHERE school_id=?";
    const params = [schoolId];
    if (class_id) { sql += " AND class_id=?"; params.push(class_id); }
    if (batch_id) { sql += " AND batch_id=?"; params.push(batch_id); }
    sql += " ORDER BY name";

    db.all(sql, params, (err, students) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, students });
    });

});

router.post("/bulk/generate", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const { template_id, date } = req.body;
    const studentIds = [].concat(req.body.student_ids || []);

    if (studentIds.length === 0) return res.send("No students selected. <a href='/certificates/bulk'>Back</a>");

    try {
        const template = await dbGet("SELECT * FROM certificate_templates WHERE id=? AND school_id=?", [template_id, schoolId]);
        if (!template) return res.status(404).send("Template not found");

        const fields = await dbAll("SELECT * FROM certificate_fields WHERE template_id=?", [template_id]);

        const students = await dbAll(
            `SELECT * FROM students WHERE school_id=? AND id IN (${studentIds.map(() => "?").join(",")})`,
            [schoolId, ...studentIds]
        );

        const valuesList = students.map(s => buildValuesForStudent(s, fields, req.body));

        // Log each issuance.
        for (let i = 0; i < students.length; i++) {
            await dbRun(
                `INSERT INTO certificates_issued (school_id, template_id, student_id, issued_date, custom_values, issued_by)
                 VALUES (?,?,?,?,?,?)`,
                [schoolId, template_id, students[i].id, date || new Date().toISOString().slice(0, 10), JSON.stringify(valuesList[i]), req.session.userId]
            );
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${template.certificate_type}_batch.pdf"`);

        renderCertificates({ template, fields, valuesList, destination: res });

    } catch (e) {
        res.status(500).send(e.message);
    }

});

/* ==========================================
   Small promise helpers (kept local to this file - the rest of the app
   uses callback-style db.get/db.all/db.run throughout, but the
   generation routes above read much more clearly with await).
========================================== */
function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}

/**
 * Resolves each field's display value: student_name comes from the
 * student record, date defaults to today (or the form's chosen date),
 * anything else is a "custom" field the form must have supplied a value
 * for (e.g. course_name for a Completion certificate) - same value is
 * used for every student in a bulk run, which matches "the whole batch
 * completed this course" style use cases.
 */
function buildValuesForStudent(student, fields, body) {
    const values = {};
    fields.forEach(f => {
        if (f.field_key === "student_name") {
            values.student_name = student.name;
        } else if (f.field_key === "date") {
            values.date = body.date || new Date().toISOString().slice(0, 10);
        } else {
            values[f.field_key] = body[`field_${f.field_key}`] || "";
        }
    });
    return values;
}

module.exports = router;
