import { z } from "zod";
import {
  diagError,
  diagInfo,
  diagWarning,
  tolerantRowsOf,
  type FileDiagnostic,
} from "./file-diagnostics";
import { canonicalDependencyRef } from "~/shared/dependencies";
import type { RevisionDrift } from "~/shared/revision-drift";

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

// Ruling 225 (F37-45): `schedule` is a DERIVED display value, produced only by
// the projection (`rebuildPath`) when a task is resting on a clock rather than
// on a person — `waiting: human` in the file, no packet, no recommendation,
// nothing a human could accept, and a pending schedule occurrence that will
// pick the task back up on its own. It is never hand-authored and never
// written to a task file, exactly like `validation: "bypassed"` below; it is a
// member of the enum because it rides the same projected column, and the
// round-trip that reads that column back must accept it.
export const WAITING_VALUES = ["human", "agent", "none", "schedule"] as const;
export type Waiting = (typeof WAITING_VALUES)[number];

// N20-14 (§5c / C2): `bypassed` is a DERIVED display value produced only by
// `deriveValidation` when a task carries the durable `acceptance: "forced"`
// fact — a human accepted the completion past the verdict gate. It is not a
// hand-authored source value (like the other four), but it rides the same
// `validation` field the projection caches, so it must be a first-class member
// of the enum for the round-trip and the derivation return type.
export const VALIDATION_VALUES = ["healthy", "changed", "failing", "none", "bypassed"] as const;

/** Task priority (pass-25 feature). Replaces the old boolean `urgent` with a
 *  graded scale: "urgent" is the top rung (the board still highlights it). */
export const PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof PRIORITY_VALUES)[number];
export type Validation = (typeof VALIDATION_VALUES)[number];

/** Narrow an arbitrary string to a `TaskPriority`, or `undefined` when it is not
 *  one. The SINGLE place the priority cast lives — every UI/route boundary
 *  parses form input through here instead of asserting the type itself. */
export function coercePriority(value: string): TaskPriority | undefined {
  // SAFETY: the membership test proves `value` is one of PRIORITY_VALUES, so
  // the assertion only states to the compiler what the runtime check just
  // established.
  return (PRIORITY_VALUES as readonly string[]).includes(value)
    ? (value as TaskPriority)
    : undefined;
}

/** Freeform-label bounds — the card can only show a handful before it blows out
 *  the column, and an unbounded label is a denial-of-service on the layout. */
export const MAX_TASK_LABELS = 12;
export const MAX_LABEL_LENGTH = 32;

/** Trim, collapse inner whitespace, cap length, drop empties, dedupe
 *  case-insensitively (order preserved), cap count. Shared by the server action
 *  and the create path so a label set means the same thing however it entered. */
export function normalizeTaskLabels(labels: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const l = raw.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
    if (!l) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= MAX_TASK_LABELS) break;
  }
  return out;
}

/** A due date is a plain `YYYY-MM-DD` calendar date (no timezone). Rejects
 *  malformed strings AND impossible dates (2026-02-31). */
export function isValidDueDate(due: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  const [y, m, d] = due.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** The 11 timeline event types (cross-cutting contracts §1.3). Parsers keep
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
  // pass20 F20-6: 10th packet kind (decisions.md ruling 7 — count already updated by C-DOCS)
  // Discard the task's LOCAL, never-pushed workspace branch — cleanup, not a
  // disposition: the task stays on the board and closes through the ordinary
  // no-change acceptance. Refuses when the branch exists on the remote (remote
  // deletion stays ruling 17's archive-packet path). Resolution enforces
  // `approve-transition` (it destroys commits). Ruling 161 (pass 35, G35-6):
  // a revision the agent REPORTED but never pushed does not block the offer
  // (authoring keys on `revisionLeftWorkspace`), and the discard retires that
  // revision (`workRevision.kind: discarded`) with the branch.
  "discard_branch",
  // pass31 F31-6: the remedy for a task-key BRANCH COLLISION — the remote holds
  // an unrelated branch (usually with an unowned PR) under this task's branch
  // name, so the delivery push conflicts. Confirming closes the recorded
  // unowned PR (when one exists), deletes the stale REMOTE branch, and
  // re-delivers this task's local work so its real review PR opens. The LOCAL
  // delivery is kept — this is the exact opposite of `discard_branch`, which
  // is why authoring refuses to offer discard on a delivered/occupied branch.
  // Resolution enforces `approve-transition` (it deletes a remote ref).
  "resolve_remote_collision",
  // Ruling 164 (pass 35, F35-14): the admin acceptance override, as a packet
  // option. The resolution runs `forceAcceptCompletion` — the same path, the
  // same disclosure and the same audited bypass record as the task page's
  // Force accept button — and refuses a non-admin with that button's own
  // sentence. Before it, an operator could only write the promise as a `custom`
  // option title ("Force-accept as admin without a fresh verdict", KNC-3), whose
  // resolution re-ran the operator into a no-op behind the verdict gate.
  "force_accept",
  // Ruling 164 (pass 35, F35-14): a manual board move to the option's own
  // `toStage`, performed through `transitionStage({ manual: true })` — the same
  // path as the task page's stage picker, with the same `approve-transition`
  // tier and the same transition event and audit row. Before it, "Move KNC-16
  // back to Review" was a `redirect` title and the resolution moved nothing.
  "move_stage",
  // Ruling 224 (pass 37, F37-44): the remedy a SPENT USAGE WINDOW actually has
  // — wait, and resume by itself when the window reopens. Payload: `dueAt`
  // (the provider's own reset instant) plus `profileId` for the agent to
  // re-dispatch. Resolution closes the packet and writes a `run-agent` schedule
  // for that instant, which the existing runner fires unattended. Before it,
  // every option on a quota packet was wrong at the moment it was offered: the
  // recommended one permanently moved the task off the model its profile
  // declares, and the alternative asked the human to ASSERT a window had reset
  // when the provider had just said it would not for another three hours.
  "wait_for_window",
  // Ruling 226 (pass 37, F37-43): the deliberate way past a head GitHub would
  // not compare. NOT `force_accept`, which cannot bypass the head gate and must
  // not start: this waives ONE check, for ONE (PR, delivered revision, live
  // head) triple, with the person's name on it and the consequence stated. The
  // resolution records that triple as `headCheckWaiver`; the gate honours it
  // only while all three still match, so it cannot be spent on a head that
  // moved afterwards.
  "accept_unverified_head",
  // Ruling 230 (pass 37, F37-50): "hold this until those land". Payload:
  // `blockedBy`, the tasks or goal links this one waits on. Resolution writes
  // ruling 131's dependency list, which the board renders, the schedule runner
  // refuses on, and the dependency release re-triggers automatically when the
  // last entry finishes. The mechanism was already there and good; the only
  // thing missing was a way to reach it from the surface where the decision is
  // actually made, so an operator wanting a hold reached for `block_on_policy`
  // — whose resolution UNBLOCKS — and the record said "SHOP-11 is unblocked"
  // under an option titled "Hold SHOP-11 while…".
  "block_on_dependencies",
  // Ruling 237 (pass 37, F37-57): "ask the reviewer what it would still block
  // on, before anyone reworks anything". Payload: `profileId`, the reviewer to
  // put the question to. Resolution closes the packet and starts THAT reviewer
  // with the question as its directive and its own non-delivering posture
  // intact. Ruling 210 already named this as the move at a second consecutive
  // objection, and wrote it as a paragraph in the operator's turn instruction:
  // live on SHOP-5 the operator read it and re-dispatched the deliverer forty
  // six seconds after the third `request_changes` anyway. An option whose
  // resolution merely re-runs the operator would have repeated that; this one
  // starts the reviewer itself.
  "question_reviewer",
  // Ruling 269 (pass 37, F37-101): "this belongs in its own task." The most
  // common structural remedy on a multi-service board, and the only one whose
  // recommended option had to end with an instruction to the reader instead of
  // an action. Live on SHOP-26 the operator wrote, verbatim, "You create the
  // task — no option here can": it had found a published contract with no
  // producer, the project's own conventions say a reported gap has to end up
  // owned by a live task, and the packet mechanism could not make one. Payload:
  // `newTask` (title, goal, and optionally what it waits on and its labels).
  // Resolution creates it through `createTask` — the same door the board and
  // the toolkits use — under the RESOLVING person's authority, and names the
  // new key on both timelines so the two are joined on the record.
  "create_task",
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
    /** F27-B1: a STUCK retry backend pin, carried from the engagement so the
     *  exec-profile display shows what a run will ACTUALLY use — the pinned
     *  backend, not the live profile primary the display otherwise overlays. */
    pinnedBackend: z.enum(["codex", "claude"]).nullable().optional(),
    /** U35-5 (pass 35): the engagement's verdict snapshot, carried from the
     *  engagement the projection stringified (`supportingEngagements`, which
     *  keeps the whole engagement) so the review queue can tell a REQUIRED
     *  reviewer from a supporting agent without re-reading the task file.
     *  Optional at the type level because a hand-built ref (the engage paths
     *  in specialist-run.server.ts) writes the flag on the engagement, not on
     *  the ref; a reader treats absence as "not verdict-capable". */
    verdictCapable: z.boolean().optional(),
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
    /** F27-B1 (owner ruling 2026-08-24): a deliberate backend switch that STICKS.
     *  A `retry_other_backend` recovery sets this to the target backend, and later
     *  runs of THIS engagement resolve to it OVER the live profile's primary — so a
     *  task the operator moved to Codex because Claude was quota-failing keeps using
     *  Codex on the next operator prompt / @mention, instead of reverting to the
     *  profile's Claude. Absent/null (the common case) leaves the "a run follows the
     *  live profile" rule intact, so an ADMIN's profile-backend change still takes
     *  effect on the next run — the retry pin and a profile edit stay distinct. */
    pinnedBackend: z.enum(["codex", "claude"]).nullable().optional(),
    /**
     * Ruling 421 (F39-43): the run this engagement is answering the
     * completeness question in. Ruling 410 has the operator ask a reviewer
     * that keeps objecting for EVERYTHING it would still block on, and every
     * operator on ax-clone folded that question into the review that follows
     * a rework. Nothing recorded that it had, so three deadlock packets in 25
     * minutes recommended asking again the question the very verdict they
     * escalated had answered. The dispatch that puts the question stamps it
     * here with its run id; the verdict THAT run returns is recorded as the
     * answer (`ReviewVerdict.answers`) and consumes it. Keyed by run, so a
     * stamp a later run did not carry can never attach to that run's verdict.
     */
    question: z
      .object({
        kind: z.literal("completeness"),
        runId: z.string().min(1),
        at: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .loose();
export type Engagement = z.infer<typeof engagementSchema>;

/** The single delivering engagement (workspace/branch/PR owner), if any. */
export function deliveringEngagement(fm: {
  engagements: Engagement[];
}): Engagement | null {
  return fm.engagements.find((e) => e.delivers) ?? null;
}

/**
 * Ruling 193, as amended by ruling 204: successive OBJECTIONS `profileId` has
 * raised, newest first, stopping at its first `approve` (or at the start of its
 * history).
 *
 * ROUNDS are summed, not revisions. Ruling 193 counted distinct revisions on
 * the reasoning that "a reviewer re-run twice on the same revision has objected
 * once" — and live on SHOP-9 that was exactly backwards: in a deadlock the
 * deliverer commits nothing, so no new revision is ever minted and the count sat
 * at 1 while the loop ran. The distinction 193 was reaching for survives in the
 * `rounds` field itself, which the verdict upsert increments only when a
 * completed review returns the SAME result again; a re-DISPATCH that records no
 * verdict still counts for nothing.
 */
export function consecutiveRequestChanges(
  fm: { verdicts: readonly ReviewVerdict[] },
  profileId: string,
): number {
  const mine = fm.verdicts.filter((v) => v.profileId === profileId);
  let rounds = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const v = mine[i]!;
    if (v.result !== "request_changes") break;
    // Ruling 204: ROUNDS, not distinct revisions. Live on SHOP-9 the Integration
    // Verifier blocked the same revision twice — the deliverer had nothing it
    // was allowed to change, because the blocker was another task's work — and
    // the old count read 1, so the doctrine that exists to put exactly that
    // deadlock in front of a human could not see it. The counter was keyed on
    // the one signal that STOPS MOVING when the work gets stuck.
    rounds += v.rounds;
  }
  return rounds;
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
  "transition",
  // Dynamic-dispatch rework (2026-08-29): the four slot-shaped kinds
  // (`assign_specialist` / `assign_reviewer` / `run_specialist` /
  // `run_reviewer`) collapsed into ONE. Under `recommend` autonomy the operator
  // can't dispatch runs itself, so it recommends RUNNING a chosen deployed
  // agent with a directive — an actionable card a maintainer applies with one
  // click. Applying it dispatches the agent exactly as the manual run-agent
  // control would (engage-if-needed, posture from capability grants).
  "run_agent",
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
    /** run_agent — the deployed agent to dispatch. */
    profileId: z.string().optional(),
    /** run_agent — the directive the operator wants the run to follow. */
    prompt: z.string().optional(),
    /** run_agent — the operator's EXPLICIT posture hint, persisted so Apply
     *  dispatches what was recommended (hunt 2026-08-29: the recommend arm
     *  announced "as a supporting agent" and then dropped the hint, so Apply
     *  re-derived the posture and could install the opposite one). Absent =
     *  no hint (Apply derives, exactly like a hint-less dispatch). */
    delivers: z.boolean().optional(),
    /** run_agent — ruling 421: the recommended run puts the completeness
     *  question, so Apply stamps it exactly as a direct dispatch would. */
    completeness: z.boolean().optional(),
    /** transition — the target stage id. */
    toStageId: z.string().optional(),
    /** Button label, e.g. "Run Developer". */
    label: z.string().min(1),
    /** The operator's reasoning for the recommendation (rendered under it). */
    detail: z.string().default(""),
    /** accept_completion — ruling 137 (pass 34, F34-15): the work revision the
     *  offer was authored against (`workRevision.headSha`). The card renders
     *  "for revision <sha7>", and `withdrawAcceptanceOffers` removes the card
     *  when that revision is replaced or the task's decision state changes.
     *  Absent on the other kinds and on cards written before this field. */
    forHeadSha: z.string().optional(),
  })
  .loose();
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * A governed SCHEDULED action on a task (O-3): a human schedules a future run
 * — an operator re-run ("re-check this not-yet-Done task in 24h") or, since the
 * dynamic-dispatch rework (2026-08-29), a specific agent's run with a prompt.
 * Canonical in the task file so it survives a projection rebuild; a server-side
 * runner fires due entries (server-side → backend-agnostic, works for Claude
 * AND Codex, no per-backend agent tool). Never fires on a terminal (Done) task.
 */
export const SCHEDULE_ACTION_TYPES = ["run-operator", "run-agent"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTION_TYPES)[number];

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

/**
 * Ruling 241 (pass 37, F37-68): a question put to a reviewer that a DEPENDENCY
 * HOLD refuses right now, kept until the hold lifts.
 *
 * Ruling 237's escalation recommends asking the reviewer to name everything it
 * would still block on. Ruling 186 refuses every agent dispatch on a held task
 * ("Every dispatch door lands here, so every one of them refuses"), and ruling
 * 237 added a dispatch door without checking. Live on SHOP-5 the person chose
 * the recommended option, the decision was written onto the task contract, the
 * packet was cleared, and the reviewer was never asked: the one option that
 * could end the loop consumed the decision and did nothing.
 *
 * The owner's call was QUEUE, not refuse: the question survives the wait and is
 * put the moment the task can run again. `announceRelease` is the one release
 * chokepoint, so the drain has exactly one home.
 */
export const queuedQuestionSchema = z
  .object({
    id: z.string().min(1),
    /** The reviewer the question is for. Resolved against the LIVE engagement
     *  at drain time, the same R22 rule the schedule's `profileId` follows. */
    profileId: z.string().min(1),
    /** The question itself, stored rather than rebuilt: a person was promised
     *  this text (ruling 237 wrote it down for that reason), and the wait can
     *  outlive the constant. */
    directive: z.string().min(1),
    /** Who decided, for the run's `directiveFrom` and for the record. */
    decidedBy: z.string().min(1),
    decidedByLabel: z.string().min(1),
    decidedAt: z.string().min(1),
    /** What the task waited on when the question was queued, so the drain note
     *  can say what it was waiting for. */
    heldBy: z.array(z.string()).default([]),
  })
  .loose();
export type QueuedQuestion = z.infer<typeof queuedQuestionSchema>;

export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(SCHEDULE_ACTION_TYPES),
    /** ISO timestamp; the runner fires the entry once now >= dueAt. */
    dueAt: z.string().min(1),
    // R22 (owner ruling 2026-08-21, supersedes FR39's per-schedule pin): a
    // scheduled re-run no longer pins a backend or autonomy. It resolves the
    // LIVE deployed operator profile at fire time — the same rule R21-9 gave the
    // manual run control ("the card shows, doesn't pick"). A schedule fires
    // unattended, so following the profile that is actually deployed then
    // matters MORE than freezing whatever was configured hours earlier (it was
    // also the temporal twin of the #183 stale-backend-display bug). `.loose()`
    // ignores the `backend`/`autonomy` keys any pre-ruling entry still carries.
    /** `run-agent` only: the deployed agent to dispatch when the entry fires.
     *  The profile ID is the pin (identity); backend/model/capabilities resolve
     *  from the LIVE deployment at fire time, the same R22 rule as the operator
     *  arm. Null for `run-operator`. */
    profileId: z.string().nullable().default(null),
    /** The run's instruction: the operator steer, or the dispatched agent's
     *  directive. Rides into the fired run so it knows WHY it exists (B-WF3). */
    prompt: z.string().default(""),
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
/** Ruling 236: the cap on `pr.paths.changed`. A PR touching more files than
 *  this records the first `PR_PATHS_MAX` and sets `truncated`, which the
 *  overlap read treats as "this list may be short" rather than as the whole
 *  diff. Chosen to cover any review-sized change while bounding what a
 *  hand-edited file can put in memory. */
export const PR_PATHS_MAX = 300;

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
    // Ruling 360 (pass 38, F38-14): the last REFUSED check-runs read for this
    // PR, kept only while `checks` has never been read. An absent `checks`
    // beside this key means "GitHub would not let this credential read them" —
    // which is neither "never looked" nor "no CI", and every human surface
    // rendered all three as silence. Dropped by the first read that succeeds.
    checksUnread: z
      .object({
        status: z.number().int().nullable(),
        message: z.string(),
        at: z.string(),
      })
      .nullish()
      .catch(null),
    review: z.enum(PR_REVIEW_VALUES).nullish().catch(null),
    // P14-LV-07: same optional-key convention as `checks`/`review` — an absent
    // key is "never read", which is NOT the same as "merges cleanly".
    mergeable: z.enum(PR_MERGEABLE_VALUES).nullish().catch(null),
    // Ruling 405 (F39-32): the head `mergeable` was MEASURED on. GitHub
    // recomputes mergeability asynchronously, so the read right after a push
    // answers "unknown" and the reconciler keeps the last-known verdict for
    // the same PR -- a rule written for an unread value, applied to a PR whose
    // head has moved underneath it. Live on ax-clone AX-18: the operator
    // resolved the conflict, pushed `d44e874`, and was refused the transition
    // twice on a `conflicting` measured at `5ae0752`, the commit it had just
    // superseded. `paths` has carried this pin since ruling 236 ("a list read
    // for a DIFFERENT head than the one now live is dropped rather than shown
    // stale"); the verdict that BLOCKS had none. Absent = never measured.
    mergeableAt: z.string().min(1).nullish().catch(null),
    // Ruling 236 (owner, 2026-09-14): the repository paths this PR changes, so
    // the review queue can say which OTHER open PRs a merge would put into
    // conflict before a person finds out by pressing Accept. Pinned to the head
    // it was read at, because a file list cannot change without the head moving
    // — that pin is what lets the fetch be skipped on every tick where it did
    // not. `truncated` is honest about the cap rather than silently short: an
    // overlap computed from a clipped list can only MISS a collision, never
    // invent one, and a surface that shows it must say which it is.
    // Same optional-key convention as everything above: absent = never read.
    paths: z
      .object({
        headSha: z.string().min(1),
        changed: z.array(z.string().min(1)).max(PR_PATHS_MAX),
        truncated: z.boolean(),
      })
      .nullish()
      .catch(null),
    // Ruling 135 (pass 34, F34-11): the PR's head sha as GitHub last reported
    // it. Absent = never read (the same optional-key convention as the facts
    // above); carried forward by the reconciler and by a PR reuse; never
    // inherited by a DIFFERENT PR number.
    headSha: z.string().min(1).nullish().catch(null),
    // R17-1 (F17-L12) as amended by ruling 132 (pass 34, F34-14): drift is the
    // number of AUTHORED commits since the reviewed revision, with a base
    // refresh Viberr itself made reported SEPARATELY and never as unreviewed
    // work. `describeRevisionDrift` (app/shared/revision-drift.ts) is the ONE
    // sentence every surface prints. Absent when the head equals the reviewed
    // revision (or the drift was never measured). `merges` is `.min(0)`, not
    // positive: `update_branch_from_base` runs a plain `git merge`, and a
    // strictly-behind branch FAST-FORWARDS with zero merge commits.
    revisionDrift: z
      .object({
        headSha: z.string().min(1),
        authored: z.number().int().min(0),
        baseRefresh: z
          .object({
            merges: z.number().int().min(0),
            commits: z.number().int().min(0),
          })
          .nullable(),
      })
      .nullish()
      .catch(null),
    // Ruling 135 (pass 34, F34-11): the DELIVERED revision is not on the pull
    // request. `behind` — origin's copy is an ancestor, a plain push
    // fast-forwards; `diverged` — origin holds commits this workspace does not,
    // a push is refused non-fast-forward; `unknown` — GitHub does not have the
    // revision at all (a never-pushed sha: the compare answers `missing_ref` and
    // a direct commit read 404s). Written by the reconciler AND by the workspace
    // reconcile the moment a delivering run mints a new revision on a branch
    // whose PR is open; cleared by a delivery that pushes; never recorded for a
    // `verified` revision. Absent = the delivered revision is on the PR (or the
    // fact was never measured) — consult it only through `unpushedRevisionOf`,
    // which also refuses a record written for a revision that is no longer the
    // task's current one.
    unpushedRevision: z
      .object({
        revisionSha: z.string().min(1),
        prHeadSha: z.string().min(1).nullable(),
        relation: z.enum(["behind", "diverged", "unknown"]),
      })
      .nullish()
      .catch(null),
    // Ruling 160 (pass 35, F35-11): a person closed this pull request without
    // merging it. Stamped by the reconciler on the transition INTO `closed`
    // (the only writer of that state), carried forward for the same number
    // while it stays closed, dropped when the PR leaves `closed` (a reopen) and
    // never inherited by a different PR. `by` is the GitHub login GitHub named
    // as the closer, null when it named none. `answered` is stamped by
    // `resolvePacket` when a PERSON resolves a packet while the PR is closed:
    // until then `openTaskPr` refuses to open another PR for the branch
    // (`closed_by_human`). Absent = the PR was never closed by a person.
    closure: z
      .object({
        at: z.string().min(1),
        by: z.string().nullable(),
        answered: z
          .object({
            at: z.string().min(1),
            byUserId: z.string().min(1),
          })
          .nullable(),
      })
      .nullish()
      .catch(null),
  })
  .loose();
export type PrRef = z.infer<typeof prRefSchema>;
export type UnpushedRevision = NonNullable<PrRef["unpushedRevision"]>;
export type PrClosure = NonNullable<PrRef["closure"]>;

/** The stored `pr.revisionDrift`, typed as the shared drift record so the
 *  file and the sentence builder can never disagree on the shape. */
export type StoredRevisionDrift = RevisionDrift;

/**
 * Ruling 135: the recorded unpushed-revision fact, when it still describes the
 * task's CURRENT delivered revision, or null. `currentRevisionSha` is the
 * `workRevision.headSha` the caller holds (a `TaskSummary` carries only
 * `workRevisionSha`, which is why the helper takes the sha and not the
 * revision object). A record written for an older revision is stale and reads
 * as nothing; a PR that is merged or closed has no push to offer.
 */
export function unpushedRevisionOf(
  pr: PrRef | null | undefined,
  currentRevisionSha: string | null,
): UnpushedRevision | null {
  if (!pr || !currentRevisionSha) return null;
  if (pr.state === "merged" || pr.state === "closed") return null;
  const record = pr.unpushedRevision;
  if (!record) return null;
  if (record.revisionSha !== currentRevisionSha) return null;
  return record;
}

/**
 * Ruling 135 — why an UNPUSHED delivered revision blocks acceptance, or null.
 * Ranked ABOVE `conflictingPrBlockedReason` by every consumer: `mergeable:
 * conflicting` describes the OLD head, and the fact the person can act on is
 * that the delivered revision is not on the pull request. The remedy is to
 * deliver ("push"), never to rebase: a behind or absent remote reaches the PR
 * by a plain push; a diverged remote needs the history resolved first, and the
 * sentence names the act that resolves it (ruling 321) rather than asserting
 * that one exists.
 */
/**
 * Ruling 321 — the one act that resolves a diverged branch, said once.
 *
 * Five separate sentences told a person to "resolve the branch history" and
 * none of them named an act: this reader, the workspace-delivery timeline line,
 * the operator's `update_branch_from_base` remote sentence, the collision
 * ceremony's own-PR-diverged note, and the packet outcome summary. The header
 * of this very function claimed the opposite — *"a diverged remote needs the
 * history resolved first, and the sentence says which"* — while the sentence
 * said only that someone should.
 *
 * Live on SHOP-11 the owner supplied the missing half by hand, in a decision
 * note, and then had the controller write it into the project's rulings KB so
 * no agent would need telling again: *"Viberr's own update_branch_from_base
 * merges main into the branch; it does not rewrite history, and that is the
 * correct shape whenever a PR is already tracking the branch."* That is a fact
 * about Viberr, learned from Viberr, that Viberr could have said itself.
 */
export const DIVERGED_BRANCH_REMEDY =
  "The way out is a MERGE of the remote branch into the workspace branch, never a rebase or an " +
  "amend: a branch a pull request tracks has published commits, and rewriting them is what " +
  "diverges it.";

export function unpushedRevisionBlockedReason(
  pr: PrRef | null | undefined,
  currentRevisionSha: string | null,
  taskKey: string,
): string | null {
  const record = unpushedRevisionOf(pr, currentRevisionSha);
  if (!record || !pr) return null;
  const rev = record.revisionSha.slice(0, 7);
  const head = record.prHeadSha ? `\`${record.prHeadSha.slice(0, 7)}\`` : "an older head";
  if (record.relation === "diverged") {
    return `${taskKey}'s delivered revision \`${rev}\` is not on PR #${pr.number}, whose head ${head} holds commits this workspace does not. ${DIVERGED_BRANCH_REMEDY} Then deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.`;
  }
  // Ruling 207(k): `unknown` is not `behind`. It is written when the compare
  // could not be READ at all (the reconciler's `compare()` failing, a mirror
  // that could not be built), so the remote may well be diverged — and the old
  // sentence handed that case the plain-push remedy the `diverged` arm exists
  // to replace. Naming the uncertainty is the honest answer: the same first
  // move, without the promise that it will land.
  if (record.relation === "unknown") {
    return `${taskKey}'s delivered revision \`${rev}\` is not on PR #${pr.number} (its head is ${head}), and Viberr could not read how the two relate. Deliver the branch to try the push — if the remote has diverged it will refuse, and the history has to be resolved first. It cannot be accepted until the PR carries the reviewed revision.`;
  }
  return `${taskKey}'s delivered revision \`${rev}\` is not on PR #${pr.number} (its head is ${head}). Deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.`;
}

/**
 * Ruling 161 (pass 35, G35-6): has the task's revision LEFT the workspace?
 * Three facts say yes, in the order a person would name them: a pull request
 * tracks the branch (`pr`, live or settled), a stranger's pull request stands
 * on the branch name (`github.unownedPr`), or a delivery push published the
 * revision's head (`workRevision.pushedAt`). Until one holds, the branch is the
 * task's local draft: a reported head is not a delivered one, and a person may
 * discard it. `github.commits` is deliberately not read here: the workspace
 * reconcile writes it from the local clone, so it proves nothing about origin.
 */
export type RevisionDeparture =
  | { kind: "pr"; number: number }
  | { kind: "unowned_pr"; number: number }
  | { kind: "pushed"; at: string; headSha: string };

export function revisionLeftWorkspace(fm: {
  pr: PrRef | null;
  github: GithubCache | null;
  workRevision: WorkRevision | null;
}): RevisionDeparture | null {
  if (fm.pr) return { kind: "pr", number: fm.pr.number };
  const unowned = fm.github?.unownedPr ?? null;
  if (unowned !== null) return { kind: "unowned_pr", number: unowned };
  const rev = activeWorkRevision(fm.workRevision);
  if (rev?.pushedAt) return { kind: "pushed", at: rev.pushedAt, headSha: rev.headSha };
  return null;
}

/** GitHub projection cache mirrored into the file by the Phase-7
 * reconciler — commits + change stats. Not human-edited truth. */
export const githubCommitSchema = z
  .object({
    sha: z.string(),
    msg: z.string(),
    /** Ruling 187 (pass 37, F37-8): does the REMOTE have this commit? Stamped
     *  by the reconciler from a complete branch compare. Absent means "not
     *  judged" — no compare has been able to say — which every renderer must
     *  treat as unknown rather than as either answer. A workspace commit that
     *  delivery has not pushed yet reads `false` and is honest; so does one
     *  whose workspace is gone. Distinguishing those two at reconcile time is
     *  not possible (neither is on the remote, neither carries `pushedAt`), so
     *  this says only what is knowable. */
    pushed: z.boolean().optional(),
  })
  .loose();
export const githubCacheSchema = z
  .object({
    commits: z.array(githubCommitSchema).default([]),
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
    /** Ruling 161 (pass 35, U35-8): origin's copy of the task's branch carries
     *  commits this task's own record does not account for (a stranger's PR
     *  stands on it, or the branch is ahead of the base with no delivery of
     *  this task behind it). Written by the reconciler each pass it can tell
     *  (`sha` = the foreign head when GitHub named one, `prNumber` = the
     *  unowned PR when one stands), dropped the pass the head is proven this
     *  task's, and cleared by the writers that clear `unownedPr`. Read by the
     *  archive ceremony's delete-branch disclosure and by the operator
     *  snapshot. Absent = the head is this task's, or was never read. */
    foreignHead: z
      .object({
        sha: z.string().min(1).nullable(),
        prNumber: z.number().int().nullable(),
      })
      .nullish(),
    /** Ruling 179 (pass 36, F36-7): commits on the branch that do NOT carry
     *  this task's `[KEY]` prefix — a stranger's push, a hand fix, a merge
     *  Viberr did not record. `commits` keeps this task's own; these are shown
     *  beside them as "not this task's" so a moved head is visible where the
     *  decision is made. Absent = none, or not derived this pass. */
    otherCommits: z.array(githubCommitSchema).optional(),
  })
  .loose();
export type GithubCache = z.infer<typeof githubCacheSchema>;
export type ForeignBranchHead = NonNullable<GithubCache["foreignHead"]>;

export const packetObservationSchema = z
  .object({
    k: z.string(),
    v: z.string(),
    code: z.boolean().default(false),
  })
  .loose();
export type PacketObservation = z.infer<typeof packetObservationSchema>;

/**
 * Ruling 131: one `blockedBy` entry as stored — a spelling
 * `app/shared/dependencies.ts` parses, CANONICALIZED on the way in (a task
 * prefix upper-cased, a goal id lower-cased, whitespace collapsed) so the file
 * carries exactly what the surfaces print and the resolver looks up.
 */
export const dependencyRefTextSchema = z
  .string()
  .transform((value, ctx) => {
    const canonical = canonicalDependencyRef(value);
    if (canonical === null) {
      ctx.addIssue({
        code: "custom",
        message: `not a task key or a goal link (\`${value}\`)`,
      });
      return z.NEVER;
    }
    return canonical;
  });

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
     *  specialist needs none). Ruling 237: `question_reviewer` names the
     *  reviewer the question goes to, and is refused without one. */
    profileId: z.string().optional(),
    /** archive_task — ALSO delete the task's remote branch when archiving
     *  (discard the rejected work entirely, not just the task's board row).
     *  Resolution refuses it while the PR is still open. */
    deleteBranch: z.boolean().optional(),
    /** edit_goal — ruling 138 (pass 34, U34-10): the proposed goal text
     *  itself, written AS a goal (deliverable plus acceptance criteria). It is
     *  what the goal editor opens with (`goalDraftForOption`); an option without
     *  one prefills the title and detail verbatim. Refused on any other kind. */
    goalDraft: z.string().optional(),
    /** move_stage — ruling 164 (pass 35, F35-14): the stage the resolution
     *  moves the task to, as a stage id of this project. Required on the kind
     *  (authoring refuses one without it) and refused on every other kind. */
    toStage: z.string().optional(),
    /** wait_for_window — ruling 224: the instant the provider said its window
     *  reopens, as an ISO timestamp. The resolution schedules the agent's
     *  re-dispatch just after it. Required on the kind, refused on every
     *  other. */
    dueAt: z.string().optional(),
    /** Ruling 230: `block_on_dependencies` — what this task waits on, in the
     *  same spellings `blockedBy` stores (a task key, or a goal link). */
    blockedBy: z.array(dependencyRefTextSchema).optional(),
    /** create_task — ruling 269: the task the resolution creates. `title` and
     *  `goal` are required on the kind (authoring refuses one without them)
     *  and the whole field is refused on every other kind. */
    newTask: z
      .object({
        title: z.string().min(1),
        goal: z.string().min(1),
        /** What the NEW task waits on, in `blockedBy`'s own spellings. Not the
         *  same field as `block_on_dependencies`'s, which holds THIS task's. */
        blockedBy: z.array(dependencyRefTextSchema).optional(),
        /**
         * Ruling 287: the EXISTING tasks that must wait on the new one — the
         * reverse edge, which ruling 269 could not express at all.
         *
         * A task is usually created to UNBLOCK something, so the dependency
         * runs from the existing work to the new task, and that is the
         * direction `blockedBy` cannot say. Each key is written into THAT
         * task's own `blockedBy`, checked exactly as its own editor would check
         * it, and only because a person confirmed the option.
         */
        blocks: z.array(dependencyRefTextSchema).optional(),
        labels: z.array(z.string()).optional(),
      })
      .optional(),
    /** redirect — ruling 163 (pass 35, F35-13): the resolution RETURNS the
     *  task to the review stage when it stands at or past it, so the reworked
     *  revision gets its verdict where the reviewers are eligible. Written by
     *  the branch-conflict packet; read by `resolvePacket`'s default arm. */
    rework: z.boolean().optional(),
  })
  .loose();
export type PacketOption = z.infer<typeof packetOptionSchema>;

/**
 * Ruling 315: the cap BOTH free-text fields on a decision packet share.
 *
 * They used to be 2,000 (silently sliced in the route, with nothing on the box
 * saying so) and 4,000 (refused by the server), and which one a person got was
 * decided by whether the selected option happened to be the synthetic "Write
 * your own directive" index — not by anything they could see. One number now,
 * refused at both, stated on the label, and enforced by the textarea so the
 * browser stops the paste rather than the server refusing a confirm the person
 * has already committed to.
 *
 * Lives here because the box that must show it is a client component and the
 * guard that must enforce it is server-only.
 */
export const PACKET_NOTE_MAX = 4000;

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
    /** Ruling 138 (pass 34, F34-13): WHICH option was confirmed, stamped beside
     *  `awaiting` so a reload can render the packet as decided (the chosen
     *  option locked, one "Edit the goal" control) and rebuild the same goal
     *  draft the confirm opened. Cleared with the packet. */
    decided: z
      .object({
        optionIndex: z.number().int().min(0),
        at: z.string().min(1),
        byUserId: z.string().min(1),
      })
      .optional(),
    /**
     * Ruling 315: the CAUSE that raised this packet, when the cause is bigger
     * than the task.
     *
     * A backend account losing its quota or its credential takes out every task
     * running on it at once, and each one raised its own identical packet —
     * same reason, same remedy, same options, N times. The person is answering
     * the CAUSE, not the task, so packets that share a cause resolve together:
     * answering one applies the same option to every sibling still carrying it.
     *
     * Absent on every packet whose cause is the task itself, which is almost
     * all of them. A stable string, not an id: it is built from what actually
     * failed (backend, failure kind, whose account), so two tasks that failed
     * for the same reason agree on it without anything coordinating them.
     */
    cause: z.string().optional(),
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
    /** R19-8: what this revision IS. `delivered` — a commit a delivering run
     *  produced (the only kind before pass 19). `verified` — a VERIFICATION
     *  revision: the default-branch head a reviewer judged on a task that has
     *  nothing to deliver, so the verdict has a subject to bind to and names the
     *  base sha it was given. A verification revision is never "delivered work"
     *  and never carries a task branch (`branch: null`).
     *
     *  ABSENT reads as `delivered`: every revision minted before pass 19 is one,
     *  and both minters (`nextWorkRevision`, the R19-8 verdict-time mint) now
     *  state the kind outright — so only pre-pass-19 files omit it. Read it as
     *  `=== "verified"`, never as `!== "delivered"`.
     *
     *  Ruling 161 (pass 35, G35-6): `discarded` — a delivered revision whose
     *  branch a person discarded before it ever left the workspace
     *  (`discard_branch`). The record stays so the verdicts bound to it read
     *  as history, but it is no longer the revision under review: every
     *  reader that means "the revision under review" goes through
     *  `activeWorkRevision`, which answers null for it, and `nextWorkRevision`
     *  mints a fresh id over it even for the same tree.
     *
     *  Ruling 179 (pass 36, F36-7): `external` — the review pull request's head
     *  moved after the latest verdict by commits Viberr did not deliver (a
     *  stranger's push, a hand fix). The reconciler mints it from the PR head so
     *  the verdicts on the previous revision no longer bind (the merge is what
     *  a verdict protects, and the merge takes the head); it is the revision
     *  under review until a reviewer judges it or a delivery replaces it. */
    kind: z.enum(["delivered", "verified", "discarded", "external"]).optional(),
    /** Ruling 161 (pass 35, G35-6): the instant a delivery push published
     *  this head to origin (`performDelivery`, on `pushed` or `up_to_date`
     *  with the same head). This is the one fact that says the revision LEFT
     *  the workspace without a pull request to prove it: `revisionLeftWorkspace`
     *  reads it, and the `discard_branch` authoring gate keys on it. Absent =
     *  no delivery has seen this head on origin. `github.commits` is NOT that
     *  evidence: the workspace reconcile writes it from the local clone. */
    pushedAt: z.string().min(1).nullish(),
  })
  .loose();
export type WorkRevision = z.infer<typeof workRevisionSchema>;

/**
 * Ruling 161: the revision under review, or null. A `discarded` revision is a
 * retired record (its branch is gone, its verdicts are history), so every
 * reader that asks "what is the delivered revision right now" reads through
 * here rather than testing `workRevision !== null`. Returns the SAME object
 * (never a copy) so an in-lock writer may stamp it.
 */
export function activeWorkRevision(
  rev: WorkRevision | null | undefined,
): WorkRevision | null {
  if (!rev) return null;
  if (rev.kind === "discarded") return null;
  return rev;
}

export const REVIEW_VERDICT_RESULTS = ["approve", "request_changes"] as const;

/** One reviewing engagement's verdict, bound to the revision it judged (F10-15). */
export const reviewVerdictSchema = z
  .object({
    profileId: z.string().min(1),
    /** What this verdict judged: the `workRevision.id`, or — ruling 388, when
     *  the deliverable is not a commit — `files:<deliveredAt>`. Either way a
     *  verdict on an OLD subject is automatically stale once a new one appears.
     *  `reviewSubjectId` is the one place that decides which. */
    revisionId: z.string().min(1),
    /** Denormalized head SHA for display/traceability. Ruling 388: absent when
     *  the subject is not a commit, and every reader of it already had to cope
     *  with having no sha to name. */
    headSha: z.string().min(1).optional(),
    result: z.enum(REVIEW_VERDICT_RESULTS),
    reason: z.string().default(""),
    at: z.string().min(1),
    /** Ruling 204: how many times this reviewer has returned THIS result on
     *  THIS revision. The verdict itself stays last-write-wins per
     *  (profileId, revisionId) — F10-15's model, unchanged — but the count of
     *  blocking rounds must not be destroyed by the overwrite, because a
     *  reviewer re-blocking an UNCHANGED revision is the strongest evidence
     *  there is that the deliverer cannot satisfy it. Absent reads 1. */
    rounds: z.number().int().min(1).default(1),
    /** Ruling 416(b): how many times this reviewer returned this result on
     *  this revision, fought round or not. More reviews than rounds means the
     *  reviewer read the revision again with nothing reworked behind it: a
     *  verdict-shaped answer to the completeness question, which the deadlock
     *  packet must not recommend asking again. Absent reads as `rounds` (no
     *  such re-read on record). */
    reviews: z.number().int().min(1).optional(),
    /** Ruling 421: the reviewer answered the completeness question on this
     *  revision in the current same-result streak: a run that put it
     *  (`Engagement.question`) returned this result here. Kept across the
     *  per-revision overwrite, as `reviews` is, so a later round on the same
     *  revision does not erase it. The deadlock packet reads it as the
     *  question spent. */
    answers: z.literal("completeness").optional(),
  })
  .loose();
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

// -------------------------------------------------------- frontmatter

/** Ruling 132: one recorded base refresh (see `baseRefreshes` below). */
export const baseRefreshSchema = z
  .object({
    /** The merge commit `update_branch_from_base` created (full sha). The
     *  refresh merges with `--no-ff`, so this is always a two-parent commit. */
    mergeSha: z.string().min(1),
    /** The base branch tip that was merged in (full sha). */
    baseSha: z.string().min(1),
    /** The base branch name, e.g. `main`. */
    base: z.string().min(1),
    /** How many base commits the refresh brought onto the task branch. */
    commits: z.number().int().min(0),
    /** UTC ISO instant the refresh was pushed. */
    at: z.string().min(1),
  })
  .loose();
export type BaseRefresh = z.infer<typeof baseRefreshSchema>;

/** The field schemas, named so the tolerant parser below can reach them
 *  directly: it validates ONE field at a time (a bad field falls back with a
 *  diagnostic instead of dropping the task), so it never runs the composed
 *  object schema. */
const taskFrontmatterFields = {
  key: z.string().regex(/^[A-Za-z]+-\d+$/),
  title: z.string().min(1),
  stage: z.string().min(1),
  /** The stage this task sat at BEFORE its most recent transition (null until
   *  the first move). Durable, structural previous-stage knowledge for the
   *  operator's agent choice (dynamic-dispatch rework 2026-08-29): before this
   *  field the prior stage reached the operator only as one-hop transition
   *  trigger context or timeline prose — gone by the next turn. */
  previousStageId: z.string().nullable().default(null),
  /** V18 (F31-11): a DURABLE deliberate-hold marker. Set to the current stage
   *  when a stranded-resume nudge ends stranded again (the operator held an
   *  `auto` stage twice in a row on purpose); while it names the task's
   *  current stage, the settle-time stranded backstop stays quiet instead of
   *  paying a nudge and duplicating the hold note on every external trigger.
   *  Cleared by any stage transition, packet resolution, or goal edit — each
   *  is a human re-litigating the task's direction. A manual operator drive
   *  deliberately does NOT clear it: the drive itself is the re-litigation,
   *  and clearing would re-arm the nudge-then-duplicate-note cycle the marker
   *  exists to end (the operator can still advance, which clears it via the
   *  transition). */
  heldAtStage: z.string().nullable().default(null),
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
  /** Ruling 241: reviewer questions a dependency hold refused, put when the
   *  hold lifts. Empty on every task that never had one. */
  queuedQuestions: z.array(queuedQuestionSchema).default([]),
  urgent: z.boolean(),
  /** Task priority (pass-25). A graded triage scale; "urgent" is the top rung and
   *  keeps the board's existing urgent highlight (`urgent` is derived from it at
   *  write time so the projection/board/filter that already read `urgent` are
   *  unchanged). */
  priority: z.enum(PRIORITY_VALUES).default("normal"),
  /** Free-form triage labels (pass-25) — board chips + filter. */
  labels: z.array(z.string()).default([]),
  /** Optional due date, an ISO date string `YYYY-MM-DD` (pass-25). Board shows
   *  it and flags overdue; null = none. */
  dueDate: z.string().nullable().default(null),
  /** Ruling 131 (pass 34, Q34-11): what this task WAITS ON — task keys and
   *  goal links in the same project, in the canonical spellings of
   *  `app/shared/dependencies.ts` (`JC-6`, `goal-1 link 3`). Planning metadata
   *  with one difference from priority, labels and due date: while the list
   *  is non-empty the derived readiness is floored at `blocked`, the task owes
   *  nobody anything (`waiting: none` unless a packet or recommendation is
   *  open), the operator's create/transition/scheduled triggers are refused,
   *  and Viberr releases the task itself when every entry is done. States are
   *  resolved at READ time, never cached here. Parsed per row (a malformed
   *  spelling drops only itself). */
  blockedBy: z.array(dependencyRefTextSchema).default([]),
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
  /**
   * Ruling 388 (F39-15): when a RUN last delivered work that is not a commit.
   *
   * A research task, a design note, an audit: the deliverable is the files the
   * run saved into `attachments/`, and there is no revision to bind a review
   * to. Everything downstream of review was keyed on `workRevision`, so such a
   * task could not hold a verdict, could not derive a validation from one, and
   * after ruling 385 could not be accepted either. This is the identity the
   * review binds to instead, and a later run that saves files moves it, which
   * is what makes the old verdict stale — the same rule a new revision follows.
   *
   * A person's own upload never sets it: an uploaded fixture is an input to the
   * work, not the work (ruling 379).
   */
  deliveredAt: z.string().nullable().default(null),
  /** F10-15: per-engagement verdicts, each bound to the revision it judged. */
  verdicts: z.array(reviewVerdictSchema),
  /** Ruling 132 (pass 34, F34-14): every base refresh the operator's
   *  `update_branch_from_base` landed on the task branch, recorded the moment
   *  the merge is pushed — the merge commit, the base tip it merged, the base
   *  branch name, how many base commits it brought in, and when. A merge
   *  commit listed here is a CLEAN merge by construction (that path aborts on
   *  any conflict), which is how the reconciler tells Viberr's own base
   *  refresh from an out-of-band merge that counts as authored drift. A
   *  fast-forward refresh records `mergeSha === baseSha`. First-class like
   *  `verdicts`; parsed per row. */
  baseRefreshes: z.array(baseRefreshSchema),
  branch: z.string().nullable(),
  // P13-D-5: `repo` (the task-level repo override) lived here. The override was
  // deleted this pass by owner ruling — one project, one repo — and nothing can
  // write it any more, so the field is gone rather than kept as a permanently
  // null read path. An existing `repo:` line in a task.md is now an UNKNOWN key:
  // preserved verbatim on round-trip, ignored by every resolver.
  pr: prRefSchema.nullable(),
  // R17-2 / R19-8: this task completes with NOTHING to deliver. Acceptance of a
  // `workRevision && !pr` task is normally refused ("deliver the branch & open
  // the PR"); this flag is the ONE signal that turns that refusal into a
  // first-class "Completed — no changes" acceptance that closes to Done without
  // a PR or merge. Two producers: a delivery attempt that found the branch empty
  // (`performDelivery`'s `nothing_to_review` result), and a reviewer approving a
  // task that never needed a branch at all (`recordAgentCompletion`, which also
  // mints the `kind: "verified"` revision the verdict binds to). Cleared the
  // moment a delivery opens a PR.
  //
  // R19-8: the flag is a CLAIM about a moment that has passed —
  // `acceptanceNoChangeCheck` (no-change-completion.server) re-verifies it with a
  // LIVE remote read before any writer closes the task to Done, so a branch that
  // has since gained commits cannot ride a stale flag into Done (F19-21).
  noChanges: z.boolean().optional(),
  // N20-14 (pass20 §5c): a durable record that this task reached Done through a
  // force-accept — the human deliberately bypassed the verdict gate. Without it
  // `deriveValidation` recomputes the pre-accept "awaiting verdict" state and a
  // force-accepted Done task reads "accepted · awaiting verdict" on the hero and
  // its card. This is the SERVER half only: the durable fact + its projection +
  // TaskSummary. The "accepted · gate bypassed" display arm is C-VOCAB's.
  acceptance: z.enum(["forced"]).nullable().optional(),
  /**
   * Ruling 226 (F37-43): a maintainer took a merge whose containment check
   * GitHub refused to run, deliberately and on the record.
   *
   * Pinned to all three shas/numbers it was granted against, because the whole
   * danger it admits is that the PR head is unknown: a waiver that outlived the
   * head it was granted for would be a standing permission to merge anything
   * that branch later carried. The gate re-reads the live head and honours this
   * only while the triple still matches.
   */
  headCheckWaiver: z
    .object({
      prNumber: z.number().int(),
      /** The delivered revision the reviewers were pinned to. */
      revisionHeadSha: z.string().min(1),
      /** The live PR head GitHub reported at the moment of the waiver. */
      liveHeadSha: z.string().min(1),
      at: z.string().min(1),
      byUserId: z.string().min(1),
      byLabel: z.string().default(""),
    })
    .nullable()
    .optional(),
  github: githubCacheSchema.nullable(),
  /** Chained-goal back-reference (ruling 99): this task is one LINK of a goal
   *  chain. The chain itself is canonical in
   *  `projects/<slug>/goals/<goalId>.md`; this points back at it, the same
   *  project→task shape as `stage` (project.md owns the stage list, the task
   *  carries its position). Null for every task outside a chain. Written by
   *  goal-actions at link-task creation; never hand-set expecting the chain to
   *  adopt the task — the goal file's own `links[].taskKey` is what binds. */
  goalRef: z
    .object({
      goalId: z.string().min(1),
      linkIndex: z.number().int().min(1),
    })
    .nullable()
    .default(null),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Board position within a stage — a sparse rank for drag-to-reorder. Null
   *  falls back to the task-key number (the pre-reorder default order). */
  boardRank: z.number().nullable(),
};

/** Strict target shape — what a fully valid task.md frontmatter parses to. */
export const taskFrontmatterSchema = z.object(taskFrontmatterFields);
export type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

// ------------------------------------------- review-state derivation (F10-15)

/** The minimal review-relevant slice of the frontmatter (so the helpers are
 *  pure and testable without a full task file). */
type ReviewState = {
  engagements: Engagement[];
  workRevision: WorkRevision | null;
  /** Ruling 388: the non-commit delivery this task's review binds to. Optional
   *  so the existing call sites (which all pass whole frontmatter) need no
   *  change. */
  deliveredAt?: string | null;
  verdicts: ReviewVerdict[];
  /** R19-8: this task was verified to have nothing to deliver. Optional so the
   *  existing call sites (which all pass whole frontmatter) need no change. */
  noChanges?: boolean;
  /** N20-14 (§5c): `"forced"` when a human force-accepted this task past the
   *  verdict gate — the durable override fact. Optional for the same reason. */
  acceptance?: "forced" | null;
};

/** Supporting engagements that are REQUIRED reviewers (verdict-capable). Their
 *  approval of the current revision gates acceptance (F10-15). */
export function requiredReviewers(fm: { engagements: Engagement[] }): Engagement[] {
  return fm.engagements.filter((e) => !e.delivers && e.verdictCapable);
}

/**
 * Ruling 388: what a review on this task binds to right now.
 *
 * The active work revision, or — when the deliverable is not a commit — the
 * moment a run last saved files. ONE place decides it, so the verdict writer,
 * the staleness rule, the derived validation and the required-reviewer gate can
 * never disagree about what was reviewed. Null when the task has delivered
 * nothing at all, which is ruling 161's case: nobody owes a verdict.
 */
export function reviewSubjectId(fm: {
  workRevision: WorkRevision | null;
  deliveredAt?: string | null;
}): string | null {
  const rev = activeWorkRevision(fm.workRevision);
  if (rev) return rev.id;
  return fm.deliveredAt ? `files:${fm.deliveredAt}` : null;
}

/** Verdicts bound to the CURRENT subject — older ones are stale (F10-32,
 *  ruling 388). */
export function currentVerdicts(fm: {
  workRevision: WorkRevision | null;
  deliveredAt?: string | null;
  verdicts: ReviewVerdict[];
}): ReviewVerdict[] {
  const subject = reviewSubjectId(fm);
  if (!subject) return [];
  return fm.verdicts.filter((v) => v.revisionId === subject);
}

/** The DERIVED review-state cache written into `validation` (F10-15): failing if
 *  any required reviewer requests changes on the current revision; healthy when
 *  every required reviewer approved it; changed while a revision is under review
 *  with verdicts pending (or no required reviewer); none before delivery. */
export function deriveValidation(
  fm: ReviewState,
): (typeof VALIDATION_VALUES)[number] {
  // Ruling 161: a discarded revision owes nobody a verdict. Ruling 388: neither
  // does a task that has delivered nothing at all — but a task whose deliverable
  // is a saved FILE has delivered, and used to be forced to `none` here however
  // its reviewer had ruled. Live on ax-clone AX-12 that printed "**Validation:**
  // none. Review & validation requested changes." in one sentence, and left the
  // operator with no rework route, because ruling 163's backward move needs a
  // `failing` or `changed` validation to license it.
  if (!reviewSubjectId(fm)) return "none";
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
  // F19-27 / R19-8: a verified no-change completion has a work revision but
  // nothing inside it to review — no diff, no pull request, and nobody owing a
  // verdict. Falling through to `changed` made an accepted task sit in Done
  // wearing "awaiting verdict", the same false claim UXO-1 removed from
  // archived tasks.
  //
  // Placed LAST on purpose. Both real outcomes still win: a recorded
  // request-changes stays `failing`, and a reviewer who DID approve a
  // nothing-to-deliver task stays `healthy` — an approval is evidence and must
  // not be erased into "nothing to see". Only the genuinely empty case —
  // no verdict owed, none given — becomes `none`.
  //
  // NARROWED to `required.length === 0` (post-merge): under A's mint-before-
  // approval flow a verify-only task carries a `kind:"verified"` revision the
  // required reviewer has not yet approved, and reaching here means at least one
  // required reviewer is still PENDING (all-approved → `healthy` above, any
  // request-changes → `failing` above). Labelling that "none" would tell the
  // human "nothing owed" while the acceptance gate is genuinely holding on a
  // verdict — the F19-21 regression. It stays `changed` until the verdict lands.
  // N20-14 (§5c) / C2: a force-accept is a durable human override of the verdict
  // gate. Once it is recorded, re-deriving the pre-acceptance pending state
  // ("awaiting verdict") is a false live obligation — the task reached Done
  // because a human bypassed the gate, not because a verdict landed. Surface the
  // override itself so a force-accepted, Done task never re-derives "awaiting
  // verdict" on any surface that still renders its validation pill.
  //
  // Placed AFTER the real-verdict arms (`failing` / `healthy`) and the no-change
  // arm's siblings but BEFORE `none`/`changed`, mirroring the no-change arm's
  // rule that a recorded verdict is EVIDENCE and must not be erased: a reviewer
  // who actually approved or requested changes still wins. Only the genuinely
  // moot pending/none case yields to the bypass fact.
  if (fm.acceptance === "forced") return "bypassed";
  if (fm.noChanges && required.length === 0) return "none";
  return "changed";
}

/** Why acceptance is blocked on the current revision, or null when allowed. A
 *  task with NO required reviewers and NO revision stays acceptable (planning /
 *  non-repo work); once a revision exists, all required reviewers must approve
 *  it and none may request changes (F10-15).
 *
 *  R19-8: the "No reviewed revision yet" arm is what dead-ended a task with
 *  nothing to deliver (F19-21, live VC-5) — the reviewer approved, the verdict
 *  had no subject to bind to, and acceptance refused forever. Nothing changes
 *  HERE: such a task now carries a `kind: "verified"` revision minted at verdict
 *  time, so it walks the ordinary required-reviewer path below. A second
 *  required reviewer who has not approved still holds it, which is intended. */
export function acceptanceBlockedReason(fm: ReviewState): string | null {
  const required = requiredReviewers(fm);
  // Ruling 161(b) names the acceptance gates among the readers that mean "the
  // revision under review": a DISCARDED record is retired, its verdicts are
  // history, and `currentVerdicts` already answers [] for it. Reading
  // `fm.workRevision` raw here sent the discarded task down the arm below and
  // told a person to wait for an approval of a revision no reviewer can be
  // given (the verdict binding refuses to pin one to a retired head) — the
  // F19-21 dead end, re-created by the new kind.
  if (!activeWorkRevision(fm.workRevision)) {
    // F19-21 (spec change 3) — the refusal used to stop at the first sentence,
    // and on a VERIFICATION-only task that reads as a dead end: nothing this
    // task will ever do produces a revision, so "nothing to approve" looks
    // permanent and the live exits were force-accept or "manually mark Done".
    // Running delivery once IS the path — it inspects the workspace and records
    // the verified no-change outcome (minting the base revision these reviewers
    // then approve), so the refusal names it.
    return required.length > 0
      ? "No reviewed revision yet, so there is nothing for the required reviewers to approve. " +
          "If this task requires no changes, run delivery once to verify and record that."
      : null;
  }
  const cur = currentVerdicts(fm);
  const verdictOf = (profileId: string) =>
    cur.find((v) => v.profileId === profileId)?.result;
  if (required.some((r) => verdictOf(r.profileId) === "request_changes")) {
    return "This task's latest review requests changes on the current revision. Rework and re-review before accepting.";
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
  return `${taskKey}'s review PR was closed on GitHub without merging, so it can't be accepted. Rework and reopen the PR, or archive the task.`;
}

/**
 * P14-LV-07 — why a CONFLICTING review PR blocks acceptance, or null.
 *
 * Accepting a completion MERGES its PR (FR31). A PR whose head conflicts with
 * the base branch cannot be merged by anyone, so accepting it would close the
 * task on a merge that did not happen — live-proven: VM-4 went to Done with
 * `pr.state: accepted` while PR #103 stayed open and conflicting, and the
 * timeline blamed unreachable GitHub / missing credentials. The conflict is a
 * REWORK signal, not a merge-pending state — and the rework is a MERGE of the
 * base into the branch, never a rebase (ruling 291).
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
  // Ruling 405: a conflict belongs to the head it was measured on. Once the
  // head moves past it the verdict says nothing about what is there now, and
  // this gate falls back to the rule the doc comment above already states:
  // unknown never blocks, because the merge attempt is the authority.
  if (pr.mergeableAt && pr.headSha && pr.mergeableAt !== pr.headSha) return null;
  // Ruling 291 (F37-126): this never names the rewrite. Viberr's own remedy is a
  // MERGE — `update_branch_from_base` "merge[s] the base into the branch and
  // push[es] it", and that same tool's text tells the operator to "never ask an
  // agent to rebase, merge or force-push". This sentence was the one place the
  // product recommended the operation it forbids everywhere else, to the one
  // reader with no tool and the most freedom to do it by hand. It is also the
  // operation that broke a branch on this very board: "Live on SHOP-11: a
  // rebase diverged the branch from its own PR #15" (operator-actions.server).
  return `${taskKey}'s review PR #${pr.number} conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Resolve the conflict on the branch by merging the base INTO it — never by rebasing, which rewrites commits the pull request already published — then re-review, or archive the task.`;
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
  return `${taskKey} is archived. Restore it before accepting the completion.`;
}

/**
 * F19-8 — why an ARCHIVED task can't be MOVED between stages, or null.
 *
 * The same reasoning as `archivedTaskBlockedReason` one step earlier in the
 * flow. Acceptance was guarded from the start, but nothing guarded a plain
 * transition, so an archived task could be dragged (or keyboard-moved, or
 * transitioned through the API) from column to column while every surface
 * called it abandoned — and dropping it on the terminal stage walked it into
 * the acceptance path that DOES refuse, producing a refusal for a move the
 * board had already animated. Restore it first; then it moves like any task.
 */
export function archivedTaskMoveBlockedReason(
  fm: { archived: boolean },
  taskKey: string,
): string | null {
  if (!fm.archived) return null;
  return `${taskKey} is archived. Restore it before moving it between stages.`;
}

/** The revision a delivered head lands on, plus whether it is a NEW review
 *  subject (`changed: false` keeps every prior verdict valid). */
export interface NextWorkRevision {
  revision: WorkRevision;
  changed: boolean;
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
): NextWorkRevision {
  // Ruling 161: a discarded revision is never the same subject, whatever its
  // tree: the branch it named is gone, and a re-created head is new work.
  const active = activeWorkRevision(current);
  const sameSubject =
    active != null &&
    (input.treeSha != null && active.treeSha != null
      ? active.treeSha === input.treeSha
      : active.headSha === input.headSha);
  if (sameSubject) return { revision: active, changed: false };
  return {
    revision: {
      id: input.id,
      headSha: input.headSha,
      treeSha: input.treeSha,
      branch: input.branch,
      createdAt: input.createdAt,
      sourceProfileId: input.sourceProfileId,
      // R19-8: this helper has ONE caller — a delivering run's reconcile — so
      // everything it mints is delivered work. The verification revision is
      // minted at verdict time and never comes through here.
      kind: "delivered",
    },
    changed: true,
  };
}

export const TASK_FRONTMATTER_KEYS: readonly (keyof TaskFrontmatter)[] = [
  "key",
  "title",
  "stage",
  "previousStageId",
  "heldAtStage",
  "readiness",
  "waiting",
  "ownerUserId",
  "engagements",
  "operator",
  "recommendations",
  "schedules",
  "queuedQuestions",
  "urgent",
  "priority",
  "labels",
  "dueDate",
  // Ruling 131: listed because this is the unknown-key membership index and
  // the file-formats §2 pin — serialization writes the whole frontmatter.
  "blockedBy",
  "archived",
  "validation",
  "workRevision",
  "deliveredAt",
  "verdicts",
  // Ruling 132: same reason as `blockedBy`.
  "baseRefreshes",
  "branch",
  // P13-D-5: "repo" deliberately NOT listed — it is an unknown key now, so an
  // existing task.md keeps its line verbatim instead of losing it on rewrite.
  "pr",
  "noChanges",
  "acceptance",
  // Ruling 226: without this line the waiver never reaches the file, so the
  // gate that re-reads it would refuse forever and the override would be a
  // button that does nothing. The canary found exactly that.
  "headCheckWaiver",
  "github",
  "goalRef",
  "createdAt",
  "updatedAt",
  "boardRank",
];

/** Membership index for the unknown-key sweep below, which tests arbitrary YAML
 *  keys — a string lookup here keeps the exported list itself typed. */
const TASK_FRONTMATTER_KEY_SET: ReadonlySet<string> = new Set(TASK_FRONTMATTER_KEYS);

/** The frontmatter mapping as YAML handed it over: keys exactly as written,
 * every value still undecoded (the field schemas above do the decoding, one
 * field at a time). This is also the contract for the leftover keys the writer
 * round-trips back into the file verbatim — those are never parsed at all, so
 * their values stay whatever YAML produced. */
const rawFrontmatterSchema = z.record(z.string(), z.unknown());
export type RawFrontmatter = z.infer<typeof rawFrontmatterSchema>;

export interface TolerantTaskFrontmatterResult {
  frontmatter: TaskFrontmatter;
  /** Unknown fields, preserved verbatim for round-trip writes. */
  unknown: RawFrontmatter;
  diagnostics: FileDiagnostic[];
}

/** What the tolerant parse reads out of a task.md. (The legacy `specialist` /
 *  `reviewers` / `consultants` slot absorption was deleted in the
 *  dynamic-dispatch rework, 2026-08-29 — preprod, no back-compat by owner
 *  ruling. A file still carrying those keys keeps them as unknown keys.) */
type ReadableFrontmatterKey = keyof TaskFrontmatter;

/** Runs `schema` over `data[path]`; on failure records a diagnostic and returns
 * `fallback`. Absent (undefined) values only diagnose when `required`. */
function tolerant<T>(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
  path: ReadableFrontmatterKey,
  schema: z.ZodType<T>,
  fallback: T,
  options: { required?: boolean; severity?: "info" | "warning" } = {},
): T {
  const value = data[path];
  if (value === undefined) {
    if (options.required) {
      const make = options.severity === "info" ? diagInfo : diagWarning;
      diagnostics.push(
        make(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing; using ${JSON.stringify(fallback)}.`,
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
      `Frontmatter field \`${path}\` is invalid (${result.error.issues[0]?.message ?? "unparseable"}); using ${JSON.stringify(fallback)}.`,
      path,
    ),
  );
  return fallback;
}

/**
 * Validate a list field ONE ROW AT A TIME, keeping the good rows and dropping
 * only the bad ones with a per-index diagnostic — the F18 contract.
 *
 * The whole-array {@link tolerant} above empties the ENTIRE list on one bad
 * row, and because the diagnostic is only a warning (not a hardStop) the file
 * stays writable, so the next `updateTaskFile` serializes the emptied list back
 * over the rows that had been fine — a durable, silent loss. Any list whose
 * loss would persist (verdicts, schedules, engagements, …) parses through here.
 */
/**
 * C01-A8 (pass 32): `github.commits` gets the per-row tolerance every other
 * list has. The cache is reconciler-written, but ONE odd row (`sha: 1234` as a
 * YAML number after a hand edit, a half-written line) failed the WHOLE
 * `github` object to null — and took `unownedPr` (R15-15, the branch-collision
 * fact) and `changed` down with it. The GitHub card then stopped reporting a
 * collision that still existed, and the next write serialized `github: null`
 * back for good. Returns `data` untouched when there is nothing to clean.
 */
function githubWithCleanCommits(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
): RawFrontmatter {
  const probe = z
    .object({ commits: z.array(z.unknown()) })
    .loose()
    .safeParse(data.github);
  if (!probe.success) return data;
  const commits = tolerantRowsOf(
    diagnostics,
    probe.data.commits,
    githubCommitSchema,
    "github.invalid_commit",
    (i) => ({
      subject: `GitHub commit row [${i}]`,
      noun: "commit row",
      path: `github.commits[${i}]`,
    }),
  );
  return { ...data, github: { ...probe.data, commits } };
}

function tolerantRows<T>(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
  path: ReadableFrontmatterKey,
  element: z.ZodType<T>,
): T[] {
  const value = data[path];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagWarning(
        "frontmatter.invalid_field",
        `Frontmatter field \`${path}\` is not a list — using an empty list.`,
        path,
      ),
    );
    return [];
  }
  return tolerantRowsOf(
    diagnostics,
    value,
    element,
    "frontmatter.invalid_field",
    (i) => ({
      subject: `Frontmatter \`${path}[${i}]\``,
      noun: "entry",
      path: `${path}[${i}]`,
    }),
  );
}

/**
 * Engagement parsing enforces one row per profile and at most one delivering
 * workspace owner. (The legacy `specialist`/`reviewers`/`consultants` slot
 * absorption lived here until the dynamic-dispatch rework, 2026-08-29 —
 * deleted with the rest of the slot model, preprod no-back-compat.)
 */
/** Validate the `engagements` list one row at a time, keeping the good ones. */
function parseEngagementRows(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
): Engagement[] {
  return tolerantRows(
    diagnostics,
    data,
    "engagements",
    taskFrontmatterFields.engagements.element,
  );
}

function parseEngagements(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
): Engagement[] {
  // Per-ENTRY, the way project.md's lists have parsed since F18. On the
  // whole-array path a single unparseable row emptied the entire roster — the
  // `delivers: true` branch owner and every required reviewer with it — and
  // the diagnostic is only a warning, so the file is still writable and the
  // next `updateTaskFile` serialized `engagements: []` back over the rows that
  // had been fine. One bad row now drops only itself.
  const engagements: Engagement[] = parseEngagementRows(diagnostics, data);
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
          `Profile \`${engagement.profileId}\` is engaged more than once; only the first engagement is kept.`,
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
        `Engagement \`${engagement.profileId}\` also claims delivers, but only the first delivering engagement owns the workspace; this one was demoted.`,
        "engagements",
      ),
    );
    engagement.delivers = false;
  }
  return deduped;
}

/**
 * Tolerant frontmatter parse. `data` is the frontmatter mapping the reader
 * decoded off disk — a file whose frontmatter is not a mapping arrives here
 * empty, so every field falls back to its default. `fallbackKey` (the task
 * directory name) rescues files whose `key` field is missing/invalid.
 */
export function parseTaskFrontmatter(
  data: RawFrontmatter,
  context: { fallbackKey?: string } = {},
): TolerantTaskFrontmatterResult {
  const diagnostics: FileDiagnostic[] = [];

  // key — identity; unidentifiable without a directory-name fallback.
  let key: string;
  const keyResult = taskFrontmatterFields.key.safeParse(data.key);
  if (keyResult.success) {
    key = keyResult.data;
    if (context.fallbackKey && key !== context.fallbackKey) {
      diagnostics.push(
        diagError(
          "frontmatter.key_mismatch",
          `Frontmatter key \`${key}\` does not match the task directory \`${context.fallbackKey}\`; the directory name wins.`,
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
        `Frontmatter has no valid \`key\`; inferred \`${key}\` from the task directory.`,
        "key",
      ),
    );
  } else {
    key = "UNKNOWN-0";
    diagnostics.push(
      diagError(
        "frontmatter.missing_key",
        "Frontmatter has no valid `key` and no directory fallback; the task cannot be identified.",
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
  const stageResult = taskFrontmatterFields.stage.safeParse(data.stage);
  if (stageResult.success) {
    stage = stageResult.data;
  } else {
    stage = "";
    diagnostics.push(
      diagWarning(
        "frontmatter.unresolved_stage",
        data.stage === undefined
          ? "Frontmatter field `stage` is missing; the task's stage is unresolved (shown as an unknown stage) until it is set."
          : `Frontmatter field \`stage\` is invalid (${stageResult.error.issues[0]?.message ?? "unparseable"}); the task's stage is unresolved (shown as an unknown stage) until it is corrected.`,
        "stage",
      ),
    );
  }

  const frontmatter: TaskFrontmatter = {
    key,
    title: tolerant(
      diagnostics,
      data,
      "title",
      taskFrontmatterFields.title,
      key,
      { required: true },
    ),
    stage,
    // previousStageId — absent on tasks that predate the dynamic-dispatch
    // rework → null, silently (a missing optional scalar is not a diagnostic).
    previousStageId: tolerant(
      diagnostics,
      data,
      "previousStageId",
      taskFrontmatterFields.previousStageId,
      null,
    ),
    // heldAtStage — absent on tasks that predate the durable-hold marker
    // (V18) → null, silently, same posture as previousStageId.
    heldAtStage: tolerant(
      diagnostics,
      data,
      "heldAtStage",
      taskFrontmatterFields.heldAtStage,
      null,
    ),
    readiness: tolerant(
      diagnostics,
      data,
      "readiness",
      z.enum(READINESS_VALUES),
      "ready",
      { required: true },
    ),
    waiting: tolerant(
      diagnostics,
      data,
      "waiting",
      z.enum(WAITING_VALUES),
      "none",
      { required: true },
    ),
    ownerUserId: tolerant(
      diagnostics,
      data,
      "ownerUserId",
      taskFrontmatterFields.ownerUserId,
      null,
    ),
    engagements: parseEngagements(diagnostics, data),
    operator: tolerant(
      diagnostics,
      data,
      "operator",
      taskFrontmatterFields.operator,
      null,
    ),
    // Per-ROW (F18): one malformed recommendation drops only itself, never the
    // whole list — a whole-array wipe would persist on the next write.
    recommendations: tolerantRows(
      diagnostics,
      data,
      "recommendations",
      taskFrontmatterFields.recommendations.element,
    ),
    // schedules — absent on tasks that predate O-3 → empty, silently (mirrors
    // recommendations: a missing optional array is not a diagnostic). Per-ROW so
    // one bad occurrence never drops the rest (FR39 server-fired runs).
    schedules: tolerantRows(
      diagnostics,
      data,
      "schedules",
      taskFrontmatterFields.schedules.element,
    ),
    // Ruling 241: absent on every task that never had a question queued →
    // empty, silently. Per-ROW, so one malformed entry never drops a question
    // a person was promised. (`queuedQuestions` carries a `.default([])`
    // wrapper, so its element is named directly — `.element` is only exposed by
    // a bare `z.array`, and the same trap dropped `rulingsKb` on the project
    // parser earlier in this pass: this builder reads field by field, so a
    // field missing HERE writes fine and reads back undefined.)
    queuedQuestions: tolerantRows(
      diagnostics,
      data,
      "queuedQuestions",
      queuedQuestionSchema,
    ),
    // urgent is an optional boolean by contract — absent means false, silently.
    urgent: tolerant(
      diagnostics,
      data,
      "urgent",
      taskFrontmatterFields.urgent,
      false,
    ),
    // Pass-25 task metadata: all default cleanly when absent (no diagnostic).
    priority: tolerant(
      diagnostics,
      data,
      "priority",
      taskFrontmatterFields.priority,
      "normal",
    ),
    // Per-ROW (F18): one malformed label drops only itself. (`labels` carries a
    // `.default([])` wrapper, so its element is named directly rather than via
    // `.element`, which only a bare `z.array` exposes.)
    labels: tolerantRows(diagnostics, data, "labels", z.string()),
    dueDate: tolerant(
      diagnostics,
      data,
      "dueDate",
      taskFrontmatterFields.dueDate,
      null,
    ),
    // Ruling 131: per-ROW, like every list whose loss would persist — one
    // unparseable spelling drops only itself (with a diagnostic at
    // `blockedBy[i]`), never the whole wait. Absent reads `[]`, silently.
    blockedBy: tolerantRows(diagnostics, data, "blockedBy", dependencyRefTextSchema),
    // archived, likewise: absent means "not archived" and is not a diagnostic.
    archived: tolerant(
      diagnostics,
      data,
      "archived",
      taskFrontmatterFields.archived,
      false,
    ),
    validation: tolerant(
      diagnostics,
      data,
      "validation",
      z.enum(VALIDATION_VALUES),
      "none",
      { required: true, severity: "info" },
    ),
    workRevision: tolerant(
      diagnostics,
      data,
      "workRevision",
      taskFrontmatterFields.workRevision,
      null,
    ),
    // Ruling 388: absent on every file written before it existed, which reads
    // as "this task has delivered no files" — the truth for all of them.
    deliveredAt: tolerant(
      diagnostics,
      data,
      "deliveredAt",
      taskFrontmatterFields.deliveredAt,
      null,
    ),
    // Per-ROW (F18): one malformed verdict drops only itself, never the whole
    // list — a whole-array wipe of recorded reviewer approvals would persist on
    // the next write and silently revert review state.
    verdicts: tolerantRows(
      diagnostics,
      data,
      "verdicts",
      taskFrontmatterFields.verdicts.element,
    ),
    // Ruling 132: per-ROW for the same reason as verdicts — a recorded base
    // refresh is what keeps a clean merge from counting as authored drift, so
    // losing the whole list on one bad row would silently re-flag every
    // refreshed PR. Absent reads `[]`, silently.
    baseRefreshes: tolerantRows(
      diagnostics,
      data,
      "baseRefreshes",
      taskFrontmatterFields.baseRefreshes.element,
    ),
    branch: tolerant(
      diagnostics,
      data,
      "branch",
      taskFrontmatterFields.branch,
      null,
    ),
    // P13-D-5: no `repo` read — the task-level override is gone.
    pr: tolerant(diagnostics, data, "pr", taskFrontmatterFields.pr, null),
    // R17-2: absent means "not a no-change completion" — never a diagnostic.
    noChanges: tolerant(
      diagnostics,
      data,
      "noChanges",
      taskFrontmatterFields.noChanges,
      undefined,
    ),
    // N20-14: absent means "not force-accepted" — never a diagnostic.
    acceptance: tolerant(
      diagnostics,
      data,
      "acceptance",
      taskFrontmatterFields.acceptance,
      undefined,
    ),
    // Ruling 226: absent means "no override was granted" — never a diagnostic.
    headCheckWaiver: tolerant(
      diagnostics,
      data,
      "headCheckWaiver",
      taskFrontmatterFields.headCheckWaiver,
      undefined,
    ),
    github: tolerant(
      diagnostics,
      githubWithCleanCommits(diagnostics, data),
      "github",
      taskFrontmatterFields.github,
      null,
    ),
    // Ruling 99: absent means "not part of a goal chain" — never a diagnostic.
    goalRef: tolerant(
      diagnostics,
      data,
      "goalRef",
      taskFrontmatterFields.goalRef,
      null,
    ),
    createdAt: tolerant(
      diagnostics,
      data,
      "createdAt",
      taskFrontmatterFields.createdAt,
      null,
    ),
    updatedAt: tolerant(
      diagnostics,
      data,
      "updatedAt",
      taskFrontmatterFields.updatedAt,
      null,
    ),
    boardRank: tolerant(
      diagnostics,
      data,
      "boardRank",
      taskFrontmatterFields.boardRank,
      null,
    ),
  };

  const unknown: RawFrontmatter = {};
  for (const [k, v] of Object.entries(data)) {
    // The legacy engagement slots (`specialist`/`reviewers`/`consultants`) are
    // NOT excluded here any more: their absorption was deleted with the
    // dynamic-dispatch rework (ruling 98), so they are ordinary unknown keys —
    // preserved verbatim on round-trip, read by nothing. (The old exclusion
    // existed only so an absorbed slot would not be emitted in both forms.)
    if (!TASK_FRONTMATTER_KEY_SET.has(k)) {
      unknown[k] = v;
    }
  }

  return { frontmatter, unknown, diagnostics };
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
  // Ruling 99: the instance controller writing on a task thread (briefing an
  // agent, publishing chain progress). Encoded as the bare word `controller`,
  // the same shape as `operator`.
  | { kind: "controller" }
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
/** Long enough for a real citation sentence ("app/app.css.test.ts — 89/89
 *  passed (vitest, node environment)") without becoming a dump: at 120 the
 *  cap chopped verdict rows mid-word and the tail was lost from the FILE, so
 *  no surface could recover it. Rows re-enter every agent prompt, so the
 *  ceiling stays bounded — 8 rows x 200 is the worst case. */
const EVIDENCE_LABEL_MAX_CHARS = 200;
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

/** One cell of an agent- or server-supplied row, as it arrives: unparsed JSON.
 *  A string passes through, an absent cell reads empty, and any other value is
 *  rendered rather than dropped (a count routinely arrives as a number). */
const evidenceCellSchema = z
  .string()
  .catch(({ value }) => (value == null ? "" : String(value)));

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
  const flat = (text: string, max: number, stripSeparator: boolean): string => {
    let s = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (stripSeparator) s = s.split(" · ").join(" ").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const out: EvidenceRow[] = [];
  for (const row of rows) {
    const label = flat(
      evidenceCellSchema.parse(row.label),
      EVIDENCE_LABEL_MAX_CHARS,
      false,
    );
    if (!label) continue; // an unlabeled row cites nothing
    const column = (cell: string) =>
      flat(cell, EVIDENCE_COUNT_MAX_CHARS, true) || EVIDENCE_EMPTY_COLUMN;
    out.push({
      label,
      add: column(evidenceCellSchema.parse(row.add)),
      del: column(evidenceCellSchema.parse(row.del)),
    });
    if (out.length >= EVIDENCE_MAX_ROWS) break;
  }
  return out.length > 0 ? out : null;
}

/** Name/count caps for an event's `attachments:` list — REFERENCES into the
 *  task's `attachments/` dir, so they stay small by construction (the files
 *  themselves live on disk; the panel and the timeline chips resolve names
 *  against the live directory). */
export const EVENT_ATTACHMENTS_MAX = 20;
const ATTACHMENT_NAME_MAX_CHARS = 200;

/**
 * Sanitize the attachment names a run produced into a list that round-trips
 * through the task.md serializer (one `- <name>` line each; the parser trims
 * the line, so a name that trims differently cannot survive) and that the
 * serving route would accept (a path separator would 404 there anyway).
 * Returns null when nothing usable survives — callers then omit the field.
 */
export function sanitizeEventAttachmentNames(
  names: readonly string[] | null | undefined,
): string[] | null {
  if (!names || names.length === 0) return null;
  const unwritable = (name: string): boolean => {
    for (const ch of name) {
      if (ch === "/" || ch === "\\") return true; // the serving route 404s these
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return true; // a newline would forge a row
    }
    return false;
  };
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || name !== raw) continue; // must round-trip the parser's trim
    if (name.length > ATTACHMENT_NAME_MAX_CHARS) continue;
    if (unwritable(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= EVENT_ATTACHMENTS_MAX) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Ruling 317: the title on a comment that is a verdict's full justification.
 *
 * `clipVerdictReason` stores 2,000 characters of it and appends "Its full
 * report is on this task's timeline, whole." That promise holds only while the
 * timeline keeps the comment, and compaction folds comments — so the comment
 * says what it is, and compaction reads the title.
 *
 * Lives here because the writer is a server action and the reader is the
 * compaction pass, and neither should import the other.
 */
export const VERDICT_REPORT_TITLE = "Review verdict";

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
  /** Files this event's run saved into the task's `attachments/` dir (browser
   *  captures). Optional: most writers never produce files, and an absent field
   *  serializes to nothing. Names only — the directory stays the truth. */
  attachments?: string[];
  /**
   * Ruling 382 (F39-9): the people this event's own notification fan-out
   * REACHED, routing preferences applied. Written by whichever writer fanned
   * the event out, and read by compaction, which never folds an event that
   * notified somebody: viberr told a person "this is here", and the pointer has
   * to still lead somewhere.
   *
   * Absent on almost every event (most notify nobody) and an absent field
   * serializes to nothing, so no existing task file changes.
   */
  notified?: string[];
}

/** Full parsed task file (see app/server/files/task-file.server.ts). */
export interface ParsedTaskFile {
  frontmatter: TaskFrontmatter;
  unknownFrontmatter: RawFrontmatter;
  goal: string;
  packet: TaskPacket | null;
  /** Newest first. */
  timeline: TaskFileEvent[];
  /** Unrecognized `## Section` blocks, preserved verbatim in order. */
  extraSections: { title: string; raw: string }[];
}
