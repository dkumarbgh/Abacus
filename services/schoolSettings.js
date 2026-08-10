const db = require("../config/database");

/**
 * Fetches whether Simple Fee Mode is ON for a school.
 * Returns a Promise<boolean> for easy use alongside async/await call sites,
 * but also works fine with .then() in plain callback-style code.
 */
function getSimpleFeeMode(schoolId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT simple_fee_mode FROM schools WHERE id=?", [schoolId], (err, row) => {
            if (err) return reject(err);
            resolve(!!(row && row.simple_fee_mode));
        });
    });
}

/**
 * Per-form default mandatory rules. A field NOT listed here isn't a
 * configurable field at all (e.g. it's hard-required or always optional
 * in code, not something Settings can change).
 *
 * Shape: { [formKey]: { [fieldKey]: { label, defaultMandatory } } }
 */
const FIELD_DEFS = {
    student: {
        admission_no:   { label: "Admission No.",           defaultMandatory: false },
        age:            { label: "Age",                     defaultMandatory: true },
        gender:         { label: "Gender",                  defaultMandatory: false },
        dob:            { label: "Date of Birth",            defaultMandatory: false },
        guardian_name:  { label: "Guardian Name",            defaultMandatory: true },
        guardian_phone: { label: "Guardian WhatsApp Number", defaultMandatory: true },
        guardian_email: { label: "Guardian Email",           defaultMandatory: false },
        address:        { label: "Address",                  defaultMandatory: false },
        fee_due_date:   { label: "Fee Due Date",             defaultMandatory: false },

        mother_tongue:      { label: "Mother Tongue",              defaultMandatory: false },
        mother_name:        { label: "Mother's Name",               defaultMandatory: false },
        father_name:        { label: "Father's Name",               defaultMandatory: false },
        mother_occupation:  { label: "Mother's Occupation",         defaultMandatory: false },
        father_occupation:  { label: "Father's Occupation",         defaultMandatory: false },
        mother_phone:       { label: "Mother's Contact Number",     defaultMandatory: false },
        father_phone:       { label: "Father's Contact Number",     defaultMandatory: false },
        mother_email:       { label: "Mother's Email",              defaultMandatory: false },
        father_email:       { label: "Father's Email",              defaultMandatory: false },
        previous_school:    { label: "School",                      defaultMandatory: false },
        stream:             { label: "Stream",                      defaultMandatory: false },
        standard:           { label: "Standard",                    defaultMandatory: false },
        religion:           { label: "Religion",                    defaultMandatory: false },
        nationality:        { label: "Nationality",                 defaultMandatory: false },
        country:            { label: "Country",                     defaultMandatory: false },
        state:              { label: "State",                       defaultMandatory: false },
        city:               { label: "City",                        defaultMandatory: false },
        course_id:          { label: "Course",                      defaultMandatory: false },
        batch_id:           { label: "Batch",                       defaultMandatory: false },
        level_id:           { label: "Level",                       defaultMandatory: false },
        branch_id:          { label: "Branch / Centre",             defaultMandatory: false },
        total_hours_per_month: { label: "Total Hours in Month",     defaultMandatory: false }
    }
};

/**
 * Returns { [fieldKey]: true|false } for every configurable field of a form,
 * merging the school's saved overrides (field_settings table) on top of the
 * built-in defaults above. Fields not in FIELD_DEFS are not included (the
 * views/routes treat those as always-mandatory, e.g. Name/Class).
 */
function getFieldSettings(schoolId, formKey) {
    return new Promise((resolve, reject) => {
        const defs = FIELD_DEFS[formKey] || {};
        const result = {};
        Object.keys(defs).forEach(key => { result[key] = defs[key].defaultMandatory; });

        db.all(
            "SELECT field_key, is_mandatory FROM field_settings WHERE school_id=? AND form_key=?",
            [schoolId, formKey],
            (err, rows) => {
                if (err) return reject(err);
                rows.forEach(r => {
                    if (Object.prototype.hasOwnProperty.call(result, r.field_key)) {
                        result[r.field_key] = !!r.is_mandatory;
                    }
                });
                resolve(result);
            }
        );
    });
}

/**
 * Fetches admission-number auto-assignment settings for a school.
 * Returns { auto, prefix, next, preview } where preview is what the NEXT
 * assigned number would look like right now (prefix + zero-padded next).
 */
function getAdmissionNoSettings(schoolId) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT admission_no_auto, admission_no_prefix, admission_no_next FROM schools WHERE id=?",
            [schoolId],
            (err, row) => {
                if (err) return reject(err);
                const auto = !!(row && row.admission_no_auto);
                const prefix = (row && row.admission_no_prefix) || "";
                const next = (row && row.admission_no_next) || 1;
                resolve({ auto, prefix, next, preview: `${prefix}${String(next).padStart(4, "0")}` });
            }
        );
    });
}

/**
 * Atomically hands out the next admission number for a school and
 * advances the counter, so two students registered back-to-back never
 * collide. Returns the assigned string (e.g. "2026/0001"). Only call this
 * when admission_no_auto is actually ON for the school - check first with
 * getAdmissionNoSettings if you need to decide whether to call it at all.
 */
function assignNextAdmissionNo(schoolId) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT admission_no_prefix, admission_no_next FROM schools WHERE id=?",
            [schoolId],
            (err, row) => {
                if (err) return reject(err);
                const prefix = (row && row.admission_no_prefix) || "";
                const next = (row && row.admission_no_next) || 1;
                const assigned = `${prefix}${String(next).padStart(4, "0")}`;
                db.run(
                    "UPDATE schools SET admission_no_next=? WHERE id=?",
                    [next + 1, schoolId],
                    (err2) => err2 ? reject(err2) : resolve(assigned)
                );
            }
        );
    });
}

module.exports = { getSimpleFeeMode, getFieldSettings, FIELD_DEFS, getAdmissionNoSettings, assignNextAdmissionNo };
