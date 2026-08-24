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
 * Expected classes so far this month. Two modes:
 *  - Schedule-based (preferred): if the student has specific days set on
 *    the "Weekly Attendance Schedule" (Student Edit page), counts exactly
 *    how many of those weekdays have actually occurred between monthStart
 *    and the elapsed cutoff - e.g. a student scheduled Tue+Fri only
 *    "expects" a class on the Tuesdays/Fridays that actually fell within
 *    the elapsed range, not a rough weekly average.
 *  - Batch-average fallback: if the student has no schedule days set,
 *    falls back to the old estimate (sessions/week x elapsed/7), so
 *    students who haven't been given a specific schedule yet still get a
 *    reasonable number instead of nothing.
 *
 * @param {object} opts
 * @param {number|null} opts.sessionsPerWeek - the student's batch's sessions/week (fallback only)
 * @param {number} opts.daysElapsed - days elapsed so far this month (from getElapsedInfo)
 * @param {string} opts.monthStart - "YYYY-MM-01" for the month being checked
 * @param {number[]} [opts.scheduleDays] - day-of-week ints (0=Sunday..6=Saturday) from student_schedule, if any
 * @returns {number|null} null when there's nothing to compare against (no schedule AND no sessions/week)
 */
function computeExpected({ sessionsPerWeek, daysElapsed, monthStart, scheduleDays }) {

    if (scheduleDays && scheduleDays.length > 0) {
        if (daysElapsed === 0) return 0;
        const start = new Date(monthStart);
        let count = 0;
        for (let i = 0; i < daysElapsed; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            if (scheduleDays.includes(d.getDay())) count++;
        }
        return count;
    }

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
