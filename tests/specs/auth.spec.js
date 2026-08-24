const { test, expect } = require("@playwright/test");
const { LoginPage, ChooseAccountPage } = require("../pages/LoginPage");
const { RegisterSchoolPage } = require("../pages/RegisterSchoolPage");
const { uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } = require("../helpers/testData");

test.describe("Authentication", () => {

    test("registering a new school logs the admin straight in", async ({ page }) => {

        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();

        await registerPage.register({
            schoolName: uniqueSchoolName(),
            adminName: "Test Admin",
            adminEmail: uniqueEmail("admin"),
            password: DEFAULT_PASSWORD
        });

        // Successful registration lands on the dashboard, not back on a form.
        await expect(page).toHaveURL("/");

    });

    test("wrong password shows an error and keeps the typed email", async ({ page }) => {

        const email = uniqueEmail("wrongpass");
        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName(),
            adminName: "Test Admin",
            adminEmail: email,
            password: DEFAULT_PASSWORD
        });

        // Log out, then deliberately get the password wrong.
        await page.goto("/logout");
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.login(email, "definitely-the-wrong-password");

        await expect(page.locator(".alert-danger")).toContainText(/invalid/i);
        expect(await loginPage.emailFieldValue()).toBe(email);

    });

    test("same email + same password at two schools triggers the account picker", async ({ page }) => {

        const sharedEmail = uniqueEmail("shared");
        const registerPage = new RegisterSchoolPage(page);

        // First school.
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName("School Alpha"),
            adminName: "Shared Person",
            adminEmail: sharedEmail,
            password: DEFAULT_PASSWORD
        });
        await page.goto("/logout");

        // Second school, SAME email + SAME password.
        const schoolBName = uniqueSchoolName("School Beta");
        await registerPage.goto();
        await registerPage.register({
            schoolName: schoolBName,
            adminName: "Shared Person",
            adminEmail: sharedEmail,
            password: DEFAULT_PASSWORD
        });
        await page.goto("/logout");

        // Logging in now should show the picker, not go straight to a dashboard.
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.login(sharedEmail, DEFAULT_PASSWORD);

        await expect(page).toHaveURL(/login\/choose-account/);

        const chooser = new ChooseAccountPage(page);
        expect(await chooser.accountOptionsCount()).toBe(2);

        await chooser.pickAccountBySchoolName(schoolBName);
        await expect(page).toHaveURL("/");
        await expect(page.locator("body")).toContainText(schoolBName);

    });

    test("a single-account login never shows the picker", async ({ page }) => {

        const email = uniqueEmail("solo");
        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName(),
            adminName: "Solo Person",
            adminEmail: email,
            password: DEFAULT_PASSWORD
        });
        await page.goto("/logout");

        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.login(email, DEFAULT_PASSWORD);

        await expect(page).toHaveURL("/");

    });

});
