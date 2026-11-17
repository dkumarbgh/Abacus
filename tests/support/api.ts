import { expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { dbGet, latestId } from "./db";
import { DEFAULT_PASSWORD, SUPER_ADMIN, uniqueEmail, uniqueSchoolName } from "./data";

export type Role = "Admin" | "Teacher" | "Accountant";
export type ListType = "batch" | "level" | "course" | "branch";

export interface SchoolInfo { id: number; name: string; adminEmail: string; password: string; }
export interface StudentInput {
    name: string; classId: number; levelId?: number; batchId?: number; age?: number;
    guardianName?: string; guardianPhone?: string;
}

/** Logs an API context in through the real /login form. Returns the redirect target. */
export async function loginApi(ctx: APIRequestContext, email: string, password: string): Promise<string> {
    const res = await ctx.post("/login", { form: { email, password }, maxRedirects: 0 });
    expect(res.status(), `login POST for ${email}`).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location, `login for ${email} bounced back to /login`).not.toMatch(/^\/login$/);
    return location;
}

export async function newContext(baseURL: string): Promise<APIRequestContext> {
    return pwRequest.newContext({ baseURL });
}

/** Super Admin actions, done over HTTP (setup only - UI coverage lives in superAdmin.spec.ts). */
export class SuperAdminApi {
    constructor(readonly ctx: APIRequestContext) {}

    static async create(baseURL: string): Promise<SuperAdminApi> {
        const ctx = await newContext(baseURL);
        await loginApi(ctx, SUPER_ADMIN.email, SUPER_ADMIN.password);
        return new SuperAdminApi(ctx);
    }

    async createSchool(opts: Partial<Omit<SchoolInfo, "id">> = {}): Promise<SchoolInfo> {
        const info = {
            name: opts.name ?? uniqueSchoolName(),
            adminEmail: opts.adminEmail ?? uniqueEmail("admin"),
            password: opts.password ?? DEFAULT_PASSWORD
        };
        const res = await this.ctx.post("/super-admin/schools/new", {
            form: { school_name: info.name, admin_name: "Test Admin", admin_email: info.adminEmail, admin_password: info.password },
            maxRedirects: 0
        });
        expect(res.status(), "create school").toBe(302);
        const id = Number((res.headers()["location"] ?? "").match(/\/super-admin\/schools\/(\d+)/)?.[1]);
        expect(id, "new school id from redirect").toBeGreaterThan(0);
        return { id, ...info };
    }

    async addUser(schoolId: number, user: { name: string; email: string; password?: string; role: Role | string; readOnly?: boolean }): Promise<void> {
        const form: Record<string, string> = {
            name: user.name, email: user.email, password: user.password ?? DEFAULT_PASSWORD, role: user.role
        };
        if (user.readOnly) form.read_only = "on";
        const res = await this.ctx.post(`/super-admin/schools/${schoolId}/users/add`, { form, maxRedirects: 0 });
        expect(res.status(), `add ${user.role} user`).toBe(302);
    }

    /** Roles are GLOBAL (shared by every school) - always use a unique name per test. */
    async createRole(name: string, capabilities: string[]): Promise<number> {
        const res = await this.ctx.post("/super-admin/roles/new", { form: { name }, maxRedirects: 0 });
        expect(res.status(), "create role").toBe(302);
        const row = await dbGet<{ id: number }>("SELECT id FROM roles WHERE name=?", [name]);
        if (!row) throw new Error(`Role ${name} was not created`);
        await this.setCapabilities(row.id, capabilities);
        return row.id;
    }

    async setCapabilities(roleId: number, capabilities: string[]): Promise<void> {
        const form = new URLSearchParams();
        for (const c of capabilities) form.append("capabilities", c);
        const res = await this.ctx.post(`/super-admin/roles/${roleId}/capabilities`, {
            data: form.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0
        });
        expect(res.status(), "set capabilities").toBe(302);
    }

    async dispose(): Promise<void> { await this.ctx.dispose(); }
}

/** A school Admin's session, used to build test data quickly through the app's own routes. */
export class SchoolApi {
    constructor(readonly ctx: APIRequestContext, readonly school: SchoolInfo) {}

    private async postForm(url: string, form: Record<string, string | number>, what: string): Promise<void> {
        const res = await this.ctx.post(url, { form: Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)])), maxRedirects: 0 });
        if (res.status() !== 302) {
            const body = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
            throw new Error(`${what}: ${url} returned ${res.status()} - ${body}`);
        }
    }

    async addClass(name: string): Promise<number> {
        await this.postForm("/classes/add", { class_name: name }, "add class");
        return latestId("classes", this.school.id, "class_name=?", [name]);
    }

    async addListItem(type: ListType, name: string): Promise<number> {
        await this.postForm("/lists/add", { list_type: type, name }, `add ${type}`);
        return latestId("lookup_items", this.school.id, "list_type=? AND name=?", [type, name]);
    }

    async addStudent(s: StudentInput): Promise<number> {
        const multipart: Record<string, string> = {
            name: s.name, class_id: String(s.classId), age: String(s.age ?? 10),
            guardian_name: s.guardianName ?? "Guardian", guardian_phone: s.guardianPhone ?? "9000000000"
        };
        if (s.levelId) multipart.level_id = String(s.levelId);
        if (s.batchId) multipart.batch_id = String(s.batchId);
        const res = await this.ctx.post("/students/add", { multipart, maxRedirects: 0 });
        expect(res.status(), `add student ${s.name} (200 = validation error page)`).toBe(302);
        return latestId("students", this.school.id, "name=?", [s.name]);
    }

    async addFeeCategory(name: string): Promise<number> {
        await this.postForm("/fees/add", { fee_name: name }, "add fee category");
        return latestId("fee_categories", this.school.id, "fee_name=?", [name]);
    }

    async addFeeStructure(f: { levelId: number; categoryId: number; amount: number; academicYear?: string }): Promise<number> {
        await this.postForm("/fee-structure/add", {
            level_id: f.levelId, fee_category_id: f.categoryId, academic_year: f.academicYear ?? "2026-27", amount: f.amount
        }, "add fee structure");
        return latestId("fee_structure", this.school.id, "fee_category_id=?", [f.categoryId]);
    }

    async pay(studentId: number, feeStructureId: number, amount: number): Promise<void> {
        await this.postForm("/fee-payments/pay", {
            student_id: studentId, fee_structure_id: feeStructureId, amount_paid: amount, mode: "Cash"
        }, "record payment");
    }

    async setReceiptPrefix(prefix: string): Promise<void> {
        await this.postForm("/settings/receipt-no", { receipt_no_prefix: prefix, receipt_no_format: "sequential", receipt_no_digits: 4 }, "receipt settings");
    }

    async dispose(): Promise<void> { await this.ctx.dispose(); }
}
