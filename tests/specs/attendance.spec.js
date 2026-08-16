const { test, expect } = require("@playwright/test");
const { RegisterSchoolPage } = require("../pages/RegisterSchoolPage");
const { AddStudentPage, ClassesPage } = require("../pages/StudentsPage");
const { AttendancePage } = require("../pages/AttendancePage");
const { uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } = require("../helpers/testData");

test.describe("Attendance", () => {

    test.beforeEach(async ({ page }) => {

        const registerPage = new RegisterSchoolPage(page);
        await registerPage.goto();
        await registerPage.register({
            schoolName: uniqueSchoolName("Attendance Test School"),
            adminName: "Test Admin",
            adminEmail: uniqueEmail("attendance"),
            password: DEFAULT_PASSWORD
        });

        const classesPage = new ClassesPage(page);
        await classesPage.goto();
        await classesPage.addClass("Class 3");

        const addStudentPage = new AddStudentPage(page);

        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "Present Kid", age: 8, className: "Class 3",
            guardianName: "G1", guardianPhone: "9222222221"
        });
        await addStudentPage.submit();

        await addStudentPage.goto();
        await addStudentPage.fillBasics({
            name: "Absent Kid", age: 8, className: "Class 3",
            guardianName: "G2", guardianPhone: "9222222222"
        });
        await addStudentPage.submit();

    });

    test("marking attendance for exactly ONE present student saves without crashing", async ({ page }) => {

        // Regression test: Express parses a single checked checkbox as a
        // plain string (not an array), which used to crash this route with
        // "students.forEach is not a function" - fixed by normalizing with
        // [].concat(). This test exists specifically to catch that
        // regression if it's ever reintroduced.
        const attendancePage = new AttendancePage(page);
        await attendancePage.goto();

        const today = new Date().toISOString().slice(0, 10);
        await attendancePage.loadFor(today, "Class 3");
        await attendancePage.setPresentByName(["Present Kid"]); // only ONE student checked

        await attendancePage.save();

        // Should redirect back to /attendance, not show an error page.
        await expect(page).toHaveURL(/\/attendance/);
        await expect(page.locator("body")).not.toContainText(/forEach is not a function/);
        await expect(page.locator("body")).not.toContainText(/TypeError/);

    });

    test("marking attendance for multiple students still works", async ({ page }) => {

        const attendancePage = new AttendancePage(page);
        await attendancePage.goto();

        const today = new Date().toISOString().slice(0, 10);
        await attendancePage.loadFor(today, "Class 3");
        await attendancePage.setPresentByName(["Present Kid", "Absent Kid"]);
        await attendancePage.save();

        await expect(page).toHaveURL(/\/attendance/);

    });

    test("attendance report with a date range shows correct per-student percentages", async ({ page }) => {

        // Regression test: the report's SQL query previously bound
        // parameters in the wrong order when a date range was applied
        // (date placeholders come first in the query text, but the code
        // pushed class_id/school_id first) - silently returning "No
        // students in this class" instead of real data.
        const attendancePage = new AttendancePage(page);
        const today = new Date().toISOString().slice(0, 10);

        // Only Present Kid present; Absent Kid left unchecked.
        await attendancePage.goto();
        await attendancePage.loadFor(today, "Class 3");
        await attendancePage.setPresentByName(["Present Kid"]);
        await attendancePage.save();

        await page.goto("/reports/attendance");
        await page.selectOption('select[name="class_id"]', { label: "Class 3" });
        await page.fill('input[name="from"]', today);
        await page.fill('input[name="to"]', today);
        await page.click('button:has-text("Filter")');

        await expect(page.locator("body")).not.toContainText(/No students in this class/i);
        await expect(page.locator("body")).toContainText("Present Kid");
        await expect(page.locator("body")).toContainText("Absent Kid");

        // Present Kid should show 100%, Absent Kid should show 0% (marked
        // absent for the day since they were left unchecked).
        const presentRow = page.locator("tr", { hasText: "Present Kid" });
        await expect(presentRow).toContainText("100");

        const absentRow = page.locator("tr", { hasText: "Absent Kid" });
        await expect(absentRow).toContainText("0");

    });

});
