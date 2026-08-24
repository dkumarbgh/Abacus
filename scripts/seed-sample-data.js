/**
 * Seeds a full set of sample/test data across every table in the app -
 * a school, an admin login, classes, lookup lists, students (with the
 * full extended field set, including one with a personalized fee item +
 * discount + installments), teachers, subjects, timetable, attendance
 * (a mix of Present/Absent across a few days), exams + results, and a
 * couple of message log entries.
 *
 * SAFE TO RUN ANYTIME: it creates its own dedicated test school (named
 * below) rather than touching any of your real schools/students, so your
 * existing data is completely untouched.
 *
 * Usage:
 *   node scripts/seed-sample-data.js
 *
 * Then log in with the printed email/password to see it all in the app.
 *
 * Re-running this script creates ANOTHER fresh test school each time
 * (school names aren't unique) - delete the old one from Users/Settings,
 * or just ignore the extra one, if you run it more than once.
 */

const bcrypt = require("bcryptjs");
const db = require("../config/database");

const SCHOOL_NAME = "Sample Test Centre";
const ADMIN_EMAIL = `test-admin-${Date.now()}@example.com`;
const ADMIN_PASSWORD = "password123";

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

// Migration runs automatically when config/database.js is required, but
// it's async and not awaited there - give it a moment to finish before we
// start inserting, so every column/table we need actually exists yet.
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function seed() {

    await wait(1500);

    console.log("Seeding sample data...\n");

    // ---- School + users ----
    const school = await dbRun(
        "INSERT INTO schools (name, address, phone, email) VALUES (?,?,?,?)",
        [SCHOOL_NAME, "123 Sample Street", "9876543210", "office@sampletestcentre.example"]
    );
    const schoolId = school.lastID;

    await dbRun(
        "INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)",
        [schoolId, "Test Admin", ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 10), "Admin"]
    );
    await dbRun(
        "INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)",
        [schoolId, "Test Teacher", `test-teacher-${Date.now()}@example.com`, bcrypt.hashSync(ADMIN_PASSWORD, 10), "Teacher"]
    );

    // ---- Classes ----
    const class8 = await dbRun("INSERT INTO classes (class_name, school_id) VALUES (?,?)", ["Class 8", schoolId]);
    const class9 = await dbRun("INSERT INTO classes (class_name, school_id) VALUES (?,?)", ["Class 9", schoolId]);
    const classIds = [class8.lastID, class9.lastID];

    // ---- Lookup lists (Courses/Batches/Levels/Branches) ----
    const course = await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "course", "Spoken English"]);
    await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "course", "Abacus"]);
    const batch = await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "batch", "Morning Batch"]);
    await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "batch", "Evening Batch"]);
    const level = await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "level", "Beginner"]);
    const branch = await dbRun("INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)", [schoolId, "branch", "Main Branch"]);

    // ---- Teachers, subjects, timetable ----
    const teacher1 = await dbRun("INSERT INTO teachers (name, subject, phone, email, status, school_id) VALUES (?,?,?,?,?,?)",
        ["Mrs. Kavya Rao", "Mathematics", "9000000001", "kavya@example.com", "Active", schoolId]);
    const teacher2 = await dbRun("INSERT INTO teachers (name, subject, phone, email, status, school_id) VALUES (?,?,?,?,?,?)",
        ["Mr. Arjun Iyer", "English", "9000000002", "arjun@example.com", "Active", schoolId]);

    const mathsSubj = await dbRun("INSERT INTO subjects (subject_name, subject_code, description, school_id) VALUES (?,?,?,?)",
        ["Mathematics", "MATH8", "Class 8 Mathematics", schoolId]);
    const engSubj = await dbRun("INSERT INTO subjects (subject_name, subject_code, description, school_id) VALUES (?,?,?,?)",
        ["English", "ENG8", "Class 8 English", schoolId]);

    await dbRun("INSERT INTO teacher_subjects (teacher_id, subject_id, class_id, school_id) VALUES (?,?,?,?)",
        [teacher1.lastID, mathsSubj.lastID, classIds[0], schoolId]);
    await dbRun("INSERT INTO teacher_subjects (teacher_id, subject_id, class_id, school_id) VALUES (?,?,?,?)",
        [teacher2.lastID, engSubj.lastID, classIds[0], schoolId]);

    await dbRun("INSERT INTO timetable (class_id, teacher_id, subject_id, day, period, start_time, end_time, school_id) VALUES (?,?,?,?,?,?,?,?)",
        [classIds[0], teacher1.lastID, mathsSubj.lastID, "Monday", 1, "09:00", "09:45", schoolId]);
    await dbRun("INSERT INTO timetable (class_id, teacher_id, subject_id, day, period, start_time, end_time, school_id) VALUES (?,?,?,?,?,?,?,?)",
        [classIds[0], teacher2.lastID, engSubj.lastID, "Monday", 2, "09:45", "10:30", schoolId]);

    // ---- Fee categories + class-wide fee structure ----
    const tuitionCat = await dbRun("INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)",
        ["Tuition Fee", "Regular monthly tuition", schoolId]);
    const transportCat = await dbRun("INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)",
        ["Transport Fee", "School bus", schoolId]);

    const tuitionStructure = await dbRun(
        "INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, school_id) VALUES (?,?,?,?,?)",
        [classIds[0], tuitionCat.lastID, "2026-27", 12000, schoolId]
    );
    await dbRun(
        "INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, school_id) VALUES (?,?,?,?,?)",
        [classIds[0], transportCat.lastID, "2026-27", 3000, schoolId]
    );

    // ---- Students (full extended field set) ----
    const students = [
        {
            name: "Riya Sharma", age: 14, class_id: classIds[0], admission_no: "2026/0001",
            gender: "Female", dob: "2012-03-14", guardian_name: "Suresh Sharma", guardian_phone: "919876500001",
            guardian_email: "suresh.sharma@example.com", address: "12 MG Road, Mysuru",
            fee_due_date: "2026-09-05", mother_tongue: "Kannada", mother_name: "Anita Sharma",
            father_name: "Suresh Sharma", mother_occupation: "Teacher", father_occupation: "Engineer",
            mother_phone: "919876500011", father_phone: "919876500001",
            mother_email: "anita.sharma@example.com", father_email: "suresh.sharma@example.com",
            previous_school: "St. Xavier's School", stream: "Science", standard: "8th",
            religion: "Hindu", nationality: "Indian", country: "India", state: "Karnataka", city: "Mysuru",
            course_id: course.lastID, batch_id: batch.lastID, level_id: level.lastID, branch_id: branch.lastID,
            total_hours_per_month: "20"
        },
        {
            name: "Aditya Kumar", age: 13, class_id: classIds[0], admission_no: "2026/0002",
            gender: "Male", dob: "2013-07-22", guardian_name: "Ramesh Kumar", guardian_phone: "919876500002",
            address: "45 Vidyaranyapuram, Mysuru", fee_due_date: "2026-09-10",
            previous_school: "Delhi Public School", standard: "8th", city: "Mysuru", state: "Karnataka",
            country: "India", nationality: "Indian"
        },
        {
            name: "Sneha Patil", age: 15, class_id: classIds[1], admission_no: "2026/0003",
            gender: "Female", dob: "2011-11-02", guardian_name: "Vijay Patil", guardian_phone: "919876500003",
            address: "8 Saraswathipuram, Mysuru", standard: "9th", city: "Mysuru"
        },
        {
            name: "Second Kid No Fee", age: 13, class_id: classIds[0], admission_no: "2026/0004",
            guardian_name: "Guardian X", guardian_phone: "919876500004"
        }
    ];

    const studentIds = [];
    for (const s of students) {
        const cols = Object.keys(s);
        const placeholders = cols.map(() => "?").join(",");
        const result = await dbRun(
            `INSERT INTO students (${cols.join(",")}, school_id) VALUES (${placeholders}, ?)`,
            [...cols.map(c => s[c]), schoolId]
        );
        studentIds.push(result.lastID);
    }
    const [riyaId, adityaId, snehaId] = studentIds;

    // ---- Class-wide fee payments for a couple of students ----
    await dbRun(
        `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [riyaId, tuitionStructure.lastID, 6000, "2026-08-01", "Cash", `RCPT-SEED-${Date.now()}-1`, "Partial payment", schoolId]
    );

    // ---- Personalized "Course Fee" for Riya (total fee + discount + installments) ----
    const courseFeeCat = await dbRun("INSERT INTO fee_categories (fee_name, description, school_id) VALUES (?,?,?)",
        ["Course Fee", null, schoolId]);
    const riyaCourseFee = await dbRun(
        "INSERT INTO fee_structure (class_id, fee_category_id, academic_year, amount, student_id, school_id) VALUES (?,?,?,?,?,?)",
        [classIds[0], courseFeeCat.lastID, "2026", 20000, riyaId, schoolId]
    );
    await dbRun(
        "INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id) VALUES (?,?,?,?,?,?)",
        [riyaId, riyaCourseFee.lastID, "FLAT", 2000, "Enrollment discount", schoolId]
    );
    await dbRun(
        `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [riyaId, riyaCourseFee.lastID, 5000, "2026-08-01", "Cash", `RCPT-SEED-${Date.now()}-2`, "Installment 1", schoolId]
    );
    await dbRun(
        `INSERT INTO fee_payments (student_id, fee_structure_id, amount_paid, payment_date, mode, receipt_no, remarks, school_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [riyaId, riyaCourseFee.lastID, 3000, "2026-08-15", "UPI", `RCPT-SEED-${Date.now()}-3`, "Installment 2", schoolId]
    );

    // ---- Attendance: 3 days, mixed Present/Absent, full roster each day ----
    const classRoster = [riyaId, adityaId]; // both in Class 8
    const attendanceDays = [
        { date: "2026-08-03", present: [riyaId, adityaId] },
        { date: "2026-08-04", present: [riyaId] },            // Aditya absent
        { date: "2026-08-05", present: [adityaId] }            // Riya absent
    ];
    for (const day of attendanceDays) {
        for (const sid of classRoster) {
            const status = day.present.includes(sid) ? "Present" : "Absent";
            await dbRun(
                "INSERT INTO attendance (student_id, attendance_date, status, school_id) VALUES (?,?,?,?)",
                [sid, day.date, status, schoolId]
            );
        }
    }

    // ---- Exam + results ----
    const exam = await dbRun(
        "INSERT INTO exams (exam_name, class_id, academic_year, exam_date, school_id) VALUES (?,?,?,?,?)",
        ["Mid-Term Exam", classIds[0], "2026-27", "2026-08-20", schoolId]
    );
    await dbRun(
        "INSERT INTO exam_results (exam_id, student_id, subject_id, marks_obtained, max_marks, school_id) VALUES (?,?,?,?,?,?)",
        [exam.lastID, riyaId, mathsSubj.lastID, 88, 100, schoolId]
    );
    await dbRun(
        "INSERT INTO exam_results (exam_id, student_id, subject_id, marks_obtained, max_marks, school_id) VALUES (?,?,?,?,?,?)",
        [exam.lastID, adityaId, mathsSubj.lastID, 72, 100, schoolId]
    );

    // ---- Message log sample (as if WhatsApp reminders were sent) ----
    await dbRun(
        "INSERT INTO message_logs (student_id, phone, type, message, status, school_id) VALUES (?,?,?,?,?,?)",
        [riyaId, "919876500001", "FEE_REMINDER", "Dear Parent, a total of Rs.10000 in school fees is pending for Riya Sharma.", "SENT", schoolId]
    );
    await dbRun(
        "INSERT INTO message_logs (student_id, phone, type, message, status, school_id) VALUES (?,?,?,?,?,?)",
        [snehaId, "919876500003", "FEE_REMINDER", "Dear Parent, school fees are pending for Sneha Patil.", "FAILED", schoolId]
    );

    // ---- Print summary ----
    const counts = {};
    for (const table of ["classes", "students", "teachers", "subjects", "timetable", "fee_categories",
        "fee_structure", "fee_payments", "fee_discounts", "attendance", "exams", "exam_results",
        "message_logs", "lookup_items"]) {
        const row = await dbGet(`SELECT COUNT(*) AS n FROM ${table} WHERE school_id=?`, [schoolId]);
        counts[table] = row.n;
    }

    console.log("Done. Sample data created:\n");
    console.log(`  School:   "${SCHOOL_NAME}" (id ${schoolId})`);
    console.log(`  Login:    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log("\n  Row counts:");
    Object.entries(counts).forEach(([table, n]) => console.log(`    ${table.padEnd(16)} ${n}`));
    console.log("\nLog in with the credentials above to explore it in the app.");

    process.exit(0);

}

seed().catch(err => {
    console.error("Seeding failed:", err);
    process.exit(1);
});
