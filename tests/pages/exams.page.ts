import type { Locator, Page } from "@playwright/test";

export interface ExamForm {
    name?: string;
    /** Visible level name, as shown in the Level dropdown. */
    level?: string;
    academicYear?: string;
    /** yyyy-mm-dd */
    examDate?: string;
    feeAmount?: number;
}

/**
 * /exams - "Create Exam" form on the left, "Exams" table on the right.
 *
 * The form's <label>s are not linked to their inputs (no for/id), so getByLabel
 * cannot find them; fields are located by their `name` attribute inside the form.
 * Adding for/id pairs in views/exams.ejs would let these switch to getByLabel.
 */
export class ExamsPage {
    readonly heading: Locator;
    readonly form: Locator;
    readonly nameInput: Locator;
    readonly levelSelect: Locator;
    readonly academicYearInput: Locator;
    readonly examDateInput: Locator;
    readonly feeAmountInput: Locator;
    readonly createButton: Locator;
    readonly table: Locator;
    readonly rows: Locator;
    readonly emptyMessage: Locator;

    constructor(readonly page: Page) {
        this.heading = page.getByRole("heading", { name: "Create Exam" });
        this.form = page.locator('form[action="/exams/add"]');
        this.nameInput = this.form.locator('input[name="exam_name"]');
        this.levelSelect = this.form.locator('select[name="level_id"]');
        this.academicYearInput = this.form.locator('input[name="academic_year"]');
        this.examDateInput = this.form.locator('input[name="exam_date"]');
        this.feeAmountInput = this.form.locator('input[name="fee_amount"]');
        this.createButton = this.form.getByRole("button", { name: "Create Exam" });
        this.table = page.getByRole("table");
        this.rows = this.table.locator("tbody").getByRole("row");
        this.emptyMessage = this.table.getByText("No exams created yet");
    }

    async goto(): Promise<void> {
        await this.page.goto("/exams");
        await this.heading.waitFor();
    }

    row(examName: string): Locator {
        return this.rows.filter({ hasText: examName });
    }

    /** Columns: Exam, Level, Academic Year, Date, Fee, Action */
    cell(examName: string, column: "exam" | "level" | "academicYear" | "date" | "fee"): Locator {
        const index = { exam: 0, level: 1, academicYear: 2, date: 3, fee: 4 }[column];
        return this.row(examName).getByRole("cell").nth(index);
    }

    enterMarksLink(examName: string): Locator { return this.row(examName).getByRole("link", { name: /Enter Marks/ }); }
    resultsLink(examName: string): Locator { return this.row(examName).getByRole("link", { name: /Results/ }); }
    deleteLink(examName: string): Locator { return this.row(examName).getByRole("link", { name: "Delete" }); }

    /** Fills only the fields given, so validation tests can leave required ones blank. */
    async fill(f: ExamForm): Promise<void> {
        if (f.name !== undefined) await this.nameInput.fill(f.name);
        if (f.level !== undefined) await this.levelSelect.selectOption({ label: f.level });
        if (f.academicYear !== undefined) await this.academicYearInput.fill(f.academicYear);
        if (f.examDate !== undefined) await this.examDateInput.fill(f.examDate);
        if (f.feeAmount !== undefined) await this.feeAmountInput.fill(String(f.feeAmount));
    }

    async submit(): Promise<void> {
        await this.createButton.click();
        await this.page.waitForLoadState("domcontentloaded");
    }

    async createExam(f: ExamForm): Promise<void> {
        await this.fill(f);
        await this.submit();
    }

    /** Turns off the browser's `required` checks so the server-side handling can be exercised. */
    async disableBrowserValidation(): Promise<void> {
        await this.form.evaluate((f: HTMLFormElement) => { f.noValidate = true; });
    }

    /** Clicks Delete and answers the "Delete this exam and all its marks?" confirm. */
    async deleteExam(examName: string, { confirm = true }: { confirm?: boolean } = {}): Promise<void> {
        this.page.once("dialog", d => (confirm ? d.accept() : d.dismiss()));
        await this.deleteLink(examName).click();
        await this.page.waitForLoadState("domcontentloaded");
    }
}
