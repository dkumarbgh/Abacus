const nodemailer = require("nodemailer");
const db = require("../config/database");

/**
 * Email (SMTP) integration - deployment-wide config via environment
 * variables (see .env.example), same pattern as FACE_SERVICE_URL/
 * JWT_SECRET etc. Works with Gmail (using an App Password, not your
 * regular password - Gmail blocks plain password SMTP login) or any
 * other SMTP provider.
 *
 * ---- Debugging ----
 * Same approach as services/whatsappClient.js: logs go to the console
 * (prefixed "[Email]") AND an in-memory ring buffer exposed via
 * getDiagnostics()/getRecentLogs(), which the Admin-only /email/debug
 * page reads - so a misconfigured SMTP setup is visible in the browser,
 * not just buried in server logs.
 */

const LOG_BUFFER_MAX = 300;
const logBuffer = [];
let lastError = null;
let transporter = null;
let configError = null;
let verified = false;

function log(level, ...args) {
    const line = `[${new Date().toISOString()}] [Email] ${args.map(a =>
        a instanceof Error ? (a.stack || a.message) : (typeof a === "object" ? JSON.stringify(a) : String(a))
    ).join(" ")}`;
    logBuffer.push({ level, line, at: new Date().toISOString() });
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    if (level === "error") console.error(line); else console.log(line);
}

function buildTransporter() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        configError = "SMTP not configured - set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT, SMTP_SECURE, SMTP_FROM_NAME, SMTP_FROM_EMAIL) in .env. See .env.example.";
        log("info", "Not configured yet:", configError);
        return null;
    }

    const port = Number(process.env.SMTP_PORT) || 587;
    const t = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === "true" || port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    t.verify((err) => {
        if (err) {
            lastError = { message: err.message, stack: err.stack, at: new Date().toISOString() };
            log("error", "SMTP connection verify failed:", err);
        } else {
            verified = true;
            log("info", `✅ SMTP connected (${SMTP_HOST}:${port}) - ready to send.`);
        }
    });

    return t;
}

transporter = buildTransporter();

function getDiagnostics() {
    return {
        configured: !!transporter,
        verified,
        configError,
        lastError,
        smtpHost: process.env.SMTP_HOST || null,
        smtpPort: process.env.SMTP_PORT || null,
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || null
    };
}

function getRecentLogs() {
    return logBuffer.slice().reverse();
}

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 * @param {Array}  [opts.attachments] - nodemailer attachment objects, e.g. [{ filename, path }] or [{ filename, content: buffer }]
 * @param {number|null} [opts.studentId]
 * @param {string} [opts.type] - same type conventions as WhatsApp (FEE_REMINDER, CUSTOM, etc.)
 * @param {number|null} [opts.schoolId]
 * @returns {Promise<string>} "SENT" or "FAILED"
 */
function sendEmail({ to, subject, text, html, attachments, studentId = null, type = "CUSTOM", schoolId = null }) {
    return new Promise((resolve) => {

        const logResult = (status) => {
            db.run(
                `INSERT INTO message_logs (student_id, email, channel, type, message, status, school_id)
                 VALUES (?,?,?,?,?,?,?)`,
                [studentId, to, "email", type, text || html || subject, status, schoolId],
                () => resolve(status)
            );
        };

        if (!to) {
            log("error", "Send skipped - no email address on file for student_id", studentId);
            return logResult("FAILED");
        }

        if (!transporter) {
            log("error", "Send skipped - SMTP not configured. student:", studentId, "to:", to);
            return logResult("FAILED");
        }

        const fromName = process.env.SMTP_FROM_NAME || "School Office";
        const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

        transporter.sendMail({
            from: `"${fromName}" <${fromEmail}>`,
            to, subject, text, html, attachments
        })
            .then(() => {
                log("info", "Sent OK to", to, "type:", type);
                logResult("SENT");
            })
            .catch((err) => {
                lastError = { message: err.message, stack: err.stack, at: new Date().toISOString() };
                log("error", "Send failed for", to, "-", err);
                logResult("FAILED");
            });

    });
}

/**
 * Send to many recipients with a small delay between each - same
 * rate-limiting courtesy as WhatsApp's sendBulk, though SMTP providers
 * are generally more tolerant of bursts than WhatsApp Web automation is.
 */
async function sendBulkEmail(recipients, delayMs = 500) {
    log("info", `Starting bulk email to ${recipients.length} recipient(s).`);
    const results = [];
    for (const r of recipients) {
        const status = await sendEmail(r);
        results.push({ to: r.to, status });
        await new Promise((res) => setTimeout(res, delayMs));
    }
    const sent = results.filter(r => r.status === "SENT").length;
    log("info", `Bulk email finished: ${sent}/${recipients.length} sent OK.`);
    return results;
}

module.exports = {
    sendEmail,
    sendBulkEmail,
    isConfigured: () => !!transporter,
    getDiagnostics,
    getRecentLogs
};
