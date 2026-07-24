import type { DatabaseSync } from "node:sqlite";

/**
 * Provenance READ layer (P13-D-16; `architecture.md` server/provenance).
 *
 * Every production read of the `provenance` table used to be raw SQL in the
 * wrong layer — two statements inside a feature query module and a
 * hand-written `db.prepare(...)` inside a ROUTE LOADER (the only one in
 * `app/routes/`, against the layering rules the same document states). All
 * three asked the same question in three shapes: "what did the reconciler last
 * observe for this file?". They now ask it here.
 *
 * This is a query layer, not a product surface: there is no user-facing
 * provenance view (that claim was dropped from the doc), and nothing here
 * interprets — freshness POLICY lives in
 * `server/interpretation/freshness-policy.server.ts`.
 */

/** The reconciler's per-task observation (branch compare + PR state). */
export const RECONCILE_ACTION = "github.reconcile";

export interface ProvenanceRow {
  id: number;
  sourcePath: string;
  contentHash: string | null;
  observedAt: string;
  action: string;
  details: Record<string, unknown> | null;
}

interface RawRow {
  id: number;
  source_path: string;
  content_hash: string | null;
  observed_at: string;
  action: string;
  details_json: string | null;
}

function parseDetails(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapRow(row: RawRow): ProvenanceRow {
  return {
    id: row.id,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    observedAt: row.observed_at,
    action: row.action,
    details: parseDetails(row.details_json),
  };
}

/** Store-relative provenance key for a task file — the exact string the
 *  rebuilder and the reconciler write under (`storeRelativePath` of the task
 *  file), reproduced here so slug+key callers need no filesystem access. */
export function taskProvenancePath(
  projectSlug: string,
  taskKey: string,
): string {
  return `projects/${projectSlug}/tasks/${taskKey}/task.md`;
}

/** Newest-first observations for one store file (optionally one action).
 *  This is what makes the rebuilder's `projected|removed|error|rescan` rows
 *  readable at all — they had no reader before. */
export function listProvenance(
  db: DatabaseSync,
  options: { sourcePath: string; action?: string; limit?: number },
): ProvenanceRow[] {
  const limit = options.limit ?? 50;
  const rows = (
    options.action
      ? db
          .prepare(
            `SELECT * FROM provenance WHERE source_path = ? AND action = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(options.sourcePath, options.action, limit)
      : db
          .prepare(
            `SELECT * FROM provenance WHERE source_path = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(options.sourcePath, limit)
  ) as unknown as RawRow[];
  return rows.map(mapRow);
}

/** The newest observation for one file+action, or null. */
export function latestProvenance(
  db: DatabaseSync,
  options: { sourcePath: string; action: string },
): ProvenanceRow | null {
  const row = db
    .prepare(
      `SELECT * FROM provenance WHERE source_path = ? AND action = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(options.sourcePath, options.action) as RawRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Latest reconciled `behindBy` per task file — or **null when the branch was
 * never compared** (UI-05). Null is load-bearing: `deriveSyncState` cannot
 * distinguish "no data" from a real "0 commits behind", so returning 0 painted
 * an unreconciled branch green "synced".
 *
 * Factory: the statement is prepared ONCE and many branch rows are mapped
 * through it, instead of re-preparing per row inside a `.map` (pass-4 WI-10).
 */
export function createReconcileBehindByLookup(
  db: DatabaseSync,
): (sourcePath: string) => number | null {
  const stmt = db.prepare(
    `SELECT details_json FROM provenance
     WHERE source_path = ? AND action = ?
     ORDER BY id DESC LIMIT 1`,
  );
  return (sourcePath: string): number | null => {
    const row = stmt.get(sourcePath, RECONCILE_ACTION) as
      | { details_json: string | null }
      | undefined;
    const behindBy = parseDetails(row?.details_json ?? null)?.behindBy;
    return typeof behindBy === "number" ? behindBy : null;
  };
}

/** Newest reconcile across ALL of a project's task files; null = never. */
export function latestProjectReconcileAt(
  db: DatabaseSync,
  projectSlug: string,
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(observed_at) AS latest FROM provenance
       WHERE action = ? AND source_path LIKE ?`,
    )
    .get(RECONCILE_ACTION, `projects/${projectSlug}/%`) as
    | { latest: string | null }
    | undefined;
  return row?.latest ?? null;
}

/** Newest reconcile for ONE task; null = never. The task page's freshness cue
 *  (UI-57) — previously a raw `.prepare()` inside the route loader. */
export function latestTaskReconcileAt(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(observed_at) AS latest FROM provenance
       WHERE action = ? AND source_path = ?`,
    )
    .get(RECONCILE_ACTION, taskProvenancePath(projectSlug, taskKey)) as
    | { latest: string | null }
    | undefined;
  return row?.latest ?? null;
}
