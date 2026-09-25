import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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
const RECONCILE_ACTION = "github.reconcile";

/** `details_json` is a small JSON OBJECT of facts (ids, counts, paths) — see
 *  the secret-free contract on `provenance-recorder.server.ts`. Anything else
 *  the column holds (a scalar, an array, unparseable text) is not a details bag
 *  and reads as absent, the way unparseable text always did. */
const provenanceDetailsSchema = z.record(z.string(), z.json());

export type ProvenanceDetails = z.infer<typeof provenanceDetailsSchema>;

export interface ProvenanceRow {
  id: number;
  sourcePath: string;
  contentHash: string | null;
  observedAt: string;
  action: string;
  details: ProvenanceDetails | null;
}

type RawRow = {
  id: number;
  source_path: string;
  content_hash: string | null;
  observed_at: string;
  action: string;
  details_json: string | null;
};

function parseDetails(json: string | null): ProvenanceDetails | null {
  if (!json) return null;
  try {
    const parsed = provenanceDetailsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
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
  // SAFETY: `provenance` (0001_baseline.sql) declares every column this row
  // maps — `id` INTEGER PRIMARY KEY, `source_path`/`observed_at`/`action` TEXT
  // NOT NULL, `content_hash`/`details_json` nullable TEXT.
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
  ) as RawRow[];
  return rows.map(mapRow);
}

/** The newest observation for one file+action, or null. */
export function latestProvenance(
  db: DatabaseSync,
  options: { sourcePath: string; action: string },
): ProvenanceRow | null {
  // SAFETY: same column guarantees as {@link listProvenance}.
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
/** The one field a `github.reconcile` row is read for. A row whose `behindBy`
 *  is missing or not a number is "never compared", exactly as before. */
const reconcileDetailsSchema = z.object({ behindBy: z.number() });

/** The sync verdict a row recorded, when it recorded one. */
const reconcileSyncSchema = z.object({ sync: z.string() });

/** Ruling 494: the head a row names (the compare's on a `github.reconcile`
 *  row, the pushed one on a `github.push` row). Absent, null or unreadable is
 *  "not named", which a reader treats as unknown, never as a match. */
const rowHeadSchema = z.object({ headSha: z.string().min(1).nullish().catch(null) });

function rowHeadOf(details: ProvenanceDetails | null): string | null {
  if (details === null) return null;
  const parsed = rowHeadSchema.safeParse(details);
  return parsed.success ? (parsed.data.headSha ?? null) : null;
}

/** What the NEWEST `github.reconcile` row for a task file recorded. */
export interface ReconcileObservation {
  /** Its sync verdict, or null when it recorded none. */
  sync: string | null;
  /** Ruling 494: the branch head its compare read, or null when it named none
   *  (a row written before the ruling, or an answer that did not name it). */
  headSha: string | null;
}

/**
 * The sync verdict and the compared head the NEWEST observation row for this
 * task file recorded, or null when there is no row.
 *
 * Ruling 187's sibling (pass 37, F37-9): the sync pill reads the newest
 * `github.reconcile` row, and the reconciler withheld that row on any pass
 * whose only change was the compare — so when `main` moved, the pill kept
 * rendering the last verdict. Live, SHOP-2 showed **synced** while the
 * reconciler's own audit row for the same minute said `behind_main` and git
 * agreed with the audit. "Behind main" is only interesting BECAUSE main
 * moved, which was the one transition the pill could not see.
 *
 * Ruling 494 (pass 40, F40-70): the same holds for the head the compare read.
 * The count is true only of that head, so a pass that compared a DIFFERENT
 * head than the newest row names is a change worth a row too (and a row that
 * names none is replaced by the first pass that does).
 *
 * The reconciler compares against this and writes a row when either differs,
 * so growth stays bounded by real changes exactly as `changed` bounds it for
 * the file.
 */
export function latestReconcileObservation(
  db: DatabaseSync,
  sourcePath: string,
): ReconcileObservation | null {
  // SAFETY: `provenance.details_json` is a nullable TEXT column
  // (0001_baseline.sql), and it is the only column selected here.
  const row = db
    .prepare(
      `SELECT details_json FROM provenance
       WHERE source_path = ? AND action = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(sourcePath, RECONCILE_ACTION) as { details_json: string | null } | undefined;
  if (!row) return null;
  const details = parseDetails(row.details_json);
  const sync = details === null ? null : reconcileSyncSchema.safeParse(details);
  return {
    sync: sync?.success ? sync.data.sync : null,
    headSha: rowHeadOf(details),
  };
}

/** Ruling 494: the row a Viberr push of a task branch leaves beside the
 *  compares (`recompareAfterPush`, github-reconciler.server.ts). */
export const PUSH_ACTION = "github.push";

/**
 * Ruling 494 (pass 40, F40-70): the newest compare's count for a task branch,
 * with the head it was counted on and any push Viberr made after it.
 *
 * `baseBehindBy` used to be the count alone. Live on WEB-16 a compare read
 * GitHub's copy of the branch 0.2 s before the delivery pushed a head that
 * carried `main`, nothing compared again for five minutes, and for those five
 * minutes the operator told the owner, twice in packets, that the branch was 6
 * commits behind. The row named no head, so nothing could tell the count was
 * about a head the branch no longer had.
 */
export interface BaseCompareReading {
  /** The count the newest compare recorded. */
  behindBy: number;
  /** The branch head that compare read, or null when the row names none. */
  headSha: string | null;
  /** When that compare ran (UTC ISO). */
  observedAt: string;
  /** Viberr's newest push of the branch recorded AFTER that compare (the head
   *  it published, null when git could not name it), or null when none was. */
  pushedSince: { headSha: string | null; at: string } | null;
}

/** Factory, like {@link createReconcileBehindByLookup}: the statements are
 *  prepared once. Null exactly when that lookup answers null (no row, or a
 *  newest row with no count: never compared). */
export function createBaseCompareLookup(
  db: DatabaseSync,
): (sourcePath: string) => BaseCompareReading | null {
  const compareStmt = db.prepare(
    `SELECT id, observed_at, details_json FROM provenance
     WHERE source_path = ? AND action = ?
     ORDER BY id DESC LIMIT 1`,
  );
  const pushStmt = db.prepare(
    `SELECT observed_at, details_json FROM provenance
     WHERE source_path = ? AND action = ? AND id > ?
     ORDER BY id DESC LIMIT 1`,
  );
  return (sourcePath: string): BaseCompareReading | null => {
    // SAFETY: `id` is the INTEGER PRIMARY KEY, `observed_at` TEXT NOT NULL and
    // `details_json` nullable TEXT (0001_baseline.sql): the three columns
    // selected.
    const row = compareStmt.get(sourcePath, RECONCILE_ACTION) as
      | { id: number; observed_at: string; details_json: string | null }
      | undefined;
    if (!row) return null;
    const details = parseDetails(row.details_json);
    if (details === null) return null;
    const reconciled = reconcileDetailsSchema.safeParse(details);
    if (!reconciled.success) return null;
    // SAFETY: as above, `observed_at` and `details_json`.
    const push = pushStmt.get(sourcePath, PUSH_ACTION, row.id) as
      | { observed_at: string; details_json: string | null }
      | undefined;
    return {
      behindBy: reconciled.data.behindBy,
      headSha: rowHeadOf(details),
      observedAt: row.observed_at,
      pushedSince: push
        ? { headSha: rowHeadOf(parseDetails(push.details_json)), at: push.observed_at }
        : null,
    };
  };
}

export function createReconcileBehindByLookup(
  db: DatabaseSync,
): (sourcePath: string) => number | null {
  const stmt = db.prepare(
    `SELECT details_json FROM provenance
     WHERE source_path = ? AND action = ?
     ORDER BY id DESC LIMIT 1`,
  );
  return (sourcePath: string): number | null => {
    // SAFETY: `provenance.details_json` is a nullable TEXT column
    // (0001_baseline.sql), and it is the only column selected here.
    const row = stmt.get(sourcePath, RECONCILE_ACTION) as
      | { details_json: string | null }
      | undefined;
    const details = parseDetails(row?.details_json ?? null);
    if (details === null) return null;
    const reconciled = reconcileDetailsSchema.safeParse(details);
    return reconciled.success ? reconciled.data.behindBy : null;
  };
}

/**
 * Newest reconcile OBSERVATION ROW across all of a project's task files.
 *
 * F19-22 — read the name literally: this is the last pass that CHANGED
 * something, never the last pass that ran. DG-3
 * (`github-reconciler.server.ts`: `if (changed || !ctx.skipUnchangedProvenance)`)
 * deliberately withholds the row on an unchanged poller tick to bound the
 * table, so a healthy poller over a quiet repository leaves this value frozen
 * for hours. Null therefore means "no pass has ever recorded a change" — NOT
 * "never reconciled", which is what every caller used to render it as.
 *
 * For "when did a pass last COMPLETE?" use
 * `server/audit/audit-query.server.ts`, which reads the unconditional per-tick
 * audit row. Surfaces that describe freshness to a human need BOTH.
 */
export function latestProjectReconcileAt(
  db: DatabaseSync,
  projectSlug: string,
): string | null {
  // SAFETY: `MAX()` over the nullable-when-empty TEXT column `observed_at`
  // yields TEXT or NULL, and the aggregate always returns exactly one row.
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

/** Newest reconcile OBSERVATION ROW for ONE task — the task page's "Last
 *  change" cue (UI-57; previously a raw `.prepare()` inside the route loader).
 *  Same F19-22 caveat as {@link latestProjectReconcileAt}: null means no pass
 *  ever recorded a change for this task, not that none ever ran, and the
 *  "Checked" half of that panel comes from the audit query instead. */
export function latestTaskReconcileAt(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string | null {
  // SAFETY: same aggregate guarantee as {@link latestProjectReconcileAt}.
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
