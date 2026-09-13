const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");
const { getFieldSettings, FIELD_DEFS, getAdmissionNoSettings, getDefaultHoursAttended, getReceiptNoSettings } = require("../services/schoolSettings");
const { getSchoolLanguage, allKeysGrouped } = require("../services/labels");

router.use(requireLogin);

/* ==========================================
   VIEW SETTINGS (Admin only)
========================================== */
router.get("/", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    db.get(
        "SELECT simple_fee_mode, language, attendance_import_export_enabled, fees_import_export_enabled FROM schools WHERE id=?",
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
                        return getDefaultHoursAttended(schoolId).then(defaultHoursAttended => {
                            return getReceiptNoSettings(schoolId).then(receiptNo => {
                                res.render("settings", {
                                    simpleFeeMode: !!(school && school.simple_fee_mode),
                                    studentFields,
                                    admissionNo,
                                    defaultHoursAttended,
                                    receiptNo,
                                    language: (school && school.language) || "en",
                                    attendanceImportExportEnabled: !!(school && school.attendance_import_export_enabled),
                                    feesImportExportEnabled: !!(school && school.fees_import_export_enabled)
                                });
                            });
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
   UPDATE DEFAULT HOURS ATTENDED (Admin only)
   Pre-fills the "hours" box in Attendance Management. Clamped to the
   same 0-12 range enforced on the attendance form itself, so a stray
   value here can't produce something nonsensical downstream.
========================================== */
router.post("/attendance", requireRole("Admin"), (req, res) => {

    const raw = parseFloat(req.body.default_hours_attended);
    const hours = isNaN(raw) ? 2 : Math.max(0, Math.min(12, raw));

    db.run(
        "UPDATE schools SET default_hours_attended=? WHERE id=?",
        [hours, req.schoolId],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/settings");
        }
    );

});

/* ==========================================
   UPDATE RECEIPT NUMBER FORMAT (Admin only)
========================================== */
router.post("/receipt-no", requireRole("Admin"), (req, res) => {

    const prefix = (req.body.receipt_no_prefix || "RCPT").trim() || "RCPT";
    const format = ["sequential", "yearly_reset", "yearly_continuous"].includes(req.body.receipt_no_format)
        ? req.body.receipt_no_format
        : "sequential";
    const digitsRaw = parseInt(req.body.receipt_no_digits);
    const digits = isNaN(digitsRaw) ? 4 : Math.max(1, Math.min(8, digitsRaw));

    db.run(
        "UPDATE schools SET receipt_no_prefix=?, receipt_no_format=?, receipt_no_digits=? WHERE id=?",
        [prefix, format, digits, req.schoolId],
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

/* ==========================================
   LANGUAGE (Admin only)
========================================== */
router.post("/language", requireRole("Admin"), (req, res) => {

    const language = req.body.language === "kn" ? "kn" : "en";

    db.run("UPDATE schools SET language=? WHERE id=?", [language, req.schoolId], (err) => {
        if (err) return res.send(err.message);
        res.redirect("/settings");
    });

});

/* ==========================================
   ATTENDANCE / FEES IMPORT-EXPORT TOGGLES (Admin only)
========================================== */
router.post("/import-export-toggles", requireRole("Admin"), (req, res) => {

    const attendanceEnabled = req.body.attendance_import_export_enabled === "on" ? 1 : 0;
    const feesEnabled = req.body.fees_import_export_enabled === "on" ? 1 : 0;

    db.run(
        "UPDATE schools SET attendance_import_export_enabled=?, fees_import_export_enabled=? WHERE id=?",
        [attendanceEnabled, feesEnabled, req.schoolId],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/settings");
        }
    );

});

/* ==========================================
   CUSTOMIZE SCREEN TEXT (Admin only)
   Lets a school override any migrated label's wording, independent of
   which language is selected - see services/labels.js for how these
   combine with the language defaults.
========================================== */
router.get("/labels", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;

    Promise.all([
        getSchoolLanguage(schoolId),
        new Promise((resolve, reject) => {
            db.all("SELECT label_key, label_text FROM label_overrides WHERE school_id=?", [schoolId], (err, rows) => {
                if (err) return reject(err);
                const map = {};
                rows.forEach(r => { map[r.label_key] = r.label_text; });
                resolve(map);
            });
        })
    ]).then(([language, overrides]) => {

        const { DEFAULTS } = require("../services/labels");
        const groups = allKeysGrouped();
        const groupList = Object.keys(groups).sort().map(group => ({
            group,
            keys: groups[group].map(key => ({
                key,
                defaultText: (DEFAULTS[language] && DEFAULTS[language][key]) || DEFAULTS.en[key] || key,
                overrideText: overrides[key] || ""
            }))
        }));

        res.render("settingsLabels", { groupList, language });

    }).catch(err => res.send(err.message));

});

router.post("/labels", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const { allKeysGrouped } = require("../services/labels");
    const groups = allKeysGrouped();
    const allKeys = Object.values(groups).flat();

    // One UPDATE/DELETE/INSERT per key kept simple and explicit rather
    // than a bulk multi-row upsert - this list is at most a few hundred
    // keys long, nowhere near enough rows for that simplicity to matter
    // for performance.
    const tasks = allKeys.map(key => {
        const value = (req.body[key] || "").trim();
        return new Promise((resolve, reject) => {
            if (!value) {
                // Blank input = "use the language default" - remove any
                // existing override rather than storing an empty string.
                db.run("DELETE FROM label_overrides WHERE school_id=? AND label_key=?", [schoolId, key], (err) => err ? reject(err) : resolve());
            } else {
                db.run(
                    `INSERT INTO label_overrides (school_id, label_key, label_text) VALUES (?,?,?)
                     ON CONFLICT(school_id, label_key) DO UPDATE SET label_text=excluded.label_text`,
                    [schoolId, key, value],
                    (err) => err ? reject(err) : resolve()
                );
            }
        });
    });

    Promise.all(tasks)
        .then(() => res.redirect("/settings/labels"))
        .catch(err => res.send(err.message));

});

module.exports = router;
