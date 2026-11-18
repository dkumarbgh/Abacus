import { test, expect } from "../fixtures";
import { ExamsPage } from "../pages/exams.page";
import { SchoolApi, loginApi, newContext } from "../support/api";
import { DEFAULT_PASSWORD, uniqueEmail, uniqueSuffix } from "../support/data";
import { dbAll, dbGet, latestId } from "../support/db";

test.describe("Exams", () => {

    let levelId: number;

    test.beforeEach(async ({ adminApi }) => {
        levelId = await adminApi.addListItem("level", "Level 1");
    });

    test("a school with no exams shows the empty-state message", async ({ adminPage: page }) => {
        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(exams.emptyMessage).toBeVisible();
    });

    test("creating an exam without a fee lists it with no fee", async ({ adminPage: page, school }) => {
        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.createExam({ name: "Term 1 Final", level: "Level 1", academicYear: "2026-2027", examDate: "2026-12-10" });

        await expect(page).toHaveURL(/\/exams$/);
        await expect(exams.row("Term 1 Final")).toHaveCount(1);
        await expect(exams.cell("Term 1 Final", "level")).toHaveText("Level 1");
        await expect(exams.cell("Term 1 Final", "academicYear")).toHaveText("2026-2027");
        await expect(exams.cell("Term 1 Final", "date")).toHaveText("2026-12-10");
        await expect(exams.cell("Term 1 Final", "fee")).toHaveText("—");
        await expect(exams.emptyMessage).toHaveCount(0);

        const row = await dbGet<{ fee_structure_id: number | null }>(
            "SELECT fee_structure_id FROM exams WHERE school_id=? AND exam_name=?", [school.id, "Term 1 Final"]);
        expect(row?.fee_structure_id).toBeNull();
    });

    test("an exam without a date shows a dash in the Date column", async ({ adminPage: page, adminApi }) => {
        await adminApi.addExam({ name: "Undated Exam", levelId });
        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(exams.cell("Undated Exam", "date")).toHaveText("-");
    });

    test("creating an exam with a fee auto-creates a fee item for that level", async ({ adminPage: page, adminApi, school }) => {
        const classId = await adminApi.addClass("Class 5");
        await adminApi.addStudent({ name: "Exam Kid One", classId, levelId });
        await adminApi.addStudent({ name: "Exam Kid Two", classId, levelId });

        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.createExam({ name: "Fee Exam", level: "Level 1", academicYear: "2026-27", feeAmount: 500 });

        await expect(exams.cell("Fee Exam", "fee")).toContainText("₹500");
        await expect(exams.cell("Fee Exam", "fee")).toContainText("0/2 paid");

        const fee = await dbGet<{ amount: number; level_id: number; fee_name: string }>(
            `SELECT fs.amount, fs.level_id, fc.fee_name
             FROM exams e JOIN fee_structure fs ON fs.id = e.fee_structure_id
             JOIN fee_categories fc ON fc.id = fs.fee_category_id
             WHERE e.school_id=? AND e.exam_name=?`, [school.id, "Fee Exam"]);
        expect(fee).toEqual({ amount: 500, level_id: levelId, fee_name: "Exam Fee: Fee Exam" });
    });

    test("the paid count goes up when a student pays the exam fee", async ({ adminPage: page, adminApi, school }) => {
        const classId = await adminApi.addClass("Class 5");
        const payer = await adminApi.addStudent({ name: "Paying Kid", classId, levelId });
        await adminApi.addStudent({ name: "Unpaid Kid", classId, levelId });
        const examId = await adminApi.addExam({ name: "Paid Count Exam", levelId, feeAmount: 300 });
        const feeStructureId = (await dbGet<{ fee_structure_id: number }>(
            "SELECT fee_structure_id FROM exams WHERE id=? AND school_id=?", [examId, school.id]))!.fee_structure_id;
        await adminApi.pay(payer, feeStructureId, 300);

        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(exams.cell("Paid Count Exam", "fee")).toContainText("1/2 paid");
    });

    test("Exam Name and Academic Year are required by the form", async ({ adminPage: page }) => {
        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(exams.nameInput).toHaveAttribute("required", "");
        await expect(exams.academicYearInput).toHaveAttribute("required", "");
        await expect(exams.levelSelect).toHaveAttribute("required", "");
    });

    test("BUG: a blank Exam Name is rejected by the server when the browser check is bypassed", async ({ adminPage: page, school }) => {
        test.fail(true, "Found 2026-11-18: POST /exams/add has no server-side validation; an empty exam_name is stored.");
        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.fill({ name: "", level: "Level 1", academicYear: "2026-27" });
        await exams.disableBrowserValidation();
        await exams.submit();

        expect(await dbAll("SELECT id FROM exams WHERE school_id=?", [school.id])).toEqual([]);
    });

    test("HTML in an exam name is shown as text (escaped)", async ({ adminPage: page, adminApi }) => {
        await adminApi.addExam({ name: `<b id="injected">Bold</b> Exam`, levelId });
        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(page.locator("#injected")).toHaveCount(0);
        await expect(exams.table).toContainText(`<b id="injected">Bold</b> Exam`);
    });

    test("Enter Marks opens the marks page for that exam", async ({ adminPage: page, adminApi }) => {
        const examId = await adminApi.addExam({ name: "Marks Link Exam", levelId });
        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.enterMarksLink("Marks Link Exam").click();
        await expect(page).toHaveURL(new RegExp(`/exams/marks/${examId}$`));
    });

    test("deleting an exam after confirming removes it and its marks", async ({ adminPage: page, adminApi, school }) => {
        const classId = await adminApi.addClass("Class 5");
        const studentId = await adminApi.addStudent({ name: "Marked Kid", classId, levelId });
        const examId = await adminApi.addExam({ name: "Doomed Exam", levelId });
        await adminApi.ctx.post("/subjects/add", { form: { subject_name: "Maths", subject_code: "M1", description: "" }, maxRedirects: 0 });
        const subjectId = await latestId("subjects", school.id, "subject_name=?", ["Maths"]);
        await adminApi.ctx.post(`/exams/marks/${examId}`, {
            form: { subject_id: String(subjectId), max_marks: "100", student_id: String(studentId), marks: "88" }, maxRedirects: 0
        });
        expect(await dbAll("SELECT id FROM exam_results WHERE exam_id=?", [examId])).toHaveLength(1);

        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.deleteExam("Doomed Exam");

        await expect(exams.row("Doomed Exam")).toHaveCount(0);
        expect(await dbAll("SELECT id FROM exams WHERE id=?", [examId])).toEqual([]);
        expect(await dbAll("SELECT id FROM exam_results WHERE exam_id=?", [examId])).toEqual([]);
    });

    test("cancelling the delete confirmation keeps the exam", async ({ adminPage: page, adminApi }) => {
        const examId = await adminApi.addExam({ name: "Kept Exam", levelId });
        const exams = new ExamsPage(page);
        await exams.goto();
        await exams.deleteExam("Kept Exam", { confirm: false });

        await expect(page).toHaveURL(/\/exams$/);
        await expect(exams.row("Kept Exam")).toHaveCount(1);
        expect(await dbAll("SELECT id FROM exams WHERE id=?", [examId])).toHaveLength(1);
    });

});

test.describe("Exams - access control", () => {

    test("a role without the Exams capability gets 403 on the Exams page", async ({ page, school, superAdmin, loginAs }) => {
        const roleName = `QA No Exams ${uniqueSuffix()}`;
        await superAdmin.createRole(roleName, ["attendance"]);
        const email = uniqueEmail("no-exams");
        await superAdmin.addUser(school.id, { name: "No Exams User", email, role: roleName });
        await loginAs(email, DEFAULT_PASSWORD);

        expect((await page.goto("/exams"))?.status()).toBe(403);
    });

    test("a role without the Exams capability cannot create an exam by posting directly", async ({ page, school, superAdmin, adminApi, loginAs }) => {
        const levelId = await adminApi.addListItem("level", "Level 1");
        const roleName = `QA No Exams Post ${uniqueSuffix()}`;
        await superAdmin.createRole(roleName, ["attendance"]);
        const email = uniqueEmail("no-exams-post");
        await superAdmin.addUser(school.id, { name: "No Exams Poster", email, role: roleName });
        await loginAs(email, DEFAULT_PASSWORD);

        const res = await page.request.post("/exams/add", {
            form: { exam_name: "Sneaky Exam", level_id: String(levelId), academic_year: "2026-27" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
        expect(await dbAll("SELECT id FROM exams WHERE school_id=?", [school.id])).toEqual([]);
    });

    test("a view-only user can see exams but creating one stores nothing", async ({ page, school, superAdmin, adminApi, loginAs }) => {
        const levelId = await adminApi.addListItem("level", "Level 1");
        await adminApi.addExam({ name: "Visible Exam", levelId });
        const email = uniqueEmail("viewonly-exams");
        await superAdmin.addUser(school.id, { name: "Exam Viewer", email, role: "Admin", readOnly: true });
        await loginAs(email, DEFAULT_PASSWORD);

        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(exams.row("Visible Exam")).toHaveCount(1);

        await exams.fill({ name: "Should Not Save", level: "Level 1", academicYear: "2026-27" });
        await exams.form.evaluate((f: HTMLFormElement) => { f.noValidate = true; f.submit(); });
        await expect(page.locator("body")).toContainText(/view-only/i);
        expect(await dbAll("SELECT id FROM exams WHERE school_id=? AND exam_name=?", [school.id, "Should Not Save"])).toEqual([]);
    });

});

/** School A's Admin must never see or change School B's exams, even by guessing ids. */
const isolationTest = test.extend<{ other: { api: SchoolApi; levelId: number; examId: number } }>({
    other: async ({ superAdmin, baseURL }, use) => {
        const school = await superAdmin.createSchool({ name: `Other Exam School ${Date.now()}` });
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, school.adminEmail, school.password);
        const api = new SchoolApi(ctx, school);
        const levelId = await api.addListItem("level", "Secret Level");
        const examId = await api.addExam({ name: "Secret Other Exam", levelId });
        await use({ api, levelId, examId });
        await api.dispose();
    }
});

isolationTest.describe("Exams - cross-school isolation", () => {

    isolationTest("the Exams list and Level dropdown never show another school's data", async ({ adminPage: page, adminApi, other }) => {
        await adminApi.addListItem("level", "My Level");
        const exams = new ExamsPage(page);
        await exams.goto();
        await expect(page.locator("body")).not.toContainText("Secret Other Exam");
        await expect(exams.levelSelect.locator("option")).toHaveText(["My Level"]);
    });

    isolationTest("opening another school's exam marks page by id does not reveal it", async ({ adminPage: page, other }) => {
        await page.goto(`/exams/marks/${other.examId}`);
        await expect(page.locator("body")).toContainText("Exam not found");
        await expect(page.locator("body")).not.toContainText("Secret Other Exam");
    });

    isolationTest("deleting another school's exam by id does nothing", async ({ adminPage: page, other }) => {
        await page.request.get(`/exams/delete/${other.examId}`, { maxRedirects: 0 });
        expect(await dbAll("SELECT id FROM exams WHERE id=?", [other.examId])).toHaveLength(1);
    });

    isolationTest("creating an exam against another school's level is rejected", async ({ adminPage: page, school, other }) => {
        const res = await page.request.post("/exams/add", {
            form: { exam_name: "Borrowed Level Exam", level_id: String(other.levelId), academic_year: "2026-27" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
        expect(await dbAll("SELECT id FROM exams WHERE school_id=? AND level_id=?", [school.id, other.levelId])).toEqual([]);
    });

    isolationTest("an exam fee against another school's level creates no fee item", async ({ adminPage: page, school, other }) => {
        const res = await page.request.post("/exams/add", {
            form: { exam_name: "Borrowed Fee Exam", level_id: String(other.levelId), academic_year: "2026-27", fee_amount: "500" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
        expect(await dbAll("SELECT id FROM fee_structure WHERE level_id=?", [other.levelId])).toEqual([]);
        expect(await dbAll("SELECT id FROM fee_categories WHERE school_id=? AND fee_name=?", [school.id, "Exam Fee: Borrowed Fee Exam"])).toEqual([]);
    });

});
