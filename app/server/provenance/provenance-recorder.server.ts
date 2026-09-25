import type { DatabaseSync } from "node:sqlite";

/**
 * Provenance WRITE layer (P13-D-16; `architecture.md` server/provenance).
 *
 * The `provenance` table is the observational record of "what the server saw in
 * a store file, and when": the projection rebuilder writes
 * `projected | removed | error | rescan`, the GitHub reconciler writes
 * `github.reconcile` / `github.merge`. Both used to carry a private, byte-
 * identical `INSERT` helper, and every read was raw SQL somewhere else again
 * (a feature module and — worse — a route loader). This module owns the write;
 * `provenance-query.server.ts` owns the read. A Viberr push of a task branch
 * writes `github.push` through it (ruling 494, `recompareAfterPush`).
 *
 * Rows are append-only and never pruned by `applyRetention`, so `details` must
 * stay small and secret-free — ids, counts, paths, never tokens or file bodies.
 */

/**
 * A `details` value as it survives the round trip through `details_json` — the
 * JSON scalars, arrays and nested maps, and nothing else, so a caller cannot
 * hand over a value `JSON.stringify` flattens to `{}` and leave a field name
 * with no fact under it. (`audit-recorder.server.ts` states the same contract
 * for its own blob column; the two tables share nothing else.)
 */
export type ProvenanceDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ProvenanceDetailValue[]
  | { [key: string]: ProvenanceDetailValue };

export interface ProvenanceRecord {
  /** Store-relative path, e.g. `projects/viberr-core/tasks/VIB-142/task.md`. */
  sourcePath: string;
  /** sha256 of the observed content; null when the observation isn't content
   *  (a reconcile, a removal, a rescan summary). */
  contentHash?: string | null;
  /** `projected` | `removed` | `error` | `rescan` | `github.reconcile` | … */
  action: string;
  details?: { [key: string]: ProvenanceDetailValue };
  /** Injectable observation time (tests / batch runs). Defaults to now. */
  observedAt?: string;
}

/** Appends one provenance observation. */
export function recordProvenance(
  db: DatabaseSync,
  input: ProvenanceRecord,
): void {
  db.prepare(
    `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.sourcePath,
    input.contentHash ?? null,
    input.observedAt ?? new Date().toISOString(),
    input.action,
    input.details ? JSON.stringify(input.details) : null,
  );
}
