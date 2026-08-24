class StudentsPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/students");
    }

    async search(name) {
        await this.page.fill('input[name="search"]', name);
        await this.page.keyboard.press("Enter");
    }

    async clickAddStudent() {
        await this.page.click('a:has-text("Register Student")');
    }

    async isStudentListed(name) {
        return this.page.locator("table", { hasText: name }).count().then(c => c > 0);
    }

    async admissionNoFor(name) {
        const row = this.page.locator("tr", { hasText: name });
        return row.locator("td").nth(3).textContent(); // ID, Photo, Name, Admission No., ...
    }

}

class AddStudentPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/students/add");
    }

    /**
     * Fills only the fields provided - leaves everything else blank, which
     * is exactly how a mandatory-field validation test needs to work (omit
     * a required field, expect the error banner).
     */
    async fillBasics({ name, age, className, guardianName, guardianPhone, admissionNo }) {
        if (name !== undefined) await this.page.fill('input[name="name"]', name);
        if (age !== undefined) await this.page.fill('input[name="age"]', String(age));
        if (className !== undefined) await this.page.selectOption('select[name="class_id"]', { label: className });
        if (guardianName !== undefined) await this.page.fill('input[name="guardian_name"]', guardianName);
        if (guardianPhone !== undefined) await this.page.fill('input[name="guardian_phone"]', guardianPhone);
        if (admissionNo !== undefined) {
            const field = this.page.locator('input[name="admission_no"]');
            // Auto-assign mode shows this field disabled - skip filling it then.
            if (await field.isEnabled()) await field.fill(admissionNo);
        }
    }

    async submit() {
        await this.page.click('button:has-text("Save Student")');
    }

    async errorMessage() {
        return this.page.locator(".alert-danger").textContent();
    }

    async admissionNoPreview() {
        // Auto-assign mode shows the next number in a disabled input.
        return this.page.inputValue('input[name="admission_no"]');
    }

}

class ClassesPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/classes");
    }

    async addClass(className) {
        await this.page.click('a:has-text("Add Class")');
        await this.page.fill('input[name="class_name"]', className);
        await this.page.click('button:has-text("Save")');
    }

}

module.exports = { StudentsPage, AddStudentPage, ClassesPage };
