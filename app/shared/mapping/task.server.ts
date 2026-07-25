import type {
  AgentRef,
  GithubCache,
  OperatorRef,
  PacketObservation,
  PacketOption,
  PrChecks,
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

/**
 * Centralized snake_case → camelCase mapping for `task_projections` and the
 * board/detail render shapes consumed by Phase 4/5 loaders.
 */

export interface TaskProjectionRow {
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
}

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
  /** Revision-bound acceptance block reason (P11-50): null when the current
   *  revision is acceptance-ready, else why it isn't. Projected so read models
   *  (review queue) don't re-read task files on a loader path. */
  blockReason: string | null;
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
  return {
    ...rest,
    from: packetFromDisplay(from),
  } as PacketRender;
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

export function mapTaskProjectionRow(
  row: TaskProjectionRow,
  context: {
    /** Project stages in order — id for position, name for display copy. */
    stages: { id: string; name: string }[];
    /** Resolved owner render shape (null when unowned/unknown). */
    owner: ActorRender | null;
    accepted: boolean;
  },
): TaskSummary {
  const specialist = row.specialist_json
    ? mapAgentRef(JSON.parse(row.specialist_json) as AgentRef)
    : null;
  const reviewers = (JSON.parse(row.reviewers_json) as AgentRef[])
    .map((c) => mapAgentRef(c))
    .filter((c): c is AgentRender => c !== null);
  const operator = row.operator_json
    ? mapOperatorRef(JSON.parse(row.operator_json) as OperatorRef, context.stages)
    : null;
  const github = row.github_json
    ? (JSON.parse(row.github_json) as GithubCache)
    : null;
  const pr = row.pr_json ? (JSON.parse(row.pr_json) as PrRef) : null;

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
    blockReason: row.validation_block_reason,
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
    packet: mapPacket(
      row.packet_json ? (JSON.parse(row.packet_json) as TaskPacket) : null,
    ),
    eventCount: row.event_count,
    commentCount: row.comment_count,
    diagnosticCount: row.diagnostic_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    boardRank: row.board_rank,
    filePath: row.source_path,
  };
}
