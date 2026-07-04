/**
 * Minimal structured JSON logger: one JSON object per line on stdout.
 * Shape: { level, time (ISO 8601 UTC), msg, ...boundFields, ...callFields }.
 * Use `logger.child({ requestId })` to bind per-request context.
 *
 * Deliberately dependency-free (no pino) and must never import other server
 * modules — everything else is allowed to import the logger.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a new logger with `bindings` merged into every line. */
  child(bindings: LogFields): Logger;
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

export function createLogger(bindings: LogFields = {}): Logger {
  function write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[minLevel()]) return;
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      msg,
      ...bindings,
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = serializeField(value);
      }
    }
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

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

/** Process-wide root logger. */
export const logger: Logger = createLogger();
