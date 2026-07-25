import type { DatabaseSync } from "node:sqlite";
import type { Validation, Waiting } from "~/schemas/task-file.schema";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { getProject, listProjectTasks } from "./board-query.server";

/**
 * Review-queue read model (review-queue.md §1/§3, Phase 9C).
 *
 * Qualification: the project's RESOLVED review stage (the stage with a workflow
 * edge into the terminal stage — `resolveStageRoles().reviewId`), NOT the
 * literal id "review". This is the exact predicate the workspace-layout rail
 * badge uses (routes/project.tsx), so the two counts can never drift — on a
 * board whose review stage is not literally named `review`, a
 * literal-"review" filter left this queue permanently empty while the rail
 * showed a count (pass-4 WI-1). Panel split (R8-3, member-scoped): a
 * review-stage task waiting on a human lands in "Waiting on your acceptance"
 * ONLY for a viewer who can ACCEPT it — maintainer+ (resolve-packet tier) or
 * the task owner (owner exception, R6-2). Everything else — waiting on an agent,
 * the legal `review + none` combination, OR a human-waiting task another human
 * must accept — lands in "Still in review", where the page labels a human-
 * waiting row "waiting on a human" (never the false "agent working"). Passing no
 * viewer keeps the split state-based (any human-waiting task → ready), which the
 * tests and non-scoped callers rely on.
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
  pr: { number: number; state: "review" | "merged" | "closed" } | null;
  validation: Validation;
  /** F10-11/F10-15: null = the current revision is acceptance-ready (all
   *  required reviewers approved it, none requesting changes). A non-null reason
   *  means the task is NOT ready for acceptance (failing / awaiting a reviewer /
   *  no delivered revision) — it must NOT sit under "Waiting on your acceptance".*/
  blockReason: string | null;
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
  db: DatabaseSync,
  slug: string,
  opts: { viewerUserId?: string; dataRoot?: string } = {},
): ReviewQueueData {
  const project = getProject(db, slug);
  const reviewId = project
    ? resolveStageRoles(project.stages, project.workflow).reviewId
    : null;
  const inReview = reviewId
    ? listProjectTasks(db, slug).filter((t) => t.stage === reviewId)
    : [];

  // F10-11/F10-15: acceptance readiness comes from the revision-bound review
  // model, not just `waiting`. The reason (a failing verdict, an outstanding
  // required reviewer, or no delivered revision) is PROJECTED into
  // `task_projections.validation_block_reason` at rebuild time (P11-50), so this
  // read model no longer re-reads task files on a loader path.

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
          // Preserve a CLOSED (rejected) PR so the acceptance filter can exclude
          // it — coercing it to "review" hid that the work was rejected (NEW-1).
          state:
            t.pr.state === "merged"
              ? ("merged" as const)
              : t.pr.state === "closed"
                ? ("closed" as const)
                : ("review" as const),
        }
      : null,
    validation: t.validation,
    blockReason: t.blockReason,
  }));

  // R8-3: "Waiting on your acceptance" is member-scoped by ACCEPTANCE AUTHORITY,
  // not by decision-object presence — a review-stage task waiting on a human can
  // have no packet/recommendation (the operator couldn't open a completion
  // packet) yet still need a human to accept it. A viewer can accept iff they are
  // maintainer+ (resolve-packet tier) OR the task's owner (owner exception, R6-2,
  // which requires the own-task role). No viewer → state-based (any human-waiting
  // task), preserving the unscoped/test behavior.
  const viewerRole: ProjectRole | null =
    opts.viewerUserId === undefined
      ? null
      : ((
          db
            .prepare(
              `SELECT role FROM project_members WHERE project_slug = ? AND user_id = ?`,
            )
            .get(slug, opts.viewerUserId) as { role: ProjectRole } | undefined
        )?.role ?? null);
  const viewerCanGovern = roleCan(viewerRole, "resolve-packet");
  const viewerCanOwn = roleCan(viewerRole, "own-task");
  const ownerByKey = new Map(
    inReview.map((t) => [
      t.key,
      t.owner && t.owner.kind === "human" ? t.owner.userId : null,
    ]),
  );
  const canAccept = (key: string): boolean => {
    if (opts.viewerUserId === undefined) return true; // unscoped
    if (viewerCanGovern) return true;
    const owner = ownerByKey.get(key) ?? null;
    return owner !== null && owner === opts.viewerUserId && viewerCanOwn;
  };
  // Ready-for-acceptance requires acceptance authority, an acceptable current
  // revision (F10-11: no failing/awaiting/no-revision block), AND that the review
  // PR was not REJECTED (closed unmerged) — a rejected-PR task can't be accepted
  // (its work was declined); it needs a rework/reopen/archive decision, so it
  // belongs in "Still in review", not the acceptance panel (NEW-1).
  const isReady = (r: ReviewQueueRow): boolean =>
    r.waiting === "human" &&
    canAccept(r.key) &&
    r.blockReason === null &&
    r.pr?.state !== "closed";
  return {
    ready: rows.filter(isReady),
    working: rows.filter((r) => !isReady(r)),
    total: rows.length,
  };
}
