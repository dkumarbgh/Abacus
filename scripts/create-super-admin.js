/**
 * Creates (or promotes an existing user to) a Super Admin - a login that
 * isn't scoped to one school. It can see and manage every school
 * registered in this deployment from /super-admin.
 *
 * There's no self-serve way to become a Super Admin (for obvious security
 * reasons) - this script is the only way to create the first one.
 *
 * Usage:
 *   node scripts/create-super-admin.js <email> <password> ["Display Name"]
 *
 * Examples:
 *   node scripts/create-super-admin.js owner@example.com MyStrongPass123
 *   node scripts/create-super-admin.js owner@example.com MyStrongPass123 "Platform Owner"
 *
 * If that email already belongs to an existing user, this PROMOTES them to
 * SuperAdmin (and updates their password) instead of creating a duplicate.
 */

const bcrypt = require("bcryptjs");
const db = require("../config/database");

const [, , email, password, name] = process.argv;

if (!email || !password) {
    console.log("Usage: node scripts/create-super-admin.js <email> <password> [\"Display Name\"]");
    process.exit(1);
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run() {

    await wait(1000); // let the migration in config/database.js finish first

    const passwordHash = bcrypt.hashSync(password, 10);

    db.all("SELECT id, school_id, role FROM users WHERE email=?", [email], (err, existing) => {

        if (err) { console.error(err.message); process.exit(1); }

        if (existing.length > 1) {
            console.log(`That email has ${existing.length} separate accounts (one per school), so it's ambiguous which to promote:`);
            existing.forEach(u => console.log(`  - user id ${u.id}, school_id ${u.school_id}, role ${u.role}`));
            console.log("Delete/rename the ones you don't want promoted first, then re-run this script.");
            process.exit(1);
        }

        if (existing.length === 1) {
            const target = existing[0];
            db.run(
                "UPDATE users SET role='SuperAdmin', password_hash=?, name=? WHERE id=?",
                [passwordHash, name || "Super Admin", target.id],
                (err2) => {
                    if (err2) { console.error(err2.message); process.exit(1); }
                    console.log(`Promoted existing user (${email}) to SuperAdmin and updated their password.`);
                    process.exit(0);
                }
            );
            return;
        }

        // A user row still needs SOME school_id (schema requires it, and
        // it's not enforced as a real foreign key), but it's inert for a
        // SuperAdmin - their access isn't scoped by it, /super-admin routes
        // never filter by req.schoolId. We attach them to the first school
        // that exists; if NONE exist yet (a brand new deployment, before
        // anyone has registered a school), we create one dedicated
        // placeholder row for this purpose instead of guessing an id like
        // "1" that might not correspond to any real row - login itself no
        // longer strictly requires a matching row either (LEFT JOIN), but
        // pointing at something real avoids a dangling/confusing reference.
        db.get("SELECT id FROM schools ORDER BY id LIMIT 1", (err3, school) => {

            if (err3) { console.error(err3.message); process.exit(1); }

            if (school) return createUser(school.id);

            db.run(
                "INSERT INTO schools (name) VALUES ('System (Super Admin accounts)')",
                function (err5) {
                    if (err5) { console.error(err5.message); process.exit(1); }
                    createUser(this.lastID);
                }
            );

            function createUser(schoolId) {

                db.run(
                    "INSERT INTO users (school_id, name, email, password_hash, role) VALUES (?,?,?,?,?)",
                    [schoolId, name || "Super Admin", email, passwordHash, "SuperAdmin"],
                    (err4) => {
                        if (err4) { console.error(err4.message); process.exit(1); }
                        console.log(`Created SuperAdmin login: ${email}`);
                        console.log(`Log in at /login, and you'll land on /super-admin automatically.`);
                        process.exit(0);
                    }
                );

            }

        });

    });

}

run();
