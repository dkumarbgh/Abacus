import { test as base, expect } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";
import { DEFAULT_PASSWORD, uniqueEmail } from "../support/data";
import type { SchoolApi } from "../support/api";
import { dbAll } from "../support/db";

/**
 * Mobile-app JSON API (JWT). No browser. Face matching itself needs the
 * face-service and stays a manual case; the test server runs with
 * FEATURE_FACE_RECOGNITION=false.
 */
interface ApiSchool { token: string; email: string; classId: number; className: string; studentId: number; }

async function tokenFor(request: APIRequestContext, email: string, password = DEFAULT_PASSWORD): Promise<string> {
    const res = await request.post("/api/login", { data: { email, password } });
    expect(res.status(), `api login for ${email}`).toBe(200);
    return (await res.json()).token;
}

async function setupApiSchool(request: APIRequestContext, api: SchoolApi): Promise<ApiSchool> {
    const className = `API Class ${api.school.id}`;
    const classId = await api.addClass(className);
    const studentId = await api.addStudent({ name: "API Test Student", classId, guardianPhone: "9990001111" });
    return { token: await tokenFor(request, api.school.adminEmail), email: api.school.adminEmail, classId, className, studentId };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const test = base.extend<{ a: ApiSchool; b: ApiSchool }>({
    a: async ({ request, adminApi }, use) => { await use(await setupApiSchool(request, adminApi)); },
    b: async ({ request, superAdmin, baseURL }, use) => {
        const { SchoolApi, newContext, loginApi } = await import("../support/api");
        const school = await superAdmin.createSchool();
        const ctx = await newContext(String(baseURL));
        await loginApi(ctx, school.adminEmail, school.password);
        const api = new SchoolApi(ctx, school);
        await use(await setupApiSchool(request, api));
        await api.dispose();
    }
});

test.describe("API - /api/login", () => {
    test("valid credentials return a token and user info", async ({ request, school }) => {
        const res = await request.post("/api/login", { data: { email: school.adminEmail, password: school.password } });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.token).toBeTruthy();
        expect(body.user.role).toBe("Admin");
    });

    test("wrong password is rejected", async ({ request, school }) => {
        const res = await request.post("/api/login", { data: { email: school.adminEmail, password: "definitely-wrong" } });
        expect(res.status()).toBe(401);
        expect((await res.json()).error).toMatch(/invalid/i);
    });

    test("unknown email gets the same generic message", async ({ request }) => {
        const res = await request.post("/api/login", { data: { email: uniqueEmail("nobody"), password: "x" } });
        expect(res.status()).toBe(401);
        expect((await res.json()).error).toMatch(/invalid/i);
    });

    test("missing password does not crash the server", async ({ request, school }) => {
        const res = await request.post("/api/login", { data: { email: school.adminEmail } });
        expect(res.status()).toBe(401);
    });
});

test.describe("API - /api/classes", () => {
    test("valid token returns this school's classes", async ({ request, a }) => {
        const res = await request.get("/api/classes", { headers: auth(a.token) });
        expect(res.status()).toBe(200);
        const classes: Array<{ class_name: string }> = await res.json();
        expect(classes.map(c => c.class_name)).toContain(a.className);
    });

    test("no Authorization header is rejected", async ({ request }) => {
        const res = await request.get("/api/classes");
        expect(res.status()).toBe(401);
        expect((await res.json()).error).toMatch(/missing authorization/i);
    });

    test("garbage token is rejected", async ({ request }) => {
        const res = await request.get("/api/classes", { headers: auth("not-a-real-token") });
        expect(res.status()).toBe(401);
        expect((await res.json()).error).toMatch(/invalid or expired/i);
    });

    test("tenant isolation: School A's token never returns School B's classes", async ({ request, a, b }) => {
        const classes: Array<{ id: number; class_name: string }> = await (await request.get("/api/classes", { headers: auth(a.token) })).json();
        expect(classes.map(c => c.id)).toEqual([a.classId]);
        expect(classes.map(c => c.class_name)).not.toContain(b.className);
    });
});

test.describe("API - /api/classes/:id/students", () => {
    test("returns this school's students for its own class", async ({ request, a }) => {
        const students: Array<{ id: number }> = await (await request.get(`/api/classes/${a.classId}/students`, { headers: auth(a.token) })).json();
        expect(students.map(s => s.id)).toEqual([a.studentId]);
    });

    test("returns [] for another school's class_id", async ({ request, a, b }) => {
        const res = await request.get(`/api/classes/${b.classId}/students`, { headers: auth(a.token) });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    test("returns [] for a non-existent class_id", async ({ request, a }) => {
        const res = await request.get("/api/classes/999999/students", { headers: auth(a.token) });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    test("no Authorization header is rejected", async ({ request }) => {
        expect((await request.get("/api/classes/1/students")).status()).toBe(401);
    });
});

test.describe("API - /api/attendance/manual", () => {
    const rowsFor = (studentId: number, date: string) =>
        dbAll<{ status: string }>("SELECT status FROM attendance WHERE student_id=? AND attendance_date=?", [studentId, date]);

    test("creates a new attendance record", async ({ request, a }) => {
        const res = await request.post("/api/attendance/manual", {
            headers: auth(a.token), data: { student_id: a.studentId, attendance_date: "2026-08-18", status: "Present" }
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).ok).toBe(true);
        expect(await rowsFor(a.studentId, "2026-08-18")).toEqual([{ status: "Present" }]);
    });

    test("posting again for the same student+date updates instead of duplicating", async ({ request, a }) => {
        for (const status of ["Present", "Absent"]) {
            const res = await request.post("/api/attendance/manual", {
                headers: auth(a.token), data: { student_id: a.studentId, attendance_date: "2026-08-19", status }
            });
            expect(res.status()).toBe(200);
        }
        expect(await rowsFor(a.studentId, "2026-08-19")).toEqual([{ status: "Absent" }]);
    });

    test("a student_id from another school is rejected", async ({ request, a, b }) => {
        const res = await request.post("/api/attendance/manual", {
            headers: auth(a.token), data: { student_id: b.studentId, attendance_date: "2026-08-18", status: "Present" }
        });
        expect(res.status()).toBe(403);
        expect((await res.json()).error).toMatch(/not found for your school/i);
        expect(await rowsFor(b.studentId, "2026-08-18")).toEqual([]);
    });

    test("no Authorization header is rejected", async ({ request }) => {
        const res = await request.post("/api/attendance/manual", { data: { student_id: 1, attendance_date: "2026-08-18", status: "Present" } });
        expect(res.status()).toBe(401);
    });

    test("a view-only user's API token cannot write attendance", async ({ request, a, superAdmin, school }) => {
        const email = uniqueEmail("viewonly-api");
        await superAdmin.addUser(school.id, { name: "Demo Viewer", email, role: "Teacher", readOnly: true });
        const token = await tokenFor(request, email);
        const res = await request.post("/api/attendance/manual", {
            headers: auth(token), data: { student_id: a.studentId, attendance_date: "2026-08-20", status: "Present" }
        });
        expect(res.status()).toBe(403);
        expect(await rowsFor(a.studentId, "2026-08-20")).toEqual([]);
    });
});

test.describe("API - /attendance/face-mark", () => {
    test("no Authorization header is rejected before any file processing", async ({ request }) => {
        expect((await request.post("/attendance/face-mark", { multipart: { class_id: "1" } })).status()).toBe(401);
    });

    test("with face recognition switched off, a valid token is still refused", async ({ request, a }) => {
        const res = await request.post("/attendance/face-mark", { headers: auth(a.token), multipart: { class_id: String(a.classId) } });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
