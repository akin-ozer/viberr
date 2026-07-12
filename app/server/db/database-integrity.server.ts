import type Database from "better-sqlite3";

export interface DatabaseIntegrityReport {
  ok: boolean;
  messages: string[];
}

/** Run SQLite's bounded structural check and return every reported fault. */
export function checkDatabaseIntegrity(
  db: Database.Database,
): DatabaseIntegrityReport {
  try {
    const rows = db.pragma("quick_check(100)") as Record<string, unknown>[];
    const messages = rows
      .flatMap((row) => Object.values(row))
      .filter((value): value is string => typeof value === "string");
    return {
      ok: messages.length === 1 && messages[0] === "ok",
      messages,
    };
  } catch (error) {
    return {
      ok: false,
      messages: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export class ProjectionIntegrityError extends Error {
  readonly report: DatabaseIntegrityReport;

  constructor(report: DatabaseIntegrityReport) {
    super(
      "The SQLite projection failed its integrity check. Stop Viberr, preserve state/projection.sqlite plus its -wal/-shm files, rebuild the projection from canonical project files, then restart.",
    );
    this.name = "ProjectionIntegrityError";
    this.report = report;
  }
}

const INCIDENT_KEY = Symbol.for("viberr.databaseIntegrityIncident");

export function setDatabaseIntegrityIncident(
  incident: ProjectionIntegrityError | null,
): void {
  const cache = globalThis as unknown as Record<symbol, ProjectionIntegrityError | null>;
  cache[INCIDENT_KEY] = incident;
}

export function getDatabaseIntegrityIncident(): ProjectionIntegrityError | null {
  const cache = globalThis as unknown as Record<symbol, ProjectionIntegrityError | null>;
  return cache[INCIDENT_KEY] ?? null;
}
