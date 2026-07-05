import type Database from "better-sqlite3";
import type { Validation, Waiting } from "~/schemas/task-file.schema";
import { listProjectTasks } from "./board-query.server";

/**
 * Review-queue read model (review-queue.md §1/§3, Phase 9C).
 *
 * Qualification: literal `stage === "review"` only (contracts §2.2) — the
 * same predicate the workspace layout uses for the rail badge, so the two
 * counts can never drift. The panel split is purely on `waiting`:
 * `human` → "Waiting on your acceptance", anything else — including the
 * legal `review + none` combination — lands in "Still with agents"
 * (ruling 10 / contracts §2.2, ported 1:1).
 *
 * Ordering (spec §8.2 decision): deterministic task-key number ASC — the
 * order `listProjectTasks` already guarantees, which reproduces the mock's
 * seed rendering (VIB-142 above VIB-145).
 *
 * Rows are read-only projections; the queue performs zero mutations.
 */

export interface ReviewQueueRow {
  key: string;
  title: string;
  waiting: Waiting;
  /** Pending packet header only — the queue reads kind + title, nothing else. */
  packet: { kind: string; title: string } | null;
  /** Newest timeline event's text (position 0) — the subline fallback. */
  latestEventText: string | null;
  pr: { number: number; state: "review" | "merged" } | null;
  validation: Validation;
}

export interface ReviewQueueData {
  /** waiting === "human" — panel 1. */
  ready: ReviewQueueRow[];
  /** everything else at the review stage — panel 2. */
  working: ReviewQueueRow[];
  /** All review-stage tasks (header "X of Y" + rail-badge parity). */
  total: number;
}

export function getReviewQueue(
  db: Database.Database,
  slug: string,
): ReviewQueueData {
  const inReview = listProjectTasks(db, slug).filter(
    (t) => t.stage === "review",
  );

  // Newest event per task in one shot (position 0 = newest, file order).
  const latestByKey = new Map<string, string>();
  const latestRows = db
    .prepare(
      `SELECT task_key, text FROM task_events
       WHERE project_slug = ? AND position = 0`,
    )
    .all(slug) as { task_key: string; text: string }[];
  for (const row of latestRows) latestByKey.set(row.task_key, row.text);

  const rows: ReviewQueueRow[] = inReview.map((t) => ({
    key: t.key,
    title: t.title,
    waiting: t.waiting,
    packet: t.packet ? { kind: t.packet.kind, title: t.packet.title } : null,
    latestEventText: latestByKey.get(t.key) ?? null,
    pr: t.pr
      ? {
          number: t.pr.number,
          state: t.pr.state === "merged" ? ("merged" as const) : ("review" as const),
        }
      : null,
    validation: t.validation,
  }));

  return {
    ready: rows.filter((r) => r.waiting === "human"),
    working: rows.filter((r) => r.waiting !== "human"),
    total: rows.length,
  };
}
