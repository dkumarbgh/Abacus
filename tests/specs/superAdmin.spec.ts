import { test, expect } from "../fixtures";
import { SUPER_ADMIN, uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } from "../support/data";
import { dbGet } from "../support/db";

test.describe("Super Admin", () => {

    test.beforeEach(async ({ loginAs }) => {
        await loginAs(SUPER_ADMIN.email, SUPER_ADMIN.password);
    });

    test("creates a school with its first Admin, who can then log in", async ({ page, browser }) => {
        const name = uniqueSchoolName("UI Created School");
        const adminEmail = uniqueEmail("ui-admin");

        await page.goto("/super-admin/schools/new");
        await page.fill('input[name="school_name"]', name);
        await page.fill('input[name="admin_name"]', "New Admin");
        await page.fill('input[name="admin_email"]', adminEmail);
        await page.fill('input[name="admin_password"]', DEFAULT_PASSWORD);
        await page.click('button:has-text("Create School")');

        await expect(page).toHaveURL(/\/super-admin\/schools\/\d+$/);
        await expect(page.locator("body")).toContainText(name);
        await page.goto("/super-admin");
        await expect(page.locator("body")).toContainText(name);

        const ctx = await browser.newContext();
        const p2 = await ctx.newPage();
        await p2.goto("/login");
        await p2.fill('input[name="email"]', adminEmail);
        await p2.fill('input[name="password"]', DEFAULT_PASSWORD);
        await p2.click('button:has-text("Log In")');
        await expect(p2).toHaveURL("/");
        await expect(p2.locator("body")).toContainText(name);
        await ctx.close();
    });

    test("creating a school without required fields shows an error and creates nothing", async ({ page }) => {
        const name = uniqueSchoolName("Incomplete School");
        await page.goto("/super-admin/schools/new");
        await page.fill('input[name="school_name"]', name);
        await page.locator("form").evaluate(f => f.setAttribute("novalidate", ""));
        await page.click('button:has-text("Create School")');

        await expect(page.locator(".alert-danger")).toContainText(/required fields/i);
        expect(await dbGet("SELECT id FROM schools WHERE name=?", [name])).toBeUndefined();
    });

    test("'Login As' a school shows that school, and exit returns to Super Admin", async ({ page, school }) => {
        await page.goto(`/super-admin/schools/${school.id}/login-as`);
        await expect(page).toHaveURL("/");
        await expect(page.locator("body")).toContainText(school.name);

        await page.goto("/exit-impersonation");
        await expect(page).toHaveURL(/\/super-admin/);
    });

    test("User Matrix lists a person who has accounts at two schools", async ({ page, superAdmin }) => {
        const email = uniqueEmail("matrix");
        const s1 = await superAdmin.createSchool();
        const s2 = await superAdmin.createSchool();
        await superAdmin.addUser(s1.id, { name: "Matrix Person", email, role: "Teacher" });
        await superAdmin.addUser(s2.id, { name: "Matrix Person", email, role: "Accountant" });

        await page.goto("/super-admin/user-matrix");
        const row = page.locator("tr", { hasText: email });
        await expect(row).toContainText("Teacher");
        await expect(row).toContainText("Accountant");
    });

    test("dashboard 'Add Admin / User' opens the school's form with Admin pre-selected, and the new Admin can log in", async ({ page, school, browser }) => {
        await page.goto("/super-admin");
        await page.locator("tr", { hasText: school.name }).locator('a:has-text("Add Admin / User")').click();

        await expect(page).toHaveURL(new RegExp(`/super-admin/schools/${school.id}\\?role=Admin#add-user$`));
        const form = page.locator("#add-user form");
        await expect(form.locator('select[name="role"]')).toHaveValue("Admin");
        await expect(form.locator('input[name="name"]')).toBeFocused();

        const email = uniqueEmail("second-admin");
        await form.locator('input[name="name"]').fill("Second Admin");
        await form.locator('input[name="email"]').fill(email);
        await form.locator('input[name="password"]').fill(DEFAULT_PASSWORD);
        await form.locator('button:has-text("Add User")').click();
        await expect(page.locator("tr", { hasText: email })).toContainText("Admin");

        const ctx = await browser.newContext();
        const p2 = await ctx.newPage();
        await p2.goto("/login");
        await p2.fill('input[name="email"]', email);
        await p2.fill('input[name="password"]', DEFAULT_PASSWORD);
        await p2.click('button:has-text("Log In")');
        await expect(p2).toHaveURL("/");
        expect((await p2.goto("/settings"))?.status()).toBe(200); // Admin-only page
        await ctx.close();
    });

    test("school page header 'Add Admin / User' button jumps to the form with Admin selected", async ({ page, school }) => {
        await page.goto(`/super-admin/schools/${school.id}`);
        await expect(page.locator('#add-user select[name="role"]')).toHaveValue("Teacher"); // default untouched
        await page.click("#jumpToAddUser");
        await expect(page.locator('#add-user select[name="role"]')).toHaveValue("Admin");
        await expect(page.locator('#add-user input[name="name"]')).toBeFocused();
    });

    test("a school Admin cannot open Super Admin pages", async ({ adminPage: page }) => {
        for (const path of ["/super-admin", "/super-admin/schools/new", "/super-admin/roles", "/super-admin/user-matrix"]) {
            const res = await page.goto(path);
            expect(res?.status(), path).toBe(403);
        }
    });

    test("a school Admin cannot create a school by posting to the Super Admin route", async ({ adminApi }) => {
        const name = uniqueSchoolName("Sneaky School");
        const res = await adminApi.ctx.post("/super-admin/schools/new", {
            form: { school_name: name, admin_name: "x", admin_email: uniqueEmail("x"), admin_password: "x" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
        expect(await dbGet("SELECT id FROM schools WHERE name=?", [name])).toBeUndefined();
    });

});
