const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { getSimpleFeeMode } = require("../services/schoolSettings");
const { logChange } = require("../services/auditLog");
const { assignPlanToLevel } = require("../services/feePlanGenerator");

router.use(requireLogin);

// View Fee Structure
router.get("/", (req, res) => {

    const schoolId = req.schoolId;

    db.all("SELECT * FROM lookup_items WHERE school_id=? AND list_type='level' ORDER BY name", [schoolId], (err, levels) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM fee_categories WHERE school_id=? ORDER BY fee_name", [schoolId], (err, categories) => {

            if (err) return res.send(err.message);

            db.all(`
                SELECT fs.id,
                       fs.level_id,
                       fs.class_id,
                       c.class_name,
                       lv.name AS level_name,
                       fs.fee_category_id,
                       fc.fee_name,
                       fs.academic_year,
                       fs.amount,
                       fs.installment_label,
                       fs.payment_mode
                FROM fee_structure fs
                LEFT JOIN classes c
                  ON fs.class_id = c.id
                LEFT JOIN lookup_items lv
                  ON fs.level_id = lv.id
                JOIN fee_categories fc
                  ON fs.fee_category_id = fc.id
                WHERE fs.school_id = ? AND fs.student_id IS NULL
                ORDER BY lv.name, c.class_name, fc.fee_name, fs.id
            `, [schoolId], (err, structure) => {

                if (err) return res.send(err.message);

                // Group installment-plan rows (Monthly/Bimonthly/Quarterly/
                // Half-Yearly) that belong to the SAME plan - same Category
                // + Level/Class + Academic Year + Payment Mode - into one
                // summary row for the list, so a 12-row Monthly plan shows
                // as a single line with a "View" toggle instead of
                // cluttering the table with every period. Single-payment
                // rows are never grouped - there's only ever one of those
                // per Category+Level+Year anyway.
                const singles = [];
                const groupMap = {};
                structure.forEach(item => {
                    if (item.payment_mode === "single") {
                        singles.push(item);
                        return;
                    }
                    const key = [item.fee_category_id, item.level_id, item.class_id, item.academic_year, item.payment_mode].join("|");
                    if (!groupMap[key]) {
                        groupMap[key] = {
                            key,
                            level_name: item.level_name,
                            class_name: item.class_name,
                            fee_name: item.fee_name,
                            academic_year: item.academic_year,
                            payment_mode: item.payment_mode,
                            totalAmount: 0,
                            installments: []
                        };
                    }
                    groupMap[key].totalAmount += item.amount;
                    groupMap[key].installments.push(item);
                });
                const groups = Object.values(groupMap).map(g => ({
                    ...g,
                    totalAmount: Math.round(g.totalAmount * 100) / 100 // avoid floating-point artifacts like 10000.000000000002
                }));

                getSimpleFeeMode(schoolId)
                    .then(simpleFeeMode => {
                        db.all(
                            `SELECT fee_plans.*, lv.name AS level_name, fc.fee_name
                             FROM fee_plans
                             LEFT JOIN lookup_items lv ON fee_plans.level_id = lv.id
                             JOIN fee_categories fc ON fee_plans.fee_category_id = fc.id
                             WHERE fee_plans.school_id = ?
                             ORDER BY fee_plans.created_at DESC`,
                            [schoolId],
                            (errPlans, feePlans) => {

                                if (errPlans) return res.send(errPlans.message);

                                res.render("fees/structure", {
                                    levels,
                                    categories,
                                    singles,
                                    groups,
                                    feePlans: feePlans || [],
                                    simpleFeeMode
                                });

                            }
                        );
                    })
                    .catch(err2 => res.send(err2.message));

            });

        });

    });

});

// Save Fee Structure
router.post("/add", (req, res) => {

    const {
        level_id,
        fee_category_id,
        academic_year,
        amount
    } = req.body;

    // New entries are created by LEVEL now (class_id stays NULL) - any
    // OLDER class_id-based entries already in the database keep working
    // exactly as before, matched via a separate path in the fee
    // computation logic (see computeDuesByClass in routes/reports.js and
    // the matching queries in routes/feePayments.js).
    //
    // Note: due_date is no longer set here - each student now has their
    // own fee_due_date on their profile (Students > Edit), since due
    // dates vary per student rather than being shared across a whole
    // class/level/fee item.
    db.run(`
        INSERT INTO fee_structure
        (level_id, fee_category_id, academic_year, amount, payment_mode, school_id)
        VALUES(?,?,?,?,?,?)
    `,
    [level_id, fee_category_id, academic_year, amount, "single", req.schoolId],
    function(err){

        if(err){
            return res.send(err.message);
        }

        const schoolId = req.schoolId;
        db.get("SELECT fee_name FROM fee_categories WHERE id=?", [fee_category_id], (errC, cat) => {
            logChange({
                schoolId, branchId: null, req,
                entityType: "Fee Structure", entityName: cat ? cat.fee_name : `Category #${fee_category_id}`,
                action: "Created",
                details: `${academic_year}, ₹${amount}, Single Payment`
            });
            res.redirect("/fee-structure");
        });

    });

});

// Save Fee Structure as an INSTALLMENT PLAN - Monthly, Bimonthly,
// Quarterly, or Half-Yearly. One fee_structure row per period, all
// sharing the same Fee Category/Level/Academic Year/Payment Mode, so
// they're still tracked and reported together (Fee Dues, Fee Collection,
// Fee Collection Summary, Student Payment History) exactly like any
// other fee - each period just has its own amount and label. Amounts can
// differ period to period (e.g. a lower amount for the admission month),
// so this expects an explicit amount per period rather than computing an
// even split itself.
const VALID_INSTALLMENT_MODES = ["monthly", "bimonthly", "quarterly", "half_yearly"];

router.post("/add-monthly", (req, res) => {

    const { level_id, fee_category_id, academic_year } = req.body;
    const paymentMode = VALID_INSTALLMENT_MODES.includes(req.body.payment_mode) ? req.body.payment_mode : "monthly";
    const labels = [].concat(req.body.month_label || []);
    const amounts = [].concat(req.body.month_amount || []);
    const schoolId = req.schoolId;

    const rows = [];
    for (let i = 0; i < labels.length; i++) {
        const label = (labels[i] || "").trim();
        const amount = parseFloat(amounts[i]);
        if (!label || isNaN(amount) || amount <= 0) continue; // skip blank/incomplete rows
        rows.push({ label, amount });
    }

    if (rows.length === 0) {
        return res.send("Please fill in at least one period's label and amount.");
    }

    const insertNext = (i) => {
        if (i >= rows.length) {
            db.get("SELECT fee_name FROM fee_categories WHERE id=?", [fee_category_id], (errC, cat) => {
                logChange({
                    schoolId, branchId: null, req,
                    entityType: "Fee Structure", entityName: cat ? cat.fee_name : `Category #${fee_category_id}`,
                    action: "Created",
                    details: `${academic_year}, ${rows.length} installments (${paymentMode})`
                });
                res.redirect("/fee-structure");
            });
            return;
        }
        db.run(
            `INSERT INTO fee_structure (level_id, fee_category_id, academic_year, amount, installment_label, payment_mode, school_id)
             VALUES (?,?,?,?,?,?,?)`,
            [level_id, fee_category_id, academic_year, rows[i].amount, rows[i].label, paymentMode, schoolId],
            (err) => {
                if (err) return res.send(err.message);
                insertNext(i + 1);
            }
        );
    };
    insertNext(0);

});

// Delete

router.get("/delete/:id",(req,res)=>{

    const schoolId = req.schoolId;

    db.get(
        `SELECT fee_categories.fee_name, fee_structure.installment_label, fee_structure.academic_year
         FROM fee_structure JOIN fee_categories ON fee_structure.fee_category_id = fee_categories.id
         WHERE fee_structure.id=? AND fee_structure.school_id=?`,
        [req.params.id, schoolId],
        (lookupErr, item) => {

            db.run(
                "DELETE FROM fee_structure WHERE id=? AND school_id=?",
                [req.params.id, schoolId],
                function(err){

                    if(err){
                        return res.send(err.message);
                    }

                    logChange({
                        schoolId, branchId: null, req,
                        entityType: "Fee Structure",
                        entityName: item ? item.fee_name + (item.installment_label ? " - " + item.installment_label : "") : `#${req.params.id}`,
                        action: "Deleted"
                    });

                    res.redirect("/fee-structure");

                });

        }
    );

});

// Delete an ENTIRE installment plan at once (every period sharing the
// same Category + Level/Class + Academic Year + Payment Mode) - the
// summary row's "Delete Entire Plan" button on the Fee Structure list,
// so removing a 12-part Monthly plan doesn't require 12 separate clicks.
router.get("/delete-plan", (req, res) => {

    const schoolId = req.schoolId;
    const { fee_category_id, level_id, class_id, academic_year, payment_mode } = req.query;

    let sql = "SELECT id FROM fee_structure WHERE school_id=? AND fee_category_id=? AND academic_year=? AND payment_mode=?";
    const params = [schoolId, fee_category_id, academic_year, payment_mode];
    if (level_id) { sql += " AND level_id=?"; params.push(level_id); }
    else { sql += " AND level_id IS NULL"; }
    if (class_id) { sql += " AND class_id=?"; params.push(class_id); }
    else { sql += " AND class_id IS NULL"; }

    db.all(sql, params, (err, rows) => {

        if (err) return res.send(err.message);

        const ids = rows.map(r => r.id);
        if (ids.length === 0) return res.redirect("/fee-structure");

        db.get("SELECT fee_name FROM fee_categories WHERE id=?", [fee_category_id], (errC, cat) => {

            db.run(`DELETE FROM fee_structure WHERE id IN (${ids.map(() => "?").join(",")})`, ids, (err2) => {

                if (err2) return res.send(err2.message);

                logChange({
                    schoolId, branchId: null, req,
                    entityType: "Fee Structure",
                    entityName: cat ? cat.fee_name : `Category #${fee_category_id}`,
                    action: "Deleted",
                    details: `Entire ${payment_mode} plan removed (${ids.length} installments, ${academic_year})`
                });

                res.redirect("/fee-structure");

            });

        });

    });

});

// Create a Fee Plan (a per-Level RATE, e.g. "Level 1, Monthly, ₹1000/period")
// - immediately generates periods for every CURRENT student in that Level
// who already has a Date of Joining set; students without one yet are
// skipped and reported, and pick up their periods automatically the next
// time their profile is saved with a join date (see routes/students.js),
// or via "Assign to Missing Students" below.
router.post("/plans/add", async (req, res) => {

    const { level_id, fee_category_id, academic_year, payment_mode, amount_per_period } = req.body;
    const schoolId = req.schoolId;
    const durationMonths = Math.max(1, parseInt(req.body.duration_months) || 12);

    if (!VALID_INSTALLMENT_MODES.includes(payment_mode)) {
        return res.send("Please choose a valid Payment Mode for the plan.");
    }

    try {

        const result = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO fee_plans (school_id, level_id, fee_category_id, academic_year, payment_mode, amount_per_period, duration_months)
                 VALUES (?,?,?,?,?,?,?)`,
                [schoolId, level_id, fee_category_id, academic_year, payment_mode, parseFloat(amount_per_period), durationMonths],
                function(err) { err ? reject(err) : resolve(this); }
            );
        });

        const plan = { id: result.lastID, level_id, fee_category_id, academic_year, payment_mode, amount_per_period: parseFloat(amount_per_period), duration_months: durationMonths };
        const { assignedStudents, totalPeriods, skippedNoJoinDate } = await assignPlanToLevel(plan, schoolId);

        const cat = await new Promise((resolve) => db.get("SELECT fee_name FROM fee_categories WHERE id=?", [fee_category_id], (e, r) => resolve(r)));
        logChange({
            schoolId, branchId: null, req,
            entityType: "Fee Plan", entityName: cat ? cat.fee_name : `Category #${fee_category_id}`,
            action: "Created",
            details: `${academic_year}, ${payment_mode}, ₹${amount_per_period}/period, ${durationMonths} months from each student's join date - assigned to ${assignedStudents} student(s), ${totalPeriods} periods total${skippedNoJoinDate ? `, ${skippedNoJoinDate} student(s) skipped (no Date of Joining)` : ""}`
        });

        res.redirect("/fee-structure");

    } catch (e) {
        res.send(e.message);
    }

});

// "Assign to Missing Students" - re-runs generation for a plan, picking
// up anyone who joined (or had their Date of Joining filled in/corrected)
// since the plan was created or last run. Purely additive - see
// services/feePlanGenerator.js.
router.get("/plans/:id/assign-missing", async (req, res) => {

    const schoolId = req.schoolId;

    try {

        const plan = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM fee_plans WHERE id=? AND school_id=?", [req.params.id, schoolId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!plan) return res.send("Fee Plan not found");

        const { assignedStudents, totalPeriods, totalRemoved, skippedNoJoinDate } = await assignPlanToLevel(plan, schoolId);

        const cat = await new Promise((resolve) => db.get("SELECT fee_name FROM fee_categories WHERE id=?", [plan.fee_category_id], (e, r) => resolve(r)));
        logChange({
            schoolId, branchId: null, req,
            entityType: "Fee Plan", entityName: cat ? cat.fee_name : `Category #${plan.fee_category_id}`,
            action: "Synced Student Periods",
            details: `${assignedStudents} student(s) updated - ${totalPeriods} period(s) added, ${totalRemoved} stale unpaid period(s) removed (e.g. from a corrected Date of Joining), ${skippedNoJoinDate} skipped (no Date of Joining)`
        });

        res.redirect("/fee-structure");

    } catch (e) {
        res.send(e.message);
    }

});

// Delete a Fee Plan - only removes the PLAN (the "rate" record) itself,
// never any already-generated per-student fee_structure rows, so past
// dues, payments, and discounts stay exactly as they were. New students
// just won't get periods auto-generated from this plan going forward.
router.get("/plans/:id/delete", async (req, res) => {

    const schoolId = req.schoolId;

    try {

        const plan = await new Promise((resolve, reject) => {
            db.get(
                `SELECT fee_plans.*, fc.fee_name FROM fee_plans JOIN fee_categories fc ON fee_plans.fee_category_id = fc.id
                 WHERE fee_plans.id=? AND fee_plans.school_id=?`,
                [req.params.id, schoolId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        await new Promise((resolve, reject) => {
            db.run("DELETE FROM fee_plans WHERE id=? AND school_id=?", [req.params.id, schoolId], (err) => err ? reject(err) : resolve());
        });

        logChange({
            schoolId, branchId: null, req,
            entityType: "Fee Plan", entityName: plan ? plan.fee_name : `#${req.params.id}`, action: "Deleted",
            details: "Already-generated student fee periods were kept - only the plan/rate itself was removed."
        });

        res.redirect("/fee-structure");

    } catch (e) {
        res.send(e.message);
    }

});

module.exports = router;
