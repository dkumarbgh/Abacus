const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   Teacher List
=========================================== */
router.get("/", (req, res) => {

    const search = req.query.search || "";

    db.all(
        `SELECT *
         FROM teachers
         WHERE school_id=? AND name LIKE ?
         ORDER BY name`,
        [req.schoolId, `%${search}%`],
        (err, rows) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("teachers", {
                teachers: rows,
                search
            });

        });

});


/* ===========================================
   Add Teacher Page
=========================================== */
router.get("/add", (req, res) => {

    res.render("addTeacher");

});


/* ===========================================
   Save Teacher
=========================================== */
router.post("/add", (req, res) => {

    const {
        name,
        subject,
        phone,
        email,
        status
    } = req.body;

    db.run(
        `INSERT INTO teachers
        (name, subject, phone, email, status, school_id)
        VALUES (?,?,?,?,?,?)`,
        [name, subject, phone, email, status, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/teachers");

        });

});


/* ===========================================
   Edit Teacher
=========================================== */
router.get("/edit/:id", (req, res) => {

    db.get(
        "SELECT * FROM teachers WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, teacher) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("editTeacher", {
                teacher
            });

        });

});


/* ===========================================
   Update Teacher
=========================================== */
router.post("/edit/:id", (req, res) => {

    const {
        name,
        subject,
        phone,
        email,
        status
    } = req.body;

    db.run(
        `UPDATE teachers
         SET
         name=?,
         subject=?,
         phone=?,
         email=?,
         status=?
         WHERE id=? AND school_id=?`,
        [
            name,
            subject,
            phone,
            email,
            status,
            req.params.id,
            req.schoolId
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/teachers");

        });

});


/* ===========================================
   Delete Teacher
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM teachers WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/teachers");

        });

});

module.exports = router;
