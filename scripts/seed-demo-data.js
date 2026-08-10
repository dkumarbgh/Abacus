/**
 * Seed script - creates a "Demo School" with sample data so you can test
 * every screen (including reports that need real history, like attendance
 * % and fees due/pending) without touching your real school's data.
 *
 * Safe to re-run: it checks for "Demo School" first and does nothing if it
 * already exists (delete it from the Users/DB directly if you want a fresh
 * copy, or just change DEMO_SCHOOL_NAME below to seed a second one).
 *
 * Usage:
 *   node scripts/seed-demo-data.js
 */

const bcrypt = require("bcryptjs");
const db = require("../config/database");

const DEMO_SCHOOL_NAME = "Demo School";

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

// Last N weekday dates (skips Sat/Sun), most recent first
function lastWeekdays(n) {
    const dates = [];
    const d = new Date();
    while (dates.length < n) {
        d.setDate(d.getDate() - 1);
        const day = d.getDay();
        if (day !== 0 && day !== 6) dates.push(isoDate(new Date(d)));
    }
    return dates;
}

async function seed() {

    // Wait for config/database.js's own migration to finish before we touch
    // anything - it runs its CREATE TABLE / ALTER TABLE statements as soon
    // as it's required, and we need those in place first.
    await new Promise((r) => setTimeout(r, 2000));

    const existing = await get("SELECT id FROM schools WHERE name=?", [DEMO_SCHOOL_NAME]);
    if (existing) {
        console.log(`"${DEMO_SCHOOL_NAME}" already exists (id=${existing.id}) - nothing to do.`);
        console.log("Delete it first (via the Users page / DB) if you want a fresh seed.");
        process.exit(0);
    }

    console.log(`Creating "${DEMO_SCHOOL_NAME}"...`);
    const school = await run(
        `INSERT INTO schools (name, address, phone, email) VALUES (?,?,?,?)`,
        [DEMO_SCHOOL_NAME, "123 Sample Street", "9999999999", "office@demoschool.test"]
    );
    const schoolId = school.lastID;

    // ---------- Users (different roles, for testing permissions) ----------
    const users = [
        { name: "Demo Admin", email: "admin@demo.com", password: "Admin@123", role: "Admin" },
        { name: "Demo Teacher", email: "teacher@demo.com", password: "Teacher@123", role: "Teacher" },
        { name: "Demo Accountant", email: "accountant@demo.com", password: "Accountant@123", role: "Accountant" }
    ];
    for (const u of users) {
        const hash = bcrypt.hashSync(u.password, 10);
        await run(
            `INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)`,
            [schoolId, u.name, u.email, hash, u.role]
        );
    }
    console.log("Created 3 users (Admin, Teacher, Accountant) - see credentials printed at the end.");

    // ---------- Classes ----------
    const classNames = ["Grade 1", "Grade 2", "Grade 3"];
    const classIds = {};
    for (const name of classNames) {
        const c = await run(`INSERT INTO classes (class_name, school_id) VALUES (?,?)`, [name, schoolId]);
        classIds[name] = c.lastID;
    }
    console.log("Created 3 classes.");

    // ---------- Subjects ----------
    const subjectDefs = [
        { name: "Mathematics", code: "MATH" },
        { name: "English", code: "ENG" },
        { name: "Science", code: "SCI" }
    ];
    const subjectIds = {};
    for (const s of subjectDefs) {
        const row = await run(
            `INSERT INTO subjects (subject_name, subject_code, description, school_id) VALUES (?,?,?,?)`,
            [s.name, s.code, "", schoolId]
        );
        subjectIds[s.name] = row.lastID;
    }
    console.log("Created 3 subjects.");

    // ---------- Fee categories + structure ----------
    const tuition = await run(
        `INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)`,
        ["Tuition Fee", "Term tuition", schoolId]
    );
    const transport = await run(
        `INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)`,
        ["Transport Fee", "Bus/van charges", schoolId]
    );

    const today = new Date();
    const pastDue = isoDate(new Date(today.getTime() - 10 * 86400000));   // 10 days ago (overdue)
    const futureDue = isoDate(new Date(today.getTime() + 20 * 86400000)); // 20 days from now (upcoming)

    for (const name of classNames) {
        await run(
            `INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, due_date, school_id)
             VALUES (?,?,?,?,?,?)`,
            [classIds[name], tuition.lastID, "2026-2027", 5000, pastDue, schoolId]
        );
        await run(
            `INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, due_date, school_id)
             VALUES (?,?,?,?,?,?)`,
            [classIds[name], transport.lastID, "2026-2027", 1500, futureDue, schoolId]
        );
    }
    console.log("Created fee categories + structure (one overdue item, one upcoming item per class).");

    // ---------- Students ----------
    const studentDefs = [
        { name: "Aarav Sharma", cls: "Grade 1", guardian: "Rohit Sharma", phone: "919111100001" },
        { name: "Priya Nair", cls: "Grade 1", guardian: "Suresh Nair", phone: "919111100002" },
        { name: "Kabir Khan", cls: "Grade 1", guardian: "Imran Khan", phone: "919111100003" },
        { name: "Ananya Iyer", cls: "Grade 2", guardian: "Ramesh Iyer", phone: "919111100004" },
        { name: "Vivaan Gupta", cls: "Grade 2", guardian: "Anil Gupta", phone: "919111100005" },
        { name: "Diya Reddy", cls: "Grade 2", guardian: "Kiran Reddy", phone: "919111100006" },
        { name: "Arjun Menon", cls: "Grade 3", guardian: "Vinod Menon", phone: "919111100007" },
        { name: "Ishita Rao", cls: "Grade 3", guardian: "Sanjay Rao", phone: "919111100008" },
        { name: "Reyansh Kumar", cls: "Grade 3", guardian: "Deepak Kumar", phone: "919111100009" }
    ];

    const studentIds = [];
    let admissionCounter = 1;
    for (const s of studentDefs) {
        const row = await run(
            `INSERT INTO students
             (name, age, class_id, admission_no, gender, guardian_name, guardian_phone, school_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [s.name, 8 + Math.floor(Math.random() * 3), classIds[s.cls],
             `2026/${String(admissionCounter).padStart(3, "0")}`, "Other", s.guardian, s.phone, schoolId]
        );
        studentIds.push({ id: row.lastID, ...s });
        admissionCounter++;
    }
    console.log(`Created ${studentDefs.length} students across 3 classes.`);

    // ---------- Attendance history (last 10 weekdays, ~85% present) ----------
    const days = lastWeekdays(10);
    let attendanceRows = 0;
    for (const student of studentIds) {
        for (const date of days) {
            const status = Math.random() < 0.85 ? "Present" : "Absent";
            await run(
                `INSERT INTO attendance (student_id, attendance_date, status, school_id) VALUES (?,?,?,?)`,
                [student.id, date, status, schoolId]
            );
            attendanceRows++;
        }
    }
    console.log(`Created ${attendanceRows} attendance records across the last ${days.length} weekdays.`);

    // ---------- One payment per student (partial, so fees-pending has data too) ----------
    const structures = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM fee_structure WHERE school_id=?", [schoolId], (err, rows) => {
            if (err) reject(err); else resolve(rows);
        });
    });
    let paymentCount = 0;
    for (const student of studentIds) {
        const tuitionForClass = structures.find(
            fs => fs.class_id === classIds[student.cls] && fs.fee_category_id === tuition.lastID
        );
        if (tuitionForClass) {
            await run(
                `INSERT INTO fee_payments
                 (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, school_id)
                 VALUES (?,?,?,?,?,?,?)`,
                [student.id, tuitionForClass.id, 2000, isoDate(today), "Cash", `RCPT-DEMO-${student.id}`, schoolId]
            );
            paymentCount++;
        }
    }
    console.log(`Created ${paymentCount} partial fee payments (2000 of 5000 tuition paid - rest shows as pending/due).`);

    // ---------- Exam + marks ----------
    for (const name of classNames) {
        const exam = await run(
            `INSERT INTO exams (exam_name, class_id, academic_year, exam_date, school_id) VALUES (?,?,?,?,?)`,
            ["Term 1 Test", classIds[name], "2026-2027", isoDate(today), schoolId]
        );
        const classStudents = studentIds.filter(s => s.cls === name);
        for (const student of classStudents) {
            for (const subjectName of Object.keys(subjectIds)) {
                const marks = 50 + Math.floor(Math.random() * 50); // 50-99
                await run(
                    `INSERT INTO exam_results (exam_id, student_id, subject_id, marks_obtained, max_marks, school_id)
                     VALUES (?,?,?,?,?,?)`,
                    [exam.lastID, student.id, subjectIds[subjectName], marks, 100, schoolId]
                );
            }
        }
    }
    console.log("Created one exam per class with marks for every subject/student (check /reports/exam-results).");

    console.log("\n=================================================");
    console.log(`"${DEMO_SCHOOL_NAME}" seeded successfully. Log in with:`);
    console.log("-------------------------------------------------");
    for (const u of users) {
        console.log(`  ${u.role.padEnd(11)} ${u.email}  /  ${u.password}`);
    }
    console.log("=================================================\n");

    process.exit(0);

}

seed().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
});
