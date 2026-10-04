import { type ResolvedPacketOption } from "~/shared/packet-server-outcome";
import { existsSync } from "node:fs";
import { shareDirWithAgents, shareDirWithAgentsOrWarn } from "./agent-isolation.server";
import { removeAgentTree } from "./agent-trees.server";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { getMaxRunSpendUsd } from "~/server/settings/instance-settings.server";
import { recordRunInputs } from "~/server/runtimes/run-inputs.server";
import {
  readProjectFile,
  type ProjectFileRef,
} from "~/server/files/project-writer.server";
import { getPatToken, getProjectCredential } from "~/server/secrets/pat-store.server";
import {
  cloneTimeoutMs,
  cloneFailureLogDetails,
  cloneFailureSentence,
  type CloneCredential,
  WorkspaceFault,
  workspaceStep,
} from "~/server/tasks/git-clone-auth.server";
import {
  cloneProgressStep,
  cloneStepLabel,
  cloneWorkspaceRepo,
  mirrorIsCold,
  type WorkspaceCloneInput,
} from "~/server/tasks/repo-mirror.server";
import { stripUngovernedRepoCatalog } from "./skill-mount.server";
import { initializeUnbornCheckout } from "~/server/tasks/unborn-checkout.server";
import { taskWorkspaceGit, taskWorkspaceLaunch } from "~/server/tasks/workspace-git.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  appendTimelineEvent,
  readTaskFile,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import {
  operatorUpdateBranchFromBase,
  updateBranchGate,
} from "~/server/github/update-branch-operator.server";
import {
  CREATE_TASK_BASE_NOTE,
  deliverGate,
  dispatchGate,
  gate,
  OPERATOR_TIMELINE_DEFAULT,
  operatorAcceptCompletion,
  type OperatorActionResult,
  type OperatorAuthority,
  type OperatorAuthorityOverrides,
  type OperatorAutonomy,
  operatorCancelSchedule,
  operatorCorrectKnowledgeDoc,
  operatorDeliverForReview,
  operatorDispatchAgent,
  operatorEditComment,
  operatorFlagContextConflict,
  operatorLeaseFiles,
  operatorOpenPacket,
  type OperatorOpenPacketInput,
  type OperatorPacketOptionInput,
  operatorPostComment,
  operatorRelayToTask,
  operatorResolvePacket,
  operatorScheduleRun,
  operatorSetDependencies,
  operatorSetEpic,
  operatorSetGoal,
  operatorSnapshot,
  operatorTakeFromTask,
  operatorTransitionStage,
  operatorWriteCompletionPacket,
  resolveOperatorAuthority,
} from "~/server/tasks/operator-actions.server";
import { PACKET_OPTION_KINDS, type PacketOptionKind } from "~/schemas/task-file.schema";
import { DONE_SIGNAL_RULE } from "~/server/tasks/done-signal.server";
import type { RelayPayload } from "~/server/tasks/task-relay.server";
import {
  buildOperatorToolkit,
  noteConsultedProfile,
  operatorOpenPacketDisclosed,
} from "~/server/tasks/operator-toolkit.server";
import { getProject } from "~/server/projections/board-query.server";
import { closureRefusal, taskClosure } from "~/server/tasks/task-closure.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { splitKbSource } from "~/server/tasks/kb-correction-actions.server";
import { fullReplyTextForRun, runFailureReason } from "~/server/tasks/agent-reply.server";
import {
  clearWaitingToHuman,
  liftHoldForRun,
  liftStageHoldForPerson,
  markWaitingAgent,
} from "~/server/tasks/agent-completion.server";
import { OPERATOR_TRANSITION_CHAIN_CAP } from "~/server/tasks/task-action-core.server";
import {
  reprojectTask,
  taskRef,
  type TaskMutationContext,
} from "~/server/tasks/task-mutation.server";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { RUN_PHASE } from "./adapter.server";
import type { RealBackend } from "./runtime-registry.server";
import {
  refusedPrincipalUserId,
  resolveTaskRunPrincipal,
  type RunPrincipalResolution,
} from "./run-principal.server";
// F21-3: the ONE operator confinement list, defined in claude-runtime.
import {
  chainRunCompletion,
  registerRunCompletion,
  reserveRun,
  startRun,
  type RunReservation,
  type StartRunInput,
} from "./run-service.server";
import { getRun, patchRun } from "./run-store.server";
import { holdEntriesSentence, type DependencyReleasePayload } from "~/shared/dependencies";
import { resolveDependencies } from "~/server/projections/dependencies.server";
import {
  describeRunFailure,
  type DescribeRunFailureInput,
} from "~/server/tasks/run-failure-remedy.server";
import { PLAN_NOT_CARRIED_OUT_LEAD } from "~/shared/run-failure";
import {
  noteModelAvailabilityFromFailure,
  clearModelMark,
} from "./model-availability.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  buildCodexOperatorPrompt,
  buildOperatorSystemPrompt,
  buildOperatorTurnPrompt,
  NO_OPERATOR_MCPS,
  operatorDisallowedTools,
  operatorMcpResolution,
  operatorTurnDirective,
  transitionContextOf,
} from "./operator-prompt.server";

/**
 * Runs the operator through Claude or Codex. The operator is given its persona
 * (agent
 * definition) + the Viberr app-expertise skill as a system prompt, plus the
 * in-process governance tools (operator-toolkit). It drives the task toward
 * its next boundary under its capability policy + autonomy level.
 *
 *   claude + credential present → REAL tool-driven run: the model calls the
 *     `mcp__viberr__*` tools; every call mutates the store and updates the
 *     board live. This is the path the "operator end to end" proof exercises.
 *   codex + credential present → STRUCTURED-PLAN run: Codex emits a structured
 *     JSON plan (OPERATOR_PLAN_SCHEMA), which `executeCodexPlan` runs through the
 *     same gated operator-actions as the Claude tools — so Codex honors the
 *     identical RBAC + autonomy, it just plans-then-executes instead of
 *     calling tools live.
 *   no credential principal (ruling 127) → the drive still opens a RUN ROW, but
 *     `startRun` records it as an honest error and the completion hook
 *     escalates a blocked recovery packet. The operator is a TASK run, so its
 *     principal is the task OWNER: an unowned task, a dead owner, or an owner
 *     who has not connected this backend all land here, and none of them clones
 *     a repository or spawns a process.
 */

export interface RunOperatorInput {
  projectSlug: string;
  taskKey: string;
  /** Backend to run the operator on (claude|codex). Defaults to the deployment. */
  backend?: RealBackend;
  /** Autonomy for THIS run (supervised|full). Defaults to the deployment. */
  autonomy?: OperatorAutonomy;
  /**
   * Why this operator run fired, which shapes what it does:
   *   create / transition / manual → COORDINATE: prompt the stage's agent with a
   *     task-related "@handle …" directive, then stop and wait for it to report.
   *   agent-reply → REACT: an agent the operator prompted just replied — read its
   *     report and propose the next state change (recommend/perform the transition
   *     or accept completion), rather than re-prompting.
   *   scheduled → RE-CHECK: a human scheduled this run earlier; `scheduleNote`
   *     carries the reason they gave, which the turn instruction honors.
   *   pr-diverged → RECOVER: GitHub reported an out-of-band PR state change
   *     (closed without merge / merged uncelebrated / reopened) — assess it and
   *     open the recovery decision, withdraw a moot packet, or recommend
   *     acceptance, per the turn instruction.
   *   delivered → PROCEED: the server just opened the review PR (a full-autonomy
   *     delivery). Not a transition, so this is the seam that keeps an autonomous
   *     task moving — engage the reviewer / recommend the next step from the live
   *     snapshot (R18-2).
   *   packet-resolved → PROCEED: a human just answered your decision packet
   *     (R20-1 / F20-5). The decision and their note are in the turn instruction;
   *     act on it. Never re-open the packet you were just answered on — if the
   *     same condition still blocks you, say so in ONE typed event or open a
   *     packet that names the NEW information.
   */
  trigger?:
    | "create"
    | "transition"
    | "agent-reply"
    | "goal-updated"
    | "pr-diverged"
    | "delivered"
    | "packet-resolved"
    | "dependencies-released"
    | "head-unpushed"
    /** Ruling 330: the periodic sweep found this task in a state nothing was
     *  going to move it out of. */
    | "stranded"
    /** Ruling 332: a person pressed Accept and the acceptance-time refresh
     *  found the branch in conflict with the base. */
    | "pr-conflicting"
    /** Ruling 482: the project's gates, run by Viberr on the revision under
     *  review, did not all exit 0. */
    | "gates-failed"
    /** Ruling 488: work on another task of this project relayed text here
     *  (`relay` carries it). */
    | "relayed"
    | "scheduled"
    | "manual";
  /** Ruling 141: the schedule occurrence this trigger fires for, so a refusal
   *  that meets it at the front of the lease queue can retire it on the
   *  record. Set by the schedule runner only. */
  scheduleId?: string;
  /** packet-resolved trigger: the option the human chose and any note, so the
   *  turn instruction can tell the operator exactly what was decided rather than
   *  making it re-derive the answer from the timeline (R20-1). */
  resolvedOption?: ResolvedPacketOption;
  /** `dependencies-released` trigger (ruling 131(e)): what the task waited on
   *  and who cleared it, so the turn instruction names the entries and says
   *  the base branch has changed since the hold. */
  dependencyRelease?: DependencyReleasePayload;
  /** `scheduled` trigger: the note the human wrote when they set the re-run
   *  ("re-check the flaky test"). It is the REASON the run exists, so it rides
   *  into the turn instruction — a scheduled run that arrives as a bare
   *  "manual" trigger cannot honor the reason it was scheduled for (B-WF3). */
  scheduleNote?: string;
  /** `scheduled` trigger, ruling 487: the operator set this re-run itself, so
   *  the turn must not say a human did. Set by the schedule runner only. */
  scheduledByOperator?: boolean;
  /** `relayed` trigger, ruling 488: the task the text came from, who sent it,
   *  the text and its comment's stamp here. It exists nowhere else in the
   *  run's input, so the lease queue keeps it in arrival order. */
  relay?: RelayPayload;
  /** Depth of the react re-invocation chain (bounds the prompt↔react loop). */
  reactDepth?: number;
  /** Ruling 489(d): react hops since a person last acted (bounded by
   *  OPERATOR_REACT_HOP_CEILING in task-action-core). Set by the agent-reply react
   *  and carried by the drive's own follow-ups (the `delivered` follow-up, the
   *  stranded resume); every trigger a person causes omits it, which is what
   *  restarts the count. */
  reactHops?: number;
  /** Depth of the CONSECUTIVE operator-authored transition chain (bounds the
   *  transition→re-trigger loop, the same idiom as reactDepth — see
   *  OPERATOR_TRANSITION_CHAIN_CAP in task-action-core). Omitted by every human /
   *  agent-reply trigger, which is what resets the chain. */
  transitionDepth?: number;
  /** True when THIS drive was fired by the stranded-coordination resume
   *  (`maybeResumeStrandedOperator`). Exactly one nudge per settle: a drive
   *  that was itself a stranded resume and still ends stranded is a
   *  DELIBERATE HOLD — the settle records the hold and stops instead of
   *  resuming again. Without this, a goal that directs holding an `auto`
   *  stage ("do nothing yet") looped paid operator drives back-to-back until
   *  the chain cap, and every later trigger re-armed a fresh burst (F31-11:
   *  fourteen drives on a no-op task). The turn instruction also reads it, so
   *  the nudged drive is told to either advance or RECORD the hold. */
  strandedResume?: boolean;
  /** Ruling 228 (F37-47): this nudge exists because the previous drive's plan
   *  was refused in full, not because it left an auto stage idle. The two read
   *  differently to the operator and the turn instruction says which. */
  planRefusedNudge?: boolean;
  /** F39-69: this nudge exists because the previous drive refreshed the
   *  branch and stopped there, so its instruction names the refresh. */
  refreshNudge?: boolean;
  /** Ruling 400: the refusal sentences the previous drive collected, quoted
   *  into this retry's instruction so it never has to go and find them. */
  refusedPlanSteps?: { tool: string; message: string }[];
  /** transition trigger — what just moved (display names) and who moved it.
   *  `transitionByHuman` null = the operator's own move (continue the flow);
   *  a name = a human decided it, and the turn instruction tells the operator
   *  to honor their visible steer or ASK them why (owner ruling 2026-07-26). */
  transitionFromName?: string;
  transitionToName?: string;
  transitionByHuman?: string | null;
  /** A human's `@operator …` comment to address in this run (when a person
   *  talks to the operator directly). The operator reads it and responds. */
  humanComment?: string;
  /** The commenting human's display name (NEW-4) — the turn instruction tells
   *  the operator to tag them ("@Name") so its reply notifies them. */
  humanCommentBy?: string;
  /** agent-reply trigger: the finished agent's FULL report, straight from the
   *  run store — the react prompt embeds it so the operator's next directive
   *  never depends on the timeline comment having survived. */
  agentReply?: string;
  dataRoot?: string;
  actor?: AuditActor;
}

export interface RunOperatorResult {
  /**
   * The operator run this trigger reached: its OWN run when it started one,
   * the in-flight run it is queued behind when `queued` is true — and `null`
   * when it was queued behind a drive that has not created its run row yet.
   *
   * B10: that last case used to return the literal string `"queued"`, which
   * callers passed straight into run lookups (`resolveReplyLogThread`) as if
   * it were an id. Never invent an id here: `null` is the honest answer for
   * "this trigger reached no run", and `queued` says why.
   */
  runId: string | null;
  /** true when this trigger was QUEUED behind an in-flight drive instead of
   *  starting a run of its own. It fires when that drive releases the lease. */
  queued: boolean;
  backend: RealBackend;
  autonomy: OperatorAutonomy;
  /**
   * The trigger was REFUSED at fire time rather than driven. The caller owns the
   * honesty follow-up.
   *   `terminal-stage` (F19-20) — FR39's "a scheduled re-run never fires on a
   *     terminal stage", enforced where the run would actually start rather than
   *     only where it was scheduled (the schedule runner records the retirement).
   *   `open-packet` (R20-1 / F20-5) — a HUMAN pressed "Run operator" while a
   *     decision packet is open, which is a paid no-op (coordination is paused
   *     by the packet). Scoped to the `manual` trigger: machine triggers
   *     legitimately run with a packet open (a `pr-diverged` recovery withdraws
   *     a moot packet — ruling 17; `agent-reply` reacts to a run already in
   *     flight). The route turns this into "resolve the decision first".
   *   `blocked-by` (ruling 131(d), pass 34) — the task WAITS ON OTHER WORK
   *     (`blockedBy` is non-empty). The `create`, `transition` and `scheduled`
   *     triggers are refused at fire time: no run, no cost. Reactive triggers
   *     (an agent report, a human's question, a resolved packet, a goal edit, a
   *     PR change, a manual run) still drive, under the held doctrine. The
   *     refusal settles the task's waiting flag itself.
   */
  refused?: "closed" | "open-packet" | "blocked-by";
  /** Ruling 177: the sentence every door shows for a closed task (set with
   *  `refused: "closed"`). */
  refusalReason?: string;
}

/** The operator triggers a held task refuses (ruling 131(d)). */
const HELD_TRIGGERS: ReadonlySet<string> = new Set(["create", "transition", "scheduled"]);
/** Ruling 76 + ruling 141: the triggers an open decision packet refuses — a
 *  person pressing Run operator, and the same turn they scheduled. */
const PACKET_REFUSED_TRIGGERS: ReadonlySet<string> = new Set(["manual", "scheduled"]);

/**
 * Ruling 227 (F37-46): the triggers whose refusal AT THE DOOR is written on the
 * task, not only logged. Exactly one — `manual`.
 *
 * `manual` is a PERSON: a mention, or the Run operator button. A person who is
 * told nothing concludes their instruction was taken, and on SHOP-2 that is
 * what happened — a human's "@operator …and re-review" landed on the timeline with
 * the mention rendered as routed, the composer's own footer promising
 * "@mentions route to agents", and the refusal only in the server log.
 *
 * NOT `scheduled`, though ruling 141's reasoning covers it: the schedule runner
 * already notes and retires its own fire-time refusals
 * (`refusedTerminal`/`refusedHeld`/`refusedPacket` in `schedule.server.ts`), so
 * adding it here would write the same note twice. Its tests are the proof, and
 * they were the thing that caught the duplicate.
 *
 * Every other trigger is machine flow control (`create`, `transition`,
 * `delivered`, `agent-reply`, …). Those fire constantly and refuse routinely;
 * noting each would bury the one that means something under noise.
 */
const NOTED_DOOR_REFUSAL_TRIGGERS: ReadonlySet<string> = new Set(["manual"]);

/**
 * Wall-clock ms at which THIS process started. A run row created before it
 * cannot be driven from here: run handles and completion callbacks are
 * process-local (run-service), and every operator drive holds the process
 * lease from entry to completion — so a pre-boot row is a restart orphan, not
 * work in flight. Used by the cross-boot backstop below (B10).
 */
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

/** A queued/running operator run for the same task, if one is already in flight. */
function inFlightOperatorRun(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): { id: string; backend: RealBackend; restartOrphan: boolean } | null {
  // SAFETY: the SELECT names three `agent_runs` columns the baseline schema
  // declares TEXT NOT NULL (id, backend, created_at), so a returned row carries
  // exactly these three keys with string values. `backend` additionally carries
  // `CHECK (backend IN ('claude','codex'))`, which is what the narrowing below
  // relies on.
  const row = db
    .prepare(
      `SELECT id, backend, created_at FROM agent_runs
       WHERE project_slug = ? AND task_key = ? AND kind = 'operator'
         AND state IN ('queued', 'running')
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectSlug, taskKey) as
    | { id: string; backend: string; created_at: string }
    | undefined;
  if (!row) return null;
  const createdMs = Date.parse(row.created_at);
  return {
    id: row.id,
    backend: row.backend === "codex" ? "codex" : "claude",
    // A row this process never created has no handle and no callback behind
    // it: nothing will ever fire the completion a queued trigger chains onto.
    restartOrphan: Number.isFinite(createdMs) && createdMs < PROCESS_START_MS,
  };
}

// ------------------------------------------------------ single-flight lease

/** One live operator drive: the value the lease map holds, and the token every
 *  release for that drive hands back (see releaseOperatorLease). */
interface OperatorLeaseEntry {
  runId: string | null;
  backend: RealBackend;
  autonomy: OperatorAutonomy;
  /** Task ref carried for the waiting-flag settle on release. */
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  /** This drive's transition-chain depth — the stranded-coordination
   *  resume (settle-time) threads depth+1 so the backstop chain shares
   *  OPERATOR_TRANSITION_CHAIN_CAP with the transition re-trigger. */
  transitionDepth: number;
  /** The task's stage when this drive started. A drive that MOVED the
   *  stage is never "stranded" — the transition's own re-trigger owns the
   *  follow-up (it is fire-and-forget async, so at settle time it may not
   *  have reached the queue yet; resuming here would double-drive). */
  stageAtStart: string | null;
  /** True when this drive WAS the stranded resume's one nudge — its settle
   *  must record a deliberate hold instead of nudging again (see
   *  RunOperatorInput.strandedResume). */
  strandedResume: boolean;
  /** Ruling 152(a): the drive's own `ctx.operatorRun` state (the same object),
   *  so the settle can read `movedToStageId`: a transition THIS drive made
   *  queues no re-trigger any more, and the stranded backstop must judge the
   *  stage the drive left the task at. Null for refs that never drove. */
  ownRun: OwnOperatorRun | null;
}

/** The mutable per-drive operator state a lease entry shares with its ctx. */
type OwnOperatorRun = NonNullable<TaskMutationContext["operatorRun"]>;

/**
 * Process-level operator lease + trigger queue.
 *
 * The agent_runs row alone under-covers the lease: the SCRIPTED drive
 * coordinates before its row exists, and the CODEX plan executes after its row
 * is already `finished` — in both windows a concurrent trigger used to
 * double-drive (double assignment, double prompts). Worse, a coalesced trigger
 * was simply DROPPED: a human's "@operator …" landing while a run was in
 * flight was never answered.
 *
 * The lease is held from runOperator entry through provider completion and,
 * for Codex, structured-plan execution.
 * A trigger arriving while held is QUEUED and fired exactly once on release.
 * Coalescing is per KIND: a machine trigger (create/transition/agent-reply/…)
 * is newest-wins — the operator re-reads the full task anyway, so the latest
 * one subsumes older ones — but a human `@operator …` comment carries a
 * question that exists NOWHERE else in the run's input, so human triggers are
 * kept in a queue and drained oldest-first ahead of the machine trigger
 * (B-OP2: a transition landing behind a queued question used to overwrite it,
 * and the person was never answered). Consecutive comments from the SAME
 * author merge into one queued turn (see queueOperatorTrigger) — one person's
 * three-message burst is one question, not three governed drives.
 */
interface OperatorLeaseState {
  held: Map<string, OperatorLeaseEntry>;
  pending: Map<string, PendingTriggers>;
}

const LEASE_KEY = Symbol.for("viberr.operatorLease");

/** The process-global slot the lease lives in — a well-known symbol, so a
 *  dev-server HMR reload of this module keeps the same single-flight state. */
interface LeaseStateHost {
  [LEASE_KEY]?: OperatorLeaseState;
}

function leaseState(): OperatorLeaseState {
  // SAFETY: `LEASE_KEY` is a registry symbol under a viberr-namespaced key that
  // only this module reads or writes, so the slot holds either the state this
  // function put there or nothing at all.
  const cache = globalThis as LeaseStateHost;
  let state = cache[LEASE_KEY];
  if (!state) {
    state = { held: new Map(), pending: new Map() };
    cache[LEASE_KEY] = state;
  }
  return state;
}

function leaseKeyFor(projectSlug: string, taskKey: string): string {
  return `${projectSlug}/${taskKey}`;
}

/** One task's queued triggers (see the lease doc above for the coalescing
 *  rule). */
interface PendingTriggers {
  /** The newest queued newest-wins MACHINE trigger, or null. Never a
   *  `scheduled` one — those go in `carried`. */
  latest: RunOperatorInput | null;
  /** Queued triggers carrying a reason that exists NOWHERE else in the run's
   *  input: human `@operator …` comments, `scheduled` re-checks and relays
   *  from another task (ruling 488). Oldest first. */
  carried: RunOperatorInput[];
}

/** Bound on queued reason-carrying triggers per task. Beyond this the OLDEST
 *  are dropped: the newest are the ones still awaiting an answer, and every
 *  dropped one still sits on the timeline the next drive reads. */
const MAX_PENDING_CARRIED_TRIGGERS = 8;

/**
 * Queue a trigger that arrived while the lease was held.
 *
 * Consecutive comments from the SAME person become ONE queued turn. Every
 * queued question is a full governed turn — a run, a set of governed actions,
 * and possibly a decision packet (which the open-packet guard now refuses
 * while another stands, so a queued burst can no longer strand the human
 * mid-answer) — so someone typing three messages in a row must cost one turn,
 * not three. Different authors are never merged: each is owed their own answer, in
 * arrival order.
 */
function queueOperatorTrigger(
  key: string,
  input: RunOperatorInput,
): RunOperatorInput[] {
  const state = leaseState();
  const queue = state.pending.get(key) ?? { latest: null, carried: [] };
  const dropped: RunOperatorInput[] = [];
  // A `scheduled` re-check carries a note the human wrote for THIS occurrence,
  // and the schedule runner stamps that occurrence `fired` the moment the
  // trigger is queued — so an overwritten one is a run FR39 promised, recorded
  // as delivered, that never happens. Like a human question, it is kept in
  // arrival order rather than replaced by the next machine trigger.
  const comment = input.humanComment?.trim();
  // Ruling 488: a relay carries another task's text, which the newest machine
  // trigger would otherwise overwrite before any turn read it.
  if (comment || input.trigger === "scheduled" || input.relay) {
    const previous = queue.carried[queue.carried.length - 1];
    const by = input.humanCommentBy?.trim();
    // Merging is a HUMAN-comment rule (one person typing three messages costs
    // one turn). A scheduled re-check has its own occurrence and its own note,
    // so it is never folded into a neighbour.
    if (comment && by && previous && previous.humanCommentBy?.trim() === by) {
      queue.carried[queue.carried.length - 1] = {
        ...input,
        humanComment: `${previous.humanComment?.trim()}\n\n${comment}`,
      };
      state.pending.set(key, queue);
      return dropped;
    }
    queue.carried.push(input);
    while (queue.carried.length > MAX_PENDING_CARRIED_TRIGGERS) {
      const drop = queue.carried.shift();
      if (drop) dropped.push(drop);
      logger.warn("dropping the oldest queued reason-carrying trigger: queue is full", {
        key,
        trigger: drop?.trigger ?? "manual",
        by: drop?.humanCommentBy ?? "unknown",
        cap: MAX_PENDING_CARRIED_TRIGGERS,
      });
    }
  } else {
    // Newest-wins for machine triggers, but two accounting fields must SURVIVE
    // the overwrite (V13): `strandedResume` marks the one paid nudge per
    // settle — losing it to a later trigger un-marks the eventual drive, so a
    // second stranding re-arms another nudge instead of recording the hold —
    // and `transitionDepth` bounds the transition chain, so the deeper count
    // wins or the cap resets mid-chain.
    const prior = queue.latest;
    queue.latest = input;
    if (prior?.strandedResume && input.strandedResume !== true) {
      queue.latest = { ...input, strandedResume: true };
    }
    const priorDepth = prior?.transitionDepth ?? 0;
    if (priorDepth > (input.transitionDepth ?? 0)) {
      queue.latest = { ...queue.latest, transitionDepth: priorDepth };
    }
    // Ruling 489(d): the same for the react hop count, but only between two
    // triggers of the chain itself (each carries a count). A trigger a person
    // caused carries none, and it restarts the count by overwriting.
    const priorHops = prior?.reactHops ?? 0;
    if (input.reactHops !== undefined && priorHops > input.reactHops) {
      queue.latest = { ...queue.latest, reactHops: priorHops };
    }
  }
  state.pending.set(key, queue);
  // C2 (pass 23): the caller surfaces these on the timeline — the module's own
  // doc promises "no trigger is ever silently dropped", and a warn is not that.
  return dropped;
}

/**
 * C2 (pass 23): the queue of pending @operator turns overflowed, so an earlier
 * turn was dropped. The comment itself stays on the timeline (a later drive may
 * still read it), but its DEDICATED turn is gone — say so, so a human whose
 * question fell off the back of the queue is not left waiting for an answer that
 * will never come as its own turn. Best-effort: never blocks queueing.
 */
async function noteDroppedOperatorTurn(
  db: DatabaseSync,
  dropped: RunOperatorInput,
): Promise<void> {
  const ref: TaskFileRef = {
    projectSlug: dropped.projectSlug,
    taskKey: dropped.taskKey,
  };
  if (dropped.dataRoot) ref.dataRoot = dropped.dataRoot;
  const who = dropped.humanCommentBy?.trim() || "someone";
  // The copy is kind-specific: a human comment stays on the timeline to re-send,
  // but a dropped SCHEDULED occurrence has no comment there (its note is carried
  // precisely because it exists nowhere else), and it was already stamped
  // `fired` — so telling a human it "stays on the timeline" would be false.
  const text =
    dropped.trigger === "scheduled"
      ? "The pending @operator queue was full, so a scheduled operator re-check did not get its turn. Run the operator manually, or wait for the next scheduled occurrence, if it still needs attention."
      : dropped.relay
        ? `The pending @operator queue was full, so the relay from ${dropped.relay.fromTaskKey} did not get its own operator turn. It stays on the timeline for the operator to read; run the operator if it needs acting on now.`
        : `The pending @operator queue was full, so ${who}'s earlier comment did not get its own operator turn. It stays on the timeline for the operator to read, but re-send it if it needs a dedicated answer.`;
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "operator" },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, { dataRoot: dropped.dataRoot }, dropped.projectSlug, dropped.taskKey);
  } catch (error) {
    logger.error("could not note a dropped @operator turn", {
      taskKey: dropped.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Take the next queued trigger: human questions first (oldest first), then the
 * newest machine trigger. One per release — the fired drive takes the lease and
 * drains the rest on its own release, so the order is preserved and no two
 * drives overlap.
 */
function takePendingTrigger(key: string): RunOperatorInput | null {
  const state = leaseState();
  const queue = state.pending.get(key);
  if (!queue) return null;
  let next: RunOperatorInput | null = null;
  if (queue.carried.length > 0) {
    next = queue.carried.shift() ?? null;
  } else if (queue.latest) {
    next = queue.latest;
    queue.latest = null;
  }
  if (queue.carried.length === 0 && !queue.latest) state.pending.delete(key);
  return next;
}

/**
 * Ruling 357 (pass 38, F38-11): the `delivered` follow-up a drive's OWN
 * delivery owes, judged at its lease release. A delivery made inside a drive
 * used to queue a `delivered` turn behind that drive's own lease at once;
 * 140 of 148 such drives then moved the task or dispatched the reviewer
 * themselves, and the queued turn read `get_task`, said the reviewer was
 * already in flight, and cost ~$0.15 and the coordination lane for ~15 s. The
 * other 8 stopped right after delivering, and the follow-up was what moved
 * them. So: owed when the drive delivered (`deliveredHeadMoved`) and neither
 * moved nor dispatched afterwards (`actedAfterDelivery`); nothing otherwise.
 * The depth threads on as `nextTransitionChainDepth` would have.
 */
export function deliveredFollowUpFor(entry: {
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  transitionDepth: number;
  ownRun: OwnOperatorRun | null;
}): RunOperatorInput | null {
  const own = entry.ownRun;
  if (!own?.deliveredHeadMoved || own.actedAfterDelivery) return null;
  const input: RunOperatorInput = {
    projectSlug: entry.projectSlug,
    taskKey: entry.taskKey,
    trigger: "delivered",
    transitionDepth: entry.transitionDepth + 1,
  };
  if (entry.dataRoot) input.dataRoot = entry.dataRoot;
  // Ruling 489(d): the drive's own follow-up continues its chain's hop count.
  if (own.reactHops) input.reactHops = own.reactHops;
  return input;
}

/** Ruling 357 tests: the live drive's own-run stamps, by task. */
export function ownOperatorRunForTests(projectSlug: string, taskKey: string): OwnOperatorRun | null {
  return leaseState().held.get(leaseKeyFor(projectSlug, taskKey))?.ownRun ?? null;
}

/**
 * Release the task's lease and fire the newest queued trigger, if any.
 * IDEMPOTENT per acquisition (adversarial-review #5/#7): `token` is the exact
 * lease-entry object captured when this drive acquired the lease. We only
 * delete/queue-fire when the currently-held entry IS that token — so a
 * second or late release can never evict a successor's freshly-acquired lease or
 * double-fire the queued run. A release whose token no longer matches is a
 * no-op.
 */
function releaseOperatorLease(
  db: DatabaseSync,
  key: string,
  token?: OperatorLeaseEntry,
): void {
  const state = leaseState();
  const current = state.held.get(key);
  if (token !== undefined && current !== token) return; // stale release — ignore
  state.held.delete(key);
  // Ruling 357: a drive that delivered and then stopped is owed the
  // `delivered` follow-up its delivery used to queue at once; a drive that
  // kept going is owed nothing. The follow-up fills the machine slot only when
  // that slot is empty, so a queued human question still goes first and a
  // later machine trigger still wins.
  const followUp = current ? deliveredFollowUpFor(current) : null;
  if (followUp) {
    if (!state.pending.get(key)?.latest) queueOperatorTrigger(key, followUp);
  } else if (current?.ownRun?.deliveredHeadMoved) {
    logger.info("drive delivered and kept going; no follow-up operator turn owed", {
      key,
      runId: current.runId,
    });
  }
  const queued = takePendingTrigger(key);
  if (!queued) {
    // Last drive for now: flip `waiting: agent` back to human once nothing is
    // live on the task (runOperator set it at drive start; a specialist the
    // operator prompted keeps its own completion-chain flip — the live check
    // stays out of its way).
    settleWaitingAfterOperator(db, current ?? leaseRefFromKey(key));
    return;
  }
  logger.info("operator lease released; firing the queued trigger", {
    key,
    trigger: queued.trigger ?? "manual",
    queuedCarriedTriggers: leaseState().pending.get(key)?.carried.length ?? 0,
  });
  void runOperator(db, queued)
    .then((result) =>
      result.refused ? noteQueuedTriggerRefused(db, queued, result.refused) : undefined,
    )
    .catch((error) => noteQueuedTriggerFireFailed(db, queued, toError(error)));
}

/** Drain the pending trigger after a CROSS-BOOT in-flight run finishes (a DB
 *  row with no process lease, e.g. resumed after a restart). Unlike
 *  releaseOperatorLease, this NEVER deletes a held lease — a token-less release
 *  there would evict a live successor drive that acquired the lease in the
 *  meantime and fire the queued trigger anyway, double-driving the task (AO-2).
 *  If a successor now holds the lease, it will drain the pending queue on its
 *  own release, so this is a no-op. */
function drainPendingAfterInFlight(db: DatabaseSync, key: string): void {
  const state = leaseState();
  if (state.held.has(key)) return; // a live successor owns the lease — leave it.
  const queued = takePendingTrigger(key);
  if (!queued) {
    settleWaitingAfterOperator(db, leaseRefFromKey(key));
    return;
  }
  logger.info("cross-boot in-flight finished; firing the queued trigger", {
    key,
    trigger: queued.trigger ?? "manual",
    queuedCarriedTriggers: state.pending.get(key)?.carried.length ?? 0,
  });
  void runOperator(db, queued)
    .then((result) =>
      result.refused ? noteQueuedTriggerRefused(db, queued, result.refused) : undefined,
    )
    .catch((error) => noteQueuedTriggerFireFailed(db, queued, toError(error)));
}

/** Recover the task ref from a lease key (slugs are kebab-case — the first
 *  "/" is the separator). Fallback for releases with no held entry. */
function leaseRefFromKey(key: string) {
  const i = key.indexOf("/");
  return { projectSlug: key.slice(0, i), taskKey: key.slice(i + 1) };
}

/**
 * Ruling 141 (pass 34, F34-8): a queued trigger that is REFUSED when it reaches
 * the front of the lease queue says so on the task — the refusal used to exist
 * only in the server log while the timeline still said "Scheduled action
 * starting". Mirrors {@link noteQueuedTriggerFireFailed} but SETTLES NOTHING:
 * an open packet owns `waiting: "human"`, and the terminal-stage refusal
 * already settled inside `runOperator`. When the trigger carries a schedule
 * occurrence (`scheduleId`) the occurrence is retired the same way the schedule
 * runner retires a fire-time refusal (`fired`, `claimedAt: null`) and the final
 * `task.schedule.fired` row records the outcome. A `blocked-by` refusal is
 * noted only for a schedule occurrence: a drained transition on a held task is
 * the ruling-131 hold itself, already on the record.
 */
async function noteQueuedTriggerRefused(
  db: DatabaseSync,
  queued: RunOperatorInput,
  refused: NonNullable<RunOperatorResult["refused"]>,
  /**
   * Ruling 227 (F37-46): WHERE the refusal happened. Ruling 141 taught the
   * refusal to speak when a trigger met it at the front of the lease queue, and
   * left the three refusals at the DOOR silent — so a person who wrote
   * "@operator do X" on a task with an open packet got a comment on the
   * timeline, an accepted-looking mention, and nobody coming, with the refusal
   * only in the server log. Live on SHOP-2 at 02:44. Same note, same reasons;
   * only the sentence about how the trigger arrived differs.
   */
  arrival: "queue" | "door" = "queue",
): Promise<void> {
  // At the door a `manual` trigger is a PERSON who just typed something and is
  // owed an answer, so the blocked-by silence (a drained transition on a held
  // task is the ruling-131 hold itself, already on the record) does not apply
  // to it.
  const owedAnyway = arrival === "door" && (queued.trigger ?? "manual") === "manual";
  if (refused === "blocked-by" && !queued.scheduleId && !owedAnyway) return;
  logger.info(
    arrival === "door"
      ? "operator trigger refused at the door; noting it on the task"
      : "queued operator trigger refused at the front of the lease queue",
    {
      key: `${queued.projectSlug}/${queued.taskKey}`,
      trigger: queued.trigger ?? "manual",
      refused,
    },
  );
  const ref = {
    projectSlug: queued.projectSlug,
    taskKey: queued.taskKey,
    dataRoot: queued.dataRoot,
  };
  const outcome =
    refused === "open-packet"
      ? "skipped-packet"
      : refused === "closed"
        ? "skipped-done"
        : "skipped-held";
  try {
    await updateTaskFile(ref, (parsed) => {
      const packetTitle = parsed.packet?.title ?? null;
      const cause =
        refused === "open-packet"
          ? `a decision packet is open on ${queued.taskKey}${packetTitle ? ` ("${packetTitle}")` : ""} and coordination is paused until it is resolved`
          : refused === "closed"
            ? `${queued.taskKey} is closed (${parsed.frontmatter.archived ? "archived" : "at its terminal stage"})`
            : // Ruling 356: a done entry reads as done, not as still waited on.
              `${queued.taskKey} waits on other work (${holdEntriesSentence(resolveDependencies(db, queued.projectSlug, parsed.frontmatter.blockedBy))})`;
      const arrived =
        arrival === "door" ? "" : " when it reached the front of the queue";
      const text = queued.scheduleId
        ? `**Scheduled action skipped:** the scheduled operator re-run for ${queued.taskKey} ` +
          `${arrival === "door" ? "came due" : "reached the front of the queue"}, but ${cause}; ` +
          `no run was started, and the occurrence spends no retry.`
        : `An @operator turn was refused${arrived}: ${cause}; no run was started, so nothing ` +
          `on this task has been acted on. Resolve it, then run the operator again.`;
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        // Ruling 227: a door refusal never touched the lease queue, so
        // attributing it to the lease would be a small lie in the one column
        // a reader uses to tell viberr's mechanisms apart. `policy-engine` is
        // the actor viberr's own rules already write under.
        actor: {
          kind: "system",
          systemId: arrival === "door" ? "policy-engine" : "operator-lease",
        },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
      if (queued.scheduleId) {
        const target = parsed.frontmatter.schedules.find((x) => x.id === queued.scheduleId);
        if (target && (target.status === "claimed" || target.status === "fired")) {
          target.status = "fired";
          target.firedAt = target.firedAt ?? new Date().toISOString();
          target.claimedAt = null;
        }
      }
    });
    reprojectTask(db, { dataRoot: ref.dataRoot }, ref.projectSlug, ref.taskKey);
    if (queued.scheduleId) {
      recordAudit(db, {
        action: "task.schedule.fired",
        actor: { userId: null, label: "system:schedule-runner" },
        subjectKind: "task",
        subjectId: queued.taskKey,
        projectSlug: queued.projectSlug,
        taskKey: queued.taskKey,
        details: { scheduleId: queued.scheduleId, outcome, refusedAtStart: true, atDrain: true },
      });
    }
  } catch (noteErr) {
    logger.error("could not note the refused queued operator trigger", {
      key: `${queued.projectSlug}/${queued.taskKey}`,
      err: toError(noteErr),
    });
  }
}

/**
 * C2 (pass-24 fix): a queued @operator turn that FAILS at fire time must not
 * vanish into the log. The pass-23 C2 work surfaced only the cap-overflow drop
 * (`MAX_PENDING_CARRIED_TRIGGERS`); a fired trigger that THROWS left the comment
 * recorded but never coordinated, and — because a queued trigger existed —
 * `settleWaitingAfterOperator` was skipped, so the task stayed "waiting for agent"
 * with nothing live. Note it on the timeline and settle the waiting flag so the
 * board stops lying and the human can run the operator manually.
 */
async function noteQueuedTriggerFireFailed(
  db: DatabaseSync,
  queued: RunOperatorInput,
  error: Error,
): Promise<void> {
  logger.error("queued operator trigger failed", {
    key: `${queued.projectSlug}/${queued.taskKey}`,
    err: error,
  });
  const ref = {
    projectSlug: queued.projectSlug,
    taskKey: queued.taskKey,
    dataRoot: queued.dataRoot,
  };
  try {
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "note",
      actor: { kind: "system", systemId: "operator-lease" },
      title: null,
      text: "A queued @operator turn could not be started, so it was not coordinated. Your comment is still on the timeline; run the operator manually to continue.",
      toAgent: false,
      evidence: null,
    });
    reprojectTask(db, { dataRoot: ref.dataRoot }, ref.projectSlug, ref.taskKey);
  } catch (noteErr) {
    logger.error("could not note queued operator trigger failure", {
      key: `${queued.projectSlug}/${queued.taskKey}`,
      err: toError(noteErr),
    });
  }
  settleWaitingAfterOperator(db, ref);
}

/**
 * A finished operator drive left the task STRANDED when the stage's own
 * contract says no human input is due: an `auto` outbound boundary, no open
 * packet, no pending recommendation, not archived. Live-caught shape: the
 * create-run drafted the goal, declared "the next invocation will handle the
 * Triage → Ready transition", and stopped — but nothing re-invokes the
 * operator for its own `set_goal`, so the task sat at an auto stage labeled
 * "waiting on a human" with nothing for the human to decide.
 *
 * Ruling 152(a) (pass 35, G35-5): `ownMoveLandedHere` widens the LAST test,
 * never the guards above it. Since the drive's own transitions queue no
 * re-trigger, a stage the drive itself moved the task onto is a stage nothing
 * else will follow up on — and on the shipped board of the time the operator's
 * own move landed on In Progress, whose outbound boundary was `approval` (it
 * still is on a strict board; ruling 519 made it `auto` on the Standard
 * template), so the `auto` test alone left every such move with no follow-up
 * at all: no re-trigger, no resume, and `clearWaitingToHuman` flipped the
 * board to "waiting on you" with no agent engaged and no packet.
 */
export function operatorLeftTaskStranded(
  task: {
    archived: boolean;
    stage: string;
    packet: unknown;
    recommendations: readonly unknown[];
    /** Ruling 131(d): a non-empty `blockedBy` is a RECORDED hold. */
    blockedBy: readonly unknown[];
    /** Ruling 487: a pending schedule is a RECORDED wait with its time on it.
     *  Optional so the stage-only call sites in tests stay readable. */
    schedules?: readonly { status: string }[];
  },
  workflow: readonly { from: string; to: string; boundary: string }[],
  /** The finished drive's OWN last transition landed the task on this stage. */
  ownMoveLandedHere = false,
  /**
   * Ruling 228 (F37-47): every step the drive planned was refused, so it did
   * nothing. Stranded regardless of the outbound boundary — the boundary test
   * below asks "is something expected to happen here without a human?", which
   * is the right question for a drive that CHOSE to stop and the wrong one for
   * a drive that was stopped. SHOP-3 sat at Verify (boundary `human`) after a
   * wholly refused plan and this backstop could not see it.
   */
  planWhollyRefused = false,
  /**
   * F39-69: the drive carried out a base refresh and then stopped, which is
   * half a step whatever the stage's boundary. The caller passes it only for
   * a drive that was not itself the nudge, so it re-arms nothing.
   */
  refreshedAndStopped = false,
): boolean {
  if (task.archived) return false;
  if (task.packet) return false; // a decision IS pending — the human's move
  if (task.recommendations.length > 0) return false; // ditto
  // Ruling 131(d): a task waiting on other work is holding on purpose; the
  // paid nudge would only rediscover the wait (JC-9: five runs, no dispatch).
  if (task.blockedBy.length > 0) return false;
  // Ruling 487 (F40-65): so is a task holding on a pending schedule. Something
  // WILL move it, at a time on the record, which is the reason for quiet the
  // stranded sweep already honours (ruling 330). Nudging it anyway asked the
  // operator to "record the hold", and live on WEB-9 it did so with a packet
  // whose own body said it existed only so the stage was not left idle.
  if ((task.schedules ?? []).some((s) => s.status === "pending")) return false;
  if (ownMoveLandedHere) return true;
  if (planWhollyRefused) return true;
  if (refreshedAndStopped) return true;
  return workflow.some((w) => w.from === task.stage && w.boundary === "auto");
}

/**
 * Settle-time backstop for the stranded shape above: re-invoke the operator
 * (its own turn instruction already says "advance the boundary") instead of
 * stamping "waiting on human". Bounded by OPERATOR_TRANSITION_CHAIN_CAP via
 * the same transitionDepth the transition re-trigger uses; only a run that
 * FINISHED cleanly resumes — an errored drive must not loop. Returns true
 * when a resume was fired (the caller then skips the waiting flip).
 */
export async function maybeResumeStrandedOperator(
  db: DatabaseSync,
  ref: {
    projectSlug: string;
    taskKey: string;
    dataRoot?: string;
    runId?: string | null;
    transitionDepth?: number;
    stageAtStart?: string | null;
    strandedResume?: boolean;
    ownRun?: OwnOperatorRun | null;
  },
): Promise<boolean> {
  // Only a ref that knows the drive's STARTING stage resumes — the live lease
  // and the stranded-plan recovery, which reads it before executing (B-OP3).
  // Key-derived fallback refs (a cross-boot drain, where the finished run's
  // starting stage is unknowable) stay conservative: reading the stage there
  // would read it AFTER the move and resume on top of the transition's own
  // re-trigger.
  if (ref.stageAtStart === undefined) return false;
  // B6: `null` is NOT "not applicable" — it means a drive that SHOULD have
  // known its starting stage failed to read the task file, which switches this
  // backstop off for that whole drive. It used to do so in complete silence,
  // so a task left idle at an `auto` stage looked like a model decision
  // instead of a failed file read. Say so.
  if (ref.stageAtStart === null) {
    logger.warn(
      "stranded-operator backstop DISABLED for this drive: its starting stage was never read",
      { projectSlug: ref.projectSlug, taskKey: ref.taskKey, runId: ref.runId ?? null },
    );
    return false;
  }
  // A ref with no run id belongs to a drive that never produced a row —
  // `startRun` threw, and the lease was released with the token's `runId`
  // still null. Falling back to "the newest operator run for this task" judged
  // THIS drive by a PREVIOUS one, which is usually `finished`, so the guard
  // above ("only a run that FINISHED cleanly resumes") passed and the backstop
  // fired an unwatched resume chain for a drive that never ran. Same posture
  // as an unknown starting stage: a ref that cannot name its own drive does
  // not get to judge it.
  if (!ref.runId) {
    logger.warn(
      "stranded-operator backstop skipped: this drive produced no run row to judge",
      { projectSlug: ref.projectSlug, taskKey: ref.taskKey },
    );
    return false;
  }
  // SAFETY: the statement SELECTs one column, `agent_runs.state`, which the
  // baseline schema declares TEXT NOT NULL — so a returned row is exactly
  // `{ state: string }`, and no matching row at all is `undefined`.
  const stateRow = db
    .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
    .get(ref.runId) as { state: string } | undefined;
  if (stateRow?.state !== "finished") return false;

  const file = readTaskFile({
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    dataRoot: ref.dataRoot,
  });
  const project = readProjectFile({
    projectSlug: ref.projectSlug,
    dataRoot: ref.dataRoot,
  });
  if (!file || !project) return false;
  // Someone ELSE moved the stage during the drive → their transition
  // re-trigger owns the follow-up. That re-trigger is fire-and-forget async
  // and may not have reached the lease queue yet, so resuming here would
  // double-drive the task (observed: the displaced re-trigger then queued
  // behind the resume's run and re-fired after a packet was already open).
  // Ruling 152(a): the drive's OWN moves queue no re-trigger any more, so the
  // stage its last transition landed on (`movedToStageId`) is the stage to
  // judge: a chain the model abandons at an `auto` stage gets the one nudge.
  const stageLeftAt = ref.ownRun?.movedToStageId ?? ref.stageAtStart;
  if (file.parsed.frontmatter.stage !== stageLeftAt) return false;
  const autoStage = project.parsed.frontmatter.workflow.some(
    (w) => w.from === file.parsed.frontmatter.stage && w.boundary === "auto",
  );
  // F39-69: a drive that refreshed and stopped. Never the nudge itself: the
  // nudge that refreshes again and stops has had its one automatic resume.
  // A drive that DELIVERED after its refresh took the step the refresh
  // prepared, and REFRESH_ENDED_NUDGE would tell it that it had not.
  const refreshedAndStopped =
    ref.ownRun?.refreshed === true &&
    ref.ownRun.delivered !== true &&
    ref.strandedResume !== true;
  const stranded = operatorLeftTaskStranded(
    {
      archived: file.parsed.frontmatter.archived,
      stage: file.parsed.frontmatter.stage,
      packet: file.parsed.packet,
      recommendations: file.parsed.frontmatter.recommendations,
      blockedBy: file.parsed.frontmatter.blockedBy,
      schedules: file.parsed.frontmatter.schedules,
    },
    project.parsed.frontmatter.workflow,
    // The drive MOVED the task here and then stopped: nothing else follows up
    // on its own move any more, whatever the new stage's outbound boundary is.
    ref.ownRun?.movedToStageId !== undefined &&
      ref.ownRun.movedToStageId === file.parsed.frontmatter.stage,
    // Ruling 228: or it planned only steps it was not allowed to take.
    ref.ownRun?.planWhollyRefused === true,
    refreshedAndStopped,
  );
  if (!stranded) return false;

  // V18: a DURABLE hold already stands for this exact stage — recorded by an
  // earlier settle (below) and not yet re-litigated by a human (transitions,
  // packet resolutions and goal edits all clear it).
  // Without this read, the marker's whole point is lost: every external
  // trigger (a schedule firing hourly, an @operator aside) started an unmarked
  // drive, the backstop paid ONE fresh nudge, and the second stranding
  // appended a byte-identical hold note — two drives and a duplicate note per
  // trigger, forever. Quiet is correct here: the hold is already on the
  // timeline.
  if (
    file.parsed.frontmatter.heldAtStage !== null &&
    file.parsed.frontmatter.heldAtStage === file.parsed.frontmatter.stage
  ) {
    logger.info("stranded-operator resume withheld: a recorded hold stands for this stage", {
      taskKey: ref.taskKey,
      stage: file.parsed.frontmatter.stage,
    });
    return false;
  }

  // One nudge per settle (F31-11). THIS drive already was the stranded
  // resume's nudge, its turn instruction said "advance or RECORD the hold" —
  // and it ended stranded anyway. That is a deliberate hold, not an
  // interrupted chain: record it once — durably, via `heldAtStage`, so later
  // external triggers find it above instead of re-arming a nudge — and settle
  // to human instead of looping paid drives until the chain cap (which only
  // pauses the burst — the next trigger re-armed it, fourteen drives on one
  // no-op task).
  // Ruling 152(a): a nudged drive that MOVED the task and then stopped at the
  // next `auto` stage made progress; its transition queued no re-trigger any
  // more, so the chain continues with a fresh nudge, bounded by the chain cap
  // below. Only a nudge that ends where it started is the deliberate hold.
  // Ruling 202 (F37-22): DELIVERY is progress too. The three other ways a drive
  // can act are already covered — a transition by `movedToStageId`, a dispatch
  // by the live-run check in `settleWaitingAfterOperator`, a packet or a
  // recommendation by `operatorLeftTaskStranded` — and delivery was covered by
  // nothing, so a drive that pushed a branch and opened a review PR was
  // recorded as having "held the stage without advancing, dispatching, or
  // opening a packet" and coordination was declared paused on a task that was
  // being delivered.
  // Ruling 406: and ANY action it carried out is progress. The three clauses
  // above are effects Viberr thought to enumerate; this one is the fact.
  const nudgeMadeProgress =
    (ref.ownRun?.movedToStageId !== undefined &&
      ref.ownRun.movedToStageId !== ref.stageAtStart) ||
    ref.ownRun?.delivered === true ||
    ref.ownRun?.carriedOutAction === true;
  if (ref.strandedResume && !nudgeMadeProgress) {
    // Ruling 399: the same fact the stranded predicate already consulted.
    const planRefused = ref.ownRun?.planWhollyRefused === true;
    await updateTaskFile(
      { projectSlug: ref.projectSlug, taskKey: ref.taskKey, dataRoot: ref.dataRoot },
      (parsed) => {
        parsed.frontmatter.heldAtStage = parsed.frontmatter.stage;
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: { kind: "system", systemId: "policy-engine" },
          title: null,
          text: planRefused
            ? // Ruling 399 (F39-26): the operator did not choose anything here.
              // Every action it planned was REFUSED, twice — which Viberr knows
              // in this exact scope (`planWhollyRefused`, read eleven lines
              // above to decide the task was stranded at all) and which the
              // refusal notes say in their own words, directly above this one.
              // Calling that a deliberate hold is a sentence contradicting a
              // fact the same function is holding, and the remedy it offered
              // — run the operator again — is the one move that reproduces it:
              // the operator was already re-invoked once and told what was
              // wrong, and planned the refused step again anyway.
              "**Note:** the operator did not hold this stage; it was stopped. " +
              "Every action it planned was refused, on its first run and again on " +
              "the one automatic retry, so nothing it decided was carried out. The " +
              "refusal notes are directly above and each names what was wrong with " +
              "the step. Coordination is paused because a fresh operator run plans " +
              "against the same state and is refused the same way: do the thing a " +
              "refusal names, change what made the step impossible, or take the " +
              "action yourself."
            : (autoStage
                ? "**Note:** this stage auto-advances, but the operator held it twice in a row without advancing, dispatching, or opening a packet, so this is treated as a deliberate hold. "
                : "**Note:** the operator moved the task to this stage and then held it twice in a row without dispatching or opening a packet, so this is treated as a deliberate hold. ") +
              "Coordination is paused here: run the operator manually when the hold should end, adjust the goal, or loosen the boundary in Policy → Workflow rules.",
          toAgent: false,
          evidence: null,
        });
      },
    );
    reprojectTask(db, { dataRoot: ref.dataRoot }, ref.projectSlug, ref.taskKey);
    logger.info("stranded-operator resume withheld: the nudged drive held the stage again", {
      taskKey: ref.taskKey,
      stage: file.parsed.frontmatter.stage,
    });
    return false;
  }

  const depth = (ref.transitionDepth ?? 0) + 1;
  // B4: the SAME comparison the transition re-trigger makes
  // (`chainDepth >= OPERATOR_TRANSITION_CHAIN_CAP`, task-transitions). Both sides
  // compute the depth they would THREAD into the next drive, so the shared
  // meaning is "a threaded depth may never reach the cap" — i.e. at most
  // OPERATOR_TRANSITION_CHAIN_CAP consecutive operator-authored links. This
  // side used `>`, which let a 9th link through on the stranded-resume path
  // while the transition side stopped at 8, and both comment blocks claimed
  // one shared cap.
  if (depth >= OPERATOR_TRANSITION_CHAIN_CAP) {
    // The model refused to advance CAP times in a row — surface the dead end
    // honestly instead of resuming forever or stamping a silent wait.
    await appendTimelineEvent(
      { projectSlug: ref.projectSlug, taskKey: ref.taskKey, dataRoot: ref.dataRoot },
      {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text:
          `**Note:** the operator ended ${OPERATOR_TRANSITION_CHAIN_CAP} consecutive runs without advancing this ${autoStage ? "auto stage" : "task"}, opening a packet, or engaging an agent. ` +
          "Run the operator manually or adjust the goal.",
        toAgent: false,
        evidence: null,
      },
    );
    reprojectTask(db, { dataRoot: ref.dataRoot }, ref.projectSlug, ref.taskKey);
    logger.warn("stranded-operator resume hit the chain cap; leaving a note", {
      taskKey: ref.taskKey,
      depth,
    });
    return false;
  }

  logger.info("operator ended without acting; resuming the chain", {
    taskKey: ref.taskKey,
    stage: file.parsed.frontmatter.stage,
    depth,
  });
  const nudge: RunOperatorInput = {
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    trigger: "transition",
    transitionDepth: depth,
    strandedResume: true,
    dataRoot: ref.dataRoot,
  };
  if (refreshedAndStopped && ref.ownRun?.planWhollyRefused !== true) {
    nudge.refreshNudge = true;
  }
  // Ruling 489(d): the nudge continues the stranded drive's chain, so its hop
  // count carries on rather than starting over.
  if (ref.ownRun?.reactHops) nudge.reactHops = ref.ownRun.reactHops;
  if (ref.ownRun?.planWhollyRefused === true) {
    nudge.planRefusedNudge = true;
    // Ruling 400: carry the refusals into the retry's own instruction.
    if (ref.ownRun.refusedPlanSteps?.length) {
      nudge.refusedPlanSteps = ref.ownRun.refusedPlanSteps;
    }
  }
  void runOperator(db, nudge).catch((error) => {
    logger.error("stranded-operator resume failed", {
      taskKey: ref.taskKey,
      err: toError(error),
    });
  });
  return true;
}

/** After the last operator drive ends with no queued follow-up: if no run is
 *  still live on the task, RESUME a stranded auto-stage chain (see above) or
 *  flip `waiting: agent` → human. Fire-and-forget — a failed settle only
 *  leaves the board reading "working" until the next task mutation
 *  reprojects. */
function settleWaitingAfterOperator(
  db: DatabaseSync,
  ref: {
    projectSlug: string;
    taskKey: string;
    dataRoot?: string;
    runId?: string | null;
    transitionDepth?: number;
    stageAtStart?: string | null;
    strandedResume?: boolean;
    ownRun?: OwnOperatorRun | null;
  },
): void {
  void (async () => {
    try {
      const live = inFlightAgentRun(db, ref.projectSlug, ref.taskKey);
      if (live) return;
      if (await maybeResumeStrandedOperator(db, ref)) return;
      const ctx: TaskMutationContext =
        { dataRoot: ref.dataRoot };
      await clearWaitingToHuman(db, ctx, ref.projectSlug, ref.taskKey);
    } catch (error) {
      logger.warn("settleWaitingAfterOperator failed", {
        taskKey: ref.taskKey,
        err: toError(error),
      });
    }
  })();
}

/** Any queued/running run (operator, specialist or reviewer) on the task. */
function inFlightAgentRun(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM agent_runs
       WHERE project_slug = ? AND task_key = ?
         AND state IN ('queued', 'running')
       LIMIT 1`,
    )
    .get(projectSlug, taskKey);
  return !!row;
}

/** The ref the task-file readers below take, carrying `dataRoot` only when one
 *  is configured (a test store sets it; production leaves the key off). */
function taskFileRef(ref: TaskFileRef): TaskFileRef {
  const out: TaskFileRef = { projectSlug: ref.projectSlug, taskKey: ref.taskKey };
  if (ref.dataRoot) out.dataRoot = ref.dataRoot;
  return out;
}

/**
 * The stage a drive STARTS at — the fact that makes "this drive did not move
 * the task" decidable, and therefore the switch for the stranded-resume
 * backstop above.
 *
 * B6: every caller used to inline `readTaskFile(...)?.parsed.frontmatter.stage
 * ?? null`, so a missing/unreadable task file silently produced the same
 * `null` that means "unknowable" — the backstop went off for the whole drive
 * with no log line anywhere. A failed read is now warned about at the moment
 * it happens, not inferred later from a task sitting still.
 */
function readStageAtStart(
  ref: TaskFileRef,
  origin: "drive" | "stranded-plan-recovery",
): string | null {
  try {
    const stage = readTaskFile(taskFileRef(ref))?.parsed.frontmatter.stage ?? null;
    if (stage === null) {
      logger.warn(
        "operator drive could not read the task's starting stage; the stranded-resume backstop is OFF for it",
        { projectSlug: ref.projectSlug, taskKey: ref.taskKey, origin },
      );
    }
    return stage;
  } catch (error) {
    logger.warn(
      "operator drive could not read the task's starting stage; the stranded-resume backstop is OFF for it",
      {
        projectSlug: ref.projectSlug,
        taskKey: ref.taskKey,
        origin,
        err: toError(error),
      },
    );
    return null;
  }
}

/** Test-only: drop all leases/queued triggers (fresh state per test). */
export function resetOperatorLeasesForTests(): void {
  const state = leaseState();
  state.held.clear();
  state.pending.clear();
}

// ------------------------------------------- R19-1: the operator's repo view

/**
 * What THIS operator run can actually see of the project's repository (R19-1).
 *
 * F19-4, live: at triage the operator's cwd (the task's canonical folder) held
 * exactly `task.md`, and the model wrote a decision packet reporting "Repo
 * contents visible to operator: only task.md — no docs/ or README found" about
 * a repository that has both. It was describing its own empty workspace, and
 * its scoping options were invented from that ("add a README" for a repo that
 * has one). The owner ruled for a full read-only clone over a summary view and
 * over a persona-only fix: packets must be grounded in the real repository.
 *
 * `unavailable` is a first-class arm, not an error: a clone failure must never
 * strand the drive (the operator can still coordinate), but the run has to KNOW
 * it is blind, or it falls straight back into describing the task folder.
 */
export type OperatorWorkspaceView =
  | {
      kind: "checkout";
      /** `owner/repo`. */
      repo: string;
      /** Absolute checkout path (logs + tests). */
      dir: string;
      /** The path as the OPERATOR sees it — its cwd is the task folder. */
      relativeDir: string;
      /**
       * F21-21: the project's default branch, so the run has a NAME for the
       * thing the working tree is not. This checkout is the delivering agent's
       * workspace — once a specialist commits, it stands on the TASK branch —
       * so "what does the default branch contain?" is answered by the
       * `read_default_branch_file` tool (which reads `origin/<defaultBranch>`),
       * never by reading the tree.
       */
      defaultBranch: string;
    }
  | { kind: "unavailable"; repo: string; sentence: string }
  /** No repository is connected to the project — or the caller did not resolve
   *  a view at all. Both mean the same thing to the model: no checkout, so
   *  claim nothing about repository contents. */
  | { kind: "none" };

/** Where this task's operator checkout goes, and what the prompt calls it.
 *  Null when the project has no repository (or no readable project file). */
function operatorCheckoutTarget(input: TaskFileRef): {
  repo: string;
  dir: string;
  relativeDir: string;
  defaultBranch: string;
} | null {
  const projectRef: ProjectFileRef = { projectSlug: input.projectSlug };
  if (input.dataRoot) projectRef.dataRoot = input.dataRoot;
  const project = readProjectFile(projectRef);
  const repo = project ? project.parsed.frontmatter.repo : null;
  if (!project || !repo) return null;
  const name = repo.split("/").pop() ?? repo;
  return {
    repo,
    dir: path.join(
      taskDir(input.projectSlug, input.taskKey, input.dataRoot),
      "workspace",
      name,
    ),
    // Posix separators: this string is prose in a prompt, not a filesystem path.
    relativeDir: `workspace/${name}`,
    defaultBranch: project.parsed.frontmatter.defaultBranch,
  };
}

/**
 * Pass-24 B-1 (owner ruling) — the Codex operator's scratch working directory.
 *
 * The Claude operator physically cannot write: `Bash`/`Edit`/`Write`/`MultiEdit`/
 * `NotebookEdit` are removed from its context. The Codex operator has no such
 * denylist channel, and since ruling 185 no OS sandbox either: every Codex
 * thread starts `danger-full-access`, so nothing refuses a write anywhere.
 * What the folder still buys is where the run STANDS. Left at the task folder
 * (the default), the cwd would contain `task.md` (the canonical governance
 * record — stage, verdicts, packet) and the shared deliverer checkout below
 * it, so a cwd-relative `sed` or `git commit` would land in the governance
 * file or the delivery clone. Root it instead at a dedicated empty scratch
 * folder that is a SIBLING of `task.md`, never its parent: the governance file
 * and the checkout stay readable by absolute path and outside the cwd, and the
 * prompt states their read-only posture as a rule, not a wall (ruling 207(b)).
 */
function ensureOperatorScratchDir(input: TaskFileRef): string {
  const dir = path.join(
    taskDir(input.projectSlug, input.taskKey, input.dataRoot),
    ".operator-scratch",
  );
  // Ruling 460: the operator runs as its principal's own user and writes here.
  shareDirWithAgents(dir);
  return dir;
}

/**
 * The repository this drive is about to CLONE, or null when there is nothing to
 * wait for (no repo, or the checkout already exists).
 *
 * R21-4 / OBS-8: the caller reserves a live run row before that clone, so the
 * task page shows what the server is doing instead of an empty timeline. Only
 * the clone case is worth a reservation — the other two return in microseconds.
 * The lease already guarantees one drive per task, so nothing can slip a clone
 * in between this answer and `ensureOperatorRepoCheckout` acting on it.
 */
export function pendingOperatorClone(input: TaskFileRef): string | null {
  const target = operatorCheckoutTarget(input);
  if (!target) return null;
  return existsSync(path.join(target.dir, ".git", "HEAD")) ? null : target.repo;
}

/**
 * Ensure this task's workspace checkout exists before an operator run starts,
 * and report what the run really got.
 *
 * It is the SAME checkout a specialist run uses — `<taskDir>/workspace/<name>`,
 * the derivation `taskCloneDir`/`cloneRepo` share (specialist-run.server) — for
 * one task, so the delivering agent that runs later reuses this clone instead
 * of paying for a second one.
 *
 * An EXISTING checkout is returned untouched: no remote re-sanitization and no
 * re-strip of `.claude`. That directory belongs to whichever engagement is
 * delivering, and touching it mid-run is exactly the F19-15 hazard (the strip
 * deleted a streaming run's mounted skills). A checkout this function CREATES
 * has no live run against it, so it is stripped once, here, like any fresh
 * clone (R18-3 — Viberr owns the workspace catalog).
 *
 * Never throws: every failure becomes the `unavailable` arm.
 */
export async function ensureOperatorRepoCheckout(
  db: DatabaseSync,
  input: TaskFileRef,
  /** F27-U1: 0..1 progress for the cold clone the operator drive often pays
   *  first on a project (see the reservation set up by the caller). */
  onCloneProgress?: (fraction: number) => void,
  /** Ruling 468: the GitHub transport for the empty-repository bootstrap
   *  (tests inject one; production uses the global fetch). */
  options: { fetchImpl?: typeof fetch } = {},
): Promise<OperatorWorkspaceView> {
  const target = operatorCheckoutTarget(input);
  if (!target) return { kind: "none" };
  const { repo, dir, relativeDir, defaultBranch } = target;
  // Ruling 468 (F40-12): a checkout of an EMPTY repository has an unborn
  // HEAD, and the operator read that as a chore for a person ("push one
  // initial commit"). Viberr makes the first commit itself (ruling 128's
  // bootstrap) and moves the checkout onto it, here as before a task branch.
  const initialize = () =>
    initializeUnbornCheckout(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, repo, dir, defaultBranch, dataRoot: input.dataRoot },
      options,
    );
  if (existsSync(path.join(dir, ".git", "HEAD"))) {
    await initialize();
    return { kind: "checkout", repo, dir, relativeDir, defaultBranch };
  }

  let token: string | null = null;
  // Ruling 249: the operator's checkout is always a network clone, and the
  // credential is resolved before it — so this arm only ever says supplied or
  // absent, and both are true when it says them. Ruling 485: a local step's
  // fault (the person, the directory, the heal below, the strip) says
  // `not_involved` in the catch.
  let credential: CloneCredential = "absent";
  try {
    // Ruling 485: a tree in the workspace is removed as the task's person,
    // as its git runs (null: the server's own user, isolation off).
    const workspace = { projectSlug: input.projectSlug, taskKey: input.taskKey, dataRoot: input.dataRoot };
    const person = await workspaceStep(`\`${path.dirname(dir)}\` has no person to work in it as`, () =>
      taskWorkspaceLaunch(db, workspace),
    );
    // Ruling 460: `workspace/` is shared with the agent group, so what the
    // clone writes below it stays editable by the agents that run there.
    await workspaceStep(`\`${path.dirname(dir)}\` could not be created`, () =>
      shareDirWithAgentsOrWarn(path.dirname(dir)),
    );
    // Ruling 485 (3): a checkout with no `.git/HEAD` (a clone killed mid-way,
    // a tree an older build's server-side remove left half-removed) would
    // block the clone into its path on every run: removed as its person.
    if (existsSync(dir)) {
      logger.warn("a checkout with no .git/HEAD is removed as its person and cloned again", {
        taskKey: input.taskKey,
        dir,
      });
      await workspaceStep(`\`${dir}\` has no \`.git/HEAD\` and could not be removed`, () =>
        removeAgentTree(dir, person),
      );
    }
    const cred = getProjectCredential(db, input.projectSlug);
    token = cred ? getPatToken(db, cred.id) : null;
    credential = token ? "supplied" : "absent";
    try {
      // R21-4: through the project's mirror cache, exactly as the specialist
      // path clones — so the operator drive that runs FIRST on a project pays
      // the network clone once and every task after it is local work.
      const cloneInput: WorkspaceCloneInput = {
        projectSlug: input.projectSlug,
        repo,
        destination: dir,
        token,
        person,
      };
      if (input.dataRoot) cloneInput.dataRoot = input.dataRoot;
      if (onCloneProgress) cloneInput.onCloneProgress = onCloneProgress;
      await cloneWorkspaceRepo(cloneInput);
    } finally {
      // A clone killed mid-transfer leaves a partial tree that the next run's
      // `.git` check would accept as "already cloned" — worse than nothing.
      // As the person, and never thrown over the clone's own failure.
      if (!existsSync(path.join(dir, ".git", "HEAD"))) {
        try {
          await removeAgentTree(dir, person);
        } catch (removal) {
          logger.warn("an unfinished operator checkout could not be removed as its person; the next run removes it", {
            dir,
            err: toError(removal),
          });
        }
      }
    }
    // Pass 40 review (R-seams-1): the checkout's git as the task's person.
    await workspaceStep(`\`${path.join(dir, ".claude")}\` could not be removed`, () =>
      stripUngovernedRepoCatalog(dir, taskWorkspaceGit(db, workspace)),
    );
    logger.info("cloned the task repository for the operator (read-only view)", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      repo,
    });
    await initialize();
    return { kind: "checkout", repo, dir, relativeDir, defaultBranch };
  } catch (error) {
    if (error instanceof WorkspaceFault) credential = "not_involved";
    const details = cloneFailureLogDetails(error, { token });
    // F19-6: git's own complaint, redacted by value — "git exit 128" alone told
    // a human with a working credential nothing they could act on. Ruling 485:
    // for a workspace fault, the failing program's own words (rm's, git's).
    const stderrExcerpt = details.detail ?? "";
    const failureFields = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      repo,
      credential,
      ...details,
    };
    logger.warn(
      "the operator runs WITHOUT a repository checkout: its clone failed",
      // The excerpt is a field only when git actually printed something.
      stderrExcerpt ? { ...failureFields, stderrExcerpt } : failureFields,
    );
    return {
      kind: "unavailable",
      repo,
      sentence:
        cloneFailureSentence(details, { credential, timeoutMs: cloneTimeoutMs() }) +
        (stderrExcerpt ? ` The checkout reported: ${stderrExcerpt}` : ""),
    };
  }
}

export async function runOperator(
  db: DatabaseSync,
  input: RunOperatorInput,
): Promise<RunOperatorResult> {
  const ctx: TaskMutationContext = {
    dataRoot: input.dataRoot,
  };
  // Only the overrides the caller actually supplied travel; the resolver fills
  // the rest from the project's operator deployment.
  // R19-A: this resolve LAUNCHES work, so a clamp that bites is recorded.
  // Loader paths resolve authority too and deliberately pass no db — a read
  // must not write audit rows. Live-verified: without this the clamp still
  // held, but the reduction was invisible, which is the half of the ruling
  // that matters to whoever wonders why their full-autonomy run behaved.
  const overrides: OperatorAuthorityOverrides = { db, taskKey: input.taskKey };
  if (input.backend) overrides.backend = input.backend;
  if (input.autonomy) overrides.autonomy = input.autonomy;
  if (input.actor) overrides.actor = input.actor;
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, overrides);
  const backend = authority.backend;

  // Ruling 177 (pass 36, F36-4 / F36-5): a CLOSED task — terminal stage or
  // archived — refuses EVERY trigger here, where the run starts. FR39 / F19-20
  // used to scope this to the `scheduled` trigger ("every other trigger on a
  // terminal task is legitimate — a pr-diverged recovery, an @operator
  // question about finished work"); live, that legitimacy was the door: the
  // dispatch-completion contract's `agent-reply` re-invoked the operator on a
  // force-accepted task and the operator opened a decision packet on it
  // (HLC-9), and an `@operator` mention (`manual`) started a paid run on an
  // archived task behind a page whose own button refused it. The pr-diverged
  // wake on a Done task (an out-of-band merge reconciling into a task that is
  // already Done) has nothing left to route either: the reconciler writes the
  // note and the notification itself. Reopening a closed task is a HUMAN stage
  // move, and the transition that reopens it is the trigger that coordinates
  // again.
  {
    const closedFile = readTaskFile(taskFileRef(input));
    const project = getProject(db, input.projectSlug);
    const closure =
      closedFile && project
        ? taskClosure(closedFile.parsed.frontmatter, project.stages)
        : ({ closed: false } as const);
    if (closure.closed && project) {
      const reason = closureRefusal(
        input.taskKey,
        closure,
        project.stages,
        "running the operator on it",
      );
      logger.info("operator run refused: the task is closed", {
        taskKey: input.taskKey,
        projectSlug: input.projectSlug,
        trigger: input.trigger ?? "manual",
        why: closure.why,
        stage: closure.stageId,
      });
      // A refusal must leave the task's waiting state HONEST. When this trigger
      // was drained off the queue, `releaseOperatorLease` skipped its settle
      // precisely because a trigger existed to fire — so refusing without this
      // would strand `waiting: agent` on a closed task with no agent running.
      // It is a no-op unless the flag is `agent` and nothing else is live, and
      // it settles a closed task to `none` rather than "waiting on a human".
      settleWaitingAfterOperator(db, taskFileRef(input));
      // Ruling 227: and SAY so, on the task, for a trigger somebody is waiting
      // on — see `noteQueuedTriggerRefused`. Fire-and-forget: the refusal is
      // the answer, and failing to record it must not turn into a thrown error
      // for the caller.
      if (NOTED_DOOR_REFUSAL_TRIGGERS.has(input.trigger ?? "manual")) {
        void noteQueuedTriggerRefused(db, input, "closed", "door");
      }
      return {
        runId: null,
        queued: false,
        backend,
        autonomy: authority.autonomy,
        refused: "closed",
        refusalReason: reason,
      };
    }
  }

  // Ruling 131(d) (pass 34, Q34-11): a task waiting on other work is held,
  // not coordinated. The triggers that would start ordinary coordination are
  // refused before any run row exists (no run, no cost); JC-9 paid five
  // operator turns to rediscover the same wait. Reactive triggers still run
  // under the held doctrine (`operatorTurnDoctrine`).
  if (HELD_TRIGGERS.has(input.trigger ?? "manual")) {
    const held = readTaskFile(taskFileRef(input))?.parsed.frontmatter.blockedBy ?? [];
    if (held.length > 0) {
      logger.info("operator run refused: the task waits on other work", {
        taskKey: input.taskKey,
        trigger: input.trigger,
        blockedBy: held,
      });
      // Same settle the terminal branch performs: a trigger drained off the
      // lease queue had its settle skipped by `releaseOperatorLease` precisely
      // because a trigger existed to fire, so refusing without it would leave
      // `waiting: "agent"` on a task with no agent forever. A held task with
      // nothing else pending settles to `none` (`clearWaitingToHuman`).
      settleWaitingAfterOperator(db, taskFileRef(input));
      if (NOTED_DOOR_REFUSAL_TRIGGERS.has(input.trigger ?? "manual")) {
        void noteQueuedTriggerRefused(db, input, "blocked-by", "door");
      }
      return {
        runId: null,
        queued: false,
        backend,
        autonomy: authority.autonomy,
        refused: "blocked-by",
      };
    }
  }

  // R20-1 (F20-5): a HUMAN-pressed "Run operator" while a decision packet is
  // open is a paid no-op — coordination is paused by the packet, so the run
  // completes several turns and can take no action (live: 6 turns / $0.27, only
  // get_task). Refuse it and say why. Ruling 141 (pass 34, F34-8): a SCHEDULED
  // re-run is the same turn with nobody watching, so it takes the same refusal.
  // Machine reaction triggers still run with a packet open — `pr-diverged`
  // recovery WITHDRAWS a moot packet (ruling 17), and `agent-reply` reacts to a
  // run that was already in flight.
  //
  // Ruling 195 (F37-17): this arm used to say "the packet already owns
  // `waiting: human`, so there is no settle to do here". That is not an
  // invariant — it is usually true, and SHOP-6 showed how it breaks. A packet
  // opened mid-work does NOT stop the machine triggers, so the operator kept
  // coordinating and dispatched a deliverer, which set `waiting: agent`. The
  // server restarted, boot finalized that orphaned run and re-invoked the
  // operator as `manual` — straight into this refusal. No settle ran, so the
  // task sat at `waiting: agent` with nothing running and a decision nobody
  // was told about: 75 minutes, ten downstream tasks held behind it, and a
  // board that said an agent was working. The other two refusal arms settle
  // for exactly this reason; so does this one now. It is a no-op unless the
  // flag is `agent` with nothing live, and with a packet open
  // `clearWaitingToHuman` settles to `human` — the packet's own owner.
  if (PACKET_REFUSED_TRIGGERS.has(input.trigger ?? "manual")) {
    const openPacket = readTaskFile(taskFileRef(input))?.parsed.packet ?? null;
    if (openPacket) {
      logger.info("operator run refused: a decision packet is open", {
        trigger: input.trigger ?? "manual",
        taskKey: input.taskKey,
        packet: openPacket.title,
      });
      settleWaitingAfterOperator(db, taskFileRef(input));
      if (NOTED_DOOR_REFUSAL_TRIGGERS.has(input.trigger ?? "manual")) {
        void noteQueuedTriggerRefused(db, input, "open-packet", "door");
      }
      return {
        runId: null,
        queued: false,
        backend,
        autonomy: authority.autonomy,
        refused: "open-packet",
      };
    }
  }

  // Single-flight per task (NFR16, B6): one operator coordinates a task at a
  // time. A trigger arriving while the lease is held — e.g. create-time
  // auto-invoke racing an "@operator …" comment — is QUEUED (machine triggers
  // newest-wins, human questions kept in order; see the lease doc) and fired
  // when the in-flight coordination truly ends, so no trigger is ever silently
  // dropped and no two drives overlap. The process lease also covers
  // Codex plan execution after the provider run finishes.
  const leaseKey = leaseKeyFor(input.projectSlug, input.taskKey);
  const lease = leaseState();
  const heldByProcess = lease.held.get(leaseKey);
  if (heldByProcess) {
    for (const drop of queueOperatorTrigger(leaseKey, input)) {
      void noteDroppedOperatorTurn(db, drop);
    }
    logger.info("operator run queued: one already in flight (process lease)", {
      taskKey: input.taskKey,
      trigger: input.trigger ?? "manual",
    });
    return {
      // B10: null — this drive has no run row yet, so there is no run to name.
      runId: heldByProcess.runId,
      queued: true,
      backend: heldByProcess.backend,
      autonomy: heldByProcess.autonomy,
    };
  }
  // Cross-boot backstop: a queued/running DB row without a process lease (e.g.
  // resumed after a restart) still coalesces; queue the trigger and drain it
  // when that run finishes.
  const inflight = inFlightOperatorRun(db, input.projectSlug, input.taskKey);
  if (inflight?.restartOrphan) {
    // B10: a row left non-terminal by a PREVIOUS process. Its completion
    // callback died with that process — `finalizeOrphanedRuns` only patches
    // the row at boot, it never fires one — so chaining a drain onto it
    // stranded the trigger in `pending` until some unrelated drive on the same
    // task happened to release the lease. Finalize it exactly as boot recovery
    // does and drive this trigger now.
    logger.warn("clearing a restart-orphaned operator run before driving", {
      taskKey: input.taskKey,
      runId: inflight.id,
      trigger: input.trigger ?? "manual",
    });
    patchRun(db, inflight.id, {
      state: "interrupted",
      finishedAt: new Date().toISOString(),
      interruptedReason: "restart",
      phase: null,
      step: null,
    });
  } else if (inflight) {
    for (const drop of queueOperatorTrigger(leaseKey, input)) {
      void noteDroppedOperatorTurn(db, drop);
    }
    chainRunCompletion(inflight.id, () => drainPendingAfterInFlight(db, leaseKey));
    logger.info("operator run queued: DB row already in flight", {
      taskKey: input.taskKey,
      runId: inflight.id,
      trigger: input.trigger ?? "manual",
    });
    return {
      runId: inflight.id,
      queued: true,
      backend: inflight.backend,
      autonomy: authority.autonomy,
    };
  }

  // The lease-entry OBJECT is this drive's release token — every release for
  // this drive passes it, so a stale/duplicate release can never evict a
  // successor's lease (releaseOperatorLease is idempotent per token).
  // NOTE: no await may sit between the held-check above and this set — the
  // single-flight coalesce depends on check→set being one synchronous step.
  const leaseToken: OperatorLeaseEntry = {
    runId: null,
    backend,
    autonomy: authority.autonomy,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: input.dataRoot,
    transitionDepth: input.transitionDepth ?? 0,
    stageAtStart: readStageAtStart(taskFileRef(input), "drive"),
    strandedResume: input.strandedResume === true,
    ownRun: null,
  };
  lease.held.set(leaseKey, leaseToken);

  // Carry the run's identity on the ctx so that when an agent this operator
  // prompts replies, the reply-completion hook can re-invoke the operator to
  // REACT (read the reply → propose a state change). The reactDepth bounds that
  // chain (see OPERATOR_REACT_DEPTH_CAP).
  ctx.operatorRun = {
    backend,
    autonomy: authority.autonomy,
    reactDepth: input.reactDepth ?? 0,
    // Ruling 489(d): threaded to every agent this drive dispatches, whose
    // completion counts one more hop toward the ceiling.
    reactHops: input.reactHops ?? 0,
    // Threaded so a transition THIS drive makes carries the chain depth into
    // transitionStage's re-trigger (see OPERATOR_TRANSITION_CHAIN_CAP).
    transitionDepth: input.transitionDepth ?? 0,
  };
  // Ruling 152(a): the settle reads this drive's own moves off the same object.
  leaseToken.ownRun = ctx.operatorRun;

  // Ruling 157 (pass 35, F35-8): a person starting the operator (Run operator,
  // an `@operator` comment, the controller; every one of them carries `actor`)
  // or a schedule they set lifts a packet-less hold on the record. A bare
  // `manual` with no actor (boot recovery) and every machine trigger lift
  // nothing. A press that queued behind a live drive re-passes this input
  // when it drains, which is when its run starts.
  if (input.trigger === "scheduled") {
    await liftHoldForRun(db, ctx, input.projectSlug, input.taskKey, {
      kind: "operator-run",
      trigger: "scheduled",
      byName: null,
      by: null,
    });
  } else if ((input.trigger ?? "manual") === "manual" && input.actor) {
    const byName =
      input.humanCommentBy ??
      (input.actor.userId ? userDisplayName(db, input.actor.userId) : null);
    await liftHoldForRun(db, ctx, input.projectSlug, input.taskKey, {
      kind: "operator-run",
      trigger: "manual",
      byName,
      by: input.actor,
    });
    // Ruling 216 (F37-36): the SAME press also re-litigates the deliberate
    // STAGE hold, which is the one the "Coordination is paused here" note
    // tells the reader to end by running the operator manually. Only a
    // person's press: a schedule re-arming this is exactly what V18 stopped.
    await liftStageHoldForPerson(db, ctx, input.projectSlug, input.taskKey, {
      byName,
      by: input.actor,
    });
  }
  // The operator is itself an agent working the task: the board should read
  // "working" for the duration of the drive, not "waiting on you" (the
  // specialist starters do the same). Settled back to human on lease release
  // once nothing is live (settleWaitingAfterOperator).
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);

  // Claude uses in-process governance tools. Codex emits a structured plan
  // that the completion callback executes through the same governed actions.
  //
  // R21-4 / OBS-8: the operator's OWN clone is the one that ran 3+ minutes live
  // on a 113 MB repository while the task page said the operator "hasn't started
  // its operator loop". Claim the run row NOW, before the clone, with a phase
  // that says what the server is doing; `startRun` adopts it (id, thread,
  // started_at) instead of minting a second row. The thread id is minted here
  // rather than in the two start functions so the reserved row and the launched
  // run are the same thread.
  const threadId = "op-" + newId("t").replace("t_", "").slice(0, 8);
  // Ruling 127: whose accounts this drive bills — the task owner. Resolved
  // BEFORE the clone and the reservation, because a refused drive must pay for
  // neither; `startRun` turns the refusal into the run's whole outcome.
  const principal = resolveTaskRunPrincipal(
    db,
    { dataRoot: input.dataRoot },
    input.projectSlug,
    input.taskKey,
    backend,
  );
  const cloning = principal.ok ? pendingOperatorClone(taskFileRef(input)) : null;
  const reservation =
    cloning && principal.ok
    ? reserveRun(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        threadId,
        role: "Operator",
        kind: "operator",
        backend,
        model: authority.model,
        agentName: authority.name,
        agentProfileId: "operator",
        credentialUserId: principal.principal.userId,
        phase: RUN_PHASE.preparing,
        // D1 (pass 23, owner ruling Q3): the same cold-clone honesty the
        // specialist strip gets — say when the multi-minute first-task mirror
        // build is what the wait is, rather than a static "Cloning …" that reads
        // as a hang.
        step: cloneStepLabel(
          cloning,
          mirrorIsCold(input.projectSlug, cloning, input.dataRoot),
        ),
      })
    : null;
  try {
    // R19-1: give the coordinator the real repository before it reasons about
    // it. Once per drive, under the lease (so two drives never clone the same
    // task at once) and inside this try — a clone failure degrades to the
    // `unavailable` arm rather than stranding the run, and the prompt then SAYS
    // the operator is blind instead of letting it read its empty task folder as
    // "the repo" (F19-4).
    // Ruling 127: a drive with no credential principal is about to be recorded
    // as a refusal, so it clones nothing — the same posture the pre-127
    // "backend unavailable" arm had. `kind: "none"` is exactly what the prompt
    // builders already handle for a project with no repo.
    const workspace: OperatorWorkspaceView = principal.ok
      ? await ensureOperatorRepoCheckout(
          db,
          taskFileRef(input),
          // F27-U1: `cloning` is the repo of the cold first-task clone; stream
          // its percentage onto the reservation the operator drive claimed.
          reservation && cloning
            ? (fraction) =>
                reservation.phase(
                  RUN_PHASE.preparing,
                  cloneProgressStep(cloning, fraction),
                )
            : undefined,
        )
      : { kind: "none" };
    const start: OperatorRunStart = { threadId, reservation, principal };
    return backend === "codex"
      ? await startCodexOperatorRun(db, ctx, input, authority, leaseKey, leaseToken, workspace, start)
      : await startRealOperatorRun(db, ctx, input, authority, leaseKey, leaseToken, workspace, start);
  } catch (error) {
    // Preparation (or the launch) threw: finalize the reserved row as `error`,
    // or it stays `running` forever with no process behind it.
    reservation?.abandon("operator run failed to start");
    releaseOperatorLease(db, leaseKey, leaseToken);
    throw error;
  }
}

/** The run identity `runOperator` claimed before the workspace clone — handed
 *  to whichever backend starter launches the drive (R21-4). */
interface OperatorRunStart {
  threadId: string;
  /** The reserved, already-`running` row, when the drive had to clone. */
  reservation: RunReservation | null;
  /** Ruling 127: whose accounts this drive bills, or why it cannot run. */
  principal: RunPrincipalResolution;
}

// ------------------------------------------------- codex (structured output)

/**
 * JSON schema constraining the codex operator's decision plan. OpenAI strict
 * structured output requires EVERY object to set additionalProperties:false and
 * list ALL properties in `required` — optional fields are expressed as nullable
 * (the model emits null when unused). The executor treats null/"" as absent.
 */
const OPERATOR_PLAN_TOOLS = [
  "post_comment",
  "open_packet",
  // Withdraw YOUR OWN open packet when it became moot (its asked-for input was
  // provided out-of-band, e.g. a human edited the goal). `reason` explains why.
  "resolve_packet",
  // Draft the task GOAL when it is still the unspecified triage placeholder
  // (`text` = the drafted goal). Fills only an unspecified goal.
  "set_goal",
  // Dynamic-dispatch rework (2026-08-29): ONE selection+run action — the plan
  // mirror of the Claude toolkit's `run_agent` (engage-if-needed with
  // capability-derived posture, optional `prompt` as the directive comment,
  // optional `delivers: true` for an explicit delivery hand-off).
  "run_agent",
  "transition_stage",
  // R15-2: delivery (push + review PR) is the operator's decision — the plan
  // mirror of the Claude `deliver_for_review` tool. `reason` carries the
  // recommendation-card line when policy recommends instead of performs.
  "deliver_for_review",
  // N19-9 (owner ruling): bringing the task branch up to date with its base is
  // an operator decision too — the plan mirror of `update_branch_from_base`.
  // Server-owned merge+push; a conflict opens a packet, never a force.
  "update_branch_from_base",
  "accept_completion",
  // Ruling 521: the plan mirror of `write_completion_packet`, the packet every
  // acceptance offer carries. `text` is the summary, `reason` the summary of
  // the code changes, `screenshots` the images that show the result.
  "write_completion_packet",
  // F-P6 (pass 25): the plan mirror of Claude's `flag_context_conflict` — a
  // Codex operator holding `append-typed-events` can raise the R19-2 KB-vs-repo
  // conflict as the same typed `quality` event + notification, not just a plain
  // comment. `kbSource`/`repoSource` name the two sides; `text` is the detail.
  "flag_context_conflict",
  // Ruling 131(b) (pass 34): record what the task WAITS ON (the full list of
  // task keys; `blockedBy: []` clears it) instead of opening a hold packet.
  // The plan mirror of the Claude toolkit's `set_dependencies`.
  "set_dependencies",
  // Ruling 503: put this task in an epic, move it, or take it out (`epicId`,
  // "" for none). The plan mirror of the Claude toolkit's `set_epic`.
  "set_epic",
  // F39-1/F39-7 (pass 39): the plan mirror of `propose_ruling`, generalized by
  // ruling 483 into `propose_kb_correction` and made a write by ruling 498 as
  // `correct_knowledge_doc`. Every agent on the pass-39 instance ran on Codex,
  // so a tool that exists only on the Claude toolkit would have been
  // unreachable by the operator that actually found the false ruling. `text`
  // carries what the document should say, `kbSource` the knowledge base and
  // document (`<kb>/<doc>`, or a bare document of the rulings), `reason` the
  // exact passage it replaces, `repoSource` the evidence.
  "correct_knowledge_doc",
  // Ruling 417 (owner): lease shared files to THIS task until it merges. The
  // plan mirror of the Claude toolkit's `lease_files`; `paths` carries the
  // globs and `text` the reason.
  "lease_files",
  // Ruling 487 (F40-65): schedule a future run on THIS task (its own re-run,
  // or a deployed agent's with a directive) and cancel one it scheduled. The
  // plan mirrors of the Claude toolkit's two tools of the same names:
  // `profileId` (or "operator"/null) is the target, `dueAt` or `delayMinutes`
  // the time, `text` the steer or directive, `scheduleId` what to cancel.
  "schedule_task_action",
  "cancel_task_schedule",
  // Ruling 488 (F40-67): post on ANOTHER task of this project. The plan mirror
  // of the Claude toolkit's `relay_to_task`: `taskKey` names the task, `text`
  // is what lands there, `files` (ruling 538) the attachments it carries.
  "relay_to_task",
  // Ruling 557: the relay's other direction. `taskKey` names the task that
  // holds the files, `files` which of them to take onto this task, `text` an
  // optional line on what they are for.
  "take_from_task",
  // Ruling 584: edit or delete a comment the operator or an agent wrote on
  // THIS task, silently. The plan mirror of the Claude toolkit's
  // `edit_comment`: `commentAt` names the comment, `text` the words that
  // replace it (null deletes it), `reason` why.
  "edit_comment",
] as const;

const OPERATOR_PACKET_TYPES = ["input", "blocked"] as const;

type OperatorPlanTool = (typeof OPERATOR_PLAN_TOOLS)[number];

/**
 * The capability each plan tool needs — the exact mapping the Claude toolkit
 * uses to decide whether to BUILD a tool (`operator-toolkit.server.ts`). On
 * Claude a denied capability's tool never exists, so the model cannot reach it;
 * the Codex plan schema used to advertise every plan tool regardless of policy.
 */
const OPERATOR_PLAN_TOOL_CAPABILITIES = {
  post_comment: ["append-typed-events"],
  set_goal: ["append-typed-events"],
  open_packet: ["generate-packets"],
  resolve_packet: ["generate-packets"],
  run_agent: ["dispatch-agents"],
  transition_stage: ["stage-transitions"],
  // R15-2: absent-means-granted polarity — resolved via deliverGate below, not
  // the plain gate (the capability postdates live deployments).
  deliver_for_review: ["deliver-review-pr"],
  // Same absent-means-derived polarity as delivery — resolved via
  // updateBranchGate below, not the plain gate.
  update_branch_from_base: ["update-task-branch"],
  accept_completion: ["completion-for-acceptance"],
  // Ruling 521: the packet exists only to go with an acceptance offer.
  write_completion_packet: ["completion-for-acceptance"],
  // F-P6 (pass 25): same gate as Claude's `flag_context_conflict` tool.
  flag_context_conflict: ["append-typed-events"],
  // Ruling 131(b): the wait is the hold packet's replacement, so it rides the
  // packet's own grant.
  set_dependencies: ["generate-packets"],
  // Ruling 503: the same grant as `set_goal`, the operator's other planning
  // edit on its own task.
  set_epic: ["append-typed-events"],
  // F39-1/F39-7: same gate as `flag_context_conflict`, the typed event it
  // posts. Ruling 498 made the correction a write; a person undoes one from
  // the Controller page rather than gating each (owner, 2026-09-26).
  correct_knowledge_doc: ["append-typed-events"],
  // Ruling 417: a lease orders DELIVERIES, so it rides delivery authority —
  // resolved via deliverGate below, like `deliver_for_review` itself.
  lease_files: ["deliver-review-pr"],
  // Ruling 487: a schedule is a dispatch with a date on it, and it starts
  // with nobody present, so it rides a DIRECT dispatch grant (resolved below).
  schedule_task_action: ["dispatch-agents"],
  cancel_task_schedule: ["dispatch-agents"],
  // Ruling 488: a relay is a comment one task over, so it rides the comment's
  // own grant, as the Claude tool does.
  relay_to_task: ["append-typed-events"],
  // Ruling 557: a take writes the relay's claim comment on this task.
  take_from_task: ["append-typed-events"],
  // Ruling 584: a comment's words are a timeline write, like the comment.
  edit_comment: ["append-typed-events"],
} satisfies Record<OperatorPlanTool, readonly string[]>;

/**
 * The plan tools this operator is actually allowed to use (P13-RT-03). Codex
 * has no per-tool build step, so the constraint has to live in the schema the
 * run is given — otherwise the model is invited to propose actions that can
 * only be refused, burning a billed turn on a plan that does nothing.
 */
export function operatorPlanToolsFor(
  authority: OperatorAuthority,
): OperatorPlanTool[] {
  const permitted = OPERATOR_PLAN_TOOLS.filter((toolName) =>
    toolName === "deliver_for_review" || toolName === "lease_files"
      ? deliverGate(authority) !== "deny"
      : toolName === "update_branch_from_base"
        ? updateBranchGate(authority) !== "deny"
        : toolName === "schedule_task_action" || toolName === "cancel_task_schedule"
          ? // Ruling 487: only a grant that starts runs itself schedules one,
            // the same test the Claude toolkit builds the two tools on.
            dispatchGate(authority) === "direct"
        : toolName === "run_agent"
          ? // Dispatch-rework hunt (2026-08-29): `dispatch-agents` carries the
            // absent-means-default polarity (pre-rework deployments store only
            // the retired assign/summon ids) — the plain gate read it as deny
            // and silently withheld dispatching from every existing project's
            // Codex operator. Same resolver the Claude toolkit uses.
            dispatchGate(authority) !== "deny"
          : OPERATOR_PLAN_TOOL_CAPABILITIES[toolName].some(
              (cap) => gate(authority, cap) !== "deny",
            ),
  );
  // A structured-output `enum` may not be empty. An operator with NOTHING
  // granted is a misconfiguration rather than a run shape we can express, so
  // fall back to the full list — every action it then proposes is refused
  // VISIBLY by narrateRefusedActions rather than silently.
  //
  // A4: except `deliver_for_review` and `update_branch_from_base`. Reaching the
  // fallback means their grant was either explicitly withheld or (with no
  // operator deployed) never made, and these are the plan actions with effects
  // OUTSIDE Viberr — a pushed branch, an opened PR. `operatorDeliverForReview`
  // refuses either way, so advertising them only buys a billed turn spent
  // planning a push that cannot happen.
  // Ruling 417: `lease_files` rides the delivery gate, so the fallback that
  // withholds delivery withholds it too; advertising it would buy a turn
  // spent planning a lease `operatorLeaseFiles` refuses.
  // Ruling 487: the schedule verbs ride a DIRECT dispatch grant, which no
  // operator reaching the fallback holds, so they are withheld the same way.
  const withheldInFallback: readonly OperatorPlanTool[] = [
    "deliver_for_review",
    "update_branch_from_base",
    "lease_files",
    "schedule_task_action",
    "cancel_task_schedule",
  ];
  return permitted.length
    ? [...permitted]
    : OPERATOR_PLAN_TOOLS.filter((t) => !withheldInFallback.includes(t));
}

/** The JSON schema the Codex operator run must answer with, for this
 *  authority's permitted tools — exported so a test can read the emitted
 *  shape (ruling 138: `goalDraft` is a REQUIRED option key). */
export function operatorPlanSchemaFor(authority: OperatorAuthority) {
  return buildOperatorPlanSchema(operatorPlanToolsFor(authority));
}

function buildOperatorPlanSchema(tools: readonly OperatorPlanTool[]) {
  return {
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
            enum: tools,
          },
          profileId: { type: ["string", "null"], description: "For run_agent: the deployed agent profile to select and run (pick by desc + capabilities from the snapshot). For schedule_task_action: the deployed profile whose run to schedule, or \"operator\" (or null) for your own re-run. Else null." },
          delivers: { type: ["boolean", "null"], description: "run_agent: true = hand delivery to this profile (owns branch/PR, one per task; on a task whose deliverable is a result, the agent that makes it, which needs only `postsFiles`, ruling 535, and whose saved files are the delivery); false = run as supporting (review). Null derives it from the profile's grants and the task's current deliverer." },
          toStageId: { type: ["string", "null"], description: "For transition_stage, else null." },
          packetType: { type: ["string", "null"], enum: ["input", "blocked", null], description: "For open_packet: 'blocked' when work is stuck, 'input' for a decision; else null." },
          // Ruling 492: `set_goal` drafts the task's goal in `text`, so this
          // field is one of the doors that write a goal.
          text: { type: ["string", "null"], description: "For post_comment: the comment text (narration the HUMANS read, which starts no agent, so an @name in it reaches nobody); put a question or directive to an agent with run_agent instead. For open_packet: the packet title; for run_agent: the agent's directive (posted as your hand-off comment; null for a bare re-run); for flag_context_conflict: the one-or-two-sentence detail of what each side says; for correct_knowledge_doc: what the document should say in place of `reason`'s passage, in the document's own form (the corrected fact, not the evidence), an empty string to delete that passage (ruling 581), or the missing convention (ruling 418); for lease_files: why this task holds the paths, which every task the lease refuses is shown; for schedule_task_action: the steer for your own re-run, or the agent's directive (under 4000 characters); for relay_to_task: what to post on the other task, whole, since it is what that task reads; for take_from_task: optional, one line on what the files are for, on the comment that claims them here (an @name in it is notified), or null for the default line; for set_goal: the drafted goal, scope plus acceptance criteria, whose done signal follows the rule below; for write_completion_packet: the summary a person reads before accepting (ruling 521), what was done against the goal and why it is complete, outcome first, in markdown, never restating a verdict or pasting a diff; else null. " + DONE_SIGNAL_RULE },
          reason: { type: ["string", "null"], description: "Short why: recommendation-card reasoning (for a transition_stage that moves the task, shown on the move in its history), or the packet body for open_packet. For write_completion_packet: your summary of the code changes by area, naming the files that matter, required when the snapshot's `completionPacket.changesSummaryRequired` is true (more than 200 changed lines), else null so the diff is shown whole. For correct_knowledge_doc: the passage the correction REPLACES, copied EXACTLY as the document has it (list marker and emphasis included; it must stand once in the document); null only to add `text` at the end of the document, such as a missing convention." },
          kbSource: { type: ["string", "null"], description: "For flag_context_conflict: the knowledge-base document that disagrees. For correct_knowledge_doc: the knowledge base and the document to correct as `<knowledge base>/<document>`, each named as the index names it (any knowledge base a run on this task was given, yours or an engaged agent's), or the document alone for the project's rulings knowledge base. Else null." },
          repoSource: { type: ["string", "null"], description: "For flag_context_conflict: the repository file that is authoritative. For correct_knowledge_doc: the EVIDENCE that proves the passage wrong or the convention missing: the exact command and its exit code or output, or the run and verdict that showed it (for a missing convention, the reviewer's verdict). Else null." },
          blockedBy: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "For set_dependencies ONLY: the FULL list of what this task waits on, as task keys (`JC-6`) in this project; an empty array clears the wait. Null for every other tool.",
          },
          // Ruling 503: the epic set_epic puts this task in.
          epicId: {
            type: ["string", "null"],
            description: "For set_epic ONLY (ruling 503): the epic to put THIS task in (`epic-3`, from the snapshot's `openEpics`), or \"\" to take it out of its epic. A task is in at most one epic, and membership holds and orders nothing: what it waits on is set_dependencies. Null for every other tool.",
          },
          paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "For lease_files ONLY (ruling 417): the path globs to lease to THIS task until it merges, as narrow as the shared files (`*` within one segment, `**` across segments), and put the reason in `text`. First come, first served: a path another active task already holds is refused by name. Null for every other tool.",
          },
          // Ruling 487: when a scheduled run fires, and which one to cancel.
          dueAt: {
            type: ["string", "null"],
            description: "For schedule_task_action ONLY (ruling 487): the instant the run fires, as an ISO timestamp, between 1 minute and 28 days out. Give this or `delayMinutes`. Use it for a wait a clock explains: just after the cron run, the window reopening, the deploy landing. Null for every other tool.",
          },
          delayMinutes: {
            type: ["number", "null"],
            description: "For schedule_task_action ONLY (ruling 487): minutes from now (1 to 40320) instead of `dueAt`. Null for every other tool.",
          },
          scheduleId: {
            type: ["string", "null"],
            description: "For cancel_task_schedule ONLY (ruling 487): the pending entry to cancel (`schedules[].id` in the snapshot); only one marked `yours` is yours to cancel. Null for every other tool.",
          },
          commentAt: {
            type: ["string", "null"],
            description: "For edit_comment ONLY (ruling 584): the time of a comment the operator or an agent wrote on THIS task, exactly as the timeline gives it. Use it yourself, without asking anyone and without saying so on the task, when a comment should not stand as written: it states an expected answer or a golden entry's configuration agents on a benchmark must not read, holds a secret, or misleads the next run. `text` is the words that replace it in full (null deletes it) and `reason` why, for the audit log. A person's comment is refused. Null for every other tool.",
          },
          // Ruling 488: the task a relay posts on.
          taskKey: {
            type: ["string", "null"],
            description: "For relay_to_task (ruling 488): ANOTHER task in this project to post `text` on, e.g. WEB-8. It lands there as your comment, that task's operator is woken with it, and this task's timeline records the relay, so never ask a person to copy text between tasks or to confirm it landed. Refused: another project, this task, a task that does not exist, a closed task. For take_from_task (ruling 557): the task in this project whose attachments to take onto this one, e.g. AWSC-3; it may be Done, not archived. Null for every other tool.",
          },
          // Ruling 538: the files a relay carries onto the other task.
          files: {
            type: ["array", "null"],
            description: "For relay_to_task (ruling 538): names of THIS task's attachments to put on the other task with the text, exactly as this task lists them (an input that task works from, a file it is to judge). They land on its attachments, where its agents read them. Null for a relay of text alone. For take_from_task (ruling 557): names of the OTHER task's attachments to put on THIS task, exactly as it lists them: only what this task works from, never a file that task keeps from this one (an answer key). Use it instead of asking a person to attach or carry a file. Null for every other tool.",
            items: { type: "string" },
          },
          // Ruling 521: the images write_completion_packet puts on the packet.
          screenshots: {
            type: ["array", "null"],
            description: "For write_completion_packet ONLY (ruling 521): up to 6 image attachments of this task that show the result, by exact file name from the snapshot's `completionPacket.screenshotCandidates`, each with a one-line caption of what it shows. Null when nothing visible changed, and for every other tool.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                caption: { type: ["string", "null"] },
              },
              required: ["name", "caption"],
            },
          },
          completeness: {
            type: ["boolean", "null"],
            description: "For run_agent ONLY (ruling 421): true when this run puts ruling 410's completeness question to a reviewer (name EVERYTHING it would still block on, including anything it would hold for a later round), whether on its own or folded into the review of a fresh rework. Viberr records the verdict that run returns as the reviewer's complete set, so a later deadlock packet recommends one rework against it instead of asking again. Null for every other run and every other tool.",
          },
          noVerdict: {
            type: ["boolean", "null"],
            description: "For run_agent ONLY (ruling 583): true whenever this run must not judge: a verdict-capable agent run for its knowledge-base corrections or its files on a task a person closes by force-accept, or a question put before any verdict. Viberr withholds its verdict and reads nothing it writes as one; a directive saying \"record no verdict\" is not enforced without it. Null for every other run and every other tool.",
          },
          // P11-27: let the Codex operator AUTHOR the packet's option set from its
          // own reasoning (2–4 options), instead of always getting the canned
          // default set. Null → use the packet type's default options.
          packetOptions: {
            type: ["array", "null"],
            description: "For open_packet ONLY: 2 to 4 options the human chooses from, mark exactly one recommended; null to use the packet type's defaults.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...PACKET_OPTION_KINDS] },
                title: { type: "string" },
                detail: { type: ["string", "null"], description: "One concise line of extra context for this option; null if none." },
                recommended: { type: "boolean" },
                reply: {
                  type: ["boolean", "null"],
                  description: "redirect and request_edit only (ruling 650): true when choosing this option means nothing without the person's own words, what to change or what to tell the agent. The card then requires them and an empty confirm is refused. Dropped on every other kind. Null otherwise.",
                },
                // B1: the retry target used to be unexpressible here, so every
                // Codex-authored retry resolved to Claude — a re-run of the
                // backend that had just failed. Null keeps the server default
                // (the OTHER backend than the one that failed).
                backend: {
                  type: ["string", "null"],
                  enum: ["claude", "codex", null],
                  description:
                    "retry_other_backend only: the backend to re-run the failed agent on; it must be the OTHER one. Null lets the server pick the opposite of the backend that failed.",
                },
                // Ruling 409 (F39-36): this said "retry_other_backend only" while
                // ruling 237 REFUSES a `question_reviewer` option that has no
                // profileId. Live on ax-clone AX-18 the operator reached for
                // exactly that option, read this description, correctly left
                // the field null, and was refused twice -- then the task was
                // stranded and a human had to act. Two kinds need it, so both
                // are named.
                profileId: {
                  type: ["string", "null"],
                  description:
                    "TWO kinds need this, null on every other. `retry_other_backend`: the agent profile to re-run (null re-runs the agent whose run failed). `question_reviewer`: REQUIRED, the profileId of the reviewer the question is put to, which must be a reviewer this task actually has (`reviewers[].profileId`); an option without it is refused, because the resolution would promise \"ask X\" and have nobody to start.",
                },
                deleteBranch: {
                  type: ["boolean", "null"],
                  description:
                    "archive_task only: true = ALSO delete the task's remote branch (discard the rejected work). Null otherwise.",
                },
                // Ruling 164 (pass 35, F35-14): a move_stage option names the
                // stage its resolution moves the task to. Without it the
                // Codex operator could author the kind and the confirm would
                // have nowhere to move.
                toStage: {
                  type: ["string", "null"],
                  description:
                    "move_stage only: the stage id this option moves the task to. Null on every other kind. The terminal stage is refused (moving there accepts the completion).",
                },
                // Ruling 138: the goal editor opens with this text when the
                // human confirms an edit_goal option, so it is written AS a
                // goal, never as an instruction to the human.
                goalDraft: {
                  type: ["string", "null"],
                  description:
                    "edit_goal only: the proposed goal text itself, written AS a goal (the deliverable plus its acceptance criteria); it is what the goal editor opens with when the human confirms. Without it the editor prefills the option's title and detail verbatim, so never phrase those as an instruction to the human. Null on every other kind. " +
                    DONE_SIGNAL_RULE,
                },
                // Ruling 433 (F39-55): ruling 270 gave the Claude tool the
                // payloads of rulings 224, 230 and 269, and this schema never
                // got them. A Codex operator could name the three kinds, was
                // refused for the missing payload, and had no field to send
                // it in. Live on ax-clone: AX-4 twice, AX-27 once.
                blockedBy: {
                  type: ["array", "null"],
                  items: { type: "string" },
                  description:
                    "block_on_dependencies only (ruling 230): what THIS task waits on, as task keys. Required on that kind, since an option that names nothing to wait on resolves into a hold that releases on nothing. Null on every other kind. Not the action-level blockedBy, which is set_dependencies'.",
                },
                dueAt: {
                  type: ["string", "null"],
                  description:
                    "wait_for_window only (ruling 224): the instant the provider said its window reopens, as an ISO timestamp. The resolution schedules the re-dispatch just after it. Required on that kind; null on every other. Viberr raises the quota packet itself, so author one only when no packet was raised.",
                },
                newTask: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  description:
                    "create_task only (ruling 269): the task the person's confirm CREATES, under their own authority. Use it for work that belongs outside this task (another owner's package, a contract nobody produces, a gap a report named), instead of an option whose text tells the reader to create a task. " +
                    CREATE_TASK_BASE_NOTE +
                    " Required on that kind; null on every other.",
                  properties: {
                    title: { type: "string", description: "The new task's title." },
                    goal: {
                      type: "string",
                      description:
                        "The new task's goal, written AS a goal (deliverable plus acceptance criteria). It is the contract whoever works it is held to. " +
                        DONE_SIGNAL_RULE,
                    },
                    blockedBy: {
                      type: ["array", "null"],
                      items: { type: "string" },
                      description: "What the NEW task waits on (task keys), not what this task waits on. Null for nothing.",
                    },
                    blocks: {
                      type: ["array", "null"],
                      items: { type: "string" },
                      description:
                        "Ruling 287: the EXISTING tasks that must wait on the new one, usually the direction that matters, since a task is created to unblock something. Each key gets the new task added to its own blockedBy when the person confirms. This task's own key belongs here whenever it is the work that must wait (ruling 322). Null for none.",
                    },
                    labels: { type: ["array", "null"], items: { type: "string" }, description: "Labels for the new task; null for none." },
                  },
                  required: ["title", "goal", "blockedBy", "blocks", "labels"],
                },
              },
              required: ["kind", "title", "detail", "recommended", "reply", "backend", "profileId", "deleteBranch", "toStage", "goalDraft", "blockedBy", "dueAt", "newTask"],
            },
          },
        },
        required: ["tool", "profileId", "delivers", "toStageId", "packetType", "text", "reason", "packetOptions", "kbSource", "repoSource", "blockedBy", "epicId", "paths", "files", "screenshots", "completeness", "noVerdict", "dueAt", "delayMinutes", "scheduleId", "commentAt", "taskKey"],
      },
    },
  },
  required: ["reasoning", "actions"],
  } as const;
}

/**
 * Runtime mirror of OPERATOR_PLAN_SCHEMA. Structured output constrains the
 * model, but persisted/provider output still crosses a trust boundary: reject
 * missing nullable fields, unknown tools, wrong types, and extra properties
 * before any governed action can run.
 */
const operatorPlanActionSchema = z.strictObject({
  tool: z.enum(OPERATOR_PLAN_TOOLS),
  profileId: z.string().nullable(),
  delivers: z.boolean().nullable(),
  toStageId: z.string().nullable(),
  packetType: z.enum(OPERATOR_PACKET_TYPES).nullable(),
  text: z.string().nullable(),
  reason: z.string().nullable(),
  // F-P6 (pass 25): the two sides of a KB-vs-repo conflict. Tolerated as ABSENT
  // (not just null) so plans persisted before these fields existed still replay.
  kbSource: z.string().nullable().optional(),
  repoSource: z.string().nullable().optional(),
  // Ruling 131: set_dependencies — the FULL list; `.optional()` so plans
  // persisted before the field existed still replay across a restart-resume.
  blockedBy: z.array(z.string()).nullable().optional(),
  // Ruling 503: set_epic's epic — `.optional()` for the same replay reason.
  epicId: z.string().nullable().optional(),
  // Ruling 417: lease_files — `.optional()` so plans persisted before the
  // field existed still replay across a restart-resume.
  paths: z.array(z.string()).nullable().optional(),
  // Ruling 521: write_completion_packet's images — `.optional()` for the same
  // replay reason.
  screenshots: z
    .array(z.strictObject({ name: z.string(), caption: z.string().nullable() }))
    .nullable()
    .optional(),
  // Ruling 421: run_agent's completeness question — `.optional()` for the same
  // replay reason.
  completeness: z.boolean().nullable().optional(),
  // Ruling 583: run_agent's no-verdict switch, `.optional()` for the same
  // replay reason.
  noVerdict: z.boolean().nullable().optional(),
  // Ruling 487: schedule_task_action's time and cancel_task_schedule's entry —
  // `.optional()` for the same replay reason.
  dueAt: z.string().nullable().optional(),
  delayMinutes: z.number().nullable().optional(),
  scheduleId: z.string().nullable().optional(),
  // Ruling 584: edit_comment's comment, `.optional()` for the same replay reason.
  commentAt: z.string().nullable().optional(),
  // Ruling 488: relay_to_task's target — `.optional()` for the same replay
  // reason.
  taskKey: z.string().nullable().optional(),
  // Ruling 538: the files a relay carries — `.optional()` for the same reason.
  files: z.array(z.string()).nullable().optional(),
  packetOptions: z
    .array(
      z.strictObject({
        kind: z.enum(PACKET_OPTION_KINDS),
        title: z.string(),
        detail: z.string().nullable(),
        recommended: z.boolean(),
        // Tolerated as ABSENT too (not just null): plans persisted before these
        // fields existed must stay executable across a restart-resume.
        reply: z.boolean().nullable().optional(),
        backend: z.enum(["claude", "codex"]).nullable().optional(),
        profileId: z.string().nullable().optional(),
        deleteBranch: z.boolean().nullable().optional(),
        toStage: z.string().nullable().optional(),
        goalDraft: z.string().nullable().optional(),
        // Ruling 433: `.optional()` for the same replay reason.
        blockedBy: z.array(z.string()).nullable().optional(),
        dueAt: z.string().nullable().optional(),
        newTask: z
          .strictObject({
            title: z.string(),
            goal: z.string(),
            blockedBy: z.array(z.string()).nullable().optional(),
            blocks: z.array(z.string()).nullable().optional(),
            labels: z.array(z.string()).nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .nullable(),
});

const operatorPlanRuntimeSchema = z.strictObject({
  reasoning: z.string(),
  actions: z.array(operatorPlanActionSchema),
});

type OperatorPlan = z.infer<typeof operatorPlanRuntimeSchema>;

/**
 * Normalize the Codex operator's AUTHORED packet options (P11-27) into the shape
 * `operatorOpenPacket` expects, or null when it supplied nothing usable (empty,
 * or every option lacked a title) — the caller then falls back to the type's
 * default set. Caps at 4 options and ensures exactly one is marked recommended
 * (the first, if the model marked none or several).
 */
export function authoredPacketOptions(
  authored:
    | {
        kind: PacketOptionKind;
        title: string;
        detail?: string | null;
        recommended: boolean;
        reply?: boolean | null;
        backend?: RealBackend | null;
        profileId?: string | null;
        deleteBranch?: boolean | null;
        toStage?: string | null;
        goalDraft?: string | null;
        blockedBy?: string[] | null;
        dueAt?: string | null;
        newTask?: {
          title: string;
          goal: string;
          blockedBy?: string[] | null;
          blocks?: string[] | null;
          labels?: string[] | null;
        } | null;
      }[]
    | null,
): OperatorPacketOptionInput[] | null {
  if (!authored || authored.length === 0) return null;
  // Filter+cap FIRST, then locate the recommended within the KEPT set — an
  // earlier empty-title option (dropped here) would otherwise shift the raw
  // index and mark the wrong kept option recommended.
  const kept = authored.filter((o) => o.title.trim() !== "").slice(0, 4);
  if (kept.length === 0) return null;
  const recIdx = kept.findIndex((o) => o.recommended);
  return kept.map((o, i) => {
    const detail = o.detail?.trim();
    const profileId = o.profileId?.trim();
    const option: OperatorPacketOptionInput = { kind: o.kind, title: o.title.trim() };
    // Carry the per-option detail line so a Codex-authored packet renders with
    // the same context a Claude-authored one does (AO-5 #12).
    if (detail) option.detail = detail;
    // Ruling 650: `operatorOpenPacket` keeps it on redirect and request_edit.
    if (o.reply) option.reply = true;
    // Ruling 138: the proposed goal rides with the option; `operatorOpenPacket`
    // caps it and refuses it on any kind but edit_goal.
    const goalDraft = o.goalDraft?.trim();
    if (goalDraft) option.goalDraft = goalDraft;
    option.recommended = i === (recIdx >= 0 ? recIdx : 0);
    // B1: retry_other_backend only. An omitted backend is NOT defaulted here —
    // `operatorOpenPacket` fills in the opposite of the backend that failed,
    // so the Claude tool path and this one land on the same rule.
    if (o.backend) option.backend = o.backend;
    if (profileId) option.profileId = profileId;
    // archive_task only — any other kind ignores it at resolution, so gating
    // here would just second-guess the resolver.
    if (o.deleteBranch) option.deleteBranch = true;
    // Ruling 164: move_stage carries its target; `operatorOpenPacket` refuses
    // it on any other kind and validates the stage id against the board.
    const toStage = o.toStage?.trim();
    if (toStage) option.toStage = toStage;
    // Ruling 433: the payloads rulings 230, 224 and 269 require, carried the
    // way the Claude tool carries them (ruling 270). `operatorOpenPacket`
    // refuses each off its kind and its kind without it.
    if (o.blockedBy?.length) option.blockedBy = [...o.blockedBy];
    const dueAt = o.dueAt?.trim();
    if (dueAt) option.dueAt = dueAt;
    if (o.newTask) {
      const newTask: NonNullable<OperatorPacketOptionInput["newTask"]> = {
        title: o.newTask.title.trim(),
        goal: o.newTask.goal.trim(),
      };
      if (o.newTask.blockedBy?.length) newTask.blockedBy = [...o.newTask.blockedBy];
      if (o.newTask.blocks?.length) newTask.blocks = [...o.newTask.blocks];
      if (o.newTask.labels?.length) newTask.labels = [...o.newTask.labels];
      option.newTask = newTask;
    }
    return option;
  });
}

function defaultPacketOptions(
  packetType: "input" | "blocked",
): OperatorPacketOptionInput[] {
  // R20-1 (F20-5): every "blocked" label says exactly what will happen. The old
  // "…and unblock" recorded a HOLD and re-accepted the same confirm forever;
  // now each option resolves the packet, and the two active ones re-run.
  // Ruling 130(c) (pass 34, F34-12): the stock re-run option asserts only what
  // the human says. It used to read "I've updated the policy / credential",
  // was recommended for a run that died of a spent usage window, and its
  // record ("policy / credential updated") led an operator to tell a
  // specialist that a GitHub-scope block had been lifted when nothing had.
  // A FAILED run's packet never uses this set: `escalateFailedOperatorRun`
  // asks `describeRunFailure` for options that name the classified cause.
  return packetType === "blocked"
    ? [
        {
          kind: "block_on_policy",
          title: "Re-run the operator now",
          detail:
            "Closes this decision and starts a fresh operator run. If it fails again you get a new decision packet.",
          recommended: true,
          ev: "**Decision:** re-run the operator. No policy or credential was changed.",
        },
        {
          kind: "redirect",
          title: "Redirect the specialist with new guidance",
          detail:
            "Closes this decision and re-runs the operator with your note as its steer.",
        },
        {
          kind: "hold_runtime_debug",
          title: "Hold: pause coordination while I inspect the session",
          detail:
            "Closes this decision and starts NO run. The task stays blocked and waiting on you; use Run operator when you are ready.",
        },
      ]
    : [
        { kind: "request_edit", title: "Send back to the specialist for changes", recommended: true },
        { kind: "redirect", title: "Reassign or redirect the work" },
        // B-OP4: a genuine multi-way decision rarely fits "send back" or
        // "redirect". Without a free-form path the fallback card forced the
        // human to pick a wrong option or leave the packet open, so the
        // resolver's own words become the operator's next steer.
        {
          kind: "custom",
          title: "Something else: say what should happen",
          detail: "Your note becomes the operator's instruction for the next turn.",
        },
      ];
}

async function startCodexOperatorRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  leaseKey: string,
  leaseToken: OperatorLeaseEntry,
  /** R19-1: what this run can really see of the repository. */
  workspace: OperatorWorkspaceView,
  /** R21-4: the identity (and any reserved row) claimed before the clone. */
  start: OperatorRunStart,
): Promise<RunOperatorResult> {
  // Ruling 415: this operator returns a plan and cannot call tools, so the
  // snapshot carries content where it would otherwise carry an address.
  const snapshot = operatorSnapshot(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    authority,
    OPERATOR_TIMELINE_DEFAULT,
    { toolless: true },
  );
  // P14-RT-04 / KM-02: the operator's DECLARED org MCP servers mount on Codex
  // too. P13-KM-03 wired them into the Claude toolkit only, so the same grant
  // was real on one backend and decorative on the other — a Codex operator could
  // not call the read tools that would inform its plan. The CLI translation
  // drops credentials and stamps approve-mode (codex-runtime). The CLI, not
  // the operator's shell, connects to MCP servers, and since ruling 185 no OS
  // sandbox sits between either of them and the network.
  // Resolved BEFORE the persona (B8) so the prompt describes what MOUNTS.
  // F21-3: that resolve now pre-flights the stdio mounts, so "what mounts" is
  // what actually starts, not what the registry row remembers.
  // Ruling 127: which is why a REFUSED drive skips it — the pre-flight starts
  // each stdio server to handshake it and corrects its registry row, real
  // child processes and org-level writes for a run that will never exist. The
  // same posture `ensureOperatorRepoCheckout` already takes above.
  const mcp = start.principal.ok
    ? await operatorMcpResolution(db, authority.mcps)
    : NO_OPERATOR_MCPS;
  // Pass-24 B-1 (owner ruling): the Codex operator's cwd is a dedicated empty
  // scratch folder, so the directory it works in does NOT contain `task.md` or
  // the shared deliverer checkout. Nothing refuses a write to either (ruling
  // 185: `danger-full-access`); the prompt describes that posture as a rule.
  const scratchDir = ensureOperatorScratchDir(taskFileRef(input));
  const promptBuild = buildOperatorSystemPrompt(
    authority,
    input.dataRoot,
    mcp,
    workspace,
    /* isolatedWritableRoot */ true,
    // A Codex operator mounts no in-process Viberr tools at all — the plan
    // envelope IS its action surface, so the actions its policy allows are the
    // honest answer to "what could this run do".
    operatorPlanToolsFor(authority),
  );
  const prompt = buildCodexOperatorPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
    input.agentReply,
    input.humanCommentBy,
    transitionContextOf(input),
    input.scheduleNote,
    input.resolvedOption,
    input.planRefusedNudge
      ? "plan-refused"
      : input.refreshNudge
        ? "refresh-ended"
        : input.strandedResume,
    input.dependencyRelease,
    input.refusedPlanSteps,
    input.scheduledByOperator,
    input.relay,
  );
  const orgMcpServers = mcp.servers;

  const spec: StartRunInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: start.threadId,
    role: "Operator",
    kind: "operator",
    backend: "codex",
    model: authority.model,
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    systemPrompt: promptBuild.prefix,
    // Pass-24 B-1: root the run at the scratch folder, NOT the task dir (the
    // default) — that keeps `task.md` and the deliverer checkout out of its
    // cwd. It is placement, not confinement: the thread is `danger-full-access`.
    workdir: scratchDir,
    // R19-1: the same read-only policy the Claude operator carries. Codex has no
    // denylist channel and, since ruling 185, no OS sandbox, so the read-only
    // half does not bind there; a withheld web grant still does, because
    // `startRun` derives `webSearchWithheld` from this list (as it does
    // `repoWriteWithheld`). The spec STATES the run's policy rather than
    // leaving it implicit in the runtime's kind lookup.
    disallowedTools: operatorDisallowedTools(authority),
    // P13-RT-03: advertise only the actions this operator's policy permits.
    outputSchema: operatorPlanSchemaFor(authority),
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    dataRoot: input.dataRoot,
    // Ruling 127: the task owner's Codex account, or the refusal that says
    // why there is none.
    credentialUserId: start.principal.ok
      ? start.principal.principal.userId
      : refusedPrincipalUserId(start.principal.refusal),
  };
  if (!start.principal.ok) spec.principalRefusal = start.principal.refusal;
  // An absent effort leaves the SDK on its own default; an absent mcpServers
  // key is what the adapters read as "this run mounts none".
  if (authority.effort) spec.effort = authority.effort;
  if (Object.keys(orgMcpServers).length) spec.mcpServers = orgMcpServers;
  // Ruling 176: Codex sends these as each server's `disabled_tools`.
  if (mcp.toolDenials.length) spec.mcpToolDenials = mcp.toolDenials;
  // R21-4: adopt the row the human has been watching since before the clone,
  // instead of opening a second one beside it.
  if (start.reservation) spec.reservation = start.reservation;

  const { runId } = await startRun(db, spec);
  // Ruling 344: the coordinator discloses what it was given, like every other
  // run. Best-effort by construction (`recordRunInputs` swallows its own
  // failures) — a drive must never fail because its disclosure could not be
  // written.
  recordRunInputs(db, {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: start.threadId,
    backend: "codex",
    kind: "operator",
    dataRoot: input.dataRoot,
    inputs: {
      ...promptBuild.inputs,
      promptChars: prompt.length,
      // The operator's canonical state IS this prompt — `buildCodexOperatorPrompt`
      // opens with the same task snapshot a specialist gets as a separate
      // anchor block, because a Codex drive has no tool with which to read it.
      anchor: prompt,
      spendCapUsd: getMaxRunSpendUsd(db),
      directive: operatorTurnDirective(input),
    },
  });

  // When the run finishes, parse its decision plan and execute it through the
  // capability-gated operator-actions (so codex honors the exact same RBAC +
  // autonomy as the Claude tool-driven operator). The lease is released only
  // AFTER the plan finished executing — the run row is already `finished`
  // while the plan runs, which is exactly the window the process lease covers.
  const held = leaseState().held.get(leaseKey);
  if (held) held.runId = runId;
  registerRunCompletion(runId, (finished) => {
    // Provider output is only executable after a clean terminal completion.
    // A failed/interrupted turn may have persisted a syntactically valid
    // partial agent_message before it stopped; never treat that as a plan.
    // R20-3 (F20-4) / ruling 19, the half the Codex path never got: a run that
    // reached completion PROVES its model is usable on this account, and
    // clearing on a real success is the re-probe (there is no synthetic
    // check). The Claude operator's completion handler does this; this one did
    // not, so a `model_availability` row written by an earlier Codex failure
    // outlived the account change that fixed it and kept the model struck
    // through in the catalog until something else happened to clear it.
    if (finished.state === "finished") {
      const ranModel = getRun(db, finished.id)?.model ?? null;
      if (ranModel) clearModelMark(db, input.backend ?? "codex", ranModel);
    }
    const completion =
      finished.state === "finished"
        ? executeCodexPlan(db, ctx, input, authority, finished.id)
        : finished.state === "error"
          ? escalateFailedOperatorRun(db, ctx, input, authority, finished.id)
          : Promise.resolve();
    void completion
      .catch((error) => {
        logger.error("codex operator completion handling failed", {
          taskKey: input.taskKey,
          err: toError(error),
        });
      })
      .finally(() => releaseOperatorLease(db, leaseKey, leaseToken));
  }, db);

  logger.info("operator run started (codex structured output)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, queued: false, backend: "codex", autonomy: authority.autonomy };
}

/** Parse the complete structured response and validate it before execution. */
function parseOperatorPlan(text: string): OperatorPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const parsed = operatorPlanRuntimeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Boot recovery for a Codex operator turn whose plan never ran (P14-RT-08).
 *
 * `startCodexOperatorRun` executes the plan from an IN-PROCESS completion
 * callback. A restart between the run reaching `finished` and that callback
 * firing lost the whole coordination turn silently: the finished operator row is
 * invisible to `finalizeOrphanedRuns` (which wants running/queued) and to
 * `recoverUnreactedAgentRuns` (which filters `kind IN ('primary','reviewer')`),
 * so the task simply sat at waiting=agent with no packet, comment or error.
 *
 * Re-resolves the operator's CURRENT authority — the plan is re-gated by whatever
 * policy holds now, never by a snapshot from before the restart.
 */
export async function executeStrandedCodexPlan(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  ref: { projectSlug: string; taskKey: string; runId: string },
): Promise<boolean> {
  const authority = resolveOperatorAuthority(ctx, ref.projectSlug);
  // Take the SAME single-flight lease a live drive takes. Boot also re-invokes
  // the operator for orphan-finalized tasks, so a drive for this task can
  // already be running; executing a stranded plan beside it would double-drive
  // exactly what the lease exists to prevent. Releasing through the normal path
  // also settles the waiting flag and drains any queued trigger.
  const leaseKey = leaseKeyFor(ref.projectSlug, ref.taskKey);
  const lease = leaseState();
  if (lease.held.get(leaseKey)) {
    logger.info("stranded codex plan skipped: a live drive owns the task", {
      taskKey: ref.taskKey,
      runId: ref.runId,
    });
    return false;
  }
  const recoveryRef = taskFileRef({
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    dataRoot: ctx.dataRoot,
  });
  const leaseToken: OperatorLeaseEntry = {
    runId: ref.runId,
    backend: "codex",
    autonomy: authority.autonomy,
    ...recoveryRef,
    // No prior chain depth survives a restart, so the resume chain starts at 0
    // — it is still bounded by OPERATOR_TRANSITION_CHAIN_CAP from there.
    transitionDepth: 0,
    // B-OP3: the REAL stage this recovery starts from. It used to be null,
    // which switched the stranded-resume backstop off for every cross-boot
    // path — a task left at an `auto` stage by a plan that never ran came back
    // from the restart stamped "waiting on a human" with nothing for a human
    // to do. The stage is what makes "this drive did not move the task"
    // decidable; reading it here costs one file read.
    stageAtStart: readStageAtStart(recoveryRef, "stranded-plan-recovery"),
    // A cross-boot recovery is never itself the stranded resume's nudge — the
    // one-nudge accounting starts fresh after a restart, like the chain depth.
    strandedResume: false,
    ownRun: ctx.operatorRun ?? null,
  };
  lease.held.set(leaseKey, leaseToken);
  try {
    await executeCodexPlan(
      db,
      ctx,
      { ...recoveryRef, trigger: "manual" },
      authority,
      ref.runId,
    );
  } finally {
    releaseOperatorLease(db, leaseKey, leaseToken);
  }
  return true;
}

/** Execute a finished codex operator run's decision plan (capability-gated). */
async function executeCodexPlan(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  // Claim the turn BEFORE anything governed happens (P14-RT-08): this row is
  // the boot reconciler's idempotency marker (`OPERATOR_PLAN_EXECUTED_ACTION`,
  // run-recovery). Leading rather than following means a restart mid-plan leaves
  // the remainder unapplied instead of re-running actions that may already have
  // transitioned the stage or engaged an agent.
  recordAudit(db, {
    action: "runtime.operator.plan_executed",
    actor: SYSTEM_ACTOR,
    subjectKind: "run",
    subjectId: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { runId },
  });
  // This is machine-readable control data, not a timeline preview: use the
  // complete reply. replyTextForRun intentionally truncates at 1,200 chars and
  // appends prose, which corrupts otherwise-valid larger JSON plans.
  const text = fullReplyTextForRun(db, runId);
  const plan = text ? parseOperatorPlan(text) : null;
  if (!plan) {
    // An empty or unparseable plan is a HUMAN-VISIBLE failure, not a silent
    // no-op: nothing else covers an operator's own run (recovery only watches
    // specialist/reviewer runs), so without this the task simply sits with no
    // signal. Raise a blocked recovery packet through the operator's own gate.
    logger.warn("codex operator produced no usable plan; escalating", {
      taskKey: input.taskKey,
      runId,
      hadText: !!text,
    });
    const escalation = await operatorOpenPacket(
      db,
      ctx,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title: "Operator turn produced no actionable plan",
        body: text
          ? "The coordinating run replied, but its output was not a valid decision plan. Coordination is paused until a human re-engages the operator or redirects the task."
          : "The coordinating run finished without producing any output. Coordination is paused until a human re-engages the operator or redirects the task.",
        options: defaultPacketOptions("blocked"),
      },
      authority,
    ).catch((error) => {
      logger.error("codex no-plan escalation failed", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      return null;
    });
    // G6: `operatorOpenPacket` returns `{outcome:"denied"}` WITHOUT throwing
    // when `generate-packets` is withheld — and `.catch` only catches throws.
    // So an operator deployed with packet-generation off/human would emit an
    // unparseable turn and STRAND with no packet, no note, only a server-side
    // warn. Fall back to a direct `note` (as narrateRefusedActions does) so the
    // human sees why the operator went quiet even when it cannot open a packet.
    if (!escalation || escalation.outcome !== "done") {
      await writeOperatorNoPlanNote(db, ctx, input, !!text);
    }
    return;
  }
  // The plan's prose fields persist to the timeline / packets — repair
  // double-escaped `\n` sequences the model emitted inside its JSON strings
  // (finding #23: literal "\n" rendered verbatim in the UI).
  if (plan.reasoning) plan.reasoning = normalizeEscapedNewlines(plan.reasoning);
  for (const a of plan.actions) {
    if (a.text) a.text = normalizeEscapedNewlines(a.text);
    if (a.reason) a.reason = normalizeEscapedNewlines(a.reason);
  }
  const base = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  // Actions narrate themselves. Only a reply-only plan needs its reasoning
  // copied to the timeline.
  if (plan.actions.length === 0 && plan.reasoning) {
    await operatorPostComment(db, ctx, { ...base, text: plan.reasoning }, authority);
  }
  // P13-RT-03: every governed action returns `{outcome, message}` and this
  // executor used to DISCARD all of them. A plan whose actions were all denied
  // therefore left no trace whatsoever — the reasoning isn't posted either
  // (`plan.actions.length !== 0`), so a billed run, a taken-and-released lease
  // and a board flip back to "waiting on you" were indistinguishable from the
  // operator deciding to do nothing. Collect the refusals and narrate them.
  //
  // The two refusal SHAPES are kept apart (see OperatorActionResult): `denied`
  // is an authority refusal, `noop` is the task's state (or a malformed step)
  // ruling the action out. Filing them under one "refused by its capability
  // policy" banner told humans the project's policy blocked work it never
  // blocked — e.g. B3's "a decision packet is already open", which the
  // operator had every capability to do and simply must not do twice.
  const refused: RefusedPlanStep[] = [];
  // R20-9 / ruling 84: the delegated-ask disclosure used to ride the CLAUDE
  // toolkit's `open_decision_packet` alone, so a CODEX plan whose actions were
  // `prompt_agent` then `open_packet` — the exact shape the ruling is about —
  // raised the human's decision with nothing said about the consultation. The
  // plan executor is the other packet writer, so it keeps the same ledger and
  // opens through the same shared writer.
  const consultedProfileIds: string[] = [];
  const record = (toolName: string, result: OperatorActionResult | undefined) => {
    if (!result) return;
    const refusal = planRefusalOf(toolName, result);
    if (refusal) {
      refused.push(refusal);
      return;
    }
    // Ruling 406: the drive acted. Stamped HERE, on the one funnel every plan
    // step already passes through, so a new action shape is covered the day it
    // is added instead of the day it is mistaken for a deliberate hold.
    // Ruling 443: a step whose outcome is the packet it opened acted too.
    if ((result.outcome === "done" || result.openedPacket) && ctx.operatorRun) {
      ctx.operatorRun.carriedOutAction = true;
    }
  };
  // B-6 (pass 24): OpenAI-strict structured output makes every plan field
  // present-but-nullable, so a step like `{tool:"transition_stage", toStageId:null}`
  // is schema-valid. The guarded arms below skip such a step — narrate the skip
  // instead of dropping it, or a turn that named an action but filled none of its
  // fields reads to the human as an operator that silently decided nothing.
  const skippedMalformed = (toolName: string, missing: string) => {
    refused.push({ tool: toolName, message: `plan step omitted ${missing}`, kind: "state" });
  };
  // Ruling 430 (F39-52): a plan is written whole, before any step runs, so it
  // cannot see a decision one of its own steps puts in front of a person. Live
  // on AX-21 (01:18): `update_branch_from_base` met a conflict and opened the
  // blocking conflict packet, and the next step still dispatched the Surface
  // Developer with "The operator has updated the branch from the changed
  // base; start from that branch", about a branch the refresh had left
  // exactly as it was. Once the task holds a packet it did not hold when the
  // plan began, the steps that ACT are not carried out; a comment still posts.
  const packetKeyOf = (): string | null => {
    const packet = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.packet;
    return packet ? (packet.id ?? packet.title) : null;
  };
  const packetAtStart = packetKeyOf();
  let pausedBy: { tool: string; title: string } | null = null;
  const pausedSteps: string[] = [];
  for (const a of plan.actions) {
    // Ruling 488: a relay is a comment on another task, whose decision this
    // task's new packet does not hold, so it still posts like one.
    if (pausedBy && a.tool !== "post_comment" && a.tool !== "relay_to_task") {
      pausedSteps.push(a.tool);
      continue;
    }
    try {
      switch (a.tool) {
        case "post_comment":
          if (a.text) {
            record(
              a.tool,
              await operatorPostComment(db, ctx, { ...base, text: a.text }, authority),
            );
          } else skippedMalformed(a.tool, "the comment text");
          break;
        case "open_packet": {
          const packetType = a.packetType === "blocked" ? "blocked" : "input";
          if (a.text) {
            const packet: OperatorOpenPacketInput = {
              ...base,
              packetType,
              title: a.text,
              // P11-27: honor the operator's authored options when it supplied
              // a usable set (2–4); else fall back to the type's defaults.
              options: authoredPacketOptions(a.packetOptions) ?? defaultPacketOptions(packetType),
            };
            if (a.reason) packet.body = a.reason;
            record(
              a.tool,
              await operatorOpenPacketDisclosed(
                db,
                ctx,
                packet,
                authority,
                consultedProfileIds,
              ),
            );
          } else skippedMalformed(a.tool, "the packet title");
          break;
        }
        case "set_dependencies": {
          // Ruling 131(b): the plan mirror of the Claude tool. A null list is
          // a malformed step (state), never a policy refusal.
          if (a.blockedBy) {
            const wait: Parameters<typeof operatorSetDependencies>[2] = {
              ...base,
              blockedBy: a.blockedBy,
            };
            if (a.reason) wait.reason = a.reason;
            record(a.tool, await operatorSetDependencies(db, ctx, wait, authority));
          } else skippedMalformed(a.tool, "the list of what the task waits on");
          break;
        }
        case "set_epic": {
          // Ruling 503: the plan mirror of the Claude tool. "" takes the task
          // out of its epic; a null epic is a malformed step.
          if (a.epicId != null) {
            const move: Parameters<typeof operatorSetEpic>[2] = {
              ...base,
              epicId: a.epicId.trim() || null,
            };
            if (a.reason) move.reason = a.reason;
            record(a.tool, await operatorSetEpic(db, ctx, move, authority));
          } else skippedMalformed(a.tool, "the epic");
          break;
        }
        case "run_agent":
          // The plan mirror of the toolkit's one dispatch tool: select + run,
          // optional `text` as the directive, optional `delivers` hand-off.
          if (a.profileId) {
            const dispatch: Parameters<typeof operatorDispatchAgent>[2] = {
              ...base,
              profileId: a.profileId,
            };
            // Ruling 446 (F39-70): the directive travels with what this plan's earlier steps
            // were refused, which the narration below only writes after the
            // agent has started.
            if (a.text) dispatch.prompt = withEarlierRefusals(a.text, refused);
            if (a.delivers != null) dispatch.delivers = a.delivers;
            if (a.reason) dispatch.reason = a.reason;
            if (a.completeness) dispatch.completeness = true;
            if (a.noVerdict) dispatch.noVerdict = true;
            const dispatched = await operatorDispatchAgent(db, ctx, dispatch, authority);
            // R20-9: only a dispatch that actually LANDED is a consultation — a
            // denied or no-op one consulted nobody (noteConsultedProfile).
            noteConsultedProfile(consultedProfileIds, a.profileId, dispatched.outcome);
            record(a.tool, dispatched);
          } else skippedMalformed(a.tool, "the agent to run");
          break;
        case "transition_stage":
          if (a.toStageId) {
            const move: Parameters<typeof operatorTransitionStage>[2] = {
              ...base,
              toStageId: a.toStageId,
            };
            if (a.reason) move.reason = a.reason;
            record(a.tool, await operatorTransitionStage(db, ctx, move, authority));
          } else skippedMalformed(a.tool, "the target stage");
          break;
        case "deliver_for_review": {
          const deliver: Parameters<typeof operatorDeliverForReview>[2] = { ...base };
          if (a.reason) deliver.reason = a.reason;
          const delivery = await operatorDeliverForReview(db, ctx, deliver, authority);
          // A failed delivery is a GitHub-state outcome performDelivery already
          // surfaced on the timeline in full (push conflict, no commits, PR
          // number) — repeating it as a bare "did not apply" line would be a
          // worse second copy of a story already told. Only the authority
          // refusal joins the report; the generalized authority/state split
          // above now handles every OTHER tool's state refusals, which used to
          // be the F15-15 misblame class this special case was alone in
          // dodging.
          if (delivery.outcome === "denied") record(a.tool, delivery);
          break;
        }
        case "update_branch_from_base":
          record(
            a.tool,
            await operatorUpdateBranchFromBase(db, ctx, base, authority),
          );
          break;
        case "accept_completion":
          record(a.tool, await operatorAcceptCompletion(db, ctx, base, authority));
          break;
        case "write_completion_packet":
          // Ruling 521: `text` is the summary, `reason` the summary of the
          // code changes.
          if (a.text) {
            const packet: Parameters<typeof operatorWriteCompletionPacket>[2] = {
              ...base,
              summary: a.text,
            };
            if (a.reason) packet.changes = a.reason;
            if (a.screenshots?.length) {
              packet.screenshots = a.screenshots.map((s) => ({ name: s.name, caption: s.caption }));
            }
            record(a.tool, await operatorWriteCompletionPacket(db, ctx, packet, authority));
          } else skippedMalformed(a.tool, "the summary");
          break;
        case "resolve_packet": {
          // The reason falls back to the step's prose; neither present leaves
          // the key off, which is what `operatorResolvePacket` reads as "none".
          const withdraw: Parameters<typeof operatorResolvePacket>[2] = { ...base };
          const withdrawReason = a.reason || a.text;
          if (withdrawReason) withdraw.reason = withdrawReason;
          record(a.tool, await operatorResolvePacket(db, ctx, withdraw, authority));
          break;
        }
        case "set_goal":
          // `text` carries the drafted goal.
          if (a.text) {
            const goal: Parameters<typeof operatorSetGoal>[2] = { ...base, goal: a.text };
            if (a.reason) goal.reason = a.reason;
            record(a.tool, await operatorSetGoal(db, ctx, goal, authority));
          } else skippedMalformed(a.tool, "the drafted goal text");
          break;
        case "flag_context_conflict":
          // F-P6 (pass 25): `kbSource`/`repoSource` name the two sides; `text` is
          // the detail. Same action Claude's tool calls — a typed `quality` event
          // + the R19-2 watcher notification, not a plain comment.
          if (a.kbSource && a.repoSource && a.text) {
            record(
              a.tool,
              await operatorFlagContextConflict(
                db,
                ctx,
                {
                  ...base,
                  kbSource: a.kbSource,
                  repoSource: a.repoSource,
                  detail: a.text,
                },
                authority,
              ),
            );
          } else {
            skippedMalformed(
              a.tool,
              "the KB source, the repo source, and the detail",
            );
          }
          break;
        case "correct_knowledge_doc":
          // F39-1/F39-7 (pass 39), rulings 483 and 498: `kbSource` is
          // `<kb>/<doc>` (or a bare rulings document), `text` what the document
          // should say, `reason` the exact passage it replaces, `repoSource`
          // the evidence that proves it. Reuses the plan's existing string
          // fields rather than growing the schema — the two knowledge-base-
          // shaped actions then read alike. Ruling 581: an empty `text` with a
          // `reason` deletes that passage.
          if (a.kbSource && (a.text || a.reason) && a.repoSource) {
            record(
              a.tool,
              await operatorCorrectKnowledgeDoc(
                db,
                ctx,
                {
                  ...base,
                  ...splitKbSource(a.kbSource, ctx.dataRoot),
                  replaces: a.reason ?? null,
                  text: a.text ?? "",
                  evidence: a.repoSource,
                },
                authority,
              ),
            );
          } else {
            skippedMalformed(
              a.tool,
              "the knowledge-base document, the text to write, and the evidence",
            );
          }
          break;
        case "lease_files": {
          // Ruling 417: `paths` are the globs, `text` (or `reason`) why.
          const why = a.text || a.reason;
          if (a.paths && a.paths.length > 0 && why) {
            record(
              a.tool,
              await operatorLeaseFiles(db, ctx, { ...base, paths: a.paths, reason: why }, authority),
            );
          } else {
            skippedMalformed(a.tool, "the paths to lease and the reason they are held");
          }
          break;
        }
        case "schedule_task_action": {
          // Ruling 487: `profileId` is the agent (null or "operator" is the
          // operator's own re-run), `dueAt`/`delayMinutes` the time, `text`
          // the steer. No time at all is refused by the action itself, in
          // the same sentence every schedule door uses.
          const when: Parameters<typeof operatorScheduleRun>[2] = {
            ...base,
            agent: a.profileId?.trim() || "operator",
          };
          if (a.dueAt) when.dueAt = a.dueAt;
          else if (a.delayMinutes != null) when.delayMinutes = a.delayMinutes;
          if (a.text) when.prompt = a.text;
          record(a.tool, await operatorScheduleRun(db, ctx, when, authority));
          break;
        }
        case "cancel_task_schedule":
          if (a.scheduleId) {
            record(
              a.tool,
              await operatorCancelSchedule(db, ctx, { ...base, scheduleId: a.scheduleId }, authority),
            );
          } else skippedMalformed(a.tool, "the schedule to cancel");
          break;
        case "relay_to_task":
          // Ruling 488: `taskKey` is the other task, `text` what lands there;
          // ruling 538: `files` what it carries with it.
          if (a.taskKey && a.text) {
            record(
              a.tool,
              await operatorRelayToTask(
                db,
                ctx,
                { ...base, toTaskKey: a.taskKey, text: a.text, files: a.files ?? [] },
                authority,
              ),
            );
          } else skippedMalformed(a.tool, "the task to relay to and the text");
          break;
        case "take_from_task":
          // Ruling 557: `taskKey` holds the files, `files` names them, `text`
          // is an optional line on what they are for.
          if (a.taskKey && a.files && a.files.length > 0) {
            const take: Parameters<typeof operatorTakeFromTask>[2] = {
              ...base,
              fromTaskKey: a.taskKey,
              files: a.files,
            };
            if (a.text) take.text = a.text;
            record(a.tool, await operatorTakeFromTask(db, ctx, take, authority));
          } else skippedMalformed(a.tool, "the task to take from and the files");
          break;
        case "edit_comment":
          // Ruling 584: `commentAt` names the comment, `text` replaces its
          // words (null deletes it), `reason` is why.
          if (a.commentAt && a.reason) {
            record(
              a.tool,
              await operatorEditComment(
                db,
                ctx,
                { ...base, at: a.commentAt, text: a.text ?? null, reason: a.reason },
                authority,
              ),
            );
          } else skippedMalformed(a.tool, "the comment's time and the reason");
          break;
      }
    } catch (error) {
      // ABORT the remaining plan on a governed-action failure: executing later
      // actions against a state the failed one never produced compounds the
      // damage (e.g. an accept_completion after a failed transition). The
      // failure is narrated on the timeline so the board shows what stopped.
      logger.error("codex operator action failed; aborting the remaining plan", {
        taskKey: input.taskKey,
        tool: a.tool,
        err: toError(error),
      });
      // F28-O1: narrate the abort DIRECTLY, NOT through the gated
      // `operatorPostComment` — for the same reason `narrateRefusedActions`
      // writes straight to the timeline. When the operator's `append-typed-
      // events` is withheld the gate returns `denied`/`noop` WITHOUT throwing,
      // so the `.catch()` never fired and the abort notice was silently
      // discarded, leaving an engaged-but-never-run agent (board "waiting on
      // you") with nothing but a server log to explain it. A coordination stall
      // is a `note`, not a governance signal.
      await narrateOperatorNote(db, ctx, input, "codex operator plan-abort narration failed", {
        type: "note",
        title: null,
        text: `**Coordination stopped:** the \`${a.tool}\` step failed (${errorMessage(error)}). The remaining plan was not executed.`,
      });
      break;
    }
    if (!pausedBy) {
      const now = packetKeyOf();
      if (now !== null && now !== packetAtStart) {
        const packet = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.packet;
        pausedBy = { tool: a.tool, title: packet?.title ?? "a decision" };
      }
    }
  }
  if (pausedBy && pausedSteps.length > 0) {
    await narratePausedPlan(db, ctx, input, pausedBy, pausedSteps);
  }
  await narrateRefusedActions(db, ctx, input, refused, plan.reasoning);
  // Ruling 228 (F37-47): stamp the case where the drive did NOTHING because
  // every step it planned was refused. The refusal messages are written to be
  // acted on ("Do not refresh it here; recommend or accept the completion
  // instead") and they arrive after the turn has ended, so without this nobody
  // reads them until a human notices the task has stopped. Live on SHOP-3, on
  // the very run the Codex window had just been waited three hours for: one
  // refused step, nothing else, and 25 minutes parked at Verify.
  //
  // `refused` holds one entry per non-running step (including malformed ones),
  // so equality with the plan length IS "nothing ran" — and a step that THREW
  // breaks the loop early, leaving the counts unequal, which is right: an abort
  // is narrated on its own terms and is not this.
  if (ctx.operatorRun && plan.actions.length > 0 && refused.length === plan.actions.length) {
    ctx.operatorRun.planWhollyRefused = true;
    // Ruling 400: the sentences, not just the flag. The retry quotes them.
    ctx.operatorRun.refusedPlanSteps = refused.map((r) => ({
      tool: r.tool,
      message: r.message,
    }));
  }
}

/**
 * An operator note written straight onto the timeline, then re-projected.
 * Never through the gated `operatorPostComment`: a report about what the
 * operator's plan did must not depend on the gates of the operator it reports
 * on. Never throws; a write that fails is logged as `failure`.
 */
async function narrateOperatorNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  failure: string,
  note: { type: "note" | "policy"; title: string | null; text: string },
): Promise<void> {
  try {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: note.type,
        actor: { kind: "operator" },
        title: note.title,
        text: note.text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  } catch (error) {
    logger.error(failure, {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 430: say which steps a new decision packet stopped, and why.
 *
 * Written directly, like `narrateRefusedActions`. Never throws; the plan
 * already ran.
 */
async function narratePausedPlan(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  pausedBy: { tool: string; title: string },
  steps: string[],
): Promise<void> {
  const list = steps.map((s) => `\`${s}\``).join(", ");
  await narrateOperatorNote(db, ctx, input, "codex operator plan-pause narration failed", {
    type: "note",
    title: "Coordination paused",
    text:
      `**Coordination paused:** the \`${pausedBy.tool}\` step left a decision for a person ` +
      `(“${pausedBy.title}”), so the rest of this plan was not carried out: ${list}. ` +
      "It was written before that decision existed. The operator picks the task up again once it is answered.",
  });
}

/** A plan step that did not run, and WHY it did not (see OperatorActionResult):
 *  `authority` = the capability policy (or ownership) refused it;
 *  `state` = the task's current state, or the step itself, ruled it out. */
export interface RefusedPlanStep {
  tool: string;
  message: string;
  kind: "authority" | "state";
}

/**
 * Ruling 443: what one plan step's result adds to the plan's refusals, if
 * anything. `denied` is a refusal by authority and `noop` one by state (the
 * LV-03 split), except a step whose outcome is the decision packet it opened.
 * Live on ax-clone AX-21, AX-28 and AX-5 a refresh that met a conflict was
 * narrated "This step did not apply to the task's current state" beside the
 * packet it had just opened. The step ran, and its outcome was the packet.
 */
export function planRefusalOf(
  toolName: string,
  result: OperatorActionResult,
): RefusedPlanStep | null {
  if (result.outcome !== "denied" && result.outcome !== "noop") return null;
  if (result.openedPacket) return null;
  return {
    tool: toolName,
    message: result.message,
    kind: result.outcome === "denied" ? "authority" : "state",
  };
}

/**
 * Ruling 446 (F39-70): a dispatch in a Codex plan carries the refusals the same plan has
 * already collected. A plan is written before any step runs, so a directive
 * can only say "if the lease is refused, ...". The note that answers it is
 * narrated after the plan's last step, when the agent is already running.
 * Live on ax-clone AX-5 the Developer was told "Do not modify any path the
 * lease action refuses" and was never told which paths those were: the note
 * naming them landed 46 ms after its run started.
 */
export function withEarlierRefusals(
  directive: string,
  refused: readonly { tool: string; message: string }[],
): string {
  if (refused.length === 0) return directive;
  const one = refused.length === 1;
  return (
    `${directive}\n\nViberr did not carry out ${one ? "this earlier step" : "these earlier steps"} ` +
    "of the operator's plan for this turn. Read the directive above against what actually " +
    `happened (${one ? "it is" : "each is"} Viberr's answer to the operator):\n` +
    refused.map((r) => `- \`${r.tool}\`: ${r.message}`).join("\n")
  );
}

/**
 * Put refused plan actions on the timeline (P13-RT-03).
 *
 * Written DIRECTLY as a timeline event rather than through
 * `operatorPostComment`, because the commonest refusal case is an operator
 * whose `append-typed-events` is itself withheld — routing the narration
 * through the gate would make the report of the silence silent too.
 *
 * The two shapes are named separately, and the EVENT TYPE follows: LV-03
 * reserves `policy` for genuine governance refusals, so a purely state-ruled
 * plan is a `note`. A run that stated "refused by its capability policy" over
 * "a decision packet is already open" (B3) accused the project's policy of
 * blocking work no policy blocked — and a `policy` event is what the activity
 * feed and the human read as a governance signal.
 *
 * Never throws: the plan already ran.
 */
async function narrateRefusedActions(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  refused: RefusedPlanStep[],
  reasoning: string,
): Promise<void> {
  if (refused.length === 0) return;
  const byAuthority = refused.filter((r) => r.kind === "authority");
  const byState = refused.filter((r) => r.kind === "state");
  const list = (steps: RefusedPlanStep[]) =>
    steps.map((r) => `- \`${r.tool}\`: ${r.message}`).join("\n");
  const were = (steps: RefusedPlanStep[]) =>
    steps.length === 1 ? "This step was" : "These steps were";
  const did = (steps: RefusedPlanStep[]) =>
    steps.length === 1 ? "This step did" : "These steps did";
  // One bucket → one sentence (the common case reads as prose). Mixed → two
  // labelled lists, because "refused" and "did not apply" are different facts
  // and a human acts on them differently.
  const body =
    byAuthority.length > 0 && byState.length > 0
      ? `Refused by its capability policy:\n\n${list(byAuthority)}\n\n` +
        `Did not apply to the task's current state:\n\n${list(byState)}`
      : byAuthority.length > 0
        ? `${were(byAuthority)} refused by its capability policy:\n\n${list(byAuthority)}`
        : `${did(byState)} not apply to the task's current state:\n\n${list(byState)}`;
  const text =
    // Ruling 408: the lead is a shared constant, because the next turn's carry
    // finds this note by it.
    `${PLAN_NOT_CARRIED_OUT_LEAD} ${body}` +
    (reasoning.trim()
      ? `\n\nWhat it intended:\n\n> ${reasoning.trim().replace(/\n/g, "\n> ")}`
      : "");
  logger.warn("codex operator plan actions did not run", {
    taskKey: input.taskKey,
    refusedByPolicy: byAuthority.map((r) => r.tool),
    refusedByState: byState.map((r) => r.tool),
  });
  await narrateOperatorNote(db, ctx, input, "codex operator refusal narration failed", {
    // LV-03: `policy` is a governance signal. Only an authority refusal is
    // one; a state conflict is a plain note.
    type: byAuthority.length > 0 ? "policy" : "note",
    title: null,
    text,
  });
}

/**
 * G6: last-resort note when the operator produced no usable plan AND could not
 * open the blocked recovery packet (its `generate-packets` capability is
 * withheld). Without this the task strands `waiting:human` with nothing on the
 * timeline. A plain `note` (not `policy`) — this is a coordination stall, not a
 * governance refusal — that tells the human to re-engage or redirect.
 */
async function writeOperatorNoPlanNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  hadText: boolean,
): Promise<void> {
  const text =
    "**The operator produced no actionable plan and could not open a recovery packet** " +
    "(packet generation is not available to it here). " +
    (hadText
      ? "Its run replied, but the output was not a valid decision plan. "
      : "Its run finished without producing any output. ") +
    "Coordination is paused: re-engage the operator or redirect the task.";
  await narrateOperatorNote(db, ctx, input, "codex no-plan note fallback failed", {
    type: "note",
    title: null,
    text,
  });
}

// ------------------------------------------------------- real (tool-driven)

async function startRealOperatorRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  leaseKey: string,
  leaseToken: OperatorLeaseEntry,
  /** R19-1: what this run can really see of the repository. */
  workspace: OperatorWorkspaceView,
  /** R21-4: the identity (and any reserved row) claimed before the clone. */
  start: OperatorRunStart,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  // B8: the persona describes the servers that MOUNT, not the grant list.
  // F21-3: resolved (and stdio-pre-flighted) ONCE, then handed to the toolkit —
  // a second resolve inside the toolkit would re-mount a server the pre-flight
  // had just dropped, so the prompt and the mount would disagree.
  // Ruling 127: skipped entirely on a refused drive, which spawns nothing —
  // the pre-flight would otherwise start every declared stdio server (and
  // rewrite its health row) for a run recorded as "no agent process was
  // started".
  const mcp = start.principal.ok
    ? await operatorMcpResolution(db, authority.mcps)
    : NO_OPERATOR_MCPS;
  const toolkitDeps: Parameters<typeof buildOperatorToolkit>[0] = {
    db,
    ctx,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    authority,
    orgMcpServers: mcp.servers,
  };
  // F21-21: offers `read_default_branch_file` — the anchored default-branch
  // read — only on a run that really holds a checkout to read it from.
  if (workspace.kind === "checkout") {
    toolkitDeps.workspace = {
      dir: workspace.dir,
      defaultBranch: workspace.defaultBranch,
    };
  }
  // Ruling 344: built BEFORE the prompt, because the prompt build now also
  // produces this run's input disclosure and the honest answer to "which tools"
  // is the names off these definitions — ruling 339's rule, which exists
  // because a hand-restated toolkit under-reported 460 specialist runs. Nothing
  // in the toolkit reads the prompt, so the order is free.
  const toolkit = buildOperatorToolkit(toolkitDeps);
  const promptBuild = buildOperatorSystemPrompt(
    authority,
    input.dataRoot,
    mcp,
    workspace,
    /* isolatedWritableRoot */ false,
    toolkit.tools.map((t) => t.name),
  );
  const prompt = buildOperatorTurnPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
    input.agentReply,
    input.humanCommentBy,
    transitionContextOf(input),
    input.scheduleNote,
    input.resolvedOption,
    input.planRefusedNudge
      ? "plan-refused"
      : input.refreshNudge
        ? "refresh-ended"
        : input.strandedResume,
    input.dependencyRelease,
    input.refusedPlanSteps,
    input.scheduledByOperator,
    input.relay,
  );

  const spec: StartRunInput = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: start.threadId,
    role: "Operator",
    kind: "operator",
    backend: "claude",
    model: authority.model,
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    systemPrompt: promptBuild.prefix,
    mcpServers: toolkit.mcpServers,
    allowedTools: toolkit.allowedTools,
    // R19-1: the operator's repository view is READ-ONLY — the write/shell
    // built-ins are denied for every operator run, and a withheld web grant
    // rides the same denylist.
    disallowedTools: operatorDisallowedTools(authority),
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    dataRoot: input.dataRoot,
    // Ruling 127: the task owner's Claude account, or the refusal that says
    // why there is none.
    credentialUserId: start.principal.ok
      ? start.principal.principal.userId
      : refusedPrincipalUserId(start.principal.refusal),
  };
  if (!start.principal.ok) spec.principalRefusal = start.principal.refusal;
  // An absent effort leaves the SDK on its own default.
  if (authority.effort) spec.effort = authority.effort;
  // Ruling 176: `startRun` denies each by name, after the toolkit's approvals.
  if (mcp.toolDenials.length) spec.mcpToolDenials = mcp.toolDenials;
  // R21-4: adopt the row the human has been watching since before the clone,
  // instead of opening a second one beside it.
  if (start.reservation) spec.reservation = start.reservation;

  const { runId } = await startRun(db, spec);
  // Ruling 344: the same disclosure the Codex drive and every specialist write.
  recordRunInputs(db, {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: start.threadId,
    backend: "claude",
    kind: "operator",
    dataRoot: input.dataRoot,
    inputs: {
      ...promptBuild.inputs,
      promptChars: prompt.length,
      // A Claude drive reads its canonical task state through `get_task`, so
      // the turn prompt is not an anchor block and this record must not claim
      // one. The prompt's own chars are disclosed above; `null` here is the
      // true answer and the console prints it as such.
      anchor: null,
      spendCapUsd: getMaxRunSpendUsd(db),
      directive: operatorTurnDirective(input),
    },
  });

  // The real operator coordinates DURING its run (in-proc MCP tools), so the
  // lease is held until the run reaches a terminal state. Chained (not
  // registered) so nothing can clobber it.
  const held = leaseState().held.get(leaseKey);
  if (held) held.runId = runId;
  chainRunCompletion(runId, (finished) => {
    // A real Claude operator run that ERRORS (crash / quota / auth / idle
    // timeout) was previously silent — the completion hook only released the
    // lease, so nothing reached the human (contrast the Codex no-plan
    // escalation and the specialist F8 path). Escalate it the same way (F-OP1).
    //
    // B5: the lease is released only AFTER the escalation has been written,
    // the same ordering the Codex path uses. Releasing first synchronously
    // fires `void runOperator(queued)`, so a successor drive read the snapshot
    // — and could open its own packet — while the blocked recovery packet was
    // still being written; whichever landed second silently replaced the other.
    // R20-3 (F20-4): a coordinating run that reached completion proves its model
    // is usable on this account — clear any stale unavailability mark (ruling
    // 19: clearing on a real success is the re-probe, no synthetic check).
    if (finished.state === "finished") {
      const ranModel = getRun(db, runId)?.model ?? null;
      if (ranModel) clearModelMark(db, input.backend ?? "claude", ranModel);
    }
    const completion =
      finished.state === "error"
        ? escalateFailedOperatorRun(db, ctx, input, authority, runId)
        : Promise.resolve();
    void completion
      .catch((error) => {
        logger.error("real operator completion handling failed", {
          taskKey: input.taskKey,
          err: toError(error),
        });
      })
      .finally(() => releaseOperatorLease(db, leaseKey, leaseToken));
  }, db);

  logger.info("operator run started (real)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, queued: false, backend: "claude", autonomy: authority.autonomy };
}

/**
 * F-OP1: surface a failed real operator run to the human. Nothing else covers
 * an operator's OWN run (run-recovery only watches specialist/reviewer runs),
 * so without this a crashed/quota-limited/idle-timed-out operator run leaves the
 * task sitting with no timeline entry, packet, or notification. Raise a blocked
 * recovery packet through the operator's own gate, with quota/auth-aware copy.
 */
async function escalateFailedOperatorRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  try {
    const failure = runFailureReason(db, runId);
    // Pass 34 review: the run was launched on the RESOLVED deployment backend
  // (`runOperator` reads `authority.backend`); `input.backend` is set only when
  // a caller overrides it from the Run-operator picker, so every machine
  // trigger fell back to "claude" and the packet named the wrong provider.
  const backend: RealBackend = authority.backend;
    // Ruling 130(b) (pass 34, F34-12): the ONE failure-to-words mapping. A
    // quota or credential refusal names the person whose account was refused
    // (ruling 127's credential principal, the task owner) and their own move:
    // wait until the reset instant, or connect a different account or an API
    // key on Profile → Agent accounts. The old body ended "Retry on the other
    // backend, fix the credential, or redirect the task" for EVERY kind and
    // recommended "I've updated the policy / credential"; the recorded
    // decision then lied about a fix nobody made.
    const ownerUserId =
      readTaskFile(taskFileRef(input))?.parsed.frontmatter.ownerUserId ?? null;
    const describeInput: DescribeRunFailureInput = {
      failure,
      backend,
      taskKey: input.taskKey,
      ownerUserId,
      role: "operator",
    };
    if (ctx.dataRoot) describeInput.dataRoot = ctx.dataRoot;
    const described = describeRunFailure(db, describeInput);
    // Ruling 127: a drive refused for want of a credential principal already
    // recorded the ONE sentence that names the person and their remedy
    // (`principalRefusalMessage`, on the run's `run·unavailable` line); the
    // leaf hands that sentence back as the reason, and no second remedy is
    // written beside it.
    const refusal = failure?.kind === "unavailable";
    const providerText = failure?.providerText ?? "";
    logger.warn("real operator run failed; escalating", {
      taskKey: input.taskKey,
      runId,
      kind: failure?.kind ?? "unknown",
    });
    const escalation: OperatorOpenPacketInput = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      packetType: "blocked",
      // The colon form: `app/server` is outside the copy-ban gate, so this is
      // a deliberate copy change (the title is rendered on the packet card).
      title: "Operator run failed: pick a recovery path",
      body:
        (refusal
          ? `The operator could not run on this task. ${described.reason} No ` +
            `coordination was performed.`
          : `${described.reason} No coordination was performed. ${described.remedy}`) +
        // R20-3 (F20-4): the operator's OWN escalation used to drop the
        // provider's words entirely; append the redacted sentence so a Codex
        // model/account mismatch reads its real cause, not the generic advice.
        (providerText ? `\n\nWhat the provider reported: ${providerText}` : ""),
      options: described.options,
    };
    // Same "Provider said" observation the specialist stuck-loop packet gets —
    // and no observations block at all when nothing was learned.
    const observations: NonNullable<OperatorOpenPacketInput["observations"]> = [];
    if (described.resetLabel) observations.push({ k: "Window reopens", v: described.resetLabel });
    if (providerText) observations.push({ k: "Provider said", v: providerText, code: true });
    if (observations.length) escalation.observations = observations;
    const opened = await operatorOpenPacket(db, ctx, escalation, authority);
    // R20-3: mark the model unavailable when the provider REFUSED it (no probe).
    if (providerText) {
      noteModelAvailabilityFromFailure(db, {
        runId,
        backend,
        model: getRun(db, runId)?.model ?? null,
        providerText,
      });
    }
    // B3 made a second packet a refusal, so an escalation can legitimately
    // land on a task that already has an open decision (the human is already
    // being asked something). Never silent: the run still failed.
    if (opened.outcome !== "done") {
      logger.warn("operator-run failure escalation did not open a packet", {
        taskKey: input.taskKey,
        runId,
        reason: opened.message,
      });
    }
  } catch (error) {
    logger.error("operator-run failure escalation failed", {
      taskKey: input.taskKey,
      runId,
      err: toError(error),
    });
  }
}

// ------------------------------------------------------- system prompt
