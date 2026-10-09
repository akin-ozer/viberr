import type { RevisionDrift } from "~/shared/revision-drift";
import type { DatabaseSync } from "node:sqlite";
import {
  conflictingPrBlockedReason,
  unpushedRevisionBlockedReason,
  unpushedRevisionOf,
  type UnpushedRevision,
  type PrMergeable,
  type PrState,
  type TaskPriority,
  type Validation,
  type Waiting,
} from "~/schemas/task-file.schema";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import {
  isTerminalStage,
  resolveStageRoles,
  stageName,
} from "~/shared/workflow/stage-roles";
import type { ProjectRecord } from "~/shared/mapping/project.server";
import {
  getProject,
  listProjectTasks,
  type TaskActivitySummary,
} from "./board-query.server";
import { liveMergeable } from "~/features/github/github-pills";
import { prPathOverlaps, type PrDiffPaths, type PrOverlap } from "~/shared/pr-overlaps";

/**
 * Review-queue read model (review-queue.md §1/§3, Phase 9C).
 *
 * Ruling 304 (owner, 2026-10-09): the queue is its viewer's own. A row is a
 * task the viewer OWNS (the human owner seat, held with `own-task`, the owner
 * exception's own condition), whatever their project role, and a task owned by
 * anybody else is never a row, a maintainer's included. Each row stands in one
 * of three panels:
 *
 * - `completions` ("Waiting on your acceptance"): the decision moves the task
 *   to the terminal stage. Either an open packet offers `accept_completion`,
 *   or, with no packet open, the task stands at the acceptance boundary waiting
 *   on its owner and nothing refuses the acceptance (`isReady` below).
 * - `decisions` ("Open decisions"): an open decision packet that asks anything
 *   else, at any stage. One open packet per task, so one row.
 * - `working` ("Still in review"): review work with nothing for the owner to
 *   decide yet.
 *
 * REVIEW WORK (U35-5, pass 35) is what the board defines by engagements and
 * verdicts, not by one stage id. A non-archived, non-terminal task is review
 * work when ANY of these holds:
 *   (a) it sits at the RESOLVED review stage (the stage with a workflow edge
 *       into the terminal stage — `resolveStageRoles().reviewId`, NOT the
 *       literal id "review");
 *   (b) its pull request is open for review (`pr.state === "review"`);
 *   (c) a verdict-capable engagement (a required reviewer, F10-15) has not
 *       approved the current work revision: the derived `validation` is
 *       `changed` (verdict pending) or `failing` (changes requested).
 * All three read the projection row (`pr_json`, `reviewers_json`,
 * `validation`), so the query stays one pass over `task_projections`. On a
 * board whose reviews happen at Validation and Review while the edge into Done
 * leaves Merge, (b) and (c) are what list the work (FINDINGS U35-5).
 *
 * `total` counts every row and is what the workspace rail badge shows
 * (routes/project.tsx reads this queue's `total`), so the two cannot drift —
 * a literal-"review" filter once left this queue permanently empty while the
 * rail showed a count (pass-4 WI-1).
 *
 * `acceptableKeys` is wider than the rows on purpose: every task this viewer
 * may accept now, theirs or not (maintainer+, the resolve-packet tier, or the
 * owner, R6-2). It is the acceptance half of the "waiting on you" answer the
 * board, the epic pages and the rows' tags share (`waitingOnViewer`, R8-3), and
 * a maintainer can still accept a task they do not own there; only this queue
 * is the owner's alone.
 *
 * E5: `viewerUserId` is REQUIRED. It used to be optional, and the acceptance
 * predicate opened with `if (viewerUserId === undefined) return true` — an
 * authorization question whose default answer was "yes, anyone". Nothing in the
 * app omitted it, so the permissive branch existed purely for test convenience
 * while standing ready to hand the next caller an unfiltered "ready for
 * acceptance" list. Naming a viewer is now the type-level cost of asking the
 * question, and an unknown/non-member id resolves to no acceptance authority
 * and no rows.
 *
 * Ordering (spec §8.2 decision): deterministic task-key number ASC — the
 * order `listProjectTasks` already guarantees, which reproduces the mock's
 * seed rendering (VIB-142 above VIB-145).
 *
 * Rows are read-only projections, and the queue's route has no action: a
 * decision is answered in the queue's dialog, which reads the task page's
 * decision (`routes/task-decision.ts`) and posts to the task page's action.
 */

/** Ruling 242 / 116: the pairwise path intersection lives in
 *  `~/shared/pr-overlaps` (moved by ruling 244 so the accept dialog shares it). */

export interface ReviewQueueRow {
  key: string;
  title: string;
  /** U35-5: the DISPLAY name of the stage the task sits at (`stageName`, the
   *  one spelling every surface shares). An off-boundary row's subline names
   *  it ("Review in progress at Validation"), because the rows no longer share
   *  a stage. */
  stageName: string;
  /** U35-5: true when acceptance is legal FROM the stage the task sits at —
   *  the graph's own answer (`isAtAcceptanceBoundary`, the predicate behind
   *  `acceptanceStageBlockedReason` and the board's accept gate), NOT
   *  `stage === reviewId`: a board may declare several edges into the terminal
   *  stage and `reviewId` is only the first of them. `ready` requires it; the
   *  subline builder picks the boundary sentences for it and the "Review in
   *  progress at <stage>" sentence otherwise. */
  atAcceptanceBoundary: boolean;
  /** F26-14: lightweight triage metadata carried to the acceptance boundary,
   *  the same values the board card reads. */
  priority: TaskPriority;
  labels: string[];
  dueDate: string | null;
  waiting: Waiting;
  /** Ruling 45: the instant a clock-resting row picks itself back up, so the
   *  queue names the time instead of a person who owes nothing. */
  resumesAt: string | null;
  /** Pending packet header only — the queue reads kind + title, nothing else. */
  packet: { kind: string; title: string } | null;
  /** Ruling 63: an `edit_goal` decision was confirmed and the packet waits
   *  for the edited goal — the row's subline says so instead of re-offering
   *  the decision. */
  goalEditPending: boolean;
  /** Newest timeline event's text (position 0) — the subline fallback. */
  latestEventText: string | null;
  pr: {
    number: number;
    /** F19-32: the CANONICAL four-value PR state (`PrState`), never a private
     *  copy of the union. This row used to narrow it to review|merged|closed
     *  and coerce everything else to "review", which silently swallowed
     *  `accepted` — R16-6's first-class "merge pending" — so `prStatePill`'s
     *  amber branch was structurally unreachable here even though the page
     *  calls the one canonical map (ruling 237). Ruling 244 requires that
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
    /** Ruling 239 (F17-L12): the WHOLE drift record (authored count + base
     *  refresh), so the subline can print the
     *  canonical sentence. Absent when the head equals the reviewed revision. */
    revisionDrift?: RevisionDrift;
    /** Ruling 243: the PR head as last read, and the CURRENT unpushed record
     *  (already filtered through `unpushedRevisionOf` against the row's own
     *  revision, so the subline can trust it). Absent = on the PR, or unread. */
    headSha?: string;
    unpushedRevision?: UnpushedRevision;
    /** Ruling 242 (owner, 2026-09-14): the other OPEN review PRs in this project
     *  whose changed paths intersect this one's, so the queue can say which
     *  merges will conflict which before a person finds out by pressing Accept.
     *  Measured live: merging SHOP-2 put four of six open PRs into CONFLICTING
     *  inside a minute, all on the same two shared files, and the queue listed
     *  them as six independent rows throughout.
     *
     *  Read-only: it orders nothing and blocks nothing. Absent when no path
     *  list has been read for this PR; empty when nothing overlaps. */
    overlaps?: PrOverlap[];
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
  /** Ruling 304: the viewer's own tasks whose decision moves them to the
   *  terminal stage — a packet offering `accept_completion`, or an acceptance
   *  nothing refuses — panel 1, "Waiting on your acceptance". */
  completions: ReviewQueueRow[];
  /** Ruling 304: the viewer's own tasks with any other open decision packet,
   *  at any stage — panel 2, "Open decisions". */
  decisions: ReviewQueueRow[];
  /** The viewer's own review work with nothing to decide yet: review-stage
   *  tasks, and review work at any earlier stage (an open review PR, or a
   *  required reviewer's verdict outstanding on the current revision) —
   *  panel 3 (U35-5). */
  working: ReviewQueueRow[];
  /** Every task this viewer may accept now, theirs or not (maintainer+, or
   *  the owner): the acceptance half of `waitingOnViewer` (UI-48), which the
   *  board, the epic pages and the rows' tags read. Wider than the rows. */
  acceptableKeys: string[];
  /** All rows, in every panel: the rail badge's count, so the badge and the
   *  queue it opens are one number. */
  total: number;
}

export function getReviewQueue(
  db: DatabaseSync,
  slug: string,
  opts: {
    viewerUserId: string;
    dataRoot?: string;
    /**
     * Ruling 11: the project's LIVE tasks (archived ones dropped) in
     * `listProjectTasks` order, when the caller already built them — the
     * workspace layout passes the board's list, so each load maps every task
     * once. Omitted, the queue lists them itself. Same rows either way, so the
     * rail badge and this queue stay one number (U35-5).
     */
    tasks?: readonly TaskActivitySummary[];
    /** Ruling 11: the project row, when the caller already read it. */
    project?: ProjectRecord | null;
  },
): ReviewQueueData {
  const project = opts.project === undefined ? getProject(db, slug) : opts.project;
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
  const stages = project ? project.stages : [];
  // U35-5: review work is the union of the three rules the header comment
  // names. `listProjectTasks` already drops archived tasks (R14-3); the
  // terminal stage is dropped here because a task in Done is an ending, not
  // review work, whatever its PR or verdict state still says (LV-20 normalises
  // its `waiting` the same way).
  const isReviewWork = (t: TaskSummary): boolean => {
    if (isTerminalStage(t.stage, stages)) return false;
    if (t.stage === reviewId) return true;
    // (b) an open pull request under review.
    if (t.pr !== null && t.pr.state === "review") return true;
    // (c) a required reviewer's verdict on the current revision is missing
    // (`changed`) or is request_changes (`failing`). `deriveValidation` yields
    // `changed` for a revision with NO required reviewer too, so the
    // engagement check is what makes this "review work" and not merely
    // "delivered".
    return (
      t.reviewers.some((r) => r.verdictCapable === true) &&
      (t.validation === "changed" || t.validation === "failing")
    );
  };
  // An archived project has no review boundary (D-1 above) and nothing on it
  // anybody can act on (R6-3), so it lists nothing. A task in the terminal
  // stage is an ending, not a decision or review work.
  const live = reviewId
    ? (opts.tasks ?? listProjectTasks(db, slug)).filter((t) => !isTerminalStage(t.stage, stages))
    : [];

  // R8-3: acceptance is member-scoped by ACCEPTANCE AUTHORITY, not by
  // decision-object presence — a review-stage task waiting on a human can have
  // no packet/recommendation (the operator couldn't open a completion packet)
  // yet still need a human to accept it. A viewer can accept iff they are
  // maintainer+ (resolve-packet tier) OR the task's owner (owner exception,
  // R6-2, which requires the own-task role). Fail closed: an id with no
  // membership row — a non-member, a deleted account, or (a JS caller) no id at
  // all — holds neither role, so nothing is acceptance-ready for them and no
  // task is theirs.
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
  /** Ruling 304: the task is the viewer's — the human owner seat, held with
   *  `own-task`, the owner exception's own condition (R6-2). */
  const isOwn = (t: TaskSummary): boolean =>
    viewerCanOwn &&
    t.owner !== null &&
    t.owner.kind === "human" &&
    t.owner.userId === opts.viewerUserId;
  // UX19-3: the projected `blockReason` column carries only PART of the
  // acceptance gate. `acceptanceBlockReason` (rebuilder.server.ts) deliberately
  // omits two refusals `acceptanceRefusalReason` enforces on every writer
  // (task-acceptance.server.ts) — an OPEN blocked decision, and a CONFLICTING PR —
  // and this filter re-checked neither. Live shape: a row sat under "Waiting on
  // your acceptance" wearing the "your acceptance" tag while the task page one
  // click away read "Acceptance is blocked". Both facts are on the task summary
  // this queue already reads, so the panel split now asks the same questions the
  // writer does. The panel is a promise: it must not name an acceptance the
  // server refuses. (When the projected column grows these gates too,
  // `blockReason` catches them first and this stays harmless belt-and-braces.)
  const gateBlocked = (t: TaskSummary): boolean =>
    // Same predicate the acceptance writers pass as `blockedPacket`
    // (task-acceptance.server.ts): an operator-raised blocked decision is still
    // open, and accepting would bury it.
    (t.readiness === "blocked" && t.packet?.type === "blocked") ||
    // Ruling 243: the delivered revision is not on the PR.
    unpushedRevisionBlockedReason(t.pr, t.workRevisionSha ?? null, t.key) !== null ||
    // P14-LV-07, via the SAME helper the server gate calls — a PR GitHub
    // cannot merge cannot be accepted.
    conflictingPrBlockedReason(t, t.key) !== null;
  // Ready-for-acceptance requires acceptance authority, an acceptable current
  // revision (F10-11/F10-15: no failing/awaiting/no-revision block, the
  // revision-bound reason PROJECTED into `validation_block_reason` at rebuild
  // time, P11-50, so this reads the SAME gate the server enforces without
  // re-reading task files on a loader path), the rest of the server's refusal
  // set (UX19-3), AND that the review PR was not REJECTED (closed unmerged) — a
  // rejected-PR task can't be accepted (its work was declined); it needs a
  // rework/reopen/archive decision, so it is not offered for acceptance (NEW-1).
  // U35-5: only a stage acceptance is legal FROM earns it
  // (`acceptanceStageBlockedReason`, task-acceptance.server.ts, whose predicate
  // this is); review work before the boundary is listed, never offered for
  // acceptance.
  const isReady = (t: TaskSummary): boolean =>
    isReviewWork(t) &&
    t.atAcceptanceBoundary &&
    t.waiting === "human" &&
    (viewerCanGovern || isOwn(t)) &&
    t.blockReason === null &&
    !gateBlocked(t) &&
    t.pr?.state !== "closed";
  const acceptableKeys = live.filter(isReady).map((t) => t.key);
  const acceptable = new Set(acceptableKeys);
  // Ruling 304: the rows are the viewer's own tasks that carry an open packet,
  // at any stage, or are review work.
  const listed = live.filter((t) => isOwn(t) && (t.packet !== null || isReviewWork(t)));

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

  const rows: ReviewQueueRow[] = listed.map((t) => {
    let pr: ReviewQueueRow["pr"] = null;
    if (t.pr) {
      // F19-32: pass the parsed state THROUGH. The old ladder preserved
      // `merged`/`closed` (NEW-1: a coerced closed PR hid that the work was
      // rejected) and folded everything else into "review" — which made
      // `accepted` (merge pending) indistinguishable from an open PR on the
      // one surface ruling 244 names alongside the board. The schema's own
      // `.catch("review")` is what handles an unknown token, so there is
      // nothing left for a second coercion here to defend against.
      pr = { number: t.pr.number, state: t.pr.state };
      // Omitted rather than nulled when GitHub was never asked — the key's
      // absence is the "never read" signal the file format itself uses.
      // Ruling 242: through the head pin (ruling 315), as the GitHub page and
      // the task page read it; raw, the row's subline called a PR conflicting
      // after the push that resolved it.
      const mergeable = liveMergeable(t.pr);
      if (mergeable) pr.mergeable = mergeable;
      // Ruling 239: the whole record rides through — projecting only a count
      // here is what dropped `baseRefresh` before the row was built.
      if (t.pr.revisionDrift) pr.revisionDrift = t.pr.revisionDrift;
      // Ruling 243: both fields ride through, or `prStateSub`'s branch is
      // structurally unreachable (the same defect `mergeable` had, P14-LV-07).
      if (t.pr.headSha) pr.headSha = t.pr.headSha;
      const unpushed = unpushedRevisionOf(t.pr, t.workRevisionSha ?? null);
      if (unpushed) pr.unpushedRevision = unpushed;
    }
    return {
      key: t.key,
      title: t.title,
      // U35-5: the row names its stage, since the rows no longer share one.
      stageName: stageName(stages, t.stage),
      // The summary already carries the graph's answer, derived server-side
      // through the same `resolveStageRoles` the acceptance writer uses; a
      // second, narrower predicate here filed a legally acceptable task under
      // "Still in review" while the board offered Accept on the same row.
      atAcceptanceBoundary: t.atAcceptanceBoundary,
      // F26-14: carry the triage metadata to the review queue (same source the
      // board card reads), so a high/urgent or overdue task is visible at the
      // acceptance boundary too.
      priority: t.priority,
      labels: t.labels,
      dueDate: t.dueDate,
      waiting: t.waiting,
      resumesAt: t.resumesAt ?? null,
      packet: t.packet ? { kind: t.packet.kind, title: t.packet.title } : null,
      goalEditPending: t.packet?.awaiting === "goal_edit",
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

  // Ruling 242: pairwise path intersection across the board's OPEN review PRs,
  // every one of them and not only the viewer's: a merge of someone else's PR
  // puts this row's in conflict just the same. Done here, over tasks already
  // loaded, rather than in the UI: it is a question about the project's pull
  // requests, not about one card, and a surface that recomputed it per row
  // would need every other row anyway.
  const sides: PrDiffPaths[] = live.flatMap((t) => {
    const paths = t.pr?.paths;
    return t.pr?.state === "review" && paths && paths.changed.length > 0
      ? [{ taskKey: t.key, prNumber: t.pr.number, changed: paths.changed, truncated: paths.truncated }]
      : [];
  });
  const sideByKey = new Map(sides.map((side) => [side.taskKey, side]));
  for (const row of rows) {
    const mine = sideByKey.get(row.key);
    if (!row.pr || !mine) continue;
    row.pr.overlaps = prPathOverlaps(mine, sides);
  }

  // Ruling 304: the panel is what the decision does. An open packet is the
  // task's decision wherever it stands; it moves the task to the terminal
  // stage when it offers `accept_completion` (a decided `edit_goal` offers
  // nothing: what it owes is the goal). With no packet open, an acceptance
  // nothing refuses is the decision, and review work waits for one.
  const completions: ReviewQueueRow[] = [];
  const decisions: ReviewQueueRow[] = [];
  const working: ReviewQueueRow[] = [];
  for (const [i, row] of rows.entries()) {
    const packet = listed[i].packet;
    if (packet) {
      const offersAcceptance =
        packet.awaiting === undefined &&
        packet.options.some((o) => o.kind === "accept_completion");
      (offersAcceptance ? completions : decisions).push(row);
    } else {
      (acceptable.has(row.key) ? completions : working).push(row);
    }
  }
  return { completions, decisions, working, acceptableKeys, total: rows.length };
}
