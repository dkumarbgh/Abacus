/** Unique test data, so runs never collide even on a reused DB. */
export const uniqueSuffix = (): string => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
export const uniqueEmail = (prefix = "test"): string => `${prefix}-${uniqueSuffix()}@example.com`;
export const uniqueSchoolName = (prefix = "Regression School"): string => `${prefix} ${uniqueSuffix()}`;
export const today = (): string => new Date().toISOString().slice(0, 10);

export const DEFAULT_PASSWORD = "TestPass123";
export const SUPER_ADMIN = {
    email: process.env.TEST_SUPERADMIN_EMAIL || "superadmin@test.local",
    password: process.env.TEST_SUPERADMIN_PASSWORD || "SuperPass123"
};
