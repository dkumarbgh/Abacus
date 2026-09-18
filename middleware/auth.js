const jwt = require("jsonwebtoken");
const { buildTranslator } = require("../services/labels");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

/* ===========================================
   WEB (session-based) AUTH
   Attaches req.schoolId / req.userRole for convenience, and res.locals.t
   (see services/labels.js) so every view can call t('some.key') for
   customizable/translatable text without each route having to wire it up
   itself.
=========================================== */
async function requireLogin(req, res, next) {

    if (!req.session || !req.session.userId) {
        return res.redirect("/login");
    }

    req.schoolId = req.session.schoolId;
    req.userRole = req.session.role;
    req.userId = req.session.userId;

    try {
        res.locals.t = await buildTranslator(req.schoolId);
    } catch (e) {
        // Never let a labels-lookup hiccup take down an otherwise-working
        // page - fall back to plain English defaults for this request.
        const { DEFAULTS } = require("../services/labels");
        res.locals.t = (key) => (DEFAULTS.en[key] !== undefined ? DEFAULTS.en[key] : key);
    }

    // Per-school WhatsApp toggle (schools.whatsapp_enabled), exposed to every
    // view so the navbar can hide the WhatsApp link once a school turns it
    // off - not just block the route itself (see requireSchoolFeature below).
    res.locals.schoolWhatsappEnabled = await new Promise((resolve) => {
        const db = require("../config/database");
        db.get("SELECT whatsapp_enabled FROM schools WHERE id=?", [req.schoolId], (err, row) => {
            resolve(err || !row ? true : !!row.whatsapp_enabled);
        });
    });

    next();

}

// Checks the user's EFFECTIVE role set - their primary role (users.role,
// unchanged - still what drives login/the "last Admin" safety guards/etc)
// PLUS any secondary roles granted via Super Admin > Roles & Capabilities
// (see services/capabilities.js) - so someone holding Teacher as their
// primary role and Accountant as a secondary one passes
// requireRole("Accountant") without their primary role ever changing.
// Every existing requireRole(...) call site needed zero changes for this -
// a user with only ever had a primary role behaves exactly as before.
function requireRole(...roles) {
    return async (req, res, next) => {
        try {
            if (!req.userRole) {
                return res.status(403).send("<h3>You don't have permission to do that.</h3><a href='/'>Back to Dashboard</a>");
            }
            const { getEffectiveRoleNames } = require("../services/capabilities");
            const effective = await getEffectiveRoleNames(req.userRole, req.userId);
            if (!effective.some(r => roles.includes(r))) {
                return res.status(403).send("<h3>You don't have permission to do that.</h3><a href='/'>Back to Dashboard</a>");
            }
            next();
        } catch (e) {
            res.status(403).send("<h3>You don't have permission to do that.</h3><a href='/'>Back to Dashboard</a>");
        }
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

/* ===========================================
   PER-SCHOOL FEATURE TOGGLES
   Unlike requireFeature() above (deployment-wide, set via .env), these
   check a column on the schools table - changeable per school from
   Settings without touching environment variables or redeploying. See
   config/database.js for the schools.*_enabled columns, and
   routes/settings.js for where they're toggled.
=========================================== */
function requireSchoolFeature(columnName, friendlyName) {
    return (req, res, next) => {
        const db = require("../config/database");
        db.get(`SELECT ${columnName} AS enabled FROM schools WHERE id=?`, [req.schoolId], (err, row) => {
            if (err) return res.send(err.message);
            if (!row || !row.enabled) {
                return res.status(403).send(
                    `<h3>${friendlyName} isn't turned on for your school.</h3>` +
                    `<p>An Admin can enable it from Settings.</p>` +
                    `<a href="/settings">Go to Settings</a>`
                );
            }
            next();
        });
    };
}

module.exports = { requireLogin, requireRole, requireApiAuth, requireFeature, requireSchoolFeature, JWT_SECRET };
