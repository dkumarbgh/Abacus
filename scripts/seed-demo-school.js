/**
 * Creates ONE demo school filled with realistic but completely FAKE data -
 * meant for showing SimpleSchool to prospective schools (pair it with the
 * view-only "test" login from scripts/create-demo-user.js).
 *
 * What it creates: the school + an Admin login, classes, a course, 4
 * abacus Levels, 3 Batches (with weekly days), a branch, 3 teachers,
 * 2 subjects, 2 fee categories, a monthly Tuition fee plan per Level
 * (periods generated from each student's join date - same code the app
 * uses), 24 students, ~2 months of attendance, fee payments (most paid,
 * a few with dues so the Fees Due/Pending reports have something to
 * show), one exam with marks per Level, and a few referral leads.
 *
 * All names are invented and phone numbers use the 90000xxxxx range so
 * nothing can accidentally message a real person.
 *
 * Usage:
 *   node scripts/seed-demo-school.js
 *   node scripts/seed-demo-school.js "My Demo Academy"
 *
 * Safe to run on a database with other schools - it only ever ADDS a new
 * school, never touches existing ones. Running it twice makes two demo
 * schools.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { assignPlanToLevel } = require("../services/feePlanGenerator");

const SCHOOL_NAME = process.argv[2] || "IQPlusAcademy";
const ADMIN_EMAIL = "admin@iqplus.com";
const ADMIN_PASSWORD = "Demo@123";

const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Deterministic pseudo-random so every run produces the same-looking demo.
let seed = 20261116;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

const STUDENTS = [
    ["Aarav Sharma", "M"], ["Ananya Rao", "F"], ["Vihaan Gowda", "M"], ["Diya Nair", "F"],
    ["Arjun Patil", "M"], ["Ishita Hegde", "F"], ["Kabir Reddy", "M"], ["Myra Shetty", "F"],
    ["Reyansh Kulkarni", "M"], ["Saanvi Iyer", "F"], ["Advik Joshi", "M"], ["Aadhya Bhat", "F"],
    ["Vivaan Murthy", "M"], ["Kiara Menon", "F"], ["Ayaan Prasad", "M"], ["Navya Kamath", "F"],
    ["Dhruv Acharya", "M"], ["Prisha Rao", "F"], ["Atharv Naik", "M"], ["Anika Desai", "F"],
    ["Shaurya Pai", "M"], ["Tara Gupta", "F"], ["Rudra Shenoy", "M"], ["Meera Krishnan", "F"]
];
const PARENT_FIRST = ["Ramesh", "Suresh", "Prakash", "Mahesh", "Anil", "Sunil", "Rajesh", "Vinay", "Kiran", "Naveen", "Lakshmi", "Kavya", "Deepa", "Shilpa", "Rekha", "Sowmya"];
const CITY = "Mysuru";

async function seedDemo() {

    await wait(1500); // let config/database.js finish its migrations

    // ---- School + admin ----
    const school = await run(
        "INSERT INTO schools (name, address, phone, email) VALUES (?,?,?,?)",
        [SCHOOL_NAME, "12, 4th Cross, Saraswathipuram, Mysuru 570009", "9000000001", "office@iqplus.com"]
    );
    const S = school.lastID;
    await run("UPDATE schools SET admission_no_prefix='BM', admission_no_next=25 WHERE id=?", [S]);

    const existingAdmin = await get("SELECT id FROM users WHERE email=?", [ADMIN_EMAIL]);
    if (!existingAdmin) {
        await run("INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?, 'Admin')",
            [S, "Demo Admin", ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 10)]);
    }

    // ---- Classes (school standard) ----
    const classIds = [];
    for (const c of ["Class 2", "Class 3", "Class 4", "Class 5", "Class 6"]) {
        classIds.push((await run("INSERT INTO classes (class_name, school_id) VALUES (?,?)", [c, S])).lastID);
    }

    // ---- Lookup lists ----
    const lookup = async (type, name, extra = {}) => (await run(
        `INSERT INTO lookup_items (school_id, list_type, name, sessions_per_week, digit_count, operand_count, problem_count, include_subtraction, default_days)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [S, type, name, extra.spw || null, extra.digits || null, extra.operands || null, extra.problems || null, extra.sub ? 1 : 0, extra.days || null]
    )).lastID;

    const course = await lookup("course", "Abacus");
    await lookup("course", "Vedic Maths");
    const levels = [
        { id: await lookup("level", "Level 1", { digits: 1, operands: 3, problems: 50 }), fee: 800 },
        { id: await lookup("level", "Level 2", { digits: 1, operands: 5, problems: 50, sub: true }), fee: 900 },
        { id: await lookup("level", "Level 3", { digits: 2, operands: 4, problems: 75, sub: true }), fee: 1000 },
        { id: await lookup("level", "Level 4", { digits: 2, operands: 6, problems: 100, sub: true }), fee: 1100 }
    ];
    const batches = [
        { id: await lookup("batch", "Mon-Wed Batch", { spw: 2, days: "1,3" }), days: [1, 3] },
        { id: await lookup("batch", "Tue-Thu Batch", { spw: 2, days: "2,4" }), days: [2, 4] },
        { id: await lookup("batch", "Weekend Batch", { spw: 2, days: "0,6" }), days: [0, 6] }
    ];
    const branch = await lookup("branch", "Saraswathipuram");

    // ---- Teachers + subjects ----
    await run("INSERT INTO teachers (name, subject, phone, email, status, school_id) VALUES (?,?,?,?,?,?)", ["Priya Venkatesh", "Abacus", "9000000011", "priya@iqplus.com", "Active", S]);
    await run("INSERT INTO teachers (name, subject, phone, email, status, school_id) VALUES (?,?,?,?,?,?)", ["Harish Kumar", "Abacus", "9000000012", "harish@iqplus.com", "Active", S]);
    await run("INSERT INTO teachers (name, subject, phone, email, status, school_id) VALUES (?,?,?,?,?,?)", ["Nandini Rao", "Mental Maths", "9000000013", "nandini@iqplus.com", "Active", S]);
    const abacusSubj = (await run("INSERT INTO subjects (subject_name, subject_code, description, school_id) VALUES (?,?,?,?)", ["Abacus", "ABA", "Bead-frame calculation", S])).lastID;
    await run("INSERT INTO subjects (subject_name, subject_code, description, school_id) VALUES (?,?,?,?)", ["Mental Maths", "MM", "Visualisation & speed", S]);

    // ---- Fee categories ----
    const tuition = (await run("INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)", ["Tuition Fee", "Monthly class fee", S])).lastID;
    await run("INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)", ["Books & Kit", "Abacus kit and level workbook", S]);

    // ---- Students ----
    const students = [];
    for (let i = 0; i < STUDENTS.length; i++) {
        const [name, gender] = STUDENTS[i];
        const level = levels[i % 4];
        const batch = batches[i % 3];
        const classId = classIds[Math.min(classIds.length - 1, Math.floor(i / 5))];
        const surname = name.split(" ")[1];
        const parent = `${pick(PARENT_FIRST)} ${surname}`;
        const age = 7 + Math.floor(i / 5);
        const dob = ymd(new Date(new Date().getFullYear() - age, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)));
        const joined = ymd(daysAgo(60 + Math.floor(rand() * 90)));   // joined 2-5 months ago
        const phone = `90000${String(10100 + i * 7).padStart(5, "0")}`;

        const r = await run(
            `INSERT INTO students (name, age, class_id, admission_no, gender, dob, guardian_name, guardian_phone, guardian_email,
                                   address, city, state, country, date_of_joining, course_id, batch_id, level_id, branch_id, school_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [name, age, classId, `BM${String(i + 1).padStart(3, "0")}`, gender === "M" ? "Male" : "Female", dob, parent, phone,
             `${surname.toLowerCase()}.family@example.com`, `${10 + i}, ${pick(["Gokulam", "Kuvempunagar", "Vijayanagar", "Jayalakshmipuram"])}, ${CITY}`,
             CITY, "Karnataka", "India", joined, course, batch.id, level.id, branch, S]
        );
        for (const d of batch.days) {
            await run("INSERT INTO student_schedule (school_id, student_id, day_of_week) VALUES (?,?,?)", [S, r.lastID, d]);
        }
        students.push({ id: r.lastID, batch, level, joined, regular: rand() > 0.2 });
    }

    // ---- Fee plans (monthly Tuition per Level) - uses the app's own generator ----
    const year = new Date().getMonth() >= 5 ? `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(2)}` : `${new Date().getFullYear() - 1}-${String(new Date().getFullYear()).slice(2)}`;
    for (const level of levels) {
        const plan = await run(
            `INSERT INTO fee_plans (school_id, level_id, fee_category_id, academic_year, payment_mode, amount_per_period, duration_months)
             VALUES (?,?,?,?,?,?,?)`, [S, level.id, tuition, year, "monthly", level.fee, 12]);
        await assignPlanToLevel({ id: plan.lastID, level_id: level.id, fee_category_id: tuition, academic_year: year, payment_mode: "monthly", amount_per_period: level.fee, duration_months: 12 }, S);
    }

    // ---- Payments: pay every period that has already started, except a
    //      few students who are behind (so the dues reports aren't empty) ----
    let receipt = 1;
    const today = ymd(new Date());
    for (let i = 0; i < students.length; i++) {
        const st = students[i];
        const periods = await all(
            "SELECT id, amount, due_date, installment_label FROM fee_structure WHERE school_id=? AND student_id=? ORDER BY due_date, id", [S, st.id]);
        // Periods are labelled "September 2026" etc. (due_date is left
        // empty by the plan generator) - only count months that have begun.
        const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const monthStart = (p) => {
            if (p.due_date) return p.due_date;
            const m = /^(\w+)\s+(\d{4})/.exec(p.installment_label || "");
            const idx = m ? MONTHS.indexOf(m[1]) : -1;
            return idx >= 0 ? `${m[2]}-${String(idx + 1).padStart(2, "0")}-01` : st.joined;
        };
        const started = periods.filter(p => monthStart(p) <= today);
        const behind = i % 6 === 5 ? 2 : (i % 6 === 2 ? 1 : 0);   // 4 students owe 2 months, 4 owe 1
        const toPay = started.slice(0, Math.max(0, started.length - behind));
        for (const p of toPay) {
            const ms = monthStart(p);
            const payDate = ms < st.joined ? st.joined : (ms.slice(0, 8) + "05" <= today ? ms.slice(0, 8) + "05" : ms);
            await run(
                `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [st.id, p.id, p.amount, payDate, pick(["Cash", "UPI", "UPI", "Bank Transfer"]), `RCPT-${String(receipt++).padStart(4, "0")}`, null, S]);
        }
    }
    await run("UPDATE schools SET receipt_no_next=? WHERE id=?", [receipt, S]).catch(() => {});

    // ---- Attendance: every scheduled class day in the last 8 weeks ----
    for (let n = 56; n >= 1; n--) {
        const d = daysAgo(n);
        const dateStr = ymd(d);
        for (const st of students) {
            if (!st.batch.days.includes(d.getDay()) || dateStr < st.joined) continue;
            const present = rand() < (st.regular ? 0.9 : 0.6);
            await run(
                "INSERT INTO attendance (student_id, attendance_date, status, batch_id, is_different_batch, hours_attended, school_id) VALUES (?,?,?,?,0,?,?)",
                [st.id, dateStr, present ? "Present" : "Absent", st.batch.id, present ? 2 : 0, S]);
        }
    }

    // ---- One exam per Level, with marks ----
    for (const level of levels) {
        const exam = await run("INSERT INTO exams (exam_name, level_id, academic_year, exam_date, school_id) VALUES (?,?,?,?,?)",
            [`Monthly Assessment - ${level === levels[0] ? "Level 1" : "Level " + (levels.indexOf(level) + 1)}`, level.id, year, ymd(daysAgo(10)), S]);
        for (const st of students.filter(s => s.level === level)) {
            await run("INSERT INTO exam_results (exam_id, student_id, subject_id, marks_obtained, max_marks, school_id) VALUES (?,?,?,?,?,?)",
                [exam.lastID, st.id, abacusSubj, 55 + Math.floor(rand() * 45), 100, S]);
        }
    }

    // ---- A few referral leads ----
    const leads = [["Rohan Bhat", "9000020001", "New"], ["Sneha Kulkarni", "9000020002", "Contacted"], ["Aditya Rao", "9000020003", "Joined"]];
    for (let i = 0; i < leads.length; i++) {
        await run(`INSERT INTO referrals (school_id, referring_student_id, lead_name, lead_phone, status, coupon_code, notes)
                   VALUES (?,?,?,?,?,?,?)`,
            [S, students[i * 3].id, leads[i][0], leads[i][1], leads[i][2], `BM-REF-${101 + i}`, "Demo lead"]).catch(() => {});
    }

    const counts = {};
    for (const t of ["students", "attendance", "fee_structure", "fee_payments", "exam_results", "referrals"]) {
        counts[t] = (await get(`SELECT COUNT(*) AS n FROM ${t} WHERE school_id=?`, [S])).n;
    }

    console.log(`\nCreated demo school "${SCHOOL_NAME}" (id ${S})`);
    console.log(counts);
    if (!existingAdmin) console.log(`\nAdmin login (full access): ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`\nFor a view-only demo login run:\n  node scripts/create-demo-user.js ${S} test@iqplus.com test123`);
    process.exit(0);
}

seedDemo().catch(e => { console.error("Seeding failed:", e); process.exit(1); });
