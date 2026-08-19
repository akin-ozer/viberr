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
 * `requestId` (plus method/path and anything `bindCorrelation` added) with no
 * work at the call site. That is the whole point — the previous attempt at this
 * was an opt-in `logger.child({ requestId })` that no call site ever used and
 * was deleted unused. Explicit `fields` still win over correlation on a key
 * clash, so a domain id a call site passes is never silently overwritten.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof LEVELS;
type LogFields = Record<string, unknown>;

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
  if (raw && raw in LEVELS) return raw as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function serializeField(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function assign(record: Record<string, unknown>, fields?: LogFields): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    record[key] = serializeField(value);
  }
}

function write(
  level: LogLevel,
  msg: string,
  bound: LogFields | null,
  fields?: LogFields,
): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return;
  const record: Record<string, unknown> = {
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
 */
export function writeFatalSync(msg: string, fields?: LogFields): void {
  const record: Record<string, unknown> = {
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
    writeSync(2, line + "\n");
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
    child: (extra: LogFields) => makeLogger({ ...(bound ?? {}), ...extra }),
  };
}

export const logger: Logger = makeLogger(null);
