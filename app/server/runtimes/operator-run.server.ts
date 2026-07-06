import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { getDataRoot, agentProfilesDir, skillDirPath } from "~/server/files/file-store-root.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { newId } from "~/shared/ids/new-id.server";
import {
  gate,
  operatorAcceptCompletion,
  operatorAssignReviewer,
  operatorAssignSpecialist,
  operatorPostComment,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorSnapshot,
  operatorTransitionStage,
  resolveOperatorAuthority,
  type OperatorAuthority,
  type OperatorAutonomy,
  type OperatorTaskSnapshot,
} from "~/server/tasks/operator-actions.server";
import { buildOperatorToolkit } from "~/server/tasks/operator-toolkit.server";
import { replyTextForRun } from "~/server/tasks/agent-reply.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import { isBackendAvailable, type RealBackend } from "./runtime-registry.server";
import { registerRunCompletion, startRun } from "./run-service.server";
import { buildScript } from "./simulated-runtime.server";

/**
 * Runs the OPERATOR as a real agent (Claude Code) or a deterministic scripted
 * drive (Codex / offline). The operator is given its persona (agent
 * definition) + the Viberr app-expertise skill as a system prompt, plus the
 * in-process governance tools (operator-toolkit). It drives the task toward
 * its next boundary under its capability policy + autonomy level.
 *
 *   claude + credential present → REAL tool-driven run: the model calls the
 *     `mcp__viberr__*` tools; every call mutates the store and updates the
 *     board live. This is the path the "operator end to end" proof exercises.
 *   codex, or claude unavailable → SCRIPTED drive: the same operator-actions
 *     are called deterministically in code (the board still advances honestly),
 *     and a simulated run streams the narrative to the agent logs. Codex has no
 *     in-process tool channel, so it always takes this path.
 */

const OPERATOR_AUDIT_ACTOR: AuditActor = { userId: null, label: "operator" };

export interface RunOperatorInput {
  projectSlug: string;
  taskKey: string;
  /** Backend to run the operator on (claude|codex). Defaults to the deployment. */
  backend?: RealBackend;
  /** Autonomy for THIS run (supervised|full). Defaults to the deployment. */
  autonomy?: OperatorAutonomy;
  dataRoot?: string;
  actor?: AuditActor;
}

export interface RunOperatorResult {
  runId: string;
  backend: RealBackend;
  /** "real" = LLM tool-driven · "scripted" = deterministic drive. */
  mode: "real" | "scripted";
  autonomy: OperatorAutonomy;
}

export async function runOperator(
  db: Database.Database,
  input: RunOperatorInput,
): Promise<RunOperatorResult> {
  const ctx: TaskMutationContext = {
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
  });
  const backend = authority.backend;

  // Claude: real tool-driven operator (in-process MCP tools). Codex: no
  // in-process tool channel, so it runs a real STRUCTURED-OUTPUT operator (the
  // model emits a decision plan we execute through the same capability-gated
  // actions). Neither available → deterministic scripted drive.
  if (backend === "claude" && isBackendAvailable("claude")) {
    return startRealOperatorRun(db, ctx, input, authority);
  }
  if (backend === "codex" && isBackendAvailable("codex")) {
    return startCodexOperatorRun(db, ctx, input, authority);
  }
  return runScriptedOperatorDrive(db, ctx, input, authority);
}

// ------------------------------------------------- codex (structured output)

/**
 * JSON schema constraining the codex operator's decision plan. OpenAI strict
 * structured output requires EVERY object to set additionalProperties:false and
 * list ALL properties in `required` — optional fields are expressed as nullable
 * (the model emits null when unused). The executor treats null/"" as absent.
 */
const OPERATOR_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoning: {
      type: "string",
      description: "A concise operator comment: observed → changed → recommended → decision required.",
    },
    actions: {
      type: "array",
      description: "The coordination actions to take, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: {
            type: "string",
            enum: [
              "post_comment",
              "assign_specialist",
              "run_specialist",
              "assign_reviewer",
              "run_reviewer",
              "transition_stage",
              "accept_completion",
            ],
          },
          profileId: { type: ["string", "null"], description: "For assign_/run_ actions, else null." },
          toStageId: { type: ["string", "null"], description: "For transition_stage, else null." },
          text: { type: ["string", "null"], description: "For post_comment, else null." },
          reason: { type: ["string", "null"], description: "Short why — shown on recommendation cards." },
        },
        required: ["tool", "profileId", "toStageId", "text", "reason"],
      },
    },
  },
  required: ["reasoning", "actions"],
} as const;

interface OperatorPlanAction {
  tool: string;
  profileId?: string;
  toStageId?: string;
  text?: string;
  reason?: string;
}

async function startCodexOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  const prompt = buildCodexOperatorPrompt(authority, snapshot, input.dataRoot);

  const { runId } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "codex",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    outputSchema: OPERATOR_PLAN_SCHEMA,
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  // When the run finishes, parse its decision plan and execute it through the
  // capability-gated operator-actions (so codex honors the exact same RBAC +
  // autonomy as the Claude tool-driven operator).
  registerRunCompletion(runId, (finished) => {
    void executeCodexPlan(db, ctx, input, authority, finished.id).catch((error) => {
      logger.error("codex operator plan execution failed", {
        taskKey: input.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  });

  logger.info("operator run started (codex structured output)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "codex", mode: "real", autonomy: authority.autonomy };
}

/** Pull the first JSON object out of a model response (tolerates prose around it). */
function extractPlanJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Execute a finished codex operator run's decision plan (capability-gated). */
async function executeCodexPlan(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  const text = replyTextForRun(db, runId);
  if (!text) {
    logger.info("codex operator produced no plan text", { taskKey: input.taskKey, runId });
    return;
  }
  const plan = extractPlanJson(text) as
    | { reasoning?: string; actions?: OperatorPlanAction[] }
    | null;
  if (!plan) {
    logger.warn("codex operator plan was not valid JSON", { taskKey: input.taskKey, runId });
    return;
  }
  const base = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  if (plan.reasoning) {
    await operatorPostComment(db, ctx, { ...base, text: plan.reasoning }, authority);
  }
  for (const a of plan.actions ?? []) {
    try {
      switch (a.tool) {
        case "post_comment":
          if (a.text) await operatorPostComment(db, ctx, { ...base, text: a.text }, authority);
          break;
        case "assign_specialist":
          if (a.profileId)
            await operatorAssignSpecialist(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "run_specialist":
          await operatorRunSpecialist(db, ctx, base, authority);
          break;
        case "assign_reviewer":
          if (a.profileId)
            await operatorAssignReviewer(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "run_reviewer":
          if (a.profileId) await operatorRunReviewer(db, ctx, { ...base, profileId: a.profileId }, authority);
          break;
        case "transition_stage":
          if (a.toStageId)
            await operatorTransitionStage(
              db,
              ctx,
              { ...base, toStageId: a.toStageId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "accept_completion":
          await operatorAcceptCompletion(db, ctx, base, authority);
          break;
      }
    } catch (error) {
      logger.error("codex operator action failed", {
        taskKey: input.taskKey,
        tool: a.tool,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

// ------------------------------------------------------- real (tool-driven)

async function startRealOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  const systemPrompt = buildOperatorSystemPrompt(authority, input.dataRoot);
  const toolkit = buildOperatorToolkit({
    db,
    ctx,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    authority,
  });
  const prompt = buildOperatorTurnPrompt(snapshot);

  const { runId } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "claude",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    systemPrompt,
    mcpServers: toolkit.mcpServers,
    allowedTools: toolkit.allowedTools,
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  logger.info("operator run started (real)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "claude", mode: "real", autonomy: authority.autonomy };
}

// ------------------------------------------------------- scripted drive

/**
 * Deterministic operator supervision: performs the same capability-gated
 * operator-actions in code, so a Codex / offline operator still moves the board.
 * Terminates: it makes at most one forward action per stage, stopping the first
 * time an action is only recommended (supervised autonomy) or denied.
 */
async function runScriptedOperatorDrive(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const { projectSlug, taskKey } = input;
  const lines: LogLine[] = [];
  const say = (text: string) =>
    lines.push({ t: "", ev: "text", tag: "assistant", text });

  lines.push({
    t: "",
    ev: "init",
    tag: "system·init",
    text: `operator runtime · ${authority.autonomy} autonomy · anchored projects/${projectSlug}/tasks/${taskKey}/task.md`,
  });

  try {
    let snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
    say(
      `Supervising ${taskKey} at stage “${snap.stageName}”. Autonomy: ${authority.autonomy}.`,
    );
    await operatorPostComment(
      db,
      ctx,
      {
        projectSlug,
        taskKey,
        text: `**Operator (${authority.autonomy}) engaged.** Plan: assign a specialist, drive toward the review boundary, then ${authority.autonomy === "full" ? "accept completion" : "recommend acceptance"}.`,
      },
      authority,
    );

    // Assign a primary specialist appropriate to the work, if none yet.
    if (!snap.specialist && snap.deployedSpecialists.length) {
      const pick = pickSpecialist(snap);
      if (pick) {
        const r = await operatorAssignSpecialist(
          db,
          ctx,
          { projectSlug, taskKey, profileId: pick.id },
          authority,
        );
        say(r.message);
      }
    }

    const doneStageId = snap.doneStageId;
    // Bounded forward drive.
    for (let step = 0; step < 8; step++) {
      snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
      if (snap.stage === doneStageId) break;

      const toDone = snap.nextStages.find((n) => n.id === doneStageId);
      if (toDone) {
        // At the boundary before Done — engage a reviewer, then accept.
        if (!snap.reviewers.length && gate(authority, "summon-reviewers") !== "deny") {
          const rev = pickReviewer(snap);
          if (rev) {
            const rr = await operatorAssignReviewer(
              db,
              ctx,
              { projectSlug, taskKey, profileId: rev.id },
              authority,
            );
            say(rr.message);
          }
        }
        const acc = await operatorAcceptCompletion(db, ctx, { projectSlug, taskKey }, authority);
        say(acc.message);
        break;
      }

      const next = snap.nextStages[0];
      if (!next) {
        say("No further governed transition from here — handing back to humans.");
        break;
      }
      const t = await operatorTransitionStage(
        db,
        ctx,
        { projectSlug, taskKey, toStageId: next.id },
        authority,
      );
      say(t.message);
      if (t.outcome !== "done") break; // recommended (supervised) → stop.
    }
  } catch (error) {
    logger.error("operator scripted drive failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    say("Operator halted on an error — see the task timeline.");
  }

  lines.push({
    t: "",
    ev: "result",
    tag: "result",
    text: "operator pass complete",
    stats: { subtype: "success", dur: 1200, api: 900, turns: 1, cost: 0, in: 0, cached: 0, out: 0 },
  });

  const sid = newId("op").replace("op_", "");
  const now = new Date().toISOString();
  const script = buildScript({
    lines,
    occurredAt: lines.map(() => now),
    sessionId: sid,
    backend: authority.backend,
    model: authority.model,
    op: true,
    keepRunning: false,
    instant: true,
  });

  const { runId } = await startRun(db, {
    projectSlug,
    taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: authority.backend,
    model: authority.model,
    agentName: authority.name,
    agentProfileId: "operator",
    prompt: `Supervise ${taskKey} toward its next boundary.`,
    script,
    simulate: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  logger.info("operator run started (scripted)", {
    taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: authority.backend, mode: "scripted", autonomy: authority.autonomy };
}

// ------------------------------------------------------- specialist picks

/** Prefer an implementation specialist eligible for the current stage. */
function pickSpecialist(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists;
  return (
    specs.find((s) => /develop|implement/i.test(s.role) || s.id === "developer") ??
    specs.find((s) => !/review/i.test(s.role)) ??
    specs[0] ??
    null
  );
}

/** Prefer a review specialist to engage before acceptance. */
function pickReviewer(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists.filter(
    (s) => !snap.reviewers.some((r) => r.profileId === s.id) && s.id !== snap.specialist?.profileId,
  );
  return (
    specs.find((s) => /review/i.test(s.role) || s.id === "reviewer") ??
    specs[0] ??
    null
  );
}

// ------------------------------------------------------- system prompt

/** Baked-in fallback persona when the store has no operator definition file. */
const FALLBACK_OPERATOR_DEFINITION = `You are the Operator: the coordinator for one Viberr task. You never write code and you never close a task unless full autonomy grants it. You are given the "viberr" governance tools and the Viberr app-expertise skill. Always call get_task first, then drive the task toward its next boundary using your tools, respecting your capability policy: perform direct actions, post recommendations for recommend-only actions and stop, and never attempt human-reserved actions. Keep every comment concise — each action appears on the human-visible board.`;

/** Read the shipped operator agent definition (body only), or the fallback. */
function readOperatorDefinition(dataRoot?: string): string {
  try {
    const file = path.join(agentProfilesDir(dataRoot), "..", "definitions", "operator.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      const trimmed = body.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    // fall through to the baked-in persona
  }
  return FALLBACK_OPERATOR_DEFINITION;
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

/** Assemble the operator's system prompt: persona + expertise + live policy. */
export function buildOperatorSystemPrompt(
  authority: OperatorAuthority,
  dataRoot?: string,
): string {
  const definition = readOperatorDefinition(dataRoot);
  const policyLines = [...authority.policy.entries()]
    .map(([id, mode]) => `- ${id}: ${mode}`)
    .join("\n");

  const parts = [definition];
  // Load EVERY declared skill that exists in the store (not just one), so the
  // operator's profile-declared skills are actually in its context.
  const skills = authority.skills.length ? authority.skills : ["viberr-app-expertise"];
  for (const name of skills) {
    const body = readSkillBody(name, dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (skill)\n\n${body}`);
  }
  parts.push(
    "\n\n---\n# Your authority for this task\n\n" +
      `Autonomy: **${authority.autonomy}**.\n\n` +
      "Capability policy (capabilityId: mode):\n" +
      policyLines +
      "\n\nRules:\n" +
      "- `direct` capabilities: act via the matching tool.\n" +
      "- `recommend` capabilities: under supervised autonomy the tool posts a recommendation and you must stop; under FULL autonomy it acts directly.\n" +
      "- `human` / `off` / withheld: the tool is not offered — never attempt it.\n" +
      "- Reach Done ONLY via accept_completion, and only under full autonomy; otherwise recommend acceptance.\n" +
      "- Never write code, run shell commands, or touch the repository. You have only the `mcp__viberr__*` tools.",
  );
  return parts.join("");
}

/**
 * The full prompt for the CODEX structured-output operator. Codex has no
 * system-prompt field and no in-process tools, so the persona + expertise, the
 * live task snapshot, and the output instruction all go in one prompt; the
 * model returns a decision plan (constrained by OPERATOR_PLAN_SCHEMA) that we
 * execute through the same capability-gated actions.
 */
export function buildCodexOperatorPrompt(
  authority: OperatorAuthority,
  snapshot: OperatorTaskSnapshot,
  dataRoot?: string,
): string {
  const persona = buildOperatorSystemPrompt(authority, dataRoot);
  return (
    persona +
    "\n\n---\n# This task\n\n" +
    "```json\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n```\n\n" +
    "# Your decision\n\n" +
    "You cannot call tools. Instead, DECIDE the coordination actions to take now and return them as a plan. " +
    "Use the deployedSpecialists' profileId values for assign actions, and nextStages' ids for transitions. " +
    "Respect your capability policy + autonomy: under supervised autonomy, governed actions become recommendation cards; " +
    "under full autonomy they are performed. Reach Done only via accept_completion (full autonomy).\n\n" +
    "Return ONLY a JSON object of the form " +
    `{ "reasoning": "<a concise operator comment>", "actions": [ { "tool": "assign_specialist", "profileId": "…", "reason": "…" }, { "tool": "transition_stage", "toStageId": "…", "reason": "…" } ] }. ` +
    "Include a short reason on each governed action (it is shown on the recommendation card)."
  );
}

/** The operator's opening turn prompt (points it at get_task). */
export function buildOperatorTurnPrompt(snapshot: OperatorTaskSnapshot): string {
  return (
    `You are operating task ${snapshot.key} — "${snapshot.title}". ` +
    `Goal: ${snapshot.goal}\n\n` +
    `It is currently at stage "${snapshot.stageName}" (autonomy: ${snapshot.autonomy}). ` +
    "Drive it toward its next boundary using your viberr tools.\n\n" +
    "Do this now:\n" +
    "1. Call get_task to see the live state, your policy, and the allowed next stages.\n" +
    "2. Post a brief plan comment.\n" +
    "3. Assign an appropriate primary specialist (if none is assigned).\n" +
    "4. Move the task forward through its allowed stage transitions.\n" +
    "5. Engage a reviewer as it enters the review stage.\n" +
    "6. Then accept completion (full autonomy) or recommend acceptance (supervised).\n\n" +
    "Respect your capability policy at every step. Keep comments concise."
  );
}
