import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { onTestFinished } from "vitest";

/**
 * Ruling 11: deterministic counters for the perf tests (the one home for
 * counting SQL, store-file reads and writes). They wrap
 * the process-wide `node:sqlite` prototypes and `fs.readFileSync` for the span
 * between `start` and `stop`, so every module (including ones that prepared
 * their statements before the probe started) is counted. A test holds one
 * database, so the process-wide scope is the database under test.
 *
 * Start a probe inside a test: it also stops when that test finishes, so a
 * throw inside the window cannot leave the prototypes or `fs` wrapped for the
 * rest of the file (the next probe would capture the wrapper as its original,
 * and a leaked `countSql(db)` would read a database the cleanup has closed).
 * Probes may nest and stop in any order: a stopped probe's wrapper only
 * forwards, and it comes off as soon as nothing live is installed above it.
 */

/** Any of the overloaded functions a probe wraps. */
type Wrappable = (...args: never[]) => void;

/** What each installed wrapper replaced, and whether its probe has stopped. */
const INSTALLED = new WeakMap<Wrappable, { original: Wrappable; stopped: () => boolean }>();

function install<K extends string>(
  target: Record<K, Wrappable>,
  key: K,
  wrapper: Wrappable,
  stopped: () => boolean,
): void {
  INSTALLED.set(wrapper, { original: target[key], stopped });
  // defineProperty: the originals are overloaded, and each wrapper forwards
  // whatever arguments it was given.
  Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapper });
}

/** Takes stopped probes' wrappers off `target[key]`, top down, and stops at
 *  the first one whose probe is still counting (it comes off when it stops). */
function unwind<K extends string>(target: Record<K, Wrappable>, key: K): void {
  for (;;) {
    const entry = INSTALLED.get(target[key]);
    if (!entry?.stopped()) return;
    Object.defineProperty(target, key, { configurable: true, writable: true, value: entry.original });
  }
}

export interface SqlTally {
  /** Statement executions: `run`/`get`/`all`/`iterate` plus every `exec`. */
  statements: number;
  /** WAL commits: writes outside a transaction plus each `COMMIT`. */
  commits: number;
  /** The SQL text of each execution, in order (for filters and messages). */
  sql: string[];
  /** Rows each execution returned, index-aligned with `sql` (0 for run/exec). */
  rows: number[];
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
  const tally: SqlTally = { statements: 0, commits: 0, sql: [], rows: [] };
  const record = (sql: string): number => {
    tally.statements += 1;
    tally.sql.push(sql);
    tally.rows.push(0);
    if (/^\s*commit\b/i.test(sql)) tally.commits += 1;
    // A write outside a transaction is its own commit.
    if (WRITE_RE.test(sql) && db && !db.isTransaction) tally.commits += 1;
    return tally.rows.length - 1;
  };
  const proto = StatementSync.prototype;
  const originals = {
    run: proto.run,
    get: proto.get,
    all: proto.all,
    iterate: proto.iterate,
    exec: DatabaseSync.prototype.exec,
  };
  let stopped = false;
  const isStopped = () => stopped;
  const stop = (): SqlTally => {
    stopped = true;
    for (const key of ["run", "get", "all", "iterate"] as const) unwind(proto, key);
    unwind(DatabaseSync.prototype, "exec");
    return tally;
  };
  // Registered before anything is wrapped: outside a test this throws with
  // nothing to undo.
  onTestFinished(() => {
    stop();
  });
  // Recorded BEFORE the call, so a write's autocommit is judged by the
  // transaction state it ran in.
  install(
    proto,
    "run",
    function run(this: StatementSync, ...args: Parameters<StatementSync["run"]>) {
      if (!stopped) record(this.sourceSQL);
      return originals.run.apply(this, args);
    },
    isStopped,
  );
  install(
    proto,
    "get",
    function get(this: StatementSync, ...args: Parameters<StatementSync["get"]>) {
      if (stopped) return originals.get.apply(this, args);
      const at = record(this.sourceSQL);
      const row = originals.get.apply(this, args);
      tally.rows[at] = row === undefined ? 0 : 1;
      return row;
    },
    isStopped,
  );
  install(
    proto,
    "all",
    function all(this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
      if (stopped) return originals.all.apply(this, args);
      const at = record(this.sourceSQL);
      const rows = originals.all.apply(this, args);
      tally.rows[at] = rows.length;
      return rows;
    },
    isStopped,
  );
  install(
    proto,
    "iterate",
    function iterate(this: StatementSync, ...args: Parameters<StatementSync["iterate"]>) {
      if (!stopped) record(this.sourceSQL);
      return originals.iterate.apply(this, args);
    },
    isStopped,
  );
  install(
    DatabaseSync.prototype,
    "exec",
    function exec(this: DatabaseSync, sql: string) {
      if (!stopped) record(sql);
      return originals.exec.call(this, sql);
    },
    isStopped,
  );
  return { tally, stop };
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
  let stopped = false;
  const stop = (): string[] => {
    stopped = true;
    unwind(fs, "readFileSync");
    syncBuiltinESMExports();
    return reads;
  };
  onTestFinished(() => {
    stop();
  });
  const resolvedRoot = path.resolve(root);
  const wrapped = function readFileSync(...args: Parameters<typeof fs.readFileSync>) {
    // Every data-root read in the app passes a path string; a descriptor or a
    // URL resolves outside the root and is not counted.
    const abs = path.resolve(String(args[0]));
    if (!stopped && abs.startsWith(resolvedRoot + path.sep)) reads.push(path.relative(resolvedRoot, abs));
    return original.apply(fs, args);
  };
  install(fs, "readFileSync", wrapped, () => stopped);
  syncBuiltinESMExports();
  return { reads, stop };
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
  let stopped = false;
  const isStopped = () => stopped;
  const stop = (): FileWrites => {
    stopped = true;
    unwind(fs, "mkdirSync");
    unwind(fs, "appendFileSync");
    syncBuiltinESMExports();
    return writes;
  };
  onTestFinished(() => {
    stop();
  });
  install(
    fs,
    "mkdirSync",
    function mkdirSync(...args: Parameters<typeof fs.mkdirSync>) {
      const rel = stopped ? null : under(String(args[0]));
      if (rel !== null) writes.mkdirs.push(rel);
      return originalMkdir.apply(fs, args);
    },
    isStopped,
  );
  install(
    fs,
    "appendFileSync",
    function appendFileSync(...args: Parameters<typeof fs.appendFileSync>) {
      const rel = stopped ? null : under(String(args[0]));
      if (rel !== null) writes.appends.push(rel);
      return originalAppend.apply(fs, args);
    },
    isStopped,
  );
  syncBuiltinESMExports();
  return { writes, stop };
}

export interface StatementRecord {
  sql: string;
  rows: number;
}

export interface ServerReadTally {
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
 * The read work one call does: SQL executions with their rows, and
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
    statements: sql.sql.map((text, i) => ({ sql: text, rows: sql.rows[i] ?? 0 })),
    storeReads: [...storeReads],
  };
}
