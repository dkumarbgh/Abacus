const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { getSimpleFeeMode } = require("../services/schoolSettings");

router.use(requireLogin);

// View Fee Structure
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? AND is_active=1 ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM fee_categories WHERE school_id=? ORDER BY fee_name", [schoolId], (err, categories) => {

            if (err) return res.send(err.message);

            db.all(`
                SELECT fs.id,
                       c.class_name,
                       fc.fee_name,
                       fs.academic_year,
                       fs.amount
                FROM fee_structure fs
                JOIN classes c
                  ON fs.class_id = c.id
                JOIN fee_categories fc
                  ON fs.fee_category_id = fc.id
                WHERE fs.school_id = ?
                ORDER BY c.class_name
            `, [schoolId], (err, structure) => {

                if (err) return res.send(err.message);

                getSimpleFeeMode(schoolId)
                    .then(simpleFeeMode => {
                        res.render("fees/structure", {
                            classes,
                            categories,
                            structure,
                            simpleFeeMode
                        });
                    })
                    .catch(err2 => res.send(err2.message));

            });

        });

    });

});

// Save Fee Structure
router.post("/add", (req, res) => {

    const {
        class_id,
        fee_category_id,
        academic_year,
        amount
    } = req.body;

    // Note: due_date is no longer set here - each student now has their own
    // fee_due_date on their profile (Students > Edit), since due dates vary
    // per student rather than being shared across a whole class/fee item.
    db.run(`
        INSERT INTO fee_structure
        (class_id, fee_category_id, academic_year, amount, school_id)
        VALUES(?,?,?,?,?)
    `,
    [class_id, fee_category_id, academic_year, amount, req.schoolId],
    function(err){

        if(err){
            return res.send(err.message);
        }

        res.redirect("/fee-structure");

    });

});

// Delete

router.get("/delete/:id",(req,res)=>{

    db.run(
        "DELETE FROM fee_structure WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err){

            if(err){
                return res.send(err.message);
            }

            res.redirect("/fee-structure");

        });

});

module.exports = router;
