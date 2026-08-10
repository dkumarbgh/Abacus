const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { getFieldSettings, FIELD_DEFS, getAdmissionNoSettings } = require("../services/schoolSettings");

router.use(requireLogin);

/* ==========================================
   VIEW SETTINGS (Admin only)
========================================== */
router.get("/", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    db.get(
        "SELECT simple_fee_mode FROM schools WHERE id=?",
        [schoolId],
        (err, school) => {

            if (err) return res.send(err.message);

            getFieldSettings(schoolId, "student")
                .then(studentFieldSettings => {

                    // Pair each field's label (from FIELD_DEFS) with its current
                    // on/off value, in a stable order, for the view to loop over.
                    const studentFields = Object.keys(FIELD_DEFS.student).map(key => ({
                        key,
                        label: FIELD_DEFS.student[key].label,
                        mandatory: studentFieldSettings[key]
                    }));

                    return getAdmissionNoSettings(schoolId).then(admissionNo => {
                        res.render("settings", {
                            simpleFeeMode: !!(school && school.simple_fee_mode),
                            studentFields,
                            admissionNo
                        });
                    });

                })
                .catch(err2 => res.send(err2.message));

        }
    );

});


/* ==========================================
   TOGGLE SIMPLE FEE MODE (Admin only)
   ON  -> fee collection is just Paid / Not Paid, no amount entry
   OFF -> fee collection accepts any amount (partial payments allowed)
========================================== */
router.post("/fee-mode", requireRole("Admin"), (req, res) => {

    const enabled = req.body.simple_fee_mode === "on" ? 1 : 0;

    db.run(
        "UPDATE schools SET simple_fee_mode=? WHERE id=?",
        [enabled, req.schoolId],
        (err) => {

            if (err) return res.send(err.message);

            res.redirect("/settings");

        }
    );

});


/* ==========================================
   UPDATE STUDENT FORM MANDATORY FIELDS (Admin only)
   Any configurable field NOT checked in the submitted form is saved as
   optional; checked ones are saved as mandatory. Upserts one row per
   field into field_settings.
========================================== */
router.post("/fields/student", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const checked = [].concat(req.body.mandatory_fields || []); // array of field_keys that were checked

    const fieldKeys = Object.keys(FIELD_DEFS.student);

    const stmt = db.prepare(`
        INSERT INTO field_settings (school_id, form_key, field_key, is_mandatory)
        VALUES (?, 'student', ?, ?)
        ON CONFLICT(school_id, form_key, field_key) DO UPDATE SET is_mandatory=excluded.is_mandatory
    `);

    fieldKeys.forEach(key => {
        stmt.run([schoolId, key, checked.includes(key) ? 1 : 0]);
    });

    stmt.finalize((err) => {

        if (err) return res.send(err.message);

        res.redirect("/settings");

    });

});

/* ==========================================
   UPDATE ADMISSION NO. AUTO-ASSIGNMENT (Admin only)
========================================== */
router.post("/admission-no", requireRole("Admin"), (req, res) => {

    const auto = req.body.admission_no_auto === "on" ? 1 : 0;
    const prefix = (req.body.admission_no_prefix || "").trim();

    db.run(
        "UPDATE schools SET admission_no_auto=?, admission_no_prefix=? WHERE id=?",
        [auto, prefix, req.schoolId],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/settings");
        }
    );

});

/* ==========================================
   FULL DATABASE BACKUP (Admin only)
   Uses VACUUM INTO to write a clean, consistent snapshot to a temp file
   first (rather than sending the live school.db directly), so a backup
   never captures a half-written row if someone happens to be saving
   something else at the same moment. The temp copy is deleted right after
   it's streamed to the browser.
========================================== */
router.get("/backup", requireRole("Admin"), (req, res) => {

    const os = require("os");
    const path = require("path");
    const fs = require("fs");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempPath = path.join(os.tmpdir(), `simpleschool-backup-${stamp}.db`);

    db.run(`VACUUM INTO ?`, [tempPath], (err) => {

        if (err) return res.send("Backup failed: " + err.message);

        res.download(tempPath, `simpleschool-backup-${stamp}.db`, (downloadErr) => {
            // Clean up the temp copy either way, once the download has
            // finished (or failed) - don't leave snapshots piling up on disk.
            fs.unlink(tempPath, () => {});
            if (downloadErr) console.error("Backup download error:", downloadErr.message);
        });

    });

});

module.exports = router;
