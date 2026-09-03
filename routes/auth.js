const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");

/* ===========================================
   LOGIN / LOGOUT
=========================================== */

// Public self-service registration used to live here - schools are now
// only created by a Super Admin (see routes/superAdmin.js /schools/new).
// This just catches anyone with the old link/bookmark and sends them
// somewhere useful instead of a bare 404.
router.get("/register-school", (req, res) => {
    res.redirect("/login");
});

router.get("/login", (req, res) => {
    const error = req.session.loginError || null;
    const email = req.session.loginEmail || "";
    delete req.session.loginError;
    delete req.session.loginEmail;
    res.render("auth/login", { error, email });
});

router.post("/login", (req, res) => {

    const { email, password } = req.body;

    // On failure, redirect back to a GET (rather than rendering the page
    // directly as the POST response) so refreshing the result page doesn't
    // trigger the browser's "Confirm Form Resubmission" warning, and the
    // email they typed comes back with them instead of being wiped.
    const failWith = (message) => {
        req.session.loginError = message;
        req.session.loginEmail = email || "";
        res.redirect("/login");
    };

    const startSessionFor = (user) => {
        req.session.userId = user.id;
        req.session.schoolId = user.school_id;
        req.session.role = user.role;
        req.session.name = user.name;
        req.session.schoolName = user.school_name;

        if (user.role === "SuperAdmin") {
            return res.redirect("/super-admin");
        }

        res.redirect("/");
    };

    // The same email can now have a separate account at more than one
    // school (e.g. Teacher at School A, Accountant at School B) - fetch
    // every account under this email, then check the password against
    // each one individually, since different schools' admins may have set
    // different passwords for what's otherwise "the same person".
    //
    // LEFT JOIN (not INNER) on purpose: a SuperAdmin's school_id is just
    // inert placeholder data (see scripts/create-super-admin.js), and may
    // not point at a real row - especially on a brand new deployment
    // where no school has been registered yet. An INNER JOIN would
    // silently exclude that user from this query entirely, making login
    // fail with "Invalid email or password" even though the credentials
    // are completely correct.
    db.all(
        `SELECT users.*, schools.name AS school_name
         FROM users LEFT JOIN schools ON users.school_id = schools.id
         WHERE users.email = ?`,
        [email],
        (err, candidates) => {

            if (err) return failWith(err.message);

            const matches = (candidates || []).filter(u => bcrypt.compareSync(password || "", u.password_hash));

            if (matches.length === 0) return failWith("Invalid email or password.");

            if (matches.length === 1) return startSessionFor(matches[0]);

            // More than one account uses this exact email+password combo -
            // let them pick which one, rather than guessing. Only the
            // minimal fields needed to render the picker (and re-verify
            // the choice below) go into the session - never password
            // hashes, and the account isn't actually logged into yet.
            req.session.pendingAccounts = matches.map(u => ({
                id: u.id, name: u.name, role: u.role, school_id: u.school_id, school_name: u.school_name
            }));
            res.redirect("/login/choose-account");

        }
    );

});


router.get("/login/choose-account", (req, res) => {

    const accounts = req.session.pendingAccounts;
    if (!accounts || accounts.length === 0) return res.redirect("/login");

    res.render("auth/chooseAccount", { accounts, error: null });

});

router.post("/login/choose-account", (req, res) => {

    const accounts = req.session.pendingAccounts;
    if (!accounts || accounts.length === 0) return res.redirect("/login");

    // Only allow picking one of the accounts that was actually offered in
    // THIS login attempt (i.e. one whose password already matched) -
    // never an arbitrary user id typed/tampered into the request.
    const chosen = accounts.find(a => String(a.id) === String(req.body.account_id));
    if (!chosen) return res.render("auth/chooseAccount", { accounts, error: "Please pick one of the accounts shown." });

    delete req.session.pendingAccounts;

    req.session.userId = chosen.id;
    req.session.schoolId = chosen.school_id;
    req.session.role = chosen.role;
    req.session.name = chosen.name;
    req.session.schoolName = chosen.school_name;

    if (chosen.role === "SuperAdmin") {
        return res.redirect("/super-admin");
    }

    res.redirect("/");

});

/* ===========================================
   EXIT IMPERSONATION - restores a Super Admin's own identity after they
   used "Login As" on a school (see routes/superAdmin.js). Deliberately
   only requires being logged in (not the SuperAdmin role) - by definition
   the session's role is 'Admin' while impersonating, not 'SuperAdmin', so
   a stricter check here would make this its own dead end.
   session.superAdminOriginal only ever gets set by the login-as route, so
   this can't be used by anyone who wasn't actually impersonating.
=========================================== */
router.get("/exit-impersonation", requireLogin, (req, res) => {

    const original = req.session.superAdminOriginal;

    if (!original) return res.redirect("/");

    req.session.userId = original.userId;
    req.session.name = original.name;
    req.session.schoolId = original.schoolId;
    req.session.role = "SuperAdmin";
    req.session.schoolName = null;
    delete req.session.superAdminOriginal;

    res.redirect("/super-admin");

});


router.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});


/* ===========================================
   USER MANAGEMENT (Admin only) - add teachers/accountants
   to the SAME school as the logged-in admin
=========================================== */
router.get("/users", requireLogin, requireRole("Admin"), (req, res) => {

    db.all(
        "SELECT id, name, email, role, created_at FROM users WHERE school_id=? ORDER BY name",
        [req.schoolId],
        (err, users) => {

            if (err) return res.send(err.message);

            res.render("auth/users", { users, error: null });

        }
    );

});

router.post("/users/add", requireLogin, requireRole("Admin"), (req, res) => {

    const { name, email, password, role } = req.body;
    const passwordHash = bcrypt.hashSync(password, 10);

    db.run(
        `INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)`,
        [req.schoolId, name, email, passwordHash, role || "Teacher"],
        (err) => {

            if (err) {
                const message = err.message.includes("UNIQUE")
                    ? "That email is already registered to a user."
                    : err.message;

                return db.all(
                    "SELECT id, name, email, role, created_at FROM users WHERE school_id=? ORDER BY name",
                    [req.schoolId],
                    (err2, users) => res.render("auth/users", { users: users || [], error: message })
                );
            }

            res.redirect("/users");

        }
    );

});

router.get("/users/delete/:id", requireLogin, requireRole("Admin"), (req, res) => {

    // Scope the delete to school_id too, so an admin can never delete a user
    // belonging to a different school even by guessing an id.
    db.run(
        "DELETE FROM users WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err) => {

            if (err) return res.send(err.message);

            res.redirect("/users");

        }
    );

});


/* ===========================================
   EDIT USER + CHANGE PASSWORD (Admin only)
   Scoped to the Admin's own school - they can only edit users that belong
   to the same school as them, same as every other user-management route.
=========================================== */
router.get("/users/edit/:id", requireLogin, requireRole("Admin"), (req, res) => {

    db.get(
        "SELECT id, name, email, role FROM users WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, user) => {

            if (err) return res.send(err.message);
            if (!user) return res.send("User not found");

            res.render("auth/editUser", { user, error: null });

        }
    );

});

router.post("/users/edit/:id", requireLogin, requireRole("Admin"), async (req, res) => {

    const { name, email, role, password } = req.body;
    const schoolId = req.schoolId;
    const targetId = req.params.id;

    // Guard against locking the school out entirely: if this edit would
    // remove the last remaining Admin (by downgrading their role), block it.
    if (role !== "Admin") {
        const adminCount = await new Promise((resolve, reject) => {
            db.get(
                "SELECT COUNT(*) AS n FROM users WHERE school_id=? AND role='Admin' AND id != ?",
                [schoolId, targetId],
                (err, row) => err ? reject(err) : resolve(row.n)
            );
        });
        const targetIsCurrentlyAdmin = await new Promise((resolve, reject) => {
            db.get("SELECT role FROM users WHERE id=? AND school_id=?", [targetId, schoolId], (err, row) => err ? reject(err) : resolve(row && row.role));
        });
        if (targetIsCurrentlyAdmin === "Admin" && adminCount === 0) {
            return db.get(
                "SELECT id, name, email, role FROM users WHERE id=? AND school_id=?",
                [targetId, schoolId],
                (err, user) => {
                    res.render("auth/editUser", {
                        user: user || { id: targetId, name, email, role },
                        error: "Can't change this user's role - they're the only Admin left for this school. Make someone else Admin first."
                    });
                }
            );
        }
    }

    const setClauses = ["name=?", "email=?", "role=?"];
    const params = [name, email, role];

    // Password is only updated if a new one was actually typed - leaving it
    // blank keeps the existing password unchanged.
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
                return db.get(
                    "SELECT id, name, email, role FROM users WHERE id=? AND school_id=?",
                    [targetId, schoolId],
                    (err2, user) => {
                        res.render("auth/editUser", { user: user || { id: targetId, name, email, role }, error: message });
                    }
                );
            }

            res.redirect("/users");

        }
    );

});

module.exports = router;
