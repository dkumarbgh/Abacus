import { test, expect } from "../fixtures";
import { DEFAULT_PASSWORD, uniqueEmail } from "../support/data";
import { dbAll } from "../support/db";

test.describe("View-only (demo) login", () => {

    let classId: number;

    test.beforeEach(async ({ school, superAdmin, adminApi, loginAs }) => {
        classId = await adminApi.addClass("Demo Class");
        await adminApi.addStudent({ name: "Existing Demo Kid", classId });
        const email = uniqueEmail("viewonly");
        await superAdmin.addUser(school.id, { name: "Demo Viewer", email, role: "Admin", readOnly: true });
        await loginAs(email, DEFAULT_PASSWORD);
    });

    test("can browse existing data", async ({ page }) => {
        for (const path of ["/", "/students", "/attendance", "/fee-payments"]) {
            expect((await page.goto(path))?.status(), path).toBe(200);
        }
        await page.goto("/students");
        await expect(page.locator("tbody")).toContainText("Existing Demo Kid");
    });

    test("the Add Student form is shown with Save disabled", async ({ page }) => {
        await page.goto("/students/add");
        await expect(page.locator('button:has-text("Save Student")')).toBeDisabled();
    });

    test("submitting the Add Student form anyway gets the view-only notice and stores nothing", async ({ page, school }) => {
        await page.goto("/students/add");
        await page.fill('input[name="name"]', "Should Not Save");
        await page.selectOption('select[name="class_id"]', { label: "Demo Class" });
        await page.fill('input[name="guardian_name"]', "G");
        await page.fill('input[name="guardian_phone"]', "9000000009");
        await page.locator('form[action="/students/add"]').evaluate((f: HTMLFormElement) => { f.noValidate = true; f.submit(); });
        await expect(page.locator("body")).toContainText(/view-only/i);
        expect(await dbAll("SELECT id FROM students WHERE school_id=? AND name=?", [school.id, "Should Not Save"])).toEqual([]);
    });

    test("direct POSTs to write routes are refused", async ({ page, school }) => {
        const attempts: Array<[string, Record<string, string>]> = [
            ["/classes/add", { class_name: "Sneaky Class" }],
            ["/fees/add", { fee_name: "Sneaky Fee" }],
            ["/lists/add", { list_type: "batch", name: "Sneaky Batch" }],
            ["/settings/fee-mode", { simple_fee_mode: "on" }]
        ];
        for (const [url, form] of attempts) {
            const res = await page.request.post(url, { form, maxRedirects: 0 });
            expect(res.status(), url).toBe(403);
        }
        expect(await dbAll("SELECT id FROM classes WHERE school_id=? AND class_name='Sneaky Class'", [school.id])).toEqual([]);
        expect(await dbAll("SELECT id FROM fee_categories WHERE school_id=? AND fee_name='Sneaky Fee'", [school.id])).toEqual([]);
    });

    test("GET-based deletes are refused too", async ({ page, school }) => {
        const [kid] = await dbAll<{ id: number }>("SELECT id FROM students WHERE school_id=? AND name='Existing Demo Kid'", [school.id]);
        const res = await page.request.get(`/students/delete/${kid.id}`, { maxRedirects: 0 });
        expect(res.status()).toBe(403);
        expect(await dbAll("SELECT id FROM students WHERE id=?", [kid.id])).toHaveLength(1);
    });

    test("logging out still works", async ({ page }) => {
        await page.goto("/logout");
        await page.goto("/students");
        await expect(page).toHaveURL(/\/login/);
    });

});
