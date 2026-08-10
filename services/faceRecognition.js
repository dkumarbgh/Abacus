const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

// Where the Python face-recognition microservice (face-service/app.py) is running.
// Override with the FACE_SERVICE_URL env var if you deploy it elsewhere.
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || "http://localhost:5001";

/**
 * Send an image to the face-service and get back a 128-number face encoding.
 * @param {string} imagePath - path to a JPEG/PNG file on disk
 * @returns {Promise<{encoding:number[]}|{error:string}>}
 */
async function getFaceEncoding(imagePath) {
    const form = new FormData();
    form.append("image", fs.createReadStream(imagePath));

    try {
        const response = await axios.post(`${FACE_SERVICE_URL}/encode`, form, {
            headers: form.getHeaders(),
            timeout: 15000
        });
        return response.data; // { encoding: [...] } or { error: "no_face_detected" | "multiple_faces" }
    } catch (err) {
        console.error("face-service /encode failed:", err.message);
        return { error: "face_service_unreachable" };
    }
}

/**
 * Euclidean distance between two equal-length encodings.
 * face_recognition's convention: distance < 0.6 is generally considered a match.
 */
function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += (a[i] - b[i]) ** 2;
    }
    return Math.sqrt(sum);
}

/**
 * Find the closest matching student encoding.
 * @param {number[]} encoding - encoding of the captured photo
 * @param {Array<{student_id:number, encoding:string}>} candidates - rows from face_encodings (encoding is a JSON string)
 * @param {number} threshold - max distance to still count as a match (default 0.6, the standard face_recognition threshold)
 */
function findBestMatch(encoding, candidates, threshold = 0.6) {
    let best = null;
    let bestDistance = Infinity;

    for (const c of candidates) {
        const candidateEncoding = JSON.parse(c.encoding);
        const d = distance(encoding, candidateEncoding);
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
    }

    if (best && bestDistance <= threshold) {
        return { studentId: best.student_id, distance: bestDistance, confidence: Math.max(0, 1 - bestDistance) };
    }
    return null;
}

module.exports = { getFaceEncoding, findBestMatch, distance, FACE_SERVICE_URL };
