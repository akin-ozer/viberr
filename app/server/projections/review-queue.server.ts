import type Database from "better-sqlite3";
import type { PrState, Validation, Waiting } from "~/schemas/task-file.schema";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { getProject, listProjectTasks } from "./board-query.server";
import { taskWaitsOnUser, type ProjectRole } from "~/shared/rbac";

/**
 * Review-queue read model (review-queue.md §1/§3, Phase 9C).
 *
 * Qualification: the project's RESOLVED review stage (the stage with a workflow
 * edge into the terminal stage — `resolveStageRoles().reviewId`), NOT the
 * literal id "review". This is the exact predicate the workspace-layout rail
 * badge uses (routes/project.tsx), so the two counts can never drift — on a
 * Lightweight board (`todo/doing/done`) the review role is `doing`, and a
 * literal-"review" filter left this queue permanently empty while the rail
 * showed a count (pass-4 WI-1). Human waits are personalized from explicit
 * project supervision or active task ownership; emergency org-admin authority
 * deliberately does not turn every project decision into routine assigned
 * work. `agent` and `none` remain separate states.
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
  pr: { number: number; state: PrState } | null;
  validation: Validation;
}

export interface ReviewQueueData {
  /** Human decision explicitly routed to this viewer. */
  ready: ReviewQueueRow[];
  /** Human decision routed to another owner/supervisor. */
  others: ReviewQueueRow[];
  /** Agent-side work in flight. */
  working: ReviewQueueRow[];
  /** Review-stage task with no active handoff. */
  unattended: ReviewQueueRow[];
  /** All review-stage tasks (header "X of Y" + rail-badge parity). */
  total: number;
}

export function getReviewQueue(
  db: Database.Database,
  slug: string,
  viewer?: { userId: string; projectRole: ProjectRole | null },
): ReviewQueueData {
  const project = getProject(db, slug);
  const reviewId = project
    ? resolveStageRoles(project.stages, project.workflow).reviewId
    : null;
  const inReview = reviewId
    ? listProjectTasks(db, slug).filter((t) => t.stage === reviewId)
    : [];

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
    pr: t.pr ? { number: t.pr.number, state: t.pr.state } : null,
    validation: t.validation,
  }));

  const mine = (row: ReviewQueueRow) => {
    const task = inReview.find((candidate) => candidate.key === row.key);
    return viewer
      ? taskWaitsOnUser({
          waiting: row.waiting,
          viewerUserId: viewer.userId,
          projectRole: viewer.projectRole,
          ownerUserId:
            task?.owner?.kind === "human" ? task.owner.userId : null,
        })
      : row.waiting === "human";
  };
  return {
    ready: rows.filter(mine),
    others: rows.filter((r) => r.waiting === "human" && !mine(r)),
    working: rows.filter((r) => r.waiting === "agent"),
    unattended: rows.filter((r) => r.waiting === "none"),
    total: rows.length,
  };
}
