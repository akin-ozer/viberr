import { z } from "zod";
import { liveMergeable } from "~/features/github/github-pills";
import type {
  AgentRef,
  ForeignBranchHead,
  GithubCache,
  OperatorRef,
  PacketObservation,
  PacketOption,
  PrChecks,
  PrMergeable,
  PrRef,
  PrReviewState,
  Readiness,
  TaskPacket,
  TaskPriority,
  Validation,
  Waiting,
} from "~/schemas/task-file.schema";
import type { ActorRender } from "./actor.server";
import type { DependencyRender } from "~/shared/dependencies";
import { goalDraftForOption } from "~/shared/packet-goal-draft";
import { acceptanceAnswerOf } from "~/shared/packet-acceptance-answer";

/** Pass-25: the stored `labels_json` is a JSON string-array (the write path
 *  normalizes it so). Parse it at this read boundary through the schema — a
 *  malformed or corrupt value yields no labels rather than throwing. */
const TASK_LABELS_SCHEMA = z.array(z.string()).catch([]);
export function parseTaskLabels(labelsJson: string): string[] {
  try {
    return TASK_LABELS_SCHEMA.parse(JSON.parse(labelsJson));
  } catch {
    return [];
  }
}

/** Ruling 45: the pending occurrences of `schedules_json`, at this read
 *  boundary and through a schema, for the same reason labels are — a corrupt
 *  value yields no time rather than throwing on a loader path. Only `dueAt`
 *  and `status` are read; the rest of the occurrence belongs to the schedule
 *  runner, not to a card. */
const PENDING_SCHEDULES_SCHEMA = z
  .array(z.object({ dueAt: z.string(), status: z.string() }).loose())
  .catch([]);

/**
 * The instant a clock-resting task picks itself back up: the EARLIEST pending
 * occurrence, because that is the one that will fire first and therefore the
 * only one a reader is owed. Null when nothing is pending — which the caller
 * has already ruled out via `waiting`, so this is the belt to that braces.
 */
function nextScheduleDueAt(schedulesJson: string): string | null {
  let parsed: { dueAt: string; status: string }[];
  try {
    parsed = PENDING_SCHEDULES_SCHEMA.parse(JSON.parse(schedulesJson));
  } catch {
    return null;
  }
  const due = parsed
    .filter((o) => o.status === "pending")
    .map((o) => o.dueAt)
    .filter((at) => !Number.isNaN(Date.parse(at)))
    .sort();
  return due[0] ?? null;
}
import {
  agentRoleDisplay,
  decodeActorRef,
  systemIdToName,
} from "~/server/files/actor-ref.server";
import { AGENT_QUESTION_PACKET_KIND } from "~/server/tasks/agent-outcome.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { canAcceptFromStage } from "~/shared/workflow/stage-roles";

/**
 * Centralized snake_case → camelCase mapping for `task_projections` and the
 * board/detail render shapes consumed by Phase 4/5 loaders.
 */

/** A type alias, not an interface, so a `SELECT`-row assertion is checked
 *  against SQLite's own output types instead of being laundered through
 *  `unknown` first (only a type alias gets the implicit index signature). */
export type TaskProjectionRow = {
  project_slug: string;
  task_key: string;
  title: string;
  stage: string;
  readiness: Readiness;
  stored_readiness: string | null;
  waiting: Waiting;
  urgent: 0 | 1;
  priority: TaskPriority;
  labels_json: string;
  due_date: string | null;
  /** Ruling 55 (pass 34): the task file's `blockedBy` list, verbatim JSON. */
  blocked_by_json: string;
  /** Ruling 45: the task file's `schedules` list, verbatim JSON. Read only to
   *  answer WHEN a clock-resting task picks itself back up — the projected
   *  `waiting` already answers WHETHER. */
  schedules_json: string;
  archived: 0 | 1;
  validation: Validation;
  validation_block_reason: string | null;
  /** N20-14 (§5c): 'forced' when a human force-accepted past the verdict gate. */
  acceptance: "forced" | null;
  /** D4 (C-CONTINUITY): 'degraded' when this task's timeline carries a
   *  `continuity` event (a resumed session whose provider transcript was gone),
   *  NULL otherwise. */
  continuity: "degraded" | null;
  owner_user_id: string | null;
  specialist_json: string | null;
  reviewers_json: string;
  operator_json: string | null;
  branch: string | null;
  repo: string | null;
  pr_json: string | null;
  github_json: string | null;
  /** Ruling 97: the delivered revision's head sha, NULL before delivery. */
  work_revision_sha: string | null;
  goal: string;
  /** Ruling 272: the epic this task belongs to (NULL when in none). */
  epic_id: string | null;
  packet_json: string | null;
  /** Pending operator recommendations on the task file (F7-NOTIF1). */
  recommendation_count: number;
  /** F37-71: their distinct kinds, sorted and comma-joined ('' for none). */
  recommendation_kinds: string;
  event_count: number;
  comment_count: number;
  diagnostic_count: number;
  created_at: string | null;
  updated_at: string | null;
  board_rank: number | null;
  source_path: string;
  content_hash: string;
  parsed_at: string;
};

/** One deployed specialist as the run and the display agree on it: the backend
 * a run started now would use, and the profile's current display name. Built
 * by `deployedSpecialistIdentities` (server/agents/deployment-view), consumed
 * by `withLiveAgentIdentities` below. */
export interface LiveAgentIdentity {
  backend: "codex" | "claude";
  name: string;
}

/** Agent chip render shape (mock AgentActor + the profile-id join key). */
export interface AgentRender {
  kind: "agent";
  profileId: string;
  backend: "codex" | "claude";
  /** "Codex" | "Claude". */
  name: string;
  role: string;
  /** The deployed profile's display name ("Developer"), written by
   *  `withLiveAgentIdentities` from the live deployment — the engagement row
   *  in task.md stores no name. `null` when the profile is no longer deployed
   *  (the role stands in on the card); absent on a render built by hand. */
  profileName?: string | null;
  /** F27-B1: a stuck retry pin. When set, `withLiveAgentIdentities` does NOT
   *  overlay the live profile backend — the run follows the pin, so the card
   *  must too. */
  pinnedBackend?: "codex" | "claude" | null;
  /** U35-5 (pass 35): true when this engagement is a REQUIRED reviewer (an
   *  explicit `report-validation-verdict: direct` grant snapshotted at engage
   *  time, F10-15). The review queue's review-work test reads it: a task
   *  whose required reviewer has not approved the current revision is review
   *  work wherever its stage is. Optional like `pinnedBackend`:
   *  `mapAgentRef` always sets it, and a render built by hand without it
   *  reads as not verdict-capable, which fails CLOSED (the row is not
   *  claimed as review work on the strength of a missing key). */
  verdictCapable?: boolean;
}

/** Operator cell render (ruling 295: stage id stored). */
export interface OperatorRender {
  name: "Operator";
  assignedAtStageId: string;
  /** 1-based index into the project's stage list; null if unknown stage. */
  sinceStageIndex: number | null;
  /** "since Ready" — precomputed display copy using the REAL stage name
   * (F7-UI2: "stage 2" was a bare index, dishonest for renamed stages). */
  sinceLabel: string;
}

export interface PacketRender {
  /** F10-09: the packet's id (spread from the file by `mapPacket`), which a
   *  notification about it names (ruling 75). Absent on a packet written
   *  before ids. */
  id?: string;
  type: "input" | "blocked";
  /** Pill label, e.g. "Completion report" | "Blocked decision". */
  kind: string;
  /** Display name of the raising actor ("Operator"). */
  from: string;
  title: string;
  body: string;
  observations: PacketObservation[];
  options: PacketOption[];
  /** Ruling 63: an `edit_goal` decision was confirmed and the packet waits
   *  for the edited goal to land. */
  awaiting?: "goal_edit";
  /** Ruling 63: which option was chosen, by whom and when — what a reload
   *  renders as decided and rebuilds the goal draft from. */
  decided?: TaskPacket["decided"];
  /** F35-6: the goal text the decided `edit_goal` option asks for, composed
   *  ONCE here (`goalDraftForOption` on the chosen option) and read by every
   *  door into the goal editor: the decided card renders it and its "Edit the
   *  goal" opens with it, and the hero's own Edit seeds from it while the
   *  packet waits. Present exactly when `awaiting` is `goal_edit` and a
   *  decision is recorded; absent otherwise. */
  goalDraft?: string;
  /** Ruling 316: the title of the option a plain acceptance (Accept, a stage
   *  move into the terminal stage, an applied acceptance card) ANSWERS this
   *  decision with. Absent when that acceptance withdraws it (F32-11). Derived
   *  here by `acceptanceAnswerOf`, the predicate the server's write uses, so
   *  the accept dialog reads the loader's answer and never guesses. */
  acceptAnswersWith?: string;
  /** Ruling 316: the same for a forced acceptance (the Force accept button). */
  forceAnswersWith?: string;
  /** Ruling 68 (F40-31): the agent a person's answer to this packet goes
   *  back to, by name: set on an agent's question (`askedBy`), which
   *  `resolvePacket` routes to the asker rather than to the operator. The
   *  card names the answer box after it. Absent on every other packet. */
  answerTo?: string;
}

/** What a surface renders for readiness: the canonical stored enum plus the
 * derived states no file holds — the terminal pair "accepted" (human accepted;
 * PR merge may still be pending) and "merged" (the review PR really merged,
 * F7-UI3), and "agent_working" (an agent is carrying the task; see
 * `deriveDisplayReadiness`). Feed it straight into ReadinessPill. */
export type DisplayReadiness =
  | Readiness
  | "accepted"
  | "merged"
  | "agent_working"
  /** Ruling 63: a decided `edit_goal` packet owes a goal edit. */
  | "goal_edit_pending"
  /** Ruling 44: the agent carrying the task is parked behind the instance's
   *  concurrent-run cap — nothing is streaming yet. Derived by `withLiveRun`
   *  from the run row, which is the only surface that holds the fact. */
  | "agent_queued";

/** Ruling 44: what a live run row says about the run carrying a task. */
export type LiveRunState = "queued" | "running";

/** Board-card / summary shape. `readiness` is always the canonical stored enum
 * — the acceptance gate and the board attention filter read THAT; only
 * rendering reads `displayReadiness`. */
export interface TaskSummary {
  projectSlug: string;
  key: string;
  title: string;
  stage: string;
  readiness: Readiness;
  displayReadiness: DisplayReadiness;
  waiting: Waiting;
  /** R8-3: does an open decision on this task require THE VIEWING USER's action?
   * Loader-annotated (the projection has no viewer context) — the board's
   * "Waiting on me" chip + per-card badge read this, member-scoped, instead of
   * the project-wide `waiting === "human"` enum. */
  waitingOnMe?: boolean;
  /** Ruling 44: the state of the run carrying this task, when one is live —
   *  `queued` behind the concurrent-run cap or `running`. Loader-annotated from
   *  the run rows (the projection has no run context); null when no run is
   *  live, undefined where no loader annotated it. */
  liveRun?: LiveRunState | null;
  /**
   * Ruling 45 (F37-45): when this task rests on a clock (`waiting:
   * "schedule"`), the instant it picks itself back up — so the card can say
   * so instead of naming a person who has nothing to do. Null for every other
   * waiting state, INCLUDING a task that carries a pending schedule while a
   * human decision is also open: there the decision is the answer, and this
   * would only compete with it.
   */
  resumesAt?: string | null;
  urgent: boolean;
  /** Pass-25 task metadata. */
  priority: TaskPriority;
  labels: string[];
  dueDate: string | null;
  /** Ruling 55 (pass 34): what this task waits on, each entry resolved to its
   *  state at READ time by the query layer (`dependencyResolver`, once per
   *  query), never by this mapper and never cached. Empty when the task waits
   *  on nothing. */
  blockedBy: DependencyRender[];
  /** R14-3: archived tasks leave every default view but keep their record. */
  archived: boolean;
  validation: Validation;
  /** N20-14 (§5c): 'forced' when a human force-accepted this task past the
   *  verdict gate — a durable override fact, not recomputed by deriveValidation.
   *  Carried so the hero/card display arm (C-VOCAB) can render "accepted · gate
   *  bypassed" instead of the stale "awaiting verdict". */
  acceptance?: "forced" | null;
  /**
   * D4 (C-CONTINUITY): runtime-continuity health as a task-level fact.
   * 'degraded' when this task's timeline carries a `continuity` event — a
   * resumed provider session whose transcript was gone, so the agent re-anchored
   * on `task.md` and continued fresh — else null. Projected (not loader-derived)
   * so the board card, the "Degraded continuity" board filter and the review row
   * read the SAME state the Continuity Recovery panel shows on the task page.
   * The panel's finer recovery progress (running/recovered/stalled) lives in the
   * run projection and stays on the panel; this is the coarse, persistent fact.
   */
  continuity: "degraded" | null;
  /** Revision-bound acceptance block reason (P11-50): null when the current
   *  revision is acceptance-ready, else why it isn't. Projected so read models
   *  (review queue) don't re-read task files on a loader path. */
  blockReason: string | null;
  /**
   * F19-27 — does this task stand where a completion may be accepted FROM?
   *
   * The STAGE gate, and only that: `acceptanceStageBlockedReason`
   * (task-acceptance.server.ts) is the one acceptance refusal `blockReason` above
   * deliberately leaves out (see `acceptanceBlockReason`, rebuilder.server.ts),
   * because it turns on the PROJECT's workflow graph rather than anything in the
   * task file. So a board drag from the entry stage straight into the terminal
   * one opened a confident accept dialog with no blocked row and the server then
   * refused the click with a 409. Projected here — `isAtAcceptanceBoundary`
   * mirrors the server predicate against the same stages + edges — so the
   * client can answer it without the graph.
   *
   * NOT the same as `AcceptanceAffordance.atBoundary`, which folds in the
   * archived check; an archived task has its own row, from its own shared
   * predicate (`archivedTaskBlockedReason`).
   */
  atAcceptanceBoundary: boolean;
  owner: ActorRender | null;
  specialist: AgentRender | null;
  reviewers: AgentRender[];
  operator: OperatorRender | null;
  branch: string | null;
  repo: string | null;
  pr: PrRef | null;
  /** P13-D-28: CI health for the PR head commit — feeds the checks pill next to
   *  the PR pill. Null = no PR / never read / no CI on the commit. */
  prChecks: PrChecksRender | null;
  /** P13-D-28: GitHub review verdict on an OPEN PR — feeds the review pill.
   *  Null = no PR / settled PR / never read / nothing outstanding. */
  prReview: PrReviewState | null;
  /** Ruling 236 (pass 37): `pushed` says whether the REMOTE has the commit,
   *  stamped by the reconciler from a complete compare. Absent = not judged,
   *  which is neither answer and must render as neither. */
  commits: { sha: string; msg: string; pushed?: boolean }[];
  /** Ruling 315 (pass 36, F36-7): commits on the branch that are NOT this
   *  task's (no `[KEY]` prefix) — the moved head a person must see where the
   *  acceptance decision is made. Empty when none were recorded. */
  otherCommits: { sha: string; msg: string }[];
  changed: { files: number; add: number; del: number } | null;
  /** R15-15 / F31-6: a PR found on this task's branch that this task did NOT
   *  open — the branch-collision signature. Null = no collision recorded. */
  unownedPr: number | null;
  /** Ruling 234 (pass 35, U35-8): origin's copy of the branch carries commits
   *  this task did not author, as the reconciler last recorded it. The archive
   *  ceremony's delete-branch disclosure names it. Null = the head is this
   *  task's, or was never read. */
  foreignHead: ForeignBranchHead | null;
  /**
   * Ruling 97 — the DELIVERED revision's head sha, or null before
   * delivery.
   *
   * The board's acceptance ceremony (board-accept-confirm.tsx `AcceptOnBoardConfirm`) is
   * the same dialog the task page renders, and must disclose what it accepts;
   * the confirmed click echoes that disclosure back for the server to compare
   * against the live task. A board
   * card holds nothing but this summary, so the ceremony had to disclose "No
   * delivered revision recorded." on every task — and the server refused the
   * resulting `"none"` echo as stale on any task that HAD delivered, i.e. a
   * board drop onto the terminal stage could never accept delivered work.
   *
   * The task page reads the same fact straight off the task file
   * (routes/project.task.tsx) because it already holds the file; both derive it
   * from `workRevision.headSha`, which is also what the server compares against
   * (`acceptanceDisclosureOf`). One fact, one expression, three readers.
   *
   * Optional like `acceptance` above, and safe to be: `mapTaskProjectionRow`
   * always sets it, and an absent value degrades to the honest "no revision"
   * row, which fails CLOSED — the server refuses that echo against a task that
   * really has one, and `acceptanceDisclosureDrift` never treats "none" as a
   * wildcard. So the worst a caller constructing this shape by hand can do is
   * disclose less and be refused, never disclose less and merge.
   */
  workRevisionSha?: string | null;
  goal: string;
  /** Ruling 272: the epic this task belongs to (`epic-3`), or null. Optional
   *  like `acceptance` above: `mapTaskProjectionRow` always sets it, and an
   *  absent value reads as "in no epic". The epic's title and colour are read
   *  from the project's epics where a surface draws them (`listEpics`). */
  epicId?: string | null;
  packet: PacketRender | null;
  eventCount: number;
  commentCount: number;
  diagnosticCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Sparse board-order rank (null → fall back to the task-key number). */
  boardRank: number | null;
  /** Store-relative path — the UI renders this real path (ruling 15(a)). */
  filePath: string;
}

/**
 * P13-D-28 — the rolled-up CI verdict for the PR head commit. Deliberately a
 * DATA rollup (no pill kind, no label): the pill vocabulary lives client-side in
 * `app/features/github/github-pills.ts`, and a second server-side mapping is the
 * duplicate that module's header records as already removed once.
 *
 *   failing — at least one check-run concluded failure/timed_out/cancelled/
 *             action_required
 *   pending — nothing failed but at least one run has no conclusion yet
 *   unknown — nothing failed, nothing is running, and some of the runs the head
 *             commit reported could not be read (F21-7)
 *   passing — every run concluded success/neutral/skipped
 */
export type PrChecksState = "passing" | "failing" | "pending" | "unknown";

export interface PrChecksRender extends PrChecks {
  state: PrChecksState;
  /** How many of `total` are unaccounted for — 0 on a clean read. Drives the
   *  "N/M checks unknown" label; see {@link mapPrChecks}. Optional so the
   *  render shape stays constructible from the four persisted counters alone. */
  unknown?: number;
}

/** The drift count as it comes off the LOOSE persisted `checks` object — a
 *  count or nothing, and anything else reads as nothing. Parsed here because
 *  this is that key's boundary: `prChecksSchema` keeps unmodeled keys as-is. */
const recordedUnknownChecks = z.number().int().min(0).catch(0);

/**
 * F21-7 — the runs `total` claims that no counter accounts for.
 *
 * Two sources, and the LARGER wins: the `unknown` count the linker recorded,
 * and the arithmetic shortfall of the three counters against `total`. The
 * second is the belt: a summary written before this counter existed — or by any
 * other writer — still cannot present unaccounted runs as passing.
 */
function unaccountedChecks(checks: PrChecks): number {
  const recorded = recordedUnknownChecks.parse(checks.unknown);
  const shortfall =
    checks.total - (checks.passing + checks.failing + checks.pending);
  return Math.max(recorded, shortfall, 0);
}

/**
 * Ruling 237 (pass 37, F37-109): has GitHub's check state ever been READ for
 * this PR?
 *
 * `prRefSchema` keeps the two apart on purpose — an absent `checks` key is
 * "never read", a present one with `total: 0` is "read, and GitHub reported no
 * check runs" — and its own comment says so in as many words. `mapPrChecks`
 * collapses both to null because a display has nothing to draw either way, and
 * every reader inherited that collapse, including the one reader for whom the
 * difference is the whole answer: "no CI is configured" and "we have not
 * looked" call for opposite next moves.
 */
export function prChecksRead(pr: PrRef | null): boolean {
  return pr?.checks !== undefined && pr.checks !== null;
}

/** Ruling 237: the refused read, as the GitHub view's data and the
 *  controller's `get_github_state` carry it (no pill prints it). */
export interface PrChecksUnread {
  status: number | null;
  message: string;
  /** Ruling 236: when this refusal was first seen, not the last pass that met it. */
  at: string;
}

/** Ruling 237: the refusal stands only while nothing was ever read; a summary
 *  (even `total: 0`) outranks it, and the reconciler drops the key then. */
export function mapPrChecksUnread(pr: PrRef | null): PrChecksUnread | null {
  if (!pr || prChecksRead(pr) || !pr.checksUnread) return null;
  return { status: pr.checksUnread.status, message: pr.checksUnread.message, at: pr.checksUnread.at };
}

/**
 * Null when there is nothing honest to draw: no PR, GitHub never read (the
 * `checks` key is absent — see the schema), or the head commit genuinely ran no
 * checks (`total: 0`, i.e. the repo has no CI). "Zero checks" must not render as
 * a green passing pill.
 *
 * Neither may runs nobody could read: `passing` is reserved for a summary where
 * every one of `total` runs was counted and concluded well. The precedence is
 * the worst TRUE statement first — failing, then still-running, then unknown.
 */
export function mapPrChecks(pr: PrRef | null): PrChecksRender | null {
  const checks = pr?.checks;
  if (!checks || checks.total <= 0) return null;
  const unknown = unaccountedChecks(checks);
  const state: PrChecksState =
    checks.failing > 0
      ? "failing"
      : checks.pending > 0
        ? "pending"
        : unknown > 0
          ? "unknown"
          : "passing";
  return { ...checks, unknown, state };
}

/**
 * P13-D-28 — GitHub's review verdict, surfaced ONLY while the PR is still open
 * (`review`) or accepted-with-merge-pending. A verdict frozen next to a
 * "merged"/"closed" PR pill is stale by construction; the reconciler already
 * clears it, this is the second belt.
 */
export function mapPrReview(pr: PrRef | null): PrReviewState | null {
  if (!pr?.review) return null;
  return pr.state === "review" || pr.state === "accepted" ? pr.review : null;
}

/** F17-L6: GitHub's mergeability, shown only for an OPEN (review/accepted) PR —
 *  a settled (merged/closed) PR's conflict state is moot. Same state gate as
 *  {@link mapPrReview}.
 *
 *  Ruling 242: and only while the verdict still belongs to the head that is
 *  live. A "conflicts" pill painted over the commit that RESOLVED the conflict
 *  is the same lie the acceptance gate used to tell, one surface over, so both
 *  read the pin (`conflictingPrBlockedReason` is the gate). GitHub recomputes
 *  after a push, so the honest display in that window is no pill at all. */
export function mapPrMergeable(pr: PrRef | null): PrMergeable | null {
  const live = liveMergeable(pr);
  if (!live) return null;
  return pr!.state === "review" || pr!.state === "accepted" ? live : null;
}

/**
 * F19-27 — the client-answerable half of `acceptanceStageBlockedReason`
 * (task-acceptance.server.ts): may a completion be accepted FROM `stageId`? It is
 * the server's own predicate (`canAcceptFromStage`), projected so the board
 * can answer it without the graph, so the two cannot drift.
 */
export const isAtAcceptanceBoundary = canAcceptFromStage;

function mapAgentRef(ref: AgentRef | null): AgentRender | null {
  if (!ref) return null;
  return {
    kind: "agent",
    profileId: ref.profileId,
    backend: ref.backend,
    name: BACKEND_LABEL[ref.backend],
    role: ref.role,
    profileName: null,
    pinnedBackend: ref.pinnedBackend ?? null,
    // U35-5: the projection stores the whole engagement (rebuilder
    // `supportingEngagements`), whose parser defaults the flag to false; an
    // absent key here is a hand-built ref and reads as not verdict-capable.
    verdictCapable: ref.verdictCapable === true,
  };
}

/**
 * Overlay the LIVE deployment backend onto a summary's engaged agents (owner
 * report 2026-08-21: the exec profile said "Codex" after the Developer profile
 * was switched to Claude — Run would have started a Claude run under a card
 * labeled Codex).
 *
 * The engagement rows in task.md snapshot the backend at engage time and the
 * run start heals them only when the next run actually happens
 * (specialist-run.server.ts), so between a profile edit and that run the
 * snapshot lies about what Run does. This patches specialist + reviewers from
 * the live `profileId → { backend, name }` map (`deployedSpecialistIdentities`
 * in server/agents/deployment-view — the same primary-backend rule the run
 * resolves with, and the same name rule the roster displays with); a profile
 * absent from the map (undeployed since engagement) keeps its snapshot,
 * exactly the run path's own fallback. Pure — the map is built by the server
 * query layer, so board, review queue and task detail all inherit one answer.
 *
 * The profile NAME rides the same overlay (owner, 2026-09-08): the engagement
 * row stores the role, and the board card printed it — "Claude ·
 * Implementation" — where every other surface says "Developer".
 */
export function withLiveAgentIdentities(
  summary: TaskSummary,
  live: ReadonlyMap<string, LiveAgentIdentity>,
): TaskSummary {
  if (live.size === 0) return summary;
  const patch = (agent: AgentRender): AgentRender => {
    const deployed = live.get(agent.profileId);
    if (!deployed) return agent;
    // F27-B1: a STUCK retry pin wins over the live profile BACKEND — the run
    // resolves to it (specialist-run backend resolution), so the card must
    // show it too. The pin says nothing about the profile's name, which still
    // follows the deployment.
    const backend = agent.pinnedBackend ? agent.backend : deployed.backend;
    if (backend === agent.backend && (agent.profileName ?? null) === deployed.name) return agent;
    return { ...agent, backend, name: BACKEND_LABEL[backend], profileName: deployed.name };
  };
  const specialist = summary.specialist ? patch(summary.specialist) : null;
  const reviewers = summary.reviewers.map(patch);
  if (
    specialist === summary.specialist &&
    reviewers.every((r, i) => r === summary.reviewers[i])
  ) {
    return summary;
  }
  return { ...summary, specialist, reviewers };
}

function mapOperatorRef(
  ref: OperatorRef | null,
  stages: { id: string; name: string }[],
): OperatorRender | null {
  if (!ref) return null;
  const idx = stages.findIndex((s) => s.id === ref.assignedAtStageId);
  const sinceStageIndex = idx === -1 ? null : idx + 1;
  return {
    name: "Operator",
    assignedAtStageId: ref.assignedAtStageId,
    sinceStageIndex,
    // The real stage NAME (F7-UI2) — an unknown/removed stage id renders a
    // plain admission rather than pretending a position.
    sinceLabel: idx === -1 ? "since a removed stage" : `since ${stages[idx]!.name}`,
  };
}

/**
 * THE display-readiness derivation — the one place a stored readiness becomes
 * the value every surface renders.
 *
 * Stored readiness answers "what does the FILE say", which is not always what
 * is true of the task right now. Two lifts close that gap, in this precedence:
 *
 * 1. AN AGENT IS CARRYING IT (R21-8, generalised). `waiting: "agent"` is the
 *    stored fact that an agent — not a human — is the task's next actor, and
 *    the same task actions that hand work to an agent write the pair together
 *    (`fm.waiting = "agent"; fm.readiness = "ready"` — retry-on-other-backend,
 *    re-engage-specialist, unblock-on-policy in packet-resolution.server.ts). So the
 *    readiness slot claimed a state the run contradicted:
 *      · `input_required` claimed a human was needed RIGHT NOW — the case the
 *        owner reported, fixed by R21-8;
 *      · `ready` painted the app's green all-clear over work whose outcome is
 *        not known yet — the SAME defect, in the state that actually dominates
 *        (the triage gate clears `input_required` on leaving the entry stage,
 *        which is exactly when agents start working), left behind because
 *        R21-8 was written against the one value the report happened to show.
 *    Both now read "agent working". `blocked` and `inconsistency_risk_detected`
 *    never yield — a run does not answer those (R21-8, unchanged) — with one
 *    exception, ruling 54 (F35-8): a stored `blocked` with no open packet and
 *    no dependency list is a HOLD (the `hold_runtime_debug` decision, the
 *    refused arm of a collision ceremony), and a hold is what a person's
 *    operator run or a dispatch lifts on the record. While an agent carries
 *    such a hold the display reads "agent working", exactly as the server
 *    lifts it, so a card never says blocked and agent working together. The
 *    caller decides `carriedHold` from the STORED readiness and the
 *    dependency list, so a diagnostics floor (derived `blocked` over a stored
 *    `ready`) and a dependency hold (ruling 55's floor) keep reading
 *    `blocked`, and a `blocked` packet keeps the withdrawal paths as its lift.
 *
 * 2. A HUMAN OWES AN ANSWER. An `input` packet ("Decision required" / an
 *    agent's ask-human) is a request for human input, but the operator leaves
 *    `readiness` as-is when it opens one — only a `blocked` packet flips
 *    readiness to "blocked" (operator-packets.server: "Blocked-ness lives on
 *    readiness alone"). That left a green "ready" beside a "Decision required"
 *    packet. Raising a packet flips `waiting` to "human", so this lift is also
 *    the reassertion path out of lift 1: the human's turn outranks a run that
 *    is still winding down.
 *
 * Deriving here rather than per-surface is the point (rulings 237/297: a mapping
 * is never forked per surface). Both lifts used to live in the components —
 * one of them copy-pasted across three render sites with two different gates —
 * so extending either meant finding every copy, and a new surface inherited
 * whichever bug it forgot to reproduce. Surfaces now choose how to RENDER the
 * derived value; they no longer re-decide it.
 *
 * The STORED readiness, the acceptance gate and the board attention filter all
 * read `readiness`, never `displayReadiness`, and are untouched. Lift 2's
 * demand reaches the attention filter through the open packet itself, which
 * it reads beside `waiting` (ruling 46, `board-filters.ts`).
 */
function deriveDisplayReadiness(
  readiness: Readiness,
  waiting: Waiting,
  packet: TaskPacket | null,
  /** Ruling 54: the stored value is `blocked` and the task waits on no
   *  dependency, so a stored block with no packet is a hold a run outranks. */
  carriedHold: boolean,
): DisplayReadiness {
  if (readiness === "blocked" && waiting === "agent" && packet === null && carriedHold) {
    return "agent_working";
  }
  if (
    waiting === "agent" &&
    (readiness === "ready" || readiness === "input_required")
  ) {
    return "agent_working";
  }
  // Ruling 63: a decided `edit_goal` packet owes a goal edit — that wins over
  // `input_required` and over a stored `blocked` (saving the goal lifts the
  // blocked gate with it), but never over an agent carrying the task.
  if (packet?.awaiting === "goal_edit" && waiting !== "agent") {
    return "goal_edit_pending";
  }
  if (readiness === "ready" && waiting === "human" && packet?.type === "input") {
    return "input_required";
  }
  return readiness;
}

function mapPacket(packet: TaskPacket | null): PacketRender | null {
  if (!packet) return null;
  const { from, ...rest } = packet;
  // Spread, not a field list: the packet's own extra keys (`id`, `askedBy`, and
  // whatever the loose schema preserved) ride along untouched — only `from` is
  // swapped for its display name.
  const render: PacketRender = { ...rest, from: packetFromDisplay(from) };
  // F35-6: one draft source. The chosen option's draft is composed here, on
  // the mapping every surface reads, so the decided card, its "Edit the goal"
  // and the hero's Edit all open the same text after a reload.
  const chosen =
    packet.awaiting === "goal_edit" && packet.decided
      ? packet.options[packet.decided.optionIndex]
      : undefined;
  if (chosen) render.goalDraft = goalDraftForOption(chosen);
  // Ruling 316: which option each direct acceptance answers, set only when it
  // answers one, so a packet no acceptance answers ships no extra bytes.
  const accept = acceptanceAnswerOf(packet, "accept");
  if (accept) render.acceptAnswersWith = accept.option.t;
  const force = acceptanceAnswerOf(packet, "force");
  if (force) render.forceAnswersWith = force.option.t;
  // Ruling 68: the same predicate `resolvePacket` routes on.
  if (packet.kind === AGENT_QUESTION_PACKET_KIND && packet.askedBy?.trim()) {
    render.answerTo = render.from;
  }
  return render;
}

/** Human-readable packet author from the stored actor-ref codec string. Most
 * packets are operator-authored ("operator"); an agent-raised ask-human packet
 * (G3) carries the agent's own ref — decode it to a role/backend name rather
 * than leaking `agent:codex/reviewer (…)` to the task page. */
function packetFromDisplay(from: string): string {
  if (from === "operator") return "Operator";
  const ref = decodeActorRef(from);
  switch (ref.kind) {
    case "operator":
      return "Operator";
    case "agent":
      return agentRoleDisplay(ref);
    case "system":
      return systemIdToName(ref.systemId);
    case "human":
      return ref.nameHint ?? ref.userId;
    default:
      return from; // unknown ref — leave the raw string rather than blanking it
  }
}

/** The JSON columns a `task_projections` row carries, decoded. */
interface TaskProjectionColumns {
  specialist: AgentRef | null;
  reviewers: AgentRef[];
  operator: OperatorRef | null;
  github: GithubCache | null;
  pr: PrRef | null;
  packet: TaskPacket | null;
}

/** Decoded in one place because the six columns share one provenance — the
 *  projector's own `JSON.stringify` — and therefore one justification. */
function decodeProjectionColumns(row: TaskProjectionRow): TaskProjectionColumns {
  // SAFETY: every `*_json` column below has ONE writer — `rebuildTaskFile`
  // (server/projections/rebuilder.server.ts) stores `JSON.stringify` of the
  // frontmatter the task-file schema just parsed — so each column holds exactly
  // the type named here. The nullable columns are checked before their parse;
  // `reviewers_json` is NOT NULL and always a (possibly empty) array.
  return {
    specialist: row.specialist_json
      ? (JSON.parse(row.specialist_json) as AgentRef)
      : null,
    reviewers: JSON.parse(row.reviewers_json) as AgentRef[],
    operator: row.operator_json
      ? (JSON.parse(row.operator_json) as OperatorRef)
      : null,
    github: row.github_json ? (JSON.parse(row.github_json) as GithubCache) : null,
    pr: row.pr_json ? (JSON.parse(row.pr_json) as PrRef) : null,
    packet: row.packet_json ? (JSON.parse(row.packet_json) as TaskPacket) : null,
  };
}

export function mapTaskProjectionRow(
  row: TaskProjectionRow,
  context: {
    /** Project stages in order — id for position, name for display copy. */
    stages: { id: string; name: string }[];
    /** F19-27: the project's workflow edges — the ONLY source for the
     *  acceptance-boundary fact below. Empty is legal (a graph-less project
     *  resolves its roles positionally, exactly as the server does). */
    workflow: readonly { from: string; to: string }[];
    /** Resolved owner render shape (null when unowned/unknown). */
    owner: ActorRender | null;
    accepted: boolean;
    /** Ruling 55: the row's `blockedBy` list resolved by the caller. */
    blockedBy: DependencyRender[];
  },
): TaskSummary {
  const columns = decodeProjectionColumns(row);
  const specialist = mapAgentRef(columns.specialist);
  const reviewers = columns.reviewers
    .map((c) => mapAgentRef(c))
    .filter((c): c is AgentRender => c !== null);
  const operator = mapOperatorRef(columns.operator, context.stages);
  const { github, pr } = columns;

  return {
    projectSlug: row.project_slug,
    key: row.task_key,
    title: row.title,
    stage: row.stage,
    readiness: row.readiness,
    // Terminal-stage display state (F7-UI3): once the review PR is REALLY
    // merged the pill says "merged" — "accepted" is reserved for the
    // merge-pending window (or no-PR acceptance), so it never reads stale
    // next to the GitHub card's own "merged".
    displayReadiness: context.accepted
      ? pr?.state === "merged"
        ? "merged"
        : "accepted"
      : deriveDisplayReadiness(
          row.readiness,
          row.waiting,
          columns.packet,
          // Ruling 54: a hold is a STORED block with no dependency list; the
          // derived column may say `blocked` over a stored `ready` when a
          // diagnostic floors it, and that is not a hold a run may outrank.
          row.stored_readiness === "blocked" && context.blockedBy.length === 0,
        ),
    waiting: row.waiting,
    resumesAt: row.waiting === "schedule" ? nextScheduleDueAt(row.schedules_json) : null,
    urgent: row.urgent === 1,
    priority: row.priority,
    labels: parseTaskLabels(row.labels_json),
    dueDate: row.due_date,
    blockedBy: context.blockedBy,
    archived: row.archived === 1,
    validation: row.validation,
    acceptance: row.acceptance ?? null,
    continuity: row.continuity ?? null,
    blockReason: row.validation_block_reason,
    atAcceptanceBoundary: isAtAcceptanceBoundary(
      row.stage,
      context.stages,
      context.workflow,
    ),
    owner: context.owner,
    specialist,
    reviewers,
    operator,
    branch: row.branch,
    repo: row.repo,
    pr,
    prChecks: mapPrChecks(pr),
    prReview: mapPrReview(pr),
    commits: github?.commits ?? [],
    otherCommits: github?.otherCommits ?? [],
    changed: github?.changed ?? null,
    unownedPr: github?.unownedPr ?? null,
    foreignHead: github?.foreignHead ?? null,
    workRevisionSha: row.work_revision_sha,
    goal: row.goal,
    epicId: row.epic_id,
    packet: mapPacket(columns.packet),
    eventCount: row.event_count,
    commentCount: row.comment_count,
    diagnosticCount: row.diagnostic_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    boardRank: row.board_rank,
    filePath: row.source_path,
  };
}

/**
 * Ruling 44 (pass 38, F38-3): the display state reads the run row when the
 * task waits on an agent. `markWaitingAgent` writes `waiting: "agent"` for a
 * run the concurrency cap PARKED as much as for one that started (ruling 166
 * fixed the timeline sentence and the operator's reply, not this), so the
 * board card said "agent working" with a pulsing dot, the hero said the same
 * and the rail read "Agent work" while the console said "queued" and the
 * timeline said "Nothing is streaming yet". Measured on this instance before
 * the fix: 129 queued runs across 33 tasks, each one a card claiming work in
 * flight. The fact lives on the run row alone, so the loaders annotate it here,
 * in the one place display readiness is derived — never re-decided in a
 * component.
 */
export function withLiveRun<T extends TaskSummary>(
  task: T,
  liveRun: LiveRunState | null,
): T {
  const displayReadiness: DisplayReadiness =
    task.displayReadiness === "agent_working" && liveRun === "queued"
      ? "agent_queued"
      : task.displayReadiness;
  return { ...task, liveRun, displayReadiness };
}

/**
 * Ruling 166: why the queued run carrying a task waits, for the task page's
 * "Agent queued" title, built from the task's run rows as the console's footer
 * builds its own. A queued row's step, when it has one, is what the run waits
 * for before a slot: the summary of its session's last run, still being
 * compacted (ruling 175). A row with no step waits for a slot, and while any
 * of the task's parked runs does, the sentence names the cap.
 */
export function queuedRunWait(rows: readonly { state: string; step: string | null }[]): string {
  const parked = rows.filter((r) => r.state === "queued");
  const step = parked.every((r) => r.step !== null) ? parked[0]?.step : null;
  return step
    ? `Queued, ${step}; then it starts when a slot frees.`
    : "Behind the instance's concurrent-run cap; it starts when a slot frees.";
}
