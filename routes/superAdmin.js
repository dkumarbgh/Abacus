const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");

// Every route here requires the SuperAdmin role - a login that isn't tied
// to managing just one school, unlike the regular per-school Admin role.
// See scripts/create-super-admin.js for how to create one.
router.use(requireLogin, requireRole("SuperAdmin"));

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
            ref_by.name AS referring_student_name,
            ref_to.name AS referred_student_name
        FROM referrals
        JOIN schools ON referrals.school_id = schools.id
        JOIN students ref_by ON referrals.referring_student_id = ref_by.id
        JOIN students ref_to ON referrals.referred_student_id = ref_to.id
        ORDER BY referrals.created_at DESC
    `, (err, referrals) => {

        if (err) return res.send(err.message);

        res.render("superAdmin/referrals", { referrals, error: null });

    });

});

router.post("/referrals/:id/apply-reward", async (req, res) => {

    db.get("SELECT * FROM referrals WHERE id=?", [req.params.id], (err, referral) => {

        if (err) return res.send(err.message);
        if (!referral) return res.send("Referral not found");

        // Find the referring student's fee item with the largest remaining
        // due amount (class-wide or personalized, same rule used
        // everywhere else) - that's what the reward discount applies to.
        db.all(
            `SELECT fs.id, fs.amount
             FROM fee_structure fs, students s
             WHERE s.id = ? AND fs.school_id = ?
               AND ((fs.student_id IS NULL AND fs.class_id = s.class_id) OR fs.student_id = s.id)`,
            [referral.referring_student_id, referral.school_id],
            (err2, items) => {

                if (err2) return res.send(err2.message);

                if (!items.length) {
                    return db.all(`
                        SELECT referrals.*, schools.name AS school_name,
                               ref_by.name AS referring_student_name, ref_to.name AS referred_student_name
                        FROM referrals
                        JOIN schools ON referrals.school_id = schools.id
                        JOIN students ref_by ON referrals.referring_student_id = ref_by.id
                        JOIN students ref_to ON referrals.referred_student_id = ref_to.id
                        ORDER BY referrals.created_at DESC
                    `, (err3, referrals) => {
                        res.render("superAdmin/referrals", {
                            referrals,
                            error: `Can't apply this reward yet - the referring student has no fee item set up (class-wide or personal) to discount. Set one up first (Fee Structure, or their Total Fee), then try again.`
                        });
                    });
                }

                Promise.all(items.map(item => new Promise((resolve, reject) => {
                    db.all(
                        "SELECT SUM(amount_paid) AS paid FROM fee_payments WHERE fee_structure_id=?",
                        [item.id],
                        (e, rows) => e ? reject(e) : resolve({ ...item, paid: (rows[0] && rows[0].paid) || 0 })
                    );
                }))).then(withPaid => {

                    const target = withPaid.reduce((best, cur) => {
                        const curDue = cur.amount - cur.paid;
                        const bestDue = best ? (best.amount - best.paid) : -Infinity;
                        return curDue > bestDue ? cur : best;
                    }, null);

                    db.get(
                        "SELECT id FROM fee_discounts WHERE student_id=? AND fee_structure_id=?",
                        [referral.referring_student_id, target.id],
                        (err4, existingDiscount) => {

                            const saveDiscount = existingDiscount
                                ? (cb) => db.run(
                                    "UPDATE fee_discounts SET discount_type=?, discount_value=?, reason=? WHERE id=?",
                                    [referral.reward_type, referral.reward_value, "Referral reward", existingDiscount.id],
                                    cb
                                )
                                : (cb) => db.run(
                                    `INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id)
                                     VALUES (?,?,?,?,?,?)`,
                                    [referral.referring_student_id, target.id, referral.reward_type, referral.reward_value, "Referral reward", referral.school_id],
                                    cb
                                );

                            saveDiscount((err5) => {
                                if (err5) return res.send(err5.message);

                                db.run("UPDATE referrals SET reward_applied=1 WHERE id=?", [req.params.id], () => {
                                    res.redirect("/super-admin/referrals");
                                });

                            });

                        }
                    );

                });

            }
        );

    });

});

module.exports = router;
