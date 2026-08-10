const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

/* ==========================================
   VIEW ALL FEE CATEGORIES
========================================== */

router.get("/", (req, res) => {

    db.all(
        "SELECT * FROM fee_categories WHERE school_id=? ORDER BY fee_name",
        [req.schoolId],
        (err, fees) => {

            if (err) {
                return res.send(err.message);
            }

            res.render("fees/index", {
                fees
            });

        }
    );

});


/* ==========================================
   ADD FEE CATEGORY
========================================== */

router.post("/add", (req, res) => {

    const { fee_name, description } = req.body;

    db.get(
        "SELECT id FROM fee_categories WHERE fee_name=? AND school_id=?",
        [fee_name, req.schoolId],
        (err, row) => {

            if (err) return res.send(err.message);

            if (row) {
                return res.send("Fee Category already exists.");
            }

            db.run(
                `INSERT INTO fee_categories
                (fee_name, description, school_id)
                VALUES (?, ?, ?)`,
                [fee_name, description, req.schoolId],
                function(err) {

                    if (err) {
                        return res.send(err.message);
                    }

                    res.redirect("/fees");

                }
            );

        });

});


/* ==========================================
   DELETE
========================================== */

router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM fee_categories WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/fees");

        });

});

module.exports = router;
