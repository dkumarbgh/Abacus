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

            res.render("lists", { listTypes: LIST_TYPES, grouped, levels: grouped.level });

        }
    );

});

/* ==========================================
   ADD ITEM (Admin only)
========================================== */
router.post("/add", requireRole("Admin"), (req, res) => {

    const { list_type, name, sessions_per_week, level_id, digit_count, operand_count, problem_count, include_subtraction, default_days } = req.body;

    if (!LIST_TYPES[list_type] || !name || !name.trim()) {
        return res.redirect("/lists");
    }

    // default_days[] arrives as an array of checked day-of-week strings
    // ("0".."6"); normalize to a comma-separated string, or null if none
    // were checked (a batch with no default days set just won't auto-fill
    // anything on the student form).
    const defaultDaysStr = list_type === "batch" && default_days
        ? [].concat(default_days).map(Number).filter(d => d >= 0 && d <= 6).sort().join(",")
        : null;

    db.run(
        `INSERT INTO lookup_items
         (school_id, list_type, name, sessions_per_week, level_id, digit_count, operand_count, problem_count, include_subtraction, default_days)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
            req.schoolId, list_type, name.trim(),
            list_type === "batch" ? (parseInt(sessions_per_week) || null) : null,
            list_type === "batch" ? (parseInt(level_id) || null) : null,
            list_type === "level" ? (parseInt(digit_count) || null) : null,
            list_type === "level" ? (parseInt(operand_count) || null) : null,
            list_type === "level" ? (parseInt(problem_count) || null) : null,
            list_type === "level" ? (include_subtraction === "on" ? 1 : 0) : 0,
            defaultDaysStr || null
        ],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect("/lists");
        }
    );

});

/* ==========================================
   EDIT ITEM (Admin only)
========================================== */
router.get("/edit/:id", requireRole("Admin"), (req, res) => {

    db.get(
        "SELECT * FROM lookup_items WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, item) => {
            if (err) return res.send(err.message);
            if (!item) return res.send("Not found");
            db.all(
                "SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name",
                [req.schoolId],
                (err2, levels) => {
                    if (err2) return res.send(err2.message);
                    const defaultDays = (item.default_days || "").split(",").filter(d => d !== "").map(Number);
                    res.render("editListItem", { item, listTypes: LIST_TYPES, levels, defaultDays });
                }
            );
        }
    );

});

router.post("/edit/:id", requireRole("Admin"), (req, res) => {

    const { name, sessions_per_week, level_id, digit_count, operand_count, problem_count, include_subtraction, default_days } = req.body;

    db.get(
        "SELECT list_type FROM lookup_items WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, item) => {

            if (err) return res.send(err.message);
            if (!item) return res.send("Not found");

            const defaultDaysStr = item.list_type === "batch" && default_days
                ? [].concat(default_days).map(Number).filter(d => d >= 0 && d <= 6).sort().join(",")
                : null;

            db.run(
                `UPDATE lookup_items
                 SET name=?, sessions_per_week=?, level_id=?, digit_count=?, operand_count=?, problem_count=?, include_subtraction=?, default_days=?
                 WHERE id=? AND school_id=?`,
                [
                    name.trim(),
                    item.list_type === "batch" ? (parseInt(sessions_per_week) || null) : null,
                    item.list_type === "batch" ? (parseInt(level_id) || null) : null,
                    item.list_type === "level" ? (parseInt(digit_count) || null) : null,
                    item.list_type === "level" ? (parseInt(operand_count) || null) : null,
                    item.list_type === "level" ? (parseInt(problem_count) || null) : null,
                    item.list_type === "level" ? (include_subtraction === "on" ? 1 : 0) : 0,
                    defaultDaysStr || null,
                    req.params.id, req.schoolId
                ],
                (err2) => {
                    if (err2) return res.send(err2.message);
                    res.redirect("/lists");
                }
            );

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

/* ==========================================
   BATCH ROSTER - view/assign students to a specific batch
========================================== */
router.get("/batches/:id", requireRole("Admin"), (req, res) => {

    const schoolId = req.schoolId;
    const batchId = req.params.id;

    db.get(
        "SELECT * FROM lookup_items WHERE id=? AND school_id=? AND list_type='batch'",
        [batchId, schoolId],
        (err, batch) => {

            if (err) return res.send(err.message);
            if (!batch) return res.send("Batch not found");

            db.all(
                `SELECT students.id, students.name, students.admission_no, classes.class_name
                 FROM students
                 LEFT JOIN classes ON students.class_id = classes.id
                 WHERE students.batch_id = ? AND students.school_id = ?
                 ORDER BY students.name`,
                [batchId, schoolId],
                (err2, roster) => {

                    if (err2) return res.send(err2.message);

                    db.all(
                        `SELECT id, name, admission_no FROM students
                         WHERE school_id = ? AND (batch_id IS NULL OR batch_id != ?)
                         ORDER BY name`,
                        [schoolId, batchId],
                        (err3, available) => {

                            if (err3) return res.send(err3.message);

                            res.render("batchRoster", { batch, roster, available });

                        }
                    );

                }
            );

        }
    );

});

router.post("/batches/:id/add-student", requireRole("Admin"), (req, res) => {

    db.run(
        "UPDATE students SET batch_id=? WHERE id=? AND school_id=?",
        [req.params.id, req.body.student_id, req.schoolId],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect(`/lists/batches/${req.params.id}`);
        }
    );

});

router.post("/batches/:id/remove-student/:studentId", requireRole("Admin"), (req, res) => {

    db.run(
        "UPDATE students SET batch_id=NULL WHERE id=? AND school_id=? AND batch_id=?",
        [req.params.studentId, req.schoolId, req.params.id],
        (err) => {
            if (err) return res.send(err.message);
            res.redirect(`/lists/batches/${req.params.id}`);
        }
    );

});

module.exports = router;
