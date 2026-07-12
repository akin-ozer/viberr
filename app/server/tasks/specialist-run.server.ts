import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type {
  AgentRef,
  FileActorRef,
  TaskFileEvent,
} from "~/schemas/task-file.schema";
import type { CapabilityGrant, ProjectRole } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  agentProfilesDir,
  skillDirPath,
  taskDir,
} from "~/server/files/file-store-root.server";
import { KB_INJECTION_BUDGET, readKbBody } from "~/server/files/kb-injection.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import { effectiveProfileView } from "~/features/agents/agents-query.server";
import type { AgentProfileView } from "~/features/agents/agent-types";
import type { LogLine } from "~/features/runtime/runtime-types";
import { isBackendAvailable, type RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  defaultModelFor,
  resolveRunModel,
  resolveRunEffort,
} from "~/server/runtimes/model-catalog.server";
import { taskBranchName } from "~/server/github/branch-sync.server";
import {
  buildScript,
  type SimulatedScript,
} from "~/server/runtimes/simulated-runtime.server";
import { listRunsForTask, startRun } from "~/server/runtimes/run-service.server";
import { newId } from "~/shared/ids/new-id.server";
import { roleCan } from "~/shared/rbac";
import {
  type DeliveryPermissions,
  resolveDeliveryPermissions,
  resolveSpecialistDisallowedTools,
} from "./specialist-tool-policy";
import { resolveSpecialistMcpServers } from "./specialist-mcp.server";
import type { TaskActor, TaskMutationContext } from "./task-actions.server";

/**
 * Assign a deployed specialist agent to a task, and start a real (or
 * simulated-fallback) agent run for it from the task-detail UI.
 *
 * This is the "deploy a specialist to a task and run it" surface the app was
 * missing: today runs only appear from seed data or the operator-scheduling
 * reaction. `assignSpecialist` writes the `specialist` frontmatter + a typed
 * `agent` timeline event; `startSpecialistRun` clones the repo (best-effort)
 * and hands off to the Phase-8 run service, streaming a realistic simulated
 * dev-agent-analyzing-a-repo transcript when no real backend credential is
 * present (and a real SDK run when one is).
 *
 * RBAC (both fns): admin|maintainer — contracts §3.2 "Open agent runtime
 * sessions". Mirrors the transition/interrupt project-membership check.
 */

const execFileAsync = promisify(execFile);

// ----------------------------------------------------------------- helpers

function forbidden(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.FORBIDDEN,
    status: 403,
    userMessage,
    kind: "user",
  });
}

function taskRef(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
) {
  return {
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
}

/** A deployed specialist resolved from project.md `agents:` for a run. */
export interface ResolvedSpecialist {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  model: string;
  /** Reasoning/effort level threaded into the run (empty when unset). */
  effort: string;
  /** The agent's declared skills — loaded into its run persona at run time. */
  skills: string[];
  /** The agent's declared knowledge bases — docs injected into its run context. */
  kb: string[];
  /** The agent's declared MCP servers — wired into a Claude run's mcpServers. */
  mcps: string[];
  /** The deployment's stored capability grants — drive run-time tool
   *  confinement (specialist-tool-policy). Empty for the list/display path. */
  capabilities: CapabilityGrant[];
  /** Stage ids this profile may work (F1 — enforced by the assign/run guards
   *  and the operator picker). Empty when spanAll or unset. */
  stages: string[];
  /** When true the profile is eligible across every stage. */
  spanAll: boolean;
}

/** First runnable backend for a profile (codex|claude), defaulting to claude
 * when the definition/template names neither. */
function pickBackend(view: AgentProfileView): RealBackend {
  const first = view.backends.find((b) => b === "codex" || b === "claude");
  return first === "codex" ? "codex" : "claude";
}

function toResolved(view: AgentProfileView): ResolvedSpecialist {
  const backend = pickBackend(view);
  return {
    profileId: view.id,
    name: view.name,
    role: view.role || view.name,
    backend,
    // Resolve to a VALID run model id — a seed/legacy display label like
    // "codex-large · claude-sonnet" must never reach the SDK (it 400s: "model
    // not supported when using Codex with a ChatGPT account").
    model: resolveRunModel(backend, view.model),
    effort: view.effort || "",
    skills: view.resources.skills,
    kb: view.resources.kb ?? [],
    mcps: view.resources.mcps ?? [],
    capabilities: [],
    stages: view.stages ?? [],
    spanAll: view.spanAll ?? false,
  };
}

/** Resolve declared MCP names to a Claude `mcpServers` option, or `{}`. */
function mcpServersFor(
  db: Database.Database,
  names: string[],
): { mcpServers?: Record<string, unknown> } {
  const servers = resolveSpecialistMcpServers(db, names);
  return Object.keys(servers).length ? { mcpServers: servers } : {};
}

/**
 * Resolve a deployed SPECIALIST agent (kind !== "operator") from the
 * project's `agents:` deployments by profile id. The effective profile merges
 * the org template file with the deployment's loose `definition` (the same
 * assembly the Agents surface uses). Throws a typed error when the profile id
 * is not a deployed specialist.
 */
export function resolveDeployedSpecialist(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): ResolvedSpecialist {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const deployment = file.parsed.frontmatter.agents.find(
    (a) => a.profileId === profileId,
  );
  if (!deployment) {
    throw AppError.validation(
      `No agent \`${profileId}\` is deployed in this project.`,
    );
  }
  const view = effectiveProfileView(deployment, ctx.dataRoot);
  if (view.kind !== "specialist") {
    throw AppError.validation(
      `Agent \`${profileId}\` is not a specialist and cannot be assigned as one.`,
    );
  }
  // Carry the deployment's stored capability grants so the run can confine its
  // tools to them (specialist-tool-policy).
  return { ...toResolved(view), capabilities: deployment.capabilities };
}

function agentEvent(text: string): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "agent",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

// ------------------------------------------------------------- assignSpecialist

export interface AssignSpecialistResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
}

/**
 * Assigns a deployed specialist as the task's PRIMARY specialist: writes the
 * `specialist` frontmatter ({profileId, backend, role}) and appends a typed
 * `agent` timeline event announcing the deployment, then reprojects + audits
 * (SSE rides the reproject). RBAC: admin|maintainer.
 */
export async function assignSpecialist(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignSpecialistResult> {
  const auditActor = runtimeAuditActor(
    ctx,
    input.projectSlug,
    actor,
    "assign a specialist",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const specialist = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
  );
  assertStageEligible(specialist, existing.parsed.frontmatter.stage);

  const backendLabel = specialist.backend === "claude" ? "Claude Code" : "Codex";
  const ref: AgentRef = {
    profileId: specialist.profileId,
    backend: specialist.backend,
    role: specialist.role,
  };
  const event = agentEvent(
    `Deployed **${specialist.name}** (${specialist.role}, ${backendLabel}) as the primary specialist.`,
  );

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.specialist = ref;
      // Clear any pending "assign specialist" recommendation — it's now done.
      parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
        (r) => r.kind !== "assign_specialist",
      );
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.specialist.assigned",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      profileId: specialist.profileId,
      backend: specialist.backend,
      role: specialist.role,
    },
  });

  return {
    profileId: specialist.profileId,
    name: specialist.name,
    role: specialist.role,
    backend: specialist.backend,
  };
}

// --------------------------------------------------------------- assignReviewer

export interface AssignReviewerResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  /** True when the profile was already engaged as a reviewer (idempotent no-op). */
  alreadyEngaged: boolean;
}

/**
 * Engages a deployed specialist as a REVIEWER (advisory, non-primary): appends
 * an AgentRef to the task's `reviewers` frontmatter array and announces it with
 * a typed `agent` timeline event, then reprojects + audits. Idempotent — a
 * profile already in `reviewers` is a no-op. RBAC: admin|maintainer.
 */
export async function assignReviewer(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignReviewerResult> {
  const auditActor = runtimeAuditActor(
    ctx,
    input.projectSlug,
    actor,
    "assign a reviewer",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const reviewer = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
  );
  assertStageEligible(reviewer, existing.parsed.frontmatter.stage);

  const alreadyEngaged = existing.parsed.frontmatter.reviewers.some(
    (r) => r.profileId === reviewer.profileId,
  );
  if (alreadyEngaged) {
    return {
      profileId: reviewer.profileId,
      name: reviewer.name,
      role: reviewer.role,
      backend: reviewer.backend,
      alreadyEngaged: true,
    };
  }

  const backendLabel = reviewer.backend === "claude" ? "Claude Code" : "Codex";
  const ref: AgentRef = {
    profileId: reviewer.profileId,
    backend: reviewer.backend,
    role: reviewer.role,
  };
  const event = agentEvent(
    `Engaged **${reviewer.name}** (${reviewer.role}, ${backendLabel}) as a reviewer.`,
  );

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.reviewers.push(ref);
      // Clear a matching pending "engage reviewer" recommendation.
      parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
        (r) => !(r.kind === "assign_reviewer" && r.profileId === reviewer.profileId),
      );
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.assigned",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      profileId: reviewer.profileId,
      backend: reviewer.backend,
      role: reviewer.role,
    },
  });

  return {
    profileId: reviewer.profileId,
    name: reviewer.name,
    role: reviewer.role,
    backend: reviewer.backend,
    alreadyEngaged: false,
  };
}

// --------------------------------------------------------------- removeReviewer

export interface RemoveReviewerResult {
  profileId: string;
  /** False when the profile wasn't engaged as a reviewer (nothing to remove). */
  removed: boolean;
}

/**
 * Releases a REVIEWER from a task: drops the matching AgentRef from `reviewers`
 * and appends a typed `agent` timeline event, then reprojects + audits. A
 * profile that isn't currently a reviewer is a no-op. RBAC: admin|maintainer.
 */
export async function removeReviewer(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<RemoveReviewerResult> {
  requireRuntimeRole(ctx, input.projectSlug, actor, "remove a reviewer");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const target = existing.parsed.frontmatter.reviewers.find(
    (r) => r.profileId === input.profileId,
  );
  if (!target) return { profileId: input.profileId, removed: false };

  // Best-effort display name for the event; falls back to the role snapshot.
  let label = target.role;
  try {
    label = resolveDeployedSpecialist(ctx, input.projectSlug, input.profileId).name;
  } catch {
    // Profile may have been undeployed since engagement — keep the role label.
  }
  const event = agentEvent(`Released reviewer **${label}** from the task.`);

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.reviewers = parsed.frontmatter.reviewers.filter(
        (r) => r.profileId !== input.profileId,
      );
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { profileId: input.profileId },
  });

  return { profileId: input.profileId, removed: true };
}

// --------------------------------------------------------- startSpecialistRun

export interface StartSpecialistRunResult {
  runId: string;
  backend: RealBackend;
  simulated: boolean;
  role: string;
}

/**
 * Starts a PRIMARY specialist run for a task with an assigned specialist.
 * Builds an "analyze the repo" prompt from the task title + goal, best-effort
 * clones the project repo into `<taskDir>/workspace/<repo>` (PAT-injected when
 * bound, plain clone for public repos) and points the run there. Hands off to
 * the run service with a realistic simulated fallback script so the console
 * streams meaningfully when no real credential is present; a real SDK run is
 * used when the backend's credential IS available.
 *
 * RBAC: admin|maintainer. `runtime.run.started` is audited by startRun — we
 * add a task-level `task.specialist.run_started` audit row + a typed `agent`
 * timeline event.
 */
export async function startSpecialistRun(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    directive?: string;
    /** Force this run onto a specific backend regardless of the profile's
     *  default — used by "retry on the other backend" after an availability /
     *  quota failure (D4). */
    backendOverride?: RealBackend;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<StartSpecialistRunResult> {
  const auditActor = runtimeAuditActor(
    ctx,
    input.projectSlug,
    actor,
    "start a specialist run",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const sp = existing.parsed.frontmatter.specialist;
  if (!sp) {
    throw AppError.validation(
      "Assign a specialist before starting a run.",
    );
  }
  const backend: RealBackend =
    input.backendOverride ?? (sp.backend === "codex" ? "codex" : "claude");
  // Resolve the model + effort from the deployment (falls back to a sane
  // default). Effort is threaded into the run so the SDK gets the profile's
  // chosen reasoning level (claude options.effort · codex modelReasoningEffort).
  let model = defaultModelFor(backend);
  let effort = "";
  // The agent's display name for the Agent-logs picker (grouped one-per-agent).
  // Falls back to the profile id when the deployment can't be resolved.
  let agentName = sp.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  // Run-time tool confinement from the deployment's capability grants (a
  // specialist without push/PR/merge rights literally cannot run those
  // commands). Empty when nothing is withheld.
  let disallowedTools: string[] = [];
  let resolvedSpec: ResolvedSpecialist | null = null;
  try {
    const resolved = resolveDeployedSpecialist(ctx, input.projectSlug, sp.profileId);
    resolvedSpec = resolved;
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
    // The profile's model/effort are specific to ITS native backend. When this
    // run overrides to a DIFFERENT backend (D4 retry-on-other-backend), the
    // native model id is invalid there (e.g. Claude's "opus" sent to Codex) —
    // re-resolve model + effort for the actual run backend so the retry works
    // instead of hard-failing. Same-backend runs keep the profile's exact values.
    if (backend === resolved.backend) {
      model = resolved.model;
      effort = resolved.effort;
    } else {
      model = resolveRunModel(backend, undefined); // backend default
      effort = resolveRunEffort(backend, resolved.effort);
    }
  } catch {
    // Profile may have been undeployed since assignment — keep the default.
  }
  // Stage eligibility holds at the RUN boundary too (F1): an already-assigned
  // specialist must not be re-run after the task moved to a stage it isn't
  // eligible for (assign-time checks alone would let a re-prompt bypass F1).
  // Outside the try so the graceful undeployed-profile fallback can't swallow it.
  if (resolvedSpec) {
    assertStageEligible(resolvedSpec, existing.parsed.frontmatter.stage);
  }

  // The agent's run persona: its detailed definition + declared skills + KB docs.
  // This is what makes the specialist behave as itself (the Developer implements
  // + tests + reports back) rather than a generic analyzer. Claude takes it as a
  // system prompt; Codex has no system-prompt channel, so it is folded into the
  // prompt.
  const persona = buildSpecialistPersona({
    profileId: sp.profileId,
    skills,
    kb,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const title = existing.parsed.frontmatter.title;
  const goal = existing.parsed.goal;
  const repo = existing.parsed.frontmatter.repo ?? projectRepo(ctx, input.projectSlug);

  // Best-effort clone — only when a REAL backend will actually consume a
  // working tree. With no credential the simulated engine carries the run and
  // needs no checkout, so we skip the network clone entirely (keeps the demo
  // and the test suite fast + offline). Still best-effort even when real.
  const realBackend = isBackendAvailable(backend);
  const clone =
    repo && realBackend
      ? await cloneRepo(db, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          dataRoot: ctx.dataRoot,
        })
      : null;
  // The run's cwd is ALWAYS an isolated workspace dir for a real backend —
  // the clone when it succeeded, else an empty workspace root the agent clones
  // into. NEVER the task dir (which sits inside the data root, which may live
  // inside a host git repo). Confine git with GIT_CEILING (workspaceRunEnv).
  const workspaceRoot = taskWorkspaceRoot(
    input.projectSlug,
    input.taskKey,
    ctx.dataRoot,
  );
  const runWorkdir = clone ?? (realBackend ? workspaceRoot : null);
  if (runWorkdir && !existsSync(runWorkdir)) {
    mkdirSync(runWorkdir, { recursive: true });
  }

  const analyzePrompt = buildAnalyzePrompt({
    role: sp.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    branch: existing.parsed.frontmatter.branch ?? taskBranchName(input.taskKey, title),
    cloned: !!clone,
    delivery: resolveDeliveryPermissions(resolvedSpec?.capabilities ?? []),
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = foldPersonaForCodex(persona, backend, analyzePrompt, mcpNames);

  const script = buildAnalyzeScript({
    backend,
    model,
    repo,
    cloned: !!clone,
    role: sp.role,
    ...(input.directive ? { directive: input.directive } : {}),
  });

  const { runId, simulated } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    // Unique thread per specialist run so re-running a task starts a fresh
    // stream instead of colliding with a prior run on the "primary" thread
    // (agent_runs is unique on project+task+thread). Each run shows in the
    // Agent-logs picker; the label comes from the role, not the thread id.
    threadId: "primary-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Primary specialist",
    kind: "primary",
    backend,
    model,
    ...(effort ? { effort } : {}),
    ...(persona && backend === "claude" ? { systemPrompt: persona } : {}),
    // Persist the agent identity so the Agent-logs picker groups this run's
    // resumes into one entry labeled by the specialist's name (e.g. "dev").
    agentName,
    agentProfileId: sp.profileId,
    prompt,
    script,
    actor: auditActor,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    // Wire the profile's declared MCP servers into the run (item-1/FR9): a
    // profile that declares an org MCP now actually gets it (Claude only).
    ...(backend === "claude" ? mcpServersFor(db, mcpNames) : {}),
    ...(runWorkdir ? { workdir: runWorkdir } : {}),
    ...(realBackend
      ? { env: workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot) }
      : {}),
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const backendLabel = backend === "claude" ? "Claude Code" : "Codex";
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(
        agentEvent(
          `Started a ${backendLabel} run for the ${sp.role} specialist — streaming to the agent logs.`,
        ),
      );
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.specialist.run_started",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      runId,
      profileId: sp.profileId,
      backend,
      simulated,
      cloned: !!clone,
    },
  });

  const { registerAgentCompletion, markWaitingAgent } = await import(
    "./task-actions.server"
  );
  // The board reads "agent working" while the run is in flight.
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);

  // ONE canonical completion handler for EVERY start path (UI "Run", @mention,
  // operator prompt): reply → reconcile agent-side delivery → (reviewer) verdict
  // → re-invoke the operator to react. `ctx.operatorRun` (set when this run is
  // inside an operator react loop) continues the chain at depth+1; otherwise a
  // fresh chain starts against the deployed operator.
  await registerAgentCompletion(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    backend,
    role: sp.role,
    kind: "primary",
    workdir: runWorkdir,
    agentHandle: agentHandleFor(sp.role),
    ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
  });

  return { runId, backend, simulated, role: sp.role };
}

// ------------------------------------------------------------ startReviewerRun

/**
 * Starts a REVIEWER run for a specific engaged reviewer (by profile id) —
 * the reviewer counterpart of {@link startSpecialistRun}. Same analyze prompt +
 * best-effort clone + simulated-fallback script, but the run is `kind:
 * "reviewer"` on its own `r<index>-…` thread so it groups under the reviewer's
 * own Agent-logs entry. RBAC: admin|maintainer.
 */
export async function startReviewerRun(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    directive?: string;
    /** Force this run onto a specific backend (D4 retry-on-other-backend). */
    backendOverride?: RealBackend;
  },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<StartSpecialistRunResult> {
  const auditActor = runtimeAuditActor(
    ctx,
    input.projectSlug,
    actor,
    "start a reviewer run",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const reviewers = existing.parsed.frontmatter.reviewers;
  const index = reviewers.findIndex((r) => r.profileId === input.profileId);
  if (index < 0) {
    throw AppError.validation(
      "That reviewer is not engaged on this task. Assign it first.",
    );
  }
  const rev = reviewers[index]!;
  const backend: RealBackend =
    input.backendOverride ?? (rev.backend === "codex" ? "codex" : "claude");

  let model = defaultModelFor(backend);
  let effort = "";
  let agentName = rev.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  let disallowedTools: string[] = [];
  let resolvedRev: ResolvedSpecialist | null = null;
  try {
    const resolved = resolveDeployedSpecialist(ctx, input.projectSlug, rev.profileId);
    resolvedRev = resolved;
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
    // Cross-backend retry (D4): re-resolve model + effort for the run backend.
    if (backend === resolved.backend) {
      model = resolved.model;
      effort = resolved.effort;
    } else {
      model = resolveRunModel(backend, undefined);
      effort = resolveRunEffort(backend, resolved.effort);
    }
  } catch {
    // Profile may have been undeployed since engagement — keep the default.
  }
  // Stage eligibility at the RUN boundary (F1) — same rationale as
  // startSpecialistRun: an engaged reviewer must not be re-run at a stage its
  // profile isn't eligible for. Outside the try so the fallback can't swallow it.
  if (resolvedRev) {
    assertStageEligible(resolvedRev, existing.parsed.frontmatter.stage);
  }

  const persona = buildSpecialistPersona({
    profileId: rev.profileId,
    skills,
    kb,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const title = existing.parsed.frontmatter.title;
  const goal = existing.parsed.goal;
  const repo = existing.parsed.frontmatter.repo ?? projectRepo(ctx, input.projectSlug);

  const realBackend = isBackendAvailable(backend);
  const clone =
    repo && realBackend
      ? await cloneRepo(db, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          dataRoot: ctx.dataRoot,
        })
      : null;
  const workspaceRoot = taskWorkspaceRoot(
    input.projectSlug,
    input.taskKey,
    ctx.dataRoot,
  );
  const runWorkdir = clone ?? (realBackend ? workspaceRoot : null);
  if (runWorkdir && !existsSync(runWorkdir)) {
    mkdirSync(runWorkdir, { recursive: true });
  }

  const analyzePrompt = buildAnalyzePrompt({
    role: rev.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    branch: existing.parsed.frontmatter.branch ?? taskBranchName(input.taskKey, title),
    cloned: !!clone,
    delivery: resolveDeliveryPermissions(resolvedRev?.capabilities ?? []),
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = foldPersonaForCodex(persona, backend, analyzePrompt, mcpNames);

  const script = buildAnalyzeScript({
    backend,
    model,
    repo,
    cloned: !!clone,
    role: rev.role,
    ...(input.directive ? { directive: input.directive } : {}),
  });

  const { runId, simulated } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    // `r<index>-<uid>`: the index groups this reviewer's runs in the agents
    // deployment projection; the uid keeps re-runs from colliding on the thread.
    threadId: `r${index}-` + newId("t").replace("t_", "").slice(0, 8),
    role: "Reviewer",
    kind: "reviewer",
    backend,
    model,
    ...(effort ? { effort } : {}),
    ...(persona && backend === "claude" ? { systemPrompt: persona } : {}),
    agentName,
    agentProfileId: rev.profileId,
    prompt,
    script,
    actor: auditActor,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    ...(backend === "claude" ? mcpServersFor(db, mcpNames) : {}),
    ...(runWorkdir ? { workdir: runWorkdir } : {}),
    ...(realBackend
      ? { env: workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot) }
      : {}),
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  const backendLabel = backend === "claude" ? "Claude Code" : "Codex";
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(
        agentEvent(
          `Started a ${backendLabel} run for the ${rev.role} reviewer — streaming to the agent logs.`,
        ),
      );
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.run_started",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      runId,
      profileId: rev.profileId,
      backend,
      simulated,
      cloned: !!clone,
    },
  });

  const { registerAgentCompletion, markWaitingAgent } = await import(
    "./task-actions.server"
  );
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);

  // Same canonical handler — a reviewer additionally records its verdict.
  await registerAgentCompletion(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    backend,
    role: rev.role,
    kind: "reviewer",
    workdir: runWorkdir,
    agentHandle: agentHandleFor(rev.role),
    ...(ctx.operatorRun ? { operatorRun: ctx.operatorRun } : {}),
  });

  return { runId, backend, simulated, role: rev.role };
}

// ----------------------------------------------------------------- persona

/** Read the shipped agent DEFINITION body (persona) for a profile, or "" when
 *  the store ships none. Definitions live next to the profiles in the store. */
function readAgentDefinition(profileId: string, dataRoot?: string): string {
  try {
    const file = path.join(
      agentProfilesDir(dataRoot),
      "..",
      "definitions",
      `${profileId}.md`,
    );
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
  } catch {
    // missing/unreadable definition — the run falls back to the analyze prompt
  }
  return "";
}

/** Read one skill's body from the store, or "" when absent. */
function readSkillBody(name: string, dataRoot?: string): string {
  try {
    const file = path.join(skillDirPath(name, dataRoot), "SKILL.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
  } catch {
    // missing/unreadable skill — skip it
  }
  return "";
}

/**
 * Assemble a specialist's run PERSONA: its detailed definition (who it is + how
 * it works) followed by each of its declared skill bodies (its craft). This is
 * what makes a built-in agent behave as itself — the Developer implements and
 * reports back, the Reviewer critiques AND validates (tests) — rather than a
 * generic "analyze the repo" agent. Returns "" when the store ships neither a
 * definition nor any skill (the run still works on the analyze prompt alone).
 *
 * Threaded into the run as the system prompt for Claude, or folded into the turn
 * prompt for Codex (which has no system-prompt channel). Exported for tests.
 */
export function buildSpecialistPersona(input: {
  profileId: string;
  skills: string[];
  kb?: string[];
  dataRoot?: string;
}): string {
  const parts: string[] = [];
  const definition = readAgentDefinition(input.profileId, input.dataRoot);
  if (definition) parts.push(definition);
  for (const name of input.skills) {
    const body = readSkillBody(name, input.dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (skill)\n\n${body}`);
  }
  // Inject declared knowledge-base docs (F6, FR9): the KB leg was decorative for
  // specialists — no run received KB content. Load each declared KB folder that
  // exists in the store. KB_INJECTION_BUDGET is a GLOBAL cap across all declared
  // KBs (F9) — a specialist with many KBs can't blow the prompt with N × 24k.
  let kbBudget = KB_INJECTION_BUDGET;
  for (const name of input.kb ?? []) {
    if (kbBudget <= 0) break;
    const body = readKbBody(name, input.dataRoot, kbBudget);
    if (body) {
      parts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
      kbBudget -= body.length;
    }
  }
  return parts.join("");
}

// readKbBody now lives in ~/server/files/kb-injection.server (shared with the
// operator runtime): it walks the KB tree recursively and matches every text-doc
// extension, so GitHub-imported / folder-uploaded / non-.md docs actually reach
// the agent instead of being silently dropped.

/**
 * Fold the persona into the turn prompt for Codex (which has no system-prompt
 * channel), or leave the prompt as-is for Claude (which receives the persona as
 * a system prompt) and when there is no persona. Keeps both run paths honest:
 * the agent always gets its persona, wherever the backend can accept it.
 */
function foldPersonaForCodex(
  persona: string,
  backend: RealBackend,
  prompt: string,
  /** MCP server names declared on the profile — surfaced as unavailable on
   *  Codex (the Codex SDK has no mcpServers channel, so a profile that declares
   *  an org MCP silently gets nothing there; F2). */
  mcpNames: string[] = [],
): string {
  let out = prompt;
  if (backend === "codex" && mcpNames.length) {
    out +=
      `\n\n_Note: the MCP server(s) ${mcpNames.map((n) => `\`${n}\``).join(", ")} ` +
      `declared on your profile are not available on the Codex backend — proceed ` +
      `with your built-in tools._`;
  }
  if (!persona || backend !== "codex") return out;
  return `${persona}\n\n---\n# Your task\n\n${out}`;
}

// ----------------------------------------------------------------- prompt/script

function buildAnalyzePrompt(input: {
  role: string;
  taskKey: string;
  title: string;
  goal: string;
  repo: string | null;
  /** The task-key branch the delivery must land on. */
  branch: string;
  cloned: boolean;
  /** Which delivery steps the profile's capabilities permit (XS-4). */
  delivery: DeliveryPermissions;
  /** An operator directive that becomes the run's turn focus (when present). */
  directive?: string;
}): string {
  let prompt =
    `You are the ${input.role} specialist on task ${input.taskKey}: ` +
    `"${input.title}". Goal: ${input.goal}. Analyze the repository and report ` +
    `your findings (structure, dependencies, architecture, notable risks/gaps) ` +
    `as a concise summary.`;
  // Workspace + delivery CONTRACT (NFR15 traceability). The run's cwd is an
  // isolated per-task workspace; git is ceiling-confined to it, so the agent
  // must work ONLY inside the current directory and never touch a parent repo.
  if (input.repo) {
    const { canBranch, canCommitPush, canOpenPr } = input.delivery;
    prompt +=
      `\n\n## Workspace & delivery contract (follow exactly)\n` +
      `- Work ONLY inside the current working directory — it is an isolated ` +
      `workspace for this task. Never \`cd\` to a parent directory or touch any ` +
      `repository outside it.\n` +
      (input.cloned
        ? `- The repository \`${input.repo}\` is already checked out in the current directory.\n`
        : `- Clone \`https://github.com/${input.repo}\` INTO the current directory (\`git clone https://github.com/${input.repo}.git .\`) before making changes.\n`);
    if (canBranch) {
      prompt += `- Do all work on the branch \`${input.branch}\` (create it from the default branch if it does not exist): \`git checkout -B ${input.branch}\`.\n`;
    }
    if (canCommitPush) {
      prompt +=
        `- Prefix every commit message with \`[${input.taskKey}]\` so commits trace back to this task.\n` +
        `- Push the branch${canOpenPr ? " and open a pull request that references " + input.taskKey + " in its title/body" : ""}.\n`;
    } else if (canOpenPr) {
      prompt += `- Open a pull request that references ${input.taskKey} in its title/body.\n`;
    }
    // Reflect what the profile's capabilities actually allow so the run never
    // attempts (and fails) a step its tools deny.
    if (!canBranch && !canCommitPush && !canOpenPr) {
      prompt += `- Your profile does not grant branch/commit/PR delivery — do the analysis and any in-workspace edits, then report findings; do NOT attempt to branch, commit, push, or open a PR.\n`;
    }
    prompt += `- Report the exact branch name, commit SHAs, and PR URL for whatever delivery steps you performed back in your reply.`;
  }
  if (input.directive?.trim()) {
    prompt +=
      `\n\nThe operator has engaged you and directs: "${input.directive.trim()}" ` +
      `Address that directive as you work, then give a concise reply.`;
  }
  return prompt;
}

/** Classify a specialist by its role label so the simulated report and persona
 *  match what the agent actually does. The Reviewer is the single quality
 *  specialist (it reviews the diff AND authors/runs tests), so review/test/QA
 *  roles all classify as "reviewer". Anything unrecognized reports as a
 *  developer. */
function classifyRole(role?: string): "developer" | "reviewer" {
  const r = (role ?? "").toLowerCase();
  if (/review|test|valid|qa/.test(r)) return "reviewer";
  return "developer";
}

/**
 * The simulated agent's CLOSING report — ROLE-AWARE, so the operator reads a
 * report that matches the agent it prompted: the Developer reports what it
 * implemented, the Reviewer reports a review verdict, the Tester reports a
 * validation verdict. When the operator engaged the agent with a directive this
 * reports the work as DONE (otherwise the operator, reading only a "findings"
 * summary, keeps re-prompting the same canned reply and spirals — the CTL-3
 * bug). The text is deterministic on purpose: if the operator ever re-prompts a
 * simulated agent, the identical repeat trips its no-progress guard and stops
 * the loop instead of spiralling. Exported for tests.
 */
export function simulatedFinalReport(
  backend: RealBackend,
  directive?: string,
  role?: string,
): string {
  const kind = classifyRole(role);
  if (directive?.trim()) {
    if (kind === "reviewer") {
      return (
        `@operator — reviewed and validated the change against the goal. ` +
        `Correctness: the logic holds on the paths that matter. Security: input ` +
        `is validated and no secrets leak. Tests: authored and ran coverage for ` +
        `the new behavior incl. the empty and boundary cases; full suite passes. ` +
        `No blocking findings (one nit: a comment could be clearer). Verdict: ` +
        `**approve** — ready to accept.`
      );
    }
    const test = backend === "codex" ? "a test that exercises" : "a test covering";
    return (
      `@operator — done: implemented what you asked for, wired into the existing ` +
      `structure (matching the conventions under src/), and added ${test} the new ` +
      `behavior. Ran the suite and it passes. No blockers remaining — ready to advance.`
    );
  }
  if (kind === "reviewer") {
    return "Review findings: the change is small and localized; no obvious correctness or security issues in the diff. The existing tests pass, but coverage of the new path is thin — the empty and boundary cases are not exercised yet, which I'd want closed before acceptance.";
  }
  return backend === "codex"
    ? "Findings: a small Node/TypeScript service (Express). Entry at src/index.ts, HTTP layer under src/server. Dependencies are lean; no test suite is wired yet — the main gap for this goal."
    : "Findings: a small Node/TypeScript service (Express). Entry point src/index.ts; the HTTP layer lives under src/server. Dependencies are lean. Notable gap: there is no test suite wired up yet, which is the main risk for this goal.";
}

/**
 * A realistic dev-agent-analyzing-a-repo stream for the simulated fallback:
 * system·init, a couple of tool_use Read/Bash lines, an assistant findings
 * summary, and a final result envelope with usage. Ignored by a real SDK run.
 */
function buildAnalyzeScript(input: {
  backend: RealBackend;
  model: string;
  repo: string | null;
  cloned: boolean;
  /** The agent's role — makes the simulated closing report role-appropriate. */
  role?: string;
  /** When the operator engaged this agent, its directive (shown as the opener). */
  directive?: string;
}): SimulatedScript {
  const sid = newId("run").replace("run_", "");
  const now = () => new Date().toISOString();
  const repoName = input.repo ? input.repo.split("/").pop() ?? input.repo : "workspace";
  const directive = input.directive?.trim();
  const opener = directive
    ? `The operator asked me to: ${directive} On it — scanning the repository first.`
    : "Scanning the repository layout to understand its structure.";
  const finalCodex = simulatedFinalReport("codex", directive, input.role);
  const finalClaude = simulatedFinalReport("claude", directive, input.role);

  const lines: LogLine[] =
    input.backend === "codex"
      ? [
          { t: "", ev: "init", tag: "thread.started", text: `codex thread · analyzing ${repoName}` },
          { t: "", ev: "text", tag: "agent_message", text: opener },
          { t: "", ev: "tool", tag: "command_execution", name: "exec", text: "ls -R", input: { command: "ls -R" } },
          { t: "", ev: "out", tag: "command_output", text: "src/\n  index.ts\n  server/\npackage.json\nREADME.md" },
          { t: "", ev: "tool", tag: "command_execution", name: "exec", text: "cat package.json", input: { command: "cat package.json" } },
          { t: "", ev: "out", tag: "command_output", text: '{ "name": "app", "dependencies": { "express": "^4" } }' },
          {
            t: "",
            ev: "text",
            tag: "agent_message",
            text: finalCodex,
          },
          {
            t: "",
            ev: "result",
            tag: "turn.completed",
            text: "analysis complete",
            usage: { input_tokens: 4200, cached_input_tokens: 1800, output_tokens: 640 },
          },
        ]
      : [
          { t: "", ev: "init", tag: "system·init", text: `analyzing ${repoName} · read-only pass` },
          { t: "", ev: "text", tag: "assistant", text: directive ? opener : "Scanning the repository layout to understand its structure and dependencies." },
          { t: "", ev: "tool", tag: "tool_use", name: "Bash", text: "ls -R", input: { command: "ls -R" } },
          { t: "", ev: "out", tag: "tool_result", text: "src/\n  index.ts\n  server/\npackage.json\nREADME.md" },
          { t: "", ev: "tool", tag: "tool_use", name: "Read", text: "package.json", input: { file_path: "package.json" } },
          { t: "", ev: "out", tag: "tool_result", text: '{ "name": "app", "dependencies": { "express": "^4" } }' },
          {
            t: "",
            ev: "text",
            tag: "assistant",
            text: finalClaude,
          },
          {
            t: "",
            ev: "result",
            tag: "result",
            text: "analysis complete",
            stats: { subtype: "success", dur: 8400, api: 7100, turns: 3, cost: 0.06, in: 4200, cached: 1800, out: 640 },
          },
        ];

  return buildScript({
    lines,
    occurredAt: lines.map(() => now()),
    sessionId: sid,
    backend: input.backend,
    model: input.model,
    op: false,
    keepRunning: false,
  });
}

// ------------------------------------------------------------------- repo clone

function projectRepo(ctx: TaskMutationContext, projectSlug: string): string | null {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return file?.parsed.frontmatter.repo ?? null;
}

/**
 * Best-effort `git clone` of `<owner>/<name>` into
 * `<taskDir>/workspace/<name>`. Injects the project-bound PAT into the clone
 * URL when one exists (private repos), else a plain clone (public repos).
 * Returns the clone dir on success, null on any failure (the caller then
 * points the run at the task dir and tells the agent to clone itself).
 *
 * Never throws — clone failure must not break starting the run.
 */
/**
 * The isolated per-task workspace directory (`<taskDir>/workspace`). A
 * specialist run's cwd is ALWAYS inside here — NEVER the task dir itself —
 * and `GIT_CEILING_DIRECTORIES` is pinned to it, so an agent's git can never
 * walk UP to a host checkout even when `VIBERR_DATA_ROOT` lives inside a git
 * repo (the dogfooding hazard: a run once switched the running app's own
 * source onto its task branch). Combined with the run env below, the agent is
 * confined to its own directory regardless of backend.
 */
function taskWorkspaceRoot(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): string {
  return path.join(taskDir(projectSlug, taskKey, dataRoot), "workspace");
}

/** The per-run env that confines a specialist's git to its own workspace. */
/**
 * The run confinement a resumed specialist (@mention comment) must re-apply so
 * it is bound by the SAME denylist, git ceiling, MCP set, and persona as its
 * fresh run — the resume path used to drop all of these, letting a
 * capability-withheld specialist run unconfined (XS-1). Best-effort: if the
 * profile is no longer a current deployment we still return the always-human
 * denylist and the workspace git ceiling.
 */
export function resolveResumeConfinement(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string },
): {
  disallowedTools: string[];
  env: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  systemPrompt?: string;
} {
  const env = workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot);
  try {
    const resolved = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      input.profileId,
    );
    const persona = buildSpecialistPersona({
      profileId: input.profileId,
      skills: resolved.skills,
      kb: resolved.kb,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    });
    const mcpServers = resolveSpecialistMcpServers(db, resolved.mcps);
    return {
      disallowedTools: resolveSpecialistDisallowedTools(resolved.capabilities),
      env,
      ...(mcpServers && Object.keys(mcpServers).length
        ? { mcpServers }
        : {}),
      ...(persona ? { systemPrompt: persona } : {}),
    };
  } catch {
    // Profile not a current deployment — still confine to the safe floor.
    return { disallowedTools: resolveSpecialistDisallowedTools([]), env };
  }
}

function workspaceRunEnv(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): Record<string, string> {
  // The ceiling must be a STRICT ANCESTOR of the run cwd — `GIT_CEILING` only
  // blocks git from ascending INTO a listed dir, so a ceiling EQUAL to cwd is a
  // no-op (git's first step up lands in the ceiling's unblocked parent). The
  // empty-workspace run has cwd == the workspace root, so we pin the ceiling to
  // the TASK dir (its parent). That stops git-repo discovery for BOTH cwd
  // shapes — `<taskDir>/workspace` (empty) and `<taskDir>/workspace/<repo>`
  // (cloned) — before it can reach a host `.git` above the data root
  // (adversarial-review HIGH #2).
  const ceiling = taskDir(projectSlug, taskKey, dataRoot);
  return {
    GIT_CEILING_DIRECTORIES: ceiling,
  };
}

async function cloneRepo(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string;
    dataRoot?: string;
  },
): Promise<string | null> {
  try {
    const name = input.repo.split("/").pop() ?? input.repo;
    const dir = path.join(
      taskWorkspaceRoot(input.projectSlug, input.taskKey, input.dataRoot),
      name,
    );
    if (existsSync(path.join(dir, ".git"))) {
      // Already cloned for this task — reuse it.
      return dir;
    }
    mkdirSync(path.dirname(dir), { recursive: true });

    let url = `https://github.com/${input.repo}.git`;
    const cred = getProjectCredential(db, input.projectSlug);
    if (cred) {
      const token = getPatToken(db, cred.id);
      if (token) {
        // x-access-token is GitHub's username for token auth (never logged).
        url = `https://x-access-token:${token}@github.com/${input.repo}.git`;
      }
    }

    await execFileAsync(
      "git",
      ["clone", "--depth", "1", url, dir],
      { timeout: 60_000 },
    );
    return dir;
  } catch (error) {
    // Repo is private with no cred, network down, git missing — fall back.
    logger.info("specialist run clone failed — falling back to task dir", {
      taskKey: input.taskKey,
      err: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ------------------------------------------------------- completion hook

/** A short @mention handle for a specialist/reviewer role, used in the
 *  stuck-loop packet copy ("@dev repeated its report"). */
function agentHandleFor(role: string): string {
  const first = role.trim().split(/[\s/&]+/)[0] ?? role;
  return first.toLowerCase();
}

// --------------------------------------------------------------------- shared

function reproject(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

/** Audit actor for the current caller: the operator (no user id) when the
 *  context is operator-authorized, else the human — after enforcing the
 *  human runtime RBAC. Operator authority is gated upstream by its capability
 *  policy (operator-actions.server), so operator callers skip the human check. */
function runtimeAuditActor(
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
  what: string,
): { userId: string | null; label: string } {
  if (ctx.operatorAuthorized) return { userId: null, label: "operator" };
  requireRuntimeRole(ctx, projectSlug, actor, what);
  return { userId: actor.userId, label: actor.label };
}

/**
 * RBAC gate reused by both fns: admin|maintainer against project membership
 * (contracts §3.2 "Open agent runtime sessions"). Mirrors the check
 * transition/interrupt use.
 */
function requireRuntimeRole(
  ctx: TaskMutationContext,
  projectSlug: string,
  actor: TaskActor,
  what: string,
): ProjectRole {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const role = file.parsed.frontmatter.members.find(
    (m) => m.userId === actor.userId,
  )?.role;
  if (!role) throw forbidden(`Only project members can ${what}.`);
  if (!roleCan(role, "run-agents")) {
    throw forbidden(`Your project role (${role}) cannot ${what}.`);
  }
  return role;
}

/** One deployed specialist as the task-detail assign menu offers it. */
export interface DeployedSpecialistView {
  id: string;
  name: string;
  role: string;
  backend: RealBackend;
  model: string;
  /** Reasoning effort (empty when unset) — carried so a comment-resume can
   *  apply the agent's current effort, not the prior run's. */
  effort: string;
  /** Stage ids this profile is eligible to work (F1 — now enforced, not just
   *  displayed). Empty when spanAll. */
  stages: string[];
  /** When true the profile is eligible across every stage. */
  spanAll: boolean;
}

/**
 * True when a specialist may work a task at `stageId`: it spans all stages, OR
 * declares no eligible stages (treated as unrestricted, back-compat), OR lists
 * this stage. Consumed by the operator picker and the assign/run guards (F1).
 */
export function specialistEligibleForStage(
  spec: { stages: string[]; spanAll: boolean },
  stageId: string,
): boolean {
  if (spec.spanAll) return true;
  if (spec.stages.length === 0) return true;
  return spec.stages.includes(stageId);
}

/**
 * Enforce agent stage eligibility (F1): reject assigning/running a specialist on
 * a task whose current stage the specialist isn't eligible for. The Agents UI
 * shows "N of M stages" per profile; this makes that promise real instead of
 * decorative. `spanAll` and no-declared-stages profiles are always eligible.
 */
function assertStageEligible(
  spec: { name: string; stages: string[]; spanAll: boolean },
  stageId: string,
): void {
  if (specialistEligibleForStage(spec, stageId)) return;
  throw AppError.validation(
    `${spec.name} is not eligible for the "${stageId}" stage — its profile is scoped to ${
      spec.stages.join(", ") || "no stages"
    }. Change the task's stage or the profile's eligible stages.`,
  );
}

/**
 * The project's deployed SPECIALIST agents (kind !== "operator"), resolved
 * from project.md `agents:` — what the loader passes so the UI can offer them
 * in the "Assign specialist" menu. Reads the loose `definition` the same way
 * the Agents surface does.
 */
export function listDeployedSpecialists(
  db: Database.Database,
  projectSlug: string,
  ctx: TaskMutationContext = {},
): DeployedSpecialistView[] {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) return [];
  const out: DeployedSpecialistView[] = [];
  for (const deployment of file.parsed.frontmatter.agents) {
    const view = effectiveProfileView(deployment, ctx.dataRoot);
    if (view.kind !== "specialist") continue;
    const resolved = toResolved(view);
    out.push({
      id: resolved.profileId,
      name: resolved.name,
      role: resolved.role,
      backend: resolved.backend,
      model: resolved.model,
      effort: resolved.effort,
      stages: resolved.stages,
      spanAll: resolved.spanAll,
    });
  }
  return out;
}

/** True when a run for this task is currently `running` (UI disables Run). */
export function hasRunningRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): boolean {
  return listRunsForTask(db, projectSlug, taskKey).some(
    (r) => r.lifecycle === "running",
  );
}
