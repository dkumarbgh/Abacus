const db = require("../config/database");

/**
 * Runs fn() inside BEGIN IMMEDIATE ... COMMIT, ROLLBACK on error.
 *
 * The whole app shares ONE SQLite connection, so two transactions can't be
 * open at once: a second BEGIN fails with "cannot start a transaction within
 * a transaction", and that request's ROLLBACK would undo the FIRST request's
 * work. This queue makes transactions run one after another (e.g. the same
 * import file uploaded twice at the same moment).
 */
let queue = Promise.resolve();

function run(sql) {
    return new Promise((resolve, reject) => db.run(sql, [], err => err ? reject(err) : resolve()));
}

function withTransaction(fn) {
    const job = queue.then(async () => {
        await run("BEGIN IMMEDIATE");
        try {
            const result = await fn();
            await run("COMMIT");
            return result;
        } catch (e) {
            await run("ROLLBACK").catch(() => {});
            throw e;
        }
    });
    queue = job.catch(() => {});
    return job;
}

module.exports = { withTransaction };
