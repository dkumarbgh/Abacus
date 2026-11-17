import type { Locator, Page } from "@playwright/test";

/** /fee-payments/:studentId - dues table on top, payment history below. */
export class FeePaymentsPage {
    constructor(readonly page: Page) {}

    dueRow(feeName: string): Locator {
        return this.page.locator("tbody tr", { hasText: feeName }).filter({ has: this.page.locator("button, .badge") }).first();
    }
    /** Payment history rows (the table whose header has "Receipt No."). */
    get historyRows(): Locator {
        return this.page.locator("table", { has: this.page.locator("th", { hasText: "Receipt No." }) }).locator("tbody tr");
    }
    get payAmount(): Locator { return this.page.locator("#payAmount"); }

    async goto(studentId: number): Promise<void> { await this.page.goto(`/fee-payments/${studentId}`); }

    async collect(feeName: string, amount: number): Promise<void> {
        await this.dueRow(feeName).locator('button:has-text("Collect")').click();
        await this.payAmount.fill(String(amount));
        await this.page.click('button:has-text("Save Payment")');
        await this.page.waitForLoadState("domcontentloaded");
    }

    async markPaid(feeName: string): Promise<void> {
        this.page.once("dialog", d => d.accept());
        await this.dueRow(feeName).locator('button:has-text("Mark Paid")').click();
        await this.page.waitForLoadState("domcontentloaded");
    }

    /** Payment history columns: Date, Receipt No., Amount, Mode, ... (Receipt No. is column index 1). */
    async receiptNumbers(): Promise<string[]> {
        const cells = await this.historyRows.locator("td:nth-child(2)").allTextContents();
        return cells.map(c => c.trim()).filter(Boolean);
    }
}
