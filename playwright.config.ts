import { defineConfig } from "@playwright/test";

/**
 * TypeScript regression suite.
 *
 * Starts its own server (tests/support/test-server.ts) on a separate, freshly
 * wiped test DB (.test-db/test.db) with a seeded Super Admin, so a run never
 * touches school.db or your WhatsApp session. Set BASE_URL to run against an
 * already-running server instead (it must have the same Super Admin seeded).
 */
const PORT = process.env.TEST_PORT || "4100";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
    testDir: "./tests/specs",
    testMatch: "**/*.spec.ts",
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,
    workers: 1, // one SQLite file + one server: keep it serial
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI
        ? [["html", { outputFolder: "playwright-report", open: "never" }], ["list"]]
        : [["html", { open: "never" }], ["list"]],
    use: {
        baseURL: BASE_URL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        // Optional: use an installed Chrome instead of Playwright's bundled Chromium.
        launchOptions: process.env.PW_CHROME_PATH ? { executablePath: process.env.PW_CHROME_PATH } : {}
    },
    webServer: process.env.BASE_URL ? undefined : {
        command: "node --experimental-strip-types tests/support/test-server.ts",
        url: `${BASE_URL}/login`,
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: "ignore",
        stderr: "pipe",
        env: { TEST_PORT: PORT }
    }
});
