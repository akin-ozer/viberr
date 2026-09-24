import { writeSync } from "node:fs";
import { currentCorrelation } from "./request-context.server";

/**
 * Minimal structured JSON logger: one JSON object per line on stdout.
 * Shape: { level, time (ISO 8601 UTC), msg, ...correlation, ...fields }.
 *
 * Deliberately dependency-free (no pino). It imports exactly ONE app module —
 * `request-context.server.ts`, its prescribed sibling (P13-D-30) — which itself
 * imports nothing but `node:async_hooks`, so there is still no cycle risk and
 * nothing else may be added here. Everything else is allowed to import the
 * logger.
 *
 * Correlation (P13-D-30): every record picks up the active request's
 * `requestId` (plus method/path and what `bindCorrelation` added: the signed-in
 * `userId`, and a run's `runId` and `taskKey` on its own work, ruling 458(d))
 * with no work at the call site. That is the whole point — the previous attempt
 * at this was an opt-in `logger.child({ requestId })` that no call site ever
 * used and was deleted unused. Explicit `fields` still win over correlation on
 * a key clash, so a domain id a call site passes is never silently overwritten.
 */

/** Ascending severity — a level's INDEX is the threshold comparison. */
const LEVELS = ["debug", "info", "warn", "error"] as const;

type LogLevel = (typeof LEVELS)[number];
/** JSON-serializable log values, plus `Error` (flattened by `assign`) and
 *  `undefined` (dropped by JSON.stringify) — the shapes call sites really pass. */
export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };
type LogFields = Record<string, LogValue>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that stamps `bound` onto every record — for job/run paths, which
   *  have a correlation id (runId) but no HTTP request to carry it. */
  child(bound: LogFields): Logger;
}

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  const configured = LEVELS.find((level) => level === raw);
  if (configured !== undefined) return configured;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function assign(record: LogFields, fields?: LogFields): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    // An Error survives JSON.stringify as `{}` — keep the diagnosis instead.
    record[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
}

function write(
  level: LogLevel,
  msg: string,
  bound: LogFields | null,
  fields?: LogFields,
): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(minLevel())) return;
  const record = {
    level,
    time: new Date().toISOString(),
    msg,
  };
  assign(record, currentCorrelation());
  assign(record, bound ?? undefined);
  assign(record, fields);
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg,
      loggingError: "fields were not serializable",
    });
  }
  process.stdout.write(line + "\n");
}

/** The one `node:fs` call this module makes: bytes onto a descriptor, returning
 *  how many the OS took. */
export type SyncWriter = (fd: number, data: string) => number;

/**
 * F20-8(a): one fatal log line written SYNCHRONOUSLY to stderr (fd 2), for the
 * crash paths that call `process.exit` on the very next line. The normal
 * `logger.error` above is an async `process.stdout.write` to a pipe, which
 * `process.exit` truncates — the 2026-08-14 outage went straight from a 200 line
 * to the restart's lock refusal with ZERO diagnostic output in between. `writeSync`
 * returns only once the OS has the bytes, so the diagnosis always survives the
 * exit. Same JSON shape/correlation merge as `write`, minus the level gate (a
 * FATAL is never filtered). Best-effort: a failed write (fd already closed during
 * teardown) must never mask the fatal it is reporting.
 *
 * `sync` is the sink hook for tests (same shape as the GitHub client's
 * `fetchImpl`), defaulting to the real `writeSync`: it is what lets a test read
 * the exact bytes and the descriptor they went to, which are the two things
 * that make this different from `logger.error`.
 */
export function writeFatalSync(
  msg: string,
  fields?: LogFields,
  sync: SyncWriter = writeSync,
): void {
  const record = {
    level: "error",
    time: new Date().toISOString(),
    msg,
  };
  assign(record, currentCorrelation());
  assign(record, fields);
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      msg,
      loggingError: "fields were not serializable",
    });
  }
  try {
    sync(2, line + "\n");
  } catch {
    // stderr already closed during teardown — nothing further we can do.
  }
}

function makeLogger(bound: LogFields | null): Logger {
  const log =
    (level: LogLevel) => (msg: string, fields?: LogFields) =>
      write(level, msg, bound, fields);
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (extra: LogFields) => makeLogger({ ...bound, ...extra }),
  };
}

export const logger: Logger = makeLogger(null);
