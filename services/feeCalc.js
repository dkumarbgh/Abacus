/**
 * Given a fee structure's full amount and an optional discount row
 * (from fee_discounts: { discount_type: 'FLAT'|'PERCENT', discount_value }),
 * returns the discount amount to subtract. Capped so it can never make the
 * net amount negative, and a 100% PERCENT discount is how a full waiver is
 * represented - no separate "waived" flag needed.
 */
function computeDiscountAmount(amount, discount) {
    if (!discount) return 0;
    if (discount.discount_type === "PERCENT") {
        return Math.min(amount * (discount.discount_value / 100), amount);
    }
    // FLAT
    return Math.min(discount.discount_value, amount);
}

/**
 * Net payable amount for a fee item after discount.
 */
function computeNetAmount(amount, discount) {
    return Math.max(amount - computeDiscountAmount(amount, discount), 0);
}

module.exports = { computeDiscountAmount, computeNetAmount };
