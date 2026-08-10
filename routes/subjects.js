const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ===========================================
   Subject List
=========================================== */
router.get("/", (req, res) => {

    const search = req.query.search || "";

    db.all(
        `SELECT *
         FROM subjects
         WHERE school_id=? AND subject_name LIKE ?
         ORDER BY subject_name`,
        [req.schoolId, `%${search}%`],
        (err, rows) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("subjects", {
                subjects: rows,
                search
            });

        });

});


/* ===========================================
   Add Subject Page
=========================================== */
router.get("/add", (req, res) => {

    res.render("addSubject");

});


/* ===========================================
   Save Subject
=========================================== */
router.post("/add", (req, res) => {

    const {
        subject_name,
        subject_code,
        description
    } = req.body;

    db.run(
        `INSERT INTO subjects
        (subject_name, subject_code, description, school_id)
        VALUES (?,?,?,?)`,
        [subject_name, subject_code, description, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/subjects");

        });

});


/* ===========================================
   Edit Subject
=========================================== */
router.get("/edit/:id", (req, res) => {

    db.get(
        "SELECT * FROM subjects WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, subject) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("editSubject", {
                subject
            });

        });

});


/* ===========================================
   Update Subject
=========================================== */
router.post("/edit/:id", (req, res) => {

    const {
        subject_name,
        subject_code,
        description
    } = req.body;

    db.run(
        `UPDATE subjects
         SET
         subject_name=?,
         subject_code=?,
         description=?
         WHERE id=? AND school_id=?`,
        [
            subject_name,
            subject_code,
            description,
            req.params.id,
            req.schoolId
        ],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/subjects");

        });

});


/* ===========================================
   Delete Subject
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM subjects WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/subjects");

        });

});

module.exports = router;
