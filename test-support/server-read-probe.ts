import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync, StatementSync, type SQLInputValue } from "node:sqlite";

/**
 * Ruling 454: counts the server read work one call does, deterministically —
 * SQL compiles, statement executions (with the rows each returned) and
 * store-file reads. No `vi.mock`: the `node:sqlite` prototypes and the
 * `node:fs` export are wrapped for the duration of `fn` and put back after
 * (`syncBuiltinESMExports` carries the fs wrapper to the named ESM imports the
 * app uses). `iterate()` is not counted: no request path uses it.
 *
 * Measure a WARM call (run the journey once first): the figures are then the
 * steady state every revalidation pays, not the one-off cost of a cold cache.
 */

export interface StatementRecord {
  sql: string;
  rows: number;
}

export interface ServerReadTally {
  /** `db.prepare` calls (statement compiles). */
  prepares: number;
  /** Every get/all/run, with the rows it returned. */
  statements: StatementRecord[];
  /** `readFileSync` calls on files under the data root, as relative paths. */
  storeReads: string[];
}

/** The executions whose SQL matches `pattern`. */
export function statementsMatching(tally: ServerReadTally, pattern: RegExp): StatementRecord[] {
  return tally.statements.filter((s) => pattern.test(s.sql));
}

/** Rows returned by the executions whose SQL matches `pattern`. */
export function rowsMatching(tally: ServerReadTally, pattern: RegExp): number {
  return statementsMatching(tally, pattern).reduce((sum, s) => sum + s.rows, 0);
}

/** The positional-parameter overload of get/all/run — the one app code calls. */
type AnonymousExec<R> = (this: StatementSync, ...args: SQLInputValue[]) => R;

export async function tallyServerReads<T>(
  dataRoot: string,
  fn: () => Promise<T> | T,
): Promise<{ result: T; tally: ServerReadTally }> {
  const tally: ServerReadTally = { prepares: 0, statements: [], storeReads: [] };
  const root = path.resolve(dataRoot);
  const statement = StatementSync.prototype;
  const { get: originalGet, all: originalAll, run: originalRun } = statement;
  const get: AnonymousExec<ReturnType<StatementSync["get"]>> = statement.get;
  const all: AnonymousExec<ReturnType<StatementSync["all"]>> = statement.all;
  const run: AnonymousExec<ReturnType<StatementSync["run"]>> = statement.run;
  const { prepare } = DatabaseSync.prototype;
  const { readFileSync } = fs;

  // SAFETY: forwards every argument to the original with the same receiver
  // and returns its result unchanged, so it answers exactly what `get` does.
  statement.get = function (this: StatementSync, ...args: SQLInputValue[]) {
    const row: ReturnType<StatementSync["get"]> = get.apply(this, args);
    tally.statements.push({ sql: this.sourceSQL, rows: row === undefined ? 0 : 1 });
    return row;
  } as StatementSync["get"];
  // SAFETY: as above, for `all`.
  statement.all = function (this: StatementSync, ...args: SQLInputValue[]) {
    const rows: ReturnType<StatementSync["all"]> = all.apply(this, args);
    tally.statements.push({ sql: this.sourceSQL, rows: rows.length });
    return rows;
  } as StatementSync["all"];
  // SAFETY: as above, for `run`.
  statement.run = function (this: StatementSync, ...args: SQLInputValue[]) {
    const changes: ReturnType<StatementSync["run"]> = run.apply(this, args);
    tally.statements.push({ sql: this.sourceSQL, rows: 0 });
    return changes;
  } as StatementSync["run"];
  DatabaseSync.prototype.prepare = function (
    this: DatabaseSync,
    ...args: Parameters<DatabaseSync["prepare"]>
  ) {
    tally.prepares += 1;
    return prepare.apply(this, args);
  };
  // SAFETY: forwards both arguments to the original and returns its result
  // unchanged, so it answers exactly what each `readFileSync` overload does.
  fs.readFileSync = function (file: fs.PathOrFileDescriptor, options?: fs.ObjectEncodingOptions | BufferEncoding | null) {
    const abs = path.resolve(String(file));
    if (abs.startsWith(root + path.sep)) tally.storeReads.push(path.relative(root, abs));
    return readFileSync(file, options);
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const result = await fn();
    return { result, tally };
  } finally {
    statement.get = originalGet;
    statement.all = originalAll;
    statement.run = originalRun;
    DatabaseSync.prototype.prepare = prepare;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
  }
}
