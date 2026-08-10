-- ============================================================
-- Update queries for the seeded sample data
-- School: "Sample Test Centre" (school_id = 2)
--
-- Run with: sqlite3 school.db < scripts/sample-data-update-queries.sql
-- Or paste individual statements into any SQLite client.
--
-- All WHERE clauses include "AND school_id = 2" as a safety net, so even
-- if you copy a query into the wrong place, it can only ever touch this
-- one seeded school - never your real data. Change the 2 everywhere if
-- your seeded school actually got a different id (check with the lookup
-- query at the very bottom if unsure).
-- ============================================================


-- ---- Student basic info ----
-- Swap 'Riya Sharma' for whichever student you're editing.

UPDATE students
SET name = 'Riya Sharma',              -- change name
    age = 14,                          -- change age
    dob = '2012-03-14',                -- change DOB (YYYY-MM-DD)
    guardian_phone = '919876500001',   -- change WhatsApp number
    guardian_email = 'suresh.sharma@example.com',
    fee_due_date = '2026-09-05'        -- change this student's fee due date
WHERE name = 'Riya Sharma' AND school_id = 2;


-- ---- Move a student to a different class ----
-- Look up the target class_id first:
--   SELECT id, class_name FROM classes WHERE school_id = 2;

UPDATE students
SET class_id = (SELECT id FROM classes WHERE class_name = 'Class 9' AND school_id = 2)
WHERE name = 'Aditya Kumar' AND school_id = 2;


-- ---- Class-wide fee amount (Tuition / Transport) ----
-- This changes the amount for EVERYONE in that class, since it's the
-- shared Fee Structure item, not a personalized one.

UPDATE fee_structure
SET amount = 15000
WHERE fee_category_id = (SELECT id FROM fee_categories WHERE fee_name = 'Tuition Fee' AND school_id = 2)
  AND student_id IS NULL              -- IS NULL = class-wide item, not personalized
  AND school_id = 2;


-- ---- Personalized "Course Fee" (Total Fee on one student's profile) ----

UPDATE fee_structure
SET amount = 25000
WHERE student_id = (SELECT id FROM students WHERE name = 'Riya Sharma' AND school_id = 2)
  AND fee_category_id = (SELECT id FROM fee_categories WHERE fee_name = 'Course Fee' AND school_id = 2)
  AND school_id = 2;


-- ---- Discount on that Course Fee ----

UPDATE fee_discounts
SET discount_type = 'FLAT',           -- or 'PERCENT'
    discount_value = 3000
WHERE student_id = (SELECT id FROM students WHERE name = 'Riya Sharma' AND school_id = 2)
  AND school_id = 2;


-- ---- A specific payment/installment (amount or date) ----
-- Find the receipt_no first if you have several for the same student:
--   SELECT receipt_no, amount_paid, payment_date, remarks FROM fee_payments
--   WHERE student_id = (SELECT id FROM students WHERE name='Riya Sharma' AND school_id=2);

UPDATE fee_payments
SET amount_paid = 5500,
    payment_date = '2026-08-02'
WHERE remarks = 'Installment 1'
  AND student_id = (SELECT id FROM students WHERE name = 'Riya Sharma' AND school_id = 2)
  AND school_id = 2;


-- ---- Attendance status for a specific student/date ----

UPDATE attendance
SET status = 'Present'                -- or 'Absent'
WHERE student_id = (SELECT id FROM students WHERE name = 'Riya Sharma' AND school_id = 2)
  AND attendance_date = '2026-08-04'
  AND school_id = 2;


-- ---- Exam marks ----

UPDATE exam_results
SET marks_obtained = 91
WHERE student_id = (SELECT id FROM students WHERE name = 'Riya Sharma' AND school_id = 2)
  AND exam_id = (SELECT id FROM exams WHERE exam_name = 'Mid-Term Exam' AND school_id = 2)
  AND school_id = 2;


-- ---- School's own name/contact info ----

UPDATE schools
SET name = 'Sample Test Centre',
    address = '123 Sample Street',
    phone = '9876543210',
    email = 'office@sampletestcentre.example'
WHERE id = 2;


-- ---- Admin user's display name/email (NOT password - see note below) ----

UPDATE users
SET name = 'Test Admin',
    email = 'new-email@example.com'
WHERE school_id = 2 AND role = 'Admin';


-- ============================================================
-- NOTE on changing the login PASSWORD:
-- Passwords are bcrypt-hashed, so plain SQL can't set a new one directly
-- (you can't just UPDATE ... SET password_hash = 'mypassword'). Use this
-- instead, from the project folder:
--
--   node -e "
--   const bcrypt = require('bcryptjs');
--   const db = require('./config/database');
--   const newHash = bcrypt.hashSync('yourNewPassword', 10);
--   db.run('UPDATE users SET password_hash=? WHERE school_id=? AND role=\'Admin\'',
--     [newHash, 2],
--     (err) => console.log(err ? err.message : 'Password updated.'));
--   "
-- ============================================================


-- ---- If you're not sure this school is actually id 2, check first: ----
-- SELECT id, name FROM schools ORDER BY id DESC LIMIT 5;
