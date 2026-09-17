const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { requireLogin } = require("../middleware/auth");
const { logChange } = require("../services/auditLog");
const { saveComponent, loadComponent, getTemplate, templateToPrefill, saveTemplate } = require("../services/studentFeeComponents");

router.use(requireLogin);

const COMPONENTS = {
    tuition: "Tuition Fee",
    books: "Books Fee"
};

function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

/* ==========================================
   FEES TAB - Tuition Fee + Books Fee for one student, each independently
   payable in one shot, split evenly over N months, or a fully custom
   installment schedule staff defines upfront. See
   services/studentFeeComponents.js for how this ties into the rest of
   the fee system - every row it creates shows up automatically in Fee
   Collection, Fees Due, Fees Pending, Fee Collection Summary, and the
   Student Report, exactly like any other fee item.
========================================== */
router.get("/:studentId", async (req, res) => {

    const schoolId = req.schoolId;
    const studentId = req.params.studentId;

    try {
        const student = await dbGet("SELECT * FROM students WHERE id=? AND school_id=?", [studentId, schoolId]);
        if (!student) return res.send("Student not found");

        const levelName = student.level_id
            ? await dbGet("SELECT name FROM lookup_items WHERE id=? AND school_id=?", [student.level_id, schoolId])
            : null;

        const tuition = await loadComponent({ schoolId, studentId, categoryName: COMPONENTS.tuition });
        const books = await loadComponent({ schoolId, studentId, categoryName: COMPONENTS.books });

        // If this component has no schedule of its own yet, prefill the
        // form from this student's Level template (or the school-wide
        // default) instead of leaving it blank - due dates are never
        // templated, so those fields stay empty either way.
        for (const component of [tuition, books]) {
            if (component.items.length === 0) {
                const template = await getTemplate(schoolId, student.level_id, component === tuition ? COMPONENTS.tuition : COMPONENTS.books);
                if (template) {
                    component.prefill = templateToPrefill(template);
                    component.templateApplied = true;
                }
            }
        }

        const combinedTotal = Math.round((tuition.totalAmount + books.totalAmount) * 100) / 100;
        const combinedPaid = Math.round((tuition.totalPaid + books.totalPaid) * 100) / 100;
        const combinedDue = Math.round((tuition.totalDue + books.totalDue) * 100) / 100;

        res.render("students/fees", {
            student, tuition, books, levelName: levelName ? levelName.name : null,
            combinedTotal, combinedPaid, combinedDue,
            today: new Date().toISOString().slice(0, 10)
        });

    } catch (e) {
        res.send(e.message);
    }

});

function parseInstallmentsFromBody(body) {
    const labels = [].concat(body.installment_label || []);
    const amounts = [].concat(body.installment_amount || []);
    const dates = [].concat(body.installment_due_date || []);
    return amounts.map((amount, i) => ({ label: labels[i], amount, due_date: dates[i] || null }));
}

async function handleSave(req, res, componentKey) {

    const schoolId = req.schoolId;
    const studentId = req.params.studentId;
    const categoryName = COMPONENTS[componentKey];
    const mode = req.body.mode;

    if (!["single", "monthly", "custom"].includes(mode)) {
        return res.send("Please choose a valid payment mode.");
    }

    try {
        const student = await dbGet("SELECT class_id, level_id FROM students WHERE id=? AND school_id=?", [studentId, schoolId]);
        if (!student) return res.send("Student not found");

        const installments = parseInstallmentsFromBody(req.body);

        const result = await saveComponent({
            schoolId,
            studentId,
            classId: student.class_id,
            categoryName,
            mode,
            totalAmount: parseFloat(req.body.total_amount),
            singleDueDate: req.body.single_due_date || null,
            months: req.body.months,
            startDate: req.body.start_date,
            installments
        });

        // "Save as template" is checked by default (see the hidden
        // fallback input in the view) - unticking it saves just this
        // student without touching the Level's/school's saved template.
        if (req.body.save_as_template === "1") {
            const validInstallments = installments.filter(i => parseFloat(i.amount) > 0);
            await saveTemplate(schoolId, student.level_id, categoryName, {
                mode,
                totalAmount: parseFloat(req.body.total_amount) || null,
                months: parseInt(req.body.months) || null,
                installments: validInstallments
            });
        }

        const preservedNote = result.preserved.length
            ? `, ${result.preserved.length} earlier period(s) kept as-is (already paid/discounted)`
            : "";
        logChange({
            schoolId, branchId: null, req,
            entityType: "Student Fees", entityName: `${categoryName} - Student #${studentId}`,
            action: "Configured",
            details: `${mode}, ${result.wantedItems.length} item(s) - ${result.inserted} added, ${result.updated} updated, ${result.removed} removed${preservedNote}`
        });

        res.redirect(`/student-fees/${studentId}`);

    } catch (e) {
        res.send(e.message);
    }

}

router.post("/:studentId/tuition", (req, res) => handleSave(req, res, "tuition"));
router.post("/:studentId/books", (req, res) => handleSave(req, res, "books"));

module.exports = router;
