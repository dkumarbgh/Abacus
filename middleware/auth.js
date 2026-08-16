const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

/* ===========================================
   WEB (session-based) AUTH
   Attaches req.schoolId / req.userRole for convenience.
=========================================== */
function requireLogin(req, res, next) {

    if (!req.session || !req.session.userId) {
        return res.redirect("/login");
    }

    req.schoolId = req.session.schoolId;
    req.userRole = req.session.role;
    next();

}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.userRole || !roles.includes(req.userRole)) {
            return res.status(403).send("<h3>You don't have permission to do that.</h3><a href='/'>Back to Dashboard</a>");
        }
        next();
    };
}

/* ===========================================
   FEATURE FLAGS
   Blocks a route entirely when its feature is turned off via .env (see
   config/features.js) - even if someone hits the URL directly, not just
   hiding the UI entry point. `asJson: true` for API/mobile routes that
   expect a JSON response rather than an HTML page.
=========================================== */
function requireFeature(flagName, { asJson = false } = {}) {
    return (req, res, next) => {
        const features = require("../config/features");
        if (features[flagName]) return next();

        if (asJson) {
            return res.status(404).json({ ok: false, error: "feature_disabled" });
        }
        res.status(404).send("<h3>This feature is turned off for this deployment.</h3><a href='/'>Back to Dashboard</a>");
    };
}

/* ===========================================
   API (JWT-based) AUTH - used by the mobile app
   Expects: Authorization: Bearer <token>
=========================================== */
function requireApiAuth(req, res, next) {

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.schoolId = payload.schoolId;
        req.userId = payload.userId;
        req.userRole = payload.role;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }

}

module.exports = { requireLogin, requireRole, requireApiAuth, requireFeature, JWT_SECRET };
