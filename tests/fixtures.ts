import { test as base, expect, type Page } from "@playwright/test";
import { SchoolApi, SuperAdminApi, loginApi, newContext, type SchoolInfo } from "./support/api";

/**
 * Shared fixtures:
 *   superAdmin - Super Admin HTTP session (one per worker)
 *   school     - a brand-new school with its own Admin, per test
 *   adminApi   - that Admin's HTTP session, for fast data setup
 *   adminPage  - a browser page already logged in as that Admin
 *   loginAs    - log the test's `page` in as any user
 */
type TestFixtures = {
    school: SchoolInfo;
    adminApi: SchoolApi;
    adminPage: Page;
    loginAs: (email: string, password: string) => Promise<void>;
};
type WorkerFixtures = { superAdmin: SuperAdminApi };

export const test = base.extend<TestFixtures, WorkerFixtures>({
    superAdmin: [async ({}, use, workerInfo) => {
        const sa = await SuperAdminApi.create(String(workerInfo.project.use.baseURL));
        await use(sa);
        await sa.dispose();
    }, { scope: "worker" }],

    school: async ({ superAdmin }, use) => {
        await use(await superAdmin.createSchool());
    },

    adminApi: async ({ school, baseURL }, use) => {
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, school.adminEmail, school.password);
        const api = new SchoolApi(ctx, school);
        await use(api);
        await api.dispose();
    },

    loginAs: async ({ page }, use) => {
        await use(async (email, password) => {
            // page.request shares the browser context's cookie jar.
            await loginApi(page.request, email, password);
        });
    },

    adminPage: async ({ page, school, loginAs }, use) => {
        await loginAs(school.adminEmail, school.password);
        await use(page);
    }
});

export { expect };
