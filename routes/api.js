const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/database");
const { requireApiAuth, JWT_SECRET } = require("../middleware/auth");

/* ===========================================
   MOBILE APP LOGIN - returns a JWT to use as
   Authorization: Bearer <token> on every other /api and
   /attendance/face-mark call. No session/cookie involved.
=========================================== */
router.post("/login", (req, res) => {

    const { email, password } = req.body;

    db.get(
        `SELECT users.*, schools.name AS school_name
         FROM users JOIN schools ON users.school_id = schools.id
         WHERE users.email = ?`,
        [email],
        (err, user) => {

            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: "Invalid email or password" });

            const valid = bcrypt.compareSync(password || "", user.password_hash);
            if (!valid) return res.status(401).json({ error: "Invalid email or password" });

            const token = jwt.sign(
                { userId: user.id, schoolId: user.school_id, role: user.role },
                JWT_SECRET,
                { expiresIn: "30d" }
            );

            res.json({
                token,
                user: { id: user.id, name: user.name, role: user.role, schoolName: user.school_name }
            });

        }
    );

});


// Everything below requires a valid JWT (mobile app auth)
router.use(requireApiAuth);


// GET /api/classes -> [{id, class_name}]
router.get("/classes", (req, res) => {

    db.all(
        "SELECT id, class_name FROM classes WHERE school_id=? ORDER BY class_name",
        [req.schoolId],
        (err, rows) => {

            if (err) return res.status(500).json({ error: err.message });

            res.json(rows);

        }
    );

});

// GET /api/classes/:id/students -> [{id, name, admission_no, face_enrolled}]
// Used by the mobile app to show a class roster / manual fallback list.
router.get("/classes/:id/students", (req, res) => {

    db.all(
        `SELECT students.id, students.name, students.admission_no,
                CASE WHEN face_encodings.id IS NULL THEN 0 ELSE 1 END AS face_enrolled
         FROM students
         LEFT JOIN face_encodings ON face_encodings.student_id = students.id
         WHERE students.class_id = ? AND students.school_id = ?
         ORDER BY students.name`,
        [req.params.id, req.schoolId],
        (err, rows) => {

            if (err) return res.status(500).json({ error: err.message });

            res.json(rows);

        }
    );

});

// POST /api/attendance/manual  { student_id, attendance_date, status }
// Fallback for the mobile app when face recognition doesn't find a confident match.
router.post("/attendance/manual", (req, res) => {

    const { student_id, attendance_date, status } = req.body;
    const schoolId = req.schoolId;

    // Confirm the student belongs to this school before writing attendance for them.
    db.get(
        "SELECT id FROM students WHERE id=? AND school_id=?",
        [student_id, schoolId],
        (checkErr, student) => {

            if (checkErr) return res.status(500).json({ error: checkErr.message });
            if (!student) return res.status(403).json({ error: "Student not found for your school" });

            db.get(
                "SELECT id FROM attendance WHERE student_id=? AND attendance_date=?",
                [student_id, attendance_date],
                (err, existing) => {

                    if (err) return res.status(500).json({ error: err.message });

                    if (existing) {
                        db.run("UPDATE attendance SET status=? WHERE id=?", [status, existing.id], (err2) => {
                            if (err2) return res.status(500).json({ error: err2.message });
                            res.json({ ok: true });
                        });
                    } else {
                        db.run(
                            "INSERT INTO attendance (student_id, attendance_date, status, school_id) VALUES (?,?,?,?)",
                            [student_id, attendance_date, status, schoolId],
                            (err2) => {
                                if (err2) return res.status(500).json({ error: err2.message });
                                res.json({ ok: true });
                            }
                        );
                    }

                }
            );

        }
    );

});

module.exports = router;
