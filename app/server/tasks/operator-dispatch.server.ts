/**
 * The operator running an agent (ruling 13(a)): dispatching an agent on a task
 * now (`operatorDispatchAgent`, with the selection it records) or on a
 * schedule, and cancelling a schedule.
 */

import { holdRefusalFor } from "~/server/projections/dependencies.server";
import {
  cancelScheduledAction,
  OPERATOR_SCHEDULER_ID,
  scheduleDueMs,
  scheduleTaskAction,
} from "./schedule.server";
import type { DatabaseSync } from "node:sqlite";
import { deliveringEngagement } from "~/schemas/task-file.schema";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { escapeRegExp } from "~/shared/text/regexp";
import { indefiniteArticle } from "~/shared/text/sentence";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import { operatorPromptAgent } from "./agent-completion.server";
import { OPERATOR_TASK_ACTOR } from "./task-action-core.server";
import { OPERATOR_AUDIT_ACTOR, recordAudit } from "~/server/audit/audit-recorder.server";
import { type TaskMutationContext, taskRef } from "./task-mutation.server";
import { cannotOwnDeliverySentence, canOwnDelivery } from "./specialist-prompt.server";
import { type DispatchHeldError, isDispatchHeld, startAgentRun } from "./specialist-run.server";
import {
  type DeployedSpecialistView,
  listDeployedSpecialists,
  projectBoard,
  runEligibilityFor,
} from "./specialist-roster.server";
import {
  readRequiredReviewers,
  requiredReviewerDeliversRefusal,
} from "./required-reviewers.server";
import { listMcpServerNames } from "~/server/org/resources.server";
import {
  dispatchGate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-authority.server";
import { addRecommendation, opCtx } from "./operator-packets.server";

/**
 * F21-6 — what a NON-delivering engagement is called.
 *
 * The schema already distinguishes the two (`!delivers && verdictCapable` makes
 * a required reviewer; everything else is supporting — task-file.schema), and
 * the execution profile renders them under "SUPPORTING AGENTS". This copy did
 * not: every non-delivering engagement was announced "as a reviewer". Live, the
 * Web Verifier profile (verdict = Off, so its report gates nothing) was engaged
 * "as a reviewer" and then displayed as supporting — two names for one thing,
 * and the misleading one implies acceptance-gating authority it does not hold.
 *
 * An UNKNOWN profile (not deployed) reads as supporting: the weaker claim is the
 * honest one when the grant cannot be resolved.
 */
function supportingRoleWord(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): "a reviewer" | "a supporting agent" {
  return deployedAgent(ctx, projectSlug, profileId)?.capabilities.verdict
    ? "a reviewer"
    : "a supporting agent";
}

/** Org MCP names compared loosely: `qa_echo`, `qa-echo` and `QA-Echo` are
 *  one server (the tool prefix a model sees is `mcp__<name>__…`). */
function mcpNameKey(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * F32-8 (pass 32): a directive that names an org MCP server the target profile
 * does NOT hold gets a server-attributed note appended — on the hand-off
 * comment AND the run's directive. Live (VIB-1, VIB-2) the operator's reviewer
 * brief said "re-call qa_echo yourself" to a Reviewer with no MCP grant (KBs are
 * inherited from the deliverer, R18-1; MCPs are not), and the reviewer burned
 * 20-30 turns per task hunting the tool. The snapshot the operator plans from
 * already carries `deployedSpecialists[].resources`; this makes the mismatch
 * impossible to hand off silently. Names are matched as whole words against
 * the instance registry, so ordinary prose never trips it.
 */
function annotateUngrantedMcps(
  db: DatabaseSync,
  agent: DeployedSpecialistView,
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return prompt;
  const held = new Set(agent.resources.mcps.map(mcpNameKey));
  const text = mcpNameKey(prompt);
  const ungranted = listMcpServerNames(db).filter((name) => {
    const key = mcpNameKey(name);
    if (held.has(key)) return false;
    return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(key)}([^a-z0-9-]|$)`).test(text);
  });
  if (ungranted.length === 0) return prompt;
  return (
    `${prompt}\n\n(Note from Viberr: ${agent.name} holds no MCP grant for ` +
    `${ungranted.map((n) => `\`${n}\``).join(", ")} on this project, so those ` +
    `tools will not be available to it; any evidence from them is already on ` +
    `the task timeline. Do not hunt for them.)`
  );
}

function deployedAgent(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): DeployedSpecialistView | null {
  return (
    listDeployedSpecialists(projectSlug, ctx).find((s) => s.id === profileId) ??
    null
  );
}

/**
 * Best-effort task-key branch creation on GitHub when a specialist is about to
 * work. Isolated + swallowing so a GitHub failure (or unconfigured repo) can
 * never fail the operator's coordination — ensureTaskBranch already returns
 * typed results and writes the branch name into task.md on success.
 */
async function ensureTaskBranchBestEffort(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  const { ensureTaskBranchBestEffort: shared } = await import(
    "~/server/github/branch-sync.server"
  );
  await shared(db, { projectSlug, taskKey }, OPERATOR_AUDIT_ACTOR, {
    dataRoot: ctx.dataRoot,
  });
}

/** One agent-selection decision, as the trace records it. */
interface AgentSelection {
  projectSlug: string;
  taskKey: string;
  profileId: string;
  delivers: boolean;
  /** The operator's stated reason, when it gave one. */
  reason?: string;
}

/** Best-effort audit trace for every operator profile selection. */
function recordAgentSelectionTrace(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: AgentSelection,
): void {
  try {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const stage = file?.parsed.frontmatter.stage;
    const engagements = file?.parsed.frontmatter.engagements ?? [];
    const engaged = new Set(engagements.map((e) => e.profileId));
    const board = projectBoard(ctx, input.projectSlug);
    const candidates = listDeployedSpecialists(input.projectSlug, ctx).map(
      (s) => ({
        profileId: s.id,
        // Ruling 181: may it RUN here (declared, or the engaged deliverer).
        eligibleForStage: stage
          ? runEligibilityFor(s, engagements, s.id, stage, board).ok
          : false,
        alreadyEngaged: engaged.has(s.id),
        // The posture the dispatch will TAKE: for the chosen profile the
        // resolved delivers intent (auto-engage included, so a first
        // dispatch reads `true` while `alreadyEngaged` is false); for every
        // other candidate its current engagement's posture.
        deliveringAtSelection:
          s.id === input.profileId
            ? input.delivers
            : engagements.some((e) => e.profileId === s.id && e.delivers),
        chosen: s.id === input.profileId,
      }),
    );
    recordAudit(db, {
      action: "task.operator.agent_selected",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        chosen: input.profileId,
        delivers: input.delivers,
        reason: input.reason ?? null,
        candidates,
      },
    });
  } catch {
    // Tracing must never block a routing decision.
  }
}

/**
 * The dynamic-dispatch rule this module and `startAgentRun`'s auto-engage
 * agree on (the trace below must record what the dispatch will actually do):
 * explicit hint wins; an engaged profile keeps its shape; an unengaged profile
 * delivers iff the task has no deliverer yet AND the profile holds a
 * repo-write grant — a verdict-only reviewer dispatched first on a fresh task
 * engages as supporting, never as a deliverer that can ship nothing.
 */
function resolveDeliversIntent(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  agent: DeployedSpecialistView,
  hint: boolean | undefined,
): boolean {
  if (hint !== undefined) return hint;
  const file = readTaskFile({
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  });
  const fm = file?.parsed.frontmatter;
  if (!fm) return false;
  const delivering = deliveringEngagement(fm);
  if (delivering?.profileId === agent.id) return true;
  if (fm.engagements.some((e) => e.profileId === agent.id)) return false;
  // Ruling 89: a reviewer the project requires is run to review, never
  // handed delivery by default, whatever its grants.
  if (readRequiredReviewers(projectSlug, ctx).some((rule) => rule.profileId === agent.id)) return false;
  return delivering === null && agent.capabilities.delivery;
}

/**
 * Dynamic-dispatch rework (2026-08-29): the ONE operator action for putting an
 * agent to work — the collapsed replacement for engage_agent / run_agent /
 * prompt_agent and the specialist/reviewer function pairs behind them. Gated by
 * `dispatch-agents` (the collapsed assign/summon pair):
 *
 *   direct    → engage-if-needed (capability-derived posture, inside
 *               `startAgentRun`), post the prompt as an operator comment when
 *               one is given, and start the run with it as the directive. A
 *               bare dispatch (no prompt) starts the run with no synthetic
 *               comment — the agent re-anchors on task.md.
 *   recommend → ONE `run_agent` card carrying the profile + prompt, which a
 *               human applies (the applied dispatch then runs exactly this).
 *   deny      → refused out loud (R19-6).
 */
export async function operatorDispatchAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    /** The run's directive; absent → a bare re-run with no hand-off comment. */
    prompt?: string;
    /** Explicit posture — `true` is a delivery hand-off (reassigns the
     *  delivering engagement); absent → derived (see resolveDeliversIntent). */
    delivers?: boolean;
    /** The operator's stated reason, when it gave one. */
    reason?: string;
    /** Ruling 93: this run puts the completeness question, so the
     *  verdict it returns is recorded as the reviewer's complete set. */
    completeness?: boolean;
    /** Ruling 124: this run must not judge, so its verdict tool is withheld
     *  and nothing it writes is read as a verdict. */
    noVerdict?: boolean;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = dispatchGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Dispatching agents is not permitted for the operator here.",
    };
  }
  const agent = deployedAgent(ctx, input.projectSlug, input.profileId);
  if (!agent) {
    return {
      outcome: "noop",
      message: `No deployed agent "${input.profileId}" to run. Pick a profile from get_task's deployedSpecialists.`,
    };
  }
  const prompt = annotateUngrantedMcps(db, agent, input.prompt?.trim() || undefined);
  // Hunt 2026-08-29: refuse the two CONTRADICTORY hints up front, before any
  // card or trace can announce a posture the dispatch would not install.
  // (1) `delivers: true` for a profile with no repo-write grant — the dispatch
  // refuses it at both engage doors; filing a card for it would strand a
  // maintainer's Apply on that refusal.
  // Ruling 128: an agent that can post files on the task can own a results
  // task's delivery without a repo-write grant.
  if (input.delivers === true && !canOwnDelivery(agent, input.delivers)) {
    return { outcome: "noop", message: cannotOwnDeliverySentence(agent.name) };
  }
  // (2) `delivers: false` aimed at the CURRENT deliverer — dispatchAgentRun
  // deliberately keeps an engaged profile's shape (a delivering run cannot be
  // demoted per-dispatch), so honoring the hint in the label/trace while the
  // run went out `kind: "primary"` was a governed lie.
  const currentDeliverer = ((): string | null => {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    return file
      ? (deliveringEngagement(file.parsed.frontmatter)?.profileId ?? null)
      : null;
  })();
  if (input.delivers === false && currentDeliverer === input.profileId) {
    return {
      outcome: "noop",
      message:
        `${agent.name} IS the delivering agent on this task; its runs deliver. ` +
        `Omit \`delivers\` to run it, or hand delivery to another repo-write ` +
        `profile first (\`delivers: true\` on that profile).`,
    };
  }
  const delivers = resolveDeliversIntent(
    ctx,
    input.projectSlug,
    input.taskKey,
    agent,
    input.delivers,
  );
  // Ruling 128: nor to a reviewer the project requires. The engage refuses it
  // (`assignSpecialist`), and a card for it would strand Apply on that refusal.
  if (delivers && currentDeliverer !== input.profileId) {
    const reviews = readRequiredReviewers(input.projectSlug, ctx).filter(
      (rule) => rule.profileId === input.profileId,
    );
    if (reviews.length > 0) {
      return {
        outcome: "noop",
        message: requiredReviewerDeliversRefusal(agent.name, input.taskKey, reviews),
      };
    }
  }
  const as = delivers
    ? "the delivering agent"
    : supportingRoleWord(ctx, input.projectSlug, input.profileId);

  if (g === "recommend") {
    const rec: Parameters<typeof addRecommendation>[4] = {
      kind: "run_agent",
      profileId: input.profileId,
      label: `Run ${agent.name}`,
    };
    if (prompt) rec.prompt = prompt;
    // Persist the EXPLICIT hint so Apply dispatches what this arm announced —
    // the card used to drop it and Apply re-derived, sometimes the opposite.
    if (input.delivers !== undefined) rec.delivers = input.delivers;
    if (input.completeness) rec.completeness = true;
    if (input.noVerdict) rec.noVerdict = true;
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      rec,
      input.reason ??
        prompt ??
        `${agent.name} fits what the current stage needs; a maintainer starts the run.`,
    );
    return {
      outcome: "recommended",
      message: `Recommended running ${agent.name} as ${as}.`,
    };
  }

  // direct
  const selection: AgentSelection = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    delivers,
  };
  if (input.reason) selection.reason = input.reason;
  recordAgentSelectionTrace(db, ctx, selection);
  // Ruling 228: only a deliverer that writes the repository owns a branch. One
  // whose delivery is the files it saves on the task (ruling 128) never puts a
  // commit on one: live, the AWS board left 91 branches on its repository,
  // none of them ahead of `main`.
  if (delivers && agent.capabilities.delivery) {
    // Delivery spine (FR31): the agent is about to own the branch — ensure the
    // task-key branch exists on GitHub. Best-effort, degrades cleanly.
    await ensureTaskBranchBestEffort(db, ctx, input.projectSlug, input.taskKey);
  }
  // Ruling 151 (pass 35, G35-4): a HOLD is the task's state ruling the
  // dispatch out for now, which is exactly what `noop` means — never a
  // failure. The plan says so and the Codex operator makes it load-bearing:
  // its plan executor ABORTS every remaining action on a thrown one and writes
  // "Coordination stopped" on the timeline, so a held `run_agent` step cost the
  // rest of a paid turn (the transitions, comments and packets after it) for a
  // hold whose own note says nothing was dispatched and no decision is needed.
  // The retry is already on the task's schedule, so the message ends the
  // subject rather than inviting a packet.
  const heldNoop = (error: DispatchHeldError): OperatorActionResult => {
    // Ruling 124: the hold is scoped to (backend, TASK OWNER) — every run on
    // this task bills that one person (ruling 137) — so "pick a <other>
    // profile" only helps when the OWNER has the other backend connected. When
    // they do not, the operator follows the advice, the dispatch is refused on
    // the owner's credential, and the failure opens the very packet this
    // sentence forbade. So the alternative is offered only when it exists.
    const otherBackend: RealBackend = error.hold.backend === "codex" ? "claude" : "codex";
    const other = BACKEND_LABEL[otherBackend];
    const ownerId =
      readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter
        .ownerUserId ?? null;
    const fallbackReachable =
      ownerId !== null && isBackendAvailableFor(db, ownerId, otherBackend);
    return {
      outcome: "noop",
      message:
        `${error.userMessage} Do not open a packet for this; ` +
        (fallbackReachable
          ? `pick a ${other} profile if the work cannot wait.`
          : `there is no ${other} fallback either. This task's runs bill its owner, ` +
            `who has no ${other} account connected. The retry is already scheduled.`),
    };
  };
  if (prompt) {
    const promptInput: Parameters<typeof operatorPromptAgent>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: input.profileId,
      handle: agent.name,
      directive: prompt,
    };
    // Thread only the EXPLICIT hint: the auto-engage derives the posture with
    // the same rule as the trace above, and an explicit `true` is what asks
    // assignSpecialist for a delivery hand-off.
    if (input.delivers !== undefined) promptInput.delivers = input.delivers;
    if (input.completeness) promptInput.completeness = true;
    if (input.noVerdict) promptInput.noVerdict = true;
    let prompted: Awaited<ReturnType<typeof operatorPromptAgent>>;
    try {
      prompted = await operatorPromptAgent(db, promptInput, ctx);
    } catch (error) {
      if (isDispatchHeld(error)) return heldNoop(error);
      throw error;
    }
    // Ruling 152 (F37-93): "and started its run" was said for a run that was
    // refused before any process existed, and for one parked behind the cap.
    // The operator plans its next move on this sentence.
    if (prompted.outcome === "refused") {
      return {
        outcome: "noop",
        message:
          `The prompt is on the timeline for @${agent.name} (${as}), but no run started: ` +
          `${prompted.refusal ?? "the run was refused before any process started."} ` +
          `Re-send it once that is resolved.`,
      };
    }
    if (prompted.outcome === "queued") {
      return {
        outcome: "done",
        message:
          `Prompted @${agent.name} (${as}). The instance is at its concurrent-run cap, ` +
          `so the run is queued and starts when a slot frees.`,
      };
    }
    return {
      outcome: "done",
      message: `Prompted @${agent.name} (${as}) and started its run.`,
    };
  }
  const dispatch: Parameters<typeof startAgentRun>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
  };
  if (input.delivers !== undefined) dispatch.delivers = input.delivers;
  if (input.completeness) dispatch.completeness = true;
  if (input.noVerdict) dispatch.withholdVerdict = true;
  let result: Awaited<ReturnType<typeof startAgentRun>>;
  try {
    result = await startAgentRun(db, dispatch, OPERATOR_TASK_ACTOR, opCtx(ctx));
  } catch (error) {
    if (isDispatchHeld(error)) return heldNoop(error);
    throw error;
  }
  if (result.outcome === "refused") {
    return {
      outcome: "noop",
      message:
        `No run started for ${agent.name} (${as}): ` +
        `${result.refusal ?? "the run was refused before any process started."} ` +
        `Try again once that is resolved.`,
    };
  }
  if (result.outcome === "queued") {
    return {
      outcome: "done",
      message:
        `${agent.name}'s (${as}) run is queued: the instance is at its concurrent-run cap, ` +
        `so it starts when a slot frees.`,
    };
  }
  return {
    outcome: "done",
    message: `Started a ${BACKEND_LABEL[result.backend]} run for ${agent.name} (${as}).`,
  };
}

/** Ruling 125: the refusal both schedule verbs give an operator whose
 *  `dispatch-agents` grant is not `direct`, or null when it is. */
function scheduleGrantRefusal(authority: OperatorAuthority): OperatorActionResult | null {
  const g = dispatchGate(authority);
  if (g === "direct") return null;
  return {
    outcome: "denied",
    message:
      g === "recommend"
        ? "Scheduling a run needs a `direct` `dispatch-agents` grant: a scheduled run starts with " +
          "nobody present, and yours has a person start every run you propose. Recommend the run " +
          "with `run_agent` when it is due."
        : "Dispatching agents is not permitted for the operator here, so scheduling a run is not either.",
  };
}

/**
 * Ruling 125: why this agent could not be dispatched on the task NOW, or null.
 * The same gates its immediate `run_agent` meets at the dispatcher: a
 * dependency hold (ruling 56) and the stage the task stands at (ruling 181:
 * the engaged deliverer runs at every stage, anyone else at the stages it
 * declares). A schedule is that dispatch with a date on it, so it may not
 * reach what the dispatch could not.
 */
function dispatchRefusalNow(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  agent: DeployedSpecialistView,
): string | null {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const fm = file.parsed.frontmatter;
  if (fm.blockedBy.length > 0) {
    return holdRefusalFor(db, projectSlug, taskKey, fm.blockedBy, "scheduling an agent run on it");
  }
  const eligibility = runEligibilityFor(
    agent,
    fm.engagements,
    agent.id,
    fm.stage,
    projectBoard(ctx, projectSlug),
  );
  return eligibility.ok ? null : eligibility.refusal;
}

/**
 * Ruling 125 (F40-65): the operator schedules a future run on its OWN task:
 * its own re-run, or a deployed agent's run with a directive, 1 minute to 28
 * days out. It is the controller's `schedule_task_action` (ruling 264) at the
 * operator's door: the same `schedules[]` entry, the same firing path (the
 * profile deployed when it fires), the same `task.schedule.created` row and
 * "Scheduled:" line, attributed to the operator.
 *
 * Live on WEB-9 the task had to read a deployed cron run at 12:17Z. The
 * operator could not set that run itself, so it asked the owner to route one
 * through the controller and then opened a packet only to record the wait.
 * Scheduling adds no authority: it is the dispatch the operator already holds,
 * gated the same way (`scheduleGrantRefusal`, `dispatchRefusalNow`).
 */
export async function operatorScheduleRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    /** "operator" for its own re-run, or a deployed profile id. */
    agent: string;
    delayMinutes?: number;
    /** An ISO instant. Give this or `delayMinutes`. */
    dueAt?: string;
    /** The steer for its own re-run, or the agent's directive. */
    prompt?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const refused = scheduleGrantRefusal(authority);
  if (refused) return refused;
  const nowMs = Date.now();
  let dueMs: number;
  try {
    dueMs = scheduleDueMs(input, nowMs);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // The model has no clock of its own: the refusal says what "now" is.
    return {
      outcome: "noop",
      message: `${error.userMessage} It is ${new Date(nowMs).toISOString()} now.`,
    };
  }
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length > 4000) {
    return { outcome: "noop", message: "Keep the run prompt under 4000 characters." };
  }
  const target = input.agent.trim();
  const schedInput: Parameters<typeof scheduleTaskAction>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dueAt: new Date(dueMs).toISOString(),
    prompt,
  };
  let what = "your own re-run";
  if (target.toLowerCase() !== "operator") {
    const agent = deployedAgent(ctx, input.projectSlug, target);
    if (!agent) {
      return {
        outcome: "noop",
        message:
          `No deployed agent "${target}" to schedule. Pick a profile from get_task's ` +
          `deployedSpecialists, or "operator" for your own re-run.`,
      };
    }
    const notNow = dispatchRefusalNow(db, ctx, input.projectSlug, input.taskKey, agent);
    if (notNow) {
      return {
        outcome: "noop",
        message: `${agent.name}'s run cannot be scheduled, because it could not be dispatched now: ${notNow}`,
      };
    }
    schedInput.action = "run-agent";
    schedInput.profileId = agent.id;
    what = `${indefiniteArticle(agent.name)} ${agent.name} run`;
  }
  let scheduled: Awaited<ReturnType<typeof scheduleTaskAction>>;
  try {
    scheduled = await scheduleTaskAction(db, schedInput, OPERATOR_AUDIT_ACTOR, opCtx(ctx));
  } catch (error) {
    // A closed task refuses with the closure sentence (ruling 52): the
    // task's state, not the policy.
    if (error instanceof AppError && error.status === 400) {
      return { outcome: "noop", message: error.userMessage };
    }
    throw error;
  }
  const minutes = Math.round((Date.parse(scheduled.dueAt) - nowMs) / 60_000);
  return {
    outcome: "done",
    message:
      `Scheduled ${what} on ${input.taskKey} for ${scheduled.dueAt}, in ${minutes} minutes ` +
      `(${scheduled.id}). It runs on the profile deployed when it fires, and get_task lists it ` +
      "under `schedules`. A hold it explains needs no decision packet: one note naming it is the record.",
  };
}

/**
 * Ruling 125: cancel a pending run the operator scheduled on its OWN task. The
 * task is the one this toolkit is bound to, so another task's entry is simply
 * not there; a person's entry (the task page, the controller) is theirs to
 * cancel, never the operator's.
 */
export async function operatorCancelSchedule(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; scheduleId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const refused = scheduleGrantRefusal(authority);
  if (refused) return refused;
  const scheduleId = input.scheduleId.trim();
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const schedules = file.parsed.frontmatter.schedules;
  const entry = schedules.find((s) => s.id === scheduleId && s.status === "pending");
  if (!entry) {
    const pending = schedules.filter((s) => s.status === "pending").map((s) => s.id);
    return {
      outcome: "noop",
      message:
        `${scheduleId} is not a pending schedule on ${input.taskKey}. ` +
        (pending.length > 0 ? `Pending here: ${pending.join(", ")}.` : "Nothing is scheduled on it."),
    };
  }
  if (entry.createdBy !== OPERATOR_SCHEDULER_ID) {
    return {
      outcome: "denied",
      message:
        `${scheduleId} was scheduled by ${entry.createdByLabel || "a person"}, so it is theirs to ` +
        "cancel, not yours. If it no longer fits the task, say so in a comment.",
    };
  }
  const result = await cancelScheduledAction(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey, scheduleId },
    OPERATOR_AUDIT_ACTOR,
    opCtx(ctx),
  );
  return result.cancelled
    ? { outcome: "done", message: `Cancelled ${scheduleId} on ${input.taskKey}.` }
    : { outcome: "noop", message: `${scheduleId} is not pending on ${input.taskKey}.` };
}
