const express = require("express");
const router = express.Router();
const db = require("../config/database");
const crypto = require("crypto");
const { requireLogin, requireRole } = require("../middleware/auth");
const { sendMessage } = require("../services/whatsappClient");
const { sendEmail } = require("../services/emailClient");
const { applyReferralReward } = require("../services/referralReward");
const features = require("../config/features");

router.use(requireLogin);

/**
 * Short, human-readable, hard-to-confuse coupon code - avoids visually
 * ambiguous characters (0/O, 1/I/L) since this often gets read aloud or
 * copied by hand at a front desk.
 */
function generateCouponCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "REF-";
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    return code;
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}

function couponMessage(referral, schoolName) {
    const rewardText = referral.reward_type === "PERCENT" ? `${referral.reward_value}% off`
        : referral.reward_type === "PRIZE" ? (referral.prize_description || "a prize")
        : `₹${referral.reward_value} off`;
    return `Thank you for referring a friend to ${schoolName || "our school"}! Your unique referral code is ${referral.coupon_code}. `
        + `Once your friend enrolls, show this code at the office to claim your reward: ${rewardText}${referral.reward_type === "PRIZE" ? "" : " on your fees"}. - School Office`;
}

/* ==========================================
   LEADS LIST
========================================== */
router.get("/", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const status = req.query.status || "";

    let sql = `
        SELECT referrals.*,
               COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
               ref_to.name AS referred_student_name
        FROM referrals
        LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
        LEFT JOIN students ref_to ON referrals.referred_student_id = ref_to.id
        WHERE referrals.school_id=?
    `;
    const params = [schoolId];
    if (status) { sql += " AND referrals.status=?"; params.push(status); }
    sql += " ORDER BY referrals.created_at DESC";

    const leads = await dbAll(sql, params);
    res.render("leads", { leads, status });

});

/* ==========================================
   NEW LEAD
========================================== */
router.get("/new", requireRole("Admin"), async (req, res) => {

    const school = await dbGet("SELECT referral_reward_type, referral_reward_value FROM schools WHERE id=?", [req.schoolId]);
    res.render("newLead", { school, emailConfigured: require("../services/emailClient").isConfigured() });

});

router.get("/search-students", requireRole("Admin"), (req, res) => {

    const q = (req.query.q || "").trim();
    if (!q) return res.json({ ok: true, students: [] });

    db.all(
        `SELECT id, name, admission_no FROM students
         WHERE school_id=? AND (name LIKE ? OR admission_no LIKE ?)
         ORDER BY name LIMIT 20`,
        [req.schoolId, `%${q}%`, `%${q}%`],
        (err, students) => {
            if (err) return res.status(500).json({ ok: false, error: err.message });
            res.json({ ok: true, students });
        }
    );

});

router.post("/new", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const {
        referring_student_id, referrer_type, referring_lead_name, referring_lead_phone,
        lead_name, lead_phone, lead_email, reward_type, reward_value, prize_description, notes, send_now
    } = req.body;

    // Referrer is EITHER an existing student OR a lead (someone who isn't
    // themselves an enrolled student here - a parent, alumnus, walk-in,
    // etc) - exactly one of the two is required.
    const referrerIsLead = referrer_type === "lead";
    if (referrerIsLead && (!referring_lead_name || !referring_lead_name.trim())) {
        return res.send("Referrer's name is required. <a href='/leads/new'>Back</a>");
    }
    if (!referrerIsLead && !referring_student_id) {
        return res.send("Referring student is required (or switch to 'Referrer is a lead'). <a href='/leads/new'>Back</a>");
    }
    if (!lead_name) {
        return res.send("Lead name is required. <a href='/leads/new'>Back</a>");
    }
    if (reward_type === "PRIZE" && (!prize_description || !prize_description.trim())) {
        return res.send("Please describe the prize. <a href='/leads/new'>Back</a>");
    }

    let referrerId = null;
    if (!referrerIsLead) {
        const referrer = await dbGet("SELECT id FROM students WHERE id=? AND school_id=?", [referring_student_id, schoolId]);
        if (!referrer) return res.send("Referring student not found for your school.");
        referrerId = referrer.id;
    }

    // Retry on the astronomically unlikely chance of a collision.
    let couponCode;
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateCouponCode();
        const clash = await dbGet("SELECT id FROM referrals WHERE coupon_code=?", [candidate]);
        if (!clash) { couponCode = candidate; break; }
    }
    if (!couponCode) return res.send("Could not generate a unique coupon code - please try again.");

    const result = await dbRun(
        `INSERT INTO referrals
         (school_id, referring_student_id, referring_lead_name, referring_lead_phone, lead_name, lead_phone, lead_email,
          coupon_code, status, reward_type, reward_value, prize_description, notes)
         VALUES (?,?,?,?,?,?,?,?, 'New', ?,?,?,?)`,
        [schoolId, referrerId,
         referrerIsLead ? referring_lead_name.trim() : null,
         referrerIsLead ? (referring_lead_phone || null) : null,
         lead_name.trim(), lead_phone || null, lead_email || null, couponCode,
         reward_type || "FLAT", parseFloat(reward_value) || 0,
         reward_type === "PRIZE" ? prize_description.trim() : null, notes || null]
    );

    res.redirect(`/leads/${result.lastID}`);

    // Fire-and-forget the coupon-code message, same pattern as other bulk
    // sends in this app - only possible when the referrer is an enrolled
    // student, since a lead referrer has no guardian contact on file here.
    if (send_now === "on" && referrerId) {
        const referringStudent = await dbGet("SELECT name, guardian_phone, guardian_email FROM students WHERE id=?", [referrerId]);
        const school = await dbGet("SELECT name FROM schools WHERE id=?", [schoolId]);
        const referral = await dbGet("SELECT * FROM referrals WHERE id=?", [result.lastID]);
        const message = couponMessage(referral, school ? school.name : "");

        if (features.whatsapp && referringStudent.guardian_phone) {
            sendMessage({ phone: referringStudent.guardian_phone, message, studentId: referrerId, type: "CUSTOM", schoolId });
        }
        if (features.email && referringStudent.guardian_email) {
            sendEmail({ to: referringStudent.guardian_email, subject: "Your Referral Code", text: message, studentId: referrerId, type: "CUSTOM", schoolId });
        }
    }

});

/* ==========================================
   LEAD DETAIL
========================================== */
router.get("/:id", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const referral = await dbGet(
        `SELECT referrals.*,
                COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
                ref_by.guardian_phone, ref_by.guardian_email,
                ref_to.name AS referred_student_name
         FROM referrals
         LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
         LEFT JOIN students ref_to ON referrals.referred_student_id = ref_to.id
         WHERE referrals.id=? AND referrals.school_id=?`,
        [req.params.id, schoolId]
    );
    if (!referral) return res.send("Lead not found");

    const school = await dbGet("SELECT name FROM schools WHERE id=?", [schoolId]);

    res.render("leadDetail", { referral, schoolName: school ? school.name : "", emailConfigured: require("../services/emailClient").isConfigured() });

});

router.post("/:id/status", requireRole("Admin"), async (req, res) => {

    await dbRun("UPDATE referrals SET status=? WHERE id=? AND school_id=?", [req.body.status, req.params.id, req.schoolId]);
    res.redirect(`/leads/${req.params.id}`);

});

router.post("/:id/link-student", requireRole("Admin"), async (req, res) => {

    const student = await dbGet("SELECT id FROM students WHERE id=? AND school_id=?", [req.body.student_id, req.schoolId]);
    if (!student) return res.send("Student not found for your school.");

    await dbRun(
        "UPDATE referrals SET referred_student_id=?, status=CASE WHEN status='New' OR status='Contacted' THEN 'Enrolled' ELSE status END WHERE id=? AND school_id=?",
        [req.body.student_id, req.params.id, req.schoolId]
    );
    res.redirect(`/leads/${req.params.id}`);

});

router.post("/:id/send-message", requireRole("Admin"), async (req, res) => {

    const schoolId = req.schoolId;
    const referral = await dbGet(
        `SELECT referrals.*, COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
                ref_by.guardian_phone, ref_by.guardian_email
         FROM referrals LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
         WHERE referrals.id=? AND referrals.school_id=?`,
        [req.params.id, schoolId]
    );
    if (!referral) return res.send("Lead not found");

    const school = await dbGet("SELECT name FROM schools WHERE id=?", [schoolId]);
    const message = couponMessage(referral, school ? school.name : "");

    res.redirect(`/leads/${req.params.id}`);

    const viaWhatsapp = req.body.via_whatsapp === "on";
    const viaEmail = req.body.via_email === "on";

    if (viaWhatsapp && features.whatsapp && referral.guardian_phone) {
        sendMessage({ phone: referral.guardian_phone, message, studentId: referral.referring_student_id, type: "CUSTOM", schoolId });
    }
    if (viaEmail && features.email && referral.guardian_email) {
        sendEmail({ to: referral.guardian_email, subject: "Your Referral Code", text: message, studentId: referral.referring_student_id, type: "CUSTOM", schoolId });
    }

});

/* ==========================================
   REDEMPTION
========================================== */
router.get("/redeem/lookup", requireRole("Admin"), (req, res) => {
    res.render("redeemLookup", { result: null, error: null, searchedCode: "" });
});

router.post("/redeem/lookup", requireRole("Admin"), async (req, res) => {

    const code = (req.body.coupon_code || "").trim().toUpperCase();
    const schoolId = req.schoolId;

    const referral = await dbGet(
        `SELECT referrals.*, COALESCE(ref_by.name, referrals.referring_lead_name) AS referring_student_name,
                ref_to.name AS referred_student_name
         FROM referrals
         LEFT JOIN students ref_by ON referrals.referring_student_id = ref_by.id
         LEFT JOIN students ref_to ON referrals.referred_student_id = ref_to.id
         WHERE referrals.coupon_code=? AND referrals.school_id=?`,
        [code, schoolId]
    );

    if (!referral) {
        return res.render("redeemLookup", { result: null, error: "No referral found with that code for this school.", searchedCode: code });
    }

    res.render("redeemLookup", { result: referral, error: null, searchedCode: code });

});

router.post("/:id/redeem", requireRole("Admin"), async (req, res) => {

    const referral = await dbGet("SELECT * FROM referrals WHERE id=? AND school_id=?", [req.params.id, req.schoolId]);
    if (!referral) return res.send("Referral not found for your school.");

    const result = await applyReferralReward(req.params.id, req.session.userId);

    if (!result.ok) {
        return res.render("redeemLookup", { result: referral, error: result.error, searchedCode: referral.coupon_code });
    }

    res.redirect(`/leads/${req.params.id}`);

});

module.exports = router;
