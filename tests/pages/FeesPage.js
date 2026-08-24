class FeeCategoryPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/fees");
    }

    async addCategory(feeName) {
        await this.page.fill('input[name="fee_name"]', feeName);
        await this.page.click('button:has-text("Save Fee Category")');
    }

}

class FeeStructurePage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/fee-structure");
    }

    async addStructure({ className, categoryName, academicYear, amount }) {
        await this.page.selectOption('select[name="class_id"]', { label: className });
        await this.page.selectOption('select[name="fee_category_id"]', { label: categoryName });
        await this.page.fill('input[name="academic_year"]', academicYear);
        await this.page.fill('input[name="amount"]', String(amount));
        await this.page.click('button:has-text("Save Fee Structure")');
    }

}

class FeePaymentsPage {

    constructor(page) {
        this.page = page;
    }

    async gotoForStudent(studentId) {
        await this.page.goto(`/fee-payments/${studentId}`);
    }

    /** Clicks "Collect" for a fee row identified by its fee name, fills the amount, submits. */
    async collect(feeName, amount) {
        const row = this.page.locator("tr", { hasText: feeName });
        await row.locator('button:has-text("Collect")').click();
        await this.page.fill("#payAmount", String(amount));
        await this.page.click('button:has-text("Save Payment")');
    }

    /** Clicks the one-click "Mark Paid" button (Simple Fee Mode ON) for a fee row. */
    async markPaid(feeName) {
        const row = this.page.locator("tr", { hasText: feeName });
        this.page.once("dialog", dialog => dialog.accept());
        await row.locator('button:has-text("Mark Paid")').click();
    }

    async dueTextFor(feeName) {
        const row = this.page.locator("tr", { hasText: feeName });
        return row.textContent();
    }

    async statusBadgeFor(feeName) {
        const row = this.page.locator("tr", { hasText: feeName });
        return row.locator(".badge").first().textContent();
    }

}

module.exports = { FeeCategoryPage, FeeStructurePage, FeePaymentsPage };
