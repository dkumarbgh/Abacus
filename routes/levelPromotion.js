const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { renderCertificates } = require("../services/certificateGenerator");

router.use(requireLogin);

/* ==========================================
   PROMOTE LEVEL - selection page (works for single OR bulk: a single
   student is just a bulk selection of one). Filter by current Class/Level
   to find who to promote, pick the new Level, and optionally generate a
   Level Completion certificate for the level they're leaving.
========================================== */
router.get("/", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    Promise.all([
        dbAll("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId]),
        dbAll("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId]),
        dbAll("SELECT * FROM certificate_templates WHERE school_id=? AND certificate_type='level_completion' ORDER BY name", [schoolId])
    ]).then(([classes, levels, templates]) => {
        // Pre-select a single student if we arrived here from their
        // profile page (?student_id=X) - same page serves single or bulk.
        res.render("levelPromotion", {
            classes, levels, templates,
            preselectStudentId: req.query.student_id || "",
            promotedCount: req.query.promoted || null
        });
    }).catch(err => res.send(err.message));

});

/* ==========================================
   Student list for the selection page - filterable by current Class
   and/or current Level, same JSON-endpoint pattern as bulk certificates.
========================================== */
router.get("/students", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const { class_id, level_id } = req.query;

    let sql = `
        SELECT students.id, students.name, students.admission_no,
               lookup_items.name AS current_level_name
        FROM students
        LEFT JOIN lookup_items ON students.level_id = lookup_items.id
        WHERE students.school_id=?
    `;
    const params = [schoolId];
    if (class_id) { sql += " AND students.class_id=?"; params.push(class_id); }
    if (level_id) { sql += " AND students.level_id=?"; params.push(level_id); }
    sql += " ORDER BY students.name";

    db.all(sql, params, (err, students) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, students });
    });

});

/* ==========================================
   APPLY PROMOTION - updates level_id for every selected student, logs
   each transition to level_history, and (if requested) streams back a
   multi-page Level Completion certificate PDF for the level they just
   left - one page per student, using each student's OWN old level name
   (they may not all have been on the same level).
========================================== */
router.post("/apply", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const { new_level_id, date, template_id, generate_certificate } = req.body;
    const studentIds = [].concat(req.body.student_ids || []);

    if (studentIds.length === 0) {
        return res.send("No students selected. <a href='/level-promotion'>Back</a>");
    }
    if (!new_level_id) {
        return res.send("Please select the new Level. <a href='/level-promotion'>Back</a>");
    }

    try {
        const newLevel = await dbGet("SELECT * FROM lookup_items WHERE id=? AND school_id=? AND list_type='level'", [new_level_id, schoolId]);
        if (!newLevel) return res.send("That Level was not found.");

        const students = await dbAll(
            `SELECT * FROM students WHERE school_id=? AND id IN (${studentIds.map(() => "?").join(",")})`,
            [schoolId, ...studentIds]
        );

        const promotionDate = date || new Date().toISOString().slice(0, 10);
        const oldLevelNames = {}; // student_id -> their level name BEFORE this promotion

        for (const student of students) {

            let oldLevelName = null;
            if (student.level_id) {
                const oldLevel = await dbGet("SELECT name FROM lookup_items WHERE id=?", [student.level_id]);
                oldLevelName = oldLevel ? oldLevel.name : null;
            }
            oldLevelNames[student.id] = oldLevelName;

            await dbRun(
                `INSERT INTO level_history (school_id, student_id, old_level_id, new_level_id, changed_date, changed_by)
                 VALUES (?,?,?,?,?,?)`,
                [schoolId, student.id, student.level_id || null, new_level_id, promotionDate, req.session.userId]
            );

            await dbRun("UPDATE students SET level_id=? WHERE id=? AND school_id=?", [new_level_id, student.id, schoolId]);

        }

        // Certificate generation is optional - promoting a level doesn't
        // always warrant a certificate (e.g. a mid-term level correction),
        // so this only happens if explicitly requested with a template.
        if (generate_certificate === "on" && template_id) {

            const template = await dbGet("SELECT * FROM certificate_templates WHERE id=? AND school_id=?", [template_id, schoolId]);
            if (!template) return res.send("Certificate template not found.");

            const fields = await dbAll("SELECT * FROM certificate_fields WHERE template_id=?", [template_id]);

            const valuesList = students.map(s => {
                const values = {};
                fields.forEach(f => {
                    if (f.field_key === "student_name") values.student_name = s.name;
                    else if (f.field_key === "date") values.date = promotionDate;
                    else if (f.field_key === "level_name") values.level_name = oldLevelNames[s.id] || "";
                    else values[f.field_key] = req.body[`field_${f.field_key}`] || "";
                });
                return values;
            });

            // Log each certificate issuance too, same as the main certificates flow.
            for (let i = 0; i < students.length; i++) {
                await dbRun(
                    `INSERT INTO certificates_issued (school_id, template_id, student_id, issued_date, custom_values, issued_by)
                     VALUES (?,?,?,?,?,?)`,
                    [schoolId, template_id, students[i].id, promotionDate, JSON.stringify(valuesList[i]), req.session.userId]
                );
            }

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="level_completion_batch.pdf"`);
            return renderCertificates({ template, fields, valuesList, destination: res });

        }

        res.redirect("/level-promotion?promoted=" + students.length);

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
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}

module.exports = router;
