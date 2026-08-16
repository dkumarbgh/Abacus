const express = require("express");
const router = express.Router();
const db = require("../config/database");
const multer = require("multer");
const path = require("path");
const { getFaceEncoding } = require("../services/faceRecognition");
const { requireLogin, requireFeature } = require("../middleware/auth");
const { getFieldSettings, FIELD_DEFS, getAdmissionNoSettings, assignNextAdmissionNo } = require("../services/schoolSettings");
const { saveEnrollmentFee, parseInstallmentsFromBody } = require("../services/enrollmentFee");
const ExcelJS = require("exceljs");
const { STUDENT_COLUMNS } = require("../services/studentColumns");

router.use(requireLogin);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, "../public/uploads/students")),
        filename: (req, file, cb) => cb(null, `student_${Date.now()}${path.extname(file.originalname)}`)
    }),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Separate uploader for spreadsheet imports - kept in memory (never written
// to public/uploads), since it's read once by exceljs and discarded.
const uploadSpreadsheet = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/**
 * Checks req.body against the school's current mandatory-field settings
 * for the student form. Returns an array of human-readable labels for any
 * mandatory field that was left blank (empty array = valid).
 */
function validateStudentFields(fieldSettings, body) {
    const missing = [];
    Object.keys(fieldSettings).forEach(key => {
        if (fieldSettings[key] && !String(body[key] || "").trim()) {
            missing.push(FIELD_DEFS.student[key].label);
        }
    });
    return missing;
}

/**
 * Existing students in this school, for the "Referred By" dropdown on the
 * Add Student form - lets front-desk staff record that a new enrollment
 * came from an existing student's referral, right at the point of intake.
 */
function getReferralCandidates(schoolId) {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT id, name, admission_no FROM students WHERE school_id=? ORDER BY name",
            [schoolId],
            (err, rows) => err ? reject(err) : resolve(rows)
        );
    });
}
function getLookupLists(schoolId) {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT * FROM lookup_items WHERE school_id=? ORDER BY list_type, name",
            [schoolId],
            (err, rows) => {
                if (err) return reject(err);
                const grouped = { course: [], batch: [], level: [], branch: [] };
                rows.forEach(r => { if (grouped[r.list_type]) grouped[r.list_type].push(r); });
                resolve(grouped);
            }
        );
    });
}

// All the extended registration fields that aren't handled specially
// (class_id, photo, fee/installments) - listed once here so the INSERT/
// UPDATE statements below don't have to spell out 25+ columns by hand.
const EXTENDED_FIELDS = [
    "admission_no", "gender", "dob", "guardian_name", "guardian_phone", "guardian_email", "address", "fee_due_date",
    "mother_tongue", "mother_name", "father_name", "mother_occupation", "father_occupation",
    "mother_phone", "father_phone", "mother_email", "father_email",
    "previous_school", "stream", "standard", "religion", "nationality", "country", "state", "city",
    "total_hours_per_month", "course_id", "batch_id", "level_id", "branch_id"
];

/* =====================================================
   STUDENT LIST
===================================================== */
router.get("/", (req, res) => {

    const search = req.query.search || "";

    const sql = `
        SELECT
            students.*,
            classes.class_name,
            CASE WHEN face_encodings.id IS NULL THEN 0 ELSE 1 END AS face_enrolled
        FROM students
        LEFT JOIN classes
            ON students.class_id = classes.id
        LEFT JOIN face_encodings
            ON face_encodings.student_id = students.id
        WHERE students.school_id = ? AND students.name LIKE ?
        ORDER BY students.name
    `;

    db.all(sql, [req.schoolId, `%${search}%`], (err, rows) => {

        if (err) {
            return res.send(err.message);
        }

        res.render("students", {
            students: rows,
            search
        });

    });

});


/* =====================================================
   EXPORT STUDENTS (Excel)
===================================================== */
router.get("/export", (req, res) => {

    const schoolId = req.schoolId;

    db.all(
        `SELECT students.*, classes.class_name,
                courses.name AS course_name, batches.name AS batch_name,
                levels.name AS level_name, branches.name AS branch_name
         FROM students
         LEFT JOIN classes ON students.class_id = classes.id
         LEFT JOIN lookup_items courses ON students.course_id = courses.id
         LEFT JOIN lookup_items batches ON students.batch_id = batches.id
         LEFT JOIN lookup_items levels ON students.level_id = levels.id
         LEFT JOIN lookup_items branches ON students.branch_id = branches.id
         WHERE students.school_id = ?
         ORDER BY students.name`,
        [schoolId],
        async (err, rows) => {

            if (err) return res.send(err.message);

            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet("Students");

            sheet.columns = STUDENT_COLUMNS.map(c => ({ header: c.header, key: c.key, width: 20 }));
            sheet.getRow(1).font = { bold: true };

            rows.forEach(r => sheet.addRow(r));

            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="students-export-${new Date().toISOString().slice(0,10)}.xlsx"`);
            await workbook.xlsx.write(res);
            res.end();

        }
    );

});


/* =====================================================
   IMPORT TEMPLATE (blank, headers only)
===================================================== */
router.get("/import/template", async (req, res) => {

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Students");
    sheet.columns = STUDENT_COLUMNS.map(c => ({ header: c.header, key: c.key, width: 20 }));
    sheet.getRow(1).font = { bold: true };
    // One example row so it's obvious what format is expected.
    sheet.addRow({
        name: "Riya Sharma", admission_no: "2026/001", age: 15, gender: "Female",
        dob: "2011-04-12", class_name: "Class 8", guardian_name: "Suresh Sharma",
        guardian_phone: "919876543210"
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="student-import-template.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();

});


/* =====================================================
   IMPORT PAGE
===================================================== */
router.get("/import", (req, res) => {
    res.render("importStudents", { result: null });
});


/* =====================================================
   PROCESS IMPORT
   Reads an uploaded .xlsx/.csv matching the template headers, creates one
   student per row. Course/Batch/Level/Branch names are auto-created in
   their lookup lists if they don't already exist (low-risk, easy to tidy
   up later from /lists); Class must already exist - it's structural (fee
   structure, attendance, etc. all depend on it), so a typo there is
   reported as a row error instead of silently creating a bogus class.
   Mandatory-field settings are enforced per row, same as the manual form.
   Total Fee / Discount / Installments are NOT handled by import - add
   those individually from each student's Edit page after importing.
===================================================== */
router.post("/import", uploadSpreadsheet.single("file"), async (req, res) => {

    const schoolId = req.schoolId;

    if (!req.file) {
        return res.render("importStudents", { result: { error: "Please choose a file to upload." } });
    }

    try {
        const os = require("os");
        const fs = require("fs");
        const path = require("path");

        // exceljs' buffer-based .load() doesn't reliably parse in this
        // environment - writing to a temp file and using .readFile()/.csv.readFile()
        // instead is the reliable path, confirmed by testing both.
        const tempPath = path.join(os.tmpdir(), `import-${Date.now()}${path.extname(req.file.originalname) || ".xlsx"}`);
        fs.writeFileSync(tempPath, req.file.buffer);

        const workbook = new ExcelJS.Workbook();
        const isCsv = req.file.originalname.toLowerCase().endsWith(".csv");
        if (isCsv) {
            await workbook.csv.readFile(tempPath);
        } else {
            await workbook.xlsx.readFile(tempPath);
        }
        fs.unlink(tempPath, () => {});

        const sheet = workbook.worksheets[0];

        if (!sheet || sheet.rowCount < 2) {
            return res.render("importStudents", { result: { error: "That file doesn't have any data rows." } });
        }

        // Map each column found in row 1 to a STUDENT_COLUMNS key by matching
        // header text (case/whitespace-insensitive), so column order in the
        // uploaded file doesn't have to exactly match the template.
        const headerRow = sheet.getRow(1);
        const colIndexByKey = {};
        headerRow.eachCell((cell, colNumber) => {
            const text = String(cell.value || "").trim().toLowerCase();
            const match = STUDENT_COLUMNS.find(c => c.header.trim().toLowerCase() === text);
            if (match) colIndexByKey[match.key] = colNumber;
        });

        if (!colIndexByKey.name) {
            return res.render("importStudents", {
                result: { error: "Couldn't find a 'Full Name' column - please use the template's column headers." }
            });
        }

        const [fieldSettings, admissionNo, classes, lookups] = await Promise.all([
            getFieldSettings(schoolId, "student"),
            getAdmissionNoSettings(schoolId),
            new Promise((resolve, reject) => {
                db.all("SELECT * FROM classes WHERE school_id=?", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
            }),
            getLookupLists(schoolId)
        ]);

        const classByName = {};
        classes.forEach(c => { classByName[c.class_name.trim().toLowerCase()] = c.id; });

        // For course/batch/level/branch - auto-create-on-first-use cache,
        // shared across rows in this same import so we don't insert the
        // same new "Evening Batch" 40 times if 40 rows use it.
        const lookupCache = { course: {}, batch: {}, level: {}, branch: {} };
        Object.keys(lookups).forEach(type => {
            lookups[type].forEach(item => { lookupCache[type][item.name.trim().toLowerCase()] = item.id; });
        });

        async function resolveLookup(type, name) {
            if (!name || !String(name).trim()) return null;
            const key = String(name).trim().toLowerCase();
            if (lookupCache[type][key]) return lookupCache[type][key];
            const created = await new Promise((resolve, reject) => {
                db.run(
                    "INSERT INTO lookup_items (school_id, list_type, name) VALUES (?,?,?)",
                    [schoolId, type, String(name).trim()],
                    function(err) { err ? reject(err) : resolve(this.lastID); }
                );
            });
            lookupCache[type][key] = created;
            return created;
        }

        let imported = 0;
        const rowErrors = [];

        for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {

            const row = sheet.getRow(rowNum);
            const cell = (key) => {
                const idx = colIndexByKey[key];
                if (!idx) return "";
                const v = row.getCell(idx).value;
                if (v == null) return "";
                if (v instanceof Date) return v.toISOString().slice(0, 10);
                if (typeof v === "object" && v.text) return String(v.text).trim(); // rich text / hyperlink cells
                return String(v).trim();
            };

            const name = cell("name");
            if (!name) continue; // silently skip fully blank rows (e.g. trailing empty rows)

            const rowData = {};
            EXTENDED_FIELDS.forEach(key => { rowData[key] = cell(key); });
            const age = cell("age");
            rowData.age = age; // age isn't in EXTENDED_FIELDS (handled specially, like name/class_id) but IS a configurable mandatory field, so the validation loop below needs to see it too

            // Class must already exist.
            const className = cell("class_name");
            const classId = className ? classByName[className.trim().toLowerCase()] : null;
            if (className && !classId) {
                rowErrors.push(`Row ${rowNum} (${name}): class "${className}" doesn't exist - add it under Classes first, or fix the spelling.`);
                continue;
            }

            // Mandatory-field check, same rules as the manual form (Name/Class always required).
            const missing = [];
            if (!name) missing.push("Full Name");
            if (!classId) missing.push("Class");
            Object.keys(fieldSettings).forEach(key => {
                if (fieldSettings[key] && !String(rowData[key] || "").trim()) {
                    missing.push(FIELD_DEFS.student[key].label);
                }
            });
            if (missing.length) {
                rowErrors.push(`Row ${rowNum} (${name || "no name"}): missing ${missing.join(", ")}`);
                continue;
            }

            // Resolve dropdown names to IDs, auto-creating new list entries as needed.
            rowData.course_id = await resolveLookup("course", cell("course_name"));
            rowData.batch_id = await resolveLookup("batch", cell("batch_name"));
            rowData.level_id = await resolveLookup("level", cell("level_name"));
            rowData.branch_id = await resolveLookup("branch", cell("branch_name"));

            // Admission No.: use the sheet's value if given; otherwise
            // auto-assign if that's turned on for this school.
            if (!rowData.admission_no && admissionNo.auto) {
                rowData.admission_no = await assignNextAdmissionNo(schoolId);
            }

            const columns = ["name", "age", "class_id", ...EXTENDED_FIELDS, "school_id"];
            const values = [name, age || null, classId, ...EXTENDED_FIELDS.map(f => rowData[f] || null), schoolId];
            const placeholders = columns.map(() => "?").join(",");

            await new Promise((resolve, reject) => {
                db.run(`INSERT INTO students (${columns.join(",")}) VALUES(${placeholders})`, values, function(err) {
                    if (err) { rowErrors.push(`Row ${rowNum} (${name}): ${err.message}`); return resolve(); }
                    imported++;
                    resolve();
                });
            });

        }

        res.render("importStudents", {
            result: { imported, rowErrors, total: sheet.rowCount - 1 }
        });

    } catch (e) {
        res.render("importStudents", { result: { error: `Couldn't read that file: ${e.message}` } });
    }

});


/* =====================================================
   ADD STUDENT PAGE (Registration)
===================================================== */
router.get("/add", (req, res) => {

    db.all(
        "SELECT * FROM classes WHERE school_id=? AND is_active=1 ORDER BY class_name",
        [req.schoolId],
        (err, classes) => {

            if (err) {
                return res.send(err.message);
            }

            Promise.all([
                getFieldSettings(req.schoolId, "student"),
                getLookupLists(req.schoolId),
                getAdmissionNoSettings(req.schoolId),
                getReferralCandidates(req.schoolId)
            ])
                .then(([fieldSettings, lists, admissionNo, referralCandidates]) => {
                    res.render("addStudent", {
                        classes,
                        fieldSettings,
                        lists,
                        admissionNo,
                        referralCandidates,
                        errors: [],
                        old: {}
                    });
                })
                .catch(err2 => res.send(err2.message));

        });

});


/* =====================================================
   SAVE STUDENT (Registration)
===================================================== */
router.post("/add", upload.single("photo"), (req, res) => {

    const { name, class_id, age, total_fee, discount_type, discount_value } = req.body;
    const photo_path = req.file ? `/uploads/students/${req.file.filename}` : null;
    const schoolId = req.schoolId;

    Promise.all([
        getFieldSettings(schoolId, "student"),
        getAdmissionNoSettings(schoolId)
    ]).then(([fieldSettings, admissionNo]) => {

        // Auto-assigned admission numbers are never "missing" - they don't
        // exist yet at validation time, they get created right before
        // insert below. Validate against a copy so the real setting (used
        // for the *-marker on re-rendered forms) isn't mutated.
        const effectiveFieldSettings = { ...fieldSettings };
        if (admissionNo.auto) effectiveFieldSettings.admission_no = false;

        const missing = validateStudentFields(effectiveFieldSettings, req.body);
        if (!name || !String(name).trim()) missing.unshift("Full Name");
        if (!class_id) missing.unshift("Class");

        if (missing.length) {
            return Promise.all([
                new Promise((resolve, reject) => {
                    db.all("SELECT * FROM classes WHERE school_id=? AND is_active=1 ORDER BY class_name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
                }),
                getLookupLists(schoolId),
                getReferralCandidates(schoolId)
            ]).then(([classes, lists, referralCandidates]) => {
                res.render("addStudent", {
                    classes,
                    fieldSettings,
                    lists,
                    admissionNo,
                    referralCandidates,
                    errors: missing,
                    old: req.body
                });
            }).catch(err => res.send(err.message));
        }

        (admissionNo.auto ? assignNextAdmissionNo(schoolId) : Promise.resolve(req.body.admission_no))
            .then(admissionNoValue => {

        req.body.admission_no = admissionNoValue;

        const columns = ["name", "age", "class_id", ...EXTENDED_FIELDS, "photo_path", "school_id"];
        const values = [
            name, age, class_id,
            ...EXTENDED_FIELDS.map(f => req.body[f] || null),
            photo_path, schoolId
        ];
        const placeholders = columns.map(() => "?").join(",");

        db.run(
            `INSERT INTO students (${columns.join(",")}) VALUES(${placeholders})`,
            values,
            function(err) {

                if (err) {
                    return res.send(err.message);
                }

                const studentId = this.lastID;

                // If this new student was referred by an existing one,
                // record it (using this school's default reward, still
                // adjustable later) - the reward itself is only ever
                // applied by a Super Admin from the Referral Programme
                // dashboard, not automatically here.
                const referredBy = req.body.referred_by_student_id;
                if (referredBy && String(referredBy).trim() && require("../config/features").referralProgramme) {
                    db.get("SELECT referral_reward_type, referral_reward_value FROM schools WHERE id=?", [schoolId], (refErr, school) => {
                        if (refErr) return console.error("Referral lookup failed:", refErr.message);
                        db.run(
                            `INSERT INTO referrals (school_id, referring_student_id, referred_student_id, reward_type, reward_value)
                             VALUES (?,?,?,?,?)`,
                            [schoolId, referredBy, studentId,
                             (school && school.referral_reward_type) || "FLAT",
                             (school && school.referral_reward_value) || 0],
                            (insErr) => { if (insErr) console.error("Referral record failed:", insErr.message); }
                        );
                    });
                }

                // Total Fee / Discount / Installments -> real fee records.
                saveEnrollmentFee({
                    studentId,
                    classId: class_id,
                    schoolId,
                    totalFee: total_fee,
                    discountType: discount_type,
                    discountValue: discount_value,
                    installments: parseInstallmentsFromBody(req.body)
                }).catch(err2 => console.error("Enrollment fee save failed for student", studentId, ":", err2.message));

                // If a photo was uploaded, try to enroll it for face-recognition attendance right away.
                if (req.file && require("../config/features").faceRecognition) {
                    getFaceEncoding(req.file.path).then((result) => {
                        if (result.encoding) {
                            db.run(
                                `INSERT INTO face_encodings (student_id, encoding, photo_path, school_id)
                                 VALUES (?,?,?,?)`,
                                [studentId, JSON.stringify(result.encoding), photo_path, schoolId]
                            );
                        }
                        // If no face detected, that's fine - staff can enroll a clearer photo later
                        // from the student's edit page / face enrollment screen.
                    });
                }

                res.redirect("/students");

            });

            }); // end admissionNoValue.then

    }).catch(err => res.send(err.message));

});


/* =====================================================
   EDIT STUDENT PAGE
===================================================== */
router.get("/edit/:id", (req, res) => {

    db.get(
        "SELECT * FROM students WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        (err, student) => {

            if (err) {
                return res.send(err.message);
            }
            if (!student) return res.send("Student not found");

            db.all(
                "SELECT * FROM classes WHERE school_id=? ORDER BY class_name",
                [req.schoolId],
                (err, classes) => {

                    if (err) {
                        return res.send(err.message);
                    }

                    Promise.all([
                        getFieldSettings(req.schoolId, "student"),
                        getLookupLists(req.schoolId),
                        getAdmissionNoSettings(req.schoolId)
                    ])
                        .then(([fieldSettings, lists, admissionNo]) => {
                            res.render("editStudent", {
                                student,
                                classes,
                                fieldSettings,
                                lists,
                                admissionNo,
                                errors: []
                            });
                        })
                        .catch(err2 => res.send(err2.message));

                });

        });

});


/* =====================================================
   UPDATE STUDENT
===================================================== */
router.post("/edit/:id", upload.single("photo"), (req, res) => {

    const { name, class_id, age, total_fee, discount_type, discount_value } = req.body;
    const schoolId = req.schoolId;

    getFieldSettings(schoolId, "student").then(fieldSettings => {

        const missing = validateStudentFields(fieldSettings, req.body);
        if (!name || !String(name).trim()) missing.unshift("Full Name");
        if (!class_id) missing.unshift("Class");

        if (missing.length) {
            return Promise.all([
                new Promise((resolve, reject) => {
                    db.all("SELECT * FROM classes WHERE school_id=? ORDER BY class_name", [schoolId], (err, rows) => err ? reject(err) : resolve(rows));
                }),
                getLookupLists(schoolId),
                getAdmissionNoSettings(schoolId)
            ]).then(([classes, lists, admissionNo]) => {
                // Re-show the form with what they typed, so nothing is lost.
                const student = { ...req.body, id: req.params.id };
                res.render("editStudent", {
                    student,
                    classes,
                    fieldSettings,
                    lists,
                    admissionNo,
                    errors: missing
                });
            }).catch(err => res.send(err.message));
        }

        const setClauses = ["name=?", "age=?", "class_id=?", ...EXTENDED_FIELDS.map(f => `${f}=?`)];
        const params = [name, age, class_id, ...EXTENDED_FIELDS.map(f => req.body[f] || null)];

        if (req.file) {
            setClauses.push("photo_path=?");
            params.push(`/uploads/students/${req.file.filename}`);
        }

        params.push(req.params.id, schoolId);

        db.run(
            `UPDATE students SET ${setClauses.join(", ")} WHERE id=? AND school_id=?`,
            params,
            function(err) {

                if (err) {
                    return res.send(err.message);
                }

                // Total Fee / Discount / Installments -> real fee records
                // (updates the existing personalized item rather than
                // duplicating it; only ADDS any newly-entered installments).
                saveEnrollmentFee({
                    studentId: req.params.id,
                    classId: class_id,
                    schoolId,
                    totalFee: total_fee,
                    discountType: discount_type,
                    discountValue: discount_value,
                    installments: parseInstallmentsFromBody(req.body)
                }).catch(err2 => console.error("Enrollment fee save failed for student", req.params.id, ":", err2.message));

                if (req.file && require("../config/features").faceRecognition) {
                    getFaceEncoding(req.file.path).then((result) => {
                        if (result.encoding) {
                            db.run(
                                `INSERT INTO face_encodings (student_id, encoding, photo_path, school_id)
                                 VALUES (?,?,?,?)
                                 ON CONFLICT(student_id) DO UPDATE SET
                                    encoding=excluded.encoding,
                                    photo_path=excluded.photo_path,
                                    created_at=CURRENT_TIMESTAMP`,
                                [req.params.id, JSON.stringify(result.encoding), `/uploads/students/${req.file.filename}`, schoolId]
                            );
                        }
                    });
                }

                res.redirect("/students");

            });

    }).catch(err => res.send(err.message));

});


/* =====================================================
   FACE ENROLLMENT (dedicated page, e.g. to re-enroll
   a clearer photo without editing all other details)
===================================================== */
router.get("/enroll-face/:id", requireFeature("faceRecognition"), (req, res) => {

    db.get("SELECT * FROM students WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err, student) => {

        if (err) return res.send(err.message);
        if (!student) return res.send("Student not found");

        res.render("enrollFace", { student });

    });

});

router.post("/enroll-face/:id", requireFeature("faceRecognition"), upload.single("photo"), async (req, res) => {

    if (!req.file) {
        return res.send("<h4>Please choose a clear, front-facing photo.</h4><a href='/students'>Back</a>");
    }

    // Confirm the student belongs to this school before touching their record.
    const student = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM students WHERE id=? AND school_id=?", [req.params.id, req.schoolId], (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
    if (!student) return res.status(403).send("Student not found for your school.");

    const result = await getFaceEncoding(req.file.path);

    if (result.error) {
        const messages = {
            no_face_detected: "No face was detected in that photo. Please try a clearer, well-lit photo.",
            multiple_faces: "More than one face was detected. Please upload a photo of just the student.",
            face_service_unreachable: "The face-recognition service isn't running. Start face-service/app.py and try again."
        };
        return res.send(`<h4>${messages[result.error] || result.error}</h4><a href='/students/enroll-face/${req.params.id}'>Try again</a>`);
    }

    const photo_path = `/uploads/students/${req.file.filename}`;

    db.run(
        `INSERT INTO face_encodings (student_id, encoding, photo_path, school_id)
         VALUES (?,?,?,?)
         ON CONFLICT(student_id) DO UPDATE SET
            encoding=excluded.encoding,
            photo_path=excluded.photo_path,
            created_at=CURRENT_TIMESTAMP`,
        [req.params.id, JSON.stringify(result.encoding), photo_path, req.schoolId],
        (err) => {

            if (err) return res.send(err.message);

            db.run("UPDATE students SET photo_path=? WHERE id=? AND school_id=?", [photo_path, req.params.id, req.schoolId]);

            res.redirect("/students");

        }
    );

});


/* =====================================================
   DELETE STUDENT
===================================================== */
router.get("/delete/:id", (req, res) => {

    db.run(
        "DELETE FROM students WHERE id=? AND school_id=?",
        [req.params.id, req.schoolId],
        function(err) {

            if (err) {
                return res.send(err.message);
            }

            res.redirect("/students");

        });

});

module.exports = router;
