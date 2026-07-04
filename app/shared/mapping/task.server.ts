import type {
  AgentRef,
  GithubCache,
  OperatorRef,
  PacketObservation,
  PacketOption,
  PrRef,
  Readiness,
  TaskPacket,
  Validation,
  Waiting,
} from "~/schemas/task-file.schema";
import type { ActorRender } from "./actor.server";

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
  validation: Validation;
  owner_user_id: string | null;
  specialist_json: string | null;
  consultants_json: string;
  operator_json: string | null;
  branch: string | null;
  repo: string | null;
  pr_json: string | null;
  github_json: string | null;
  goal: string;
  packet_json: string | null;
  event_count: number;
  comment_count: number;
  diagnostic_count: number;
  created_at: string | null;
  updated_at: string | null;
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

/** Operator cell render (ruling 16: stage id stored; label is 1-based). */
export interface OperatorRender {
  name: "Operator";
  assignedAtStageId: string;
  /** 1-based index into the project's stage list; null if unknown stage. */
  sinceStageIndex: number | null;
  /** "stage 2" — precomputed display copy. */
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
 * `displayReadiness` adds the derived "accepted" state (done-stage tasks) —
 * feed it straight into ReadinessPill. */
export interface TaskSummary {
  projectSlug: string;
  key: string;
  title: string;
  stage: string;
  readiness: Readiness;
  displayReadiness: Readiness | "accepted";
  waiting: Waiting;
  urgent: boolean;
  validation: Validation;
  owner: ActorRender | null;
  specialist: AgentRender | null;
  consultants: AgentRender[];
  operator: OperatorRender | null;
  branch: string | null;
  repo: string | null;
  pr: PrRef | null;
  commits: { sha: string; msg: string }[];
  changed: { files: number; add: number; del: number } | null;
  goal: string;
  packet: PacketRender | null;
  eventCount: number;
  commentCount: number;
  diagnosticCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Store-relative path — the UI renders this real path (ruling 3). */
  filePath: string;
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
  stageIds: string[],
): OperatorRender | null {
  if (!ref) return null;
  const idx = stageIds.indexOf(ref.assignedAtStageId);
  const sinceStageIndex = idx === -1 ? null : idx + 1;
  return {
    name: "Operator",
    assignedAtStageId: ref.assignedAtStageId,
    sinceStageIndex,
    sinceLabel: sinceStageIndex === null ? "stage —" : `stage ${sinceStageIndex}`,
  };
}

export function mapPacket(packet: TaskPacket | null): PacketRender | null {
  if (!packet) return null;
  const { from, ...rest } = packet;
  return {
    ...rest,
    from: from === "operator" ? "Operator" : from,
  } as PacketRender;
}

export function mapTaskProjectionRow(
  row: TaskProjectionRow,
  context: {
    stageIds: string[];
    /** Resolved owner render shape (null when unowned/unknown). */
    owner: ActorRender | null;
    accepted: boolean;
  },
): TaskSummary {
  const specialist = row.specialist_json
    ? mapAgentRef(JSON.parse(row.specialist_json) as AgentRef)
    : null;
  const consultants = (JSON.parse(row.consultants_json) as AgentRef[])
    .map((c) => mapAgentRef(c))
    .filter((c): c is AgentRender => c !== null);
  const operator = row.operator_json
    ? mapOperatorRef(JSON.parse(row.operator_json) as OperatorRef, context.stageIds)
    : null;
  const github = row.github_json
    ? (JSON.parse(row.github_json) as GithubCache)
    : null;

  return {
    projectSlug: row.project_slug,
    key: row.task_key,
    title: row.title,
    stage: row.stage,
    readiness: row.readiness,
    displayReadiness: context.accepted ? "accepted" : row.readiness,
    waiting: row.waiting,
    urgent: row.urgent === 1,
    validation: row.validation,
    owner: context.owner,
    specialist,
    consultants,
    operator,
    branch: row.branch,
    repo: row.repo,
    pr: row.pr_json ? (JSON.parse(row.pr_json) as PrRef) : null,
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
    filePath: row.source_path,
  };
}
