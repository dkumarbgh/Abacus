class RegisterSchoolPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/register-school");
    }

    async register({ schoolName, adminName, adminEmail, password }) {
        await this.page.fill('input[name="school_name"]', schoolName);
        await this.page.fill('input[name="admin_name"]', adminName);
        await this.page.fill('input[name="admin_email"]', adminEmail);
        await this.page.fill('input[name="admin_password"]', password);
        await this.page.click('button:has-text("Create School & Log In")');
    }

}

module.exports = { RegisterSchoolPage };
