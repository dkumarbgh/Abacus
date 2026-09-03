const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const qrcodeImg = require("qrcode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../config/database");

/**
 * WhatsApp integration using whatsapp-web.js — sends from the school's own
 * WhatsApp number (free, unofficial). On first run a QR code prints in this
 * terminal (and is available at /whatsapp/debug); scan it from WhatsApp >
 * Linked Devices. The session is cached in ./whatsapp-session so you won't
 * need to scan again on restart - as long as that folder actually persists
 * (on hosts with an ephemeral filesystem, like Render's free tier, it won't
 * survive a redeploy, and you'll need to rescan every time).
 *
 * Keep messages to genuine parent communication (fees, attendance, notices).
 * Bulk sends already include a delay between messages — don't reduce it much.
 *
 * ---- Debugging ----
 * Everything below is logged both to the console (visible in Render's Logs
 * tab, prefixed "[WhatsApp]" so it's easy to filter/search for) AND kept in
 * an in-memory ring buffer exposed via getDiagnostics(), which the
 * Admin-only /whatsapp/debug page reads. That page also shows the most
 * recent QR code as an image (qrcode-terminal alone is awkward to use on a
 * host where you only have a few seconds to catch it in a log stream).
 */

// Configurable via WHATSAPP_SESSION_PATH so it can point at a persistent
// disk mount on hosts with an ephemeral filesystem (e.g. Render) - a
// Render Disk is mounted at its own separate absolute path (e.g.
// /var/data), not inside the deployed app folder, so the default below
// (relative to this app) only survives restarts/redeploys if you've set
// that env var to point at the mounted disk instead. Mirrors how
// config/database.js makes DB_PATH configurable for the same reason.
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, "..", "whatsapp-session");

let ready = false;
let lastQrDataUrl = null;   // most recent QR code, as a data: URL image
let lastQrAt = null;
let lastError = null;       // { message, stack, at } - most recent init/send-level failure
let lastStateChange = null; // most recent whatsapp-web.js internal state string

// Simple in-memory ring buffer of recent log lines, newest last, so
// /whatsapp/debug can show a live-ish tail without needing shell/log access.
const LOG_BUFFER_MAX = 300;
const logBuffer = [];

function log(level, ...args) {
    const line = `[${new Date().toISOString()}] [WhatsApp] ${args.map(a =>
        a instanceof Error ? (a.stack || a.message) : (typeof a === "object" ? JSON.stringify(a) : String(a))
    ).join(" ")}`;

    logBuffer.push({ level, line, at: new Date().toISOString() });
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

    if (level === "error") console.error(line);
    else console.log(line);
}

/**
 * Gathers everything useful for diagnosing a broken WhatsApp setup, without
 * needing shell access to the host. Safe to call at any time.
 */
function getDiagnostics() {

    let sessionDirWritable = false;
    let sessionDirError = null;
    try {
        fs.mkdirSync(SESSION_PATH, { recursive: true });
        const testFile = path.join(SESSION_PATH, ".write-test");
        fs.writeFileSync(testFile, "ok");
        fs.unlinkSync(testFile);
        sessionDirWritable = true;
    } catch (e) {
        sessionDirError = e.message;
    }

    let chromePath = null;
    let chromeExists = null;
    let chromePathError = null;
    try {
        // whatsapp-web.js pulls in puppeteer as a transitive dependency -
        // ask IT where it thinks Chrome/Chromium lives, then check the file
        // is actually there. This is the single most common failure point
        // on hosts like Render: the path is resolved but the binary was
        // never downloaded (or was downloaded to a path that got wiped).
        const puppeteer = require("puppeteer");
        chromePath = puppeteer.executablePath();
        chromeExists = fs.existsSync(chromePath);
    } catch (e) {
        chromePathError = e.message;
    }

    return {
        ready,
        lastError,
        lastStateChange,
        lastQrAt,
        hasQrPending: !!lastQrDataUrl,
        node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch
        },
        memory: {
            totalGB: (os.totalmem() / 1e9).toFixed(2),
            freeGB: (os.freemem() / 1e9).toFixed(2)
        },
        sessionPath: SESSION_PATH,
        sessionDirWritable,
        sessionDirError,
        chromePath,
        chromeExists,
        chromePathError
    };
}

function getRecentLogs() {
    return logBuffer.slice().reverse(); // newest first
}

function getLastQrImage() {
    return lastQrDataUrl;
}

// Log the environment BEFORE even trying to start the client, so if
// initialize() hangs or crashes we still know what we were working with.
log("info", "Starting up. Diagnostics:", getDiagnostics());

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            // Constrained hosts (Render free/starter tier and similar) often
            // don't have /dev/shm sized generously enough for Chrome's
            // default usage, which causes silent crashes rather than a
            // clear error - this flag avoids that class of failure.
            "--disable-dev-shm-usage"
        ]
    }
});

client.on("qr", (qr) => {
    lastQrAt = new Date().toISOString();
    log("info", "QR code received - scan it from WhatsApp > Linked Devices. Also viewable at /whatsapp/debug.");
    qrcode.generate(qr, { small: true });
    qrcodeImg.toDataURL(qr, (err, url) => {
        if (err) {
            log("error", "Failed to render QR code as an image for /whatsapp/debug:", err);
            return;
        }
        lastQrDataUrl = url;
    });
});

client.on("loading_screen", (percent, message) => {
    log("info", `Loading WhatsApp Web: ${percent}% - ${message}`);
});

client.on("authenticated", () => {
    log("info", "Authenticated successfully.");
});

client.on("auth_failure", (message) => {
    lastError = { message: `Authentication failed: ${message}`, stack: null, at: new Date().toISOString() };
    log("error", "Authentication failed:", message,
        "- this usually means the saved session is stale/corrupted. Try deleting the whatsapp-session folder and rescanning the QR code.");
});

client.on("change_state", (state) => {
    lastStateChange = state;
    log("info", "State changed:", state);
});

client.on("remote_session_saved", () => {
    log("info", "Session saved to disk at", SESSION_PATH,
        "(on hosts with an ephemeral filesystem this won't survive a restart/redeploy).");
});

client.on("ready", () => {
    ready = true;
    lastQrDataUrl = null; // no longer relevant once connected
    log("info", "✅ Client is ready - messages can now be sent.");
});

client.on("disconnected", (reason) => {
    ready = false;
    lastError = { message: `Disconnected: ${reason}`, stack: null, at: new Date().toISOString() };
    log("error", "⚠️  Disconnected:", reason);
});

client.initialize().catch((err) => {
    lastError = { message: err.message, stack: err.stack, at: new Date().toISOString() };
    log("error", "⚠️  Client failed to start:", err);
    log("error", "    (The rest of the app will keep working — WhatsApp sends will just fail/log as FAILED until this is fixed.)");
    log("error", "    Diagnostics at failure time:", getDiagnostics());
});

function toChatId(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return `${digits}@c.us`;
}

/**
 * Send a WhatsApp message and log the attempt.
 * @param {object} opts
 * @param {string} opts.phone
 * @param {string} opts.message
 * @param {string|null} [opts.attachmentPath] - absolute file path to attach (e.g. a test paper/practice sheet PDF). `message` becomes the caption when this is set.
 * @param {number|null} [opts.studentId]
 * @param {string} [opts.type] - FEE_REMINDER | ATTENDANCE_ALERT | EXAM_RESULT | CUSTOM
 * @param {number|null} [opts.schoolId]
 * @returns {Promise<string>} "SENT" or "FAILED"
 */
function sendMessage({ phone, message, attachmentPath = null, studentId = null, type = "CUSTOM", schoolId = null }) {
    return new Promise((resolve) => {
        const logResult = (status) => {
            db.run(
                `INSERT INTO message_logs (student_id, phone, type, message, status, school_id)
                 VALUES (?,?,?,?,?,?)`,
                [studentId, phone, type, message, status, schoolId],
                () => resolve(status)
            );
        };

        if (!phone) {
            log("error", "Send skipped - no guardian phone number on file for student_id", studentId);
            return logResult("FAILED");
        }

        if (!ready) {
            log("error", "Send skipped - client not ready. Current state:", lastStateChange, "| last error:", lastError, "| phone:", phone);
            return logResult("FAILED");
        }

        const sendPromise = attachmentPath
            ? MessageMedia.fromFilePath(attachmentPath).then(media =>
                client.sendMessage(toChatId(phone), media, { caption: message })
              )
            : client.sendMessage(toChatId(phone), message);

        sendPromise
            .then(() => {
                log("info", "Sent OK to", phone, "type:", type, attachmentPath ? "(with attachment)" : "");
                logResult("SENT");
            })
            .catch((err) => {
                lastError = { message: err.message, stack: err.stack, at: new Date().toISOString() };
                log("error", "Send failed for", phone, "-", err);
                logResult("FAILED");
            });
    });
}

/**
 * Sends the same message to however many of a student's WhatsApp numbers
 * are actually on file (WhatsApp 1 and/or WhatsApp 2), logging each as its
 * own row in message_logs. Duplicate numbers (e.g. both fields left the
 * same) are only sent once. Returns a single aggregate status so callers
 * built around "one status per student" (bulk sends, fee-reminder
 * triggers, etc.) don't need to change how they interpret the result:
 *   "SENT"     - at least one number went through
 *   "FAILED"   - at least one number was on file, but none succeeded
 *   "NO_PHONE" - neither field had a number at all
 * @param {Array<string|null|undefined>} phones
 * @param {object} opts - same shape as sendMessage's opts, minus `phone`
 * @returns {Promise<string>}
 */
async function sendToPhones(phones, opts) {
    const unique = [...new Set((phones || []).filter(Boolean).map(p => String(p).trim()).filter(Boolean))];

    if (unique.length === 0) {
        log("error", "Send skipped - no WhatsApp number on file for student_id", opts.studentId);
        return "NO_PHONE";
    }

    const statuses = [];
    for (const phone of unique) {
        statuses.push(await sendMessage({ ...opts, phone }));
    }

    return statuses.includes("SENT") ? "SENT" : "FAILED";
}

/**
 * Send to many recipients with a delay between each to avoid rate limiting.
 * @param {Array<{phones: Array<string>, message, studentId, type}>} recipients
 */
async function sendBulk(recipients, delayMs = 3000) {
    log("info", `Starting bulk send to ${recipients.length} recipient(s), ${delayMs}ms delay between each.`);
    const results = [];
    for (const r of recipients) {
        const { phones, ...opts } = r;
        const status = await sendToPhones(phones, opts);
        results.push({ phones, status });
        await new Promise((res) => setTimeout(res, delayMs));
    }
    const sent = results.filter(r => r.status === "SENT").length;
    log("info", `Bulk send finished: ${sent}/${recipients.length} sent OK.`);
    return results;
}

module.exports = {
    client,
    sendMessage,
    sendToPhones,
    sendBulk,
    isReady: () => ready,
    getDiagnostics,
    getRecentLogs,
    getLastQrImage
};
