import type { Locator, Page } from "@playwright/test";

/** /fee-payments/:studentId - dues table on top, payment history below. */
export class FeePaymentsPage {
    constructor(readonly page: Page) {}

    dueRow(feeName: string): Locator {
        return this.page.locator("tbody tr", { hasText: feeName }).filter({ has: this.page.locator("button, .badge") }).first();
    }
    /** Dues columns with Simple Fee Mode OFF: Fee, Academic Year, Total, Discount, Net, Paid, Due, Action */
    dueCell(feeName: string, column: "total" | "net" | "paid" | "due"): Locator {
        const index = { total: 2, net: 4, paid: 5, due: 6 }[column];
        return this.dueRow(feeName).getByRole("cell").nth(index);
    }
    /** "Paid" / "Not Paid" badge. Badges have no ARIA role, so this one stays CSS. */
    statusBadge(feeName: string): Locator { return this.dueRow(feeName).locator(".badge").first(); }
    collectButton(feeName: string): Locator { return this.dueRow(feeName).getByRole("button", { name: "Collect", exact: true }); }
    markPaidButton(feeName: string): Locator { return this.dueRow(feeName).getByRole("button", { name: /Mark Paid$/ }); }

    /** Payment history rows (the table whose header has "Receipt No."). */
    get historyRows(): Locator {
        return this.page.locator("table", { has: this.page.locator("th", { hasText: "Receipt No." }) }).locator("tbody tr");
    }
    get payAmount(): Locator { return this.page.locator("#payAmount"); }

    async goto(studentId: number): Promise<void> { await this.page.goto(`/fee-payments/${studentId}`); }

    /**
     * Both forms POST and redirect back to this same URL, so waitForURL would resolve at once.
     * Waiting for the POST's response means the next read sees the saved payment.
     */
    private async submitAndWait(path: RegExp, click: () => Promise<void>): Promise<void> {
        const posted = this.page.waitForResponse(r => r.request().method() === "POST" && path.test(new URL(r.url()).pathname));
        await click();
        await posted;
        await this.page.waitForLoadState("domcontentloaded");
    }

    async collect(feeName: string, amount: number): Promise<void> {
        await this.collectButton(feeName).click();
        await this.payAmount.fill(String(amount));
        await this.submitAndWait(/^\/fee-payments\/pay$/, () => this.page.getByRole("button", { name: "Save Payment" }).click());
    }

    async markPaid(feeName: string): Promise<void> {
        this.page.once("dialog", d => d.accept());
        await this.submitAndWait(/^\/fee-payments\/mark-paid$/, () => this.markPaidButton(feeName).click());
    }

    /** Payment history columns: Date, Receipt No., Amount, Mode, ... (Receipt No. is column index 1). */
    async receiptNumbers(): Promise<string[]> {
        const cells = await this.historyRows.locator("td:nth-child(2)").allTextContents();
        return cells.map(c => c.trim()).filter(Boolean);
    }
}
