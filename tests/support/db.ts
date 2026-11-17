import path from "node:path";
import sqlite3 from "sqlite3";

/**
 * Read-only handle on the TEST database, for looking up generated ids and
 * asserting what was actually stored. Never writes - setup goes through the
 * app's own routes so the suite exercises real behaviour.
 */
const DB_PATH = path.resolve(__dirname, "..", "..", process.env.TEST_DB_PATH || ".test-db/test.db");
let handle: sqlite3.Database | undefined;

function conn(): sqlite3.Database {
    if (!handle) handle = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    return handle;
}

export function dbAll<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) =>
        conn().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
}

export async function dbGet<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await dbAll<T>(sql, params))[0];
}

/** Id of the newest row in `table` for this school matching `where`. Throws if none. */
export async function latestId(table: string, schoolId: number, where: string, params: unknown[]): Promise<number> {
    const row = await dbGet<{ id: number }>(
        `SELECT id FROM ${table} WHERE school_id=? AND ${where} ORDER BY id DESC LIMIT 1`, [schoolId, ...params]);
    if (!row) throw new Error(`No ${table} row for school ${schoolId} where ${where} ${JSON.stringify(params)}`);
    return row.id;
}
