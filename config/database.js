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
            class_id INTEGER,
            fee_category_id INTEGER NOT NULL,
            academic_year TEXT NOT NULL,
            amount REAL NOT NULL,
            FOREIGN KEY(class_id) REFERENCES classes(id),
            FOREIGN KEY(fee_category_id) REFERENCES fee_categories(id)
        )
    `);

    // Existing deployments created this table with class_id NOT NULL,
    // before Level-based fee items existed. Rebuild to relax that (a
    // level-based row legitimately has no class_id at all), preserving
    // every existing row and its class_id exactly as-is.
    const feeStructureInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='fee_structure'`);
    if (feeStructureInfo && feeStructureInfo.sql.includes("class_id INTEGER NOT NULL")) {
        const oldColumns = await all(`PRAGMA table_info(fee_structure)`);
        const columnNames = oldColumns.map(c => c.name);
        // Build the copy dynamically so this works regardless of which
        // later columns (due_date, student_id, level_id, school_id) had
        // already been added on this particular database before now.
        const extraCols = columnNames.filter(c => !["id", "class_id", "fee_category_id", "academic_year", "amount"].includes(c));

        await run(`
            CREATE TABLE fee_structure_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id INTEGER,
                fee_category_id INTEGER NOT NULL,
                academic_year TEXT NOT NULL,
                amount REAL NOT NULL
                ${extraCols.length ? "," + extraCols.map(c => `${c} ${c === "due_date" ? "TEXT" : "INTEGER"}`).join(", ") : ""}
            )
        `);
        const allCols = ["id", "class_id", "fee_category_id", "academic_year", "amount", ...extraCols];
        await run(`INSERT INTO fee_structure_new (${allCols.join(",")}) SELECT ${allCols.join(",")} FROM fee_structure`);
        await run(`DROP TABLE fee_structure`);
        await run(`ALTER TABLE fee_structure_new RENAME TO fee_structure`);
        console.log("[migration] Rebuilt fee_structure - class_id is now optional (Level-based fee items don't need one).");
    }

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
            level_id INTEGER NOT NULL,
            academic_year TEXT NOT NULL,
            exam_date TEXT,
            FOREIGN KEY(level_id) REFERENCES lookup_items(id)
        )
    `);

    // Existing deployments created this table keyed on class_id, before
    // Level became the primary academic grouping (see the Level-vs-Class
    // work elsewhere in this app). Rebuild keyed on level_id instead,
    // carrying each exam's CLASS across to whichever Level its students
    // are mostly in - a best-effort mapping since there's no direct
    // class->level link on the exams table itself, only via students.
    const examsInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='exams'`);
    if (examsInfo && examsInfo.sql.includes("class_id")) {
        // Preserve school_id if it's already been backfilled onto this
        // table by the generic MULTI_TENANT_TABLES loop in an earlier run
        // - otherwise every existing exam would lose its school scoping.
        const hasSchoolId = examsInfo.sql.includes("school_id");
        await run(`
            CREATE TABLE exams_new(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exam_name TEXT NOT NULL,
                level_id INTEGER NOT NULL,
                academic_year TEXT NOT NULL,
                exam_date TEXT${hasSchoolId ? ",\n                school_id INTEGER" : ""}
            )
        `);
        await run(`
            INSERT INTO exams_new (id, exam_name, level_id, academic_year, exam_date${hasSchoolId ? ", school_id" : ""})
            SELECT exams.id, exams.exam_name,
                   COALESCE(
                       (SELECT students.level_id FROM students
                        WHERE students.class_id = exams.class_id AND students.level_id IS NOT NULL
                        GROUP BY students.level_id ORDER BY COUNT(*) DESC LIMIT 1),
                       (SELECT id FROM lookup_items WHERE list_type='level' AND school_id =
                           (SELECT school_id FROM students WHERE class_id = exams.class_id LIMIT 1)
                        LIMIT 1)
                   ) AS level_id,
                   exams.academic_year, exams.exam_date${hasSchoolId ? ", exams.school_id" : ""}
            FROM exams
        `);
        // Any exam that still couldn't be resolved (e.g. an empty class
        // with no students at all) is dropped rather than left dangling
        // with a NULL level_id, which the NOT NULL constraint forbids.
        await run(`DELETE FROM exams_new WHERE level_id IS NULL`);
        await run(`DROP TABLE exams`);
        await run(`ALTER TABLE exams_new RENAME TO exams`);
        console.log("[migration] Rebuilt exams - now keyed on Level instead of Class.");
    }

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
    // Level-based fee items - new fee structure entries are created by
    // Level now (matching how the rest of the app works for an abacus
    // academy), while any EXISTING class_id-based entries keep working
    // exactly as before - purely additive, nothing here changes how old
    // rows are matched to students.
    await addColumnIfMissing("fee_structure", "level_id", "INTEGER");

    // Lets a fee_structure row belong to ONE student instead of a whole
    // class - used for the personalized "Course Fee" created from the
    // Total Fee / Discount / Installments section on the Student form.
    // NULL (the default) means "applies to the whole class", same as
    // before this column existed.
    await addColumnIfMissing("fee_structure", "student_id", "INTEGER");

    // Sessions per week - only meaningful for list_type='batch', used to
    // compute each batch's expected classes per month (sessions_per_week x
    // ~4 weeks) for the attendance-regularity report. NULL for course/
    // level/branch entries, where it's not applicable.
    await run(`
        CREATE TABLE IF NOT EXISTS lookup_items(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            list_type TEXT NOT NULL,   -- 'course' | 'batch' | 'level' | 'branch'
            name TEXT NOT NULL,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);
    await addColumnIfMissing("lookup_items", "sessions_per_week", "INTEGER");
    // Which Level this batch belongs to - only meaningful for list_type=
    // 'batch' (a real abacus batch usually IS a specific level's batch,
    // e.g. "Level 1 - Tue/Fri"). Lets the Level filter on Attendance
    // actually narrow down the Batch list to something meaningful.
    await addColumnIfMissing("lookup_items", "level_id", "INTEGER");

    // Certificates: an Admin uploads a background image per certificate
    // type (Completion, Attendance, Merit, Transfer, or any custom type),
    // then positions text fields (Student Name, Date, etc.) on top of it
    // using a click-to-place visual editor. Generating a certificate later
    // just overlays those fields' real values onto the same background at
    // the same positions, as a PDF.
    await run(`
        CREATE TABLE IF NOT EXISTS certificate_templates(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            certificate_type TEXT NOT NULL, -- 'completion' | 'attendance' | 'merit' | 'transfer' | custom label
            background_path TEXT NOT NULL,
            image_width INTEGER NOT NULL,   -- original uploaded image's pixel size - field
            image_height INTEGER NOT NULL,  -- positions are stored as % of this, so they stay
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- correct regardless of the image's actual resolution
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);

    // Positioned text fields for a template - x_pct/y_pct are percentages
    // (0-100) of the background image's width/height, not pixels, so the
    // same layout works correctly no matter what size the source image is.
    await run(`
        CREATE TABLE IF NOT EXISTS certificate_fields(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL,
            field_key TEXT NOT NULL,    -- 'student_name' | 'date' | 'course_name' | 'custom_1' etc.
            label TEXT NOT NULL,        -- shown in the editor, e.g. "Student Name"
            x_pct REAL NOT NULL,
            y_pct REAL NOT NULL,
            font_size INTEGER NOT NULL DEFAULT 24,
            font_color TEXT NOT NULL DEFAULT '#000000',
            bold INTEGER NOT NULL DEFAULT 0,
            text_align TEXT NOT NULL DEFAULT 'center', -- left | center | right
            FOREIGN KEY(template_id) REFERENCES certificate_templates(id)
        )
    `);

    // A log of every certificate actually generated - lets staff reprint
    // one later without re-entering the custom field values, and gives an
    // audit trail of who's been issued what.
    await run(`
        CREATE TABLE IF NOT EXISTS certificates_issued(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            template_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            issued_date TEXT NOT NULL,
            custom_values TEXT, -- JSON: { field_key: value } for any fields beyond student_name/date
            issued_by INTEGER,  -- users.id of whoever generated it
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id),
            FOREIGN KEY(template_id) REFERENCES certificate_templates(id),
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);

    // message_logs originally assumed WhatsApp only (phone required, no
    // channel/email concept). Rebuild to support Email alongside it -
    // phone becomes optional, email is new, channel says which was used.
    // Existing rows are preserved and backfilled as channel='whatsapp'
    // (they all were, before this migration existed). school_id is
    // preserved directly here since the generic MULTI_TENANT_TABLES loop
    // that normally adds it already ran earlier in this same migrate() -
    // rebuilding afterward without it here would silently drop it.
    const messageLogsInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='message_logs'`);
    if (messageLogsInfo && messageLogsInfo.sql.includes("phone TEXT NOT NULL") && !messageLogsInfo.sql.includes("channel")) {

        // The generic school_id-backfill loop for MULTI_TENANT_TABLES runs
        // LATER in this same migrate() - on a fresh DB, message_logs won't
        // have school_id yet at this point; on an existing DB upgrading
        // from an earlier version, it already does, WITH real per-school
        // values that must not be lost. Handle both correctly instead of
        // assuming either one.
        const oldColumns = await all(`PRAGMA table_info(message_logs)`);
        const hadSchoolId = oldColumns.some(c => c.name === "school_id");

        await run(`
            CREATE TABLE message_logs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER,
                phone TEXT,
                email TEXT,
                channel TEXT NOT NULL DEFAULT 'whatsapp',
                type TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL,
                school_id INTEGER,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(student_id) REFERENCES students(id)
            )
        `);
        await run(`
            INSERT INTO message_logs_new (id, student_id, phone, channel, type, message, status, school_id, sent_at)
            SELECT id, student_id, phone, 'whatsapp', type, message, status, ${hadSchoolId ? "school_id" : "NULL"}, sent_at FROM message_logs
        `);
        await run(`DROP TABLE message_logs`);
        await run(`ALTER TABLE message_logs_new RENAME TO message_logs`);
        console.log("[migration] Rebuilt message_logs - now supports Email alongside WhatsApp.");
    }

    // Abacus test paper settings, per Level - only meaningful for
    // list_type='level' (same pattern as batch.sessions_per_week). Lets
    // each level have its own difficulty defaults for auto-generated
    // arithmetic practice/test papers.
    await addColumnIfMissing("lookup_items", "digit_count", "INTEGER");     // digits per number, e.g. 2
    await addColumnIfMissing("lookup_items", "operand_count", "INTEGER");   // numbers summed per problem, e.g. 5
    await addColumnIfMissing("lookup_items", "problem_count", "INTEGER");   // problems per paper, e.g. 20
    await addColumnIfMissing("lookup_items", "include_subtraction", "INTEGER NOT NULL DEFAULT 0");

    // Default days-of-week for a Batch (comma-separated 0-6, Sunday=0),
    // e.g. "2,5" for Tuesday+Friday - lets a Batch define its own typical
    // meeting days, which the Weekly Attendance Schedule on the Student
    // form can then auto-fill from when a batch is picked (a student can
    // still override the pre-filled days before saving).
    await addColumnIfMissing("lookup_items", "default_days", "TEXT");

    // Email (SMTP) - deployment-wide config via .env, same pattern as
    // FACE_SERVICE_URL/JWT_SECRET etc. Not stored in the DB - see
    // services/emailClient.js and .env.example.

    // Which BATCH a given attendance record is actually for, and whether
    // that's the student's own assigned batch or a different one (a
    // makeup/visiting session) - lets marking attendance be batch-driven
    // (as abacus classes actually run) instead of only class-driven, and
    // keeps a clean, honest record when someone attends outside their
    // normal batch rather than silently merging it into their usual one.
    await addColumnIfMissing("attendance", "batch_id", "INTEGER");
    await addColumnIfMissing("attendance", "is_different_batch", "INTEGER NOT NULL DEFAULT 0");
    // Actual hours attended for a Present record - a session may run 2
    // hours, but a student arriving late or leaving early attended less.
    // NULL for Absent records (there's nothing to log hours for).
    await addColumnIfMissing("attendance", "hours_attended", "REAL");

    // Weekly attendance schedule per student - which days of the week
    // they're expected in class (e.g. "Tue + Fri"), set from the Student
    // page similar to picking days for a recurring meeting. One row per
    // expected day; a student with no rows here just has no schedule set
    // yet (existing regularity math keeps working unaffected either way).
    await run(`
        CREATE TABLE IF NOT EXISTS student_schedule(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            day_of_week INTEGER NOT NULL, -- 0=Sunday .. 6=Saturday, matches JS Date.getDay()
            FOREIGN KEY(school_id) REFERENCES schools(id),
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_student_schedule_unique ON student_schedule(student_id, day_of_week)`);

    // Saved Abacus test papers - a generated paper now persists to disk +
    // this record, instead of being purely ephemeral (streamed once and
    // gone). Lets staff view/re-download/re-send a specific paper later
    // for reference, rather than being forced to regenerate a brand new
    // (differently randomized) one every time. level_name is snapshotted
    // in case the Level gets renamed or deleted afterward.
    await run(`
        CREATE TABLE IF NOT EXISTS test_papers_generated(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            level_id INTEGER,
            level_name TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'generated', -- 'generated' | 'uploaded'
            digit_count INTEGER,
            operand_count INTEGER,
            problem_count INTEGER,
            include_subtraction INTEGER NOT NULL DEFAULT 0,
            paper_date TEXT NOT NULL,
            file_path TEXT NOT NULL,
            generated_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    `);

    // Existing deployments created this table before "uploaded" papers
    // existed, with digit/operand/problem_count as NOT NULL (meaningless
    // for an uploaded file, which has no generated-problem settings at
    // all) and no `source` column. Rebuild to relax those constraints,
    // preserving every existing row as source='generated' (they all were,
    // before this migration existed).
    const testPapersInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='test_papers_generated'`);
    if (testPapersInfo && testPapersInfo.sql.includes("digit_count INTEGER NOT NULL") && !testPapersInfo.sql.includes("source")) {
        await run(`
            CREATE TABLE test_papers_generated_new(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                school_id INTEGER NOT NULL,
                level_id INTEGER,
                level_name TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'generated',
                digit_count INTEGER,
                operand_count INTEGER,
                problem_count INTEGER,
                include_subtraction INTEGER NOT NULL DEFAULT 0,
                paper_date TEXT NOT NULL,
                file_path TEXT NOT NULL,
                generated_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(school_id) REFERENCES schools(id)
            )
        `);
        await run(`
            INSERT INTO test_papers_generated_new
            (id, school_id, level_id, level_name, source, digit_count, operand_count, problem_count, include_subtraction, paper_date, file_path, generated_by, created_at)
            SELECT id, school_id, level_id, level_name, 'generated', digit_count, operand_count, problem_count, include_subtraction, paper_date, file_path, generated_by, created_at
            FROM test_papers_generated
        `);
        await run(`DROP TABLE test_papers_generated`);
        await run(`ALTER TABLE test_papers_generated_new RENAME TO test_papers_generated`);
        console.log("[migration] Rebuilt test_papers_generated - now supports manually uploaded papers too.");
    }

    // Level promotion history - every time a student's Level changes (via
    // the Promote Level page, single or bulk), this logs the before/after
    // so there's an audit trail of academic progression, and so a
    // "which level did they just complete" question always has a real
    // answer (used when generating a Level Completion certificate).
    await run(`
        CREATE TABLE IF NOT EXISTS level_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            old_level_id INTEGER,
            new_level_id INTEGER NOT NULL,
            changed_date TEXT NOT NULL,
            changed_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id),
            FOREIGN KEY(student_id) REFERENCES students(id)
        )
    `);

    // Referral programme: an existing student refers a prospective new
    // student; when that new student enrolls, school staff record who
    // referred them right on the Student Add form. The reward/discount
    // side of this (viewing all referrals, applying the reward as a fee
    // discount) is Super-Admin-only - see routes/superAdmin.js.
    await run(`
        CREATE TABLE IF NOT EXISTS referrals(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            referring_student_id INTEGER,
            referring_lead_name TEXT,
            referring_lead_phone TEXT,
            referred_student_id INTEGER,
            lead_name TEXT,
            lead_phone TEXT,
            lead_email TEXT,
            coupon_code TEXT,
            status TEXT NOT NULL DEFAULT 'New',
            reward_type TEXT NOT NULL DEFAULT 'FLAT',
            reward_value REAL NOT NULL DEFAULT 0,
            prize_description TEXT,
            reward_applied INTEGER NOT NULL DEFAULT 0,
            redeemed_at DATETIME,
            redeemed_by INTEGER,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id),
            FOREIGN KEY(referring_student_id) REFERENCES students(id),
            FOREIGN KEY(referred_student_id) REFERENCES students(id)
        )
    `);

    // Existing deployments created this table with referred_student_id
    // NOT NULL, before "leads" (people referred but not yet enrolled)
    // existed. Rebuild to relax that and add the new lead/coupon/
    // redemption columns, preserving every existing row exactly -
    // existing referrals become status='Enrolled' (they all pointed at
    // an already-enrolled student, since that was the only option before).
    const referralsInfo = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='referrals'`);
    if (referralsInfo && referralsInfo.sql.includes("referred_student_id INTEGER NOT NULL") && !referralsInfo.sql.includes("coupon_code")) {
        await run(`
            CREATE TABLE referrals_new(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                school_id INTEGER NOT NULL,
                referring_student_id INTEGER NOT NULL,
                referred_student_id INTEGER,
                lead_name TEXT,
                lead_phone TEXT,
                lead_email TEXT,
                coupon_code TEXT,
                status TEXT NOT NULL DEFAULT 'New',
                reward_type TEXT NOT NULL DEFAULT 'FLAT',
                reward_value REAL NOT NULL DEFAULT 0,
                reward_applied INTEGER NOT NULL DEFAULT 0,
                redeemed_at DATETIME,
                redeemed_by INTEGER,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(`
            INSERT INTO referrals_new
            (id, school_id, referring_student_id, referred_student_id, status, reward_type, reward_value, reward_applied, notes, created_at)
            SELECT id, school_id, referring_student_id, referred_student_id,
                   CASE WHEN reward_applied=1 THEN 'Redeemed' ELSE 'Enrolled' END,
                   reward_type, reward_value, reward_applied, notes, created_at
            FROM referrals
        `);
        await run(`DROP TABLE referrals`);
        await run(`ALTER TABLE referrals_new RENAME TO referrals`);
        console.log("[migration] Rebuilt referrals - now supports pre-enrollment leads, coupon codes, and redemption tracking.");
    }
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_coupon_code ON referrals(coupon_code)`);

    // Referring_student_id was NOT NULL - meaning only an already-enrolled
    // student could be recorded as the referrer. Relax that and add
    // referring_lead_* columns, so a REFERRER can also be a lead/prospect
    // who isn't (yet, or ever) an enrolled student themselves - e.g. a
    // parent, alumnus, or walk-in who brought in a new family. Also adds
    // prize_description, since a reward doesn't have to be money (see
    // reward_type='PRIZE' below) - existing rows are preserved as-is.
    const referralsInfo2 = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='referrals'`);
    if (referralsInfo2 && referralsInfo2.sql.includes("referring_student_id INTEGER NOT NULL")) {
        await run(`
            CREATE TABLE referrals_new2(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                school_id INTEGER NOT NULL,
                referring_student_id INTEGER,
                referring_lead_name TEXT,
                referring_lead_phone TEXT,
                referred_student_id INTEGER,
                lead_name TEXT,
                lead_phone TEXT,
                lead_email TEXT,
                coupon_code TEXT,
                status TEXT NOT NULL DEFAULT 'New',
                reward_type TEXT NOT NULL DEFAULT 'FLAT',
                reward_value REAL NOT NULL DEFAULT 0,
                prize_description TEXT,
                reward_applied INTEGER NOT NULL DEFAULT 0,
                redeemed_at DATETIME,
                redeemed_by INTEGER,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await run(`
            INSERT INTO referrals_new2
            (id, school_id, referring_student_id, referred_student_id, lead_name, lead_phone, lead_email,
             coupon_code, status, reward_type, reward_value, reward_applied, redeemed_at, redeemed_by, notes, created_at)
            SELECT id, school_id, referring_student_id, referred_student_id, lead_name, lead_phone, lead_email,
                   coupon_code, status, reward_type, reward_value, reward_applied, redeemed_at, redeemed_by, notes, created_at
            FROM referrals
        `);
        await run(`DROP TABLE referrals`);
        await run(`ALTER TABLE referrals_new2 RENAME TO referrals`);
        console.log("[migration] Rebuilt referrals - referrer can now be a lead (not just an enrolled student), and rewards can be a prize (not just money).");
    }
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_coupon_code ON referrals(coupon_code)`);

    // Super-Admin-configurable default reward per school, so front-desk
    // staff recording a referral don't have to type an amount each time -
    // it's pre-filled from here (still overridable per referral).
    await addColumnIfMissing("schools", "referral_reward_type", "TEXT NOT NULL DEFAULT 'FLAT'");
    await addColumnIfMissing("schools", "referral_reward_value", "REAL NOT NULL DEFAULT 0");

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

    // Default Hours Attended: pre-fills the "hours" box for every student
    // when Attendance Management is opened, instead of the previously
    // hardcoded 2. Kept as a REAL (not INTEGER) so schools running e.g.
    // 1.5-hour sessions can set that as their default too. Defaults to 2
    // so existing behaviour is unchanged unless an Admin changes it from
    // /settings.
    await addColumnIfMissing("schools", "default_hours_attended", "REAL NOT NULL DEFAULT 2");

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
