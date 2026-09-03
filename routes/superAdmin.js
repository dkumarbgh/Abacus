const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");
const { requireLogin, requireRole } = require("../middleware/auth");

// Mirrors the same default used in config/database.js - duplicated here
// (rather than importing it) because config/database.js exports the open
// Database handle itself, not its path, and changing that export shape
// would ripple through every other file that does
// `const db = require("../config/database")` expecting a Database, not a
// wrapper object.
const DB_PATH = process.env.DB_PATH || "./school.db";

// Where safety copies of the live DB are kept, both the ones an Admin
// downloads manually and the automatic "just before a restore" ones. *.db
// is already gitignored, so nothing here ends up in version control.
const BACKUPS_DIR = path.join(__dirname, "..", "backups");
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Restore uploads stay in memory (never written to public/) until they've
// been validated - same pattern as the student-import spreadsheet upload.
const uploadBackup = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB - generous headroom for a growing multi-school DB
});

// Every route here requires the SuperAdmin role - a login that isn't tied
// to managing just one school, unlike the regular per-school Admin role.
// See scripts/create-super-admin.js for how to create one.
router.use(requireLogin, requireRole("SuperAdmin"));

/* ===========================================
   CREATE A NEW SCHOOL (+ its first Admin user)
   Schools used to be self-service (anyone could hit /register-school with
   no login at all) - that's now closed off, and creating a school is a
   SuperAdmin-only action, same as everything else in this file.
=========================================== */
router.get("/schools/new", (req, res) => {
    res.render("superAdmin/newSchool", { error: null, form: {} });
});

router.post("/schools/new", (req, res) => {

    const { school_name, school_address, school_phone, school_email,
            admin_name, admin_email, admin_password } = req.body;

    if (!school_name || !admin_name || !admin_email || !admin_password) {
        return res.render("superAdmin/newSchool", { error: "Please fill in all required fields.", form: req.body });
    }

    db.run(
        `INSERT INTO schools (name, address, phone, email) VALUES (?,?,?,?)`,
        [school_name, school_address, school_phone, school_email],
        function (err) {

            if (err) return res.render("superAdmin/newSchool", { error: err.message, form: req.body });

            const schoolId = this.lastID;
            const passwordHash = bcrypt.hashSync(admin_password, 10);

            db.run(
                `INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)`,
                [schoolId, admin_name, admin_email, passwordHash, "Admin"],
                function (err2) {

                    if (err2) {
                        const message = err2.message.includes("UNIQUE")
                            ? "That admin email is already registered to another school."
                            : err2.message;
                        // The school row was already inserted above - clean it
                        // back up so a failed admin-creation doesn't leave an
                        // orphaned, user-less school behind.
                        return db.run("DELETE FROM schools WHERE id=?", [schoolId], () => {
                            res.render("superAdmin/newSchool", { error: message, form: req.body });
                        });
                    }

                    // Unlike the old self-service flow, this does NOT log the
                    // SuperAdmin into the new school - their own session is
                    // left untouched. They land on the new school's detail
                    // page and can use "Login As This School" from there if
                    // they need to see it as the Admin would.
                    res.redirect(`/super-admin/schools/${schoolId}`);

                }
            );

        }
    );

});


/* ===========================================
   DASHBOARD - every registered school, with user/student counts
=========================================== */
router.get("/", (req, res) => {

    db.all(`
        SELECT
            schools.*,
            (SELECT COUNT(*) FROM users WHERE users.school_id = schools.id) AS user_count,
            (SELECT COUNT(*) FROM students WHERE students.school_id = schools.id) AS student_count
        FROM schools
        ORDER BY schools.created_at DESC
    `, (err, schools) => {

        if (err) return res.send(err.message);

        res.render("superAdmin/dashboard", { schools });

    });

});


/* ===========================================
   ONE SCHOOL - its details + its users
=========================================== */
router.get("/schools/:id", (req, res) => {

    db.get("SELECT * FROM schools WHERE id=?", [req.params.id], (err, school) => {

        if (err) return res.send(err.message);
        if (!school) return res.send("School not found");

        db.all(
            "SELECT id, name, email, role, created_at FROM users WHERE school_id=? ORDER BY name",
            [req.params.id],
            (err2, users) => {

                if (err2) return res.send(err2.message);

                res.render("superAdmin/schoolDetail", { school, users, error: null });

            }
        );

    });

});


/* ===========================================
   DELETE SCHOOL (SuperAdmin only) - irreversible, wipes every table
   scoped to this school (students, fees, attendance, exams, users, etc).
   Two steps: a confirmation page showing exactly what will be deleted,
   then the actual delete which requires typing the school's name to
   proceed. An automatic full-database safety snapshot is taken first
   (same backups/ folder as Backup & Restore), so even this is
   recoverable via a restore if it turns out to be a mistake.
=========================================== */

// Every school-scoped table EXCEPT users (handled separately below, since
// a SuperAdmin's own login can have a placeholder school_id pointing at
// any school - deleting that school must never delete their account) and
// certificate_fields (linked via template_id, not school_id directly -
// handled via a subquery on certificate_templates instead).
const SCHOOL_SCOPED_TABLES = [
    { table: "students", label: "Students" },
    { table: "classes", label: "Classes" },
    { table: "teachers", label: "Teachers" },
    { table: "subjects", label: "Subjects" },
    { table: "teacher_subjects", label: "Subject Assignments" },
    { table: "timetable", label: "Timetable Entries" },
    { table: "attendance", label: "Attendance Records" },
    { table: "face_encodings", label: "Face-Recognition Enrollments" },
    { table: "exams", label: "Exams" },
    { table: "exam_results", label: "Exam Results" },
    { table: "practice_sheets", label: "Practice Sheets" },
    { table: "test_papers_generated", label: "Generated Test Papers" },
    { table: "fee_types", label: "Fee Types" },
    { table: "fee_categories", label: "Fee Categories" },
    { table: "fee_structure", label: "Fee Structure Items" },
    { table: "fee_payments", label: "Fee Payments" },
    { table: "fee_discounts", label: "Fee Discounts" },
    { table: "lookup_items", label: "Batches / Levels / Branches / Courses" },
    { table: "field_settings", label: "Custom Field Settings" },
    { table: "student_schedule", label: "Weekly Attendance Schedules" },
    { table: "level_history", label: "Level Promotion History" },
    { table: "certificate_templates", label: "Certificate Templates" },
    { table: "certificates_issued", label: "Certificates Issued" },
    { table: "referrals", label: "Referral Leads" },
    { table: "message_logs", label: "WhatsApp/Email Message Logs" }
];

function dbGetP(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbRunP(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}

router.get("/schools/:id/delete-confirm", async (req, res) => {

    try {
        const school = await dbGetP("SELECT * FROM schools WHERE id=?", [req.params.id]);
        if (!school) return res.send("School not found");

        const counts = [];
        for (const t of SCHOOL_SCOPED_TABLES) {
            const row = await dbGetP(`SELECT COUNT(*) c FROM ${t.table} WHERE school_id=?`, [school.id]);
            if (row.c > 0) counts.push({ label: t.label, count: row.c });
        }
        const userRow = await dbGetP("SELECT COUNT(*) c FROM users WHERE school_id=? AND role != 'SuperAdmin'", [school.id]);
        if (userRow.c > 0) counts.push({ label: "Users (Admins/Teachers/Accountants)", count: userRow.c });

        res.render("superAdmin/deleteSchoolConfirm", { school, counts, error: null });

    } catch (e) {
        res.send(e.message);
    }

});

router.post("/schools/:id/delete", async (req, res) => {

    try {
        const school = await dbGetP("SELECT * FROM schools WHERE id=?", [req.params.id]);
        if (!school) return res.send("School not found");

        if ((req.body.confirm_name || "").trim() !== school.name) {
            const counts = [];
            for (const t of SCHOOL_SCOPED_TABLES) {
                const row = await dbGetP(`SELECT COUNT(*) c FROM ${t.table} WHERE school_id=?`, [school.id]);
                if (row.c > 0) counts.push({ label: t.label, count: row.c });
            }
            return res.render("superAdmin/deleteSchoolConfirm", {
                school, counts,
                error: `The name you typed doesn't match "${school.name}" exactly - nothing was deleted.`
            });
        }

        // Safety snapshot of the WHOLE database before wiping anything -
        // same idea as the pre-restore snapshot in Backup & Restore, so a
        // deleted school can still be recovered from there if needed.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const safetyPath = path.join(BACKUPS_DIR, `pre-delete-school-${school.id}-${stamp}.db`);
        await dbRunP(`VACUUM INTO ?`, [safetyPath]);

        await dbRunP("BEGIN TRANSACTION");
        try {
            // certificate_fields links via template_id, not school_id - clear
            // it first via a subquery, before its parent template rows go.
            await dbRunP(
                "DELETE FROM certificate_fields WHERE template_id IN (SELECT id FROM certificate_templates WHERE school_id=?)",
                [school.id]
            );
            for (const t of SCHOOL_SCOPED_TABLES) {
                await dbRunP(`DELETE FROM ${t.table} WHERE school_id=?`, [school.id]);
            }
            // Never delete SuperAdmin accounts - their school_id is just a
            // placeholder and may happen to point at the school being deleted.
            await dbRunP("DELETE FROM users WHERE school_id=? AND role != 'SuperAdmin'", [school.id]);
            await dbRunP("DELETE FROM schools WHERE id=?", [school.id]);
            await dbRunP("COMMIT");
        } catch (innerErr) {
            await dbRunP("ROLLBACK");
            throw innerErr;
        }

        res.send(`
            <html><body style="font-family: sans-serif; max-width: 600px; margin: 60px auto; line-height: 1.6;">
                <h2>✅ School deleted</h2>
                <p><strong>${school.name}</strong> and all of its data has been permanently removed.</p>
                <p>A full safety snapshot of the database from just before this delete was saved as
                   <code>${path.basename(safetyPath)}</code> under Backup &amp; Restore, in case this needs to be undone.</p>
                <p><a href="/super-admin">Back to All Schools</a></p>
            </body></html>
        `);

    } catch (e) {
        res.send("Delete failed: " + e.message + ". Check the safety backup in Backup &amp; Restore if the database looks inconsistent.");
    }

});

/* ===========================================
   EDIT SCHOOL DETAILS
=========================================== */
router.get("/schools/:id/edit", (req, res) => {

    db.get("SELECT * FROM schools WHERE id=?", [req.params.id], (err, school) => {

        if (err) return res.send(err.message);
        if (!school) return res.send("School not found");

        res.render("superAdmin/editSchool", { school, error: null });

    });

});

router.post("/schools/:id/edit", (req, res) => {

    const { name, address, phone, email, simple_fee_mode, referral_reward_type, referral_reward_value } = req.body;

    db.run(
        "UPDATE schools SET name=?, address=?, phone=?, email=?, simple_fee_mode=?, referral_reward_type=?, referral_reward_value=? WHERE id=?",
        [name, address, phone, email, simple_fee_mode === "on" ? 1 : 0,
         referral_reward_type || "FLAT", parseFloat(referral_reward_value) || 0, req.params.id],
        (err) => {

            if (err) return res.send(err.message);

            res.redirect(`/super-admin/schools/${req.params.id}`);

        }
    );

});


/* ===========================================
   ADD A USER TO A SPECIFIC SCHOOL
=========================================== */
router.post("/schools/:id/users/add", (req, res) => {

    const { name, email, password, role } = req.body;
    const passwordHash = bcrypt.hashSync(password, 10);
    const schoolId = req.params.id;

    db.run(
        `INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)`,
        [schoolId, name, email, passwordHash, role || "Teacher"],
        (err) => {

            if (err) {
                const message = err.message.includes("UNIQUE")
                    ? "That email is already registered to a user."
                    : err.message;

                return db.get("SELECT * FROM schools WHERE id=?", [schoolId], (err2, school) => {
                    db.all("SELECT id, name, email, role, created_at FROM users WHERE school_id=? ORDER BY name", [schoolId], (err3, users) => {
                        res.render("superAdmin/schoolDetail", { school, users: users || [], error: message });
                    });
                });
            }

            res.redirect(`/super-admin/schools/${schoolId}`);

        }
    );

});


/* ===========================================
   EDIT / RESET PASSWORD FOR ANY USER IN ANY SCHOOL
=========================================== */
router.get("/schools/:id/users/edit/:userId", (req, res) => {

    db.get(
        "SELECT id, name, email, role FROM users WHERE id=? AND school_id=?",
        [req.params.userId, req.params.id],
        (err, user) => {

            if (err) return res.send(err.message);
            if (!user) return res.send("User not found");

            res.render("superAdmin/editUser", { user, schoolId: req.params.id, error: null });

        }
    );

});

router.post("/schools/:id/users/edit/:userId", async (req, res) => {

    const { name, email, role, password } = req.body;
    const schoolId = req.params.id;
    const targetId = req.params.userId;

    // Same "don't remove the last Admin" guard as the per-school version.
    if (role !== "Admin") {
        const adminCount = await new Promise((resolve, reject) => {
            db.get(
                "SELECT COUNT(*) AS n FROM users WHERE school_id=? AND role='Admin' AND id != ?",
                [schoolId, targetId],
                (err, row) => err ? reject(err) : resolve(row.n)
            );
        });
        const current = await new Promise((resolve, reject) => {
            db.get("SELECT role FROM users WHERE id=? AND school_id=?", [targetId, schoolId], (err, row) => err ? reject(err) : resolve(row && row.role));
        });
        if (current === "Admin" && adminCount === 0) {
            return res.render("superAdmin/editUser", {
                user: { id: targetId, name, email, role: "Admin" },
                schoolId,
                error: "Can't change this user's role - they're the only Admin left for this school."
            });
        }
    }

    const setClauses = ["name=?", "email=?", "role=?"];
    const params = [name, email, role];

    if (password && password.trim()) {
        setClauses.push("password_hash=?");
        params.push(bcrypt.hashSync(password, 10));
    }

    params.push(targetId, schoolId);

    db.run(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id=? AND school_id=?`,
        params,
        (err) => {

            if (err) {
                const message = err.message.includes("UNIQUE")
                    ? "That email is already registered to another user."
                    : err.message;
                return res.render("superAdmin/editUser", { user: { id: targetId, name, email, role }, schoolId, error: message });
            }

            res.redirect(`/super-admin/schools/${schoolId}`);

        }
    );

});


/* ===========================================
   DELETE A USER FROM A SCHOOL
=========================================== */
router.get("/schools/:id/users/delete/:userId", async (req, res) => {

    const schoolId = req.params.id;
    const targetId = req.params.userId;

    const target = await new Promise((resolve, reject) => {
        db.get("SELECT role FROM users WHERE id=? AND school_id=?", [targetId, schoolId], (err, row) => err ? reject(err) : resolve(row));
    });

    if (target && target.role === "Admin") {
        const adminCount = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) AS n FROM users WHERE school_id=? AND role='Admin' AND id != ?", [schoolId, targetId], (err, row) => err ? reject(err) : resolve(row.n));
        });
        if (adminCount === 0) {
            return res.send("Can't delete this user - they're the only Admin left for this school. <a href='/super-admin/schools/" + schoolId + "'>Back</a>");
        }
    }

    db.run("DELETE FROM users WHERE id=? AND school_id=?", [targetId, schoolId], (err) => {

        if (err) return res.send(err.message);

        res.redirect(`/super-admin/schools/${schoolId}`);

    });

});

/* ===========================================
   LOGIN AS THIS SCHOOL - full view into their actual app (students, fees,
   attendance, everything), using the same session-based auth as any other
   Admin. The Super Admin's own identity is stashed in
   session.superAdminOriginal so "Exit" can restore it - never a one-way
   trip. Every screen shows a persistent banner (see partials/navbar) with
   an Exit link back to /super-admin the whole time this is active.
=========================================== */
router.get("/schools/:id/login-as", (req, res) => {

    db.get("SELECT * FROM schools WHERE id=?", [req.params.id], (err, school) => {

        if (err) return res.send(err.message);
        if (!school) return res.send("School not found");

        // Stash the real Super Admin identity so it can be restored later.
        // If already impersonating another school, don't overwrite the
        // ORIGINAL stashed identity with the current (impersonated) one -
        // just switch which school is being viewed.
        if (!req.session.superAdminOriginal) {
            req.session.superAdminOriginal = {
                userId: req.session.userId,
                name: req.session.name,
                schoolId: req.session.schoolId
            };
        }

        req.session.schoolId = school.id;
        req.session.role = "Admin";
        req.session.name = `${req.session.superAdminOriginal.name} (viewing as Admin)`;
        req.session.schoolName = school.name;

        res.redirect("/");

    });

});

/* ===========================================
   REFERRAL PROGRAMME (Super Admin only)
   Every referral across every school, with the ability to apply the
   reward as a real discount against the referring student's largest
   outstanding fee item (same discount mechanism used everywhere else in
   the app) - not automatic, since a human should confirm before it
   actually changes what someone owes.
=========================================== */
router.get("/referrals", (req, res) => {

    db.all(`
        SELECT
            referrals.*,
            schools.name AS school_name,
            COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
            ref_to.name AS referred_student_name
        FROM referrals
        JOIN schools ON referrals.school_id = schools.id
        LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
        LEFT JOIN students ref_to ON referrals.referred_student_id = ref_to.id
        ORDER BY referrals.created_at DESC
    `, (err, referrals) => {

        if (err) return res.send(err.message);

        res.render("superAdmin/referrals", { referrals, error: null });

    });

});

router.post("/referrals/:id/apply-reward", async (req, res) => {

    const { applyReferralReward } = require("../services/referralReward");
    const result = await applyReferralReward(req.params.id, req.session.userId);

    if (result.ok) {
        return res.redirect("/super-admin/referrals");
    }

    db.all(`
        SELECT referrals.*, schools.name AS school_name,
               COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
               ref_to.name AS referred_student_name
        FROM referrals
        JOIN schools ON referrals.school_id = schools.id
        LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
        LEFT JOIN students ref_to ON referrals.referred_student_id = ref_to.id
        ORDER BY referrals.created_at DESC
    `, (err3, referrals) => {
        res.render("superAdmin/referrals", { referrals, error: result.error });
    });

});

/* ===========================================
   BACKUP & RESTORE (SuperAdmin only)
   Works on the whole physical database file, not one school at a time -
   this app is multi-tenant with every school in a single school.db, so a
   "restore" here replaces every school's data, not just one. That's why
   it's SuperAdmin-only rather than living on the per-school Settings page
   (see routes/settings.js /backup for the per-school-Admin-facing
   download, which is a lighter-weight convenience feature, not this
   safety-critical whole-database version).
=========================================== */
router.get("/backup-restore", (req, res) => {

    fs.readdir(BACKUPS_DIR, (err, files) => {

        if (err) return res.send(err.message);

        const backups = files
            .filter(f => f.endsWith(".db"))
            .map(f => {
                const stat = fs.statSync(path.join(BACKUPS_DIR, f));
                return { name: f, sizeMB: (stat.size / (1024 * 1024)).toFixed(1), mtime: stat.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);

        res.render("superAdmin/backupRestore", { backups, error: null, success: null });

    });

});

// Snapshots the LIVE database right now, saves it into backups/ (so it
// shows up in the list below too), and streams it to the browser. Uses
// VACUUM INTO rather than sending school.db directly, so the download is
// always a clean, consistent copy - never a half-written row from
// something else saving at the same moment.
router.get("/backup-restore/download-now", (req, res) => {

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `full-backup-${stamp}.db`;
    const filePath = path.join(BACKUPS_DIR, filename);

    db.run(`VACUUM INTO ?`, [filePath], (err) => {

        if (err) return res.send("Backup failed: " + err.message);

        res.download(filePath, filename, (downloadErr) => {
            if (downloadErr) console.error("Backup download error:", downloadErr.message);
            // Deliberately NOT deleting filePath afterward, unlike the
            // per-school /settings/backup route - this copy stays in
            // backups/ as part of the recoverable history shown below.
        });

    });

});

// Download a PREVIOUSLY taken backup from the list (either a manual
// "Download Now" one, or an automatic pre-restore safety copy).
router.get("/backup-restore/download/:filename", (req, res) => {

    // path.basename strips any directory traversal (e.g. "../../etc/passwd")
    // from the filename before it ever touches the filesystem.
    const filename = path.basename(req.params.filename);
    const filePath = path.join(BACKUPS_DIR, filename);

    if (!filename.endsWith(".db") || !fs.existsSync(filePath)) {
        return res.status(404).send("Backup not found.");
    }

    res.download(filePath, filename);

});

// Removes an old backup file to keep the list tidy - doesn't touch the
// live database, just a saved copy on disk.
router.post("/backup-restore/delete/:filename", (req, res) => {

    const filename = path.basename(req.params.filename);
    const filePath = path.join(BACKUPS_DIR, filename);

    fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") console.error("Backup delete error:", err.message);
        res.redirect("/super-admin/backup-restore");
    });

});

// Restores the ENTIRE live database from an uploaded backup file - every
// school, every user, every student, replaced wholesale. Guarded by:
//   1) SuperAdmin-only (route-level, above)
//   2) a typed "RESTORE" confirmation, checked server-side (never trust a
//      disabled-button-until-typed client-side check alone)
//   3) validating the uploaded file is actually a SQLite DB with the
//      table this app expects, before it's allowed anywhere near the
//      live file
//   4) an automatic safety snapshot of the CURRENT database taken right
//      before the swap, so a bad restore is itself recoverable
// Finishes by exiting the process on purpose - the live `db` handle
// (from config/database.js) already has the OLD file open, and simply
// overwriting the file on disk doesn't make that existing connection see
// the new content. A full process restart is required to reopen DB_PATH
// fresh. Render (and any process manager like PM2) automatically
// restarts a web service that exits, so this is safe there - but if
// you're running this a different way, you'll need to restart the app
// yourself after seeing the success message.
router.post("/backup-restore/upload", uploadBackup.single("file"), async (req, res) => {

    const renderError = (error) => {
        fs.readdir(BACKUPS_DIR, (err, files) => {
            const backups = (files || [])
                .filter(f => f.endsWith(".db"))
                .map(f => {
                    const stat = fs.statSync(path.join(BACKUPS_DIR, f));
                    return { name: f, sizeMB: (stat.size / (1024 * 1024)).toFixed(1), mtime: stat.mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
            res.render("superAdmin/backupRestore", { backups, error, success: null });
        });
    };

    if (!req.file) return renderError("Please choose a backup file to restore.");
    if ((req.body.confirm_text || "").trim() !== "RESTORE") {
        return renderError('Type RESTORE (all caps) in the confirmation box to proceed - this is a destructive action affecting every school.');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uploadedPath = path.join(os.tmpdir(), `restore-upload-${stamp}.db`);

    try {
        fs.writeFileSync(uploadedPath, req.file.buffer);

        // Validate: open the UPLOADED file (never the live one) read-only
        // and confirm it actually looks like a SimpleSchool database
        // before it's allowed to replace anything.
        const isValid = await new Promise((resolve) => {
            const testDb = new sqlite3.Database(uploadedPath, sqlite3.OPEN_READONLY, (openErr) => {
                if (openErr) return resolve(false);
                testDb.get(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schools','students','users')",
                    [],
                    (err, row) => {
                        testDb.close();
                        resolve(!err && !!row);
                    }
                );
            });
        });

        if (!isValid) {
            fs.unlink(uploadedPath, () => {});
            return renderError("That file doesn't look like a valid SimpleSchool backup (couldn't find the expected tables). Nothing was changed.");
        }

        // Safety snapshot of the CURRENT live data before it's overwritten.
        const preRestorePath = path.join(BACKUPS_DIR, `pre-restore-${stamp}.db`);
        await new Promise((resolve, reject) => {
            db.run(`VACUUM INTO ?`, [preRestorePath], (err) => err ? reject(err) : resolve());
        });

        // Also keep a copy of the restored file itself in backups/, so
        // it's visible in the list and re-downloadable later.
        const restoredCopyPath = path.join(BACKUPS_DIR, `restored-${stamp}.db`);
        fs.copyFileSync(uploadedPath, restoredCopyPath);

        // The actual swap: replace the live file with the validated upload.
        fs.copyFileSync(uploadedPath, DB_PATH);
        fs.unlink(uploadedPath, () => {});

        res.send(`
            <html><body style="font-family: sans-serif; max-width: 600px; margin: 60px auto; line-height: 1.6;">
                <h2>✅ Restore complete</h2>
                <p>The database has been replaced with the uploaded backup. A safety copy of what was there
                   just before (<code>${path.basename(preRestorePath)}</code>) was saved to the backups folder in case anything looks wrong.</p>
                <p>The app is restarting now to load the restored data - this takes about 10-30 seconds.
                   Everyone, including you, will need to log in again afterward (sessions don't survive a restart).</p>
                <p><a href="/login">Go to login</a> (wait a few seconds first, then refresh if it doesn't load)</p>
            </body></html>
        `);

        // Give the response time to actually reach the browser before the
        // process exits.
        setTimeout(() => process.exit(0), 1000);

    } catch (e) {
        fs.unlink(uploadedPath, () => {});
        renderError("Restore failed: " + e.message + ". The live database was not touched.");
    }

});

module.exports = router;
