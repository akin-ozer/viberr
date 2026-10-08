import { type ResolvedPacketOption } from "~/shared/packet-server-outcome";
import { existsSync } from "node:fs";
import { shareDirWithAgents, shareDirWithAgentsOrWarn } from "./agent-isolation.server";
import { removeAgentTree } from "./agent-trees.server";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AuditActor,
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
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
  OPERATOR_TIMELINE_DEFAULT,
  operatorSnapshot,
} from "~/server/tasks/operator-snapshot.server";
import {
  operatorOpenPacket,
  type OperatorOpenPacketInput,
} from "~/server/tasks/operator-packets.server";
import {
  type OperatorAuthority,
  type OperatorAuthorityOverrides,
  type OperatorAutonomy,
  resolveOperatorAuthority,
} from "~/server/tasks/operator-authority.server";
import type { RelayPayload } from "~/server/tasks/task-relay.server";
import { buildOperatorToolkit } from "~/server/tasks/operator-toolkit.server";
import { getProject } from "~/server/projections/board-query.server";
import { closureRefusal, taskClosure } from "~/server/tasks/task-closure.server";
import { runFailureReason } from "~/server/tasks/agent-reply.server";
import {
  clearWaitingToHuman,
  liftHoldForRun,
  liftStageHoldForPerson,
  markWaitingAgent,
} from "~/server/tasks/agent-completion.server";
import { OPERATOR_TRANSITION_CHAIN_CAP } from "~/server/tasks/task-action-core.server";
import { reprojectTask, type TaskMutationContext } from "~/server/tasks/task-mutation.server";
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
import {
  noteModelAvailabilityFromFailure,
  clearModelMark,
} from "./model-availability.server";
import { toError } from "~/shared/errors";
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
import {
  executeCodexPlan,
  operatorPlanSchemaFor,
  operatorPlanToolsFor,
} from "./operator-codex-plan.server";

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
 *     JSON plan (`operatorPlanSchemaFor`), which `executeCodexPlan` runs through the
 *     same gated actions as the Claude tools (operator-actions, operator-packets,
 *     operator-dispatch, operator-moves) — so Codex honors the identical RBAC +
 *     autonomy, it just plans-then-executes instead of calling tools live.
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
 * the derivation `taskCloneDir`/`cloneRepo` share (specialist-workspace.server)
 * — for one task, so the delivering agent that runs later reuses this clone
 * instead of paying for a second one.
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
  // Ruling 670: initializing an unborn checkout can move the project onto the
  // repository's own default branch, so the view names the branch read after.
  const view = async (): Promise<OperatorWorkspaceView> => {
    const settled =
      (await initialize()) === "born"
        ? defaultBranch
        : (operatorCheckoutTarget(input)?.defaultBranch ?? defaultBranch);
    return { kind: "checkout", repo, dir, relativeDir, defaultBranch: settled };
  };
  if (existsSync(path.join(dir, ".git", "HEAD"))) return view();

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
    return await view();
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
  // An absent effort is sent as the Codex catalog default, `medium`, by
  // startRun (ruling 687); an absent mcpServers key is what the adapters read
  // as "this run mounts none".
  if (authority.effort) spec.effort = authority.effort;
  if (Object.keys(orgMcpServers).length) spec.mcpServers = orgMcpServers;
  // Ruling 176: Codex sends these as each server's `disabled_tools`.
  if (mcp.toolDenials.length) spec.mcpToolDenials = mcp.toolDenials;
  // Ruling 658: what the prompt names as possibly missing need not start.
  if (mcp.unhealthy.length) spec.mcpOptional = mcp.unhealthy;
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
  // capability-gated actions in operator-actions, operator-packets,
  // operator-dispatch and operator-moves (so codex honors the exact same RBAC +
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
