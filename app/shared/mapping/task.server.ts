import type {
  AgentRef,
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
  Validation,
  Waiting,
} from "~/schemas/task-file.schema";
import type { ActorRender } from "./actor.server";
import {
  agentRoleDisplay,
  decodeActorRef,
  systemIdToName,
} from "~/server/files/actor-ref.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";

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
  goal: string;
  packet_json: string | null;
  /** Pending operator recommendations on the task file (F7-NOTIF1). */
  recommendation_count: number;
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

/** Agent chip render shape (mock AgentActor + the profile-id join key). */
export interface AgentRender {
  kind: "agent";
  profileId: string;
  backend: "codex" | "claude";
  /** "Codex" | "Claude Code". */
  name: string;
  role: string;
}

/** Operator cell render (ruling 16: stage id stored). */
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
  type: "input" | "blocked";
  /** Pill label, e.g. "Completion report" | "Blocked decision". */
  kind: string;
  /** Display name of the raising actor ("Operator"). */
  from: string;
  title: string;
  body: string;
  observations: PacketObservation[];
  options: PacketOption[];
}

/** Board-card / summary shape. `readiness` is always the canonical enum;
 * `displayReadiness` adds the derived terminal-stage states — "accepted"
 * (human accepted; PR merge may still be pending) and "merged" (the review
 * PR really merged, F7-UI3) — feed it straight into ReadinessPill. */
export interface TaskSummary {
  projectSlug: string;
  key: string;
  title: string;
  stage: string;
  readiness: Readiness;
  displayReadiness: Readiness | "accepted" | "merged";
  waiting: Waiting;
  /** R8-3: does an open decision on this task require THE VIEWING USER's action?
   * Loader-annotated (the projection has no viewer context) — the board's
   * "Waiting on me" chip + per-card badge read this, member-scoped, instead of
   * the project-wide `waiting === "human"` enum. */
  waitingOnMe?: boolean;
  urgent: boolean;
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
   * (task-actions.server.ts) is the one acceptance refusal `blockReason` above
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
  commits: { sha: string; msg: string }[];
  changed: { files: number; add: number; del: number } | null;
  goal: string;
  packet: PacketRender | null;
  eventCount: number;
  commentCount: number;
  diagnosticCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Sparse board-order rank (null → fall back to the task-key number). */
  boardRank: number | null;
  /** Store-relative path — the UI renders this real path (ruling 3). */
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
 *   passing — every run concluded success/neutral/skipped
 */
export type PrChecksState = "passing" | "failing" | "pending";

export interface PrChecksRender extends PrChecks {
  state: PrChecksState;
}

/**
 * Null when there is nothing honest to draw: no PR, GitHub never read (the
 * `checks` key is absent — see the schema), or the head commit genuinely ran no
 * checks (`total: 0`, i.e. the repo has no CI). "Zero checks" must not render as
 * a green passing pill.
 */
export function mapPrChecks(pr: PrRef | null): PrChecksRender | null {
  const checks = pr?.checks;
  if (!checks || checks.total <= 0) return null;
  const state: PrChecksState =
    checks.failing > 0 ? "failing" : checks.pending > 0 ? "pending" : "passing";
  return { ...checks, state };
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
 *  {@link mapPrReview}. */
export function mapPrMergeable(pr: PrRef | null): PrMergeable | null {
  if (!pr?.mergeable) return null;
  return pr.state === "review" || pr.state === "accepted" ? pr.mergeable : null;
}

/**
 * F19-27 — the client-answerable half of `acceptanceStageBlockedReason`
 * (task-actions.server.ts): may a completion be accepted FROM `stageId`?
 *
 * Same three questions the server asks, against the same `resolveStageRoles`
 * the server resolves the terminal/review ids with, so the two cannot drift:
 * acceptance is the human authority at the boundary the workflow puts before
 * the terminal stage, so it may only be exercised from a stage with a declared
 * edge into that stage (a custom board may have several) or from the resolved
 * review stage. Everything else must walk the graph first.
 *
 * True — not false — when there is no terminal stage to reason about or the
 * task is ALREADY terminal: the server refuses neither (its writers' idempotent
 * "already Done" return owns the second), and a projected `false` there would
 * put a refusal on a click the server would accept.
 */
export function isAtAcceptanceBoundary(
  stageId: string,
  stages: readonly { id: string }[],
  workflow: readonly { from: string; to: string }[],
): boolean {
  const { terminalId, reviewId } = resolveStageRoles(stages, workflow);
  if (terminalId === null || stageId === terminalId) return true;
  return (
    workflow.some((w) => w.from === stageId && w.to === terminalId) ||
    stageId === reviewId
  );
}

function agentBackendName(backend: "codex" | "claude"): string {
  return backend === "codex" ? "Codex" : "Claude Code";
}

export function mapAgentRef(ref: AgentRef | null): AgentRender | null {
  if (!ref) return null;
  return {
    kind: "agent",
    profileId: ref.profileId,
    backend: ref.backend,
    name: agentBackendName(ref.backend),
    role: ref.role,
  };
}

export function mapOperatorRef(
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
    // The real stage NAME (F7-UI2) — an unknown/removed stage id renders "—"
    // rather than pretending a position.
    sinceLabel: idx === -1 ? "since —" : `since ${stages[idx]!.name}`,
  };
}

export function mapPacket(packet: TaskPacket | null): PacketRender | null {
  if (!packet) return null;
  const { from, ...rest } = packet;
  // Spread, not a field list: the packet's own extra keys (`id`, `askedBy`, and
  // whatever the loose schema preserved) ride along untouched — only `from` is
  // swapped for its display name.
  const render: PacketRender = { ...rest, from: packetFromDisplay(from) };
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
      : row.readiness,
    waiting: row.waiting,
    urgent: row.urgent === 1,
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
    changed: github?.changed ?? null,
    goal: row.goal,
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
