import { test as base, expect } from "../fixtures";
import { SchoolApi, loginApi, newContext } from "../support/api";
import { dbAll } from "../support/db";

/**
 * Cross-school isolation through the normal web session: School A's Admin
 * must never see or change School B's data, even by guessing ids in URLs.
 */
const test = base.extend<{ other: { api: SchoolApi; studentId: number; classId: number } }>({
    other: async ({ superAdmin, baseURL }, use) => {
        const school = await superAdmin.createSchool({ name: `Other School ${Date.now()}` });
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, school.adminEmail, school.password);
        const api = new SchoolApi(ctx, school);
        const classId = await api.addClass("Secret Class");
        const studentId = await api.addStudent({ name: "Secret Other Kid", classId, guardianPhone: "9888888888" });
        await use({ api, studentId, classId });
        await api.dispose();
    }
});

test.describe("Cross-school isolation", () => {

    test("Students list and search never show another school's students", async ({ adminPage: page, other }) => {
        await page.goto("/students?search=Secret");
        await expect(page.locator("body")).not.toContainText("Secret Other Kid");
        await page.goto("/students");
        await expect(page.locator("body")).not.toContainText("Secret Other Kid");
    });

    test("opening another school's student by id does not reveal it", async ({ adminPage: page, other }) => {
        for (const path of [`/students/edit/${other.studentId}`, `/fee-payments/${other.studentId}`]) {
            await page.goto(path);
            await expect(page.locator("body"), path).not.toContainText("Secret Other Kid");
            await expect(page.locator("body"), path).not.toContainText("9888888888");
        }
    });

    test("attendance student search JSON excludes another school's students", async ({ adminPage: page, other }) => {
        const res = await page.request.get("/attendance/search-students?q=Secret");
        const body = await res.json();
        expect(body.students ?? []).toEqual([]);
    });

    test("editing another school's student by id changes nothing", async ({ adminPage: page, other }) => {
        await page.request.post(`/students/edit/${other.studentId}`, {
            multipart: { name: "Hijacked", class_id: String(other.classId), age: "10", guardian_name: "x", guardian_phone: "9000000000" },
            maxRedirects: 0
        });
        const [row] = await dbAll<{ name: string }>("SELECT name FROM students WHERE id=?", [other.studentId]);
        expect(row.name).toBe("Secret Other Kid");
    });

    test("deleting another school's student by id does nothing", async ({ adminPage: page, other }) => {
        await page.request.get(`/students/delete/${other.studentId}`, { maxRedirects: 0 });
        expect(await dbAll("SELECT id FROM students WHERE id=?", [other.studentId])).toHaveLength(1);
    });

    test("recording a payment against another school's student is rejected", async ({ adminPage: page, other }) => {
        await page.request.post("/fee-payments/pay", {
            form: { student_id: String(other.studentId), fee_structure_id: "1", amount_paid: "100", mode: "Cash" }, maxRedirects: 0
        });
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [other.studentId])).toEqual([]);
    });

    test("BUG: marking attendance for another school's student via the web form is ignored", async ({ adminPage: page, other, adminApi }) => {
        test.fail(true, "Found 2026-11-17: /attendance/save inserts cross_batch_student ids without checking they belong to the logged-in school.");
        const batchId = await adminApi.addListItem("batch", "My Batch");
        await page.request.post("/attendance/save", {
            form: { attendance_date: "2026-08-21", batch_id: String(batchId), cross_batch_student: String(other.studentId) }, maxRedirects: 0
        });
        expect(await dbAll("SELECT id FROM attendance WHERE student_id=?", [other.studentId])).toEqual([]);
    });

});
