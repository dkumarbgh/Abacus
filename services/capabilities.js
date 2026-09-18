const db = require("../config/database");

/**
 * Role-based module capabilities.
 *
 * Distinct from requireRole() (middleware/auth.js), which hard-gates a
 * handful of specific, security-sensitive actions to the literal "Admin"
 * or "SuperAdmin" role names (deleting a school, resetting someone's
 * password, etc.) - that stays exactly as it was and is NOT affected by
 * anything in this file.
 *
 * This is a SEPARATE, additive layer: which whole feature MODULES a role
 * can open at all (Students, Attendance, Fees, WhatsApp, ...). Before this
 * existed, every role except the handful of requireRole()-gated actions
 * above could reach every module - there was no way to say "Teachers
 * shouldn't see Fee Payments" short of editing code. A brand new custom
 * role (see createRole()) starts with NO capabilities granted (safest
 * default - a SuperAdmin must deliberately turn modules on for it), while
 * the four pre-existing roles (Admin/Teacher/Accountant/SuperAdmin) are
 * seeded with EVERY capability so existing installs see zero behavior
 * change until someone visits Roles & Capabilities and starts unchecking
 * boxes.
 */

const CAPABILITIES = [
    { key: "students",        label: "Students" },
    { key: "classes",         label: "Classes" },
    { key: "teachers",        label: "Teachers" },
    { key: "subjects",        label: "Subjects" },
    { key: "assignments",     label: "Assignments" },
    { key: "timetable",       label: "Timetable" },
    { key: "attendance",      label: "Attendance" },
    { key: "fees",            label: "Fees (Due/Pending Reports & Settings)" },
    { key: "fee_structure",   label: "Fee Structure" },
    { key: "fee_payments",    label: "Fee Payments" },
    { key: "student_fees",    label: "Student Fees" },
    { key: "exams",           label: "Exams" },
    { key: "practice_sheets", label: "Practice Sheets" },
    { key: "test_papers",     label: "Test Papers" },
    { key: "whatsapp",        label: "WhatsApp Messaging" },
    { key: "reports",         label: "Reports" },
    { key: "settings",        label: "Settings" },
    { key: "lists",           label: "Lists (Batches/Levels/Branches/Courses)" },
    { key: "certificates",    label: "Certificates" },
    { key: "level_promotion", label: "Level Promotion" },
    { key: "leads",           label: "Leads" }
];
const CAPABILITY_KEYS = CAPABILITIES.map(c => c.key);

// The four roles the app shipped with. Kept as system roles (can't be
// renamed or deleted) since a lot of code - login, the "last Admin" safety
// guards, the SuperAdmin gate - depends on these exact names continuing to
// mean what they've always meant. Anything ELSE (item 4's "add new Roles")
// is a genuinely new, capability-only role: it gets access to whatever
// modules it's granted here, but can never pass a requireRole("Admin") /
// requireRole("SuperAdmin") check, since those check the literal name.
const SYSTEM_ROLES = ["Admin", "Teacher", "Accountant", "SuperAdmin"];

function run(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}
function all(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function get(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

/** Creates the roles/role_capabilities/user_roles tables and seeds the four
 *  system roles (all capabilities granted, preserving current behavior) if
 *  they don't already exist. Safe to call on every boot. */
async function ensureRolesSeeded() {

    await run(`
        CREATE TABLE IF NOT EXISTS roles(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            is_system INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS role_capabilities(
            role_id INTEGER NOT NULL,
            capability_key TEXT NOT NULL,
            PRIMARY KEY (role_id, capability_key),
            FOREIGN KEY(role_id) REFERENCES roles(id)
        )
    `);

    // A user's PRIMARY role stays exactly as it's always been - the
    // users.role column, unchanged - so every existing login/last-Admin/
    // matrix code path is completely untouched. This table only holds
    // ADDITIONAL roles someone has been given on top of their primary one
    // (Deepak's "so user can play multiple Roles"), which only ever
    // affects capability checks, never the Admin-guard logic.
    await run(`
        CREATE TABLE IF NOT EXISTS user_roles(
            user_id INTEGER NOT NULL,
            role_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, role_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(role_id) REFERENCES roles(id)
        )
    `);

    for (const name of SYSTEM_ROLES) {
        await run(`INSERT OR IGNORE INTO roles (name, is_system) VALUES (?, 1)`, [name]);
    }

    // Grant every capability to every system role, but ONLY the very first
    // time each role is created (i.e. only if it has zero rows yet) - so
    // this never stomps on capabilities Deepak has since unchecked for
    // Teacher/Accountant on a later boot.
    const systemRoles = await all(`SELECT id, name FROM roles WHERE name IN (${SYSTEM_ROLES.map(() => "?").join(",")})`, SYSTEM_ROLES);
    for (const role of systemRoles) {
        const existing = await get(`SELECT COUNT(*) AS n FROM role_capabilities WHERE role_id=?`, [role.id]);
        if (existing.n === 0) {
            for (const key of CAPABILITY_KEYS) {
                await run(`INSERT OR IGNORE INTO role_capabilities (role_id, capability_key) VALUES (?, ?)`, [role.id, key]);
            }
        }
    }

}

/** All roles (system + custom), each with its granted capability keys. */
async function getAllRolesWithCapabilities() {
    const roles = await all(`SELECT id, name, is_system FROM roles ORDER BY is_system DESC, name`);
    const grants = await all(`SELECT role_id, capability_key FROM role_capabilities`);
    const byRole = {};
    grants.forEach(g => { (byRole[g.role_id] = byRole[g.role_id] || []).push(g.capability_key); });
    return roles.map(r => ({ ...r, capabilities: byRole[r.id] || [] }));
}

/** Just the role names, for populating role <select> dropdowns app-wide. */
async function getRoleNames() {
    const roles = await all(`SELECT name FROM roles ORDER BY is_system DESC, name`);
    return roles.map(r => r.name);
}

/** Role names that are safe to offer in a per-school "assign this role to
 *  a user" dropdown - every role EXCEPT SuperAdmin, which stays a special,
 *  never-selectable-in-the-UI system role (assigned only via
 *  scripts/create-super-admin.js) so no school-level Add/Edit User form -
 *  not even the ones under Super Admin's own school-scoped user
 *  management - can ever be used to grant it. This mirrors exactly what
 *  the previous hardcoded <option> lists already did (none of them ever
 *  included "SuperAdmin"). */
async function getAssignableRoleNames() {
    return (await getRoleNames()).filter(name => name !== "SuperAdmin");
}

async function createRole(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Role name is required.");
    if (SYSTEM_ROLES.some(s => s.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error(`"${trimmed}" is a built-in role name and can't be reused.`);
    }
    await run(`INSERT INTO roles (name, is_system) VALUES (?, 0)`, [trimmed]);
}

/** Deletes a custom role, refusing if it's a system role or still in use
 *  (as anyone's primary users.role, or as anyone's secondary role). */
async function deleteRole(roleId) {
    const role = await get(`SELECT * FROM roles WHERE id=?`, [roleId]);
    if (!role) throw new Error("Role not found.");
    if (role.is_system) throw new Error("Built-in roles can't be deleted.");

    const inUseAsPrimary = await get(`SELECT COUNT(*) AS n FROM users WHERE role=?`, [role.name]);
    const inUseAsSecondary = await get(`SELECT COUNT(*) AS n FROM user_roles WHERE role_id=?`, [roleId]);
    if (inUseAsPrimary.n > 0 || inUseAsSecondary.n > 0) {
        throw new Error(`"${role.name}" is still assigned to ${inUseAsPrimary.n + inUseAsSecondary.n} user(s) - reassign them first.`);
    }

    await run(`DELETE FROM role_capabilities WHERE role_id=?`, [roleId]);
    await run(`DELETE FROM roles WHERE id=?`, [roleId]);
}

/** Replaces a role's ENTIRE capability set with exactly `keys` (unchecked
 *  boxes are just absent from `keys`, not passed as false). */
async function setRoleCapabilities(roleId, keys) {
    const valid = (keys || []).filter(k => CAPABILITY_KEYS.includes(k));
    await run(`DELETE FROM role_capabilities WHERE role_id=?`, [roleId]);
    for (const key of valid) {
        await run(`INSERT INTO role_capabilities (role_id, capability_key) VALUES (?, ?)`, [roleId, key]);
    }
}

/** A user's secondary (additional, beyond their primary users.role) role
 *  names - see the user_roles comment above. */
async function getSecondaryRoleNames(userId) {
    const rows = await all(
        `SELECT roles.name FROM user_roles JOIN roles ON user_roles.role_id = roles.id WHERE user_roles.user_id=?`,
        [userId]
    );
    return rows.map(r => r.name);
}

/** Replaces a user's secondary roles with exactly `roleIds` (their primary
 *  users.role is untouched either way). */
async function setSecondaryRoles(userId, roleIds) {
    await run(`DELETE FROM user_roles WHERE user_id=?`, [userId]);
    for (const roleId of (roleIds || [])) {
        await run(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`, [userId, roleId]);
    }
}

/** Effective capability keys for a user, given their primary role name
 *  (users.role) and user id (to pick up secondary roles too). Union of
 *  every role they hold. */
async function getEffectiveCapabilities(primaryRoleName, userId) {
    const roleNames = [primaryRoleName, ...(userId ? await getSecondaryRoleNames(userId) : [])].filter(Boolean);
    if (roleNames.length === 0) return new Set();
    const rows = await all(
        `SELECT DISTINCT role_capabilities.capability_key
         FROM role_capabilities
         JOIN roles ON role_capabilities.role_id = roles.id
         WHERE roles.name IN (${roleNames.map(() => "?").join(",")})`,
        roleNames
    );
    return new Set(rows.map(r => r.capability_key));
}

/** All role names a user effectively holds (primary + secondary) - used
 *  for requireRole()'s multi-role check and for display (User Matrix,
 *  navbar). */
async function getEffectiveRoleNames(primaryRoleName, userId) {
    const secondary = userId ? await getSecondaryRoleNames(userId) : [];
    return [...new Set([primaryRoleName, ...secondary].filter(Boolean))];
}

/** Express middleware: blocks the request unless the logged-in user's
 *  effective capabilities include `key`. Must run after requireLogin. A
 *  role with NO row at all in role_capabilities for this key (including a
 *  freshly-created custom role with nothing granted yet) is denied - see
 *  the module comment for why that's the safe default. */
function requireCapability(key) {
    return async (req, res, next) => {
        try {
            const caps = await getEffectiveCapabilities(req.userRole, req.userId);
            if (caps.has(key)) return next();
            const label = (CAPABILITIES.find(c => c.key === key) || {}).label || key;
            res.status(403).send(
                `<h3>Your role doesn't have access to ${label}.</h3>` +
                `<p>An Admin can grant this from Super Admin &gt; Roles &amp; Capabilities.</p>` +
                `<a href="/">Back to Dashboard</a>`
            );
        } catch (e) {
            res.send(e.message);
        }
    };
}

module.exports = {
    CAPABILITIES, CAPABILITY_KEYS, SYSTEM_ROLES,
    ensureRolesSeeded,
    getAllRolesWithCapabilities, getRoleNames, getAssignableRoleNames,
    createRole, deleteRole, setRoleCapabilities,
    getSecondaryRoleNames, setSecondaryRoles,
    getEffectiveCapabilities, getEffectiveRoleNames,
    requireCapability
};
