import { test, expect } from "../fixtures";
import { AttendancePage } from "../pages/attendance.page";
import { dbAll } from "../support/db";
import { today } from "../support/data";

test.describe("Attendance", () => {

    let ids: { present: number; absent: number };

    test.beforeEach(async ({ adminApi }) => {
        const classId = await adminApi.addClass("Class 3");
        const batchId = await adminApi.addListItem("batch", "Mon-Wed Batch");
        ids = {
            present: await adminApi.addStudent({ name: "Present Kid", classId, batchId }),
            absent: await adminApi.addStudent({ name: "Absent Kid", classId, batchId })
        };
    });

    const statusFor = (studentId: number) =>
        dbAll<{ status: string }>("SELECT status FROM attendance WHERE student_id=? AND attendance_date=?", [studentId, today()]);

    test("exactly ONE present student saves without crashing (single-checkbox regression)", async ({ adminPage: page }) => {
        // Express parses one checked box as a string, not an array - this once crashed /attendance/save.
        const att = new AttendancePage(page);
        await att.goto();
        await att.load(today(), "Mon-Wed Batch");
        await att.setPresent(["Present Kid"]);
        await att.save();

        await expect(page).toHaveURL(/\/attendance/);
        await expect(page.locator("body")).not.toContainText(/TypeError|is not a function/);
        expect((await statusFor(ids.present))[0]?.status).toMatch(/present/i);
        expect((await statusFor(ids.absent))[0]?.status).toMatch(/absent/i);
    });

    test("marking several students present saves all of them", async ({ adminPage: page }) => {
        const att = new AttendancePage(page);
        await att.goto();
        await att.load(today(), "Mon-Wed Batch");
        await att.setPresent(["Present Kid", "Absent Kid"]);
        await att.save();

        expect((await statusFor(ids.present))[0]?.status).toMatch(/present/i);
        expect((await statusFor(ids.absent))[0]?.status).toMatch(/present/i);
    });

    test("saving the same batch+date twice updates instead of duplicating", async ({ adminPage: page }) => {
        const att = new AttendancePage(page);
        for (const present of [["Present Kid"], ["Present Kid", "Absent Kid"]]) {
            await att.goto();
            await att.load(today(), "Mon-Wed Batch");
            await att.setPresent(present);
            await att.save();
        }
        const rows = await statusFor(ids.absent);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toMatch(/present/i);
    });

    test("after saving, the page reopens the just-saved roster", async ({ adminPage: page }) => {
        const att = new AttendancePage(page);
        await att.goto();
        await att.load(today(), "Mon-Wed Batch");
        await att.setPresent(["Present Kid"]);
        await att.save();

        await expect(page).toHaveURL(/\/attendance\/load\?.*batch_id=/);
        await expect(att.rosterRows.filter({ hasText: "Present Kid" }).locator('input[name="student"]')).toBeChecked();
        await expect(att.rosterRows.filter({ hasText: "Absent Kid" }).locator('input[name="student"]')).not.toBeChecked();
    });

    test("a student from another batch of the same school is recorded as a cross-batch visitor", async ({ adminPage: page, adminApi }) => {
        const classId = await adminApi.addClass("Class 4");
        const otherBatchId = await adminApi.addListItem("batch", "Thu-Fri Batch");
        const visitor = await adminApi.addStudent({ name: "Visiting Kid", classId, batchId: otherBatchId });
        const homeBatchId = (await dbAll<{ id: number }>(
            "SELECT id FROM lookup_items WHERE school_id=? AND list_type='batch' AND name=?", [adminApi.school.id, "Mon-Wed Batch"]))[0].id;

        const res = await page.request.post("/attendance/save", {
            form: { attendance_date: today(), batch_id: String(homeBatchId), cross_batch_student: String(visitor) }, maxRedirects: 0
        });
        expect(res.status()).toBe(302);

        const rows = await dbAll<{ status: string; batch_id: number; is_different_batch: number }>(
            "SELECT status, batch_id, is_different_batch FROM attendance WHERE student_id=? AND attendance_date=?", [visitor, today()]);
        expect(rows).toEqual([{ status: "Present", batch_id: homeBatchId, is_different_batch: 1 }]);
    });

    const XSS_NAME = `Xss<img src=x onerror="window.__xss=1"> Kid`;

    test("HTML in a student name is shown as text, not run, in the Attendance smart search", async ({ adminPage: page, adminApi }) => {
        const classId = await adminApi.addClass("XSS Class");
        await adminApi.addStudent({ name: XSS_NAME, classId });

        const att = new AttendancePage(page);
        await att.goto();
        await att.smartSearch.pressSequentially("Xss");
        await expect(att.smartSearchResults).toContainText(XSS_NAME);
        await expect(att.smartSearchResults.locator("img[onerror]")).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    });

    test("HTML in a student name is shown as text, not run, when added from a different batch", async ({ adminPage: page, adminApi }) => {
        const classId = await adminApi.addClass("XSS Class");
        const otherBatchId = await adminApi.addListItem("batch", `Xss<b>Batch</b>`);
        await adminApi.addStudent({ name: XSS_NAME, classId, batchId: otherBatchId });

        const att = new AttendancePage(page);
        await att.goto();
        await att.load(today(), "Mon-Wed Batch");
        await att.crossBatchSearch.pressSequentially("Xss");
        await expect(att.crossBatchResults).toContainText(XSS_NAME);
        await att.crossBatchResults.getByRole("button").first().click();

        const addedRow = att.rosterRows.filter({ hasText: XSS_NAME });
        await expect(addedRow).toHaveCount(1);
        await expect(addedRow).toContainText("Different Batch (Xss<b>Batch</b>)");
        await expect(page.locator("#attendanceForm img[onerror], #attendanceForm b")).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    });

});
