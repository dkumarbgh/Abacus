import { test, expect } from "../fixtures";
import { LoginPage, ChooseAccountPage } from "../pages/login.page";
import { SUPER_ADMIN, uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } from "../support/data";

test.describe("Authentication", () => {

    test("a school Admin logs in and lands on the dashboard", async ({ page, school }) => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login(school.adminEmail, school.password);
        await expect(page).toHaveURL("/");
        await expect(page.locator("body")).toContainText(school.name);
    });

    test("wrong password shows an error and keeps the typed email", async ({ page, school }) => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login(school.adminEmail, "definitely-the-wrong-password");
        await expect(login.error).toContainText(/invalid/i);
        expect(await login.emailFieldValue()).toBe(school.adminEmail);
    });

    test("unknown email gets the same generic error (no account enumeration)", async ({ page }) => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login(uniqueEmail("nobody"), DEFAULT_PASSWORD);
        await expect(login.error).toContainText("Invalid email or password");
    });

    test("same email + password at two schools shows the account picker", async ({ page, superAdmin }) => {
        const shared = uniqueEmail("shared");
        await superAdmin.createSchool({ name: uniqueSchoolName("School Alpha"), adminEmail: shared });
        const beta = await superAdmin.createSchool({ name: uniqueSchoolName("School Beta"), adminEmail: shared });

        const login = new LoginPage(page);
        await login.goto();
        await login.login(shared, DEFAULT_PASSWORD);
        await expect(page).toHaveURL(/\/login\/choose-account/);

        const chooser = new ChooseAccountPage(page);
        await expect(chooser.options).toHaveCount(2);
        await chooser.pickBySchoolName(beta.name);
        await expect(page).toHaveURL("/");
        await expect(page.locator("body")).toContainText(beta.name);
    });

    test("a single-account login never shows the picker", async ({ page, school }) => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login(school.adminEmail, school.password);
        await expect(page).not.toHaveURL(/choose-account/);
    });

    test("Super Admin login lands on the Super Admin dashboard", async ({ page }) => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login(SUPER_ADMIN.email, SUPER_ADMIN.password);
        await expect(page).toHaveURL(/\/super-admin/);
    });

    test("self-service school registration is closed (redirects to login)", async ({ page }) => {
        await page.goto("/register-school");
        await expect(page).toHaveURL(/\/login$/);
    });

    test("protected pages redirect anonymous visitors to login", async ({ page }) => {
        for (const path of ["/", "/students", "/attendance", "/fee-payments", "/super-admin"]) {
            await page.goto(path);
            await expect(page, `anonymous visit to ${path}`).toHaveURL(/\/login/);
        }
    });

    test("logout ends the session", async ({ adminPage: page }) => {
        await page.goto("/students");
        await expect(page).toHaveURL(/\/students/);
        await page.goto("/logout");
        await page.goto("/students");
        await expect(page).toHaveURL(/\/login/);
    });

});
