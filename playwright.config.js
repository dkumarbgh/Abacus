const { defineConfig } = require("@playwright/test");

/**
 * Regression suite config. Runs against a server YOU start (locally, or
 * automatically in CI - see .github/workflows/regression.yml), pointed at
 * BASE_URL (defaults to localhost:3000).
 *
 * Deliberately does NOT start the server itself (`webServer` option) -
 * this app needs its own DB migration + optional face-service, which is
 * simpler to control explicitly in CI/local scripts than to fold into
 * Playwright's lifecycle.
 */
module.exports = defineConfig({

    testDir: "./tests/specs",
    timeout: 30_000,
    expect: { timeout: 5_000 },

    // CI: no retries hides real flakiness; but a couple of retries makes
    // sense for a scheduled regression run so one slow request doesn't
    // fail the whole run. Local runs: no retries, fail fast.
    retries: process.env.CI ? 1 : 0,

    // Tests in this suite intentionally run one after another (serial),
    // NOT in parallel - most of them register a fresh school and build on
    // that same session/data within the file, which parallel workers
    // would corrupt.
    workers: 1,

    reporter: process.env.CI
        ? [["html", { outputFolder: "playwright-report", open: "never" }], ["list"]]
        : [["html", { open: "never" }], ["list"]],

    use: {
        baseURL: process.env.BASE_URL || "http://localhost:3000",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure"
    }

});
