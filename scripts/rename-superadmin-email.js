// One-off script: rename the SuperAdmin login email.
// Run from the project root:  node scripts/rename-superadmin-email.js
//
// Uses the same DB_PATH your app already connects to (see config/database.js),
// so this always touches the correct database file - no need to hunt for it.

const db = require("../config/database");

const OLD_EMAIL = "Shrikanth@kuv.com";
const NEW_EMAIL = "Sreekanth@kuv.com";

db.get(
    "SELECT id, name, email, role FROM users WHERE email=?",
    [OLD_EMAIL],
    (err, row) => {
        if (err) {
            console.error("Lookup failed:", err.message);
            process.exit(1);
        }
        if (!row) {
            console.log(`No user found with email ${OLD_EMAIL}. Nothing to do.`);
            process.exit(0);
        }
        if (row.role !== "SuperAdmin") {
            console.log(`Found ${OLD_EMAIL}, but role is "${row.role}", not "SuperAdmin". Stopping - please check manually.`);
            process.exit(1);
        }

        console.log(`Found SuperAdmin: id=${row.id}, name=${row.name}, email=${row.email}`);

        db.run(
            "UPDATE users SET email=? WHERE id=? AND role='SuperAdmin'",
            [NEW_EMAIL, row.id],
            function (err2) {
                if (err2) {
                    console.error("Update failed:", err2.message);
                    process.exit(1);
                }
                console.log(`Updated. ${this.changes} row(s) changed. Login email is now ${NEW_EMAIL}.`);
                process.exit(0);
            }
        );
    }
);
