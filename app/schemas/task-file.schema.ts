import { z } from "zod";
import {
  diagError,
  diagInfo,
  diagWarning,
  type FileDiagnostic,
} from "./file-diagnostics";

/**
 * Zod schemas + tolerant parser for the `task.md` frontmatter and packet
 * (canonical file format documented in docs/architecture/file-formats.md).
 *
 * Tolerance contract (docs/architecture/decisions.md "Behavior rules"):
 * - unknown frontmatter fields are PRESERVED (returned separately, re-written
 *   verbatim by the serializer);
 * - missing/invalid fields produce structured FileDiagnostics + a safe
 *   fallback — the parser never throws and never drops the task.
 *
 * Readiness values are the canonical 4-value enum ONLY (orchestrator
 * ruling 1). "accepted" is a derived display state, never stored here.
 */

// ---------------------------------------------------------------- enums

export const READINESS_VALUES = [
  "ready",
  "input_required",
  "inconsistency_risk_detected",
  "blocked",
] as const;
export type Readiness = (typeof READINESS_VALUES)[number];

export const WAITING_VALUES = ["human", "agent", "none"] as const;
export type Waiting = (typeof WAITING_VALUES)[number];

export const VALIDATION_VALUES = ["healthy", "changed", "failing", "none"] as const;
export type Validation = (typeof VALIDATION_VALUES)[number];

/** The 10 timeline event types (cross-cutting contracts §1.3). Parsers keep
 * unknown strings as-is (renderer falls back to comment meta).
 *
 * P13-LV-03: `policy` used to be a grab-bag — a real PAT-scope violation, a
 * refused delivery directive, a divergence note, a scheduled re-run note and a
 * plain goal edit all shared it, so the timeline labelled a human editing a goal
 * a **"Policy violation"**. `policy` is now reserved for genuine governance
 * violations/refusals (coral shield); everything neutral is a `note`. */
export const TIMELINE_EVENT_TYPES = [
  "comment",
  "completion",
  "github",
  "policy",
  "note",
  "quality",
  "transition",
  "blocked",
  "agent",
  "assign",
  // G8: a runtime-continuity reset (a resumed session's provider transcript was
  // gone, so the agent re-anchored on task.md in a fresh session). A WARNING-
  // toned typed event, not a neutral `note` — nothing was violated (not
  // `policy`) and nothing is stuck (not `blocked`), but a supervisor scanning
  // the board/stream must get a cue that context was lost and recovered.
  "continuity",
] as const;

/** Stable packet-option kinds (orchestrator ruling 7). Dispatch on these,
 * never on English titles. */
export const PACKET_OPTION_KINDS = [
  "accept_completion",
  "request_edit",
  "block_on_policy",
  "hold_runtime_debug",
  "redirect",
  // Backend-failure recovery (D4): re-run the failed agent on the named
  // backend. Payload: `backend` (target), `profileId` (reviewer retries only).
  "retry_other_backend",
  // "A human refines the task goal": confirming opens the goal editor; the
  // packet stays (stamped `awaiting: goal_edit`) and clears the moment the
  // edited goal is saved — the decision is then fully carried out.
  "edit_goal",
  // Archive the task as the chosen disposition (R14-3 contract: reversible,
  // record kept, leaves the board/queue). With `deleteBranch: true` on the
  // option, the remote branch is deleted too — the discard-entirely path for
  // work whose PR a human closed without merging. Resolution enforces the
  // same `approve-transition` authority as the Archive button.
  "archive_task",
  "custom",
] as const;
export type PacketOptionKind = (typeof PACKET_OPTION_KINDS)[number];

// ------------------------------------------------------------ sub-shapes

/** Agent reference: profile id is the join key (ruling: never join by role
 * string). backend+role are display data. Still the projection JSON shape for
 * the derived specialist/reviewers columns. */
const agentRefSchema = z
  .object({
    profileId: z.string().min(1),
    backend: z.enum(["codex", "claude"]),
    role: z.string().min(1),
  })
  .loose();
export type AgentRef = z.infer<typeof agentRefSchema>;

/**
 * One agent ENGAGED on a task (generic-agents plan G1, 2026-07-19): the
 * uniform replacement for the former `specialist` + `reviewers[]` slots. At
 * most ONE engagement carries `delivers: true` — the workspace/branch/PR
 * owner (single-writer invariant; the parser coerces extras). Every other
 * behavior difference comes from the profile's capability grants, never from
 * which list an agent sits in.
 */
export const engagementSchema = z
  .object({
    profileId: z.string().min(1),
    backend: z.enum(["codex", "claude"]),
    /** Role display snapshot taken from the live profile at engage time. */
    role: z.string().min(1),
    delivers: z.boolean().default(false),
    /** F10-15: snapshot at engage time — does this engagement hold an EXPLICIT
     *  `report-validation-verdict: direct` grant? A supporting engagement that
     *  does is a REQUIRED reviewer: acceptance waits for its approval of the
     *  current work revision. A pure, file-local flag so the required-reviewer
     *  set needs no live profile lookup (mirrors role/backend/delivers). */
    verdictCapable: z.boolean().default(false),
  })
  .loose();
export type Engagement = z.infer<typeof engagementSchema>;

/** The single delivering engagement (workspace/branch/PR owner), if any. */
export function deliveringEngagement(fm: {
  engagements: Engagement[];
}): Engagement | null {
  return fm.engagements.find((e) => e.delivers) ?? null;
}

/** Every non-delivering engagement (the former "reviewers" position). */
export function supportingEngagements(fm: {
  engagements: Engagement[];
}): Engagement[] {
  return fm.engagements.filter((e) => !e.delivers);
}

/** Operator assignment — stage id captured when the operator attached
 * (ruling 16: store the stage id; UI renders "stage <1-based index>"). */
export const operatorRefSchema = z
  .object({ assignedAtStageId: z.string().min(1) })
  .loose();
export type OperatorRef = z.infer<typeof operatorRefSchema>;

/** Operator recommendation kinds — a supervised operator RECOMMENDS an action
 * (rather than performing it); the task UI renders each as a one-click card a
 * human accepts (applies) or dismisses. Distinct from packets (single decision):
 * a task can carry several pending recommendations at once. */
export const RECOMMENDATION_KINDS = [
  "assign_specialist",
  "assign_reviewer",
  "transition",
  // Under `recommend` autonomy the operator can't start runs itself, so it
  // recommends STARTING the specialist / reviewer run — an actionable card a
  // maintainer applies with one click (previously a dead-end comment with no
  // apply affordance). profileId targets the reviewer to run; the primary
  // specialist run needs none.
  "run_specialist",
  "run_reviewer",
  // A clean review → the operator recommends accepting completion, which moves
  // the task to Done (the review→done boundary). Rendered as an actionable card
  // symmetric with the other stage transitions; applying it (admin|maintainer)
  // accepts completion into Done.
  "accept_completion",
  // R15-2: an operator whose `deliver-review-pr` capability is `recommend`
  // proposes DELIVERY — push the task branch + open the review PR — and a human
  // applies it (performDelivery runs under their authority).
  "delivery",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export const recommendationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(RECOMMENDATION_KINDS),
    /** assign_specialist / assign_reviewer — the deployed specialist to engage. */
    profileId: z.string().optional(),
    /** transition — the target stage id. */
    toStageId: z.string().optional(),
    /** Button label, e.g. "Assign Dev as primary specialist". */
    label: z.string().min(1),
    /** The operator's reasoning for the recommendation (rendered under it). */
    detail: z.string().default(""),
  })
  .loose();
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * A governed SCHEDULED action on a task (O-3): a human schedules a future
 * operator re-run — e.g. "re-check this not-yet-Done task in 24h". Canonical in
 * the task file so it survives a projection rebuild; a server-side runner fires
 * due entries (server-side → backend-agnostic, works for Claude AND Codex, no
 * per-backend agent tool). Never fires on a terminal (Done) task.
 */
export const SCHEDULE_ACTION_TYPES = ["run-operator"] as const;

// F10-16 lifecycle: pending → claimed → fired (success) | failed (terminal).
// `claimed` reserves an occurrence before the detached operator enqueue so a
// crash/enqueue failure between the claim and completion is RECOVERABLE (a
// stale claim past its lease is re-driven) rather than silently lost, which the
// old pending→fired-before-enqueue flow did. `cancelled` is a human withdrawal.
export const SCHEDULE_STATUS_VALUES = [
  "pending",
  "claimed",
  "fired",
  "failed",
  "cancelled",
] as const;

export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(SCHEDULE_ACTION_TYPES),
    /** ISO timestamp; the runner fires the entry once now >= dueAt. */
    dueAt: z.string().min(1),
    /** The backend + autonomy the scheduled operator run uses. */
    backend: z.enum(["claude", "codex"]).default("claude"),
    autonomy: z.enum(["supervised", "full"]).default("supervised"),
    /** Human note shown on the scheduled-actions card. */
    note: z.string().default(""),
    /** Who scheduled it (userId) + a display label. */
    createdBy: z.string().min(1),
    createdByLabel: z.string().default(""),
    createdAt: z.string().min(1),
    status: z.enum(SCHEDULE_STATUS_VALUES).default("pending"),
    /** Set when the runner fires (or skips) the entry. */
    firedAt: z.string().nullable().default(null),
    /** F10-16: set when the runner CLAIMS the occurrence (before enqueue). A
     *  claim older than the lease is treated as crashed and re-driven. */
    claimedAt: z.string().nullable().default(null),
    /** F10-16: bounded retry counter — a failed enqueue/run retries up to a cap,
     *  then becomes terminal `failed` (visible), never silently lost. */
    retries: z.number().int().default(0),
  })
  .loose();
export type TaskSchedule = z.infer<typeof scheduleSchema>;

/** The canonical `pr.state` cache vocabulary (ruling 12 + D3): "review" =
 * open (incl. draft), "merged", "closed" = closed without merging, and
 * "accepted" = a human accepted the completion but the real merge is still
 * pending. Kept in ONE place; pr-linker/pr-open/reconcilers all write from
 * this set. */
export const PR_STATE_VALUES = ["review", "merged", "closed", "accepted"] as const;
export type PrState = (typeof PR_STATE_VALUES)[number];

/**
 * P13-D-28: the canonical `pr.review` vocabulary — GitHub's review-state
 * awareness the PRD promises (`prd.md:124`), derived by the reconciler from
 * `GET /pulls/{n}/reviews` + the PR's requested reviewers:
 *
 *   changes_requested — a reviewer's LATEST non-comment review asks for changes
 *                       (outranks approved when both are outstanding)
 *   approved          — at least one outstanding approval, none outstanding
 *                       against it
 *   review_required   — a reviewer/team is requested but nobody has ruled yet
 *
 * ABSENT/null means "nothing outstanding, or GitHub was never successfully
 * read" — never rendered as a verdict. Kept in ONE place, like PR_STATE_VALUES.
 */
export const PR_REVIEW_VALUES = [
  "approved",
  "changes_requested",
  "review_required",
] as const;
export type PrReviewState = (typeof PR_REVIEW_VALUES)[number];

/**
 * P14-LV-07: the canonical `pr.mergeable` vocabulary — whether GitHub can
 * actually merge this PR, derived by the linker from the PR detail's
 * `mergeable` + `mergeable_state`:
 *
 *   conflicting — the head conflicts with the base branch (`mergeable: false` /
 *                 `mergeable_state: "dirty"`); a merge WILL fail
 *   clean       — GitHub reports it mergeable
 *   unknown     — GitHub is still computing it (`mergeable: null`)
 *
 * Live-proven need: a merge that failed because the PR CONFLICTED was reported
 * to the human as "no reachable GitHub merge — merge it manually or reconcile
 * once credentials are set", and the task closed as accepted with the PR still
 * open. Mergeability was fetched on every reconcile (it rides the same PR detail
 * call as the change stats) and thrown away, so a conflicting PR was
 * indistinguishable from a credential outage. ABSENT/null means "never read",
 * exactly like `checks`/`review`.
 */
export const PR_MERGEABLE_VALUES = ["clean", "conflicting", "unknown"] as const;
export type PrMergeable = (typeof PR_MERGEABLE_VALUES)[number];

/** P13-D-28: check-runs roll-up for the PR head sha. Fetched since phase 7 and
 * discarded until this pass — it now feeds the CI pill next to the PR pill. */
export const prChecksSchema = z
  .object({
    total: z.number().int().min(0),
    passing: z.number().int().min(0),
    failing: z.number().int().min(0),
    pending: z.number().int().min(0),
  })
  .loose();
export type PrChecks = z.infer<typeof prChecksSchema>;

export const prRefSchema = z
  .object({
    number: z.number().int().min(1),
    // Tolerant: an unknown string (e.g. a legacy raw GitHub "open") coerces
    // to "review" instead of dropping the whole PR ref — parsers never throw.
    // `pr` is read through tolerant(…, null), so WITHOUT this catch an
    // unknown state nulls the entire ref (number + title + link) and the next
    // write persists that loss back to task.md.
    state: z.enum(PR_STATE_VALUES).catch("review"),
    title: z.string(),
    // P13-D-28: both facts are OPTIONAL keys (`.nullish()`) — an absent key is
    // "never read", which is not the same as "no checks" / "nobody reviewed",
    // and writers omit rather than persist a null so a reconcile pass that
    // learns nothing produces no file churn. `.catch(null)` keeps a hand-edited
    // garbage value from nulling the WHOLE ref (same reasoning as `state`).
    checks: prChecksSchema.nullish().catch(null),
    review: z.enum(PR_REVIEW_VALUES).nullish().catch(null),
    // P14-LV-07: same optional-key convention as `checks`/`review` — an absent
    // key is "never read", which is NOT the same as "merges cleanly".
    mergeable: z.enum(PR_MERGEABLE_VALUES).nullish().catch(null),
    // R17-1 (F17-L12): the PR head is STRICTLY AHEAD of the reviewed/delivered
    // revision — it contains it plus `aheadBy` extra commits pushed after the
    // review. Acceptance still merges an ahead head (owner ruling: keep "ahead"),
    // but the accept/force dialogs, the review-queue subline and the completion
    // record must SURFACE that those extra commits ship unreviewed. Absent when
    // the head equals the reviewed revision (or the drift is unknown). Same
    // optional-key + `.catch(null)` convention as the facts above.
    revisionDrift: z
      .object({
        aheadBy: z.number().int().positive(),
        headSha: z.string().min(1),
      })
      .nullish()
      .catch(null),
  })
  .loose();
export type PrRef = z.infer<typeof prRefSchema>;

/** GitHub projection cache mirrored into the file by the Phase-7
 * reconciler — commits + change stats. Not human-edited truth. */
export const githubCacheSchema = z
  .object({
    commits: z
      .array(z.object({ sha: z.string(), msg: z.string() }).loose())
      .default([]),
    changed: z
      .object({
        files: z.number().int(),
        add: z.number().int(),
        del: z.number().int(),
      })
      .loose()
      .nullable()
      .default(null),
    /** R15-15: a PR found on this task's branch that this task did NOT open —
     *  recorded so the collision is reported once instead of on every poll, and
     *  so the number is visible rather than silently discarded. */
    unownedPr: z.number().int().nullable().optional(),
  })
  .loose();
export type GithubCache = z.infer<typeof githubCacheSchema>;

export const packetObservationSchema = z
  .object({
    k: z.string(),
    v: z.string(),
    code: z.boolean().default(false),
  })
  .loose();
export type PacketObservation = z.infer<typeof packetObservationSchema>;

export const packetOptionSchema = z
  .object({
    kind: z.enum(PACKET_OPTION_KINDS),
    t: z.string().min(1),
    d: z.string().default(""),
    rec: z.boolean().default(false),
    // Acceptance is gated solely on kind === "accept_completion" plus the
    // admin|maintainer re-check in resolvePacket.
    /** Pre-authored timeline text written when this option is chosen. */
    ev: z.string().optional(),
    /** retry_other_backend — the backend to re-run the failed agent on. */
    backend: z.enum(["codex", "claude"]).optional(),
    /** retry_other_backend — a reviewer retry names its profile (the primary
     *  specialist needs none). */
    profileId: z.string().optional(),
    /** archive_task — ALSO delete the task's remote branch when archiving
     *  (discard the rejected work entirely, not just the task's board row).
     *  Resolution refuses it while the PR is still open. */
    deleteBranch: z.boolean().optional(),
  })
  .loose();
export type PacketOption = z.infer<typeof packetOptionSchema>;

export const taskPacketSchema = z
  .object({
    /** F10-09: a stable per-packet id, stamped when a NEW packet is opened. A
     *  resolution captures this (or a content fingerprint when absent) before
     *  its lock and re-checks it inside the lock, so a REPLACEMENT packet opened
     *  in the read→await→lock window can't be resolved by the stale action. */
    id: z.string().optional(),
    type: z.enum(["input", "blocked"]),
    /** Pill label, e.g. "Completion report" | "Blocked decision". */
    kind: z.string().min(1),
    /** Actor ref string — "operator" in every observed packet. */
    from: z.string().default("operator"),
    title: z.string().min(1),
    body: z.string().default(""),
    observations: z.array(packetObservationSchema).default([]),
    options: z.array(packetOptionSchema).default([]),
    /** Set when an `edit_goal` option was confirmed: the packet is decided
     *  and auto-clears when the edited goal lands (updateTaskGoal). */
    awaiting: z.enum(["goal_edit"]).optional(),
    /** R15-14: profileId of the AGENT that raised this question, when one did.
     *  Resolving such a packet resumes that agent's own session with the answer
     *  rather than handing it to the operator to re-engage a cold run. Absent on
     *  operator packets and on anything written before this field existed. */
    askedBy: z.string().optional(),
  })
  .loose();
export type TaskPacket = z.infer<typeof taskPacketSchema>;

// -------------------------------------------- work revision + verdicts (F10-15)

/**
 * The immutable identity of the delivered work currently up for review (F10-15).
 * Minted server-side when a delivering run produces a new head (commit SHA), so
 * a verdict binds to EXACTLY what the reviewer saw. A new head (different tree)
 * mints a new revision id, which automatically makes every prior verdict stale —
 * that is the whole of new-commit invalidation and the fix for the F10-32
 * "rework = a comment or stage bounce" heuristic.
 */
export const workRevisionSchema = z
  .object({
    id: z.string().min(1),
    /** Full commit SHA the reviewers judge (not the abbreviated `git log` form). */
    headSha: z.string().min(1),
    /** Tree SHA — the actual content identity; null when git couldn't resolve it. */
    treeSha: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    createdAt: z.string().min(1),
    /** The delivering engagement's profileId that produced this revision. */
    sourceProfileId: z.string().nullable().default(null),
  })
  .loose();
export type WorkRevision = z.infer<typeof workRevisionSchema>;

export const REVIEW_VERDICT_RESULTS = ["approve", "request_changes"] as const;

/** One reviewing engagement's verdict, bound to the revision it judged (F10-15). */
export const reviewVerdictSchema = z
  .object({
    profileId: z.string().min(1),
    /** The workRevision.id this verdict judged — a verdict on an OLD revision is
     *  automatically stale once a new revision is minted. */
    revisionId: z.string().min(1),
    /** Denormalized head SHA for display/traceability. */
    headSha: z.string().min(1),
    result: z.enum(REVIEW_VERDICT_RESULTS),
    reason: z.string().default(""),
    at: z.string().min(1),
  })
  .loose();
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

// -------------------------------------------------------- frontmatter

/** Strict target shape — what a fully valid task.md frontmatter parses to. */
export const taskFrontmatterSchema = z.object({
  key: z.string().regex(/^[A-Za-z]+-\d+$/),
  title: z.string().min(1),
  stage: z.string().min(1),
  readiness: z.enum(READINESS_VALUES),
  waiting: z.enum(WAITING_VALUES),
  ownerUserId: z.string().nullable(),
  /** Engaged agents (G1): one uniform list; ≤1 entry has delivers: true. */
  engagements: z.array(engagementSchema),
  operator: operatorRefSchema.nullable(),
  /** Pending operator recommendations rendered as one-click action cards. */
  recommendations: z.array(recommendationSchema),
  /** Pending/fired scheduled actions (O-3) — a server-side runner fires them. */
  schedules: z.array(scheduleSchema),
  urgent: z.boolean(),
  /** R14-3: the task was archived — abandoned work, kept for the record.
   *  Archived tasks leave the board's default view and the review queue, keep
   *  their whole timeline, and can be restored. The one honest ending for a task
   *  whose PR was rejected: the acceptance copy told humans to "archive the
   *  task" for a pass while no such thing existed (P14-GV-02). */
  archived: z.boolean(),
  /** DERIVED cache of the review state for the board/pills (F10-15). No longer
   *  written as a source of truth — `deriveValidation` recomputes it from
   *  `workRevision` + `verdicts` + the required-reviewer set on every write. */
  validation: z.enum(VALIDATION_VALUES),
  /** F10-15: the immutable work revision currently under review (or null). */
  workRevision: workRevisionSchema.nullable(),
  /** F10-15: per-engagement verdicts, each bound to the revision it judged. */
  verdicts: z.array(reviewVerdictSchema),
  branch: z.string().nullable(),
  // P13-D-5: `repo` (the task-level repo override) lived here. The override was
  // deleted this pass by owner ruling — one project, one repo — and nothing can
  // write it any more, so the field is gone rather than kept as a permanently
  // null read path. An existing `repo:` line in a task.md is now an UNKNOWN key:
  // preserved verbatim on round-trip, ignored by every resolver.
  pr: prRefSchema.nullable(),
  // R17-2 (F17-L9): the last delivery attempt confirmed the execution branch has
  // NO commits ahead of the default branch — a verified no-change completion (the
  // goal was already satisfied). Acceptance of a `workRevision && !pr` task is
  // normally refused ("deliver the branch & open the PR"); this flag is the ONE
  // signal that turns that refusal into a first-class "Completed — no changes"
  // acceptance that closes to Done without a PR or merge. Set on a delivery's
  // `nothing_to_review` result; cleared the moment a delivery opens a PR.
  noChanges: z.boolean().optional(),
  github: githubCacheSchema.nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Board position within a stage — a sparse rank for drag-to-reorder. Null
   *  falls back to the task-key number (the pre-reorder default order). */
  boardRank: z.number().nullable(),
});
export type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

// ------------------------------------------- review-state derivation (F10-15)

/** The minimal review-relevant slice of the frontmatter (so the helpers are
 *  pure and testable without a full task file). */
type ReviewState = {
  engagements: Engagement[];
  workRevision: WorkRevision | null;
  verdicts: ReviewVerdict[];
};

/** Supporting engagements that are REQUIRED reviewers (verdict-capable). Their
 *  approval of the current revision gates acceptance (F10-15). */
export function requiredReviewers(fm: { engagements: Engagement[] }): Engagement[] {
  return fm.engagements.filter((e) => !e.delivers && e.verdictCapable);
}

/** Verdicts bound to the CURRENT work revision — older ones are stale (F10-32). */
export function currentVerdicts(fm: {
  workRevision: WorkRevision | null;
  verdicts: ReviewVerdict[];
}): ReviewVerdict[] {
  const rev = fm.workRevision;
  if (!rev) return [];
  return fm.verdicts.filter((v) => v.revisionId === rev.id);
}

/** The DERIVED review-state cache written into `validation` (F10-15): failing if
 *  any required reviewer requests changes on the current revision; healthy when
 *  every required reviewer approved it; changed while a revision is under review
 *  with verdicts pending (or no required reviewer); none before delivery. */
export function deriveValidation(
  fm: ReviewState,
): (typeof VALIDATION_VALUES)[number] {
  if (!fm.workRevision) return "none";
  const required = requiredReviewers(fm);
  const cur = currentVerdicts(fm);
  const verdictOf = (profileId: string) =>
    cur.find((v) => v.profileId === profileId)?.result;
  if (required.some((r) => verdictOf(r.profileId) === "request_changes")) {
    return "failing";
  }
  if (
    required.length > 0 &&
    required.every((r) => verdictOf(r.profileId) === "approve")
  ) {
    return "healthy";
  }
  return "changed";
}

/** Why acceptance is blocked on the current revision, or null when allowed. A
 *  task with NO required reviewers and NO revision stays acceptable (planning /
 *  non-repo work); once a revision exists, all required reviewers must approve
 *  it and none may request changes (F10-15). */
export function acceptanceBlockedReason(fm: ReviewState): string | null {
  const required = requiredReviewers(fm);
  if (!fm.workRevision) {
    return required.length > 0
      ? "No reviewed revision yet — nothing for the required reviewers to approve."
      : null;
  }
  const cur = currentVerdicts(fm);
  const verdictOf = (profileId: string) =>
    cur.find((v) => v.profileId === profileId)?.result;
  if (required.some((r) => verdictOf(r.profileId) === "request_changes")) {
    return "This task's latest review requests changes on the current revision — rework and re-review before accepting.";
  }
  const missing = required.filter((r) => verdictOf(r.profileId) !== "approve");
  if (missing.length > 0) {
    return `Waiting on ${missing.length} required reviewer approval${missing.length === 1 ? "" : "s"} of the current revision.`;
  }
  return null;
}

/**
 * P13-D-4 — why a CLOSED-unmerged review PR blocks acceptance, or null.
 *
 * A PR a human closed on GitHub without merging is an out-of-band REJECTION:
 * the work was declined and there is nothing left to merge, so the task can't
 * be "accepted" into Done. Pass-12 NEW-1 put this check inline in
 * `acceptCompletion` only — but two other writers land `stage = done` AND stamp
 * `pr.state`: `resolvePacket`'s inlined `accept_completion` case and
 * `operatorAcceptCompletion`'s full-autonomy branch. Both overwrote a `closed`
 * PR to `accepted` and moved the task to Done; `pr.state` self-heals on the
 * next reconcile poll, but `stage = done` is durable and never reversed.
 *
 * ONE guard, three call sites — a fourth writer to Done must call it too.
 * Shaped like `acceptanceBlockedReason` (reason-or-null) so both gates read the
 * same way at each site.
 */
export function closedPrBlockedReason(
  fm: { pr: PrRef | null },
  taskKey: string,
): string | null {
  if (fm.pr?.state !== "closed") return null;
  return `${taskKey}'s review PR was closed on GitHub without merging — it can't be accepted. Rework and reopen the PR, or archive the task.`;
}

/**
 * P14-LV-07 — why a CONFLICTING review PR blocks acceptance, or null.
 *
 * Accepting a completion MERGES its PR (FR31). A PR whose head conflicts with
 * the base branch cannot be merged by anyone, so accepting it would close the
 * task on a merge that did not happen — live-proven: VM-4 went to Done with
 * `pr.state: accepted` while PR #103 stayed open and conflicting, and the
 * timeline blamed unreachable GitHub / missing credentials. The conflict is a
 * REWORK signal (rebase the branch), not a merge-pending state.
 *
 * `unknown` (GitHub still computing) never blocks — the merge attempt itself is
 * the authority there. Shaped like the other acceptance gates (reason-or-null).
 */
export function conflictingPrBlockedReason(
  fm: { pr: PrRef | null },
  taskKey: string,
): string | null {
  const pr = fm.pr;
  if (!pr || pr.mergeable !== "conflicting") return null;
  if (pr.state === "merged" || pr.state === "closed") return null;
  return `${taskKey}'s review PR #${pr.number} conflicts with the base branch — GitHub can't merge it, so it can't be accepted. Rebase the branch and re-review, or archive the task.`;
}

/**
 * R14-3 (P14-GV-02) — why an ARCHIVED task can't be accepted, or null.
 *
 * Archiving is the terminal disposition for abandoned work (the escape the
 * closed-PR copy has pointed at since pass 13). An archived task is out of the
 * flow: it leaves the board's default view and the review queue, so accepting
 * it into Done would resurrect it through a surface nobody is watching. Restore
 * it first, then accept.
 */
export function archivedTaskBlockedReason(
  fm: { archived: boolean },
  taskKey: string,
): string | null {
  if (!fm.archived) return null;
  return `${taskKey} is archived — restore it before accepting the completion.`;
}

/** Compute the next work revision for a freshly delivered head. A head with the
 *  SAME tree (or same head when the tree is unavailable) as the current revision
 *  is the SAME review subject — no new revision, so prior verdicts are NOT
 *  invalidated (F10-32). Otherwise a NEW revision id is minted, which makes
 *  every prior verdict stale automatically (F10-15 new-commit invalidation). */
export function nextWorkRevision(
  current: WorkRevision | null,
  input: {
    id: string;
    headSha: string;
    treeSha: string | null;
    branch: string | null;
    sourceProfileId: string | null;
    createdAt: string;
  },
): { revision: WorkRevision; changed: boolean } {
  const sameSubject =
    current != null &&
    (input.treeSha != null && current.treeSha != null
      ? current.treeSha === input.treeSha
      : current.headSha === input.headSha);
  if (sameSubject) return { revision: current, changed: false };
  return {
    revision: {
      id: input.id,
      headSha: input.headSha,
      treeSha: input.treeSha,
      branch: input.branch,
      createdAt: input.createdAt,
      sourceProfileId: input.sourceProfileId,
    },
    changed: true,
  };
}

export const TASK_FRONTMATTER_KEYS: readonly (keyof TaskFrontmatter)[] = [
  "key",
  "title",
  "stage",
  "readiness",
  "waiting",
  "ownerUserId",
  "engagements",
  "operator",
  "recommendations",
  "schedules",
  "urgent",
  "archived",
  "validation",
  "workRevision",
  "verdicts",
  "branch",
  // P13-D-5: "repo" deliberately NOT listed — it is an unknown key now, so an
  // existing task.md keeps its line verbatim instead of losing it on rewrite.
  "pr",
  "noChanges",
  "github",
  "createdAt",
  "updatedAt",
  "boardRank",
];

export interface TolerantTaskFrontmatterResult {
  frontmatter: TaskFrontmatter;
  /** Unknown fields, preserved verbatim for round-trip writes. */
  unknown: Record<string, unknown>;
  diagnostics: FileDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs `schema` over `value`; on failure records a diagnostic and returns
 * `fallback`. Absent (undefined) values only diagnose when `required`. */
function tolerant<T>(
  diagnostics: FileDiagnostic[],
  path: string,
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  options: { required?: boolean; severity?: "info" | "warning" } = {},
): T {
  if (value === undefined) {
    if (options.required) {
      const make = options.severity === "info" ? diagInfo : diagWarning;
      diagnostics.push(
        make(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing — using ${JSON.stringify(fallback)}.`,
          path,
        ),
      );
    }
    return fallback;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const make = options.severity === "info" ? diagInfo : diagWarning;
  diagnostics.push(
    make(
      "frontmatter.invalid_field",
      `Frontmatter field \`${path}\` is invalid (${result.error.issues[0]?.message ?? "unparseable"}) — using ${JSON.stringify(fallback)}.`,
      path,
    ),
  );
  return fallback;
}

/**
 * Engagement parsing enforces one row per profile and at most one delivering
 * workspace owner.
 *
 * Legacy absorption (G1): a pre-engagements task.md carries `specialist`
 * (→ the delivering engagement) and `reviewers[]` / `consultants[]` (→ the
 * supporting engagements). Those keys are absorbed here and NOT preserved as
 * unknown — the next write emits `engagements` only. An explicit
 * `engagements:` key always wins; the legacy slots are read only in its
 * absence, so a file carrying both forms is never double-counted.
 */
function parseEngagements(
  diagnostics: FileDiagnostic[],
  data: Record<string, unknown>,
): Engagement[] {
  let engagements: Engagement[];
  if (data.engagements !== undefined) {
    engagements = tolerant(
      diagnostics,
      "engagements",
      data.engagements,
      taskFrontmatterSchema.shape.engagements,
      [],
    );
  } else {
    // Legacy slots → engagements. Each ref is validated independently so one
    // bad reviewer never drops the specialist (or vice versa).
    engagements = [];
    const specialist = tolerant(
      diagnostics,
      "specialist",
      data.specialist,
      agentRefSchema.nullable(),
      null,
    );
    if (specialist)
      engagements.push({ ...specialist, delivers: true, verdictCapable: false });
    // `reviewers` is the current legacy name; `consultants` is the older alias
    // it replaced, so a stale `consultants` never shadows a live `reviewers`.
    const reviewers = tolerant(
      diagnostics,
      "reviewers",
      data.reviewers ?? data.consultants,
      z.array(agentRefSchema),
      [],
    );
    for (const reviewer of reviewers) {
      // A migrated legacy reviewer is not verdict-capable until it carries an
      // explicit report-validation-verdict:direct grant (F10-14).
      engagements.push({ ...reviewer, delivers: false, verdictCapable: false });
    }
  }
  // profileId-uniqueness invariant (defense-in-depth): a profile has at most
  // ONE engagement. A duplicate profileId corrupts run routing (startAgentRun
  // resolves by the FIRST match), so keep the first occurrence and drop the
  // rest — with a diagnostic — whatever produced the duplicate (a hand edit or
  // a missed write path).
  const seenProfiles = new Set<string>();
  const deduped: Engagement[] = [];
  for (const engagement of engagements) {
    if (seenProfiles.has(engagement.profileId)) {
      diagnostics.push(
        diagWarning(
          "frontmatter.duplicate_engagement",
          `Profile \`${engagement.profileId}\` is engaged more than once — only the first engagement is kept.`,
          "engagements",
        ),
      );
      continue;
    }
    seenProfiles.add(engagement.profileId);
    deduped.push(engagement);
  }
  let sawDeliverer = false;
  for (const engagement of deduped) {
    if (!engagement.delivers) continue;
    if (!sawDeliverer) {
      sawDeliverer = true;
      continue;
    }
    diagnostics.push(
      diagWarning(
        "frontmatter.multiple_deliverers",
        `Engagement \`${engagement.profileId}\` also claims delivers — only the first delivering engagement owns the workspace; this one was demoted.`,
        "engagements",
      ),
    );
    engagement.delivers = false;
  }
  return deduped;
}

/**
 * Tolerant frontmatter parse. `fallbackKey` (the task directory name) rescues
 * files whose `key` field is missing/invalid.
 */
export function parseTaskFrontmatter(
  raw: unknown,
  context: { fallbackKey?: string } = {},
): TolerantTaskFrontmatterResult {
  const diagnostics: FileDiagnostic[] = [];
  const data: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    diagnostics.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping — all fields fall back to defaults.",
        undefined,
        true,
      ),
    );
  }

  // key — identity; unidentifiable without a directory-name fallback.
  let key: string;
  const keyResult = taskFrontmatterSchema.shape.key.safeParse(data.key);
  if (keyResult.success) {
    key = keyResult.data;
    if (context.fallbackKey && key !== context.fallbackKey) {
      diagnostics.push(
        diagError(
          "frontmatter.key_mismatch",
          `Frontmatter key \`${key}\` does not match the task directory \`${context.fallbackKey}\` — the directory name wins.`,
          "key",
        ),
      );
      key = context.fallbackKey;
    }
  } else if (context.fallbackKey) {
    key = context.fallbackKey;
    diagnostics.push(
      diagWarning(
        "frontmatter.missing_key",
        `Frontmatter has no valid \`key\` — inferred \`${key}\` from the task directory.`,
        "key",
      ),
    );
  } else {
    key = "UNKNOWN-0";
    diagnostics.push(
      diagError(
        "frontmatter.missing_key",
        "Frontmatter has no valid `key` and no directory fallback — the task cannot be identified.",
        "key",
        true,
      ),
    );
  }

  // stage — the board column. A missing or unparseable stage must NOT be
  // silently invented as a real stage id: the old hardcoded `triage` fallback
  // relocated the card to a different board column (wrong for a task that was in
  // e.g. `review`) and was meaningless for a project without a `triage` stage.
  // Fall back to a BLANK marker + an `unresolved_stage` warning instead. The
  // blank stage matches no project column, so the projection lands the card in
  // the board's orphan ("unknown stage") bucket rather than moving it, and both
  // this warning and the projection's `reference.unknown_stage` floor readiness
  // to input_required so it surfaces. (Resolving a blank stage to the project's
  // first / last-known stage would need the project's stage list and belongs to
  // the projection layer, not this context-free parser.)
  let stage: string;
  const stageResult = taskFrontmatterSchema.shape.stage.safeParse(data.stage);
  if (stageResult.success) {
    stage = stageResult.data;
  } else {
    stage = "";
    diagnostics.push(
      diagWarning(
        "frontmatter.unresolved_stage",
        data.stage === undefined
          ? "Frontmatter field `stage` is missing — the task's stage is unresolved (shown as an unknown stage) until it is set."
          : `Frontmatter field \`stage\` is invalid (${stageResult.error.issues[0]?.message ?? "unparseable"}) — the task's stage is unresolved (shown as an unknown stage) until it is corrected.`,
        "stage",
      ),
    );
  }

  const frontmatter: TaskFrontmatter = {
    key,
    title: tolerant(
      diagnostics,
      "title",
      data.title,
      taskFrontmatterSchema.shape.title,
      key,
      { required: true },
    ),
    stage,
    readiness: tolerant(
      diagnostics,
      "readiness",
      data.readiness,
      z.enum(READINESS_VALUES),
      "ready",
      { required: true },
    ),
    waiting: tolerant(
      diagnostics,
      "waiting",
      data.waiting,
      z.enum(WAITING_VALUES),
      "none",
      { required: true },
    ),
    ownerUserId: tolerant(
      diagnostics,
      "ownerUserId",
      data.ownerUserId,
      taskFrontmatterSchema.shape.ownerUserId,
      null,
    ),
    engagements: parseEngagements(diagnostics, data),
    operator: tolerant(
      diagnostics,
      "operator",
      data.operator,
      taskFrontmatterSchema.shape.operator,
      null,
    ),
    recommendations: tolerant(
      diagnostics,
      "recommendations",
      data.recommendations,
      taskFrontmatterSchema.shape.recommendations,
      [],
    ),
    // schedules — absent on tasks that predate O-3 → empty, silently (mirrors
    // recommendations: a missing optional array is not a diagnostic).
    schedules: tolerant(
      diagnostics,
      "schedules",
      data.schedules,
      taskFrontmatterSchema.shape.schedules,
      [],
    ),
    // urgent is an optional boolean by contract — absent means false, silently.
    urgent: tolerant(
      diagnostics,
      "urgent",
      data.urgent,
      taskFrontmatterSchema.shape.urgent,
      false,
    ),
    // archived, likewise: absent means "not archived" and is not a diagnostic.
    archived: tolerant(
      diagnostics,
      "archived",
      data.archived,
      taskFrontmatterSchema.shape.archived,
      false,
    ),
    validation: tolerant(
      diagnostics,
      "validation",
      data.validation,
      z.enum(VALIDATION_VALUES),
      "none",
      { required: true, severity: "info" },
    ),
    workRevision: tolerant(
      diagnostics,
      "workRevision",
      data.workRevision,
      taskFrontmatterSchema.shape.workRevision,
      null,
    ),
    verdicts: tolerant(
      diagnostics,
      "verdicts",
      data.verdicts,
      taskFrontmatterSchema.shape.verdicts,
      [],
    ),
    branch: tolerant(
      diagnostics,
      "branch",
      data.branch,
      taskFrontmatterSchema.shape.branch,
      null,
    ),
    // P13-D-5: no `repo` read — the task-level override is gone.
    pr: tolerant(diagnostics, "pr", data.pr, taskFrontmatterSchema.shape.pr, null),
    // R17-2: absent means "not a no-change completion" — never a diagnostic.
    noChanges: tolerant(
      diagnostics,
      "noChanges",
      data.noChanges,
      taskFrontmatterSchema.shape.noChanges,
      undefined,
    ),
    github: tolerant(
      diagnostics,
      "github",
      data.github,
      taskFrontmatterSchema.shape.github,
      null,
    ),
    createdAt: tolerant(
      diagnostics,
      "createdAt",
      data.createdAt,
      taskFrontmatterSchema.shape.createdAt,
      null,
    ),
    updatedAt: tolerant(
      diagnostics,
      "updatedAt",
      data.updatedAt,
      taskFrontmatterSchema.shape.updatedAt,
      null,
    ),
    boardRank: tolerant(
      diagnostics,
      "boardRank",
      data.boardRank,
      taskFrontmatterSchema.shape.boardRank,
      null,
    ),
  };

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    // Legacy engagement slots (`specialist`/`reviewers` and the older
    // `consultants` alias) are absorbed into `engagements` above; don't
    // preserve them as "unknown" or a rewrite would emit both forms.
    if (k === "consultants" || k === "specialist" || k === "reviewers") continue;
    if (!(TASK_FRONTMATTER_KEYS as readonly string[]).includes(k)) {
      unknown[k] = v;
    }
  }

  return { frontmatter, unknown, diagnostics };
}

/** Tolerant packet parse (the fenced yaml block under `## Packet`). Returns
 * null + diagnostics when the block cannot be salvaged. */
export function parseTaskPacket(raw: unknown): {
  packet: TaskPacket | null;
  diagnostics: FileDiagnostic[];
} {
  if (raw === undefined || raw === null) return { packet: null, diagnostics: [] };
  const result = taskPacketSchema.safeParse(raw);
  if (result.success) {
    const diagnostics: FileDiagnostic[] = [];
    const recCount = result.data.options.filter((o) => o.rec).length;
    if (result.data.options.length > 0 && recCount !== 1) {
      diagnostics.push(
        diagInfo(
          "packet.rec_count",
          `Packet has ${recCount} recommended options (expected exactly 1).`,
          "packet.options",
        ),
      );
    }
    return { packet: result.data, diagnostics };
  }
  const issue = result.error.issues[0];
  return {
    packet: null,
    diagnostics: [
      diagError(
        "packet.invalid",
        `Packet block is invalid at \`${issue?.path.join(".") || "packet"}\` (${issue?.message ?? "unparseable"}) — packet ignored.`,
        "packet",
      ),
    ],
  };
}

// ------------------------------------------------------- actor refs

/**
 * Actor reference variants as encoded in files (contracts §3.1):
 *   humans   →  user:<userId> (Optional Display Name)
 *   agents   →  agent:<backend>/<profileId> (Optional Role Snapshot)
 *   operator →  operator
 *   system   →  system:<id>            (only "system:policy-engine" observed)
 *
 * AGENT IDENTITY (generic-agents plan D7, 2026-07-19): the profile id is the
 * identity — never the role string. VIB-12 proved role-slug identity is a
 * fragility class: prose-derived slugs drift, punctuation broke decoding, and
 * a failed decode silently DROPPED the event. The parenthesized role snapshot
 * mirrors the human nameHint: display fallback when the profile is gone.
 * Legacy `agent:<backend>/<role-slug>` refs (no parens) decode with the slug
 * as `profileId` and a null roleHint — display falls back to un-slugging,
 * which renders legacy refs exactly as before.
 *
 * `unknown` (tolerance): an unrecognized actor ref no longer drops its event
 * (the VIB-12 failure shape) — it parses to `{ kind: "unknown", raw }` and
 * re-serializes VERBATIM, so unrecognized authors round-trip losslessly.
 */
export type FileActorRef =
  | { kind: "human"; userId: string; nameHint: string | null }
  | {
      kind: "agent";
      backend: "codex" | "claude";
      profileId: string;
      /** Role display snapshot at write time; null on legacy refs. */
      roleHint: string | null;
    }
  | { kind: "operator" }
  | { kind: "system"; systemId: string }
  | { kind: "unknown"; raw: string };

// -------------------------------------------------- timeline events

/**
 * P13-D-26 — one `evidence:` row on a completion/verdict event.
 *
 * A REFERENCE, never a dump: `label` names what was produced or checked
 * (a suite, a changed-file summary, a revision), `add`/`del` are short signed
 * display strings ("+14", "−4"). This deliberately complements the
 * `evidence-separation` guardrail (comment-guardrails.server.ts), which trims
 * raw fenced output out of the prose and points at the run logs — the rows
 * carry the citation the guardrail leaves behind, not the noise it removed.
 */
export interface EvidenceRow {
  label: string;
  add: string;
  del: string;
}

/** Row/field caps. The rows are serialized into task.md and re-read into every
 *  agent prompt, so they stay small by construction. */
export const EVIDENCE_MAX_ROWS = 8;
const EVIDENCE_LABEL_MAX_CHARS = 120;
const EVIDENCE_COUNT_MAX_CHARS = 16;

/**
 * Placeholder for a count column with nothing to report. A row serializes as
 * ONE line, `- <label> · <add> · <del>`, and the parser trims the line before
 * splitting — so a trailing EMPTY column is not just blank on the way back, it
 * collapses the row to two segments and the parser drops it as malformed. Every
 * column therefore carries at least this glyph. (Caught by the round-trip test,
 * not by inspection.)
 */
export const EVIDENCE_EMPTY_COLUMN = "—";

/**
 * Sanitize agent- or server-supplied evidence into rows that round-trip through
 * the task.md serializer. Each row is ONE line of the form
 * `- <label> · <add> · <del>`, so a newline anywhere would forge a row and a
 * ` · ` inside `add`/`del` would shift the columns (the parser pops the LAST
 * two segments, so a separator in the label is harmless and is kept).
 * Returns null when nothing usable survives — the caller writes `evidence: null`.
 */
export function normalizeEvidenceRows(
  rows: readonly { label?: unknown; add?: unknown; del?: unknown }[] | null | undefined,
): EvidenceRow[] | null {
  if (!rows || rows.length === 0) return null;
  const flat = (v: unknown, max: number, stripSeparator: boolean): string => {
    let s = typeof v === "string" ? v : v == null ? "" : String(v);
    s = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (stripSeparator) s = s.split(" · ").join(" ").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const out: EvidenceRow[] = [];
  for (const row of rows) {
    const label = flat(row.label, EVIDENCE_LABEL_MAX_CHARS, false);
    if (!label) continue; // an unlabeled row cites nothing
    const column = (v: unknown) =>
      flat(v, EVIDENCE_COUNT_MAX_CHARS, true) || EVIDENCE_EMPTY_COLUMN;
    out.push({ label, add: column(row.add), del: column(row.del) });
    if (out.length >= EVIDENCE_MAX_ROWS) break;
  }
  return out.length > 0 ? out : null;
}

/** One parsed `###` timeline entry. Newest-first in the file and here. */
export interface TaskFileEvent {
  /** UTC ISO 8601. */
  occurredAt: string;
  /** One of TIMELINE_EVENT_TYPES, or an unknown string kept tolerantly. */
  type: string;
  actor: FileActorRef;
  /** Completion events only ("Completion report" | "Completion accepted"). */
  title: string | null;
  /** RichText micro-format: **bold**, `code`, @mention. */
  text: string;
  /** Comments only — routed to the operator/agent (toagent card tint). */
  toAgent: boolean;
  /** Completion/verdict events only. add/del are signed display strings ("+14"). */
  evidence: EvidenceRow[] | null;
}

/** Full parsed task file (see app/server/files/task-file.server.ts). */
export interface ParsedTaskFile {
  frontmatter: TaskFrontmatter;
  unknownFrontmatter: Record<string, unknown>;
  goal: string;
  packet: TaskPacket | null;
  /** Newest first. */
  timeline: TaskFileEvent[];
  /** Unrecognized `## Section` blocks, preserved verbatim in order. */
  extraSections: { title: string; raw: string }[];
}
