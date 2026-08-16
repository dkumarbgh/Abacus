/**
 * Shared logic for "expected classes so far" calculations, used by both
 * the Attendance Regularity Report (routes/reports.js /attendance-regularity)
 * and the individual Student Report (/student/:id) - one place to get this
 * right rather than three slightly-different copies.
 */

/**
 * How many days of a given "YYYY-MM" month have actually elapsed as of
 * today - the whole month if it's in the past, 0 if it's in the future,
 * or just up to today if it's the current month. Never expects a full,
 * not-yet-finished month, which is what makes attendance regularity fair
 * to check mid-month.
 */
function getElapsedInfo(month) {

    const todayStr = new Date().toISOString().slice(0, 10);
    const currentYearMonth = todayStr.slice(0, 7);
    const [year, mon] = month.split("-");
    const daysInMonth = new Date(Number(year), Number(mon), 0).getDate();

    let daysElapsed;
    if (month < currentYearMonth) {
        daysElapsed = daysInMonth;
    } else if (month === currentYearMonth) {
        daysElapsed = new Date(todayStr).getDate();
    } else {
        daysElapsed = 0;
    }

    return { daysElapsed, isCurrentMonth: month === currentYearMonth };

}

/**
 * Expected classes so far this month, given a batch's sessions/week and
 * how many days of the month have elapsed. Returns null if sessionsPerWeek
 * isn't set (nothing to compare against).
 */
function computeExpected(sessionsPerWeek, daysElapsed) {
    if (!sessionsPerWeek) return null;
    return Math.round(sessionsPerWeek * (daysElapsed / 7));
}

/**
 * Regular = attended at least 75% of expected classes so far. null when
 * there's no expected count to compare against (no batch / no
 * sessions_per_week set). "Regular" when expected is 0 (day 1 of the
 * month, or a future month) - nothing to have fallen behind on yet.
 */
function classifyRegularity(attended, expected) {
    if (expected == null) return { pct: null, status: null };
    if (expected === 0) return { pct: 100, status: "Regular" };
    const pct = Math.round((attended / expected) * 100);
    return { pct, status: pct >= 75 ? "Regular" : "Irregular" };
}

module.exports = { getElapsedInfo, computeExpected, classifyRegularity };
