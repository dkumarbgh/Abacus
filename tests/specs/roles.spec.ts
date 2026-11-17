import { test, expect } from "../fixtures";
import { DEFAULT_PASSWORD, uniqueEmail, uniqueSuffix } from "../support/data";

test.describe("Roles & capabilities", () => {

    test("a Teacher cannot open Admin-only pages but can take attendance", async ({ page, school, superAdmin, loginAs }) => {
        const email = uniqueEmail("teacher");
        await superAdmin.addUser(school.id, { name: "Tara Teacher", email, role: "Teacher" });
        await loginAs(email, DEFAULT_PASSWORD);

        for (const path of ["/settings", "/lists", "/users"]) {
            const res = await page.goto(path);
            expect(res?.status(), `Teacher opening ${path}`).toBe(403);
        }
        const ok = await page.goto("/attendance");
        expect(ok?.status()).toBe(200);
    });

    test("a Teacher cannot add users by posting directly", async ({ page, school, superAdmin, loginAs }) => {
        const email = uniqueEmail("teacher-post");
        await superAdmin.addUser(school.id, { name: "Post Teacher", email, role: "Teacher" });
        await loginAs(email, DEFAULT_PASSWORD);

        const res = await page.request.post("/users/add", {
            form: { name: "Hacker", email: uniqueEmail("hacker"), password: "x", role: "Admin" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
    });

    test("a custom role only reaches the modules it was granted", async ({ page, school, superAdmin, loginAs }) => {
        const roleName = `QA Attendance Only ${uniqueSuffix()}`;
        await superAdmin.createRole(roleName, ["attendance"]);
        const email = uniqueEmail("custom-role");
        await superAdmin.addUser(school.id, { name: "Custom Role User", email, role: roleName });
        await loginAs(email, DEFAULT_PASSWORD);

        expect((await page.goto("/attendance"))?.status()).toBe(200);
        for (const path of ["/students", "/fee-payments", "/reports"]) {
            expect((await page.goto(path))?.status(), `${roleName} opening ${path}`).toBe(403);
        }
    });

    test("granting a capability takes effect on the user's next request", async ({ page, school, superAdmin, loginAs }) => {
        const roleName = `QA Grant Later ${uniqueSuffix()}`;
        const roleId = await superAdmin.createRole(roleName, ["attendance"]);
        const email = uniqueEmail("grant-later");
        await superAdmin.addUser(school.id, { name: "Grant Later", email, role: roleName });
        await loginAs(email, DEFAULT_PASSWORD);

        expect((await page.goto("/students"))?.status()).toBe(403);
        await superAdmin.setCapabilities(roleId, ["attendance", "students"]);
        expect((await page.goto("/students"))?.status()).toBe(200);
    });

    test("SuperAdmin is never offered as an assignable role", async ({ adminPage: page }) => {
        await page.goto("/users");
        const options = await page.locator('select[name="role"] option').allTextContents();
        expect(options.length).toBeGreaterThan(0);
        expect(options.join(" ")).not.toMatch(/super\s*admin/i);
    });

});
