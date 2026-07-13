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

const integrityCache = new WeakMap<
  Database.Database,
  { checkedAt: number; report: DatabaseIntegrityReport }
>();

/**
 * Health probes can arrive every few seconds. `quick_check` walks database
 * pages and should not run once per probe, so retain a recent structural result
 * while normal count queries still prove the handle is responsive on every
 * request. Boot always uses the uncached check.
 */
export function checkDatabaseIntegrityCached(
  db: Database.Database,
  options: { now?: number; ttlMs?: number } = {},
): DatabaseIntegrityReport {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 30_000;
  const cached = integrityCache.get(db);
  if (cached && now - cached.checkedAt < ttlMs) return cached.report;
  const report = checkDatabaseIntegrity(db);
  integrityCache.set(db, { checkedAt: now, report });
  return report;
}

export function clearDatabaseIntegrityCache(db: Database.Database): void {
  integrityCache.delete(db);
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
