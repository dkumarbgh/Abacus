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

async function waitForMigrations(): Promise<void> {
    // migrate() exposes no "done" signal; poll until the schema stops changing.
    let last = -1;
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 300));
        const cols = await q("SELECT COUNT(*) AS n FROM pragma_table_info('users')").catch(() => [{ n: 0 }]);
        const tables = await q("SELECT COUNT(*) AS n FROM sqlite_master").catch(() => [{ n: 0 }]);
        const sig = cols[0].n * 10000 + tables[0].n;
        if (cols[0].n > 0 && sig === last) return;
        last = sig;
    }
    throw new Error("Test DB migrations did not settle in time");
}

(async () => {
    await waitForMigrations();
    const hash = bcrypt.hashSync(SUPER_ADMIN_PASSWORD, 10);
    await q(`INSERT INTO users (school_id, name, email, password_hash, role) VALUES (0, 'Test Super Admin', ?, ?, 'SuperAdmin')`,
        [SUPER_ADMIN_EMAIL, hash]);
    console.log(`[test-server] DB ${DB_PATH} ready, Super Admin ${SUPER_ADMIN_EMAIL} seeded`);
    require(path.join(ROOT, "app.js"));
})().catch(err => { console.error("[test-server] failed:", err); process.exit(1); });
