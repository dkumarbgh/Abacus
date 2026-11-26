/**
 * Fee Payment Option - lets students in the SAME Level follow different
 * fee structures (e.g. one family pays an Annual fee, another pays a
 * Book Kit fee + Monthly tuition).
 *
 *  - students.fee_option     : "Annual" | "Monthly" | NULL (not set)
 *  - fee_structure.applies_to: "Annual" | "Monthly" | NULL (all students)
 *  - fee_plans.applies_to    : same, for Auto (From Join Date) plans; the
 *                              per-student installments a plan generates
 *                              carry a copy of it.
 *
 * Rule: a fee applies to a student when the fee is for all students, OR the
 * student has no option set yet (old behaviour - nothing disappears), OR
 * the two match. Items that already have a payment or discount recorded
 * stay visible in reports even if they no longer apply, so money received
 * is never hidden.
 */

const FEE_OPTIONS = ["Annual", "Monthly"];

// Accepts what people actually type in a sheet or form:
// "annual", "Annual Fee Payment", "Yearly", "monthly fee payment", ...
// Returns "Annual" / "Monthly", null for blank, or undefined if unrecognised.
function normalizeFeeOption(value) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    if (!v || v === "all" || v === "all students" || v === "-") return null;
    if (v.includes("annual") || v.includes("year")) return "Annual";
    if (v.includes("month")) return "Monthly";
    return undefined;
}

function feeAppliesToStudent(fs, student) {
    const a = (fs && fs.applies_to) || "";
    const o = (student && student.fee_option) || "";
    return !a || !o || a === o;
}

// SQL condition for the same rule. fsAlias = fee_structure alias,
// optionExpr = SQL for the student's option (a column like "students.fee_option"
// or "?" when it is passed as a parameter).
function sqlFeeApplies(fsAlias, optionExpr) {
    return `(COALESCE(${fsAlias}.applies_to,'') = '' OR COALESCE(${optionExpr},'') = '' OR ${fsAlias}.applies_to = ${optionExpr})`;
}

module.exports = { FEE_OPTIONS, normalizeFeeOption, feeAppliesToStudent, sqlFeeApplies };
