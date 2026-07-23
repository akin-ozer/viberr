/**
 * Minimal structured JSON logger: one JSON object per line on stdout.
 * Shape: { level, time (ISO 8601 UTC), msg, ...fields }.
 *
 * Deliberately dependency-free (no pino) and must never import other server
 * modules — everything else is allowed to import the logger.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof LEVELS;
type LogFields = Record<string, unknown>;

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

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return;
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg,
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

const log = (level: LogLevel) => (msg: string, fields?: LogFields) =>
  write(level, msg, fields);

export const logger = {
  debug: log("debug"),
  info: log("info"),
  warn: log("warn"),
  error: log("error"),
};
