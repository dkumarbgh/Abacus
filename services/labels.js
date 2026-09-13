const db = require("../config/database");

/**
 * i18n / customizable-labels system.
 *
 * Every piece of UI text that's been migrated to this system has a key
 * (e.g. "attendance.save_button") and a default value per supported
 * language. A school can also override any individual key with its own
 * custom text (e.g. renaming "Batch" to "Section"), independent of which
 * language is selected - see label_overrides in config/database.js.
 *
 * THIS IS A ROLLING MIGRATION. Views are being converted to use t(key)
 * screen by screen - a screen that hasn't been converted yet still shows
 * plain hardcoded English, same as before. Keys are added here as each
 * screen is migrated; there's no need for every string in the app to
 * exist here before this is useful.
 *
 * Adding a new key: add it to both DEFAULTS.en and DEFAULTS.kn below,
 * then use `<%= t('your.key') %>` in the view. If a key is used in a
 * view but not listed here, t() falls back to returning the raw key
 * string - visibly obviously wrong (rather than blank), which makes an
 * unmigrated/missing string easy to spot during testing.
 */

const DEFAULTS = {
    en: {
        "common.save": "Save",
        "common.cancel": "Cancel",
        "common.edit": "Edit",
        "common.delete": "Delete",
        "common.export": "Export",
        "common.import": "Import",
        "common.search": "Search",
        "common.actions": "Actions",
        "common.date": "Date",
        "common.status": "Status",
        "common.name": "Name",
        "common.back": "Back",
        "common.go": "Go",

        "attendance.title": "Attendance",
        "attendance.select_batch": "Select Batch",
        "attendance.select_date": "Date",
        "attendance.load": "Load",
        "attendance.save_button": "💾 Save Attendance",
        "attendance.add_cross_batch_label": "Add a student attending from a DIFFERENT batch today (e.g. makeup class)",
        "attendance.search_placeholder": "Search by Roll No. or Name...",
        "attendance.add_from_batch_label": "Or add several students from another batch at once",
        "attendance.add_from_batch_select": "Choose a batch to browse its students",
        "attendance.add_selected": "➕ Add Selected",
        "attendance.select_all": "Select All",
        "attendance.clear_all": "Clear All",
        "attendance.hours_attended": "Hours",
        "attendance.present": "Present",
        "attendance.different_batch_badge": "Different Batch",
        "attendance.import_button": "📥 Import Attendance",
        "attendance.export_button": "📤 Export Attendance",
        "attendance.no_students": "No students are assigned to this batch yet.",
        "attendance.roll_no": "Roll No.",
        "attendance.level": "Level",

        "fees.title": "Fee Payments",
        "fees.record_payment": "Record Payment",
        "fees.amount": "Amount",
        "fees.mode": "Mode",
        "fees.reference_no": "Reference No.",
        "fees.remarks": "Remarks",
        "fees.receipt_no": "Receipt No.",
        "fees.import_button": "📥 Import Fee Payments",
        "fees.export_button": "📤 Export Fee Payments",
        "fees.search_by_name": "Search student by name...",
        "fees.search_by_roll_no": "Search by roll number...",
        "fees.collect_fee": "Collect Fee",
        "fees.no_students_found": "No students found",
        "fees.fee_dues_heading": "Fee Dues",
        "fees.simple_mode_badge": "Simple Fee Mode: Paid / Not Paid only",
        "fees.fee": "Fee",
        "fees.academic_year": "Academic Year",
        "fees.total": "Total",
        "fees.discount": "Discount",
        "fees.net": "Net",
        "fees.paid": "Paid",
        "fees.due": "Due",
        "fees.action": "Action",
        "fees.not_paid_badge": "Not Paid",
        "fees.paid_badge": "Paid",
        "fees.no_fee_structure": "No fee structure defined for this class yet. Set one up under Fee Structure.",
        "fees.remove_discount": "remove",
        "fees.mark_paid": "✅ Mark Paid",
        "fees.collect": "Collect",
        "fees.discount_waive": "Discount/Waive",
        "fees.save_payment": "Save Payment & Notify Guardian on WhatsApp",
        "fees.apply_discount": "Apply Discount",
        "fees.waive_full": "Waive Full Amount",
        "fees.discount_type": "Type",
        "fees.discount_value": "Value",
        "fees.discount_reason": "Reason",
        "fees.payment_history": "Payment History",
        "fees.no_payments": "No payments recorded yet",
        "fees.receipt_pdf": "🧾 Receipt PDF",
        "fees.back_to_search": "← Back to student search",

        "settings.language": "Language",
        "settings.labels_heading": "Customize Screen Text",
        "settings.labels_intro": "Override the wording used anywhere on-screen. Leave a field blank to use the language default.",
        "settings.import_export_toggles": "Import / Export Features"
    },
    kn: {
        "common.save": "ಉಳಿಸಿ",
        "common.cancel": "ರದ್ದುಮಾಡಿ",
        "common.edit": "ತಿದ್ದು",
        "common.delete": "ಅಳಿಸಿ",
        "common.export": "ರಫ್ತು",
        "common.import": "ಆಮದು",
        "common.search": "ಹುಡುಕಿ",
        "common.actions": "ಕ್ರಿಯೆಗಳು",
        "common.date": "ದಿನಾಂಕ",
        "common.status": "ಸ್ಥಿತಿ",
        "common.name": "ಹೆಸರು",
        "common.back": "ಹಿಂದೆ",
        "common.go": "ಹೋಗಿ",

        "attendance.title": "ಹಾಜರಾತಿ",
        "attendance.select_batch": "ಬ್ಯಾಚ್ ಆಯ್ಕೆಮಾಡಿ",
        "attendance.select_date": "ದಿನಾಂಕ",
        "attendance.load": "ಲೋಡ್ ಮಾಡಿ",
        "attendance.save_button": "💾 ಹಾಜರಾತಿ ಉಳಿಸಿ",
        "attendance.add_cross_batch_label": "ಇಂದು ಬೇರೆ ಬ್ಯಾಚ್‌ನಿಂದ ಬಂದ ವಿದ್ಯಾರ್ಥಿಯನ್ನು ಸೇರಿಸಿ (ಉದಾ. ಮೇಕಪ್ ತರಗತಿ)",
        "attendance.search_placeholder": "ರೋಲ್ ನಂ. ಅಥವಾ ಹೆಸರಿನಿಂದ ಹುಡುಕಿ...",
        "attendance.add_from_batch_label": "ಅಥವಾ ಇನ್ನೊಂದು ಬ್ಯಾಚ್‌ನಿಂದ ಹಲವು ವಿದ್ಯಾರ್ಥಿಗಳನ್ನು ಒಮ್ಮೆಲೇ ಸೇರಿಸಿ",
        "attendance.add_from_batch_select": "ವಿದ್ಯಾರ್ಥಿಗಳನ್ನು ನೋಡಲು ಬ್ಯಾಚ್ ಆಯ್ಕೆಮಾಡಿ",
        "attendance.add_selected": "➕ ಆಯ್ಕೆ ಮಾಡಿದವರನ್ನು ಸೇರಿಸಿ",
        "attendance.select_all": "ಎಲ್ಲಾ ಆಯ್ಕೆಮಾಡಿ",
        "attendance.clear_all": "ಎಲ್ಲಾ ತೆರವುಗೊಳಿಸಿ",
        "attendance.hours_attended": "ಗಂಟೆಗಳು",
        "attendance.present": "ಹಾಜರಿದ್ದಾರೆ",
        "attendance.different_batch_badge": "ಬೇರೆ ಬ್ಯಾಚ್",
        "attendance.import_button": "📥 ಹಾಜರಾತಿ ಆಮದು ಮಾಡಿ",
        "attendance.export_button": "📤 ಹಾಜರಾತಿ ರಫ್ತು ಮಾಡಿ",
        "attendance.no_students": "ಈ ಬ್ಯಾಚ್‌ಗೆ ಇನ್ನೂ ಯಾವುದೇ ವಿದ್ಯಾರ್ಥಿಗಳನ್ನು ನಿಯೋಜಿಸಲಾಗಿಲ್ಲ.",
        "attendance.roll_no": "ರೋಲ್ ನಂ.",
        "attendance.level": "ಹಂತ",

        "fees.title": "ಶುಲ್ಕ ಪಾವತಿ",
        "fees.record_payment": "ಪಾವತಿ ದಾಖಲಿಸಿ",
        "fees.amount": "ಮೊತ್ತ",
        "fees.mode": "ವಿಧಾನ",
        "fees.reference_no": "ಉಲ್ಲೇಖ ಸಂಖ್ಯೆ",
        "fees.remarks": "ಟಿಪ್ಪಣಿ",
        "fees.receipt_no": "ರಶೀದಿ ಸಂಖ್ಯೆ",
        "fees.import_button": "📥 ಶುಲ್ಕ ಪಾವತಿ ಆಮದು ಮಾಡಿ",
        "fees.export_button": "📤 ಶುಲ್ಕ ಪಾವತಿ ರಫ್ತು ಮಾಡಿ",
        "fees.search_by_name": "ಹೆಸರಿನಿಂದ ವಿದ್ಯಾರ್ಥಿಯನ್ನು ಹುಡುಕಿ...",
        "fees.search_by_roll_no": "ರೋಲ್ ನಂಬರ್‌ನಿಂದ ಹುಡುಕಿ...",
        "fees.collect_fee": "ಶುಲ್ಕ ಸಂಗ್ರಹಿಸಿ",
        "fees.no_students_found": "ಯಾವುದೇ ವಿದ್ಯಾರ್ಥಿಗಳು ಕಂಡುಬಂದಿಲ್ಲ",
        "fees.fee_dues_heading": "ಶುಲ್ಕ ಬಾಕಿ",
        "fees.simple_mode_badge": "ಸರಳ ಶುಲ್ಕ ವಿಧಾನ: ಪಾವತಿಸಲಾಗಿದೆ / ಪಾವತಿಸಿಲ್ಲ ಮಾತ್ರ",
        "fees.fee": "ಶುಲ್ಕ",
        "fees.academic_year": "ಶೈಕ್ಷಣಿಕ ವರ್ಷ",
        "fees.total": "ಒಟ್ಟು",
        "fees.discount": "ರಿಯಾಯಿತಿ",
        "fees.net": "ನಿವ್ವಳ",
        "fees.paid": "ಪಾವತಿಸಲಾಗಿದೆ",
        "fees.due": "ಬಾಕಿ",
        "fees.action": "ಕ್ರಿಯೆ",
        "fees.not_paid_badge": "ಪಾವತಿಸಿಲ್ಲ",
        "fees.paid_badge": "ಪಾವತಿಸಲಾಗಿದೆ",
        "fees.no_fee_structure": "ಈ ತರಗತಿಗೆ ಇನ್ನೂ ಯಾವುದೇ ಶುಲ್ಕ ರಚನೆಯನ್ನು ವ್ಯಾಖ್ಯಾನಿಸಿಲ್ಲ. ಶುಲ್ಕ ರಚನೆಯ ಅಡಿಯಲ್ಲಿ ಒಂದನ್ನು ಹೊಂದಿಸಿ.",
        "fees.remove_discount": "ತೆಗೆದುಹಾಕಿ",
        "fees.mark_paid": "✅ ಪಾವತಿಸಲಾಗಿದೆ ಎಂದು ಗುರುತಿಸಿ",
        "fees.collect": "ಸಂಗ್ರಹಿಸಿ",
        "fees.discount_waive": "ರಿಯಾಯಿತಿ/ಮನ್ನಾ",
        "fees.save_payment": "ಪಾವತಿ ಉಳಿಸಿ ಮತ್ತು WhatsApp ನಲ್ಲಿ ಪೋಷಕರಿಗೆ ತಿಳಿಸಿ",
        "fees.apply_discount": "ರಿಯಾಯಿತಿ ಅನ್ವಯಿಸಿ",
        "fees.waive_full": "ಸಂಪೂರ್ಣ ಮೊತ್ತವನ್ನು ಮನ್ನಾ ಮಾಡಿ",
        "fees.discount_type": "ವಿಧ",
        "fees.discount_value": "ಮೌಲ್ಯ",
        "fees.discount_reason": "ಕಾರಣ",
        "fees.payment_history": "ಪಾವತಿ ಇತಿಹಾಸ",
        "fees.no_payments": "ಇನ್ನೂ ಯಾವುದೇ ಪಾವತಿಗಳನ್ನು ದಾಖಲಿಸಿಲ್ಲ",
        "fees.receipt_pdf": "🧾 ರಶೀದಿ PDF",
        "fees.back_to_search": "← ವಿದ್ಯಾರ್ಥಿ ಹುಡುಕಾಟಕ್ಕೆ ಹಿಂತಿರುಗಿ",

        "settings.language": "ಭಾಷೆ",
        "settings.labels_heading": "ಪರದೆಯ ಪಠ್ಯವನ್ನು ಕಸ್ಟಮೈಸ್ ಮಾಡಿ",
        "settings.labels_intro": "ಪರದೆಯ ಮೇಲಿನ ಪದಗಳನ್ನು ಬದಲಾಯಿಸಿ. ಭಾಷೆಯ ಡೀಫಾಲ್ಟ್ ಬಳಸಲು ಖಾಲಿ ಬಿಡಿ.",
        "settings.import_export_toggles": "ಆಮದು / ರಫ್ತು ವೈಶಿಷ್ಟ್ಯಗಳು"
    }
};

function getSchoolLanguage(schoolId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT language FROM schools WHERE id=?", [schoolId], (err, row) => {
            if (err) return reject(err);
            resolve((row && row.language) || "en");
        });
    });
}

function getOverrides(schoolId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT label_key, label_text FROM label_overrides WHERE school_id=?", [schoolId], (err, rows) => {
            if (err) return reject(err);
            const map = {};
            (rows || []).forEach(r => { map[r.label_key] = r.label_text; });
            resolve(map);
        });
    });
}

/**
 * Builds a t(key) function bound to one school's current language and
 * custom overrides, for use across a single request/render.
 * Resolution order: this school's override -> chosen language's default
 * -> English default (safety net if a language's dictionary is missing
 * that key) -> the raw key itself (obviously-wrong placeholder for a key
 * that doesn't exist anywhere, so it's easy to spot during testing).
 */
async function buildTranslator(schoolId) {

    if (!schoolId) return (key) => (DEFAULTS.en[key] !== undefined ? DEFAULTS.en[key] : key);

    const [language, overrides] = await Promise.all([getSchoolLanguage(schoolId), getOverrides(schoolId)]);

    return function t(key) {
        if (overrides[key] !== undefined && overrides[key] !== "") return overrides[key];
        if (DEFAULTS[language] && DEFAULTS[language][key] !== undefined) return DEFAULTS[language][key];
        if (DEFAULTS.en[key] !== undefined) return DEFAULTS.en[key];
        return key;
    };
}

/** All known keys, grouped by their prefix (e.g. "attendance", "fees") - used to build the Settings > Customize Screen Text page. */
function allKeysGrouped() {
    const groups = {};
    Object.keys(DEFAULTS.en).forEach(key => {
        const group = key.split(".")[0];
        (groups[group] = groups[group] || []).push(key);
    });
    return groups;
}

module.exports = { buildTranslator, getSchoolLanguage, allKeysGrouped, DEFAULTS };
