/**
 * Feature flags - lets a deployment turn whole features on/off without
 * touching code, by editing the .env file (copy .env.example to .env and
 * set values there) or setting the same-named environment variables
 * directly (e.g. in Render's Environment tab).
 *
 * Every flag defaults to ON (true) if unset, so an existing deployment
 * with no .env changes keeps working exactly as it does today - you only
 * need to set a flag to "false" for the features you actually want to
 * turn off.
 *
 * Adding a new toggleable feature later: add one line here, then check
 * `features.xyz` wherever that feature's routes/views live - see
 * FACE_RECOGNITION_ENABLED below for the pattern (route guards +
 * view-level hiding of the entry points).
 */

require("dotenv").config();

function flag(envVar, defaultValue = true) {
    const raw = process.env[envVar];
    if (raw === undefined) return defaultValue;
    return raw.toLowerCase() !== "false" && raw !== "0";
}

const features = {
    faceRecognition: flag("FEATURE_FACE_RECOGNITION"),
    whatsapp: flag("FEATURE_WHATSAPP"),
    referralProgramme: flag("FEATURE_REFERRAL_PROGRAMME"),
    studentImportExport: flag("FEATURE_STUDENT_IMPORT_EXPORT"),
    email: flag("FEATURE_EMAIL")
};

module.exports = features;
