class AttendancePage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/attendance");
    }

    /** Loads the student-checkbox form for a given date + class. */
    async loadFor(date, className) {
        await this.page.fill('input[name="attendance_date"]', date);
        await this.page.selectOption('select[name="class_id"]', { label: className });
        await this.page.click('button:has-text("Load Students")');
        await this.page.waitForLoadState("networkidle");
    }

    /**
     * Sets exactly which students (by name) are checked Present, unchecking
     * everyone else - deliberately supports checking just ONE student, since
     * that's the historical regression case (single-checkbox body-parsing bug
     * where Express parses one checked checkbox as a string instead of an
     * array, previously crashing the save route).
     */
    async setPresentByName(names) {
        const rows = this.page.locator("tbody tr");
        const count = await rows.count();
        for (let i = 0; i < count; i++) {
            const row = rows.nth(i);
            const rowText = await row.textContent();
            const checkbox = row.locator('input[name="student"]');
            const shouldBeChecked = names.some(n => rowText.includes(n));
            if (shouldBeChecked) await checkbox.check();
            else await checkbox.uncheck();
        }
    }

    async save() {
        await this.page.click('button:has-text("Save Attendance")');
    }

}

class SettingsPage {

    constructor(page) {
        this.page = page;
    }

    async goto() {
        await this.page.goto("/settings");
    }

    async isSimpleFeeModeOn() {
        return this.page.isChecked('input[name="simple_fee_mode"]');
    }

    /** Toggles Simple Fee Mode to the given target state (true = ON). The
     *  checkbox auto-submits its form on change (see settings.ejs). */
    async setSimpleFeeMode(target) {
        const checkbox = this.page.locator('input[name="simple_fee_mode"]');
        const isOn = await checkbox.isChecked();
        if (isOn !== target) {
            await checkbox.click();
            await this.page.waitForLoadState("networkidle");
        }
    }

}

module.exports = { AttendancePage, SettingsPage };
