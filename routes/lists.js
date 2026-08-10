const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin, requireRole } = require("../middleware/auth");

router.use(requireLogin);

const LIST_TYPES = {
    course: "Courses",
    batch: "Batches",
    level: "Levels",
    branch: "Branches / Centres"
};

/* ==========================================
   VIEW ALL LISTS (Admin only)
========================================== */
router.get("/", requireRole("Admin"), (req, res) => {

    db.all(
        "SELECT * FROM lookup_items WHERE school_id=? ORDER BY list_type, name",
        [req.schoolId],
        (err, rows) => {

            if (err) return res.send(err.message);

            const grouped = {};
            Object.keys(LIST_TYPES).forEach(t => { grouped[t] = []; });
            rows.forEach(r => { if (grouped[r.list_type]) grouped[r.list_type].push(r); });

            res.render("lists", { listTypes: LIST_TYPES, grouped });

        }
    );

});

/* ==========================================
   ADD ITEM (Admin only)
========================================== */
router.post("/add", requireRole("Admin"), (req, res) => {

    const { list_type, name } = req.body;

    if (!LIST_TYPES[list_type] || !name || !name.trim()) {
        return res.redirect("/lists");
    }

    db.run(
        "INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)",
        [req.schoolId, list_type, name.trim()],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/lists");
        }
    );

});

/* ==========================================
   DELETE ITEM (Admin only)
   Students already pointing at a deleted item just show as unset - no FK
   enforcement, so this is always safe.
========================================== */
router.get("/delete/:id", requireRole("Admin"), (req, res) => {

    db.run(
        "DELETE FROM lookup_items WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/lists");
        }
    );

});

module.exports = router;
