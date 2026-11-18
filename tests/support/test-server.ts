/**
 * Boots SimpleSchool against a throwaway test database for the Playwright run.
 *
 * Run by Playwright's `webServer` (see playwright.config.ts) with plain Node
 * (type stripping, Node 22.18+), so only erasable TypeScript syntax is used.
 *
 *  1. Deletes and recreates the test DB (never touches ./school.db).
 *  2. Points WhatsApp at an EMPTY session folder, so the suite can never send
 *     real messages through your linked phone.
 *  3. Waits for config/database.js migrations, seeds a Super Admin, then
 *     starts app.js on the same DB connection.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT: string = path.resolve(__dirname, "..", "..");
const DB_PATH: string = path.resolve(ROOT, process.env.TEST_DB_PATH || ".test-db/test.db");
const WA_SESSION: string = path.resolve(ROOT, ".test-db/whatsapp-session-empty");

for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(WA_SESSION, { recursive: true, force: true });
fs.mkdirSync(WA_SESSION, { recursive: true });

process.chdir(ROOT);
process.env.DB_PATH = DB_PATH;
process.env.PORT = process.env.TEST_PORT || "4100";
process.env.WHATSAPP_SESSION_PATH = WA_SESSION;
process.env.FEATURE_WHATSAPP = "false";
process.env.FEATURE_EMAIL = "false";
process.env.FEATURE_FACE_RECOGNITION = "false";
process.env.SMTP_HOST = "";

const bcrypt = require("bcryptjs");
const db = require(path.join(ROOT, "config", "database.js"));

const SUPER_ADMIN_EMAIL: string = process.env.TEST_SUPERADMIN_EMAIL || "superadmin@test.local";
const SUPER_ADMIN_PASSWORD: string = process.env.TEST_SUPERADMIN_PASSWORD || "SuperPass123";

function q(sql: string, params: unknown[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => db.all(sql, params, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows)));
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Retries `check` until it returns true, or throws after `timeoutMs`. */
async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            if (await check()) return;
        } catch (err) {
            lastError = err;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ""}`);
}

/**
 * The real end-to-end readiness check: the server is listening, migrations
 * are done, and the seeded Super Admin can log in exactly as the suite will
 * (302 to /super-admin, not back to /login).
 */
async function superAdminCanLogIn(): Promise<boolean> {
    const res = await fetch(`http://localhost:${process.env.PORT}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD }).toString(),
        redirect: "manual"
    });
    return res.status === 302 && /^\/super-admin/.test(res.headers.get("location") ?? "");
}

/** app.js seeds roles/capabilities fire-and-forget; every system role must have its grants. */
async function rolesSeeded(): Promise<boolean> {
    const rows = await q(
        `SELECT COUNT(DISTINCT rc.role_id) AS n FROM role_capabilities rc
         JOIN roles r ON r.id = rc.role_id WHERE r.is_system = 1`);
    return rows[0].n >= 4;
}

(async () => {
    // Wait for the real end of migrate() - polling the schema can stop in a
    // gap before the users-table rebuild and lose the row seeded below.
    await db.ready;
    const hash = bcrypt.hashSync(SUPER_ADMIN_PASSWORD, 10);
    await q(`INSERT INTO users (school_id, name, email, password_hash, role) VALUES (0, 'Test Super Admin', ?, ?, 'SuperAdmin')`,
        [SUPER_ADMIN_EMAIL, hash]);
    console.log(`[test-server] DB ${DB_PATH} migrated, Super Admin ${SUPER_ADMIN_EMAIL} seeded`);

    require(path.join(ROOT, "app.js"));

    await waitUntil("roles/capabilities seeding", rolesSeeded);
    await waitUntil(`a successful Super Admin login on port ${process.env.PORT}`, superAdminCanLogIn);
    // playwright.config.ts waits for this exact line before running any test.
    console.log("[test-server] READY");
})().catch(err => { console.error("[test-server] failed:", err); process.exit(1); });
