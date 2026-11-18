import { test, expect } from "../fixtures";
import { SchoolApi, SuperAdminApi, loginApi, newContext } from "../support/api";
import { FeePaymentsPage } from "../pages/fees.page";
import { DEFAULT_PASSWORD, uniqueEmail, uniqueSuffix } from "../support/data";
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

async function setSimpleFeeMode(api: SchoolApi, on: boolean): Promise<void> {
    const res = await api.ctx.post("/settings/fee-mode", { form: on ? { simple_fee_mode: "on" } : {}, maxRedirects: 0 });
    expect(res.status(), "set Simple Fee Mode").toBe(302);
}

/** Runs `fn` with a second school's Admin session, always disposing it. */
async function withOtherSchool<T>(superAdmin: SuperAdminApi, baseURL: string | undefined, fn: (api: SchoolApi) => Promise<T>): Promise<T> {
    const school = await superAdmin.createSchool();
    const ctx = await newContext(String(baseURL));
    try {
        await loginApi(ctx, school.adminEmail, school.password);
        return await fn(new SchoolApi(ctx, school));
    } finally {
        await ctx.dispose();
    }
}

/** Posts a payment directly, bypassing the form, and returns the HTTP status. */
async function postPayment(api: SchoolApi, studentId: number, structureId: number, amount: string): Promise<number> {
    const res = await api.ctx.post("/fee-payments/pay", {
        form: { student_id: String(studentId), fee_structure_id: String(structureId), amount_paid: amount, mode: "Cash" }, maxRedirects: 0
    });
    return res.status();
}

test.describe("Fees", () => {

    test("a partial payment reduces the amount due", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await expect(fees.dueCell("Tuition Fee", "due")).toHaveText("₹10000");

        await fees.collect("Tuition Fee", 4000);
        await expect(fees.dueCell("Tuition Fee", "paid")).toHaveText("₹4000");
        await expect(fees.dueCell("Tuition Fee", "due")).toHaveText("₹6000");
        await expect(fees.historyRows).toHaveCount(1);
    });

    test("paying the full amount marks the fee as Paid", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await fees.collect("Tuition Fee", 10000);
        await expect(fees.statusBadge("Tuition Fee")).toHaveText("Paid");
        await expect(fees.collectButton("Tuition Fee")).toHaveCount(0);
    });

    test("each payment gets its own receipt number", async ({ adminPage: page, adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        await adminApi.pay(studentId, structureId, 1000);
        await adminApi.pay(studentId, structureId, 2000);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await expect(fees.historyRows).toHaveCount(2);
        const receipts = await fees.receiptNumbers();
        expect(new Set(receipts).size).toBe(2);
        for (const r of receipts) expect(r).not.toBe("-");

        const stored = await dbAll<{ receipt_no: string }>("SELECT receipt_no FROM fee_payments WHERE student_id=?", [studentId]);
        expect(stored.map(s => s.receipt_no).sort()).toEqual([...receipts].sort());
    });

    test("Simple Fee Mode hides amounts and shows Not Paid", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        await setSimpleFeeMode(adminApi, true);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await expect(fees.dueRow("Tuition Fee")).not.toContainText("₹");
        await expect(fees.statusBadge("Tuition Fee")).toHaveText("Not Paid");
    });

    test("in Simple Fee Mode, Mark Paid settles the fee in one click", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        await setSimpleFeeMode(adminApi, true);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await fees.markPaid("Tuition Fee");
        await expect(fees.statusBadge("Tuition Fee")).toHaveText("Paid");
        await expect(fees.markPaidButton("Tuition Fee")).toHaveCount(0);
    });

    test("in Simple Fee Mode, a partial payment posted directly is refused", async ({ adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        await setSimpleFeeMode(adminApi, true);

        expect(await postPayment(adminApi, studentId, structureId, "100")).toBe(403);
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

    test("a payment against a fee item for a different level is refused", async ({ adminApi }) => {
        const { studentId } = await feeSetup(adminApi);
        const otherLevel = await adminApi.addListItem("level", "Level 2");
        const otherFee = await adminApi.addFeeStructure({
            levelId: otherLevel, categoryId: await adminApi.addFeeCategory("Level 2 Fee"), amount: 900
        });

        expect(await postPayment(adminApi, studentId, otherFee, "100")).toBe(403);
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

    test("a payment against another school's fee item is refused", async ({ adminApi, superAdmin, baseURL }) => {
        const { studentId } = await feeSetup(adminApi);
        const otherFee = await withOtherSchool(superAdmin, baseURL, async apiB => (await feeSetup(apiB)).structureId);

        expect(await postPayment(adminApi, studentId, otherFee, "100")).toBe(403);
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

    test("a role without Fee Payments cannot open the page or record a payment", async ({ page, school, superAdmin, adminApi, loginAs }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        const roleName = `QA No Fee Payments ${uniqueSuffix()}`;
        await superAdmin.createRole(roleName, ["attendance"]);
        const email = uniqueEmail("no-fee-payments");
        await superAdmin.addUser(school.id, { name: "No Fees User", email, role: roleName });
        await loginAs(email, DEFAULT_PASSWORD);

        expect((await page.goto(`/fee-payments/${studentId}`))?.status()).toBe(403);
        const res = await page.request.post("/fee-payments/pay", {
            form: { student_id: String(studentId), fee_structure_id: String(structureId), amount_paid: "100", mode: "Cash" }, maxRedirects: 0
        });
        expect(res.status()).toBe(403);
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

    test("invalid payment amounts (negative, zero, non-numeric, blank) are refused", async ({ adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        for (const amount of ["-500", "0", "abc", "", "Infinity"]) {
            expect(await postPayment(adminApi, studentId, structureId, amount), `amount ${JSON.stringify(amount)}`).toBe(400);
        }
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

    test("a decimal payment amount is accepted and stored as a number", async ({ adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        expect(await postPayment(adminApi, studentId, structureId, " 250.50 ")).toBe(302);
        const rows = await dbAll<{ amount_paid: number }>("SELECT amount_paid FROM fee_payments WHERE student_id=?", [studentId]);
        expect(rows).toEqual([{ amount_paid: 250.5 }]);
    });

    test("a refused payment does not use up a receipt number", async ({ adminApi }) => {
        const { studentId, structureId } = await feeSetup(adminApi);
        const nextReceipt = async () => (await dbAll<{ n: number }>(
            "SELECT receipt_no_next AS n FROM schools WHERE id=?", [adminApi.school.id]))[0].n;
        const before = await nextReceipt();

        expect(await postPayment(adminApi, studentId, structureId, "-1")).toBe(400);   // invalid amount
        expect(await postPayment(adminApi, studentId, 999999, "100")).toBe(403);      // not this student's fee item
        expect(await nextReceipt()).toBe(before);

        expect(await postPayment(adminApi, studentId, structureId, "100")).toBe(302);
        expect(await nextReceipt()).toBe(before + 1);
    });

    test("BUG: receipt numbers are per school (second school's first payment works)", async ({ superAdmin, adminApi, baseURL }) => {
        test.fail(true, "Known bug: fee_payments.receipt_no is UNIQUE across ALL schools, so two schools both issuing RCPT-0001 collide.");
        // Both schools keep the default "RCPT" prefix, as real schools would.
        const a = await feeSetup(adminApi, "Tuition Fee", 10000, false);
        await adminApi.pay(a.studentId, a.structureId, 500);

        const paidB = await withOtherSchool(superAdmin, baseURL, async apiB => {
            const b = await feeSetup(apiB, "Tuition Fee", 10000, false);
            await postPayment(apiB, b.studentId, b.structureId, "500");
            return dbAll("SELECT id FROM fee_payments WHERE student_id=?", [b.studentId]);
        });
        expect(paidB, "School B's payment was not stored").toHaveLength(1);
    });

    test("an apostrophe in a fee name does not break the Collect button", async ({ adminPage: page, adminApi }) => {
        const { studentId } = await feeSetup(adminApi, "Founder's Day Fee", 750);
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(e.message));

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        await fees.collectButton("Founder").click();
        await expect(fees.payAmount).toBeVisible();
        await expect(fees.payAmount).toHaveValue("750");
        await expect(fees.payFeeName).toHaveText("Founder's Day Fee");
        expect(errors).toEqual([]);
    });

    test("with an apostrophe in the fee name, Mark Paid still asks first and cancelling saves nothing", async ({ adminPage: page, adminApi }) => {
        // Before the fix the onclick didn't compile, so the form submitted with no confirmation at all.
        const { studentId } = await feeSetup(adminApi, "Founder's Day Fee", 750);
        await setSimpleFeeMode(adminApi, true);

        const fees = new FeePaymentsPage(page);
        await fees.goto(studentId);
        // click() cannot finish while confirm() is open, so answer it from a listener.
        const messages: string[] = [];
        page.once("dialog", d => { messages.push(d.message()); void d.dismiss(); });
        await fees.markPaidButton("Founder").click();

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("Founder's Day Fee");
        await expect(fees.statusBadge("Founder")).toHaveText("Not Paid");
        expect(await dbAll("SELECT id FROM fee_payments WHERE student_id=?", [studentId])).toEqual([]);
    });

});
