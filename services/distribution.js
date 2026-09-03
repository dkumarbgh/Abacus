const path = require("path");
const { sendToPhones } = require("./whatsappClient");
const { sendEmail } = require("./emailClient");

/**
 * Sends one file (an existing Practice Sheet, or a freshly generated Test
 * Paper) to a list of students, via WhatsApp and/or Email - whichever
 * channels are requested AND the student actually has contact info for.
 * Shared by routes/practiceSheets.js and routes/testPapers.js so there's
 * one implementation of "distribute a document", not two.
 *
 * @param {object} opts
 * @param {Array<object>} opts.students - each needs guardian_phone/guardian_phone_2/guardian_email + id/name
 * @param {string} opts.absoluteFilePath - real path on disk to the file being sent
 * @param {string} opts.fileName - filename to show as the attachment
 * @param {string} opts.caption - message text / email body / WhatsApp caption
 * @param {string} opts.subject - email subject line (WhatsApp ignores this)
 * @param {boolean} opts.viaWhatsapp
 * @param {boolean} opts.viaEmail
 * @param {string} opts.messageType - message_logs "type" value, e.g. "PRACTICE_SHEET" | "TEST_PAPER"
 * @param {number} opts.schoolId
 * @returns {Promise<Array>} one result row per student per channel attempted
 */
async function distributeDocument({ students, absoluteFilePath, fileName, caption, subject, viaWhatsapp, viaEmail, messageType, schoolId }) {

    const results = [];

    for (const student of students) {

        if (viaWhatsapp) {
            if (student.guardian_phone || student.guardian_phone_2) {
                // Sends to WhatsApp 1 AND WhatsApp 2 (whichever are on file).
                const status = await sendToPhones([student.guardian_phone, student.guardian_phone_2], {
                    message: caption,
                    attachmentPath: absoluteFilePath,
                    studentId: student.id,
                    type: messageType,
                    schoolId
                });
                results.push({ studentId: student.id, channel: "whatsapp", status });
                await new Promise(r => setTimeout(r, 2000)); // same courtesy delay as other bulk WhatsApp sends
            } else {
                results.push({ studentId: student.id, channel: "whatsapp", status: "SKIPPED_NO_PHONE" });
            }
        }

        if (viaEmail) {
            const to = student.guardian_email || student.mother_email || student.father_email;
            if (to) {
                const status = await sendEmail({
                    to,
                    subject,
                    text: caption,
                    attachments: [{ filename: fileName, path: absoluteFilePath }],
                    studentId: student.id,
                    type: messageType,
                    schoolId
                });
                results.push({ studentId: student.id, channel: "email", status });
            } else {
                results.push({ studentId: student.id, channel: "email", status: "SKIPPED_NO_EMAIL" });
            }
        }

    }

    return results;

}

module.exports = { distributeDocument };
