import type { Locator, Page } from "@playwright/test";

export class StudentsPage {
    constructor(readonly page: Page) {}
    get table(): Locator { return this.page.locator("table"); }
    row(name: string): Locator { return this.page.locator("tbody tr", { hasText: name }); }

    async goto(): Promise<void> { await this.page.goto("/students"); }
    async search(name: string): Promise<void> {
        await this.page.locator('input[name="search"]').first().fill(name);
        await this.page.keyboard.press("Enter");
        await this.page.waitForLoadState("domcontentloaded");
    }
    /** Columns: ID, Photo, Name, Roll No., Level, WhatsApp 1, Face Enrolled, Action */
    async rollNoFor(name: string): Promise<string> {
        return ((await this.row(name).locator("td").nth(3).textContent()) ?? "").trim();
    }
}

export interface StudentForm {
    name?: string; age?: number; className?: string; guardianName?: string; guardianPhone?: string;
}

export class AddStudentPage {
    constructor(readonly page: Page) {}
    get error(): Locator { return this.page.locator(".alert-danger"); }
    get classOptions(): Locator { return this.page.locator('select[name="class_id"] option'); }

    async goto(): Promise<void> { await this.page.goto("/students/add"); }

    /** Fills only the fields given, so validation tests can leave required ones blank. */
    async fill(f: StudentForm): Promise<void> {
        if (f.name !== undefined) await this.page.fill('input[name="name"]', f.name);
        if (f.age !== undefined) await this.page.fill('input[name="age"]', String(f.age));
        if (f.className !== undefined) await this.page.selectOption('select[name="class_id"]', { label: f.className });
        if (f.guardianName !== undefined) await this.page.fill('input[name="guardian_name"]', f.guardianName);
        if (f.guardianPhone !== undefined) await this.page.fill('input[name="guardian_phone"]', f.guardianPhone);
    }
    async submit(): Promise<void> { await this.page.click('button:has-text("Save Student")'); }
}
