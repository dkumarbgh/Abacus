/**
 * Every test that registers a school/user needs a unique email (email is
 * now scoped per-school, not globally, but re-using the exact same email
 * across unrelated test runs still risks confusing failures) - these
 * helpers keep every run's data distinct without coordination between spec
 * files.
 */

function uniqueSuffix() {
    return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function uniqueEmail(prefix = "test") {
    return `${prefix}-${uniqueSuffix()}@example.com`;
}

function uniqueSchoolName(prefix = "Regression School") {
    return `${prefix} ${uniqueSuffix()}`;
}

const DEFAULT_PASSWORD = "TestPass123";

module.exports = { uniqueSuffix, uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD };
