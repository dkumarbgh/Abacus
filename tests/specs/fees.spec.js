const { test, expect } = require("@playwright/test");
const { RegisterSchoolPage } = require("../pages/RegisterSchoolPage");
const { AddStudentPage, ClassesPage } = require("../pages/StudentsPage");
const { FeeCategoryPage, FeeStructurePage, FeePaymentsPage } = require("../pages/FeesPage");
const { SettingsPage } = require("../pages/AttendancePage");
const { uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } = require("../helpers/testData");

test.describe("Fees", () => {

    test.beforeEach(async ({ page }) => {

        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName("Fees Test School"),
            adminName: "Test Admin",
            adminEmail: uniqueEmail("fees"),
            password: DEFAULT_PASSWORD
        });

        const classesPage = new ClassesPage(page);
        await classesPage.goto();
        await classesPage.addClass("Class 8");

        const feeCategoryPage = new FeeCategoryPage(page);
        await feeCategoryPage.goto();
        await feeCategoryPage.addCategory("Tuition Fee");

        const feeStructurePage = new FeeStructurePage(page);
        await feeStructurePage.goto();
        await feeStructurePage.addStructure({
            className: "Class 8", categoryName: "Tuition Fee", academicYear: "2026-27", amount: 10000
        });

        const addStudentPage = new AddStudentPage(page);
        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "Fee Test Student", age: 13, className: "Class 8",
            guardianName: "Parent", guardianPhone: "9111111111"
        });
        await addStudentPage.submit();

    });

    test("collecting a partial payment reduces the due amount correctly", async ({ page }) => {

        const feePaymentsPage = new FeePaymentsPage(page);
        await page.goto("/fee-payments");
        await page.locator('tr:has-text("Fee Test Student")').locator('a:has-text("Collect Fee")').click();

        await expect(page.locator("body")).toContainText("₹10000"); // full amount due initially

        await feePaymentsPage.collect("Tuition Fee", 4000);

        await expect(page.locator("body")).toContainText("₹6000"); // remaining due

    });

    test("Simple Fee Mode: amounts are hidden and Mark Paid works in one click", async ({ page }) => {

        const settingsPage = new SettingsPage(page);
        await settingsPage.goto();
        await settingsPage.setSimpleFeeMode(true);

        await page.goto("/fee-payments");
        await page.locator('tr:has-text("Fee Test Student")').locator('a:has-text("Collect Fee")').click();

        // No rupee amounts should appear anywhere on the dues table when this mode is ON.
        await expect(page.locator("body")).not.toContainText("₹");
        await expect(page.locator("body")).toContainText(/not paid/i);

        const feePaymentsPage = new FeePaymentsPage(page);
        await feePaymentsPage.markPaid("Tuition Fee");
        await page.waitForLoadState("networkidle");

        const badge = await feePaymentsPage.statusBadgeFor("Tuition Fee");
        expect(badge.trim()).toMatch(/paid/i);

        // Turning it back off should restore amounts (cleans up state for other tests too).
        await settingsPage.goto();
        await settingsPage.setSimpleFeeMode(false);

    });

});
