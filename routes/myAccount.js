/* ===========================================
   MY ACCOUNT - any logged-in user changes their OWN login details.

   - Everyone: name + password.
   - SuperAdmin only: login email too (school users keep the email their
     Admin/Super Admin set, so school logins don't drift from the school's
     naming pattern; their Admin can still change it from Users).
   - The CURRENT password is always required before anything is saved, so
     a screen left logged in can't be used to take over the account.
   - Blocked while a Super Admin is "viewing as Admin" (impersonating):
     the session's userId is still the Super Admin's, so editing "my
     account" there would be confusing - exit impersonation first.
   - View-only demo logins never reach the POST: middleware/readOnly.js
     refuses every write not on its allow-list.
=========================================== */
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { logChange } = require("../services/auditLog");

const MIN_PASSWORD = 6;

const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

router.use(requireLogin);

function render(res, user, { error = null, saved = false, impersonating = false } = {}) {
    res.render("auth/myAccount", {
        user, error, saved, impersonating,
        isSuperAdmin: user && user.role === "SuperAdmin",
        minPassword: MIN_PASSWORD
    });
}

async function loadMe(req) {
    return dbGet("SELECT id, school_id, name, email, role, password_hash FROM users WHERE id=?", [req.session.userId]);
}

router.get("/", async (req, res) => {
    try {
        const me = await loadMe(req);
        if (!me) return res.redirect("/logout");
        render(res, me, { saved: req.query.saved === "1", impersonating: !!req.session.superAdminOriginal });
    } catch (e) {
        res.send(e.message);
    }
});

router.post("/", async (req, res) => {
    try {
        const me = await loadMe(req);
        if (!me) return res.redirect("/logout");

        if (req.session.superAdminOriginal) {
            return render(res, me, { impersonating: true, error: "You're viewing a school as Admin - exit that first, then change your account." });
        }

        const name = (req.body.name || "").trim();
        const newPassword = req.body.new_password || "";
        const confirmPassword = req.body.confirm_password || "";
        const currentPassword = req.body.current_password || "";
        const isSuperAdmin = me.role === "SuperAdmin";
        const email = isSuperAdmin ? (req.body.email || "").trim() : me.email;

        // Re-show what they typed (not the stored values) on any error.
        const typed = { ...me, name, email };

        if (!bcrypt.compareSync(currentPassword, me.password_hash)) {
            return render(res, typed, { error: "Your current password is incorrect - nothing was changed." });
        }
        if (!name) return render(res, typed, { error: "Name can't be empty." });
        if (isSuperAdmin && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return render(res, typed, { error: "Please enter a valid email address." });
        }
        if (newPassword || confirmPassword) {
            if (newPassword.length < MIN_PASSWORD) return render(res, typed, { error: `New password must be at least ${MIN_PASSWORD} characters.` });
            if (newPassword !== confirmPassword) return render(res, typed, { error: "New password and confirmation don't match." });
        }

        const emailChanged = isSuperAdmin && email !== me.email;
        if (emailChanged) {
            // Login looks accounts up by email; a clash with ANY other
            // account would merge them on the login screen, so refuse it.
            const clash = await dbGet("SELECT id FROM users WHERE LOWER(email)=LOWER(?) AND id != ?", [email, me.id]);
            if (clash) return render(res, typed, { error: "That email is already used by another account." });
        }

        const sets = ["name=?"], params = [name];
        if (emailChanged) { sets.push("email=?"); params.push(email); }
        if (newPassword) { sets.push("password_hash=?"); params.push(bcrypt.hashSync(newPassword, 10)); }
        params.push(me.id);
        await dbRun(`UPDATE users SET ${sets.join(", ")} WHERE id=?`, params);

        req.session.name = name;

        const changed = [];
        if (name !== me.name) changed.push("name");
        if (emailChanged) changed.push(`email (${me.email} -> ${email})`);
        if (newPassword) changed.push("password");
        if (changed.length) {
            logChange({
                schoolId: me.school_id, branchId: null, req,
                entityType: "User", entityName: `${name} (${email})`, action: "Updated",
                details: `Own account (My Account): ${changed.join(", ")}`
            });
        }

        res.redirect("/my-account?saved=1");
    } catch (e) {
        res.send(e.message);
    }
});

module.exports = router;
