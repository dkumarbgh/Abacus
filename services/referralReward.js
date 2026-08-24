const db = require("../config/database");

/**
 * Applies a referral's reward as a real discount against the referring
 * student's largest outstanding fee item (class-wide OR level-wide,
 * whichever the student's fee structure actually uses - see the Class→
 * Level fee structure work), or their own personalized fee item.
 *
 * Shared by the Super Admin referral dashboard and the Leads redemption
 * page, so there's one implementation of "how a reward actually gets
 * applied" rather than two that could drift apart.
 *
 * @param {number} referralId
 * @param {number|null} redeemedByUserId - who performed the redemption, for the audit trail
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function applyReferralReward(referralId, redeemedByUserId = null) {
    return new Promise((resolve) => {

        db.get("SELECT * FROM referrals WHERE id=?", [referralId], (err, referral) => {

            if (err) return resolve({ ok: false, error: err.message });
            if (!referral) return resolve({ ok: false, error: "Referral not found" });
            if (referral.reward_applied) return resolve({ ok: false, error: "This reward has already been applied/redeemed." });

            // A PRIZE reward isn't a fee discount - it's handed over
            // physically (a book, a trophy, a gift voucher, etc) - so
            // there's no fee_structure item to touch. Same for a referrer
            // who is a LEAD rather than an enrolled student: they have no
            // fee record in this school to discount against. In both
            // cases, redemption is just a record-keeping step - mark it
            // Redeemed so staff know the reward has been handed over.
            if (referral.reward_type === "PRIZE" || !referral.referring_student_id) {
                return db.run(
                    "UPDATE referrals SET reward_applied=1, status='Redeemed', redeemed_at=CURRENT_TIMESTAMP, redeemed_by=? WHERE id=?",
                    [redeemedByUserId, referralId],
                    (err2) => {
                        if (err2) return resolve({ ok: false, error: err2.message });
                        resolve({ ok: true });
                    }
                );
            }

            db.all(
                `SELECT fs.id, fs.amount
                 FROM fee_structure fs, students s
                 WHERE s.id = ? AND fs.school_id = ?
                   AND (
                        (fs.student_id IS NULL AND fs.class_id IS NOT NULL AND fs.class_id = s.class_id)
                        OR (fs.student_id IS NULL AND fs.level_id IS NOT NULL AND fs.level_id = s.level_id)
                        OR fs.student_id = s.id
                   )`,
                [referral.referring_student_id, referral.school_id],
                (err2, items) => {

                    if (err2) return resolve({ ok: false, error: err2.message });

                    if (!items.length) {
                        return resolve({
                            ok: false,
                            error: "Can't apply this reward yet - the referring student has no fee item set up (class/level-wide or personal) to discount. Set one up first, then try again."
                        });
                    }

                    Promise.all(items.map(item => new Promise((resolve2, reject2) => {
                        db.all(
                            "SELECT SUM(amount_paid) AS paid FROM fee_payments WHERE fee_structure_id=?",
                            [item.id],
                            (e, rows) => e ? reject2(e) : resolve2({ ...item, paid: (rows[0] && rows[0].paid) || 0 })
                        );
                    }))).then(withPaid => {

                        const target = withPaid.reduce((best, cur) => {
                            const curDue = cur.amount - cur.paid;
                            const bestDue = best ? (best.amount - best.paid) : -Infinity;
                            return curDue > bestDue ? cur : best;
                        }, null);

                        db.get(
                            "SELECT id FROM fee_discounts WHERE student_id=? AND fee_structure_id=?",
                            [referral.referring_student_id, target.id],
                            (err4, existingDiscount) => {

                                const saveDiscount = existingDiscount
                                    ? (cb) => db.run(
                                        "UPDATE fee_discounts SET discount_type=?, discount_value=?, reason=? WHERE id=?",
                                        [referral.reward_type, referral.reward_value, "Referral reward", existingDiscount.id],
                                        cb
                                    )
                                    : (cb) => db.run(
                                        `INSERT INTO fee_discounts (student_id, fee_structure_id, discount_type, discount_value, reason, school_id)
                                         VALUES (?,?,?,?,?,?)`,
                                        [referral.referring_student_id, target.id, referral.reward_type, referral.reward_value, "Referral reward", referral.school_id],
                                        cb
                                    );

                                saveDiscount((err5) => {
                                    if (err5) return resolve({ ok: false, error: err5.message });

                                    db.run(
                                        "UPDATE referrals SET reward_applied=1, status='Redeemed', redeemed_at=CURRENT_TIMESTAMP, redeemed_by=? WHERE id=?",
                                        [redeemedByUserId, referralId],
                                        (err6) => {
                                            if (err6) return resolve({ ok: false, error: err6.message });
                                            resolve({ ok: true });
                                        }
                                    );

                                });

                            }
                        );

                    }).catch(e => resolve({ ok: false, error: e.message }));

                }
            );

        });

    });
}

module.exports = { applyReferralReward };
