import { test, expect } from "../fixtures";
import type { SchoolApi } from "../support/api";
import { FeePaymentsPage } from "../pages/fees.page";
import { dbAll } from "../support/db";

/**
 * Class + Level + fee category + structure + one student on that level.
 * Gives the school its own receipt prefix by default: receipt_no is currently
 * UNIQUE across all schools (see the BUG test below), so with default settings
 * only the first school in a run could ever record a payment.
 */
async function feeSetup(api: SchoolApi, feeName = "Tuition Fee", amount = 10000, uniqueReceiptPrefix = true) {
    if (uniqueReceiptPrefix) await api.setReceiptPrefix(`S${api.school.id}-`);
    const classId = await api.addClass("Class 8");
    const levelId = await api.addListItem("level", "Level 1");
    const categoryId = await api.addFeeCategory(feeName);
    const structureId = await api.addFeeStructure({ levelId, categoryId, amount });
    const studentId = await api.addStudent({ name: "Fee Test Student", classId, levelId, guardianPhone: "9111111111" });
    return { studentId, structureId, levelId, classId };
}

test.describe("Fees", () => {

    test("a partial payment reduces the amount due", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await expect(fees.dueRow("Tuition Fee")).toContainText(/10,?000/);

        await fees.collect("Tuition Fee", 4000);
        await expect(fees.dueRow("Tuition Fee")).toContainText(/6,?000/);
        await expect(fees.historyRows).toHaveCount(1);
    });

    test("paying the full amount marks the fee as Paid", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await fees.collect("Tuition Fee", 10000);
        await expect(fees.dueRow("Tuition Fee").locator(".badge")).toContainText(/paid/i);
        await expect(fees.dueRow("Tuition Fee").locator('button:has-text("Collect")')).toHaveCount(0);
    });

    test("each payment gets its own receipt number", async ({ adminPage: page, adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        await adminApi.pay(studentId, structureId, 1000);
        await adminApi.pay(studentId, structureId, 2000);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        const receipts = await fees.receiptNumbers();
        expect(receipts).toHaveLength(2);
        expect(new Set(receipts).size).toBe(2);
        for (const r of receipts) expect(r).not.toBe("-");

        const stored = await dbAll<{ receipt_no: string }>("SELECT receipt_no FROM fee_payments WHERE student_id=? ORDER BY receipt_no", [studentId]);
        expect(stored.map(s => s.receipt_no).sort()).toEqual([...receipts].sort());
    });

    test("Simple Fee Mode hides amounts and Mark Paid settles a fee in one click", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const res = await adminApi.ctx.post("/settings/fee-mode", { form: { simple_fee_mode: "on" }, maxRedirects: 0 });
        expect(res.status()).toBe(302);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await expect(fees.dueRow("Tuition Fee")).not.toContainText("₹");
        await expect(fees.dueRow("Tuition Fee").locator(".badge")).toContainText(/not paid/i);

        await fees.markPaid("Tuition Fee");
        await expect(fees.dueRow("Tuition Fee").locator(".badge").first()).toHaveText(/^\s*paid\s*$/i);
    });

    test("BUG: receipt numbers are per school (second school's first payment works)", async ({ superAdmin, adminApi, baseURL }) => {
        test.fail(true, "Known bug: fee_payments.receipt_no is UNIQUE across ALL schools, so two schools both issuing RCPT-0001 collide.");
        // Both schools keep the default "RCPT" prefix, as real schools would.
        const a = await feeSetup(adminApi, "Tuition Fee", 10000, false);
        await adminApi.pay(a.studentId, a.structureId, 500);

        const { SchoolApi, newContext, loginApi } = await import("../support/api");
        const schoolB = await superAdmin.createSchool();
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, schoolB.adminEmail, schoolB.password);
        const apiB = new SchoolApi(ctx, schoolB);
        const b = await feeSetup(apiB, "Tuition Fee", 10000, false);
        await apiB.ctx.post("/fee-payments/pay", {
            form: { student_id: String(b.studentId), fee_structure_id: String(b.structureId), amount_paid: "500", mode: "Cash" }
        });
        const paidB = await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [b.studentId]);
        await apiB.dispose();
        expect(paidB, "School B's payment was not stored").toHaveLength(1);
    });

    test("BUG: an apostrophe in a fee name must not break the Collect button", async ({ adminPage: page, adminApi }) => {
        test.fail(true, "Known bug: payFee(..., '<%= displayName %>', ...) - an apostrophe ends the JS string, so Collect does nothing.");
        const { studentId } = await feeSetup(adminApi, "Founder's Day Fee", 750);
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(e.message));

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await fees.dueRow("Founder").locator('button:has-text("Collect")').click();
        await expect(fees.payAmount).toBeVisible({ timeout: 2000 });
        expect(errors).toEqual([]);
    });

});
