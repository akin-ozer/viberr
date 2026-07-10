import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type {
  AgentRef,
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
  kbDirPath,
  skillDirPath,
  taskDir,
} from "~/server/files/file-store-root.server";
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
} from "~/server/runtimes/model-catalog.server";
import {
  buildScript,
  type SimulatedScript,
} from "~/server/runtimes/simulated-runtime.server";
import { listRunsForTask, startRun } from "~/server/runtimes/run-service.server";
import { newId } from "~/shared/ids/new-id.server";
import { resolveSpecialistDisallowedTools } from "./specialist-tool-policy";
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
  input: { projectSlug: string; taskKey: string; directive?: string },
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
  const backend: RealBackend = sp.backend === "codex" ? "codex" : "claude";
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
  try {
    const resolved = resolveDeployedSpecialist(ctx, input.projectSlug, sp.profileId);
    model = resolved.model;
    effort = resolved.effort;
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
  } catch {
    // Profile may have been undeployed since assignment — keep the default.
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
  const clone =
    repo && isBackendAvailable(backend)
      ? await cloneRepo(db, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          dataRoot: ctx.dataRoot,
        })
      : null;

  const analyzePrompt = buildAnalyzePrompt({
    role: sp.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    cloned: !!clone,
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = foldPersonaForCodex(persona, backend, analyzePrompt);

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
    ...(clone ? { workdir: clone } : {}),
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

  // Every specialist run reports back: register the default reply hook so the
  // agent posts its result as a comment even when started from the UI "Run"
  // button. Richer callers (operator prompt / @mention) overwrite this.
  const { registerAgentReply } = await import("./task-actions.server");
  await registerAgentReply(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    backend,
    role: sp.role,
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
  input: { projectSlug: string; taskKey: string; profileId: string; directive?: string },
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
  const backend: RealBackend = rev.backend === "codex" ? "codex" : "claude";

  let model = defaultModelFor(backend);
  let effort = "";
  let agentName = rev.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  let disallowedTools: string[] = [];
  try {
    const resolved = resolveDeployedSpecialist(ctx, input.projectSlug, rev.profileId);
    model = resolved.model;
    effort = resolved.effort;
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
  } catch {
    // Profile may have been undeployed since engagement — keep the default.
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

  const clone =
    repo && isBackendAvailable(backend)
      ? await cloneRepo(db, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          dataRoot: ctx.dataRoot,
        })
      : null;

  const analyzePrompt = buildAnalyzePrompt({
    role: rev.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    cloned: !!clone,
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const prompt = foldPersonaForCodex(persona, backend, analyzePrompt);

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
    ...(clone ? { workdir: clone } : {}),
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

  // A reviewer reports back too: register the default reply hook so its verdict
  // posts as a comment even when the run was started from the UI "Run" button.
  const { registerAgentReply } = await import("./task-actions.server");
  await registerAgentReply(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    backend,
    role: rev.role,
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
 * reports back, the Reviewer critiques, the Tester validates — rather than a
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
  // exists in the store, same as skills.
  for (const name of input.kb ?? []) {
    const body = readKbBody(name, input.dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
  }
  return parts.join("");
}

/** Read a knowledge base's docs from the store (every `.md` under
 *  `data/kb/<dir>/`), bounded so a large KB can't blow the context window.
 *  Returns "" when the folder is absent. */
function readKbBody(name: string, dataRoot?: string): string {
  try {
    const dir = kbDirPath(name, dataRoot);
    if (!existsSync(dir)) return "";
    const docs: string[] = [];
    let budget = 24_000;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md") || budget <= 0) continue;
      try {
        const slice = readFileSync(path.join(dir, entry), "utf8").trim().slice(0, budget);
        budget -= slice.length;
        docs.push(`### ${entry}\n\n${slice}`);
      } catch {
        // unreadable doc — skip
      }
    }
    return docs.join("\n\n");
  } catch {
    return "";
  }
}

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
): string {
  if (!persona || backend !== "codex") return prompt;
  return `${persona}\n\n---\n# Your task\n\n${prompt}`;
}

// ----------------------------------------------------------------- prompt/script

function buildAnalyzePrompt(input: {
  role: string;
  taskKey: string;
  title: string;
  goal: string;
  repo: string | null;
  cloned: boolean;
  /** An operator directive that becomes the run's turn focus (when present). */
  directive?: string;
}): string {
  let prompt =
    `You are the ${input.role} specialist on task ${input.taskKey}: ` +
    `"${input.title}". Goal: ${input.goal}. Analyze the repository and report ` +
    `your findings (structure, dependencies, architecture, notable risks/gaps) ` +
    `as a concise summary.`;
  if (input.repo && !input.cloned) {
    prompt += ` Clone the repo yourself from https://github.com/${input.repo} if needed.`;
  }
  if (input.directive?.trim()) {
    prompt +=
      `\n\nThe operator has engaged you and directs: "${input.directive.trim()}" ` +
      `Address that directive as you work, then give a concise reply.`;
  }
  return prompt;
}

/** Classify a specialist by its role label so the simulated report and persona
 *  match what the agent actually does (developer implements, reviewer critiques,
 *  tester validates). Anything unrecognized reports as a developer. */
function classifyRole(role?: string): "developer" | "reviewer" | "tester" {
  const r = (role ?? "").toLowerCase();
  if (/review/.test(r)) return "reviewer";
  if (/test|valid|qa/.test(r)) return "tester";
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
        `@operator — reviewed the change against the goal. Correctness: the logic ` +
        `holds on the paths that matter. Security: input is validated and no ` +
        `secrets leak. Tests: the new behavior is covered. No blocking findings ` +
        `(one nit: a comment could be clearer). Verdict: **approve** — ready to accept.`
      );
    }
    if (kind === "tester") {
      return (
        `@operator — validated the change. Exercised the happy path plus empty, ` +
        `boundary, and error-path cases, and added a test for the empty-input case ` +
        `that was previously uncovered. Full suite passes. Verdict: **pass** — no blockers.`
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
    return "Review findings: the change is small and localized; no obvious correctness or security issues in the diff, and the existing tests still pass. Before acceptance I'd want a test that exercises the new path.";
  }
  if (kind === "tester") {
    return "Validation findings: the existing suite passes, but coverage of the new path is thin — the empty and boundary cases are not exercised yet, which is the main gap for this goal.";
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
      taskDir(input.projectSlug, input.taskKey, input.dataRoot),
      "workspace",
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
  if (role !== "admin" && role !== "maintainer") {
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
