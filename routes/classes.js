const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

// Display Classes
router.get("/", (req, res) => {

    db.all(
        "SELECT * FROM classes WHERE school_id=? ORDER BY is_active DESC, class_name",
        [req.schoolId],
        (err, rows) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("classes", {
                classes: rows
            });

        });

});

// Add Class Page
router.get("/add", (req, res) => {

    res.render("addClass");

});

// Save Class
router.post("/add", (req, res) => {

    db.run(
        "INSERT INTO classes(class_name, school_id) VALUES(?,?)",
        [req.body.class_name, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/classes");

        });

});

// Edit Class Page
router.get("/edit/:id", (req, res) => {

    db.get(
        "SELECT * FROM classes WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, cls) => {

            if (err) return res.send(err.message);
            if (!cls) return res.send("Class not found");

            res.render("editClass", { cls });

        });

});

// Save Edited Class
router.post("/edit/:id", (req, res) => {

    db.run(
        "UPDATE classes SET class_name=? WHERE id=? AND school_id=?",
        [req.body.class_name, req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/classes");

        });

});

// Toggle Active/Inactive
// Inactive classes are hidden from the "pick a class" dropdown when adding a
// new student or a new Fee Structure item, but stay fully visible/usable
// everywhere a student is already assigned to them (their profile, reports,
// attendance history, etc.) - so marking a class inactive is safe even if
// students are still enrolled in it; it just stops NEW enrollments there.
router.post("/toggle/:id", (req, res) => {

    db.run(
        "UPDATE classes SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/classes");

        });

});

// Delete Class
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM classes WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/classes");

        });

});

module.exports = router;
