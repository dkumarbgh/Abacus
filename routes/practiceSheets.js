const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireLogin } = require("../middleware/auth");

router.use(requireLogin);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads/sheets")),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`)
    }),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

/* ===========================================
   LIST + UPLOAD FORM
=========================================== */
router.get("/", (req, res) => {

    const { class_id, subject_id } = req.query;
    const schoolId = req.schoolId;

    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, classes) => {

        if (err) return res.send(err.message);

        db.all("SELECT * FROM subjects WHERE school_id=? ORDER BY subject_name", [schoolId], (err, subjects) => {

            if (err) return res.send(err.message);

            let sql = `
                SELECT practice_sheets.*, classes.class_name, subjects.subject_name
                FROM practice_sheets
                JOIN classes ON practice_sheets.class_id = classes.id
                JOIN subjects ON practice_sheets.subject_id = subjects.id
                WHERE practice_sheets.school_id = ?
            `;
            const params = [schoolId];

            if (class_id) { sql += " AND practice_sheets.class_id=?"; params.push(class_id); }
            if (subject_id) { sql += " AND practice_sheets.subject_id=?"; params.push(subject_id); }

            sql += " ORDER BY practice_sheets.uploaded_at DESC";

            db.all(sql, params, (err, sheets) => {

                if (err) return res.send(err.message);

                res.render("practiceSheets", { classes, subjects, sheets, class_id, subject_id });

            });

        });

    });

});


/* ===========================================
   UPLOAD A SHEET
=========================================== */
router.post("/upload", upload.single("file"), (req, res) => {

    if (!req.file) return res.send("<h4>Please choose a PDF to upload.</h4><a href='/practice-sheets'>Back</a>");

    const { title, class_id, subject_id } = req.body;
    const file_path = `/uploads/sheets/${req.file.filename}`;

    db.run(
        `INSERT INTO practice_sheets (class_id, subject_id, title, file_path, school_id)
         VALUES (?,?,?,?,?)`,
        [class_id, subject_id, title, file_path, req.schoolId],
        (err) => {

            if (err) return res.send(err.message);

            res.redirect("/practice-sheets");

        }
    );

});


/* ===========================================
   DELETE A SHEET
=========================================== */
router.get("/delete/:id", (req, res) => {

    db.get("SELECT * FROM practice_sheets WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err, sheet) => {

        if (err) return res.send(err.message);

        db.run("DELETE FROM practice_sheets WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err) => {

            if (err) return res.send(err.message);

            if (sheet) {
                const filePath = path.join(__dirname, "../public", sheet.file_path);
                fs.unlink(filePath, () => {}); // ignore errors if file already gone
            }

            res.redirect("/practice-sheets");

        });

    });

});

module.exports = router;
