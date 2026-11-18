import type { Locator, Page } from "@playwright/test";

export class AttendancePage {
    constructor(readonly page: Page) {}
    get rosterRows(): Locator { return this.page.locator("#attendanceForm tbody tr"); }
    get smartSearch(): Locator { return this.page.locator("#smartSearch"); }
    get smartSearchResults(): Locator { return this.page.locator("#smartSearchResults"); }
    /** "Add from Different Batch" search - only rendered once a batch's roster is loaded. */
    get crossBatchSearch(): Locator { return this.page.locator("#crossBatchSearch"); }
    get crossBatchResults(): Locator { return this.page.locator("#crossBatchResults"); }

    async goto(): Promise<void> { await this.page.goto("/attendance"); }

    async load(date: string, batchName: string): Promise<void> {
        await this.page.fill('input[name="attendance_date"]', date);
        await this.page.locator("#batchSelect").selectOption({ label: batchName });
        await this.page.click('button:has-text("Load Students")');
        await this.page.waitForLoadState("domcontentloaded");
    }

    /** Ticks exactly the named students as Present and unticks everyone else. */
    async setPresent(names: string[]): Promise<void> {
        const count = await this.rosterRows.count();
        for (let i = 0; i < count; i++) {
            const row = this.rosterRows.nth(i);
            const box = row.locator('input[name="student"]');
            if (await box.count() === 0) continue;
            const text = (await row.textContent()) ?? "";
            await box.setChecked(names.some(n => text.includes(n)));
        }
    }

    async save(): Promise<void> {
        await this.page.locator("#attendanceForm button.btn-success").last().click();
        await this.page.waitForLoadState("domcontentloaded");
    }
}
