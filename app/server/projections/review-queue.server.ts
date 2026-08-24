import type { DatabaseSync } from "node:sqlite";
import {
  conflictingPrBlockedReason,
  type PrMergeable,
  type PrState,
  type TaskPriority,
  type Validation,
  type Waiting,
} from "~/schemas/task-file.schema";
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
 * waiting row "waiting on a human" (never the false "agent working").
 *
 * E5: `viewerUserId` is REQUIRED. It used to be optional, and the acceptance
 * predicate opened with `if (viewerUserId === undefined) return true` — an
 * authorization question whose default answer was "yes, anyone". Nothing in the
 * app omitted it, so the permissive branch existed purely for test convenience
 * while standing ready to hand the next caller an unfiltered "ready for
 * acceptance" list. Naming a viewer is now the type-level cost of asking the
 * question, and an unknown/non-member id resolves to no acceptance authority.
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
  /** F26-14: lightweight triage metadata carried to the acceptance boundary,
   *  the same values the board card reads. */
  priority: TaskPriority;
  labels: string[];
  dueDate: string | null;
  waiting: Waiting;
  /** Pending packet header only — the queue reads kind + title, nothing else. */
  packet: { kind: string; title: string } | null;
  /** Newest timeline event's text (position 0) — the subline fallback. */
  latestEventText: string | null;
  pr: {
    number: number;
    /** F19-32: the CANONICAL four-value PR state (`PrState`), never a private
     *  copy of the union. This row used to narrow it to review|merged|closed
     *  and coerce everything else to "review", which silently swallowed
     *  `accepted` — R16-6's first-class "merge pending" — so `prStatePill`'s
     *  amber branch was structurally unreachable here even though the page
     *  calls the one canonical map (ruling 12). Ruling 40 requires that
     *  difference to be visible on the board card AND this queue; a maintainer
     *  moving a task back out of the terminal stage reaches the state with no
     *  workflow re-wiring at all. */
    state: PrState;
    /** P14-LV-07: GitHub's last-read mergeability. The subline builder has
     *  named a conflicting PR since LV-07 (review-helpers.ts `prStateSub`) and
     *  this row never carried the field, so that branch could not fire on any
     *  real queue — the one state the row could not describe was the one that
     *  cannot be merged at all. Same convention as `prRefSchema`: an ABSENT key
     *  means never read, which is NOT "merges cleanly". */
    mergeable?: PrMergeable;
    /** R17-1 (F17-L12): the PR head is ahead of the reviewed revision by
     *  `aheadBy` commits — the queue subline warns that accepting merges them
     *  unreviewed. Absent when the head equals the reviewed revision. */
    revisionDrift?: { aheadBy: number };
  } | null;
  validation: Validation;
  /** F10-11/F10-15: null = the current revision is acceptance-ready (all
   *  required reviewers approved it, none requesting changes). A non-null reason
   *  means the task is NOT ready for acceptance (failing / awaiting a reviewer /
   *  no delivered revision, or R15-1's verdict gate: delivered work with no PR
   *  or no approving verdict) — it must NOT sit under "Waiting on your
   *  acceptance". R16-3: a PR closed unmerged is named here FIRST, ahead of any
   *  process gate, because no verdict and no force-accept can undo it. */
  blockReason: string | null;
  /** Gap-10: ISO of the newest timeline event (`occurred_at`), null when the
   *  timeline is empty. The queue is a triage list and carried no time at all —
   *  a task that reached the boundary five minutes ago and one that has sat
   *  there since Tuesday rendered identically. */
  lastActivityAt: string | null;
  /** Gap-10: this row has gone quiet past its threshold (see `isQuiet`). */
  quiet: boolean;
  /** D4: 'degraded' when this task's runtime continuity was lost (projected task
   *  fact) — the same state the Continuity Recovery panel shows on task detail,
   *  carried here so the review boundary flags it too. NULL otherwise. */
  continuity: "degraded" | null;
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
  opts: {
    viewerUserId: string;
    dataRoot?: string;
    /** Gap-10: the instant "has this gone quiet?" is asked against (tests only). */
    now?: Date;
  },
): ReviewQueueData {
  const project = getProject(db, slug);
  // D-1 (pass 24): an ARCHIVED project is read-only (R6-3) — the server refuses
  // acceptance from any role, and `decisionsRequiring` (which feeds the home
  // dashboard, the notifications inbox and the board's "waiting on me" chip)
  // drops archived projects entirely. The review queue counted only archived
  // TASKS (via `listProjectTasks`' `archived = 0`), never archived PROJECTS, so an
  // acceptance-ready task on an archived project showed "waiting on your
  // acceptance" here (and on the board chip) while every other surface said
  // nothing waited and the accept click was refused. Treat the whole project as
  // having no review boundary — one predicate, all surfaces agree (F19-9).
  const reviewId =
    project && !project.archived
      ? resolveStageRoles(project.stages, project.workflow).reviewId
      : null;
  const inReview = reviewId
    ? listProjectTasks(db, slug, opts.now ? { now: opts.now } : {}).filter(
        (t) => t.stage === reviewId,
      )
    : [];

  // F10-11/F10-15: acceptance readiness comes from the revision-bound review
  // model, not just `waiting`. The reason (a failing verdict, an outstanding
  // required reviewer, no delivered revision, or R15-1's verdict gate on
  // delivered work) is PROJECTED into `task_projections.validation_block_reason`
  // at rebuild time (P11-50), so this read model no longer re-reads task files
  // on a loader path — and reads the SAME gate the server enforces.

  // Newest event per task in one shot (position 0 = newest, file order).
  const latestByKey = new Map<string, string>();
  // SAFETY: both selected columns, `task_events.task_key` and
  // `task_events.text`, are TEXT NOT NULL (0001_baseline.sql).
  const latestRows = db
    .prepare(
      `SELECT task_key, text FROM task_events
       WHERE project_slug = ? AND position = 0`,
    )
    .all(slug) as { task_key: string; text: string }[];
  for (const row of latestRows) latestByKey.set(row.task_key, row.text);

  const rows: ReviewQueueRow[] = inReview.map((t) => {
    let pr: ReviewQueueRow["pr"] = null;
    if (t.pr) {
      // F19-32: pass the parsed state THROUGH. The old ladder preserved
      // `merged`/`closed` (NEW-1: a coerced closed PR hid that the work was
      // rejected) and folded everything else into "review" — which made
      // `accepted` (merge pending) indistinguishable from an open PR on the
      // one surface ruling 40 names alongside the board. The schema's own
      // `.catch("review")` is what handles an unknown token, so there is
      // nothing left for a second coercion here to defend against.
      pr = { number: t.pr.number, state: t.pr.state };
      // Omitted rather than nulled when GitHub was never asked — the key's
      // absence is the "never read" signal the file format itself uses.
      if (t.pr.mergeable) pr.mergeable = t.pr.mergeable;
      if (t.pr.revisionDrift) {
        pr.revisionDrift = { aheadBy: t.pr.revisionDrift.aheadBy };
      }
    }
    return {
      key: t.key,
      title: t.title,
      // F26-14: carry the triage metadata to the review queue (same source the
      // board card reads), so a high/urgent or overdue task is visible at the
      // acceptance boundary too.
      priority: t.priority,
      labels: t.labels,
      dueDate: t.dueDate,
      waiting: t.waiting,
      packet: t.packet ? { kind: t.packet.kind, title: t.packet.title } : null,
      latestEventText: latestByKey.get(t.key) ?? null,
      pr,
      validation: t.validation,
      blockReason: t.blockReason,
      // Gap-10: annotated once, by `listProjectTasks` — the board and this queue
      // must not answer "when did anything last happen here" two different ways.
      lastActivityAt: t.lastActivityAt,
      quiet: t.quiet,
      // D4: the projected continuity fact, carried straight through so the review
      // row flags degraded continuity the same way the board card does.
      continuity: t.continuity,
    };
  });

  // R8-3: "Waiting on your acceptance" is member-scoped by ACCEPTANCE AUTHORITY,
  // not by decision-object presence — a review-stage task waiting on a human can
  // have no packet/recommendation (the operator couldn't open a completion
  // packet) yet still need a human to accept it. A viewer can accept iff they are
  // maintainer+ (resolve-packet tier) OR the task's owner (owner exception, R6-2,
  // which requires the own-task role). Fail closed: an id with no membership row
  // — a non-member, a deleted account, or (a JS caller) no id at all — holds
  // neither role, so nothing is acceptance-ready for them.
  // SAFETY: `project_members.role` is CHECK-constrained to exactly
  // PROJECT_ROLES ('admin' | 'maintainer' | 'contributor' | 'viewer') by
  // 0001_baseline.sql; the row is undefined when the viewer is not a member.
  const viewerRole: ProjectRole | null = opts.viewerUserId
    ? ((
        db
          .prepare(
            `SELECT role FROM project_members WHERE project_slug = ? AND user_id = ?`,
          )
          .get(slug, opts.viewerUserId) as { role: ProjectRole } | undefined
      )?.role ?? null)
    : null;
  const viewerCanGovern = roleCan(viewerRole, "resolve-packet");
  const viewerCanOwn = roleCan(viewerRole, "own-task");
  const ownerByKey = new Map(
    inReview.map((t) => [
      t.key,
      t.owner && t.owner.kind === "human" ? t.owner.userId : null,
    ]),
  );
  const canAccept = (key: string): boolean => {
    if (viewerCanGovern) return true;
    if (!viewerCanOwn) return false;
    const owner = ownerByKey.get(key) ?? null;
    return owner !== null && owner === opts.viewerUserId;
  };
  // UX19-3: the projected `blockReason` column carries only PART of the
  // acceptance gate. `acceptanceBlockReason` (rebuilder.server.ts) deliberately
  // omits two refusals `acceptanceRefusalReason` enforces on every writer
  // (task-actions.server.ts) — an OPEN blocked decision, and a CONFLICTING PR —
  // and this filter re-checked neither. Live shape: a row sat under "Waiting on
  // your acceptance" wearing the "your acceptance" tag while the task page one
  // click away read "Acceptance is blocked". Both facts are on the task summary
  // this queue already reads, so the panel split now asks the same questions the
  // writer does. R15-11 keeps the ROW a triage link ("Review", never "Accept"),
  // but the PANEL is still a promise — it must not name an acceptance the server
  // refuses. (When the projected column grows these gates too, `blockReason`
  // catches them first and this stays harmless belt-and-braces.)
  const gateBlockedByKey = new Map<string, boolean>(
    inReview.map((t) => [
      t.key,
      // Same predicate the acceptance writers pass as `blockedPacket`
      // (task-actions.server.ts): an operator-raised blocked decision is still
      // open, and accepting would bury it.
      (t.readiness === "blocked" && t.packet?.type === "blocked") ||
        // P14-LV-07, via the SAME helper the server gate calls — a PR GitHub
        // cannot merge cannot be accepted.
        conflictingPrBlockedReason(t, t.key) !== null,
    ]),
  );
  // Ready-for-acceptance requires acceptance authority, an acceptable current
  // revision (F10-11: no failing/awaiting/no-revision block), the rest of the
  // server's refusal set (UX19-3), AND that the review PR was not REJECTED
  // (closed unmerged) — a rejected-PR task can't be accepted (its work was
  // declined); it needs a rework/reopen/archive decision, so it belongs in
  // "Still in review", not the acceptance panel (NEW-1).
  const isReady = (r: ReviewQueueRow): boolean =>
    r.waiting === "human" &&
    canAccept(r.key) &&
    r.blockReason === null &&
    !gateBlockedByKey.get(r.key) &&
    r.pr?.state !== "closed";
  return {
    ready: rows.filter(isReady),
    working: rows.filter((r) => !isReady(r)),
    total: rows.length,
  };
}
