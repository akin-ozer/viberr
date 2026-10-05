import {
  projectRulingsKb,
  withProjectRulings,
} from "~/server/files/project-rulings.server";
import { activeFileLeases } from "./file-leases.server";
import { reviewSubjectSha } from "~/shared/revision-drift";
import { closureRefusal, taskClosure } from "./task-closure.server";
import { existsSync, mkdirSync } from "node:fs";
import { shareDirWithAgents } from "~/server/runtimes/agent-isolation.server";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  activeWorkRevision,
  deliveringEngagement,
  type FileActorRef,
  type ParsedTaskFile,
  reviewSubjectId,
  supportingEngagements,
} from "~/schemas/task-file.schema";
import {
  AGENT_OUTCOME_JSON_SCHEMA,
  holdsCollaborationGrant,
  resolveAgentCollab,
} from "./agent-outcome.server";
import { holdRefusalFor } from "~/server/projections/dependencies.server";
import { buildAgentToolkit, type AgentToolkit } from "./agent-toolkit.server";
import { withheldAgentGrants } from "~/features/agents/capability-catalog";
import { type AuditActor, recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import {
  mountGrantedSkills,
  removeSkillPlugin,
  type SkillMount,
  type SkillPlugin,
} from "~/server/runtimes/skill-mount.server";
import { logger } from "~/server/logging/logger.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  refusedPrincipalUserId,
  resolveTaskRunPrincipal,
} from "~/server/runtimes/run-principal.server";
import {
  backendDispatchHold,
  UNDATED_HOLD_MS,
  type BackendDispatchHold,
} from "~/server/runtimes/backend-quota.server";
import { formatResetLabel } from "./run-failure-remedy.server";
import {
  defaultModelFor,
  resolveRunEffort,
  substituteRunModel,
} from "~/server/runtimes/model-catalog.server";
import {
  ensureTaskBranchBestEffort,
  taskBranchName,
} from "~/server/github/branch-sync.server";
import {
  RUN_PHASE,
  type RunMcpServers,
} from "~/server/runtimes/adapter.server";
import {
  assertRunReservationLive,
  reserveRun,
  startRun,
  type RunReservation,
  type RunStartOutcome,
  type StartRunInput,
  repoWriteWithheldFromDenylist,
} from "~/server/runtimes/run-service.server";
import { listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import { newId } from "~/shared/ids/new-id.server";
import type { McpToolDenial } from "~/shared/mcp-tools";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  resolveDeliveryPermissions,
  resolveSpecialistDisallowedTools,
  resolveUndeployedDisallowedTools,
} from "./specialist-tool-policy";
import { BOARD_MCP_NAME } from "~/server/mcp-proxy/board-tool.server";
import { KNOWLEDGE_MCP_NAME } from "~/server/mcp-proxy/knowledge-tool.server";
import {
  resolveBoardMcp,
  resolveKnowledgeMcp,
  resolveSpecialistMcpServersDetailed,
  verifyStdioMcpMountsForRun,
} from "./specialist-mcp.server";
import { BROWSER_MCP_NAME, resolveBrowserMcp } from "./specialist-browser-mcp.server";
import { cloneProgressStep, cloneStepLabel, mirrorIsCold } from "./repo-mirror.server";
// Values come from the leaf substrate, never the task-action modules, which
// load THIS module when they run (see task-mutation.server.ts).
import {
  appendPolicyNote,
  reprojectTask,
  stageDisplayName,
  taskRef,
  type TaskActor,
  type TaskMutationContext,
} from "./task-mutation.server";
import { userDisplayName } from "./user-display-name.server";
import { readRequiredReviewers } from "./required-reviewers.server";
import { getMaxRunSpendUsd } from "~/server/settings/instance-settings.server";

/**
 * Assign a deployed specialist agent to a task and start its provider run.
 *
 * RBAC (both fns): admin|maintainer — contracts §3.2 "Open agent runtime
 * sessions". Mirrors the transition/interrupt project-membership check.
 */

// ------------------------------------------------------- canonical re-anchor

/**
 * P19-G0 — the canonical task-state block for a FRESH run.
 *
 * PRD Runtime continuity: "Any reactivated agent re-anchors on the canonical
 * task artifact before acting", and FR22 promises a continuation that holds
 * "even when prior runtime history is unavailable". Until now exactly one path
 * honoured that: the @mention RESUME, whose whole prompt is
 * `specialistReplyDirective` and which prepends the anchor to it. Every FRESH
 * run — the UI's Run button, the operator's `run_agent`/`prompt_agent`, and a
 * FIRST @mention of an agent that has no prior session — received
 * `buildAnalyzePrompt`: role, title, goal, the repo/branch contract, the
 * directive and the trust boundary, and NOT ONE fact about what has already
 * happened on the task. No timeline, no prior verdict, no open decision packet.
 *
 * That is the rework loop's central failure. A reviewer re-run on revision 2
 * could not tell whether the change it asked for on revision 1 had been made;
 * the deliverer re-prompted for that rework had no record of why it made the
 * choices sitting in its own branch. There is no pull-side substitute either:
 * the specialist MCP surface has no task-read tool, and the run cwd is ALWAYS
 * the isolated workspace, never the task dir, so `task.md` is not reachable
 * from inside the run. Continuity was whatever the operator retyped.
 *
 * ONE anchor implementation, not two: `canonicalTaskAnchor` (task-replies) is
 * already the shape ruled correct for the resume path and is prompt-budget
 * clamped on every axis. Imported dynamically, like every reach from this
 * module into the task-action modules (ruling 207(e)).
 *
 * Best-effort by design: a task whose project file cannot be read still runs —
 * it falls back to the raw stage id, exactly as the resume path does, and only
 * a genuinely unbuildable anchor is dropped.
 */
async function freshRunAnchor(
  ctx: TaskMutationContext,
  projectSlug: string,
  parsed: ParsedTaskFile,
  boardReader: boolean,
): Promise<string | null> {
  try {
    const { canonicalTaskAnchor } = await import("./task-replies.server");
    return canonicalTaskAnchor({
      parsed,
      stageName: stageDisplayName(ctx, projectSlug, parsed.frontmatter.stage),
      boardReader,
      // Ruling 245: read at anchor time, so a lease set mid-flight binds the
      // very next run rather than the one after a restart.
      // Ruling 245(b): resolved, so a run is never warned off a file whose
      // holder has already landed.
      fileLeases: activeFileLeases(projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
      // Ruling 482: the project's gates as Viberr ran them, so a reviewer
      // reads the record instead of re-running the gates to report them.
      gates:
        readProjectFile(
          ctx.dataRoot ? { projectSlug, dataRoot: ctx.dataRoot } : { projectSlug },
        )?.parsed.frontmatter.gates ?? [],
    });
  } catch (error) {
    logger.warn("canonical anchor could not be built for a fresh run", {
      projectSlug,
      taskKey: parsed.frontmatter.key,
      err: toError(error),
    });
    return null;
  }
}

// ------------------------------------------------------- run-input disclosure

// Ruling 344: the run-input disclosure moved to `~/server/runtimes/run-inputs.server`,
// where the operator and controller can reach it without importing this runtime.
// Re-exported because this module is still where the specialist paths use it and
// where the tests for the specialist half live.
import {
  recordRunInputs,
  resolvedResourceInputs,
  type ResolvedResourceInputs,
} from "~/server/runtimes/run-inputs.server";
import { fileWriteRoots } from "~/server/runtimes/file-tool-policy.server";
import { joinedPrompt, type RunPrompt, sortedNames } from "~/server/runtimes/prompt-prefix.server";
import { specialistCompactAnchor } from "~/server/runtimes/context-policy.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  agentEvent,
  deliveringContextGrants,
  KB_CORRECTION_NOTE_CLAUDE,
  KB_CORRECTION_NOTE_CODEX,
  listDeployedSpecialists,
  mcpServersFor,
  personGitOrNull,
  projectBoard,
  RELAY_NOTE_CLAUDE,
  RELAY_NOTE_CODEX,
  REREVIEW_RESTATES_NOTE,
  resolveDeployedSpecialist,
  type ResolvedSpecialist,
  runDispatchLine,
  runEligibilityFor,
  type RunMcpMounts,
  runtimeAuditActor,
  type SkillMountInput,
  withDeliveringGrants,
} from "./specialist-roster.server";
import {
  agentGitIdentity,
  agentGitIdentityEnv,
  cloneRepo,
  projectRepo,
  taskCloneDir,
  taskWorkspaceRoot,
  workspaceRunEnv,
} from "./specialist-workspace.server";
import {
  type AnalyzePromptInput,
  buildAnalyzePrompt,
  buildSpecialistPromptPrefix,
  cannotOwnDeliverySentence,
  canOwnDelivery,
  directiveRequestsDelivery,
  githubReadForRun,
  knowledgeBaseReadDirs,
  prAnchor,
  type PromptCloneFailure,
  type SpecialistPersonaInput,
} from "./specialist-prompt.server";
import { assignReviewer, assignSpecialist } from "./specialist-assignment.server";

export {
  recordRunInputs,
  resolvedResourceInputs,
  type ResolvedResourceInputs,
};

// -------------------------------------------------------------- startAgentRun

export interface StartAgentRunResult {
  runId: string;
  backend: RealBackend;
  role: string;
  /** The agent's display name (deployment name; profile id when unresolvable). */
  name: string;
  /**
   * Ruling 263 (pass 37, F37-93): what the dispatch actually did.
   *
   * A dispatch that returns is not a dispatch that started a provider process.
   * A run whose principal has no credential for this backend becomes a run ROW
   * recording the refusal and nothing else (ruling 127), and a run that finds
   * the concurrency cap full is parked as `queued` until a slot frees. Both
   * used to be indistinguishable here from a live run, so `run_agent_on_task`
   * answered `[done] … run started` for all three under a tool description
   * promising it "reports honestly whether a run started".
   */
  outcome: RunStartOutcome;
  /** The refusal sentence the run recorded, when `outcome` is `"refused"`. */
  refusal: string | null;
}

/** The reservation `dispatchAgentRun` claims mid-flight, so the exported
 *  wrapper can release it when preparation throws (R21-4). A box, not a return
 *  value: the throw is exactly the path that produces no return value. */
interface PendingReservation {
  reservation: RunReservation | null;
  /** Ruling 180: the skill plugin built for a run that has not started yet —
   *  removed by the wrapper when the dispatch fails before `startRun` adopts
   *  it; null once the run owns it (run-service removes it at settle). */
  skillPlugin: SkillPlugin | null;
}

/**
 * Start an engaged agent from its current deployment and task workspace.
 *
 * R21-4: the dispatch claims a live run row BEFORE the workspace clone (so the
 * task page shows "Preparing workspace" instead of nothing for minutes). That
 * row is `running` and, for a delivering run, occupies the single-flight slot —
 * so a preparation failure has to release it here, or the task would refuse
 * every further delivering run until the process restarts.
 */
export interface StartAgentRunInput {
  projectSlug: string;
  taskKey: string;
  /** The engaged profile to run; omitted → the delivering engagement. */
  profileId?: string;
  directive?: string;
  /** Display name of the human whose words `directive` quotes, when there is
   *  one (an @mention comment). The prompt tells the agent to tag them back —
   *  the tag is what notifies a person (NEW-4). */
  directiveFrom?: string;
  /** Force this run onto a specific backend regardless of the profile's
   *  default — "retry on the other backend" after an availability /
   *  quota failure (D4). */
  backendOverride?: RealBackend;
  /**
   * Dynamic-dispatch rework (2026-08-29): explicit delivering/supporting
   * posture for a profile that is NOT yet engaged (the auto-engage below).
   * Omitted → derived: an unengaged profile becomes the delivering engagement
   * iff the task has no deliverer AND the profile holds a repo-write grant;
   * otherwise it engages as a supporting agent. An already-engaged profile
   * keeps its shape unless `true` explicitly asks for a delivery hand-off.
   */
  delivers?: boolean;
  /**
   * Dispatch-completion contract (owner directive, 2026-08-29): the display
   * name of the human whose manual (or scheduled) dispatch started this run.
   * Presence arms the contract — the run's final report always tags this
   * human (notifying them) and @operator, and the completion always re-invokes
   * the operator so coordination continues. Mechanical in the completion
   * pipeline (R20-9's guarantee-over-guidance shape); the prompt clause below
   * is the guidance half.
   */
  triggeredByName?: string;
  /** The dispatcher's user id — the completion contract's cc-append verifies
   *  "already tagged?" against the mention resolution ladder with it. */
  triggeredByUserId?: string;
  /**
   * Ruling 313: run this reviewer with its VERDICT channel withheld, for the
   * one dispatch whose whole point is that it must not produce another verdict
   * — `question_reviewer` (ruling 237).
   *
   * The engagement is untouched: the reviewer stays verdict-capable and stays a
   * required reviewer, so acceptance still waits for its approve. Only THIS run
   * cannot file one.
   */
  withholdVerdict?: boolean;
  /**
   * Ruling 421 (F39-43): this run puts ruling 410's completeness question, so
   * the verdict it returns is the reviewer's complete blocking set. Stamped on
   * the engagement with this run's id once the run exists (`Engagement.question`)
   * and read back by the verdict writer, which records the verdict as the
   * answer. The deadlock packet then stops recommending the question it asked.
   */
  completeness?: boolean;
}

export async function startAgentRun(
  db: DatabaseSync,
  input: StartAgentRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<StartAgentRunResult> {
  const pending: PendingReservation = { reservation: null, skillPlugin: null };
  try {
    return await dispatchAgentRun(db, input, actor, ctx, pending);
  } catch (error) {
    pending.reservation?.abandon(errorMessage(error));
    // A plugin no run adopted has no reader (ruling 180).
    removeSkillPlugin(pending.skillPlugin);
    throw error;
  }
}

async function dispatchAgentRun(
  db: DatabaseSync,
  input: StartAgentRunInput,
  actor: TaskActor,
  ctx: TaskMutationContext,
  pending: PendingReservation,
): Promise<StartAgentRunResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "start an agent run",
  );

  let existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  // An ARCHIVED task refuses every other governed mutation — acceptance
  // (`archivedTaskBlockedReason`), transitions and drags
  // (`archivedTaskMoveBlockedReason`), a scheduled occurrence
  // (`schedule.server.ts`) and `removeReviewer` — but the dispatch checked
  // nothing, so an abandoned task could still start a real, billable run that
  // wrote to its workspace and its timeline. Worse, when that dispatch
  // auto-engaged a NEW seat the seat could not be released again:
  // `removeReviewer` refuses on archived and has no admin escape, so the only
  // way back was to restore the task. Note this is deliberately the ARCHIVED
  // gate only — ruling 133 licenses engaging an eligible profile at any STAGE,
  // terminal included, so a closed-but-not-archived task is untouched here.
  // Ruling 177 (pass 36): the gate is CLOSED (terminal stage or archived), one
  // spelling for every door — ruling 133's "an eligible profile at any stage,
  // terminal included" ended with the terminal stage.
  {
    const dispatchBoard = projectBoard(ctx, input.projectSlug);
    const closure = dispatchBoard
      ? taskClosure(existing.parsed.frontmatter, dispatchBoard.stages)
      : ({ closed: false } as const);
    if (closure.closed && dispatchBoard) {
      throw AppError.validation(
        closureRefusal(input.taskKey, closure, dispatchBoard.stages, "running an agent on it"),
      );
    }
  }

  // Ruling 186 (pass 37, F37-2): a task waiting on other work is HELD, and the
  // hold is a GATE here — beside closure, in the same chokepoint, for the same
  // reason. Ruling 131(d) refused three operator triggers and then asked the
  // model not to "dispatch delivery work"; asking is not a gate. Live, SHOP-2
  // was marked "Held until every entry is done; Viberr releases it then" and a
  // Codex run started 1.9 seconds later, designed and committed the whole
  // identity service, and pushed a branch cut from a base that predated the
  // foundation it waited on. Every dispatch door lands here, so every one of
  // them refuses: the operator's `run_agent`, the controller's `run_agent`, and
  // the task page's Run-an-agent control (which shows the same sentence before
  // the click, `holdRefusal` being shared and client-safe).
  {
    const held = existing.parsed.frontmatter.blockedBy;
    if (held.length > 0) {
      throw AppError.validation(
        holdRefusalFor(db, input.projectSlug, input.taskKey, held, "running an agent on it"),
      );
    }
  }

  let engagement = input.profileId
    ? (existing.parsed.frontmatter.engagements.find(
        (e) => e.profileId === input.profileId,
      ) ?? null)
    : deliveringEngagement(existing.parsed.frontmatter);

  // Dynamic-dispatch rework (2026-08-29): running an agent that is not yet
  // engaged ENGAGES it — the pre-assignment ceremony ("Engage it first") is
  // gone. The engagement row still exists (verdict snapshots, KB union,
  // workspace paths, single-flight and the required-reviewer gate all key off
  // it); it is simply created by the dispatch instead of by a separate human
  // step. Posture derives from the profile's own capability grants:
  //   - delivering iff the task has no deliverer AND the profile holds a
  //     repo-write grant (an explicit `delivers: true` hint — the operator's
  //     hand-off — reassigns delivery through the existing assignSpecialist
  //     machinery instead);
  //   - supporting otherwise (own isolated checkout; a verdict grant makes it
  //     a required reviewer, exactly as an explicit engage did).
  if (!engagement && input.profileId) {
    const view = listDeployedSpecialists(input.projectSlug, ctx).find(
      (s) => s.id === input.profileId,
    );
    if (!view) {
      throw AppError.validation(
        `"${input.profileId}" is not deployed on this project. Deploy it on the Agents page first.`,
      );
    }
    const currentDeliverer = deliveringEngagement(existing.parsed.frontmatter);
    const delivery = view.capabilities?.delivery === true;
    // Ruling 556: a reviewer the project requires is engaged to review when
    // nothing asks otherwise; only an explicit `delivers: true` reaches the
    // refusal in `assignSpecialist`.
    const requiredHere = readRequiredReviewers(input.projectSlug, ctx).some(
      (rule) => rule.profileId === input.profileId,
    );
    const wantsDelivery =
      input.delivers ?? (currentDeliverer === null && delivery && !requiredHere);
    if (wantsDelivery && !canOwnDelivery(view, input.delivers)) {
      // R21-2's posture: name the capability AND where a human grants it,
      // rather than starting a delivering run that can ship nothing.
      throw AppError.validation(cannotOwnDeliverySentence(view.name));
    }
    await (wantsDelivery ? assignSpecialist : assignReviewer)(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: input.profileId },
      actor,
      ctx,
    );
    existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
    engagement =
      existing.parsed.frontmatter.engagements.find(
        (e) => e.profileId === input.profileId,
      ) ?? null;
  } else if (
    engagement &&
    input.profileId &&
    input.delivers === true &&
    !engagement.delivers
  ) {
    // Explicit delivery hand-off to an agent currently engaged as supporting:
    // route through assignSpecialist (single-deliverer invariant, hand-off
    // event, live-primary-run refusal) and re-read.
    //
    // Dispatch-rework hunt (2026-08-29): the repo-write guard below used to
    // live only on the UNENGAGED branch above, so a verdict-only reviewer
    // already engaged as supporting could be handed delivery — recreating the
    // exact ships-nothing dead end ruling 98(a) closes. Same check, same
    // remedy-naming refusal, on BOTH doors to `delivers: true`.
    const handoffView = listDeployedSpecialists(input.projectSlug, ctx).find(
      (s) => s.id === input.profileId,
    );
    if (handoffView && !canOwnDelivery(handoffView, input.delivers)) {
      throw AppError.validation(cannotOwnDeliverySentence(handoffView.name));
    }
    await assignSpecialist(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: input.profileId,
      },
      actor,
      ctx,
    );
    existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
    engagement =
      existing.parsed.frontmatter.engagements.find(
        (e) => e.profileId === input.profileId,
      ) ?? null;
  }

  if (!engagement) {
    throw AppError.validation(
      input.profileId
        ? `"${input.profileId}" could not be engaged on this task.`
        : "Pick an agent to run. This task has no delivering agent yet.",
    );
  }
  const delivers = engagement.delivers;

  // Ruling 122: the branch name is ALLOCATED once, before the agent is told
  // what to check out. The operator's own dispatch already ran this hook
  // (FR31's delivery spine), but a human-dispatched delivering run reached the
  // prompt with no branch recorded, so it fell back to the canonical key — the
  // one name a reused task key can already have a stranger's pull request on.
  // Best-effort by the same reasoning as the operator's: a task that cannot
  // reach GitHub still runs, and delivery re-checks the name.
  if (delivers && !existing.parsed.frontmatter.branch) {
    await ensureTaskBranchBestEffort(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      auditActor,
      { dataRoot: ctx.dataRoot },
    );
    existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey)) ?? existing;
  }

  // Server-side single-flight for the DELIVERING agent (F7-OP1). Two racing
  // dispatches used to start two runs in the SAME tasks/<KEY>/workspace clone —
  // two agent processes fighting over one git index/branch, risking a double
  // push. One live delivering run per task: refuse a second until the first
  // finishes or is interrupted. Supporting agents run concurrently in their own
  // isolated checkouts (P8); their write posture is grants-derived on BOTH
  // backends (ruling 101: Claude's denylist binds it; on Codex it is advisory
  // since ruling 185, with the delivery gate as the boundary).
  if (delivers) {
    const liveDelivering = listRunsForTaskRows(
      db,
      input.projectSlug,
      input.taskKey,
    ).find(
      (r) =>
        r.kind === "primary" && (r.state === "running" || r.state === "queued"),
    );
    if (liveDelivering) {
      // Ruling 452: typed with the live run's agent, which is not always this
      // one — only a directive to the SAME agent is delivered on its finish.
      throw new AgentBusyError(
        "A delivering agent run is already in progress on this task. Wait for it to finish or interrupt it before starting another.",
        liveDelivering.agent_profile_id,
      );
    }
  } else {
    // P8/Finding-2 (pass 25): a SUPPORTING run now has its OWN isolated checkout
    // (`workspace/support/<profileId>/<repo>`) that `cloneRepo` deletes and
    // re-clones FRESH on every dispatch. Two overlapping runs of the SAME
    // supporting engagement would share that one dir, so the second's re-clone
    // would yank the first's working tree out mid-run. Serialize same-engagement
    // runs (an @mention or operator re-summon while it is already running refuses
    // until the first finishes); DIFFERENT supporting engagements still run
    // concurrently — their profileIds map to separate dirs. Before P8 the shared
    // canonical checkout's reuse path was non-destructive, so this could not bite.
    const liveSameEngagement = listRunsForTaskRows(
      db,
      input.projectSlug,
      input.taskKey,
    ).find(
      (r) =>
        r.agent_profile_id === engagement.profileId &&
        (r.state === "running" || r.state === "queued"),
    );
    if (liveSameEngagement) {
      throw new AgentBusyError(
        "This agent already has a run in progress on this task. Wait for it to finish or interrupt it before starting another.",
        engagement.profileId,
      );
    }
  }

  // Resolve the CURRENT deployment before picking the backend: absent a pin, the
  // run follows the live profile, not the engage-time snapshot in task.md, so
  // editing a profile's backend takes effect on the very next run (manual,
  // operator prompt or @mention) instead of pinning the task by accident.
  let resolved: ResolvedSpecialist | null = null;
  try {
    resolved = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      engagement.profileId,
    );
  } catch {
    // Profile may have been undeployed since engagement — snapshot fallback.
  }
  // Backend priority: an explicit D4 retry override for THIS run wins; then a
  // STUCK retry pin (F27-B1, owner ruling 2026-08-24 — a prior retry-on-other-
  // backend switch that later prompts must keep following, OVER the live profile);
  // then the live deployment; then the snapshot (undeployed profile). The pin is
  // set only by a deliberate retry below, so a plain profile edit still wins here.
  const backend: RealBackend =
    input.backendOverride ??
    engagement.pinnedBackend ??
    resolved?.backend ??
    (engagement.backend === "codex" ? "codex" : "claude");
  // Resolve the model + effort from the deployment (falls back to a sane
  // default). Effort is threaded into the run so the SDK gets the profile's
  // chosen reasoning level (claude options.effort · codex modelReasoningEffort).
  let model = defaultModelFor(backend);
  let effort = "";
  // The agent's display name for the Agent-logs picker (grouped one-per-agent).
  // Falls back to the profile id when the deployment can't be resolved.
  let agentName = engagement.profileId;
  let skills: string[] = [];
  let kb: string[] = [];
  let mcpNames: string[] = [];
  // Run-time tool confinement from the deployment's capability grants (an
  // agent without push/PR/merge rights literally cannot run those commands).
  //
  // P14-RT-01: the UNDEPLOYED baseline is the fully-withheld set, not `[]`. An
  // empty denylist also left `repoWriteWithheldFromDenylist` false, so a Codex
  // run of a profile nobody can resolve got `danger-full-access` — undeploying a
  // profile ESCALATED its next FRESH run, while `resolveResumeConfinement` locked
  // the same vanished profile down. Both paths now take one posture: a run whose
  // grants cannot be confirmed may read and validate, never deliver.
  let disallowedTools: string[] = resolveUndeployedDisallowedTools();
  if (resolved) {
    agentName = resolved.name;
    skills = resolved.skills;
    kb = resolved.kb;
    mcpNames = resolved.mcps;
    disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
    // The profile's model/effort are specific to ITS native backend. When this
    // run overrides to a DIFFERENT backend (D4 retry-on-other-backend, or a
    // F27-B1 pin), the native model id is invalid there. F36-8 (pass 36): the
    // ORIGINAL id is handed through to `startRun` all the same — run-service's
    // F21-13 branch substitutes the backend default AND discloses it (the run
    // log opens with the notice). This branch used to pre-swap the default in,
    // so run-service saw a valid model and nothing anywhere said `sonnet` had
    // replaced `gpt-5.6-luna`. Effort still translates here (`resolveRunEffort`
    // maps by rank across the two tier scales; no disclosure needed).
    model = resolved.model;
    effort =
      backend === resolved.backend
        ? resolved.effort
        : resolveRunEffort(backend, resolved.effort);
  }
  // What the run will EXECUTE (F36-8): the same answer run-service records on
  // the row, read here so the reserved row and the timeline event name it.
  const modelSubstitution = substituteRunModel(backend, model);
  const ranModel = modelSubstitution.model;
  // Stage eligibility holds at the RUN boundary too (F1): an already-engaged
  // agent must not be re-run after the task moved to a stage it isn't eligible
  // for. Outside the try so the undeployed-profile fallback can't swallow it.
  // An undeployed profile declares no stages to check against — the withheld
  // confinement above is what bounds that run instead (P14-RT-01).
  // Ruling 133 (pass 34): the RUN boundary admits the engaged deliverer at
  // every stage and keeps a supporting engagement stage-scoped; the admitted
  // reason is recorded on the audit row.
  let stageEligibility: "declared" | "engaged-deliverer" | "undeployed" = "undeployed";
  if (resolved) {
    const eligibility = runEligibilityFor(
      resolved,
      existing.parsed.frontmatter.engagements,
      engagement.profileId,
      existing.parsed.frontmatter.stage,
      projectBoard(ctx, input.projectSlug),
    );
    if (!eligibility.ok) throw AppError.validation(eligibility.refusal);
    stageEligibility = eligibility.why;
  }

  // R18-1: a REVIEWER must judge the work against the SAME knowledge-base
  // conventions the DELIVERER used. Grants are per-profile, so a reviewer with
  // `kb: []` (or a different KB set) reviewed against different conventions and
  // produced false `request_changes` verdicts (live-caught: a reviewer flagged
  // a KB-required footer as unsubstantiated because it lacked the KB). Union the
  // delivering engagement's live KB grants into this reviewer run's kb list —
  // reviewer's own KBs first, the deliverer's extras appended, deduped so a KB
  // both grant injects (and charges the shared budget) once. Only for a
  // non-delivering run: the deliverer's own run already carries these, and the
  // operator runs a separate path (buildOperatorSystemPrompt). Tolerant of an
  // undeployed deliverer (resolve throws → skip), like the reviewer's own
  // resolve above.
  if (!delivers) {
    kb = withDeliveringGrants(kb, () =>
      deliveringContextGrants(
        existing.parsed.frontmatter,
        engagement.profileId,
        (profileId) =>
          resolveDeployedSpecialist(ctx, input.projectSlug, profileId).kb,
      ),
    );
  }
  // Ruling 239: the project's rulings KB reaches EVERY agent on the project,
  // after the profile's own grants and R18-1's inherited ones so it never
  // displaces them in the shared injection budget. Placed here rather than in
  // the per-profile grant so nobody can forget it on the one profile that
  // needed it — which is exactly how a conventions KB written "For reviewers"
  // came to be re-derived from first principles, four rework rounds at a time.
  kb = withProjectRulings(kb, input.projectSlug, ctx);

  // Ruling 127: WHOSE account this run bills, resolved BEFORE anything is
  // spent. A task with no owner, an owner whose account is gone, or an owner
  // who has not connected this backend all end the same way — an honest error
  // run through the normal completion pipeline, with no clone, no reservation
  // and no process. Resolving here (rather than letting `startRun` discover it)
  // is what keeps a multi-minute clone from being paid for a run that was
  // never going to start.
  const principal = resolveTaskRunPrincipal(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    backend,
  );
  // G35-4 / ruling 152(c) (pass 35): the ONE read before anything is spent.
  // A backend the instance already knows is out of quota for the account this
  // run bills gets no run row, no clone and no operator turn: the dispatch is
  // held, said on the timeline, audited, and re-scheduled for the reopen
  // instant. Live, nine deliveries were dispatched one after another into a
  // window the health body was already showing as spent, each paying a clone,
  // a refused run, an operator turn and a "Work stalled" packet. The retry
  // doors (`retry_other_backend`, the scheduled fire) pass through here
  // against their OWN target backend, so a Claude retry proceeds while Codex
  // is held. After the eligibility gates above: an ineligible dispatch is
  // refused with its own sentence, never parked.
  if (principal.ok) {
    await assertDispatchNotHeld(db, ctx, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      backend,
      credentialUserId: principal.principal.userId,
      profileId: engagement.profileId,
      agentName,
      deployed: resolved !== null,
      directive: input.directive ?? null,
      actor: auditActor,
    });
  }
  // The clone gate, and every other "will a provider process actually consume
  // this?" gate below. A refused run still becomes a RUN ROW — `startRun`
  // records the refusal as an honest terminal error and the normal completion
  // pipeline opens the blocked packet — it just never pays for a checkout, a
  // skill mount, a browser or a toolkit for a process that will not exist.
  // Same shape the pre-127 "backend unavailable" path had (R7-2).
  const realBackend = principal.ok;

  // P14-LV-09: resolve the MCP grants BEFORE the persona, and build it from what
  // actually mounted — passing the DECLARED names is the literal symptom (the
  // prompt announced a server the run had no tools for). The persona itself is
  // built AFTER the clone below, because the same rule now applies to skills:
  // which ones mount natively is only knowable once the workspace exists.
  //
  // Ruling 127: and AFTER the principal, because this resolve is not a read.
  // `mcpServersFor` pre-flights every declared stdio server by SPAWNING it to
  // handshake it (F20-10) and corrects its registry row from what happened —
  // vendor/org child processes and org-level writes for a run the next line is
  // about to refuse. A refused run mounts nothing, so it resolves nothing.
  //
  // Ruling 176: the same denylist that withholds the file tools decides
  // whether the admin's marked MCP write tools go too — one predicate.
  const resolvedMcps: RunMcpMounts = realBackend
    ? await mcpServersFor(db, mcpNames, repoWriteWithheldFromDenylist(disallowedTools))
    : { unresolved: [], unhealthy: [], toolDenials: [], proxied: [], oauthGrants: [] };
  // Ruling 585: a Codex run that holds a knowledge base reads and corrects it
  // through the gateway's knowledge server, and its prompt says so.
  const knowledgeMount = realBackend
    ? resolveKnowledgeMcp({
        backend,
        kb,
        dataRoot: ctx.dataRoot,
        agent: { profileId: engagement.profileId, roleHint: engagement.role },
      })
    : null;

  // Collaboration gates (G3/G4) from the deployment's grants — the SAME
  // resolution the completion pipeline re-derives (agent-outcome.server.ts).
  //
  // R15-7 (owner ruling, 2026-07-28): a run whose profile CANNOT be resolved is
  // fully conservative, matching the withheld tool posture two blocks up. It
  // used to pass `[]`, which the catalog defaults read as comment/ask/evidence
  // GRANTED — so a ghost profile kept a mid-run comment channel, could open a
  // question packet in a vanished profile's name, and could assert evidence,
  // while everything the tool layer governs was denied. `withheldAgentGrants()`
  // states the withholding explicitly rather than relying on an absent grant.
  const granted = resolveAgentCollab(
    resolved ? resolved.capabilities : withheldAgentGrants(),
  );
  /**
   * Ruling 313. `question_reviewer` (ruling 237) re-runs a deadlocked reviewer
   * "exactly as it stands" and asks it, in the directive, to answer in a comment
   * and NOT return a verdict — because "a verdict here would bind to the same
   * revision and count as another objection, which is the loop"
   * (`review-deadlock.server.ts`). Nothing enforced it. The verdict field is
   * gated on the PROFILE's grant, so the tool stayed mounted and the sentence
   * was the only thing in its way.
   *
   * Live on SHOP-76 the reviewer returned a verdict on exactly that run
   * (04:34:35Z), it counted, and the packet re-raised at the SAME round count —
   * so the person answered the identical question twice and the option they
   * were shown as recommended fed the loop it was offered to end.
   *
   * `review-deadlock.server.ts`'s own header names this construction as the one
   * ruling 186 refused: "a request in a prompt, with nothing that notices when
   * the model does something else". One variable feeds both backends here — the
   * Claude toolkit's `report_outcome` field, the Codex envelope's schema, and
   * the persona's collaboration notes — so withholding it once withholds it
   * everywhere, and the prompt stops promising what the tools contradict.
   *
   * Ruling 555: nor is the deliverer offered it. The deliverer mints and
   * everyone else judges (ruling 388), so a verdict from the run that makes the
   * delivery is a verdict on its own work, which `requiredReviewers` has never
   * counted. On AWSC-3 the Estimate Judge delivered and approved in one reply,
   * and completion filed its files as the evidence for that verdict, so they
   * were never recorded as the delivery.
   */
  const collab = input.withholdVerdict || delivers ? { ...granted, verdict: false } : granted;
  // Ruling 589: a Codex run that holds a collaboration grant reads the board
  // and its own timeline through the gateway's board server, as a Claude run's
  // toolkit does.
  const boardMount = realBackend
    ? resolveBoardMcp({ backend, collaborates: holdsCollaborationGrant(collab), dataRoot: ctx.dataRoot })
    : null;
  // The agent's own actor ref (D7/D8) — toolkit writes are attributed to it.
  const agentActorRef: FileActorRef = {
    kind: "agent",
    backend,
    profileId: engagement.profileId,
    roleHint: engagement.role,
  };
  // Staging key linking a Claude report_outcome tool call to THIS dispatch's
  // completion (the runId doesn't exist until startRun returns).
  const outcomeKey = newId("oc");

  const title = existing.parsed.frontmatter.title;
  const goal = existing.parsed.goal;
  // P13-D-5: one project, one repository.
  const repo = projectRepo(ctx, input.projectSlug);

  // Thread prefix: the delivering agent streams on `primary-…`; each
  // supporting agent groups on its `r<index>-…` prefix (the agents deployment
  // projection groups on it). Unique suffix so re-runs never collide on
  // agent_runs' unique(project, task, thread). Computed HERE, before the
  // workspace work, because the reservation below claims the row with it.
  const supportingIndex = delivers
    ? -1
    : supportingEngagements(existing.parsed.frontmatter).findIndex(
        (r) => r.profileId === engagement.profileId,
      );
  const threadId =
    (delivers ? "primary-" : `r${supportingIndex}-`) +
    newId("t").replace("t_", "").slice(0, 8);

  // R21-4 / OBS-8: claim the run row NOW, before the clone. A cold task-repo
  // clone ran 3+ minutes live on a 113 MB repository, and for that whole window
  // the task page showed an empty timeline, no live-run strip and no hint that
  // anything was happening — the product looked dead while it was working. The
  // reserved row renders the strip with a real phase; `startRun` adopts it (id,
  // thread and started_at) instead of minting a second row, and the catch in
  // `startAgentRun` abandons it if preparation throws.
  // D1 (pass 23, owner ruling Q3): only the FIRST task in a project pays the
  // full cold clone (~minutes on a large repo) — later tasks fetch from the local
  // mirror in seconds. The strip showed a static "Cloning …" for the whole
  // download and "looked stalled for minutes" on the first-run experience; say
  // when the wait is the one-time mirror build so it reads as expected setup.
  // Ruling 127: a REFUSED run has nothing to prepare, so it reserves nothing.
  // The reservation exists to render a live "Preparing workspace" strip during
  // a clone; showing one for a run that is about to be recorded as an error
  // would be theatre, and it would hold a concurrency slot for it.
  pending.reservation = principal.ok
    ? reserveRun(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        threadId,
        role: engagement.role,
        kind: delivers ? "primary" : "reviewer",
        backend,
        credentialUserId: principal.principal.userId,
        // The strip's header names what will RUN, never a foreign id (F36-8).
        model: ranModel,
        agentName,
        agentProfileId: engagement.profileId,
        phase: RUN_PHASE.preparing,
        step: repo
          ? cloneStepLabel(repo, mirrorIsCold(input.projectSlug, repo, ctx.dataRoot))
          : "Setting up the run workspace",
      })
    : null;

  // P8 (pass 25): a SUPPORTING (non-delivering) engagement runs in its OWN
  // isolated checkout so its writes never reach the delivering tree (which
  // delivery's `git add -A` ships). Only the delivering engagement uses the
  // canonical `workspace/<repo>` the delivery / evidence / operator paths read.
  const support = delivers ? undefined : { profileId: engagement.profileId };
  const clone =
    repo && realBackend
      ? await cloneRepo(db, {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo,
          dataRoot: ctx.dataRoot,
          identity: agentGitIdentity(engagement.profileId),
          // `support` is undefined for the delivering engagement (→ canonical
          // checkout) and set for a supporting one (→ isolated checkout).
          support,
          // Ruling 179: a supporting checkout judges the revision under review;
          // the delivering one follows origin's copy of the task branch.
          // Ruling 238: with ONE exception, computed from facts already on the
          // task — a head that moved only because Viberr refreshed the base
          // carries the same deliverable on a newer base, and pinning behind it
          // is what left SHOP-18's verifier re-reading a defect that had been
          // fixed and merged.
          pinSubject: support
            ? reviewSubjectSha({
                reviewedSha:
                  activeWorkRevision(existing.parsed.frontmatter.workRevision)?.headSha ?? null,
                prHeadSha: existing.parsed.frontmatter.pr?.headSha ?? null,
                drift: existing.parsed.frontmatter.pr?.revisionDrift ?? null,
                // Ruling 439: a refresh made before any PR exists re-pins too.
                refreshes: existing.parsed.frontmatter.baseRefreshes,
              })
            : null,
          taskBranch: existing.parsed.frontmatter.branch ?? null,
          // F27-U1: turn the cold first-task network clone from a silent
          // multi-minute wait into a live percentage on the run strip.
          onCloneProgress: (fraction) =>
            pending.reservation?.phase(
              RUN_PHASE.preparing,
              cloneProgressStep(repo, fraction),
            ),
        })
      : null;
  // The run's cwd is ALWAYS an isolated workspace dir for a real backend —
  // NEVER the task dir. Confine git with GIT_CEILING (workspaceRunEnv). A
  // supporting run with no checkout falls back to its OWN scoped root, never the
  // shared `workspace/`, so even a checkout-less run stays isolated.
  const workspaceRoot = taskWorkspaceRoot(
    input.projectSlug,
    input.taskKey,
    ctx.dataRoot,
  );
  const supportRoot = support
    ? path.join(workspaceRoot, "support", support.profileId)
    : workspaceRoot;
  const cloneFailure = clone?.failure ?? null;
  const runWorkdir = clone?.dir ?? (realBackend ? supportRoot : null);
  if (runWorkdir && !existsSync(runWorkdir)) {
    // Ruling 460: the agent runs as its person's own user and writes here.
    shareDirWithAgents(workspaceRoot);
    mkdirSync(runWorkdir, { recursive: true });
  }
  // C4-opres: the clone above is the MINUTES-long window in which the human can
  // (and does) press Stop on the strip this reservation put on the page. That
  // interrupt is the run's outcome — so stop here, before mounting skills,
  // resolving MCP servers and building a persona for a run nobody wants. The
  // wrapper's catch releases the reservation, and `abandon` will not demote the
  // recorded `interrupted`. `startRun` re-checks immediately before adopting.
  if (pending.reservation) {
    assertRunReservationLive(db, pending.reservation.runId);
  }
  // The checkout is done; the rest of preparation (skill mount, KB/persona
  // assembly, MCP pre-flight) is seconds, not minutes — but it is still time the
  // strip would otherwise spend showing the clone that already finished.
  pending.reservation?.phase(
    RUN_PHASE.preparing,
    "Mounting the agent's granted resources",
  );

  // Mount the granted skills as this run's plugin BESIDE the checkout (ruling
  // 180) so the Claude SDK discovers them natively (progressive disclosure:
  // metadata now, full body only when the agent invokes one) while the tree
  // the project's own tools scan stays exactly a clean clone (F36-9). AFTER
  // the clone — the mount re-strips the repo's own `.claude` first. Claude
  // only: Codex has no native skills channel (LV-13 severs it deliberately),
  // so a Codex run's grants stay prompt text. One plugin per RUN: a second
  // run on this shared workspace cannot unmount a live run's skills.
  let skillMount: SkillMount = { mounted: [], skipped: [], plugin: null };
  if (backend === "claude" && realBackend) {
    const mountInput: SkillMountInput = {
      workspaceDir: clone?.dir ?? null,
      skills,
      // The reserved row's id names the plugin directory; a run without a
      // reservation (cap full, or about to be refused) gets a fresh id.
      runId: pending.reservation?.runId ?? newId("run"),
    };
    // Omitted on the default store — the mount resolves its own root then.
    if (ctx.dataRoot) mountInput.dataRoot = ctx.dataRoot;
    mountInput.git = personGitOrNull(db, input.projectSlug, input.taskKey, ctx.dataRoot);
    skillMount = await mountGrantedSkills(mountInput);
    pending.skillPlugin = skillMount.plugin;
  }

  // R19-19: the browser mount resolves from the SAME grants the collaboration
  // gates use — an unresolvable profile is withheld here for the same reason
  // (R15-7: we can confirm nothing about it). Only for a real backend: the
  // config would otherwise describe a child no engine will ever spawn.
  const attachmentsDir = taskAttachmentsDir(
    input.projectSlug,
    input.taskKey,
    ctx.dataRoot,
  );
  const browser = realBackend
    ? resolveBrowserMcp({
        grants: resolved ? resolved.capabilities : withheldAgentGrants(),
        attachmentsDir,
        backend,
      })
    : { server: null, refused: null };
  // Evidence-granted runs get the attachments drop (owner ask 2026-08-20):
  // the dir must exist BEFORE the run so a plain `cp` into it cannot fail on
  // a missing path (the browser mount creates it too — idempotent).
  if (collab.evidence && realBackend) {
    // Ruling 460: shared with the agent group, which writes the drop.
    shareDirWithAgents(attachmentsDir);
  }

  // The agent's run persona: its detailed definition + granted skills + KB docs.
  // Claude takes it as a system prompt; Codex receives the same persona through
  // the supported `developer_instructions` configuration channel. Skills that
  // MOUNTED are announced but not injected; the rest still ride the prompt.
  // P19-G11: skill/KB grants whose CONTENT never reached the run, collected as
  // the persona reads the bodies (see `unresolvedOut`) so the run's input
  // disclosure can name them to a HUMAN, not only to the agent.
  const unresolvedResources: { name: string; reason: string }[] = [];
  const personaInput: SpecialistPersonaInput = {
    profileId: engagement.profileId,
    rulingsKb: projectRulingsKb(input.projectSlug, ctx),
    backend,
    skills,
    nativeSkills: skillMount.mounted,
    kb,
    knowledgeTool: backend !== "codex" || knowledgeMount !== null,
    mcps: [
      ...Object.keys(resolvedMcps.mcpServers ?? {}),
      ...(browser.server ? [BROWSER_MCP_NAME] : []),
    ],
    unresolvedMcps: resolvedMcps.unresolved,
    unhealthyMcps: resolvedMcps.unhealthy,
    mcpWriteToolsDenied: resolvedMcps.toolDenials,
    mcpProxied: resolvedMcps.proxied,
    mcpOAuthGrants: resolvedMcps.oauthGrants,
    // Ruling 159: the agent is handed the ABSOLUTE directory (inside the
    // container `/data/...` is real; on bare metal it is the data root's own
    // absolute path). The store-relative form is a display form for humans.
    browser: browser.server
      ? { attachmentsDir }
      : browser.refused
        ? { refusedReason: browser.refused.reason }
        : null,
    attachmentsDrop:
      collab.evidence && realBackend ? { attachmentsDir } : null,
    // F4: the persona section rides the same predicate the tool mount does.
    githubRead: githubReadForRun({
      githubRead: collab.githubRead,
      backend,
      realBackend,
      repo,
    }),
    dataRoot: ctx.dataRoot,
    unresolvedOut: unresolvedResources,
  };
  // A profile with no body of its own leaves the key ABSENT — the builder falls
  // back to the generic prompt, which an empty definition would not do.
  if (resolved?.definition) personaInput.definition = resolved.definition;
  // Ruling 370: the split the adapters render by backend; `persona` is the
  // same text as one document, for the disclosure's character count.
  const personaPrefix = buildSpecialistPromptPrefix(personaInput);
  const persona = joinedPrompt(personaPrefix);
  // Ruling 371: what the run is handed back after a compaction.
  const compactAnchor = specialistCompactAnchor({
    taskKey: input.taskKey,
    title,
    taskMdPath: resolveTaskFilePath(taskRef(ctx, input.projectSlug, input.taskKey)),
    branch: existing.parsed.frontmatter.branch ?? null,
    pr: prAnchor(existing.parsed.frontmatter.pr?.number ?? null, repo),
    kb: sortedNames(kb),
    rulingsKb: projectRulingsKb(input.projectSlug, ctx),
  });
  // The refused pair joins the run-input disclosure (P19-G11) — a granted
  // browser that silently reached no run would be the silent-resource class.
  if (browser.refused) unresolvedResources.push(browser.refused);

  // No resolvable deployment ⇒ no grants ⇒ no delivery steps in the prompt.
  // Under the P14-LV-01 polarity an empty grant list is already fully withheld,
  // so this matches the denylist above rather than contradicting it (XS-4).
  const delivery = resolveDeliveryPermissions(resolved?.capabilities ?? []);
  // The run env: git confinement only. Delivery is SERVER-SIDE for BOTH
  // backends (F-GH3): the agent commits locally but NEVER pushes — viberr
  // pushes the workspace branch + opens the PR when the OPERATOR decides to
  // deliver (ruling 207(f): R15-2 deleted the Review-transition hook).
  const baseRunEnv = {
    ...workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot),
    // F24: unify the delivery commit author across codex/claude.
    ...agentGitIdentityEnv(engagement.profileId),
  };
  // F15-15: a reviewing run judges the DELIVERED revision (the PR head), not
  // whatever the local workspace branch holds — pin it into the prompt.
  // Ruling 161: a discarded revision is no subject to review.
  const activeRevision = activeWorkRevision(existing.parsed.frontmatter.workRevision);
  const reviewSubject =
    !delivers && activeRevision
      ? {
          headSha: activeRevision.headSha,
          prNumber: existing.parsed.frontmatter.pr?.number ?? null,
        }
      : null;
  // Ruling 594: the same condition that mounts the board readers.
  const boardReader =
    realBackend && holdsCollaborationGrant(collab) && (backend === "claude" || !!boardMount);
  // P19-G0: EVERY fresh run re-anchors on the canonical task artifact. This is
  // the one thing `buildAnalyzePrompt` never carried — see `freshRunAnchor`.
  const anchor = await freshRunAnchor(ctx, input.projectSlug, existing.parsed, boardReader);
  // Every optional field below is OMITTED rather than set to undefined: the
  // prompt builder renders a section per key it was actually given.
  const promptInput: AnalyzePromptInput = {
    role: engagement.role,
    taskKey: input.taskKey,
    title,
    goal,
    repo,
    branch: existing.parsed.frontmatter.branch ?? taskBranchName(input.taskKey),
    cloned: !!clone?.dir,
    delivery,
    delivers,
  };
  if (clone?.refreshed) promptInput.workspaceRefresh = clone.refreshed;
  if (anchor) promptInput.anchor = anchor;
  // Ruling 422: the folders the persona's knowledge-base index points at, so
  // the workspace contract permits the reads the index asks for.
  const kbReadDirs = knowledgeBaseReadDirs(
    [...kb, projectRulingsKb(input.projectSlug, ctx)],
    ctx.dataRoot,
  );
  if (kbReadDirs.length > 0) promptInput.kbReadDirs = kbReadDirs;
  if (boardReader) promptInput.taskFileReader = true;
  // Ruling 591: the same condition as the correction note below.
  if (realBackend && kb.length > 0 && (backend === "claude" || knowledgeMount)) {
    promptInput.kbCorrectionTool = true;
  }
  if (collab.evidence && realBackend) {
    promptInput.attachmentsDropDir = attachmentsDir;
  } else if (realBackend) {
    // Ruling 592: a run that cannot post still reads what the task holds.
    promptInput.attachmentsReadDir = attachmentsDir;
  }
  if (cloneFailure) {
    const promptFailure: PromptCloneFailure = {
      sentence: cloneFailure.sentence,
      credential: cloneFailure.credential,
    };
    if (cloneFailure.reason === "workspace_fault") promptFailure.workspaceFault = true;
    // F19-6: the agent is told to quote the reason verbatim, so this is the line
    // that carries git's real complaint into its report — and from there into
    // the operator's blocked packet.
    if (cloneFailure.stderrExcerpt) {
      promptFailure.stderrExcerpt = cloneFailure.stderrExcerpt;
    }
    promptInput.cloneFailure = promptFailure;
  }
  if (reviewSubject) promptInput.reviewSubject = reviewSubject;
  if (input.directive) promptInput.directive = input.directive;
  // Ruling 207(e): both of these end up inside a "tag @X so they are notified"
  // instruction, and the mention ladder matches an email's LOCAL PART, a full
  // name or a first name — never a whole address. A schedule carries
  // `createdByLabel`, which is whatever `actor.label` was when it was created,
  // and `TaskActor.label` is documented as "e.g. the email"; the task page was
  // fixed to pass a display name (R21-9) but the controller's schedule door and
  // the quota-hold auto-reschedule were not. The agent then dutifully tags
  // `@a.kaya@hepapi.com`, which chips nothing, notifies nobody, and leaves no
  // trace that the dispatcher was never told their run finished. `userName` is
  // the resolver that exists for exactly this (its own doc says an email tag
  // "chips nothing and notifies nobody"), so the id decides whenever there is
  // one, and the label stays the fallback for a dispatcher with no user row.
  const taggableName = (id: string | undefined, label: string): string => {
    if (!id) return label;
    const name = userDisplayName(db, id);
    return name && name !== id ? name : label;
  };
  if (input.directiveFrom) {
    promptInput.directiveFrom = taggableName(input.triggeredByUserId, input.directiveFrom);
  }
  if (input.triggeredByName) {
    promptInput.triggeredByName = taggableName(
      input.triggeredByUserId,
      input.triggeredByName,
    );
  }
  // Ruling 275: the persona this run will actually carry, so the shell
  // inventory can contradict it by name where the two disagree.
  if (persona.trim()) promptInput.persona = persona;
  const basePrompt = buildAnalyzePrompt(promptInput);
  // The human needs the real reason too, and needs it BEFORE the agent's own
  // account of the run. Without this the only trace on the task page is the
  // agent saying it lacked credentials — which reads as a settings problem on a
  // project whose credential is probe-verified, and sends someone to re-issue a
  // PAT that was never at fault. Same rule as F15-15: a mechanical failure must
  // never reach a human wearing a credential's clothes.
  if (cloneFailure) {
    await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
      text:
        `**Workspace checkout failed:** ${cloneFailure.sentence} ` +
        `The agent is running against an EMPTY workspace, so it cannot read or change ${repo}. ` +
        (cloneFailure.reason === "clone_terminated"
          ? "Raise `VIBERR_GIT_CLONE_TIMEOUT_MS` if this repository simply needs longer, then re-run."
          : "Re-run once the cause above is addressed.") +
        // F19-6: the classification alone ("git exit 128") sent humans
        // hunting; git's own redacted words are what makes this actionable.
        (cloneFailure.stderrExcerpt
          ? `\n\nWhat the checkout reported:\n\n\`\`\`\n${cloneFailure.stderrExcerpt}\n\`\`\``
          : ""),
    });
  }

  // Collaboration guidance (G3/G4): tell the agent about its channel so the
  // capabilities are actually exercised, per-transport.
  const collabNotes: string[] = [];
  if (backend === "claude" && realBackend) {
    if (collab.comment) {
      collabNotes.push(
        "- `post_comment`: post a material mid-run progress note or finding to the task timeline.",
      );
    }
    if (collab.ask) {
      collabNotes.push(
        "- `ask_human`: raise a question you are blocked on as a decision card for the humans. The answer does not arrive during this run; note it in your report and finish. You will be RESUMED in this same session with the decision, so do not restart your work when that happens.",
      );
    }
    if (collab.verdict) {
      collabNotes.push(
        "- `report_outcome` (REQUIRED at the end of your review): report `approve` or `request_changes` with a one-paragraph justification" +
          (collab.evidence
            ? ", plus `evidence`: short REFERENCES to what you checked (a suite, a file and line, a check), each with how it came out and marked pass, fail or info, never raw output"
            : "") +
          ", then finish with your full findings.\n" +
          // Ruling 210 (owner): the round count is the expensive thing, and the
          // doctrine only ever addressed a reviewer whose objection SURVIVES a
          // rework. A reviewer that returns a NEW valid objection every round
          // costs exactly as much and was asked for nothing: live, SHOP-6 took
          // seven rounds and SHOP-10 five, each one correct, each one finding
          // something the previous round had not looked for.
          "  A `request_changes` is a COMPLETE list, not the first thing you found. Before you " +
          "report it, sweep your whole owned surface for this revision and name EVERY change you " +
          "would block on, including the ones you have not verified in detail, marked as such. " +
          "Then say so in one sentence: that this is the complete set for this revision, and that " +
          "a fix addressing all of it should pass your next review. If something genuinely new " +
          "appears in a later revision (the rework introduced it, or it was unreachable until an " +
          "earlier blocker was cleared), say THAT explicitly and why it could not have been named " +
          "before. Finding one defect, sending the work back, and finding the next one next round " +
          "is not review; it is a queue, and it is paid for a round at a time.",
      );
    } else if (collab.evidence) {
      // U11 (the Claude half of B-AG3): an evidence-only profile now MOUNTS
      // `report_outcome`, so the prompt has to name the channel — an unannounced
      // tool is the same silent-resource class as an unmounted grant.
      collabNotes.push(
        "- `report_outcome`: at the end of your work, report `evidence`: short REFERENCES to what you checked or produced (a suite, a file and line, a check), each with how it came out and marked pass, fail or info, never raw output, with a one-paragraph summary. You do NOT judge the work; there is no verdict on this tool for you.",
      );
    }
    // Ruling 488 (F40-67): the relay rides whichever `report_outcome` mounted.
    if (collab.verdict || collab.evidence) collabNotes.push(RELAY_NOTE_CLAUDE);
  } else if (
    backend === "codex" &&
    realBackend &&
    // B-AG3: the note must cover EVERY grant that mounts the envelope schema
    // (see `useEnvelopeSchema` below), evidence included. An evidence-only Codex
    // profile had its final reply constrained to the JSON envelope with nothing
    // in the prompt explaining the shape — the schema descriptions were the only
    // hint, which is exactly how a prose report degrades into a stub.
    (collab.verdict || collab.ask || collab.evidence)
  ) {
    collabNotes.push(
      '- Your FINAL message must be the structured outcome JSON: {"summary": "<your full report, markdown>"' +
        (collab.verdict ? ', "verdict": "approve" | "request_changes" (required when you judged the work)' : "") +
        (collab.ask ? ', "question": {"title", "body", "options"} (only when blocked on a human decision)' : "") +
        (collab.evidence
          ? ', "evidence": [{"label", "result", "status"}] (short REFERENCES to what you checked: a suite, a file and line, a check; each with how it came out and pass, fail or info; never raw output)'
          : "") +
        // Ruling 488: every envelope carries the relay field.
        ', "relay": [{"taskKey", "text"}] (only when you must post something on another task)' +
        "}.",
    );
    collabNotes.push(RELAY_NOTE_CODEX);
    if (collab.ask) {
      // F20-32: on Codex the ask-human capability IS this `question` field —
      // there is no callable `ask_human` tool on this backend (the in-process
      // toolkit is Claude-only). Live, a Codex developer whose GOAL told it to
      // "ask the human, via your ask-human capability" went hunting for a tool,
      // found none, and narrated "the ask-human capability is unavailable in
      // this session, so I cannot obtain the required confirmation" — WHILE
      // populating `question` to ask exactly that. Name the channel so the agent
      // stops reporting a limitation that isn't real.
      collabNotes.push(
        '- Your ask-human capability on THIS backend is that `question` field: filling it in is how you raise a question for the humans; there is no separate ask_human tool here, so never say ask-human is unavailable. Set `question` when a human decision blocks you; the answer arrives on a later resumed run, not during this one, so note it and finish.',
      );
    }
  }
  // Ruling 590: a reviewer that has judged this task before is told its new
  // verdict replaces the old one for every reader, on either backend.
  if (
    realBackend &&
    collab.verdict &&
    existing.parsed.frontmatter.verdicts.some((v) => v.profileId === engagement.profileId)
  ) {
    collabNotes.push(REREVIEW_RESTATES_NOTE);
  }
  // Ruling 483 (F40-53): a knowledge-base line this run proves wrong has a
  // channel now, and the run is told which. Claude files it with the tool the
  // KB grant mounts, and Codex with the same tool on the gateway's knowledge
  // server (ruling 585); a Codex run without that server reports it, and the
  // operator relays it (its agent-reply turn says so).
  if (realBackend && kb.length > 0) {
    collabNotes.push(
      backend === "claude" || knowledgeMount
        ? KB_CORRECTION_NOTE_CLAUDE
        : KB_CORRECTION_NOTE_CODEX,
    );
  }
  const prompt = collabNotes.length
    ? `${basePrompt}\n\n## Collaboration\n\n${collabNotes.join("\n")}`
    : basePrompt;

  // Collaboration transports (G3/G4):
  //   Claude → in-process toolkit tools (post_comment / ask_human /
  //            report_outcome), merged with the profile's declared MCPs;
  //   Codex  → the outcome-envelope outputSchema on the final reply (the codex
  //            SDK can't mount our in-process tools) — only when a structured
  //            field (verdict/question) is actually usable, so a plain
  //            developer's report stays natural prose.
  const declaredMcps = resolvedMcps;
  const toolkit =
    backend === "claude" && realBackend
      ? buildAgentToolkit({
          db,
          ctx,
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          actorRef: agentActorRef,
          outcomeKey,
          collab,
          // Ruling 283: the SAME list the persona indexed, so the tool can read
          // exactly what the index named and nothing else.
          kb,
        })
      : null;
  // R19-19: the browser sits between the org grants and the toolkit — a registry
  // row can never shadow it (the name is refused at save), and it can never
  // shadow viberr's own governance tools. That precedence is the order below.
  const grantedMcpServers = { ...declaredMcps.mcpServers };
  if (browser.server) grantedMcpServers[BROWSER_MCP_NAME] = browser.server;
  if (knowledgeMount) grantedMcpServers[KNOWLEDGE_MCP_NAME] = knowledgeMount;
  if (boardMount) grantedMcpServers[BOARD_MCP_NAME] = boardMount;
  const mergedMcpServers = { ...grantedMcpServers, ...toolkit?.mcpServers };
  // P13-D-26: `collab.evidence` joins the gate. Codex has no `report_outcome`
  // tool, so the envelope is its ONLY structured channel — without this an
  // evidence-granted Codex agent silently had no way to cite anything, making
  // attach-evidence-references a Claude-only capability the profile editor
  // offered to every backend.
  const useEnvelopeSchema =
    backend === "codex" &&
    realBackend &&
    (collab.verdict || collab.ask || collab.evidence);

  // Each optional field is set only when it has something to say: `startRun`
  // derives its own defaults from an ABSENT key (an explicit undefined would
  // override the adapter's, e.g. the fully-isolated skills posture).
  const runInput: StartRunInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    // The engagement's live role snapshot — run rows no longer carry the
    // "Primary specialist"/"Reviewer" kind literals (shadow-kind cleanup).
    role: engagement.role,
    kind: delivers ? "primary" : "reviewer",
    backend,
    model,
    // Persist the agent identity so the Agent-logs picker groups this run's
    // resumes into one entry labeled by the agent's name.
    agentName,
    agentProfileId: engagement.profileId,
    // Ruling 127: the task owner pays for this run — or nobody does, and the
    // refusal below is what the run records. A run refused because the owner
    // has not connected the backend still NAMES that owner, so the refusal is
    // auditable; a run with no owner at all records null.
    credentialUserId: principal.ok
      ? principal.principal.userId
      : refusedPrincipalUserId(principal.refusal),
    prompt,
    actor: auditActor,
    dataRoot: ctx.dataRoot,
  };
  // Ruling 316: the run REMEMBERS that its verdict channel was withheld, so the
  // completion path can tell an answer from a silence. Ruling 313 stopped the
  // tool; without this the prose fallback manufactures the verdict anyway.
  if (input.withholdVerdict) runInput.verdictWithheld = true;
  // Ruling 544: what this run is judging — read from the same task file the
  // support checkout was pinned from — so a verdict returned after a newer
  // delivery binds to nothing it never read.
  runInput.reviewSubject = reviewSubjectId(existing.parsed.frontmatter);
  if (!principal.ok) runInput.principalRefusal = principal.refusal;
  if (effort) runInput.effort = effort;
  if (persona) runInput.systemPrompt = personaPrefix;
  runInput.compactAnchor = compactAnchor;
  if (disallowedTools.length) runInput.disallowedTools = disallowedTools;
  if (resolvedMcps.toolDenials.length) runInput.mcpToolDenials = resolvedMcps.toolDenials;
  // The SDK's native skills filter (Claude): exactly what mounted, nothing else.
  // Empty ⇒ the adapter keeps the fully-isolated defaults and the `Skill` tool
  // stays denied.
  if (skillMount.mounted.length) runInput.skills = skillMount.mounted;
  if (skillMount.plugin) runInput.skillPlugin = skillMount.plugin;
  // Profile MCPs (item-1/FR9) + the collaboration toolkit (Claude).
  if (Object.keys(mergedMcpServers).length) {
    runInput.mcpServers = mergedMcpServers;
  }
  if (useEnvelopeSchema) runInput.outputSchema = AGENT_OUTCOME_JSON_SCHEMA;
  if (runWorkdir) runInput.workdir = runWorkdir;
  if (realBackend) runInput.env = baseRunEnv;
  // The attachments drop the "Posting files" section above names. It widens
  // no sandbox any more (ruling 185 removed Codex's) — it is the path the
  // persona promises, carried on the spec so a resumed run keeps it (C02-R3).
  if (collab.evidence && realBackend) {
    runInput.attachmentsWritableDir = attachmentsDir;
  }
  // R21-4: hand the reserved row over — `startRun` adopts it rather than
  // minting a second one.
  if (pending.reservation) runInput.reservation = pending.reservation;

  const { runId, outcome, refusal } = await startRun(db, runInput);
  // Adopted: from here the row belongs to the RUN, and the wrapper's catch must
  // not finalize it as an error just because a post-start write threw — nor
  // remove the plugin the run is reading (run-service removes it at settle).
  pending.reservation = null;
  pending.skillPlugin = null;

  // Ruling 421: the run that puts the completeness question says so on its
  // engagement, keyed by THIS run's id, so the verdict it returns is recorded
  // as the answer. A refused run answers nothing, so it stamps nothing.
  if (input.completeness && outcome !== "refused") {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      const own = parsed.frontmatter.engagements.find(
        (e) => e.profileId === engagement.profileId,
      );
      if (own) own.question = { kind: "completeness", runId, at: new Date().toISOString() };
    });
  }

  // P19-G8/G11: the run's INPUTS, on the run, before its first provider line.
  // Everything here was already resolved above and, until now, thrown away.
  recordRunInputs(db, {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    backend,
    dataRoot: ctx.dataRoot,
    inputs: {
      ...resolvedResourceInputs({
        cwd: runWorkdir,
        repo,
        cloned: !!clone?.dir,
        // Ruling 129: what the pre-run refresh did, disclosed on the run.
        workspaceRefresh: clone?.refreshed,
        delivers,
        personaChars: persona.length,
        skills,
        nativeSkills: skillMount.mounted,
        kb,
        mountedMcps: Object.keys(mergedMcpServers),
        // The run RECORD keeps names; the reasons ride the prompt (ruling 310)
        // and the KB/skill misses already have their own name+reason list here.
        unresolvedMcps: resolvedMcps.unresolved.map((u) => u.name),
        unhealthyMcps: resolvedMcps.unhealthy,
        mcpWriteToolsDenied: resolvedMcps.toolDenials,
        unresolvedResources,
        deniedTools: disallowedTools,
        toolkit: toolkit?.toolNames ?? null,
        // Ruling 564: what the Claude adapter's hook confines the file tools to.
        fileWriteRoots:
          backend === "claude"
            ? fileWriteRoots(disallowedTools, runInput.attachmentsWritableDir)
            : null,
      }),
      promptChars: prompt.length,
      anchor,
      // Ruling 175: the cap `startRun` just stamped on the run, disclosed.
      spendCapUsd: getMaxRunSpendUsd(db),
      directive: input.directive?.trim()
        ? {
            from: input.directiveFrom?.trim() || null,
            chars: input.directive.trim().length,
          }
        : null,
    },
  });

  const backendLabel = BACKEND_LABEL[backend];
  const switched = engagement.backend !== backend;
  // F36-8 (pass 36): the event names the MODEL when the backend switch made
  // run-service substitute it, and says the pin sticks when this run set one.
  // Live, "switched from Codex" was the whole disclosure, and the next
  // operator dispatch ran on Claude/sonnet with nobody having chosen sonnet.
  const substitutedNote = modelSubstitution.foreignBackend
    ? ` on \`${ranModel}\`: the profile's \`${model}\` is a ${BACKEND_LABEL[modelSubstitution.foreignBackend]} model`
    : "";
  const pinNote = input.backendOverride
    ? `. Later runs on this task stay on ${backendLabel} until another retry moves them`
    : engagement.pinnedBackend && modelSubstitution.foreignBackend
      ? ` (this task is pinned to ${backendLabel})`
      : "";
  // F10-31: surface (in run evidence) when the operator directive tried to make
  // this specialist perform a server-owned delivery action (push / open / merge
  // a PR). The specialist prompt gives the typed contract precedence and the
  // clone has no push credential, so the directive is inert — but recording it
  // keeps the authority source auditable instead of silently trusted.
  // Ruling 323: the PHRASE, not a bare boolean. A heuristic that writes a
  // permanent accusation has to show its evidence — a reader who disagrees with
  // the note can see what it matched on, and so can whoever fixes the next hole.
  const deliveryPhrase = input.directive
    ? directiveRequestsDelivery(input.directive)
    : null;
  const directiveOverrode = deliveryPhrase !== null;
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      // Keep the engage-time snapshot in step with the backend that actually
      // ran (deployment edit or D4 retry): the exec-profile label stays honest.
      const engaged = parsed.frontmatter.engagements.find(
        (r) => r.profileId === engagement.profileId,
      );
      if (engaged && engaged.backend !== backend) {
        engaged.backend = backend;
      }
      // F27-B1 (owner ruling 2026-08-24): a D4 retry-on-other-backend is a
      // DELIBERATE switch that must STICK — pin it so later resolutions (operator
      // prompt / @mention) follow it OVER the live profile primary. Only an
      // explicit override sets the pin; a plain deployment-edit run leaves it be,
      // so an admin's later profile-backend change still takes effect.
      if (engaged && input.backendOverride) {
        engaged.pinnedBackend = input.backendOverride;
      }
      parsed.timeline.unshift(
        agentEvent(
          runDispatchLine({
            outcome,
            refusal,
            backendLabel,
            role: engagement.role,
            switchedFrom: switched ? BACKEND_LABEL[engagement.backend] : null,
            notes: `${substitutedNote}${pinNote}`,
          }),
        ),
      );
      if (directiveOverrode) {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "policy",
          actor: { kind: "system", systemId: "delivery" },
          title: null,
          text:
            `The directive for this run says \`${deliveryPhrase}\`, which reads as asking the ` +
            "specialist to perform delivery. That is a server-owned action. It was NOT " +
            "granted to the agent. Viberr performs delivery when the operator decides to; the " +
            "directive was treated as task guidance only. If the phrase was describing the " +
            "branch rather than instructing the agent, nothing was withheld: this note is a " +
            "record of what the directive said, not a refusal.",
          toAgent: false,
          evidence: null,
        });
      }
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  const runStartedDetails = {
    runId,
    profileId: engagement.profileId,
    backend,
    delivers,
    cloned: !!clone?.dir,
    // Ruling 133: why the run was admitted at this stage.
    stageEligibility,
  };
  // Ruling 357: a dispatch after the operator drive's own delivery is the
  // drive acting on it; the lease release then owes no `delivered` follow-up.
  if (ctx.operatorRun?.deliveredHeadMoved) ctx.operatorRun.actedAfterDelivery = true;
  recordAudit(db, {
    // ONE action id for every engaged agent (the former
    // task.specialist.run_started / task.reviewer.run_started split);
    // `delivers` in the details carries the distinction as data.
    action: "task.agent.run_started",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: directiveOverrode
      ? { ...runStartedDetails, directiveRequestedDelivery: true, deliveryPhrase }
      : runStartedDetails,
  });

  const {
    liftHoldForRun,
    markWaitingAgent,
    registerAgentCompletion,
  } = await import("./agent-completion.server");
  // Dynamic, like the import above: agent-reply already imports THIS module for
  // the deployed-specialist list, so a static import here would close a cycle.
  const { agentMentionHandle } = await import("./agent-reply.server");
  // Ruling 157 (pass 35, F35-8): a dispatch that starts a run lifts a
  // packet-less hold on the record, whichever door it came through (the Run
  // control, an @mention, the operator's `run_agent`, a schedule,
  // `retry_other_backend`, an applied recommendation).
  await liftHoldForRun(db, ctx, input.projectSlug, input.taskKey, {
    kind: "dispatch",
    profileId: engagement.profileId,
    name: agentName,
    by: ctx.operatorAuthorized ? null : auditActor,
  });
  // The board reads "agent working" while the run is in flight.
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);

  // ONE canonical completion handler for EVERY start path (UI "Run", @mention,
  // operator prompt): reply → reconcile delivery (delivers only) → outcome/
  // verdict → re-invoke the operator to react. `ctx.operatorRun` (set when
  // this run is inside an operator react loop) continues the chain at depth+1.
  const completion: Parameters<typeof registerAgentCompletion>[2] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    runId,
    backend,
    profileId: engagement.profileId,
    role: engagement.role,
    delivers,
    outcomeKey,
    workdir: runWorkdir,
    agentHandle: agentMentionHandle({ profileId: engagement.profileId, name: agentName }),
    // C5 (pass 25): a run that quotes a human's words (@mention directive) is a
    // conversational turn, not a review invocation — a reviewer answering it
    // owes no verdict. The no-verdict note is gated on this so it never fires for
    // a chat reply that merely lands while the task sits at the review stage.
    fromHumanDirective: !!input.directiveFrom,
    // F-P11 (pass 25): a plain Codex developer (no envelope schema) must not have
    // its prose reply re-parsed as an outcome envelope.
    envelopeRequested: useEnvelopeSchema,
    // Ruling 248 (F37-77): the server could not provision this run's checkout,
    // so it ran with no working tree. A run that read nothing judges nothing.
    noCheckout: !!cloneFailure,
  };
  // Dispatch-completion contract (2026-08-29): the mechanical half — the
  // completion pipeline appends the missing @tags to the report and ALWAYS
  // re-invokes the operator, bypassing the react heuristic (still depth-capped).
  if (input.triggeredByName?.trim()) {
    // Ruling 211(i): the same resolution the PROMPT half got (ruling 207(e)).
    // This is the mechanical fallback — the cc line the pipeline appends when
    // the model did not tag the dispatcher itself — and it was still carrying
    // the raw `TaskActor.label`, which for a schedule is an email. So the
    // guaranteed ping reached nobody in exactly the path that exists because
    // the model forgot, which is the one that most needs to work.
    completion.dispatchedByName = taggableName(
      input.triggeredByUserId,
      input.triggeredByName.trim(),
    );
    if (input.triggeredByUserId) {
      completion.dispatchedByUserId = input.triggeredByUserId;
    }
  }
  // Only a run started INSIDE an operator react loop carries the loop state —
  // its absence is what tells the completion handler not to continue a chain.
  if (ctx.operatorRun) completion.operatorRun = ctx.operatorRun;
  await registerAgentCompletion(db, ctx, completion);

  return { runId, backend, role: engagement.role, name: agentName, outcome, refusal };
}

// -------------------------------------------------------------- quota hold

/** The sentence a door shows for a held dispatch (a toast, an @mention's
 *  `runNotStarted`, the operator's tool reply): what is held, until when, and
 *  that the retry is already on the schedule. */
function dispatchHeldSentence(input: {
  backendLabel: string;
  agentName: string;
  untilLabel: string | null;
  dueLabel: string | null;
  deployed: boolean;
}): string {
  const scheduled = input.dueLabel
    ? input.untilLabel
      ? `${input.agentName}'s run is scheduled for then`
      : `${input.agentName}'s run is retried at ${input.dueLabel}`
    : input.deployed
      ? `${input.agentName}'s run was not rescheduled because this task refuses a schedule, run it again once the window reopens`
      : `${input.agentName}'s run was not rescheduled because it is no longer deployed here`;
  return input.untilLabel
    ? `Held: ${input.backendLabel} is out of quota until ${input.untilLabel}; ${scheduled}.`
    : `Held: ${input.backendLabel} is out of quota and the reopen time is unknown; ${scheduled}.`;
}

/**
 * Ruling 152(c): the ONE read every door that starts provider work passes
 * through, against its own target backend and the account the work bills.
 * `dispatchAgentRun` is one caller; `commentToAgent`'s RESUME branch is the
 * other, because it goes straight to `resumeRun` and would otherwise pay the
 * MCP pre-flight, the skill re-mount and a refused provider run on a window
 * the instance already knows is spent — the common repeat, since a hold is
 * usually recorded because a run FAILED and the agent therefore has a session.
 * Returns nothing and throws `DispatchHeldError` when the backend is held.
 */
export async function assertDispatchNotHeld(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    backend: RealBackend;
    /** The user the work bills (ruling 127); the hold is scoped to it. */
    credentialUserId: string;
    profileId: string;
    agentName: string;
    deployed: boolean;
    directive: string | null;
    actor: AuditActor;
  },
): Promise<void> {
  const hold = backendDispatchHold(db, input.backend, {
    credentialUserId: input.credentialUserId,
  });
  if (!hold) return;
  throw await holdDispatch(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    backend: input.backend,
    hold,
    profileId: input.profileId,
    agentName: input.agentName,
    deployed: input.deployed,
    directive: input.directive,
    actor: input.actor,
  });
}

/**
 * Ruling 152(c): record a held dispatch and hand back the error the door
 * throws. Nothing here is a run: no row, no reservation, no process. The
 * schedule is the retry (`run-agent`, the same profile and directive, due one
 * minute after the reopen instant, or `UNDATED_HOLD_MS` after the refusal
 * when the provider named none); the note is the human's record; the audit
 * row is the machine's. A profile that is no longer deployed cannot be
 * scheduled (the schedule writer refuses a phantom), so the note says the
 * retry is not scheduled instead of failing the hold on that refusal.
 */
async function holdDispatch(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    backend: RealBackend;
    hold: BackendDispatchHold;
    profileId: string;
    agentName: string;
    deployed: boolean;
    directive: string | null;
    actor: AuditActor;
  },
): Promise<AppError> {
  const backendLabel = BACKEND_LABEL[input.backend];
  const untilIso = input.hold.until != null ? new Date(input.hold.until).toISOString() : null;
  const untilLabel = formatResetLabel(untilIso);
  const observedMs = Date.parse(input.hold.observedAt);
  const reopensMs =
    input.hold.until ?? (Number.isFinite(observedMs) ? observedMs : Date.now()) + UNDATED_HOLD_MS;
  const dueAt = new Date(Math.max(reopensMs + 60_000, Date.now() + 60_000)).toISOString();
  // Cluster review (pass 35): ONE pending retry per profile per window. Every
  // door reaches this function and a spent window is exactly what makes a
  // person (and the operator) dispatch again, so an unconditional
  // `scheduleTaskAction` turned N refused dispatches into N pending
  // `run-agent` occurrences all due at the same reopen instant. They are
  // claimed in one tick: the first starts the run, the rest bounce off the
  // single-flight 409, defer back to pending with no retry spent, and start
  // the SAME directive again once that run ends — the paid runs G35-5(c)
  // exists to stop, moved to the other side of the window. A pending
  // occurrence for this profile due at or after this hold's reopen instant IS
  // the retry, so it is reused.
  const pendingRetry =
    readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))
      ?.parsed.frontmatter.schedules.find(
        (s) =>
          s.status === "pending" &&
          s.action === "run-agent" &&
          s.profileId === input.profileId &&
          Date.parse(s.dueAt) >= reopensMs,
      ) ?? null;
  let scheduleId: string | null = pendingRetry?.id ?? null;
  /** A repeat hold that changed nothing says nothing: the note, and the
   *  "Scheduled:" event beside it, are already on the timeline. */
  let restate = pendingRetry === null;
  /** The newest directive wins over the pending occurrence's own (the machine
   *  triggers' rule), and a directive that replaced another is worth the note
   *  the reader needs to see what the reopen will actually run. */
  const newerDirective =
    pendingRetry !== null &&
    input.directive !== null &&
    input.directive.trim() !== "" &&
    input.directive !== pendingRetry.prompt
      ? input.directive
      : null;
  if (pendingRetry !== null && newerDirective !== null) restate = true;
  if (pendingRetry === null && input.deployed) {
    const { scheduleTaskAction } = await import("./schedule.server");
    const scheduleInput: Parameters<typeof scheduleTaskAction>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      dueAt,
      action: "run-agent",
      profileId: input.profileId,
    };
    if (input.directive) scheduleInput.prompt = input.directive;
    try {
      scheduleId = (await scheduleTaskAction(db, scheduleInput, input.actor, ctx)).id;
    } catch (error) {
      // A task at its terminal stage refuses a schedule; the hold still
      // stands and the note says the retry is by hand.
      logger.warn("held dispatch could not be rescheduled", {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        profileId: input.profileId,
        err: toError(error),
      });
    }
  }
  const dueLabel = scheduleId ? formatResetLabel(pendingRetry?.dueAt ?? dueAt) : null;
  const quoted = input.hold.providerText.trim();
  const said = quoted ? ` (the provider said: "${quoted}")` : "";
  const retry = scheduleId
    ? untilLabel
      ? `${input.agentName}'s run starts when the window reopens (scheduled for ${dueLabel}); nothing was dispatched and no decision is needed.`
      : `the reopen time is unknown, so ${input.agentName}'s run is retried at ${dueLabel}. Nothing was dispatched and no decision is needed.`
    : `nothing was dispatched and no decision is needed. The retry was not scheduled because ${input.agentName} ${input.deployed ? "cannot be scheduled on this task" : "is no longer deployed on this project"}; run it again once the window reopens.`;
  const text = untilLabel
    ? `**Held:** ${backendLabel} is out of quota until ${untilLabel}${said}. ${retry}`
    : `**Held:** ${backendLabel} is out of quota${said}; ${retry}`;
  if (restate) {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      if (newerDirective !== null) {
        const target = parsed.frontmatter.schedules.find((s) => s.id === scheduleId);
        if (target && target.status === "pending") target.prompt = newerDirective;
      }
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: "Dispatch held",
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  }
  recordAudit(db, {
    action: "task.agent.run_held",
    actor: input.actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      backend: input.backend,
      until: untilIso,
      scheduleId,
      profileId: input.profileId,
      // The machine's record of a repeat: the audit row stands for every held
      // attempt (the timeline note does not), and this says which of them
      // minted the retry and which reused it.
      reusedSchedule: pendingRetry !== null,
    },
  });
  return new DispatchHeldError(
    dispatchHeldSentence({
      backendLabel,
      agentName: input.agentName,
      untilLabel,
      dueLabel,
      deployed: input.deployed,
    }),
    {
      backend: input.backend,
      until: untilIso,
      scheduleId,
      profileId: input.profileId,
      agentName: input.agentName,
    },
  );
}

/** What a held dispatch recorded, for the door that catches it. */
export interface DispatchHoldRecord {
  backend: RealBackend;
  /** ISO instant the window reopens; null when the provider named none. */
  until: string | null;
  /** The `run-agent` schedule the hold made; null when none could be. */
  scheduleId: string | null;
  profileId: string;
  agentName: string;
}

/** Ruling 152(c): the hold a dispatch door reads as "already rescheduled,
 *  nothing to retry" rather than as a refusal (400) or a conflict (409). A
 *  typed subclass so the record travels as itself, not as a details bag. */
export class DispatchHeldError extends AppError {
  readonly hold: DispatchHoldRecord;
  constructor(userMessage: string, hold: DispatchHoldRecord) {
    super({
      code: ERROR_CODES.DISPATCH_HELD,
      status: 409,
      userMessage,
      details: {
        backend: hold.backend,
        until: hold.until,
        scheduleId: hold.scheduleId,
        profileId: hold.profileId,
      },
    });
    this.hold = hold;
  }
}

export function isDispatchHeld(cause: unknown): cause is DispatchHeldError {
  return cause instanceof DispatchHeldError;
}

/**
 * Ruling 452: the single-flight refusal, typed, naming whose run is live. A
 * dispatch door records a person's directive before the start (ruling 375),
 * so when the live run is the SAME agent's, the directive sits inside that
 * run's window and ruling 203 delivers it when the run finishes. The door says
 * so instead of "No run started" and "wait, then start another", which a
 * person who obeyed turned into a second delivery of the same words.
 */
class AgentBusyError extends AppError {
  /** The profile whose run is live; ruling 203 delivers to that profile only. */
  readonly busyProfileId: string | null;
  constructor(userMessage: string, busyProfileId: string | null) {
    super({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage,
      details: { busyProfileId },
    });
    this.busyProfileId = busyProfileId;
  }
}

export function isAgentBusy(cause: unknown): cause is AgentBusyError {
  return cause instanceof AgentBusyError;
}

/** Ruling 452: the person's note beside a directive whose agent was already
 *  running — one sentence for every dispatch door that records one. */
export function directiveDeferredNote(agentName: string): string {
  return (
    `${agentName} is already running on this task, so no second run started. ` +
    "These words are delivered to it when that run finishes."
  );
}

// ------------------------------------------------------------------- repo clone

/** The whole confinement a RESUMED run inherits — one contract so a resume can
 *  never silently carry less policy than the fresh run did (the XS-1 class). */
export interface ResumeConfinement {
  disallowedTools: string[];
  /** Ruling 176: the org servers' marked write tools the resumed run
   *  withholds, re-derived like the rest of its policy. */
  mcpToolDenials?: McpToolDenial[];
  env: Record<string, string>;
  mcpServers?: RunMcpServers;
  /** Ruling 370: the persona as its static/dynamic split. */
  systemPrompt?: RunPrompt;
  /** Ruling 371: the compaction anchor, re-derived like the rest. */
  compactAnchor?: string;
  /** The granted skills re-mounted beside the surviving workspace (Claude). */
  skills?: string[];
  /** Ruling 180: the resumed run's own plugin directory carrying `skills`. */
  skillPlugin?: SkillPlugin;
  /** Staging key for a Claude report_outcome on this resumed turn. */
  outcomeKey?: string;
  /** F7: the Codex outcome-envelope schema to re-arm on resume. */
  outputSchema?: unknown;
  /** P19-G8/G11: the resolved-resource half of this resumed run's input
   *  disclosure — the SAME record the fresh path writes, built from the SAME
   *  resolution this function performs. The caller owns the remaining three
   *  fields (it composes the prompt) and passes the whole thing to
   *  `recordRunInputs` once `resumeRun` has minted the run id — which ruling
   *  343 made true; this sentence asserted it for two days while the field had
   *  no reader at all. */
  runInputs: ResolvedResourceInputs;
  /** C02-R3 (pass 32): the task's attachments drop, when the profile holds
   *  `attach-evidence-references` — re-armed on resume exactly as the fresh
   *  run mounts it — the path the "Posting files" section promises. Absent
   *  when evidence is withheld. */
  attachmentsWritableDir?: string;
}

/**
 * Reapply the fresh-run confinement and resources when resuming a specialist.
 *
 * ASYNC since the skill mount: a resumed run re-mounts its granted skills into
 * the surviving workspace, exactly as the fresh run did. It has to. The mount
 * is what the SDK reads, the mount decides which skills the persona injects, and
 * grants can change between the two runs — so re-deriving both from one call is
 * the only shape where a resume cannot silently disagree with the fresh run
 * (the XS-1 class: resume kept dropping half of the run's policy).
 */
export async function resolveResumeConfinement(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    /** The resumed run's backend + engagement shape — rebuilds the same
     *  collaboration transport the fresh-run path mounts: the toolkit on Claude,
     *  and (F7) the outcome-envelope outputSchema on Codex so a resumed Codex
     *  agent still emits a structured verdict/questions instead of prose. */
    backend?: RealBackend;
    role?: string;
    delivers?: boolean;
  },
): Promise<ResumeConfinement> {
  const env = {
    ...workspaceRunEnv(input.projectSlug, input.taskKey, ctx.dataRoot),
    // F24: keep the unified delivery identity on resumed runs too.
    ...agentGitIdentityEnv(input.profileId),
  };
  // P8 (pass 25): a resumed SUPPORTING run reuses its OWN isolated checkout, the
  // same one its fresh run cloned — never the delivering engagement's canonical
  // tree. `resumeWorkdir` scopes the actual cwd; this scopes the disclosure +
  // skill mount to match.
  const support = input.delivers ? undefined : { profileId: input.profileId };
  try {
    const resolved = resolveDeployedSpecialist(
      ctx,
      input.projectSlug,
      input.profileId,
    );
    const disallowedTools = resolveSpecialistDisallowedTools(resolved.capabilities);
    // P14-LV-09: resolve first, then describe what MOUNTED — the resumed run
    // gets the same honest prompt as a fresh one. F20-10: pre-flight the stdio
    // mounts so a server that fails to start is dropped + disclosed here too.
    // Ruling 176: with the same write-tool withholding the fresh run derives.
    const resumeMcps = await verifyStdioMcpMountsForRun(
      db,
      resolveSpecialistMcpServersDetailed(db, resolved.mcps, {
        withholdWriteTools: repoWriteWithheldFromDenylist(disallowedTools),
      }),
    );
    const mcpServers = resumeMcps.servers;
    // R18-1 parity: a resumed/@mention reviewer must keep the deliverer's KBs it
    // had on the fresh run, or it silently loses those conventions mid-thread.
    const resumeTask = readTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
    );
    // Ruling 239: and the project's rulings, for the same reason R18-1 keeps the
    // deliverer's KBs here — a resumed thread that silently drops a knowledge
    // base mid-conversation is worse than one that never had it, because the
    // agent's earlier turns were reasoning with it. This is the SECOND place
    // that builds a run's KB list; the fresh-run site is the one ruling 239
    // shipped with, and this one was missed.
    const kb = withProjectRulings(
      !input.delivers && resumeTask
        ? withDeliveringGrants(resolved.kb, () =>
            deliveringContextGrants(
              resumeTask.parsed.frontmatter,
              input.profileId,
              (profileId) =>
                resolveDeployedSpecialist(ctx, input.projectSlug, profileId).kb,
            ),
          )
        : resolved.kb,
      input.projectSlug,
      ctx,
    );
    // Re-mount beside the workspace this task's runs share (ruling 180: one
    // plugin per run, so a RESUMED supporting agent can no longer wipe the
    // delivering run's skills — the F19-15 race the in-checkout mount had).
    // `resumeWorkdir` (agent-reply) hands the resumed run the same clone when
    // it still exists; a task whose clone is gone has nothing to mount beside
    // and falls back to injection.
    let skillMount: SkillMount = { mounted: [], skipped: [], plugin: null };
    if (input.backend === "claude") {
      const mountInput: SkillMountInput = {
        workspaceDir: taskCloneDir(ctx, input.projectSlug, input.taskKey, support),
        skills: resolved.skills,
        // The resumed run's row does not exist yet: a fresh id names the
        // directory; the run carries the path and removes it at settle.
        runId: newId("run"),
      };
      // Omitted on the default store — the mount resolves its own root then.
      if (ctx.dataRoot) mountInput.dataRoot = ctx.dataRoot;
      mountInput.git = personGitOrNull(db, input.projectSlug, input.taskKey, ctx.dataRoot);
      skillMount = await mountGrantedSkills(mountInput);
    }
    // R19-19: the browser re-mounts on resume from the same grants — a resumed
    // run must not silently lose (or gain) the browser the fresh run had.
    const resumeBrowser = input.backend
      ? resolveBrowserMcp({
          grants: resolved.capabilities,
          attachmentsDir: taskAttachmentsDir(
            input.projectSlug,
            input.taskKey,
            ctx.dataRoot,
          ),
          backend: input.backend,
        })
      : { server: null, refused: null };
    // Ruling 585: the knowledge server re-mounts on resume from the same list.
    const resumeKnowledge = resolveKnowledgeMcp({
      backend: input.backend,
      kb,
      dataRoot: ctx.dataRoot,
      agent: { profileId: input.profileId, roleHint: input.role ?? resolved.role },
    });
    const resumeUnresolved: { name: string; reason: string }[] = [];
    // Resolve the collaboration gates up-front: the persona's github_read
    // section (F4) needs `collab.githubRead`, and the toolkit below reuses the
    // same value. Same both-paths parity the browser mount keeps (line ~2476).
    // Ruling 555: a resumed deliverer is offered no verdict either.
    const resumeGranted = resolveAgentCollab(resolved.capabilities);
    const collab = input.delivers ? { ...resumeGranted, verdict: false } : resumeGranted;
    // Ruling 589: and the board server, from the same grants.
    const resumeBoard = resolveBoardMcp({
      backend: input.backend,
      collaborates: holdsCollaborationGrant(collab),
      dataRoot: ctx.dataRoot,
    });
    const resumeRepo = projectRepo(ctx, input.projectSlug);
    const personaInput: SpecialistPersonaInput = {
      profileId: input.profileId,
      rulingsKb: projectRulingsKb(input.projectSlug, ctx),
      // undefined on a run with no backend (no-op) → no backend-specific persona.
      backend: input.backend,
      skills: resolved.skills,
      nativeSkills: skillMount.mounted,
      kb,
      knowledgeTool: input.backend !== "codex" || resumeKnowledge !== null,
      mcps: [
        ...Object.keys(mcpServers),
        ...(resumeBrowser.server ? [BROWSER_MCP_NAME] : []),
      ],
      unresolvedMcps: resumeMcps.unresolved.filter((u) => !u.mounted),
      unhealthyMcps: resumeMcps.unresolved.filter((u) => u.mounted).map((u) => u.name),
      mcpWriteToolsDenied: resumeMcps.toolDenials,
      mcpProxied: resumeMcps.proxied,
      mcpOAuthGrants: resumeMcps.oauthGrants,
      // Ruling 159: the absolute dir, exactly as the fresh path hands it.
      browser: resumeBrowser.server
        ? {
            attachmentsDir: taskAttachmentsDir(input.projectSlug, input.taskKey, ctx.dataRoot),
          }
        : resumeBrowser.refused
          ? { refusedReason: resumeBrowser.refused.reason }
          : null,
      // C02-R3: the same drop section the fresh persona carries — a resumed
      // evidence-granted run used to lose "how to post a file" mid-thread.
      attachmentsDrop: collab.evidence
        ? {
            attachmentsDir: taskAttachmentsDir(input.projectSlug, input.taskKey, ctx.dataRoot),
          }
        : null,
      // Same predicate as the fresh path. A resume is always a REAL backend
      // (an unavailable one fail-fasts before it ever mounts a toolkit), so the
      // realBackend term is `true` here — stated, not silently omitted.
      githubRead: githubReadForRun({
        githubRead: collab.githubRead,
        backend: input.backend,
        realBackend: true,
        repo: resumeRepo,
      }),
      dataRoot: ctx.dataRoot,
      unresolvedOut: resumeUnresolved,
    };
    // Same rule as the fresh run: a profile with no body of its own leaves the
    // key ABSENT so the builder falls back to the generic prompt.
    if (resolved.definition) personaInput.definition = resolved.definition;
    const personaPrefix = buildSpecialistPromptPrefix(personaInput);
    const persona = joinedPrompt(personaPrefix);
    if (resumeBrowser.refused) resumeUnresolved.push(resumeBrowser.refused);
    // Ruling 371: the same anchor the fresh run carries (XS-1 parity).
    const compactAnchor = specialistCompactAnchor({
      taskKey: input.taskKey,
      title: resumeTask?.parsed.frontmatter.title ?? input.taskKey,
      taskMdPath: resolveTaskFilePath(taskRef(ctx, input.projectSlug, input.taskKey)),
      branch: resumeTask?.parsed.frontmatter.branch ?? null,
      pr: prAnchor(resumeTask?.parsed.frontmatter.pr?.number ?? null, resumeRepo),
      kb: sortedNames(kb),
      rulingsKb: projectRulingsKb(input.projectSlug, ctx),
    });
    // Same collaboration transport the fresh-run path mounts (XS-1 / F7 parity):
    // the in-process toolkit on Claude, the outcome-envelope outputSchema on
    // Codex. Both key off the SAME collaboration grants the fresh run resolves
    // (`collab`, resolved above so the persona could read `githubRead`).
    let outcomeKey: string | undefined;
    let toolkit: AgentToolkit | null = null;
    let outputSchema: unknown;
    if (input.backend === "claude") {
      outcomeKey = newId("oc");
      toolkit = buildAgentToolkit({
        db,
        ctx,
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        actorRef: {
          kind: "agent",
          backend: "claude",
          profileId: input.profileId,
          roleHint: input.role ?? resolved.role,
        },
        outcomeKey,
        collab,
        kb,
      });
    } else if (
      input.backend === "codex" &&
      (collab.verdict || collab.ask || collab.evidence)
    ) {
      // F7: re-arm the Codex outcome envelope on resume — a resumed reviewer
      // used to lose it and fall back to the fragile prose regex (ask_human
      // could not fire at all). P13-D-26 adds evidence to the same gate, so a
      // resumed agent keeps the channel it started with.
      outputSchema = AGENT_OUTCOME_JSON_SCHEMA;
    }
    // Same precedence as the fresh run: org grants, then the browser, then
    // viberr's own governance tools.
    const grantedServers = { ...mcpServers };
    if (resumeBrowser.server) {
      grantedServers[BROWSER_MCP_NAME] = resumeBrowser.server;
    }
    if (resumeKnowledge) grantedServers[KNOWLEDGE_MCP_NAME] = resumeKnowledge;
    if (resumeBoard) grantedServers[BOARD_MCP_NAME] = resumeBoard;
    const merged = { ...grantedServers, ...toolkit?.mcpServers };
    const cloneDir = taskCloneDir(ctx, input.projectSlug, input.taskKey, support);
    // C02-R3: the fresh path creates the drop BEFORE the run so a plain `cp`
    // cannot fail on a missing path; a resume is a real backend by
    // construction, so the same holds here.
    let attachmentsWritableDir: string | undefined;
    if (collab.evidence) {
      attachmentsWritableDir = taskAttachmentsDir(
        input.projectSlug,
        input.taskKey,
        ctx.dataRoot,
      );
      shareDirWithAgents(attachmentsWritableDir);
    }
    const confinement: ResumeConfinement = {
      disallowedTools,
      env,
      runInputs: resolvedResourceInputs({
        cwd: cloneDir,
        repo: projectRepo(ctx, input.projectSlug),
        workspaceRefresh: undefined,
        cloned: !!cloneDir && existsSync(cloneDir),
        delivers: input.delivers === true,
        personaChars: persona.length,
        skills: resolved.skills,
        nativeSkills: skillMount.mounted,
        kb,
        mountedMcps: Object.keys(merged),
        unresolvedMcps: resumeMcps.unresolved
          .filter((u) => !u.mounted)
          .map((u) => u.name),
        unhealthyMcps: resumeMcps.unresolved.filter((u) => u.mounted).map((u) => u.name),
        mcpWriteToolsDenied: resumeMcps.toolDenials,
        unresolvedResources: resumeUnresolved,
        deniedTools: disallowedTools,
        toolkit: toolkit?.toolNames ?? null,
        fileWriteRoots:
          input.backend === "claude"
            ? fileWriteRoots(disallowedTools, attachmentsWritableDir)
            : null,
      }),
    };
    if (attachmentsWritableDir) confinement.attachmentsWritableDir = attachmentsWritableDir;
    if (resumeMcps.toolDenials.length) confinement.mcpToolDenials = resumeMcps.toolDenials;
    // Each key is set only when this resume really has that policy: the caller
    // spreads the result into the resume spec, where an ABSENT key means "keep
    // the adapter's default" and a present-but-undefined one would not.
    if (Object.keys(merged).length) confinement.mcpServers = merged;
    if (persona) confinement.systemPrompt = personaPrefix;
    confinement.compactAnchor = compactAnchor;
    if (skillMount.mounted.length) confinement.skills = skillMount.mounted;
    if (skillMount.plugin) confinement.skillPlugin = skillMount.plugin;
    if (outcomeKey) confinement.outcomeKey = outcomeKey;
    if (outputSchema) confinement.outputSchema = outputSchema;
    return confinement;
  } catch {
    // Profile not a current deployment (undeployed/deleted). We can't confirm
    // any grant, so confine CONSERVATIVELY — deny ALL delivery tools, not just
    // the always-human merge (AO-5 #5). A resumed run of a vanished profile may
    // read/validate but never write/push/PR.
    const withheld = resolveUndeployedDisallowedTools();
    return {
      disallowedTools: withheld,
      env,
      // P19-G11: the disclosure states the withheld posture rather than going
      // silent — "this run's profile could not be resolved" is exactly the kind
      // of thing a human reading the console needs to be told.
      runInputs: resolvedResourceInputs({
        cwd: taskCloneDir(ctx, input.projectSlug, input.taskKey, support),
        repo: projectRepo(ctx, input.projectSlug),
        workspaceRefresh: undefined,
        cloned: false,
        delivers: input.delivers === true,
        personaChars: 0,
        skills: [],
        nativeSkills: [],
        kb: [],
        mountedMcps: [],
        unresolvedMcps: [],
        unhealthyMcps: [],
        mcpWriteToolsDenied: [],
        unresolvedResources: [
          {
            name: input.profileId,
            reason:
              "the agent profile is no longer a deployment on this project; no grant could be confirmed, so this run is fully withheld",
          },
        ],
        deniedTools: withheld,
        toolkit: null,
      }),
    };
  }
}
