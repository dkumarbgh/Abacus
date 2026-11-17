import { test, expect } from "../fixtures";
import { AddStudentPage, StudentsPage } from "../pages/students.page";
import { dbAll, dbGet } from "../support/db";

test.describe("Students", () => {

    test.beforeEach(async ({ adminApi }) => {
        await adminApi.addClass("Class 5");
    });

    test("adding a student with all required fields succeeds", async ({ adminPage: page }) => {
        const add = new AddStudentPage(page);
        await add.goto();
        await add.fill({ name: "Riya Sharma", age: 12, className: "Class 5", guardianName: "Suresh Sharma", guardianPhone: "9876543210" });
        await add.submit();

        await expect(page).toHaveURL(/\/students$/);
        await expect(new StudentsPage(page).row("Riya Sharma")).toHaveCount(1);
    });

    test("missing mandatory guardian fields shows a validation error and keeps the form", async ({ adminPage: page }) => {
        const add = new AddStudentPage(page);
        await add.goto();
        await add.fill({ name: "Missing Guardian Kid", age: 11, className: "Class 5" });

        // Client side: the browser blocks the submit.
        await expect(page.locator('input[name="guardian_name"]')).toHaveAttribute("required", "");
        await expect(page.locator('input[name="guardian_phone"]')).toHaveAttribute("required", "");

        // Server side: still rejected if the browser check is bypassed.
        await page.locator('form[action="/students/add"]').evaluate(f => f.setAttribute("novalidate", ""));
        await add.submit();
        await expect(add.error).toContainText(/guardian name/i);
        await expect(add.error).toContainText(/whatsapp 1 number/i);
        await expect(page.locator('input[name="name"]')).toHaveValue("Missing Guardian Kid"); // input kept
    });

    test("missing Full Name is rejected even though it is not a configurable field", async ({ adminPage: page }) => {
        const add = new AddStudentPage(page);
        await add.goto();
        await add.fill({ age: 11, className: "Class 5", guardianName: "G", guardianPhone: "9000000001" });
        await page.locator('form[action="/students/add"]').evaluate(f => f.setAttribute("novalidate", "")); // bypass browser check
        await add.submit();
        await expect(add.error).toContainText(/full name/i);
    });

    test("roll numbers auto-assign uniquely by default", async ({ adminPage: page, adminApi }) => {
        const classId = (await dbGet<{ id: number }>("SELECT id FROM classes WHERE school_id=? AND class_name='Class 5'", [adminApi.school.id]))!.id;
        await adminApi.addStudent({ name: "First Kid", classId });
        await adminApi.addStudent({ name: "Second Kid", classId });

        const list = new StudentsPage(page);
        await list.goto();
        const first = await list.rollNoFor("First Kid");
        const second = await list.rollNoFor("Second Kid");
        expect(first).not.toMatch(/^-?$/);
        expect(second).not.toMatch(/^-?$/);
        expect(first).not.toBe(second);
    });

    test("an inactive class is hidden from the Add Student dropdown", async ({ adminPage: page, adminApi }) => {
        await adminApi.addClass("Class 9 Inactive Test");
        await page.goto("/classes");
        await page.locator("tr", { hasText: "Class 9 Inactive Test" }).locator('button:has-text("Mark Inactive")').click();
        await expect(page.locator("tr", { hasText: "Class 9 Inactive Test" })).toContainText("Inactive");

        const add = new AddStudentPage(page);
        await add.goto();
        const options = (await add.classOptions.allTextContents()).join(" | ");
        expect(options).not.toContain("Class 9 Inactive Test");
        expect(options).toContain("Class 5");
    });

    test("search filters the student list by name", async ({ adminPage: page, adminApi }) => {
        const classId = (await dbGet<{ id: number }>("SELECT id FROM classes WHERE school_id=?", [adminApi.school.id]))!.id;
        await adminApi.addStudent({ name: "Ananya Rao", classId });
        await adminApi.addStudent({ name: "Bharath Kumar", classId });

        const list = new StudentsPage(page);
        await list.goto();
        await list.search("Ananya");
        await expect(list.row("Ananya Rao")).toHaveCount(1);
        await expect(list.row("Bharath Kumar")).toHaveCount(0);
    });

    test("editing a student's name is saved", async ({ adminPage: page, adminApi }) => {
        const classId = (await dbGet<{ id: number }>("SELECT id FROM classes WHERE school_id=?", [adminApi.school.id]))!.id;
        const id = await adminApi.addStudent({ name: "Old Name Kid", classId });

        await page.goto(`/students/edit/${id}`);
        await page.fill('input[name="name"]', "New Name Kid");
        await page.click('button:has-text("Update Student")');

        await expect(page).toHaveURL(/\/students/);
        const rows = await dbAll<{ name: string }>("SELECT name FROM students WHERE id=?", [id]);
        expect(rows[0].name).toBe("New Name Kid");
    });

    test("HTML in a student name is shown as text on the Students list (escaped)", async ({ adminPage: page, adminApi }) => {
        const classId = (await dbGet<{ id: number }>("SELECT id FROM classes WHERE school_id=?", [adminApi.school.id]))!.id;
        await adminApi.addStudent({ name: `<b id="injected">Bold</b> Kid`, classId });

        await new StudentsPage(page).goto();
        await expect(page.locator("#injected")).toHaveCount(0);
        await expect(page.locator("tbody")).toContainText(`<b id="injected">Bold</b> Kid`);
    });

});
