/**
 * Single source of truth for the Student import/export spreadsheet columns.
 * Used by the export route (fills these from the DB), the template
 * download (headers only), and the import route (reads these back).
 *
 * `key` is the students table column (or a special one handled separately
 * - class_name, course_name, batch_name, level_name, branch_name - which
 * get resolved to/from the matching lookup table by name instead of ID,
 * since spreadsheet users think in names, not internal IDs).
 */
const STUDENT_COLUMNS = [
    { key: "name", header: "Full Name" },
    { key: "admission_no", header: "Roll Number" },
    { key: "age", header: "Age" },
    { key: "gender", header: "Gender" },
    { key: "dob", header: "DOB (YYYY-MM-DD)" },
    { key: "class_name", header: "Class" },
    { key: "mother_tongue", header: "Mother Tongue" },
    { key: "mother_name", header: "Mother's Name" },
    { key: "father_name", header: "Father's Name" },
    { key: "mother_occupation", header: "Mother's Occupation" },
    { key: "father_occupation", header: "Father's Occupation" },
    { key: "mother_phone", header: "Mother's Contact Number" },
    { key: "father_phone", header: "Father's Contact Number" },
    { key: "mother_email", header: "Mother's Email" },
    { key: "father_email", header: "Father's Email" },
    { key: "guardian_name", header: "Guardian Name" },
    { key: "guardian_phone", header: "Parent Contact No." },
    { key: "guardian_phone_2", header: "Guardian's Contact No." },
    { key: "guardian_email", header: "Guardian Email" },
    { key: "address", header: "Residential Address" },
    { key: "previous_school", header: "School" },
    { key: "stream", header: "Stream" },
    { key: "standard", header: "Standard" },
    { key: "religion", header: "Religion" },
    { key: "nationality", header: "Nationality" },
    { key: "country", header: "Country" },
    { key: "state", header: "State" },
    { key: "city", header: "City" },
    { key: "course_name", header: "Course" },
    { key: "batch_name", header: "Batch" },
    { key: "level_name", header: "Level" },
    { key: "branch_name", header: "Branch / Centre" },
    { key: "total_hours_per_month", header: "Total Hours in Month" },
    { key: "fee_due_date", header: "Fee Due Date (YYYY-MM-DD)" }
];

module.exports = { STUDENT_COLUMNS };
