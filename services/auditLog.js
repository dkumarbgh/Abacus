const db = require("../config/database");

/**
 * Records one entry in the Audit Log (see config/database.js for the
 * table, and views/auditLog.ejs / routes/reports.js for the report that
 * displays these).
 *
 * This is intentionally fire-and-forget: a logging failure should never
 * break the actual action the user was performing (e.g. don't fail a fee
 * payment just because the audit insert hiccuped), so errors here are
 * only logged to the console, never thrown or awaited by the caller.
 *
 * @param {object} opts
 * @param {number} opts.schoolId
 * @param {number|null} [opts.branchId] - the affected student's branch_id, when there is one
 * @param {object} opts.req - the Express request, used to pull the acting user's id/name from the session
 * @param {string} opts.entityType - e.g. "Student", "Fee Payment", "Fee Structure", "Attendance", "Exam", "User"
 * @param {string} [opts.entityName] - a human-readable label for what was changed, e.g. a student's name
 * @param {string} opts.action - e.g. "Created", "Updated", "Deleted", "Paid", "Discounted"
 * @param {string} [opts.details] - short free-text specifics, e.g. "₹500 via Cash, Receipt RCPT-0004"
 */
function logChange({ schoolId, branchId, req, entityType, entityName, action, details }) {
    try {
        const userId = req && req.session ? req.session.userId : null;
        const userName = req && req.session ? req.session.name : null;
        db.run(
            `INSERT INTO audit_logs (school_id, branch_id, user_id, user_name, entity_type, entity_name, action, details)
             VALUES (?,?,?,?,?,?,?,?)`,
            [schoolId, branchId || null, userId, userName, entityType, entityName || null, action, details || null],
            (err) => {
                if (err) console.error("Audit log insert failed:", err.message);
            }
        );
    } catch (e) {
        console.error("Audit log error:", e.message);
    }
}

module.exports = { logChange };
