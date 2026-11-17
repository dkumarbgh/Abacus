import type { Locator, Page } from "@playwright/test";

export class LoginPage {
    constructor(readonly page: Page) {}
    get error(): Locator { return this.page.locator(".alert-danger"); }
    async goto(): Promise<void> { await this.page.goto("/login"); }
    async login(email: string, password: string): Promise<void> {
        await this.page.fill('input[name="email"]', email);
        await this.page.fill('input[name="password"]', password);
        await this.page.click('button:has-text("Log In")');
    }
    async emailFieldValue(): Promise<string> { return this.page.inputValue('input[name="email"]'); }
}

export class ChooseAccountPage {
    constructor(readonly page: Page) {}
    get options(): Locator { return this.page.locator('input[name="account_id"]'); }
    async pickBySchoolName(schoolName: string): Promise<void> {
        await this.page.locator("label.list-group-item", { hasText: schoolName }).locator('input[name="account_id"]').check();
        await this.page.click('button:has-text("Continue")');
    }
}
