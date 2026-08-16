class LoginPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/login");
    }

    async login(email, password) {
        await this.page.fill('input[name="email"]', email);
        await this.page.fill('input[name="password"]', password);
        await this.page.click('button:has-text("Log In")');
    }

    async errorMessage() {
        return this.page.locator(".alert-danger").textContent();
    }

    async emailFieldValue() {
        return this.page.inputValue('input[name="email"]');
    }

}

class ChooseAccountPage {

    constructor(page) {
        this.page = page;
    }

    async accountOptionsCount() {
        return this.page.locator('input[name="account_id"]').count();
    }

    async pickAccountBySchoolName(schoolName) {
        // Each radio's containing <label> shows the school name in a <strong>
        const label = this.page.locator("label.list-group-item", { hasText: schoolName });
        await label.locator('input[name="account_id"]').check();
        await this.page.click('button:has-text("Continue")');
    }

}

module.exports = { LoginPage, ChooseAccountPage };
