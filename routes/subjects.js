const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { requireCapability } = require("../services/capabilities");

router.use(requireLogin);
router.use(requireCapability("subjects"));

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
// A duplicate Subject Code used to show the raw database error
// ("SQLITE_CONSTRAINT: UNIQUE constraint failed ...") - say it plainly instead.
function subjectSaveError(res, err, code) {
    if (/UNIQUE/i.test(err.message)) {
        return res.status(400).send(
            `<h4>The subject code "${String(code || "").replace(/[<>&"]/g, "")}" is already used by another subject. Please choose a different code.</h4>` +
            `<a href="/subjects">Back to Subjects</a>`
        );
    }
    return res.send(err.message);
}

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
                return subjectSaveError(res, err, (req.body || {}).subject_code);
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
                return subjectSaveError(res, err, (req.body || {}).subject_code);
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
                return subjectSaveError(res, err, (req.body || {}).subject_code);
            }

            res.redirect("/subjects");

        });

});

module.exports = router;
