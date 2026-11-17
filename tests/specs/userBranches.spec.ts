import { test, expect } from "../fixtures";
import { DEFAULT_PASSWORD, uniqueEmail } from "../support/data";
import { dbAll } from "../support/db";

/** User <-> Branch links: label only (no access restriction yet). */
const linksFor = (userId: number) =>
    dbAll<{ name: string }>(
        `SELECT li.name FROM user_branches ub JOIN lookup_items li ON li.id = ub.branch_id WHERE ub.user_id=? ORDER BY li.name`, [userId]);
const userIdFor = async (schoolId: number, email: string) =>
    (await dbAll<{ id: number }>("SELECT id FROM users WHERE school_id=? AND email=?", [schoolId, email]))[0].id;

test.describe("User branches", () => {

    test("school Admin adds another Admin with two branches; the list shows them", async ({ adminPage: page, adminApi, school }) => {
        await adminApi.addListItem("branch", "Kuvempunagar");
        await adminApi.addListItem("branch", "Vijayanagar");
        await adminApi.addListItem("branch", "Hebbal");
        const email = uniqueEmail("branch-admin");

        await page.goto("/users");
        const form = page.locator('form[action="/users/add"]');
        await form.locator('input[name="name"]').fill("Branch Admin");
        await form.locator('input[name="email"]').fill(email);
        await form.locator('input[name="password"]').fill(DEFAULT_PASSWORD);
        await form.locator('select[name="role"]').selectOption("Admin");
        await form.getByLabel("Kuvempunagar").check();
        await form.getByLabel("Vijayanagar").check();
        await form.locator('button:has-text("Add User")').click();

        const row = page.locator("tr", { hasText: email });
        await expect(row).toContainText("Kuvempunagar");
        await expect(row).toContainText("Vijayanagar");
        await expect(row).not.toContainText("Hebbal");
        expect((await linksFor(await userIdFor(school.id, email))).map(r => r.name)).toEqual(["Kuvempunagar", "Vijayanagar"]);
    });

    test("editing a user changes their branches", async ({ adminPage: page, adminApi, school, superAdmin }) => {
        await adminApi.addListItem("branch", "North Centre");
        await adminApi.addListItem("branch", "South Centre");
        const email = uniqueEmail("edit-branch");
        await superAdmin.addUser(school.id, { name: "Edit Me", email, role: "Teacher" });
        const id = await userIdFor(school.id, email);

        await page.goto(`/users/edit/${id}`);
        await page.getByLabel("North Centre").check();
        await page.click('button:has-text("Save Changes")');
        expect((await linksFor(id)).map(r => r.name)).toEqual(["North Centre"]);

        await page.goto(`/users/edit/${id}`);
        await expect(page.getByLabel("North Centre")).toBeChecked();
        await page.getByLabel("North Centre").uncheck();
        await page.getByLabel("South Centre").check();
        await page.click('button:has-text("Save Changes")');
        expect((await linksFor(id)).map(r => r.name)).toEqual(["South Centre"]);
    });

    test("Super Admin can set branches when adding a user to a school", async ({ page, adminApi, school, loginAs }) => {
        await adminApi.addListItem("branch", "Main Branch");
        const { SUPER_ADMIN } = await import("../support/data");
        await loginAs(SUPER_ADMIN.email, SUPER_ADMIN.password);
        const email = uniqueEmail("sa-branch");

        await page.goto(`/super-admin/schools/${school.id}?role=Admin#add-user`);
        const form = page.locator("#add-user form");
        await form.locator('input[name="name"]').fill("SA Branch Admin");
        await form.locator('input[name="email"]').fill(email);
        await form.locator('input[name="password"]').fill(DEFAULT_PASSWORD);
        await form.getByLabel("Main Branch").check();
        await form.locator('button:has-text("Add User")').click();

        await expect(page.locator("tr", { hasText: email })).toContainText("Main Branch");
        expect((await linksFor(await userIdFor(school.id, email))).map(r => r.name)).toEqual(["Main Branch"]);
    });

    test("a school with no branches shows a hint, and adding a user still works", async ({ adminPage: page, school }) => {
        await page.goto("/users");
        await expect(page.locator('form[action="/users/add"] [data-testid="branch-picker"]')).toContainText(/no branches yet/i);
        const email = uniqueEmail("no-branch");
        const form = page.locator('form[action="/users/add"]');
        await form.locator('input[name="name"]').fill("No Branch");
        await form.locator('input[name="email"]').fill(email);
        await form.locator('input[name="password"]').fill(DEFAULT_PASSWORD);
        await form.locator('button:has-text("Add User")').click();
        await expect(page.locator("tr", { hasText: email })).toHaveCount(1);
    });

    test("another school's branch id is ignored", async ({ adminApi, school, superAdmin, baseURL }) => {
        const { SchoolApi, newContext, loginApi } = await import("../support/api");
        const other = await superAdmin.createSchool();
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, other.adminEmail, other.password);
        const foreignBranch = await new SchoolApi(ctx, other).addListItem("branch", "Foreign Branch");
        await ctx.dispose();
        const ownBranch = await adminApi.addListItem("branch", "Own Branch");

        const email = uniqueEmail("foreign");
        const form = new URLSearchParams({ name: "X", email, password: DEFAULT_PASSWORD, role: "Teacher" });
        form.append("branch_ids", String(ownBranch));
        form.append("branch_ids", String(foreignBranch));
        const res = await adminApi.ctx.post("/users/add", {
            data: form.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0
        });
        expect(res.status()).toBe(302);
        expect((await linksFor(await userIdFor(school.id, email))).map(r => r.name)).toEqual(["Own Branch"]);
    });

    test("deleting a user removes their branch links", async ({ adminApi, school, superAdmin }) => {
        const branchId = await adminApi.addListItem("branch", "Temp Branch");
        const email = uniqueEmail("delete-branch");
        await superAdmin.addUser(school.id, { name: "Delete Me", email, role: "Teacher" });
        const id = await userIdFor(school.id, email);
        const form = new URLSearchParams({ name: "Delete Me", email, password: "", role: "Teacher", branch_ids: String(branchId) });
        await adminApi.ctx.post(`/users/edit/${id}`, { data: form.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0 });
        expect(await linksFor(id)).toHaveLength(1);

        await adminApi.ctx.get(`/users/delete/${id}`, { maxRedirects: 0 });
        expect(await dbAll("SELECT * FROM user_branches WHERE user_id=?", [id])).toEqual([]);
    });

});
