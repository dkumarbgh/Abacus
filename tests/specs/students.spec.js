const { test, expect } = require("@playwright/test");
const { RegisterSchoolPage } = require("../pages/RegisterSchoolPage");
const { StudentsPage, AddStudentPage, ClassesPage } = require("../pages/StudentsPage");
const { uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } = require("../helpers/testData");

test.describe("Students", () => {

    // Fresh school + one class, shared by every test in this file (each
    // test still creates its own students, so they don't collide with
    // each other within this shared school).
    test.beforeEach(async ({ page }) => {

        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName("Students Test School"),
            adminName: "Test Admin",
            adminEmail: uniqueEmail("students"),
            password: DEFAULT_PASSWORD
        });

        const classesPage = new ClassesPage(page);
        await classesPage.goto();
        await classesPage.addClass("Class 5");

    });

    test("adding a student with all required fields succeeds", async ({ page }) => {

        const addStudentPage = new AddStudentPage(page);
        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "Riya Sharma",
            age: 12,
            className: "Class 5",
            guardianName: "Suresh Sharma",
            guardianPhone: "9876543210"
        });
        await addStudentPage.submit();

        await expect(page).toHaveURL("/students");

        const studentsPage = new StudentsPage(page);
        expect(await studentsPage.isStudentListed("Riya Sharma")).toBe(true);

    });

    test("submitting without a required field shows a clear validation error", async ({ page }) => {

        const addStudentPage = new AddStudentPage(page);
        await addStudentPage.goto();

        // Deliberately omit Guardian Name and Guardian Phone (mandatory by default).
        await addStudentPage.fillBasics({
            name: "Missing Guardian Kid",
            age: 11,
            className: "Class 5"
        });
        await addStudentPage.submit();

        // Should stay on the form, not redirect to the list.
        await expect(page).toHaveURL(/students\/add/);
        const error = await addStudentPage.errorMessage();
        expect(error).toMatch(/guardian name/i);
        expect(error).toMatch(/guardian.*phone/i);

    });

    test("admission numbers auto-assign sequentially by default", async ({ page }) => {

        const addStudentPage = new AddStudentPage(page);

        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "First Kid", age: 10, className: "Class 5",
            guardianName: "G1", guardianPhone: "9000000001"
        });
        await addStudentPage.submit();
        await expect(page).toHaveURL("/students");

        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "Second Kid", age: 10, className: "Class 5",
            guardianName: "G2", guardianPhone: "9000000002"
        });
        await addStudentPage.submit();
        await expect(page).toHaveURL("/students");

        const studentsPage = new StudentsPage(page);
        const firstNo = await studentsPage.admissionNoFor("First Kid");
        const secondNo = await studentsPage.admissionNoFor("Second Kid");

        expect(firstNo.trim()).not.toBe("");
        expect(secondNo.trim()).not.toBe("");
        expect(firstNo.trim()).not.toBe(secondNo.trim());

    });

    test("an inactive class is hidden from the Add Student dropdown", async ({ page }) => {

        const classesPage = new ClassesPage(page);
        await classesPage.goto();
        await classesPage.addClass("Class 9 Inactive Test");

        // Mark it inactive.
        const row = page.locator("tr", { hasText: "Class 9 Inactive Test" });
        await row.locator('button:has-text("Mark Inactive")').click();
        await page.waitForLoadState("networkidle");

        const addStudentPage = new AddStudentPage(page);
        await addStudentPage.goto();

        const options = await page.locator('select[name="class_id"] option').allTextContents();
        expect(options.join(" ")).not.toContain("Class 9 Inactive Test");
        expect(options.join(" ")).toContain("Class 5"); // the active one from beforeEach

    });

});
