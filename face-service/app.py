"""
Face-encoding microservice for SimpleSchool's face-recognition attendance.

This service is intentionally "dumb": it takes a photo and returns a 128-number
face encoding. It does NOT store anything or know about students — the Node app
(school.db) is the source of truth for who's who and does the actual matching.
That keeps this service stateless and easy to run/replace independently.

Setup:
    pip install flask face_recognition pillow
    python app.py

Note: face_recognition depends on dlib, which needs cmake + a C++ compiler to
build. On Windows, the easiest path is installing dlib via a prebuilt wheel;
on macOS/Linux, `brew install cmake` / `apt install cmake` first, then pip
install as above.

Endpoints:
    POST /encode   multipart form field "image" -> { encoding: [128 floats] }
                   or { error: "no_face_detected" | "multiple_faces" }
    GET  /health   -> { ok: true }
"""

from flask import Flask, request, jsonify
import face_recognition
import tempfile
import os

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/encode", methods=["POST"])
def encode():
    if "image" not in request.files:
        return jsonify({"error": "no_image_uploaded"}), 400

    image_file = request.files["image"]

    # Save to a temp file since face_recognition wants a file path or ndarray
    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        image_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        image = face_recognition.load_image_file(tmp_path)
        face_locations = face_recognition.face_locations(image)

        if len(face_locations) == 0:
            return jsonify({"error": "no_face_detected"}), 200

        if len(face_locations) > 1:
            return jsonify({"error": "multiple_faces"}), 200

        encodings = face_recognition.face_encodings(image, known_face_locations=face_locations)
        encoding = encodings[0].tolist()  # 128 floats

        return jsonify({"encoding": encoding})

    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    # Runs on port 5001 by default to match services/faceRecognition.js in the Node app.
    app.run(host="0.0.0.0", port=5001)
