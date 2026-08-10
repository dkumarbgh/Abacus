const sqlite3 = require("sqlite3").verbose();

// On a host with an ephemeral filesystem (e.g. Render without a persistent
// Disk attached), "./school.db" gets wiped and rebuilt from the repo on
// every deploy - which means every student/fee/attendance record entered
// since the last deploy is silently gone. Setting the DB_PATH environment
// variable to a path on a mounted persistent Disk (e.g. "/var/data/school.db"
// on Render) avoids that entirely. Falls back to the old relative path so
// local development is unaffected.
const DB_PATH = process.env.DB_PATH || "./school.db";

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error(err.message);
    } else {
        console.log(`Connected to SQLite Database at ${DB_PATH}`);
    }
});

// Small promise wrappers so migrations run in a guaranteed, predictable order.
// (sqlite3's db.serialize() only orders statements issued synchronously at
// the top level - it does NOT wait for nested async callbacks like
// PRAGMA-then-ALTER, which caused real ordering bugs here. Explicit
// async/await sequencing avoids that entirely.)
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err); else resolve(rows);
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

async function addColumnIfMissing(table, name, def) {
    const columns = await all(`PRAGMA table_info(${table})`);
    const existing = columns.map(c => c.name);
    if (!existing.includes(name)) {
        try {
            await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        } catch (e) {
            console.error(`Could not add column ${table}.${name}:`, e.message);
        }
    }
}

// Tables that belong to a single school (everything except schools/users themselves)
const MULTI_TENANT_TABLES = [
    "classes", "students", "teachers", "subjects", "fee_types",
    "fee_categories", "fee_structure", "fee_payments", "attendance",
    "face_encodings", "exams", "exam_results", "practice_sheets",
    "message_logs", "teacher_subjects", "timetable"
];

async function migrate() {

    await run(`
        CREATE TABLE IF NOT EXISTS schools(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            address TEXT,
            phone TEXT,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Teacher',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS classes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name TEXT NOT NULL
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS students(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            age INTEGER,
            class_id INTEGER,
            FOREIGN KEY(class_id) REFERENCES classes(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS teachers(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            status TEXT DEFAULT 'Active'
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS attendance(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            attendance_date TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS subjects(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_name TEXT NOT NULL,
            subject_code TEXT NOT NULL UNIQUE,
            description TEXT
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS teacher_subjects(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER NOT NULL,
            subject_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            FOREIGN KEY(teacher_id) REFERENCES teachers(id),
            FOREIGN KEY(subject_id) REFERENCES subjects(id),
            FOREIGN KEY(class_id) REFERENCES classes(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS timetable(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL,
            teacher_id INTEGER NOT NULL,
            subject_id INTEGER NOT NULL,
            day TEXT NOT NULL,
            period INTEGER NOT NULL,
            start_time TEXT,
            end_time TEXT,
            FOREIGN KEY(class_id) REFERENCES classes(id),
            FOREIGN KEY(teacher_id) REFERENCES teachers(id),
            FOREIGN KEY(subject_id) REFERENCES subjects(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS fee_types(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fee_name TEXT NOT NULL,
            amount REAL NOT NULL,
            academic_year TEXT NOT NULL,
            description TEXT
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS fee_categories(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fee_name TEXT NOT NULL,
            description TEXT
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS fee_structure (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL,
            fee_category_id INTEGER NOT NULL,
            academic_year TEXT NOT NULL,
            amount REAL NOT NULL,
            FOREIGN KEY(class_id) REFERENCES classes(id),
            FOREIGN KEY(fee_category_id) REFERENCES fee_categories(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS fee_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            fee_structure_id INTEGER NOT NULL,
            amount_paid REAL NOT NULL,
            payment_date TEXT NOT NULL,
            mode TEXT DEFAULT 'Cash',
            receipt_no TEXT UNIQUE,
            remarks TEXT,
            FOREIGN KEY(student_id) REFERENCES students(id),
            FOREIGN KEY(fee_structure_id) REFERENCES fee_structure(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS face_encodings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL UNIQUE,
            encoding TEXT NOT NULL,
            photo_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_name TEXT NOT NULL,
            class_id INTEGER NOT NULL,
            academic_year TEXT NOT NULL,
            exam_date TEXT,
            FOREIGN KEY(class_id) REFERENCES classes(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS exam_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            subject_id INTEGER NOT NULL,
            marks_obtained REAL NOT NULL,
            max_marks REAL NOT NULL DEFAULT 100,
            FOREIGN KEY(exam_id) REFERENCES exams(id),
            FOREIGN KEY(student_id) REFERENCES students(id),
            FOREIGN KEY(subject_id) REFERENCES subjects(id),
            UNIQUE(exam_id, student_id, subject_id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS practice_sheets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL,
            subject_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(class_id) REFERENCES classes(id),
            FOREIGN KEY(subject_id) REFERENCES subjects(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS message_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER,
            phone TEXT NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS fee_discounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            fee_structure_id INTEGER NOT NULL,
            discount_type TEXT NOT NULL DEFAULT 'FLAT',
            discount_value REAL NOT NULL,
            reason TEXT,
            school_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id),
            FOREIGN KEY(fee_structure_id) REFERENCES fee_structure(id),
            UNIQUE(student_id, fee_structure_id)
        )
    `);

    await addColumnIfMissing("classes", "is_active", "INTEGER NOT NULL DEFAULT 1");

    // Student registration fields
    for (const [name, def] of [
        ["admission_no", "TEXT"],
        ["gender", "TEXT"],
        ["dob", "TEXT"],
        ["guardian_name", "TEXT"],
        ["guardian_phone", "TEXT"],
        ["guardian_email", "TEXT"],
        ["address", "TEXT"],
        ["photo_path", "TEXT"],
        // Fee due date is per-student (not shared across a whole class/fee
        // item anymore) - set from the student's own record.
        ["fee_due_date", "TEXT"],

        // Extended registration fields (Centre/Batch enrollment form)
        ["mother_tongue", "TEXT"],
        ["mother_name", "TEXT"],
        ["father_name", "TEXT"],
        ["father_occupation", "TEXT"],
        ["mother_occupation", "TEXT"],
        ["mother_phone", "TEXT"],
        ["father_phone", "TEXT"],
        ["mother_email", "TEXT"],
        ["father_email", "TEXT"],
        ["previous_school", "TEXT"],   // "School" field - student's own school, distinct from this centre
        ["stream", "TEXT"],
        ["standard", "TEXT"],
        ["religion", "TEXT"],
        ["nationality", "TEXT"],
        ["country", "TEXT"],
        ["state", "TEXT"],
        ["city", "TEXT"],
        ["total_hours_per_month", "TEXT"],

        // Dropdowns backed by lookup_items (see below) - nullable, no FK
        // enforced (sqlite FKs are opt-in and the rest of the schema
        // doesn't enforce them either) so deleting a list entry never
        // breaks a student record, it just shows as unset.
        ["course_id", "INTEGER"],
        ["batch_id", "INTEGER"],
        ["level_id", "INTEGER"],
        ["branch_id", "INTEGER"]
    ]) {
        await addColumnIfMissing("students", name, def);
    }

    await addColumnIfMissing("fee_structure", "due_date", "TEXT");

    // Lets a fee_structure row belong to ONE student instead of a whole
    // class - used for the personalized "Course Fee" created from the
    // Total Fee / Discount / Installments section on the Student form.
    // NULL (the default) means "applies to the whole class", same as
    // before this column existed.
    await addColumnIfMissing("fee_structure", "student_id", "INTEGER");

    // Admin-managed dropdown lists: Courses, Batches, Levels, Branches.
    // One shared table (list_type distinguishes which list a row belongs
    // to) rather than four near-identical tables.
    await run(`
        CREATE TABLE IF NOT EXISTS lookup_items(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            list_type TEXT NOT NULL,   -- 'course' | 'batch' | 'level' | 'branch'
            name TEXT NOT NULL,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);

    // Simple Fee Mode: per-school toggle. When ON, fee collection doesn't
    // accept a partial/custom amount - each fee item is just marked
    // Paid/Not Paid in one click (for the full net amount due). Defaults
    // to OFF (0) so existing behaviour (enter any amount) is unchanged
    // unless an Admin turns it on from /settings.
    await addColumnIfMissing("schools", "simple_fee_mode", "INTEGER NOT NULL DEFAULT 0");

    // Auto-assigned Admission No.: when ON, the Add Student form fills in
    // (and the backend always computes, ignoring anything from the form)
    // PREFIX + next sequential number, e.g. "2026/0001". admission_no_next
    // is the next number to hand out; incremented every time one is
    // assigned. Defaults ON since that's the common case; toggle from
    // Settings if a school wants to type their own instead.
    await addColumnIfMissing("schools", "admission_no_auto", "INTEGER NOT NULL DEFAULT 1");
    await addColumnIfMissing("schools", "admission_no_prefix", "TEXT NOT NULL DEFAULT ''");
    await addColumnIfMissing("schools", "admission_no_next", "INTEGER NOT NULL DEFAULT 1");

    // Configurable mandatory fields: lets an Admin decide, per form, which
    // optional-by-default fields should be required. Absence of a row for
    // a given (school, form, field) means "use the built-in default" -
    // see services/fieldSettings.js for the defaults themselves.
    await run(`
        CREATE TABLE IF NOT EXISTS field_settings(
            school_id INTEGER NOT NULL,
            form_key TEXT NOT NULL,
            field_key TEXT NOT NULL,
            is_mandatory INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(school_id, form_key, field_key),
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);

    // Multi-school support: every core table gets a school_id
    for (const table of MULTI_TENANT_TABLES) {
        await addColumnIfMissing(table, "school_id", "INTEGER");
    }

    // users.email was originally UNIQUE globally, meaning one person could
    // never have separate accounts at more than one school (e.g. Teacher
    // at School A, Accountant at School B). Rebuild without that
    // constraint and replace it with a per-school unique index instead -
    // the same email can now have one account per school, and login shows
    // a picker if more than one of them matches the password typed. Safe
    // to run every start - only acts if the old global constraint is
    // still present.
    const usersTableInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`);
    if (usersTableInfo && usersTableInfo.sql.includes("email TEXT NOT NULL UNIQUE")) {
        await run(`
            CREATE TABLE users_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                school_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'Teacher',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(school_id) REFERENCES schools(id)
            )
        `);
        await run(`
            INSERT INTO users_new (id, school_id, name, email, password_hash, role, created_at)
            SELECT id, school_id, name, email, password_hash, role, created_at FROM users
        `);
        await run(`DROP TABLE users`);
        await run(`ALTER TABLE users_new RENAME TO users`);
        console.log("[migration] Rebuilt users table - one email can now have an account per school.");
    }
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_school ON users(email, school_id)`);

    // subjects.subject_code was originally UNIQUE globally, which breaks as
    // soon as two schools want to use the same code (e.g. "MATH5"). Rebuild
    // the table without that constraint and replace it with a per-school
    // unique index instead. Safe to run every start - only acts if the old
    // global constraint is still present.
    const subjectsTableInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='subjects'`);
    if (subjectsTableInfo && subjectsTableInfo.sql.includes("UNIQUE")) {
        await run(`
            CREATE TABLE subjects_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject_name TEXT NOT NULL,
                subject_code TEXT NOT NULL,
                description TEXT,
                school_id INTEGER
            )
        `);
        await run(`
            INSERT INTO subjects_new (id, subject_name, subject_code, description, school_id)
            SELECT id, subject_name, subject_code, description, school_id FROM subjects
        `);
        await run(`DROP TABLE subjects`);
        await run(`ALTER TABLE subjects_new RENAME TO subjects`);
        console.log("[migration] Rebuilt subjects table with per-school unique codes.");
    }
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_school ON subjects(subject_code, school_id)`);

    // fee_categories.fee_name had the same global-UNIQUE issue.
    const feeCatTableInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='fee_categories'`);
    if (feeCatTableInfo && feeCatTableInfo.sql.includes("UNIQUE")) {
        await run(`
            CREATE TABLE fee_categories_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fee_name TEXT NOT NULL,
                description TEXT,
                school_id INTEGER
            )
        `);
        await run(`
            INSERT INTO fee_categories_new (id, fee_name, description, school_id)
            SELECT id, fee_name, description, school_id FROM fee_categories
        `);
        await run(`DROP TABLE fee_categories`);
        await run(`ALTER TABLE fee_categories_new RENAME TO fee_categories`);
        console.log("[migration] Rebuilt fee_categories table with per-school unique names.");
    }
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_feecat_name_school ON fee_categories(fee_name, school_id)`);

    // One-time backfill: if there's data from before multi-school support
    // existed (school_id IS NULL) and no school has been created yet,
    // create a "Default School" and attach all that data to it - otherwise
    // it would become invisible once every query starts filtering by
    // school_id.
    const schoolCount = await get("SELECT COUNT(*) AS n FROM schools");
    if (schoolCount.n === 0) {
        const studentCount = await get("SELECT COUNT(*) AS n FROM students WHERE school_id IS NULL");
        if (studentCount.n > 0) {
            const result = await run(`INSERT INTO schools (name) VALUES ('Default School')`);
            const defaultSchoolId = result.lastID;
            for (const table of MULTI_TENANT_TABLES) {
                await run(`UPDATE ${table} SET school_id=? WHERE school_id IS NULL`, [defaultSchoolId]);
            }

            // Create a login for the backfilled data so it's not stranded
            // behind a login screen with no credentials. Change this password
            // immediately after logging in.
            const bcrypt = require("bcryptjs");
            const tempPassword = "changeme123";
            const passwordHash = bcrypt.hashSync(tempPassword, 10);
            await run(
                `INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)`,
                [defaultSchoolId, "Admin", "admin@defaultschool.local", passwordHash, "Admin"]
            );

            console.log(`[migration] Backfilled pre-existing data into "Default School" (id=${defaultSchoolId})`);
            console.log(`[migration] Temporary login created - email: admin@defaultschool.local  password: ${tempPassword}`);
            console.log(`[migration] Please log in and change this password (via Users page) right away.`);
        }
    }

}

migrate().catch(err => console.error("Migration error:", err));

module.exports = db;
