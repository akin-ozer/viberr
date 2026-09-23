import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Ruling 454: deterministic counters for the perf tests (the one home for
 * counting SQL, store-file reads and writes). They wrap
 * the process-wide `node:sqlite` prototypes and `fs.readFileSync` for the span
 * between `start` and `stop`, so every module (including ones that prepared
 * their statements before the probe started) is counted. A test holds one
 * database, so the process-wide scope is the database under test.
 */

export interface SqlTally {
  /** Statement executions: `run`/`get`/`all`/`iterate` plus every `exec`. */
  statements: number;
  /** Executions of INSERT / UPDATE / DELETE / REPLACE. */
  writes: number;
  /** WAL commits: writes outside a transaction plus each `COMMIT`. */
  commits: number;
  /** The SQL text of each execution, in order (for filters and messages). */
  sql: string[];
  /** Rows each execution returned, index-aligned with `sql` (0 for run/exec). */
  rows: number[];
  /** `db.prepare` calls (statement compiles). */
  prepares: number;
}

const WRITE_RE = /^\s*(insert|update|delete|replace)\b/i;

export interface SqlProbe {
  readonly tally: SqlTally;
  /** Restores the prototypes and returns the final tally. */
  stop(): SqlTally;
}

/**
 * Counts SQL executed on every open handle until `stop()`. Pass the database
 * under test to count WAL commits (a write outside a transaction commits);
 * without it `commits` counts only explicit COMMITs.
 */
export function countSql(db?: DatabaseSync): SqlProbe {
  const tally: SqlTally = { statements: 0, writes: 0, commits: 0, sql: [], rows: [], prepares: 0 };
  const record = (sql: string): number => {
    tally.statements += 1;
    tally.sql.push(sql);
    tally.rows.push(0);
    if (/^\s*commit\b/i.test(sql)) tally.commits += 1;
    if (WRITE_RE.test(sql)) {
      tally.writes += 1;
      if (db && !db.isTransaction) tally.commits += 1;
    }
    return tally.rows.length - 1;
  };
  const proto = StatementSync.prototype;
  const originals = {
    run: proto.run,
    get: proto.get,
    all: proto.all,
    iterate: proto.iterate,
    exec: DatabaseSync.prototype.exec,
    prepare: DatabaseSync.prototype.prepare,
  };
  // Recorded BEFORE the call, so a write's autocommit is judged by the
  // transaction state it ran in. Installed with defineProperty: the methods are
  // overloaded, and each wrapper forwards whatever arguments it was given.
  Object.defineProperty(proto, "run", {
    configurable: true,
    writable: true,
    value: function run(this: StatementSync, ...args: Parameters<StatementSync["run"]>) {
      record(this.sourceSQL);
      return originals.run.apply(this, args);
    },
  });
  Object.defineProperty(proto, "get", {
    configurable: true,
    writable: true,
    value: function get(this: StatementSync, ...args: Parameters<StatementSync["get"]>) {
      const at = record(this.sourceSQL);
      const row = originals.get.apply(this, args);
      tally.rows[at] = row === undefined ? 0 : 1;
      return row;
    },
  });
  Object.defineProperty(proto, "all", {
    configurable: true,
    writable: true,
    value: function all(this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
      const at = record(this.sourceSQL);
      const rows = originals.all.apply(this, args);
      tally.rows[at] = rows.length;
      return rows;
    },
  });
  Object.defineProperty(proto, "iterate", {
    configurable: true,
    writable: true,
    value: function iterate(this: StatementSync, ...args: Parameters<StatementSync["iterate"]>) {
      record(this.sourceSQL);
      return originals.iterate.apply(this, args);
    },
  });
  DatabaseSync.prototype.exec = function exec(this: DatabaseSync, sql: string) {
    record(sql);
    return originals.exec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function prepare(
    this: DatabaseSync,
    ...args: Parameters<DatabaseSync["prepare"]>
  ) {
    tally.prepares += 1;
    return originals.prepare.apply(this, args);
  };
  let stopped = false;
  return {
    tally,
    stop() {
      if (!stopped) {
        stopped = true;
        proto.run = originals.run;
        proto.get = originals.get;
        proto.all = originals.all;
        proto.iterate = originals.iterate;
        DatabaseSync.prototype.exec = originals.exec;
        DatabaseSync.prototype.prepare = originals.prepare;
      }
      return tally;
    },
  };
}

export interface FileReadProbe {
  /** Paths read under the root, relative to it, in order. */
  readonly reads: string[];
  /** Restores `fs.readFileSync` and returns the reads. */
  stop(): string[];
}

/**
 * Counts `fs.readFileSync` calls on files under `root`. ESM named imports of
 * `node:fs` are live bindings to the builtin, so `syncBuiltinESMExports`
 * carries the wrapper to modules that imported `readFileSync` by name.
 */
export function countFileReads(root: string): FileReadProbe {
  const reads: string[] = [];
  const original = fs.readFileSync;
  const resolvedRoot = path.resolve(root);
  const wrapped = function readFileSync(...args: Parameters<typeof fs.readFileSync>) {
    // Every data-root read in the app passes a path string; a descriptor or a
    // URL resolves outside the root and is not counted.
    const abs = path.resolve(String(args[0]));
    if (abs.startsWith(resolvedRoot + path.sep)) reads.push(path.relative(resolvedRoot, abs));
    return original.apply(fs, args);
  };
  // Installed with defineProperty for the same reason as the SQL wrappers: the
  // original is overloaded and the wrapper forwards its arguments unchanged.
  Object.defineProperty(fs, "readFileSync", { value: wrapped, configurable: true, writable: true });
  syncBuiltinESMExports();
  let stopped = false;
  return {
    reads,
    stop() {
      if (!stopped) {
        stopped = true;
        fs.readFileSync = original;
        syncBuiltinESMExports();
      }
      return reads;
    },
  };
}

export interface FileWrites {
  /** `mkdirSync` targets under the root, relative to it. */
  mkdirs: string[];
  /** `appendFileSync` targets under the root, relative to it. */
  appends: string[];
}

export interface FileWriteProbe {
  readonly writes: FileWrites;
  /** Restores both functions and returns the calls. */
  stop(): FileWrites;
}

/** Counts `fs.mkdirSync` and `fs.appendFileSync` calls under `root`, the same
 *  way `countFileReads` counts reads. */
export function countFileWrites(root: string): FileWriteProbe {
  const writes: FileWrites = { mkdirs: [], appends: [] };
  const resolvedRoot = path.resolve(root);
  const under = (target: string): string | null => {
    const abs = path.resolve(target);
    return abs.startsWith(resolvedRoot + path.sep) ? path.relative(resolvedRoot, abs) : null;
  };
  const originalMkdir = fs.mkdirSync;
  const originalAppend = fs.appendFileSync;
  Object.defineProperty(fs, "mkdirSync", {
    configurable: true,
    writable: true,
    value: function mkdirSync(...args: Parameters<typeof fs.mkdirSync>) {
      const rel = under(String(args[0]));
      if (rel !== null) writes.mkdirs.push(rel);
      return originalMkdir.apply(fs, args);
    },
  });
  Object.defineProperty(fs, "appendFileSync", {
    configurable: true,
    writable: true,
    value: function appendFileSync(...args: Parameters<typeof fs.appendFileSync>) {
      const rel = under(String(args[0]));
      if (rel !== null) writes.appends.push(rel);
      return originalAppend.apply(fs, args);
    },
  });
  syncBuiltinESMExports();
  let stopped = false;
  return {
    writes,
    stop() {
      if (!stopped) {
        stopped = true;
        fs.mkdirSync = originalMkdir;
        fs.appendFileSync = originalAppend;
        syncBuiltinESMExports();
      }
      return writes;
    },
  };
}

export interface StatementRecord {
  sql: string;
  rows: number;
}

export interface ServerReadTally {
  /** `db.prepare` calls (statement compiles). */
  prepares: number;
  /** Every execution, with the rows it returned. */
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

/**
 * The read work one call does: SQL compiles, executions with their rows, and
 * store-file reads under `dataRoot`. Measure a WARM call (run the journey once
 * first): the figures are then the steady state every revalidation pays, not
 * the one-off cost of a cold cache.
 */
export async function tallyServerReads<T>(
  dataRoot: string,
  fn: () => Promise<T> | T,
): Promise<{ result: T; tally: ServerReadTally }> {
  const sql = countSql();
  const files = countFileReads(dataRoot);
  try {
    const result = await fn();
    return { result, tally: toServerReadTally(sql.tally, files.reads) };
  } finally {
    sql.stop();
    files.stop();
  }
}

function toServerReadTally(sql: SqlTally, storeReads: string[]): ServerReadTally {
  return {
    prepares: sql.prepares,
    statements: sql.sql.map((text, i) => ({ sql: text, rows: sql.rows[i] ?? 0 })),
    storeReads: [...storeReads],
  };
}
