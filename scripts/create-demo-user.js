/**
 * Creates (or resets) a VIEW-ONLY demo login - someone who can log in and
 * look at everything, but can never add, change or delete anything (see
 * middleware/readOnly.js). Handy for giving prospective schools a demo.
 *
 * Usage:
 *   node scripts/create-demo-user.js <schoolId> [username] [password]
 *
 *   node scripts/create-demo-user.js 16                 -> user "test@iqplus.com", password "test123"
 *   node scripts/create-demo-user.js 16 test@iqplus.com MyDemo@26
 *
 * Re-running it for an existing username just resets that user's password,
 * school and view-only flag - it never creates a duplicate.
 *
 * You can do the same thing from the web UI: Super Admin > a school >
 * Add User (tick "View-only"), or Edit User on an existing one.
 *
 * Tip: point the demo login at a school filled with SAMPLE data, not a
 * real school - view-only still shows real students' names and phone
 * numbers to whoever has the login.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../config/database");

const [schoolIdArg, usernameArg, passwordArg] = process.argv.slice(2);
const schoolId = Number(schoolIdArg);
const username = (usernameArg || "test@iqplus.com").trim();
const password = passwordArg || "test123";

if (!schoolId) {
    console.log("Usage: node scripts/create-demo-user.js <schoolId> [username] [password]");
    db.all("SELECT id, name FROM schools ORDER BY id", [], (err, rows) => {
        if (!err) {
            console.log("\nSchools:");
            rows.forEach(r => console.log(`  ${r.id}  ${r.name}`));
        }
        process.exit(1);
    });
    return;
}

// Give migrate() (kicked off when config/database is required) a moment to
// add the users.read_only column on an older database.
setTimeout(() => {
    db.get("SELECT id, name FROM schools WHERE id=?", [schoolId], (err, school) => {
        if (err) { console.error(err.message); process.exit(1); }
        if (!school) { console.error(`No school with id ${schoolId}.`); process.exit(1); }

        const hash = bcrypt.hashSync(password, 10);

        db.get("SELECT id FROM users WHERE email=?", [username], (err2, existing) => {
            if (err2) { console.error(err2.message); process.exit(1); }

            const done = (e) => {
                if (e) { console.error(e.message); process.exit(1); }
                console.log(`${existing ? "Updated" : "Created"} view-only demo login for "${school.name}":`);
                console.log(`  Username: ${username}`);
                console.log(`  Password: ${password}`);
                process.exit(0);
            };

            if (existing) {
                db.run(
                    "UPDATE users SET school_id=?, name=?, password_hash=?, role='Admin', read_only=1 WHERE id=?",
                    [schoolId, "Demo (view only)", hash, existing.id], done
                );
            } else {
                db.run(
                    "INSERT INTO users (school_id, name, email, password_hash, role, read_only) VALUES (?,?,?,?, 'Admin', 1)",
                    [schoolId, "Demo (view only)", username, hash], done
                );
            }
        });
    });
}, 1500);
