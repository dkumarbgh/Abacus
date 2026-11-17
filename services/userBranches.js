/**
 * User <-> Branch links (label only for now - NOT an access restriction).
 *
 * A user can belong to zero, one or several of their school's branches
 * (lookup_items with list_type='branch'). Stored in user_branches, created
 * by the idempotent migration in config/database.js. Nothing in the app
 * filters data by these links yet; they are shown on the user lists and
 * edited on every Add/Edit User form.
 */
const db = require("../config/database");

function all(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
function run(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}

/** The school's branches, for the checkbox list. */
function getSchoolBranches(schoolId) {
    return all("SELECT id, name FROM lookup_items WHERE school_id=? AND list_type='branch' ORDER BY name", [schoolId]);
}

/** { [userId]: [{id, name}, ...] } for every user in the school (deleted branches drop out via the JOIN). */
async function getUserBranchMap(schoolId) {
    const rows = await all(
        `SELECT ub.user_id, li.id, li.name
         FROM user_branches ub JOIN lookup_items li ON li.id = ub.branch_id AND li.school_id = ub.school_id
         WHERE ub.school_id=? ORDER BY li.name`,
        [schoolId]
    );
    const map = {};
    rows.forEach(r => { (map[r.user_id] = map[r.user_id] || []).push({ id: r.id, name: r.name }); });
    return map;
}

/** Normalises the branch_ids form field (missing / single string / array). */
function parseBranchIds(body) {
    return [].concat((body && body.branch_ids) || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
}

/** Replaces a user's branches. Ids that aren't this school's branches are ignored. */
async function setUserBranches(userId, schoolId, branchIds) {
    const valid = new Set((await getSchoolBranches(schoolId)).map(b => b.id));
    const wanted = [...new Set(branchIds)].filter(id => valid.has(id));
    await run("DELETE FROM user_branches WHERE user_id=? AND school_id=?", [userId, schoolId]);
    for (const branchId of wanted) {
        await run("INSERT OR IGNORE INTO user_branches (user_id, branch_id, school_id) VALUES (?,?,?)", [userId, branchId, schoolId]);
    }
}

function deleteForUser(userId) {
    return run("DELETE FROM user_branches WHERE user_id=?", [userId]);
}

/**
 * Router middleware: puts the school's branches and the user->branches map on
 * res.locals, so every render of the user pages (including validation-error
 * re-renders) has them without each route passing them explicitly.
 */
function loadBranchLocals(getSchoolId) {
    return async (req, res, next) => {
        try {
            const schoolId = getSchoolId(req);
            res.locals.schoolBranches = schoolId ? await getSchoolBranches(schoolId) : [];
            res.locals.userBranchMap = schoolId ? await getUserBranchMap(schoolId) : {};
        } catch (e) {
            console.error("[userBranches] could not load branches:", e.message);
            res.locals.schoolBranches = [];
            res.locals.userBranchMap = {};
        }
        next();
    };
}

module.exports = { getSchoolBranches, getUserBranchMap, parseBranchIds, setUserBranches, deleteForUser, loadBranchLocals };
