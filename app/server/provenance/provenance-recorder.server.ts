import type { DatabaseSync } from "node:sqlite";
import { storeRelativePath } from "../files/file-store-root.server";

/**
 * Provenance WRITE layer (P13-D-16; `architecture.md` server/provenance).
 *
 * The `provenance` table is the observational record of "what the server saw in
 * a store file, and when": the projection rebuilder writes
 * `projected | removed | error | rescan`, the GitHub reconciler writes
 * `github.reconcile` / `github.merge`. Both used to carry a private, byte-
 * identical `INSERT` helper, and every read was raw SQL somewhere else again
 * (a feature module and — worse — a route loader). This module owns the write;
 * `provenance-query.server.ts` owns the read.
 *
 * Rows are append-only and never pruned by `applyRetention`, so `details` must
 * stay small and secret-free — ids, counts, paths, never tokens or file bodies.
 */

export interface ProvenanceRecord {
  /** Store-relative path, e.g. `projects/viberr-core/tasks/VIB-142/task.md`. */
  sourcePath: string;
  /** sha256 of the observed content; null when the observation isn't content
   *  (a reconcile, a removal, a rescan summary). */
  contentHash?: string | null;
  /** `projected` | `removed` | `error` | `rescan` | `github.reconcile` | … */
  action: string;
  details?: Record<string, unknown>;
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

/** {@link recordProvenance} for callers holding an ABSOLUTE store path (the
 *  GitHub reconciler): converts to the store-relative key every reader uses, so
 *  a row written from an absolute path is still findable by the query layer. */
export function recordProvenanceForFile(
  db: DatabaseSync,
  input: Omit<ProvenanceRecord, "sourcePath"> & {
    absPath: string;
    dataRoot?: string;
  },
): void {
  const { absPath, dataRoot, ...rest } = input;
  recordProvenance(db, {
    ...rest,
    sourcePath: storeRelativePath(absPath, dataRoot),
  });
}
