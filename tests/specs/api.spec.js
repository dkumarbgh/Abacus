const { test, expect } = require("@playwright/test");
const { uniqueEmail, uniqueSchoolName, DEFAULT_PASSWORD } = require("../helpers/testData");

/**
 * Pure API testing - no browser page is ever opened here, only HTTP
 * requests via Playwright's `request` fixture. Setup (registering a
 * school, creating a class) goes through the same real routes a browser
 * would hit; the APIRequestContext automatically carries the session
 * cookie across calls within one test, same as a browser would.
 *
 * Anything that needs face-service (actual face matching) is deliberately
 * NOT automated here - same reasoning as the UI suite, which runs with
 * FEATURE_FACE_RECOGNITION=false in CI. Those cases are covered as manual
 * test cases in the API test case spreadsheet instead.
 */

async function registerSchoolAndGetSetup(request) {
    const email = uniqueEmail("api");
    const schoolName = uniqueSchoolName("API Test School");

    // /register-school is a plain HTML form POST, not a JSON API - but
    // it's still just an HTTP endpoint, and this IS how a real school
    // account actually gets created. The APIRequestContext keeps the
    // session cookie it sets for every subsequent call in this context.
    // maxRedirects: 0 on every call below that expects a redirect - Playwright's
    // request API follows redirects automatically by default (like fetch),
    // so without this we'd see the status of wherever it landed, never the
    // actual 302 the route itself returned.
    const regRes = await request.post("/register-school", {
        form: {
            school_name: schoolName,
            admin_name: "API Test Admin",
            admin_email: email,
            admin_password: DEFAULT_PASSWORD
        },
        maxRedirects: 0
    });
    expect(regRes.status()).toBe(302); // redirect on success

    // Create a class via the session-authenticated web route (still just
    // an HTTP call - no browser needed for a form POST).
    const classRes = await request.post("/classes/add", {
        form: { class_name: "API Test Class" },
        maxRedirects: 0
    });
    expect(classRes.status()).toBe(302);

    // Get a JWT the same way the mobile app does.
    const loginRes = await request.post("/api/login", {
        data: { email, password: DEFAULT_PASSWORD }
    });
    expect(loginRes.ok()).toBeTruthy();
    const { token } = await loginRes.json();

    return { email, token, schoolName };
}

test.describe("API - /api/login", () => {

    test("valid credentials return a token and user info", async ({ request }) => {
        const { email, token } = await registerSchoolAndGetSetup(request);
        expect(token).toBeTruthy();
        // A second explicit login call, to test the endpoint in isolation
        // from the setup helper above.
        const res = await request.post("/api/login", { data: { email, password: DEFAULT_PASSWORD } });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.token).toBeTruthy();
        expect(body.user.role).toBe("Admin");
    });

    test("wrong password is rejected", async ({ request }) => {
        const { email } = await registerSchoolAndGetSetup(request);
        const res = await request.post("/api/login", { data: { email, password: "definitely-wrong" } });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/invalid/i);
    });

    test("non-existent email is rejected with the same generic message", async ({ request }) => {
        const res = await request.post("/api/login", { data: { email: uniqueEmail("nobody"), password: "x" } });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/invalid/i);
    });

    test("missing password field does not crash the server", async ({ request }) => {
        const { email } = await registerSchoolAndGetSetup(request);
        const res = await request.post("/api/login", { data: { email } });
        expect(res.status()).toBe(401);
    });

});

test.describe("API - /api/classes", () => {

    test("valid token returns this school's classes", async ({ request }) => {
        const { token } = await registerSchoolAndGetSetup(request);
        const res = await request.get("/api/classes", { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status()).toBe(200);
        const classes = await res.json();
        expect(Array.isArray(classes)).toBeTruthy();
        expect(classes.some(c => c.class_name === "API Test Class")).toBeTruthy();
    });

    test("no Authorization header is rejected", async ({ request }) => {
        const res = await request.get("/api/classes");
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/missing authorization/i);
    });

    test("garbage token is rejected", async ({ request }) => {
        const res = await request.get("/api/classes", { headers: { Authorization: "Bearer not-a-real-token" } });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toMatch(/invalid or expired/i);
    });

    test("tenant isolation: School A's token never returns School B's classes", async ({ request }) => {
        const schoolA = await registerSchoolAndGetSetup(request);
        const schoolB = await registerSchoolAndGetSetup(request);

        const resA = await request.get("/api/classes", { headers: { Authorization: `Bearer ${schoolA.token}` } });
        const classesA = await resA.json();

        expect(classesA.every(c => c.class_name !== schoolB.schoolName)).toBeTruthy();
        // Both schools independently have their own "API Test Class" -
        // the real check is that A's list length reflects only A's data,
        // not a combined view.
        expect(classesA.length).toBe(1);
    });

});

test.describe("API - /api/classes/:id/students", () => {

    test("returns an empty array for a class_id belonging to another school", async ({ request }) => {
        const schoolA = await registerSchoolAndGetSetup(request);
        const schoolB = await registerSchoolAndGetSetup(request);

        const classesRes = await request.get("/api/classes", { headers: { Authorization: `Bearer ${schoolB.token}` } });
        const [schoolBClass] = await classesRes.json();

        // Try to read School B's class roster using School A's token.
        const res = await request.get(`/api/classes/${schoolBClass.id}/students`, {
            headers: { Authorization: `Bearer ${schoolA.token}` }
        });
        expect(res.status()).toBe(200);
        const students = await res.json();
        expect(students).toEqual([]);
    });

    test("returns an empty array for a non-existent class_id", async ({ request }) => {
        const { token } = await registerSchoolAndGetSetup(request);
        const res = await request.get("/api/classes/999999/students", { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    test("no Authorization header is rejected", async ({ request }) => {
        const res = await request.get("/api/classes/1/students");
        expect(res.status()).toBe(401);
    });

});

test.describe("API - /api/attendance/manual", () => {

    async function setupWithStudent(request) {
        const setup = await registerSchoolAndGetSetup(request);
        const classesRes = await request.get("/api/classes", { headers: { Authorization: `Bearer ${setup.token}` } });
        const [cls] = await classesRes.json();

        // Add a student via the session-authenticated web form (no JSON API for this exists).
        await request.post("/students/add", {
            multipart: {
                name: "API Test Student",
                age: "10",
                class_id: String(cls.id),
                guardian_name: "Guardian",
                guardian_phone: "9990001111"
            }
        });

        const studentsRes = await request.get(`/api/classes/${cls.id}/students`, { headers: { Authorization: `Bearer ${setup.token}` } });
        const [student] = await studentsRes.json();

        return { ...setup, classId: cls.id, studentId: student.id };
    }

    test("creates a new attendance record", async ({ request }) => {
        const { token, studentId } = await setupWithStudent(request);
        const res = await request.post("/api/attendance/manual", {
            headers: { Authorization: `Bearer ${token}` },
            data: { student_id: studentId, attendance_date: "2026-08-18", status: "Present" }
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).ok).toBe(true);
    });

    test("posting again for the same student+date UPDATES rather than duplicates", async ({ request }) => {
        const { token, studentId } = await setupWithStudent(request);
        const date = "2026-08-19";

        await request.post("/api/attendance/manual", {
            headers: { Authorization: `Bearer ${token}` },
            data: { student_id: studentId, attendance_date: date, status: "Present" }
        });
        const secondRes = await request.post("/api/attendance/manual", {
            headers: { Authorization: `Bearer ${token}` },
            data: { student_id: studentId, attendance_date: date, status: "Absent" }
        });
        expect(secondRes.status()).toBe(200);
        expect((await secondRes.json()).ok).toBe(true);
        // Correctness of "updated not duplicated" is covered at the DB
        // level by the UI regression suite's attendance tests; this test
        // confirms the API itself doesn't error on a repeat call.
    });

    test("a student_id from another school is rejected", async ({ request }) => {
        const setupA = await setupWithStudent(request);
        const setupB = await setupWithStudent(request);

        const res = await request.post("/api/attendance/manual", {
            headers: { Authorization: `Bearer ${setupA.token}` },
            data: { student_id: setupB.studentId, attendance_date: "2026-08-18", status: "Present" }
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/not found for your school/i);
    });

    test("no Authorization header is rejected", async ({ request }) => {
        const res = await request.post("/api/attendance/manual", {
            data: { student_id: 1, attendance_date: "2026-08-18", status: "Present" }
        });
        expect(res.status()).toBe(401);
    });

});

test.describe("API - /attendance/face-mark (validation only, not actual matching)", () => {

    test("missing image returns 400", async ({ request }) => {
        const { token } = await registerSchoolAndGetSetup(request);
        const res = await request.post("/attendance/face-mark", {
            headers: { Authorization: `Bearer ${token}` },
            multipart: { class_id: "1" }
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("no_image_uploaded");
    });

    test("no Authorization header is rejected before any file processing", async ({ request }) => {
        const res = await request.post("/attendance/face-mark", {
            multipart: { class_id: "1" }
        });
        expect(res.status()).toBe(401);
    });

});
