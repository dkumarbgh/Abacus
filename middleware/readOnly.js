/* ===========================================
   VIEW-ONLY (DEMO) USERS
   A user with users.read_only = 1 can log in and look at everything their
   role normally sees, but can never change anything. Built for handing a
   demo login (e.g. "test") to prospective schools.

   Two layers, on purpose:

   1. REQUEST GUARD (enforceReadOnly) - the main gate. For a view-only
      session, every non-GET request is refused (except logging in/out),
      plus the handful of GET links that change data or leak more than a
      demo should see (delete/remove links, "assign missing", the full
      database backup download, user management, WhatsApp linking).

   2. DATABASE BACKSTOP (installDbGuard) - in case some GET page quietly
      writes (e.g. a recalculation that saves its result, a lazily-created
      default row), any INSERT/UPDATE/DELETE/etc issued while serving a
      view-only request is skipped as a no-op instead of being run. The
      page still renders from what it computed; nothing is persisted. This
      also protects any future route someone forgets to add to layer 1.

   Normal users never enter either path - for them this is a no-op.
=========================================== */
const { AsyncLocalStorage, AsyncResource } = require("async_hooks");

const readOnlyContext = new AsyncLocalStorage();

// Requests a view-only session may still make even though they aren't GET.
const ALLOWED_WRITES = [
    /^\/login$/,
    /^\/login\/choose-account$/,
    /^\/logout$/
];

// GET links that change data, or expose more than a demo login should.
const BLOCKED_GETS = [
    /\/delete(\/|-|$)/i,          // every /delete/:id, /:id/delete, /delete-plan, /delete-confirm
    /\/remove(\/|$)/i,            // /fee-payments/discount/remove/:id
    /\/assign-missing(\/|$)/i,    // /fee-structure/plans/:id/assign-missing
    /^\/settings\/backup(\/|$)/,  // downloads the ENTIRE database (every school)
    /^\/users(\/|$)/,             // staff list with emails + add/edit/delete users
    /^\/whatsapp(\/|$)/,          // scanning the QR would link a phone to the school
    /^\/super-admin(\/|$)/,
    /^\/exit-impersonation$/
];

function isReadOnlySession(req) {
    return !!(req.session && req.session.readOnly);
}

function isBlocked(req) {
    const p = req.path;
    if (req.method === "GET" || req.method === "HEAD") {
        return BLOCKED_GETS.some(rx => rx.test(p));
    }
    return !ALLOWED_WRITES.some(rx => rx.test(p));
}

function refuse(req, res) {
    const wantsJson = req.xhr ||
        (req.headers.accept || "").includes("application/json") ||
        (req.headers["content-type"] || "").includes("application/json");

    if (wantsJson) {
        return res.status(403).json({ ok: false, error: "view_only", message: "This is a view-only demo login - changes aren't saved." });
    }

    // Send them back to the page they were on, but only if it's on this
    // same site (never an open redirect via a forged Referer).
    let back = "/";
    const ref = req.get("Referer");
    if (ref) {
        try {
            const u = new URL(ref);
            if (u.host === req.get("host")) back = u.pathname + u.search;
        } catch (e) { /* ignore malformed Referer */ }
    }

    res.status(403).send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>View-only demo</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"></head>` +
        `<body class="bg-light"><div class="container mt-5" style="max-width:560px">` +
        `<div class="card shadow"><div class="card-body text-center">` +
        `<h4 class="mb-3">👀 View-only demo</h4>` +
        `<p>You're signed in with a demo account, so you can look around freely, but nothing can be added, changed or deleted.</p>` +
        `<a href="${back.replace(/"/g, "&quot;")}" class="btn btn-primary">&larr; Go back</a> ` +
        `<a href="/" class="btn btn-outline-secondary">Dashboard</a>` +
        `</div></div></div></body></html>`
    );
}

function enforceReadOnly(req, res, next) {
    if (!isReadOnlySession(req)) return next();

    res.locals.readOnly = true;

    if (isBlocked(req)) return refuse(req, res);

    readOnlyContext.run({ readOnly: true }, () => next());
}

/* ---------- database backstop ---------- */

const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)\b/i;

function inReadOnlyRequest() {
    const store = readOnlyContext.getStore();
    return !!(store && store.readOnly);
}

function installDbGuard(db) {
    if (db.__readOnlyGuardInstalled) return;
    db.__readOnlyGuardInstalled = true;

    // sqlite3's native callbacks don't carry AsyncLocalStorage context on
    // their own - bind each callback to the context it was issued from, so
    // a query made inside another query's callback still knows it's part
    // of a view-only request.
    const bindLastCallback = (args) => {
        for (let i = args.length - 1; i >= 0; i--) {
            if (typeof args[i] === "function") {
                args[i] = AsyncResource.bind(args[i]);
                break;
            }
        }
        return args;
    };

    const lastCallback = (args) => {
        for (let i = args.length - 1; i >= 0; i--) {
            if (typeof args[i] === "function") return args[i];
        }
        return null;
    };

    ["get", "all", "each"].forEach(method => {
        const original = db[method].bind(db);
        db[method] = function (...args) {
            return original(...bindLastCallback(args));
        };
    });

    ["run", "exec"].forEach(method => {
        const original = db[method].bind(db);
        db[method] = function (sql, ...rest) {
            if (inReadOnlyRequest() && WRITE_SQL.test(String(sql))) {
                console.log(`[view-only] skipped write: ${String(sql).trim().split(/\s+/).slice(0, 4).join(" ")} ...`);
                const cb = lastCallback(rest);
                if (cb) process.nextTick(() => cb.call({ lastID: undefined, changes: 0 }, null));
                return db;
            }
            return original(sql, ...bindLastCallback(rest));
        };
    });

    const originalPrepare = db.prepare.bind(db);
    db.prepare = function (sql, ...rest) {
        if (inReadOnlyRequest() && WRITE_SQL.test(String(sql))) {
            console.log(`[view-only] skipped prepared write: ${String(sql).trim().split(/\s+/).slice(0, 4).join(" ")} ...`);
            const stub = {
                run(...a) { const cb = lastCallback(a); if (cb) process.nextTick(() => cb.call({ lastID: undefined, changes: 0 }, null)); return stub; },
                finalize(cb) { if (typeof cb === "function") process.nextTick(cb); return stub; },
                bind() { return stub; },
                reset(cb) { if (typeof cb === "function") process.nextTick(cb); return stub; }
            };
            return stub;
        }
        return originalPrepare(sql, ...bindLastCallback(rest));
    };
}

module.exports = { enforceReadOnly, installDbGuard, isReadOnlySession };
