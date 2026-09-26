import { joinedPrompt } from "~/server/runtimes/prompt-prefix.server";
import { execFile } from "node:child_process";
import { describeRevisionDrift } from "~/shared/revision-drift";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "~/server/logging/logger.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  updateTaskFile, readTaskFile } from "~/server/files/task-writer.server";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import type {
  RunCallbacks,
  RunExit,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import {
  configureRunServiceForTests,
} from "./run-service.server";
import {
  type AdapterSet,
} from "./runtime-registry.server";
import {
  connectFakeBackend,
  connectFakeBackends,
  disconnectFakeBackend,
} from "../../../test-support/backend-credentials";
import { assertStrictSchema } from "../../../test-support/strict-schema";
import { RUN_INPUTS_TAG } from "~/features/runtime/runtime-types";
import {
  getRun,
  insertRunLine,
  nextSeq,
  listRunLines,
  listRunsForTaskRows,
  upsertRun,
} from "./run-store.server";
import { defaultModelFor } from "./model-catalog.server";
import {
  deliveredFollowUpFor,
  executeStrandedCodexPlan,
  maybeResumeStrandedOperator,
  CODEX_PLAN_WHOLE_TURN,
  REFRESH_ENDED_NUDGE,
  operatorPlanToolsFor,
  ownOperatorRunForTests,
  resetOperatorLeasesForTests,
  runOperator,
  authoredPacketOptions,
  operatorPlanSchemaFor,
} from "./operator-run.server";
import * as operatorPrompts from "./operator-run.server";
import { readDefaultBranchFile } from "~/server/tasks/operator-repo-read.server";
import {
  AGENT_REPORT_CAP_TOOLLESS,
  CREATE_TASK_BASE_NOTE,
  type OperatorAuthority,
  type OperatorAutonomy,
  type OperatorTaskSnapshot,
} from "~/server/tasks/operator-actions.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import { createLocalOrigin, withLocalGithub } from "../../../test-support/git-origin";
import { listAuditEvents } from "../../../test-support/audit-log";
import { emptyRunFailureFacts, type RunFailureFacts } from "~/shared/run-failure";

interface PendingRun {
  spec: RunSpec;
  callbacks: RunCallbacks;
}

class ControlledAdapter implements RuntimeAdapter {
  readonly backend = "codex" as const;
  pending: PendingRun | null = null;

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.pending = { spec, callbacks };
    return { runId: spec.runId, interrupt() {} };
  }

  /** Ruling 130(a): a run that died with a CLASSIFIED failure ends on an
   *  `err` line carrying the adapter's typed facts; the packet builder reads
   *  that record, never a second regex over the text. */
  fail(store: TestStore, text: string, facts: RunFailureFacts): void {
    const pending = this.pending;
    if (!pending) throw new Error("No Codex operator run is pending.");
    const tag = `run·error·${facts.kind}`;
    insertRunLine(store.db, {
      runId: pending.spec.runId,
      // Ruling 344: the SAME numbering the real sink uses (`nextSeq`), not a
      // literal 0. A run now carries Viberr's own `run·inputs` disclosure at
      // its head, and `insertRunLine` is `ON CONFLICT DO NOTHING` — so a
      // fixture that claims seq 0 silently drops its own line and the run
      // looks like it said nothing.
      seq: nextSeq(store.db, pending.spec.runId),
      occurredAt: new Date().toISOString(),
      raw: JSON.stringify({ ev: "err", tag, text }),
      display: { t: "12:00:00", ev: "err", tag, text, failure: facts },
    });
    pending.callbacks.onExit({
      outcome: "error",
      effectiveBackend: "codex",
      sessionId: "codex-operator-test",
    });
    this.pending = null;
  }

  finish(store: TestStore, text: string, outcome: RunExit["outcome"]): void {
    const pending = this.pending;
    if (!pending) throw new Error("No Codex operator run is pending.");
    // Persist the projected assistant line exactly where executeCodexPlan reads
    // it. The controlled adapter deliberately leaves completion to the test so
    // startCodexOperatorRun has registered its callback first.
    insertRunLine(store.db, {
      runId: pending.spec.runId,
      // Ruling 344: `nextSeq`, exactly as the sink does — see `fail` above.
      seq: nextSeq(store.db, pending.spec.runId),
      occurredAt: new Date().toISOString(),
      raw: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
      display: { t: "12:00:00", ev: "text", tag: "agent_message", text },
    });
    pending.callbacks.onExit({
      outcome,
      effectiveBackend: "codex",
      sessionId: "codex-operator-test",
    });
    this.pending = null;
  }
}

const OPERATOR_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "generate-packets", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "recommend" },
];

/** What a case overrides on the `transition_stage` plan action it feeds the
 *  operator: a real field, or the undeclared property the strict plan schema
 *  must reject. */
interface PlanActionPatch {
  toStageId?: string;
  reason?: string;
  /** Not part of the plan schema — the strict-object rejection probe. */
  unexpected?: boolean;
}

function transitionAction(extra: PlanActionPatch = {}) {
  return {
    tool: "transition_stage",
    profileId: null,
    delivers: null,
    toStageId: "review",
    packetType: null,
    text: null,
    reason: "Implementation is complete.",
    packetOptions: null,
    ...extra,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 100; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw lastError;
}

describe("Codex structured operator completion", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let adapter: ControlledAdapter;

  const task = () =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;

  beforeEach(async () => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            // R19-A: per-run autonomy is CLAMPED to the project's configured
            // level, so `start()`'s `autonomy: "full"` below only means
            // something on a project that CONFIGURED full autonomy.
            autonomy: "full",
          },
        },
      ],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Codex operator plan",
        stage: "impl",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
      }),
      goal: "Coordinate a finished implementation into review.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();

    adapter = new ControlledAdapter();
    const adapters: AdapterSet = {
      claude: adapter,
      codex: adapter,
    };
    configureRunServiceForTests(adapters);
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have this backend connected or the drive is refused before it starts.
    await connectFakeBackend(store.db, store.users.arda.id, "codex");
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx.cleanup();
  });

  async function start(): Promise<void> {
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "agent-reply",
      dataRoot: store.dataRoot,
    });
    expect(adapter.pending).not.toBeNull();
  }

  /**
   * Ruling 344 (pass 37, F37-180): the coordinator discloses what it was given.
   *
   * `recordRunInputs` had two callers, both on the specialist paths, so across
   * the whole shopify-clone pass the corpus held 834 `run·inputs` lines against
   * 2,317 runs — and the 1,024 with none were every operator drive (953) and
   * every controller turn (71). P19-G8/G11's rationale never said
   * "specialist": nobody could check which knowledge bases a run carried, which
   * grants resolved to nothing, or what state it was anchored on. The operator
   * is the actor that writes the packets and scoping notes a person reads, and
   * ruling 261's live incident WAS an operator KB arriving cut off mid-word —
   * found by reading code, because there was no record to read.
   */
  it("ruling 344: a Codex drive records what it was given, read off its own resolution", async () => {
    // CANARY: delete the `recordRunInputs` call after `startRun` in
    // `startCodexOperatorRun` and this finds no line.
    await start();
    const runId = adapter.pending!.spec.runId;
    const line = listRunLines(store.db, runId).find(
      (l) => l.display.tag === RUN_INPUTS_TAG,
    );
    expect(line, "the drive recorded no input disclosure").toBeTruthy();
    // It sits at the HEAD of the run's block — it is written at run start, so
    // the first thing a person expanding the console meets is what went in.
    expect(line!.seq).toBe(0);
    const inputs = line!.display.inputs!;
    // The operator has no checkout of its own, and the prompt it carries
    // forbids it from calling anything it holds "the repository".
    expect(inputs.cloned).toBe(false);
    expect(inputs.cwd).toBeNull();
    expect(inputs.delivers).toBe(false);
    // Every granted skill rides the prompt as text on this surface — the
    // disclosure's whole point is saying which channel a grant took.
    expect(inputs.skills.native).toEqual([]);
    expect(inputs.skills.injected).toEqual(inputs.skills.granted);
    // CANARY: hand `buildOperatorSystemPrompt` a literal `[]` for its toolkit
    // and this empties — the Codex drive's action surface IS its plan envelope,
    // so those actions are the honest answer to "what could this run do".
    expect(inputs.tools.toolkit).toContain("run_agent");
    expect(inputs.tools.toolkit).toContain("transition_stage");
    // A drive with no human comment carries no directive, and says so rather
    // than inventing one.
    expect(inputs.directive).toBeNull();
    expect(inputs.promptChars).toBeGreaterThan(0);
    adapter.finish(store, JSON.stringify({ reasoning: "nothing to do", actions: [] }), "finished");
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  it("ruling 344: a human's @operator comment is disclosed as the turn's directive, with who wrote it", async () => {
    // CANARY: return `null` unconditionally from `operatorTurnDirective`.
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "  please hold this until VIB-2 lands  ",
      humanCommentBy: "Arda Test",
      dataRoot: store.dataRoot,
    });
    expect(adapter.pending).not.toBeNull();
    const inputs = listRunLines(store.db, adapter.pending!.spec.runId).find(
      (l) => l.display.tag === RUN_INPUTS_TAG,
    )!.display.inputs!;
    expect(inputs.directive).toEqual({
      from: "Arda Test",
      // The TRIMMED length, because that is the text the prompt carries.
      chars: "please hold this until VIB-2 lands".length,
    });
    adapter.finish(store, JSON.stringify({ reasoning: "held", actions: [] }), "finished");
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  it("ruling 131(b): the Codex set_dependencies step executes; a null list is a MALFORMED step narrated as state, never policy", async () => {
    // Canary: delete the `set_dependencies` case from the executor switch
    // (the step falls to the default arm and the wait never lands).
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const step = (blockedBy: string[] | null) => ({
      tool: "set_dependencies",
      profileId: null,
      delivers: null,
      toStageId: null,
      packetType: null,
      text: null,
      reason: "the parser lands first",
      packetOptions: null,
      blockedBy,
    });
    await start();
    adapter.finish(
      store,
      JSON.stringify({ reasoning: "Wait for VIB-2.", actions: [step(["VIB-2"]), step(null)] }),
      "finished",
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(task().frontmatter.blockedBy).toEqual(["VIB-2"]);
    expect(task().packet).toBeNull();
    // The malformed sibling is narrated through the STATE arm.
    const narration = task().timeline.find((e) => e.text.includes("The operator's plan was not carried out in full"));
    expect(narration).toBeDefined();
    expect(narration!.type).toBe("note");
    expect(narration!.text).toContain("did not apply to the task's current state");
    expect(narration!.text).toContain("`set_dependencies` — plan step omitted the list of what the task waits on");
    expect(narration!.text).not.toContain("refused by its capability policy");
  });

  it("narrates plan actions its policy refused, instead of a silent no-op (P13-RT-03)", async () => {
    // The finding's scenario: a project withholds `generate-packets` and
    // `stage-transitions`. The operator emits open_packet + transition_stage;
    // both are denied. Because `plan.actions.length !== 0` the reasoning is not
    // posted either, so a billed run, a taken-and-released lease and a board
    // flip back to "waiting on you" left NOTHING on the timeline — identical to
    // the operator deciding to do nothing. executeCodexPlan discarded every
    // `{outcome, message}` the governed actions returned.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "off" },
            { capabilityId: "stage-transitions", mode: "off" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Implementation looks complete; escalate and advance.",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Confirm the release note wording",
            reason: "Needs a human call.",
            packetOptions: null,
          },
          transitionAction(),
        ],
      }),
      "finished",
    );

    await eventually(() => {
      const refusal = task().timeline.find(
        (e) => e.type === "policy" && e.text.includes("not carried out in full"),
      );
      expect(refusal).toBeDefined();
      expect(refusal!.text).toContain("open_packet");
      expect(refusal!.text).toContain("transition_stage");
      // And what it MEANT to do is preserved for the human reading the board.
      expect(refusal!.text).toContain("escalate and advance");
    });
    // Nothing was actually performed.
    expect(task().packet).toBeNull();
    expect(task().frontmatter.stage).toBe("impl");
  });

  /**
   * Ruling 430 (F39-52), live on AX-21 at 01:18: the plan's refresh met a
   * conflict and opened the blocking conflict packet, and its next step still
   * dispatched the Surface Developer with "The operator has updated the branch
   * from the changed base". A plan is written before any step runs; once one
   * of its steps leaves a decision in front of a person, the rest does not act.
   */
  it("ruling 430: once a step leaves a new decision packet, the plan's remaining acting steps are not carried out", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Escalate the scope question, then advance.",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Which of the two scopes should the task take?",
            reason: "A person owns the scope.",
            packetOptions: null,
          },
          transitionAction(),
        ],
      }),
      "finished",
    );
    // CANARY: drop the `pausedBy` guard and the transition is recommended on
    // top of the open question.
    await eventually(() => {
      const paused = task().timeline.find((e) => e.type === "note" && e.title === "Coordination paused");
      expect(paused).toBeDefined();
      expect(paused!.text).toContain("the `open_packet` step left a decision for a person");
      expect(paused!.text).toContain("`transition_stage`");
    });
    expect(task().packet).not.toBeNull();
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.recommendations ?? []).toEqual([]);
  });

  /**
   * F39-70, live on ax-clone AX-5 at 05:35. The plan leased three shared
   * paths, then dispatched the Developer with "Do not modify any path the
   * lease action refuses; report the refused path". The lease was refused,
   * and the note naming the paths landed 46 ms after the dispatch, because the
   * narration runs after the plan's last step. The Developer's prompt held the
   * instruction and not the refusal.
   */
  it("F39-70: a dispatch carries the refusals its own plan collected before it", async () => {
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "developer",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Dev",
            role: "Implementation",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await start();
    const operatorRun = adapter.pending!.spec.runId;
    const directive = "Carry on with the parser. If the move to Done was refused, say what blocks it.";
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "",
        actions: [
          // Impl -> Done is no transition this workflow has: refused.
          transitionAction({ toStageId: "done", reason: "Close it out." }),
          {
            tool: "run_agent",
            profileId: "developer",
            delivers: null,
            toStageId: null,
            packetType: null,
            text: directive,
            reason: null,
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );
    // CANARY: dispatch `a.text` bare and the agent is handed a question about
    // a refusal it has no way to read.
    await eventually(() => {
      expect(adapter.pending?.spec.runId).not.toBe(operatorRun);
      const prompt = adapter.pending!.spec.prompt;
      expect(prompt).toContain(directive);
      expect(prompt).toContain("Viberr did not carry out this earlier step of the operator's plan");
      expect(prompt).toContain("- `transition_stage`: ");
    });
    // The person reading the timeline sees the same directive the agent got.
    const handoff = task().timeline.find((e) => e.type === "comment" && e.text.includes(directive));
    expect(handoff?.text).toContain("- `transition_stage`: ");
    // A plan with nothing refused before the dispatch passes the directive as written.
    expect(operatorPrompts.withEarlierRefusals(directive, [])).toBe(directive);
  });

  it("F28-O1: a mid-plan abort is narrated even when append-typed-events is WITHHELD", async () => {
    // The operator can dispatch agents but CANNOT append typed events. Its
    // plan's run_agent throws mid-plan (a single-flight 409: the profile
    // already has a live run — the hunt turned the old no-repo-write hand-off
    // into an operator-level noop, which no longer throws), which aborts the
    // plan. Before F28-O1 the abort notice went through the GATED
    // operatorPostComment, which returns denied/noop WITHOUT throwing when
    // append-typed-events is off — so `.catch()` never fired and the abort was
    // swallowed, leaving the task stalled with nothing on the timeline. The
    // fix narrates the abort DIRECTLY, so it lands regardless of the gate.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "off" },
            { capabilityId: "dispatch-agents", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            autonomy: "full",
          },
        },
        {
          // Deployed but WITHOUT a repo-write grant — the dispatch below runs
          // it as supporting, and the pre-inserted LIVE run row makes the
          // single-flight preflight throw a 409 mid-plan.
          profileId: "developer",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Dev",
            role: "Implementation",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // The live run the plan step collides with (the throwing seam).
    upsertRun(store.db, {
      id: "run_live_dev",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "r0-live",
      role: "Implementation",
      kind: "reviewer",
      backend: "codex",
      model: defaultModelFor("codex"),
      sdk: "codex",
      sessionId: null,
      agentName: "Dev",
      agentProfileId: "developer",
      state: "running",
    });

    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Kick off the run.",
        actions: [
          {
            tool: "run_agent",
            profileId: "developer",
            delivers: null,
            toStageId: null,
            packetType: null,
            text: null,
            reason: "Run the agent.",
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      const abort = task().timeline.find(
        (e) => e.type === "note" && e.text.includes("Coordination stopped"),
      );
      expect(abort).toBeDefined();
      expect(abort!.text).toContain("run_agent");
    });
  });

  it("no usable plan + generate-packets WITHHELD writes a note instead of stranding (G6)", async () => {
    // The operator can post events but CANNOT open packets. Its turn is
    // unparseable, so the escalation path tries to open a blocked recovery
    // packet — which the gate DENIES (returns `denied` without throwing). The
    // old `.catch`-only code discarded that and the task strated silently.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "off" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    // Non-JSON output → parseOperatorPlan returns null (the no-plan branch).
    adapter.finish(store, "I was unable to decide on a next step.", "finished");

    await eventually(() => {
      const note = task().timeline.find(
        (e) =>
          e.type === "note" &&
          e.text.includes("could not open a recovery packet"),
      );
      expect(note).toBeDefined();
      expect(note!.text).toContain("re-engage the operator");
    });
    // The gate denied the packet — but the human is NOT stranded with silence.
    expect(task().packet).toBeNull();
  });

  /**
   * The refusal banner must name the REAL reason. With B3's already-open guard
   * landed, an operator that holds `generate-packets` and simply must not open
   * a second packet was reported as "refused by its capability policy" — an
   * accusation against a policy that blocked nothing, on a `policy` timeline
   * event (the type LV-03 reserves for governance signals).
   */
  it("files a STATE refusal as a note that does not blame the capability policy", async () => {
    await start();
    // Turn 1 opens the packet.
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Which endpoint should this target?",
            reason: "The task names no endpoint.",
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );
    await eventually(() => {
      expect(task().packet).not.toBeNull();
    });

    // Turn 2 tries to open a SECOND one — refused by state, not by policy.
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Ask about the migration too.",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Ship without the migration?",
            reason: "A second question.",
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      const narration = task().timeline.find((e) =>
        e.text.includes("not carried out in full"),
      );
      expect(narration).toBeDefined();
      expect(narration!.text).toContain("did not apply to the task's current state");
      expect(narration!.text).toContain("already open");
      expect(narration!.text).not.toContain("refused by its capability policy");
      // LV-03: a state conflict is not a governance refusal.
      expect(narration!.type).toBe("note");
    });
    // The human's packet still stands.
    expect(task().packet!.title).toBe("Which endpoint should this target?");
  });

  /**
   * F39-10 (pass 39, live on ax-clone AX-9): the same misblame, reached through
   * a DIFFERENT door. `update-task-branch` was granted `direct` on that board
   * and the operator planned `update_branch_from_base` at Review twice, twelve
   * minutes apart. Both landed as `policy` events reading "refused by its
   * capability policy" — against a grant that was wide open. What ruled the
   * step out was the task's STAGE (ruling 162), which is state.
   */
  it("the acceptance boundary is a STATE refusal, not a policy one, on a grant that is wide open", async () => {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            ...OPERATOR_POLICY,
            { capabilityId: "update-task-branch", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            autonomy: "full",
          },
        },
      ],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Codex operator plan",
        stage: "review",
        readiness: "ready",
        waiting: "none",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
      }),
      goal: "Coordinate a finished implementation into review.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Refresh the branch before acceptance.",
        actions: [
          {
            tool: "update_branch_from_base",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: null,
            reason: null,
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      const narration = task().timeline.find((e) =>
        e.text.includes("not carried out in full"),
      );
      expect(narration).toBeDefined();
      expect(narration!.text).toContain("the acceptance boundary");
      expect(narration!.text).toContain("did not apply to the task's current state");
      // CANARY: return `denied` from `acceptanceBoundaryRefusal`'s arm and both
      // of these flip — the sentence blames the policy and the type becomes the
      // governance signal LV-03 reserves for a real one.
      expect(narration!.text).not.toContain("refused by its capability policy");
      expect(narration!.type).toBe("note");
    });
  });

  it("names BOTH reasons separately when a plan hits policy and state in one turn", async () => {
    // `stage-transitions: off` (authority) + an already-Done-style state
    // refusal from resolve_packet with no packet open.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "stage-transitions", mode: "off" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Tidy up and advance.",
        actions: [
          {
            tool: "resolve_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: null,
            reason: "nothing to withdraw",
            packetOptions: null,
          },
          transitionAction(),
        ],
      }),
      "finished",
    );

    await eventually(() => {
      const narration = task().timeline.find((e) =>
        e.text.includes("not carried out in full"),
      );
      expect(narration).toBeDefined();
      expect(narration!.text).toContain("Refused by its capability policy:");
      expect(narration!.text).toContain("`transition_stage`");
      expect(narration!.text).toContain("Did not apply to the task's current state:");
      expect(narration!.text).toContain("`resolve_packet`");
      // A real governance refusal IS present, so the event stays `policy`.
      expect(narration!.type).toBe("policy");
    });
  });

  it("does not narrate anything when every action succeeded", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Narrating the state.",
        actions: [
          {
            tool: "post_comment",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: "Implementation is complete; moving to review.",
            reason: null,
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );
    await eventually(() => {
      expect(
        task().timeline.some((e) => e.text.includes("Implementation is complete")),
      ).toBe(true);
    });
    expect(task().timeline.some((e) => e.type === "policy")).toBe(false);
    // P14-RT-08: the live path CLAIMS the turn, so the boot reconciler that
    // recovers dropped plans can tell an executed one from a stranded one.
    await eventually(() => {
      expect(
        listAuditEvents(store.db, { action: "runtime.operator.plan_executed" }),
      ).toHaveLength(1);
    });
  });

  it("does not execute a valid partial plan when the turn fails", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "A partial response that must never be executed.",
        actions: [transitionAction()],
      }),
      "error",
    );

    await eventually(() => {
      expect(task().packet?.type).toBe("blocked");
    });
    expect(task().frontmatter.stage).toBe("impl");
    expect(
      task().timeline.some((event) =>
        event.text.includes("A partial response that must never be executed."),
      ),
    ).toBe(false);
  });

  it("executes a valid structured plan larger than the timeline preview limit", async () => {
    // Ruling 151: impl → review is an `approval` boundary the operator may only
    // recommend, so the plan crosses the `auto` edge ready → impl instead.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...task().frontmatter, stage: "ready" },
      goal: task().goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await start();
    const reasoning = `Observed: ${"implementation evidence ".repeat(70)}`;
    const text = JSON.stringify({
      reasoning,
      actions: [transitionAction({ toStageId: "impl" })],
    });
    expect(text.length).toBeGreaterThan(1_200);
    adapter.finish(store, text, "finished");

    await eventually(() => {
      expect(task().frontmatter.stage).toBe("impl");
    });
    expect(task().packet).toBeNull();
    expect(
      task().timeline.some((event) => event.text.includes("implementation evidence")),
    ).toBe(false);
  });

  it("rejects schema-invalid JSON before any governed action executes", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "This object has an undeclared action property.",
        actions: [transitionAction({ unexpected: true })],
      }),
      "finished",
    );

    await eventually(() => {
      expect(task().packet?.type).toBe("blocked");
    });
    expect(task().frontmatter.stage).toBe("impl");
    expect(
      task().timeline.some((event) =>
        event.text.includes("This object has an undeclared action property."),
      ),
    ).toBe(false);
  });

  it("P11-27: honors the operator's AUTHORED packet options over the defaults", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "Goal is ambiguous — needs the human to choose.",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Which config should this target?",
            reason: "The task names no specific endpoint.",
            packetOptions: [
              // A real strict-schema Codex model always emits `detail` (null when unused).
              { kind: "edit_goal", title: "Refine the goal with the exact endpoint", detail: "State the target endpoint", recommended: true },
              { kind: "custom", title: "Confirm it's intentionally broad", detail: null, recommended: false },
            ],
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      expect(task().packet?.options?.length).toBe(2);
    });
    const titles = task().packet!.options.map((o) => o.t);
    expect(titles).toContain("Refine the goal with the exact endpoint");
    expect(titles).toContain("Confirm it's intentionally broad");
    // Not the canned default set.
    expect(titles).not.toContain("Send back to the specialist for changes");
  });

  it("ruling 433: a Codex plan's create_task option reaches the packet with the task it creates", async () => {
    /**
     * Live on AX-27 at 01:40, after the owner asked for exactly this option:
     * "`open_packet` — \"Create core task: Persist terminal Task execution
     * details\" is a create_task option with no task on it. Give newTask a
     * title and a goal". The Codex plan's option object had no newTask field,
     * so the refusal asked for something the operator could not send. AX-4
     * hit the same refusal twice. Ruling 270 fixed this door on the Claude
     * tool only.
     *
     * CANARY: stop carrying newTask in `authoredPacketOptions`.
     */
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "The status data is core-owned; the owner asked for its own task.",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Create the core status task?",
            reason: "The owner asked for a create_task option.",
            packetOptions: [
              {
                kind: "create_task",
                title: "Create the core status task",
                detail: "The Developer adds the fields; this task waits on it.",
                recommended: true,
                newTask: {
                  title: " Persist terminal Task execution details ",
                  goal: "Add exitCode, reason and sandboxHandle to TaskStatus. Done when a live control plane shows them on a Failed Task.",
                  blockedBy: null,
                  blocks: null,
                  labels: ["core"],
                },
              },
              { kind: "custom", title: "Narrow this task instead", detail: null, recommended: false, newTask: null },
            ],
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      expect(task().packet?.options?.length).toBe(2);
    });
    const created = task().packet!.options[0]!;
    expect(created.kind).toBe("create_task");
    expect(created.newTask).toEqual({
      title: "Persist terminal Task execution details",
      goal: "Add exitCode, reason and sandboxHandle to TaskStatus. Done when a live control plane shows them on a Failed Task.",
      labels: ["core"],
    });
    expect(task().packet!.options[1]!.newTask).toBeUndefined();
  });

  // B-OP4: the flat Codex plan may leave `packetOptions` null on a genuine
  // multi-way decision. The fallback card then offered only "send back" and
  // "redirect" — neither of which is the real answer to "which of these should
  // we do?", so the human had to pick a wrong option or leave it open.
  it("B-OP4: the fallback INPUT packet offers a free-form option too", async () => {
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "open_packet",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: "input",
            text: "Which config should this target?",
            reason: "The task names no specific endpoint.",
            packetOptions: null,
          },
        ],
      }),
      "finished",
    );

    await eventually(() => {
      expect(task().packet).not.toBeNull();
    });
    const options = task().packet!.options;
    expect(options.map((o) => o.kind)).toContain("custom");
    expect(options.find((o) => o.kind === "custom")!.t).toContain("Something else");
  });

  // P14-RT-04 / KM-02: P13-KM-03 wired the operator's declared org MCP servers
  // into the CLAUDE toolkit only, so `startCodexOperatorRun` passed none and
  // `codexConfigForRun` wrote `mcp_servers: {}` — the same grant was real on one
  // backend and decorative on the other.
  it("mounts the operator's declared org MCP servers on the Codex run", async () => {
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mcp_ops", "ops-readonly", "HTTP", "https://mcp.example/sse", null, now, now);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            resources: { skills: [], kb: [], mcps: ["ops-readonly"] },
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    expect(adapter.pending!.spec.mcpServers).toEqual({
      "ops-readonly": { type: "http", url: "https://mcp.example/sse" },
    });
    // …and the operator is told which servers it holds, so it can report them
    // honestly instead of guessing (P14-LV-11).
    expect(joinedPrompt(adapter.pending!.spec.systemPrompt ?? "")).toContain(
      "Attached MCP servers: ops-readonly.",
    );
  });

  /**
   * R20-9 / ruling 84 residual (band-3 follow-up) — the MECHANICAL
   * delegated-ask disclosure rode the CLAUDE toolkit's `open_decision_packet`
   * alone. The Codex plan executor is the other packet writer, and a plan whose
   * actions are `run_agent` (with a prompt) then `open_packet` — the exact
   * shape the ruling is about — reached the human with nothing said about the
   * consultation. Both writers now share one ledger + one writer
   * (`operatorOpenPacketDisclosed`).
   */
  function deployWithDeveloper(dispatchMode: CapabilityMode): void {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            ...OPERATOR_POLICY,
            { capabilityId: "dispatch-agents", mode: dispatchMode },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            autonomy: "full",
          },
        },
        {
          profileId: "developer",
          // Repo-write so the explicit delivers:true hand-off below engages it
          // as the deliverer instead of refusing (no-repo-write validation).
          capabilities: [
            { capabilityId: "execute-code-or-write-repo", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Dev",
            role: "Implementation",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /** The ruling's shape: consult an agent, then take the question to a human. */
  const PROMPT_THEN_PACKET = JSON.stringify({
    reasoning: "",
    actions: [
      {
        tool: "run_agent",
        profileId: "developer",
        delivers: true,
        toStageId: null,
        packetType: null,
        text: "Which storage backend does the repo use?",
        reason: null,
        packetOptions: null,
      },
      {
        tool: "open_packet",
        profileId: null,
        delivers: null,
        toStageId: null,
        packetType: "input",
        text: "Which storage backend?",
        reason: "The repo supports both.",
        packetOptions: null,
      },
    ],
  });

  it("R20-9: a Codex plan that prompts then opens a packet DISCLOSES the consultation", async () => {
    // Canary: drop the `consultedProfileIds` threading in executeCodexPlan (or
    // call `operatorOpenPacket` there again) and the disclosure vanishes while
    // the Claude toolkit's own tests still pass.
    deployWithDeveloper("direct");
    await start();
    adapter.finish(store, PROMPT_THEN_PACKET, "finished");

    await eventually(() => {
      expect(task().packet).not.toBeNull();
    });
    const body = task().packet!.body ?? "";
    // The model's own body survives; the FACT is appended to it.
    expect(body).toContain("The repo supports both.");
    expect(body).toContain("the operator prompted Dev on this task");
    expect(body).toContain("not by that agent");
  });

  it("R20-9: a REFUSED prompt discloses nothing — it consulted nobody", async () => {
    // The guard's other half: `noteConsultedProfile` records only `done`, so a
    // hand-off the policy denied cannot manufacture a consultation that never
    // happened — a different lie from the one the disclosure fixes.
    deployWithDeveloper("off");
    await start();
    adapter.finish(store, PROMPT_THEN_PACKET, "finished");

    await eventually(() => {
      expect(task().packet).not.toBeNull();
    });
    expect(task().packet!.body).toBe("The repo supports both.");
    expect(task().packet!.body ?? "").not.toContain("Disclosure");
    // …and the denial itself is still narrated (P13-RT-03).
    await eventually(() => {
      const refusal = task().timeline.find((e) =>
        e.text.includes("not carried out in full"),
      );
      expect(refusal).toBeDefined();
      expect(refusal!.text).toContain("run_agent");
    });
  });

  // P14-LV-11: asked which backend it was on, an operator running on Claude
  // reported "Codex backend run" — it had no runtime identity at all, so it
  // echoed the premise in the task goal.
  it("tells the operator which backend and model it is actually running on", async () => {
    await start();
    const systemPrompt = joinedPrompt(adapter.pending!.spec.systemPrompt ?? "");
    expect(systemPrompt).toContain("# Your runtime");
    expect(systemPrompt).toContain("You are running on the **Codex** backend");
    expect(systemPrompt).toContain(defaultModelFor("codex"));
    expect(systemPrompt).toContain("No MCP servers are attached to you.");
    expect(systemPrompt).toContain("never repeat");
  });

  // R26-1: the operator is told its get_task snapshot carries the task's human
  // triage metadata as ADVISORY signals. Canary: drop the "Triage signals" push
  // in buildOperatorSystemPrompt and this fails. Pairs with the operatorSnapshot
  // metadata-propagation test in operator-actions.server.test.
  it("R26-1: the system prompt carries the advisory Triage-signals note", async () => {
    await start();
    const systemPrompt = joinedPrompt(adapter.pending!.spec.systemPrompt ?? "");
    expect(systemPrompt).toContain("# Triage signals (advisory)");
    expect(systemPrompt).toContain("`priority`");
    expect(systemPrompt).toContain("`dueDate`");
    // Advisory, never a gate — the note must say so.
    expect(systemPrompt).toContain("change no gate and grant no authority");
  });
});

// ------------------------------------------- P13-RT-03: denials must be visible

describe("operatorPlanToolsFor — the schema mirrors the capability policy (P13-RT-03)", () => {
  function authority(
    modes: Record<string, CapabilityMode>,
    autonomy: OperatorAutonomy = "supervised",
  ): OperatorAuthority {
    return {
      policy: new Map(Object.entries(modes)),
      autonomy,
      backend: "codex",
      model: defaultModelFor("codex"),
      effort: "",
      name: "Operator",
      skills: [],
      kb: [],
      mcps: [],
      persona: null,
      deployed: true,
      humanGatedBeforeWork: false,
    };
  }

  it("drops the tools whose capability is withheld", () => {
    // The finding's failure scenario: `generate-packets: off` and
    // `stage-transitions: off`. On Claude those tools are never BUILT, so the
    // model can't reach them; the Codex plan schema advertised all nine.
    const tools = operatorPlanToolsFor(
      authority({
        "append-typed-events": "direct",
        "generate-packets": "off",
        "stage-transitions": "off",
        "dispatch-agents": "direct",
        "completion-for-acceptance": "human",
      }),
    );
    expect(tools).toContain("post_comment");
    expect(tools).toContain("set_goal");
    expect(tools).toContain("run_agent");
    expect(tools).not.toContain("open_packet");
    expect(tools).not.toContain("resolve_packet");
    expect(tools).not.toContain("transition_stage");
    expect(tools).not.toContain("accept_completion");
  });

  it("the dispatch grant admits run_agent, even at recommend (mirrors the Claude toolkit)", () => {
    // Dynamic-dispatch rework: engage_agent/prompt_agent collapsed into the ONE
    // run_agent action, gated by the collapsed `dispatch-agents` capability.
    const tools = operatorPlanToolsFor(
      authority({ "dispatch-agents": "recommend" }),
    );
    expect(tools).toContain("run_agent");
  });

  it("an all-denied operator falls back to the full list MINUS delivery (an enum may not be empty)", () => {
    // A misconfiguration rather than an expressible run shape — every action it
    // then proposes is refused VISIBLY by the executor rather than silently.
    // R15-2: `deliver-review-pr` must be EXPLICITLY off here — an absent grant
    // means granted (the capability postdates live deployments). Hunt
    // 2026-08-29: `dispatch-agents` carries the SAME polarity now
    // (dispatchGate), so all-denied must withhold it explicitly too — an
    // absent dispatch grant legitimately keeps run_agent alive.
    // A4: the fallback must not re-advertise the one action with effects
    // outside Viberr (push a branch, open a PR) that this policy just withheld.
    const tools = operatorPlanToolsFor(
      authority({ "deliver-review-pr": "off", "dispatch-agents": "off" }),
    );
    // Dynamic-dispatch rework: engage_agent + prompt_agent collapsed into ONE
    // run_agent, so the fallback list shrank from 10 to 8; ruling 131 added
    // `set_dependencies` (in-Viberr, no outside effect), so it was 9; ruling
    // 378 added `propose_ruling` (ruling 483 renamed it `propose_kb_correction`,
    // ruling 498 `correct_knowledge_doc`), also in-Viberr and also destroying
    // nothing a person cannot undo, so it is 10.
    // Ruling 417's `lease_files` rides the delivery gate, so it is withheld
    // with delivery and the count stays 10. Ruling 487's two schedule verbs
    // ride a DIRECT dispatch grant, which this operator does not hold, so they
    // are withheld too and it is still 10. Ruling 488's `relay_to_task` is a
    // comment on another task of the project, in-Viberr like `post_comment`,
    // so it joins the fallback and it is 11. Ruling 503's `set_epic` puts this
    // task in an epic, in-Viberr like `set_dependencies`, so it is 12.
    expect(tools).toHaveLength(12);
    expect(tools).toContain("set_epic");
    expect(tools).toContain("relay_to_task");
    expect(tools).not.toContain("schedule_task_action");
    expect(tools).toContain("set_dependencies");
    expect(tools).toContain("correct_knowledge_doc");
    expect(tools).not.toContain("deliver_for_review");
    expect(tools).not.toContain("lease_files");
    expect(tools).toContain("flag_context_conflict");
  });

  it("ruling 417: lease_files is offered exactly where delivery is", () => {
    // CANARY: map it to a grant nobody holds and a Codex operator can never
    // lease, which is every operator on the board the ruling was written for.
    expect(operatorPlanToolsFor(authority({ "deliver-review-pr": "direct" }))).toContain("lease_files");
    expect(operatorPlanToolsFor(authority({ "deliver-review-pr": "off", "dispatch-agents": "direct" }))).not.toContain(
      "lease_files",
    );
    // The plan schema carries the field it needs, required like every other.
    const schema = operatorPlanSchemaFor(authority({ "deliver-review-pr": "direct" }));
    const item = schema.properties.actions.items;
    expect(item.properties.paths.type).toEqual(["array", "null"]);
    expect(item.required).toContain("paths");
  });

  it("ruling 488: relay_to_task is offered with the comment grant, and the plan carries its task key", () => {
    // CANARY: drop the verb from OPERATOR_PLAN_TOOLS (a Codex operator can
    // never relay), or map it to a grant it does not ride.
    expect(operatorPlanToolsFor(authority({ "append-typed-events": "direct" }))).toContain("relay_to_task");
    expect(
      operatorPlanToolsFor(authority({ "append-typed-events": "off", "generate-packets": "direct" })),
    ).not.toContain("relay_to_task");
    const item = operatorPlanSchemaFor(authority({ "append-typed-events": "direct" })).properties.actions.items;
    expect(item.properties.taskKey.type).toEqual(["string", "null"]);
    expect(item.properties.taskKey.description).toContain("never ask a person to copy text between tasks");
    expect(item.required).toContain("taskKey");
  });

  it("ruling 487: the schedule verbs are offered on a DIRECT dispatch grant only, and the plan carries their fields", () => {
    // CANARY: drop the two verbs from OPERATOR_PLAN_TOOLS (a Codex operator can
    // never schedule), or gate them on `dispatchGate !== "deny"` (the recommend
    // operator is offered a run that starts with nobody present).
    for (const tools of [
      operatorPlanToolsFor(authority({ "dispatch-agents": "direct" })),
      // Absent resolves to the catalog default, `direct` (ruling 98(b)).
      operatorPlanToolsFor(authority({ "generate-packets": "direct" })),
    ]) {
      expect(tools).toContain("schedule_task_action");
      expect(tools).toContain("cancel_task_schedule");
    }
    for (const tools of [
      operatorPlanToolsFor(authority({ "dispatch-agents": "recommend", "generate-packets": "direct" })),
      operatorPlanToolsFor(authority({ "dispatch-agents": "off", "generate-packets": "direct" })),
    ]) {
      expect(tools).not.toContain("schedule_task_action");
      expect(tools).not.toContain("cancel_task_schedule");
    }
    const item = operatorPlanSchemaFor(authority({ "dispatch-agents": "direct" })).properties.actions.items;
    expect(item.properties.dueAt.type).toEqual(["string", "null"]);
    expect(item.properties.delayMinutes.type).toEqual(["number", "null"]);
    expect(item.properties.scheduleId.type).toEqual(["string", "null"]);
    expect(item.required).toEqual(expect.arrayContaining(["dueAt", "delayMinutes", "scheduleId"]));
  });

  it("F39-68: the plan's create_task says a created task starts from the base branch", () => {
    // CANARY: drop the sentence and the Codex operator is told only to use the
    // kind for "another owner's package", which is how AX-5 was nearly made
    // to wait on a task that could never reach its code.
    const schema = operatorPlanSchemaFor(authority({ "generate-packets": "direct" }));
    expect(JSON.stringify(schema)).toContain(JSON.stringify(CREATE_TASK_BASE_NOTE).slice(1, -1));
  });

  it("ruling 421: the plan schema carries run_agent's `completeness`, required like every other field", () => {
    // CANARY: drop the property or its `required` entry, and a strict Codex
    // plan can never say the question was put.
    const schema = operatorPlanSchemaFor(authority({ "dispatch-agents": "direct" }));
    const item = schema.properties.actions.items;
    expect(item.properties.completeness.type).toEqual(["boolean", "null"]);
    expect(item.required).toContain("completeness");
  });

  it("dispatchGate: an ABSENT dispatch-agents grant keeps run_agent — pre-rework deployments store only the retired ids (hunt 2026-08-29)", () => {
    // The owner's live deployments carry `assign-primary-specialist` +
    // `summon-reviewers` and no `dispatch-agents` row; the plain gate read
    // absent as deny and silently made the whole rework inert on every
    // existing project. The gate now resolves absent to the catalog default.
    const tools = operatorPlanToolsFor(
      authority({
        "assign-primary-specialist": "direct",
        "summon-reviewers": "direct",
        "generate-packets": "direct",
      }),
    );
    expect(tools).toContain("run_agent");
  });

  it("A4: an UNDEPLOYED operator is never offered delivery, whatever the board's preset", () => {
    // The no-deployment authority carries an EMPTY policy, so every gate denies
    // and the fallback fires — which used to re-offer `deliver_for_review`
    // because `deliverGate`'s absent-means-granted polarity had no
    // deployed-check. `humanGatedBeforeWork: false` is the non-strict board
    // that resolved the absent grant to `direct`.
    const undeployed = { ...authority({}), deployed: false };
    expect(operatorPlanToolsFor(undeployed)).not.toContain("deliver_for_review");
  });

  it("R15-2: deliver_for_review is offered when the grant is absent (absent = granted), withheld only when explicitly off", () => {
    // Fails on pre-R15-2 main twice over: the tool did not exist, and a plain
    // gate() would read an absent grant as deny.
    expect(operatorPlanToolsFor(authority({ "append-typed-events": "direct" }))).toContain(
      "deliver_for_review",
    );
    expect(
      operatorPlanToolsFor(
        authority({
          "append-typed-events": "direct",
          "deliver-review-pr": "off",
        }),
      ),
    ).not.toContain("deliver_for_review");
  });

  // Ruling 138 (pass 34, U34-10): goalDraft rides the plan and its schema requires the key.
  it("authoredPacketOptions carries a trimmed goalDraft, and the plan schema requires the key", () => {
    // Canary: remove the carry in `authoredPacketOptions`, or drop "goalDraft"
    // from the option item's `required`.
    const carried = authoredPacketOptions([
      { kind: "edit_goal", title: "Ship the export", detail: null, recommended: true, goalDraft: " Deliver a CSV export. " },
      { kind: "hold_runtime_debug", title: "Hold", detail: null, recommended: false, goalDraft: null },
    ]);
    expect(carried?.[0]?.goalDraft).toBe("Deliver a CSV export.");
    expect(carried?.[1]?.goalDraft).toBeUndefined();

    const schema = operatorPlanSchemaFor(
      authority({
        "append-typed-events": "direct",
        "generate-packets": "direct",
        "stage-transitions": "direct",
        "dispatch-agents": "direct",
        "completion-for-acceptance": "human",
      }),
    );
    const item = schema.properties.actions.items.properties.packetOptions.items;
    expect(item.required).toContain("goalDraft");
    expect(item.properties.goalDraft.type).toEqual(["string", "null"]);
    expect(item.properties.goalDraft.description).toContain("written AS a goal");
  });

  it("ruling 433: the plan's option carries the payloads of block_on_dependencies and wait_for_window, and requires every key", () => {
    // CANARY: drop the blockedBy or dueAt carry, or a key from `required`.
    const carried = authoredPacketOptions([
      { kind: "block_on_dependencies", title: "Hold until AX-22 lands", detail: null, recommended: true, blockedBy: ["AX-22", "goal-4 link 3"], dueAt: null, newTask: null },
      { kind: "wait_for_window", title: "Wait for the window", detail: null, recommended: false, blockedBy: null, dueAt: " 2026-09-23T05:00:00.000Z ", newTask: null },
    ]);
    expect(carried?.[0]?.blockedBy).toEqual(["AX-22", "goal-4 link 3"]);
    expect(carried?.[0]?.dueAt).toBeUndefined();
    expect(carried?.[1]?.dueAt).toBe("2026-09-23T05:00:00.000Z");
    expect(carried?.[1]?.blockedBy).toBeUndefined();

    const schema = operatorPlanSchemaFor(
      authority({ "append-typed-events": "direct", "generate-packets": "direct" }),
    );
    const item = schema.properties.actions.items.properties.packetOptions.items;
    for (const key of ["blockedBy", "dueAt", "newTask"] as const) {
      expect(item.required).toContain(key);
    }
    expect(item.properties.newTask.required).toEqual(["title", "goal", "blockedBy", "blocks", "labels"]);
    expect(assertStrictSchema(schema)).toEqual([]);
  });

});

describe("pr-diverged turn instruction (both backends)", () => {
  function snapshot(
    over: Partial<OperatorTaskSnapshot> = {},
  ): OperatorTaskSnapshot {
    return {
      key: "VIB-9",
      // Ruling 302: the window's own size, always present.
      timelineTotal: 0,
      title: "T",
      goal: "Do the thing.",
      priority: "normal",
      labels: [],
      dueDate: null,
      blockedBy: [],
      stage: "review",
      stageName: "Review",
      previousStage: null,
      readiness: "ready",
      waiting: "human",
      validation: "changed",
      owner: null,
      specialist: null,
      reviewers: [],
      nextStages: [{ id: "done", name: "Done", boundary: "human" }],
      reworkStages: [],
      stageIds: ["triage", "ready", "impl", "review", "done"],
      doneStageId: "done",
      reviewStageId: "review",
      workStageId: "impl",
      deployedSpecialists: [],
      openPacket: false,
      packet: null,
      recentTimeline: [],
      pr: { number: 318, state: "closed", title: "PR", revisionDrift: null, revisionDriftSentence: "", headSha: null, unpushedRevision: null, unpushedRevisionSentence: "" },
      branch: "vib-9",
      liveRuns: [],
      autonomy: "supervised",
      operatorPolicy: { scope: "operator", note: "", capabilities: {} },
      ...over,
    };
  }
  const { buildOperatorTurnPrompt, buildCodexOperatorPrompt, agentReportBlock } = operatorPrompts;

  it("closed PR on an active task → ONE recovery packet with rework/archive/archive+deleteBranch, acceptance forbidden", () => {
    const prompt = buildOperatorTurnPrompt(snapshot(), "pr-diverged");
    expect(prompt).toContain("closed WITHOUT merging");
    expect(prompt).toContain("open_decision_packet");
    expect(prompt).toContain("`archive_task`");
    expect(prompt).toContain("`deleteBranch: true`");
    expect(prompt).toContain("`vib-9`"); // names the branch the option would delete
    expect(prompt).toContain("never recommend acceptance while the PR is closed");
  });

  it("merged out-of-band → acceptance is the next state, no packet demanded", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot({ pr: { number: 318, state: "merged", title: "PR", revisionDrift: null, revisionDriftSentence: "", headSha: null, unpushedRevision: null, unpushedRevisionSentence: "" } }),
      "pr-diverged",
    );
    expect(prompt).toContain("merged OUT-OF-BAND");
    expect(prompt).toContain("`accept_completion`");
    expect(prompt).not.toContain("archive_task");
  });

  it("PR live again → withdraw the moot packet and continue", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot({ pr: { number: 318, state: "review", title: "PR", revisionDrift: null, revisionDriftSentence: "", headSha: null, unpushedRevision: null, unpushedRevisionSentence: "" } }),
      "pr-diverged",
    );
    expect(prompt).toContain("live again");
    expect(prompt).toContain("resolve_decision_packet");
  });

  it("accepted-then-closed at the terminal stage → packet with custom options, not archive", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot({ stage: "done", stageName: "Done" }),
      "pr-diverged",
    );
    expect(prompt).toContain("terminal stage");
    expect(prompt).toContain("`custom` options");
    expect(prompt).not.toContain("archive_task");
  });

  /**
   * Ruling 397 (F39-24): the owner chose "the operator decides" over a new
   * packet option, so the fact has to reach the operator's own turn. It is
   * prepended by the wrapper rather than by any one trigger's branch, because
   * every early-returning branch is a turn that can be about to re-dispatch
   * work that is already done.
   */
  const STANDING = {
    actor: "agent",
    failedAt: "2026-09-22T08:33:08.205Z",
    reportedAt: "2026-09-22T08:33:08.181Z",
  };

  it("ruling 397: a standing report is named FIRST, on every trigger", () => {
    for (const trigger of ["packet-resolved", "manual", "agent-reply", "pr-diverged"] as const) {
      const prompt = buildOperatorTurnPrompt(snapshot({ unfinishedReport: STANDING }), trigger);
      // CANARY: drop `unfinishedReportInstruction` from the wrapper and none of
      // these carry it, which is the prompt AX-2's operator actually got.
      expect(prompt, trigger).toContain("READ THIS FIRST");
      expect(prompt, trigger).toContain(STANDING.reportedAt);
      expect(prompt, trigger).toContain("is about the PULL REQUEST");
      expect(prompt, trigger).toContain("read_timeline_entry");
      // It must not read as an order to accept the report either.
      expect(prompt, trigger).toContain("Re-dispatch only when the report is plainly partial");
    }
    // And the Codex plan prompt, which is a different builder over the same
    // instruction, carries it too.
    expect(buildCodexOperatorPrompt(snapshot({ unfinishedReport: STANDING }), "manual")).toContain(
      "READ THIS FIRST",
    );
  });

  /**
   * Ruling 408 (F39-35): ruling 400 quotes the refusals of a WHOLLY refused
   * plan. Live on ax-clone AX-18 the plan was `[deliver_for_review,
   * transition_stage]` — the delivery ran, so nothing was recorded, and the
   * next drive re-planned the refused transition and was refused identically.
   * The carry is the same sentence for the partial case, reaching the ordinary
   * turn rather than the paid nudge.
   */
  const REFUSED_NOTE = {
    at: "2026-09-22T17:07:51.797Z",
    text:
      "**The operator's plan was not carried out in full.** This step did not apply:\n\n" +
      "- `transition_stage` — AX-18's review PR #16 conflicts with the base branch.",
  };

  it("ruling 408: an unanswered refusal is quoted in full, on every trigger", () => {
    for (const trigger of ["packet-resolved", "manual", "agent-reply", "pr-diverged"] as const) {
      const prompt = buildOperatorTurnPrompt(
        snapshot({ unansweredRefusal: REFUSED_NOTE }),
        trigger,
      );
      // CANARY: drop `unansweredRefusalInstruction` from the wrapper and none
      // of these carry it — the prompt AX-18's second drive actually got.
      expect(prompt, trigger).toContain("Your last plan was refused in part");
      expect(prompt, trigger).toContain("conflicts with the base branch");
      expect(prompt, trigger).toContain("Do NOT plan the same refused action again");
      // It names the consequence the operator cannot otherwise see (ruling 406).
      expect(prompt, trigger).toContain("recorded as a hold on the stage");
      // And it never sends the reader to the timeline (ruling 392/400).
      expect(prompt, trigger).not.toContain("read them and follow them");
    }
    expect(
      buildCodexOperatorPrompt(snapshot({ unansweredRefusal: REFUSED_NOTE }), "manual"),
    ).toContain("Your last plan was refused in part");
  });

  /**
   * Ruling 415 (F39-41), live on ax-clone AX-19. The owner's round-five answer
   * ("changing what may block rather than asking again") reached one operator
   * turn; the next, a scheduled resume, never saw it and asked again. The
   * newest decision by then was "wait for the window", which says nothing
   * about review, so the instruction must not tell the operator to follow the
   * newest decision only.
   */
  const DECISIONS = [
    { at: "2026-09-22T19:34:20.283Z", by: "Arda", decision: "wait for the Codex window to reopen.", words: "Wait for the window." },
    {
      at: "2026-09-22T19:27:09.023Z",
      by: "Arda",
      decision: "answered with a custom directive.",
      words: "So I am changing what may block rather than asking again.",
    },
  ];

  it("ruling 415: a person's decisions are named on every trigger, on both backends, older ones included", () => {
    for (const trigger of ["packet-resolved", "manual", "agent-reply", "pr-diverged", "scheduled"] as const) {
      const prompt = buildOperatorTurnPrompt(snapshot({ humanDecisions: DECISIONS }), trigger);
      // CANARY: drop `humanDecisionsInstruction` from the wrapper and none of
      // these carry it, which is the prompt AX-19's 20:13 turn got.
      expect(prompt, trigger).toContain("A PERSON has decided things on this task");
      expect(prompt, trigger).toContain("does not cancel an older one");
      expect(prompt, trigger).toContain("do not ask again a question one of them has already answered");
    }
    const codex = buildCodexOperatorPrompt(snapshot({ humanDecisions: DECISIONS }), "scheduled");
    expect(codex).toContain("A PERSON has decided things on this task");
    // The snapshot the Codex plan reads carries the older decision's words.
    expect(codex).toContain("rather than asking again");
    expect(buildCodexOperatorPrompt(snapshot({}), "manual")).not.toContain("A PERSON has decided");
  });

  it("ruling 421: the completeness question is flagged on the turn a verdict arrives and in the stage rules", () => {
    // The turn a second objection lands on tells the operator to set it.
    // CANARY: drop the ruling-421 sentence from the agent-reply branch.
    const reply = "Verdict: request-changes\n\nStill blocking.";
    const onVerdict = buildCodexOperatorPrompt(snapshot({}), "agent-reply", undefined, reply);
    expect(onVerdict).toContain("set `completeness: true` on it");
    // And the stage rules' fallback arm names it with the dispatch it goes on.
    const later = buildCodexOperatorPrompt(snapshot({}), "manual");
    expect(later).toContain("`completeness: true` (ruling 421");
  });

  it("ruling 424: at the acceptance stage every turn says the branch refresh is not the operator's, the report's turn included", () => {
    // CANARY: drop `refreshBoundaryInstruction` from `operatorTurnInstruction`.
    // Live, the refused refreshes were planned on the turn a report came in,
    // which returns before the stage rules, so the stage rules alone miss it.
    const reason =
      "AX-22 is at Review, the acceptance boundary: the branch is brought up to date once, at acceptance time, and merged in the same ceremony. Do not refresh it here; recommend or accept the completion instead.";
    const atBoundary = snapshot({ notRefreshableReason: reason, baseBehindBy: 7 });
    for (const trigger of ["agent-reply", "manual", "scheduled"] as const) {
      const prompt = buildCodexOperatorPrompt(atBoundary, trigger, undefined, trigger === "agent-reply" ? "Rework committed." : undefined);
      expect(prompt, trigger).toContain("Never plan it here, whether `baseBehindBy` is positive or a reviewer is about to re-review");
    }
    expect(buildCodexOperatorPrompt(snapshot({ baseBehindBy: 7 }), "agent-reply", undefined, "Rework committed.")).not.toContain("Never plan it here");
    // Ruling 429: and when it lifts. CANARY: drop the 429 sentence.
    expect(buildCodexOperatorPrompt(atBoundary, "agent-reply", undefined, "Needs main.")).toContain(
      "It lifts the moment a verdict fails or a new revision awaits its verdict",
    );
  });

  it("ruling 494: a behind count that describes an older head is named before the plan on both backends, and a current one adds nothing", () => {
    // CANARY: drop `baseCompareInstruction` from `operatorTurnInstruction`.
    // Live on WEB-16 the stale count reached a comment and two packets, so
    // it is said on every trigger, the report's and the delivery's included.
    const sentence =
      "`baseBehindBy` (6) was counted on `aafee66`, and Viberr pushed `20534f6` to `web-16` after that compare, so the count describes the older head.";
    const stale = snapshot({
      baseBehindBy: 6,
      baseComparedHead: {
        sha: "aafee66".padEnd(40, "0"),
        observedAt: "2026-09-25T21:25:48.527Z",
        current: false,
        pushedSince: { sha: "20534f6".padEnd(40, "0"), at: "2026-09-25T21:25:55.000Z" },
      },
      baseBehindBySentence: sentence,
    });
    const rule =
      "A decision packet never states a behind count for a head other than the one the packet puts up.";
    for (const trigger of ["agent-reply", "delivered", "manual"] as const) {
      const reply = trigger === "agent-reply" ? "Rework committed." : undefined;
      for (const prompt of [
        buildCodexOperatorPrompt(stale, trigger, undefined, reply),
        buildOperatorTurnPrompt(stale, trigger, undefined, reply),
      ]) {
        expect(prompt, trigger).toContain(`${sentence} ${rule}`);
      }
    }
    const current = snapshot({ baseBehindBy: 0, baseBehindBySentence: "" });
    expect(buildCodexOperatorPrompt(current, "manual")).not.toContain(rule);
    expect(buildOperatorTurnPrompt(current, "manual")).not.toContain(rule);
  });

  it("ruling 437: a packet the operator did not raise is named as not its own, on every trigger", () => {
    // Live on AX-28 (02:12) and AX-31 (02:39): `resolve_packet` planned on an
    // agent's question and refused. CANARY: drop `packetAuthorInstruction`.
    const question = {
      type: "input" as const,
      title: "Choose the signal-classification contract",
      body: "",
      options: ["Use a wait-status supervisor"],
      awaiting: null,
      raisedBy: "agent:codex/developer (Implementation)",
      yours: false,
    };
    for (const trigger of ["agent-reply", "manual", "scheduled"] as const) {
      const prompt = buildCodexOperatorPrompt(
        snapshot({ openPacket: true, packet: question }),
        trigger,
        undefined,
        trigger === "agent-reply" ? "Asked the owner." : undefined,
      );
      expect(prompt, trigger).toContain(
        "The open decision packet was raised by agent:codex/developer (Implementation), not by you",
      );
      expect(prompt, trigger).toContain("`resolve_packet` is refused, however moot it looks");
    }
    const own = { ...question, raisedBy: "operator", yours: true };
    expect(buildCodexOperatorPrompt(snapshot({ openPacket: true, packet: own }), "manual")).not.toContain("not by you");
  });

  it("ruling 418: a reviewer's defect class becomes a written convention, on the turn the verdict arrives and on the stage rules", () => {
    // CANARY: drop either sentence and the turn the verdict lands on, or every
    // later manual/scheduled turn, says nothing about the rulings learning.
    const reply = "Verdict: request-changes\n\ngit args are passed without --.";
    const onVerdict = buildCodexOperatorPrompt(snapshot({}), "agent-reply", undefined, reply);
    expect(onVerdict).toContain("also `correct_knowledge_doc` that convention into the rulings document");
    expect(onVerdict).toContain("one per class, never one per finding");
    // Ruling 410's round-two duty is on this turn too, not only in the skill.
    // CANARY: drop that sentence and the only instruction on the turn a second
    // objection lands on is "move back and rework", the loop 410 ended.
    expect(onVerdict).toContain("At the SECOND consecutive objection from the same reviewer");
    const later = buildCodexOperatorPrompt(snapshot({}), "manual");
    expect(later).toContain("`correct_knowledge_doc` the convention into the rulings document it belongs to");
    // Ruling 498: it is written, not proposed.
    expect(later).toContain("It is written at once, every later run reads it, and a person undoes it if they disagree.");
  });

  it("rulings 483 and 498: the turn an agent's report lands on relays a knowledge-base passage it proved wrong", () => {
    // CANARY: drop the relay sentence and a Codex agent's correction, which it
    // has no tool to file, stays in its report as it did on WEB-3.
    const reply = "## Knowledge-base correction\n\nakin-dossier 06-platform-facts.md T-003 says 4.138.0; measured 4.139.0.";
    const turn = buildCodexOperatorPrompt(snapshot({}), "agent-reply", undefined, reply);
    expect(turn).toContain(
      "If the report says a passage in a knowledge base is wrong (a version, a path, a command, a step it measured) and no correction of it is on the timeline, `correct_knowledge_doc` it",
    );
  });

  it("ruling 431: the live lease list is explained on every turn it is present, collisions or not", () => {
    // CANARY: drop the `leases` sentence from `collisionsInstruction`.
    const fileLeases = [{ taskKey: "AX-20", paths: ["internal/controller/task.go"], reason: "lands first" }];
    expect(buildCodexOperatorPrompt(snapshot({ fileLeases }), "manual")).toContain(
      "A timeline note that a task leased or holds a file is history",
    );
    expect(buildCodexOperatorPrompt(snapshot({}), "manual")).not.toContain("is the project's lease list as it binds now");
  });

  it("ruling 413 reaches a Codex operator: collisions are explained in the shared instruction", () => {
    const collisions = [{ taskKey: "AX-21", prNumber: 15, paths: ["internal/cli/render.go"], partial: false }];
    // CANARY: drop `collisionsInstruction` from the wrapper; the field alone
    // arrived unexplained on every operator of the board it was written for.
    expect(buildCodexOperatorPrompt(snapshot({ collisions }), "manual")).toContain(
      "names the OTHER open review PRs whose diff touches a file",
    );
    expect(buildCodexOperatorPrompt(snapshot({}), "manual")).not.toContain("names the OTHER open review PRs");
    // Ruling 426: the refusal a lease now meets, and what to do about it.
    // CANARY: drop the ruling-426 sentence from `collisionsInstruction`.
    expect(buildCodexOperatorPrompt(snapshot({ collisions }), "manual")).toContain(
      "which of the two lands first is then a person's call",
    );
  });

  it("ruling 415: a tool-less operator is handed an unfinished report, not an address", () => {
    const withText = { ...STANDING, text: "Done on branch `ax-2`, commit `3e0396ab`." };
    const codex = buildCodexOperatorPrompt(snapshot({ unfinishedReport: withText }), "manual");
    // CANARY: drop the `standing.text` arm and this points at a tool again.
    expect(codex).toContain("Here it is:\n\nDone on branch `ax-2`");
    expect(codex).not.toContain("`read_timeline_entry` with that stamp");
  });

  it("ruling 443: a step whose outcome is the packet it opened is not a refusal", () => {
    const { planRefusalOf } = operatorPrompts;
    const conflict = "`ax-5` CONFLICTS with `main`. Opened a blocking decision packet for a human to resolve.";
    // CANARY: drop the `openedPacket` check and AX-5's refresh is narrated
    // "This step did not apply" beside the packet it opened.
    expect(planRefusalOf("update_branch_from_base", { outcome: "noop", message: conflict, openedPacket: true })).toBeNull();
    // Without the packet it is still what it was: a state refusal.
    const stuck = "`ax-5` CONFLICTS with `main`. A decision packet could NOT be opened (one is open).";
    expect(planRefusalOf("update_branch_from_base", { outcome: "noop", message: stuck })).toEqual({
      tool: "update_branch_from_base",
      message: stuck,
      kind: "state",
    });
    expect(planRefusalOf("run_agent", { outcome: "denied", message: "No." })?.kind).toBe("authority");
    expect(planRefusalOf("run_agent", { outcome: "done", message: "Started." })).toBeNull();
  });

  it("F39-69: a Codex plan is told it is the whole turn, a refresh and its next step together", () => {
    // CANARY: drop the sentence and nothing tells a plan that stopping after
    // the refresh leaves the task idle.
    expect(buildCodexOperatorPrompt(snapshot(), "manual")).toContain(CODEX_PLAN_WHOLE_TURN);
    expect(CODEX_PLAN_WHOLE_TURN).toContain("A walk across `auto` stages where nothing needs an agent is one `transition_stage` per stage");
  });

  it("ruling 415: a tool-less operator gets a long report whole, and an honest note when even that is cut", () => {
    const long = `${"finding ".repeat(1200)}`; // ~9,600 chars: past 4,000, inside 16,000
    const codex = agentReportBlock("agent-reply", long, { toolless: true });
    // CANARY: cap the tool-less report at 4,000 again and the findings past it
    // are gone with nowhere to fetch them from, the SHOP-42 loss on Codex.
    expect(codex).toContain(long.trim());
    expect(codex).not.toContain("is CUT");
    const huge = "x".repeat(AGENT_REPORT_CAP_TOOLLESS + 10);
    const cut = agentReportBlock("agent-reply", huge, { toolless: true });
    expect(cut).toContain("this turn cannot fetch the rest");
    expect(cut).not.toMatch(/get_task|read_timeline_entry/);
    // An operator with tools keeps ruling 285's cut and its address.
    expect(agentReportBlock("agent-reply", long)).toContain("read_timeline_entry");
  });

  /**
   * Ruling 409 (F39-36), live on ax-clone AX-18.
   *
   * Ruling 237 REFUSES a `question_reviewer` option that names no reviewer
   * ("A question_reviewer option needs the reviewer it asks"). The option's own
   * `profileId` description told the operator the field was
   * "retry_other_backend only", and `question_reviewer` appeared nowhere in the
   * packet-authoring guidance at all. So the operator reached for the option
   * this product recommends for a review deadlock, read the schema, correctly
   * left the field null, and was refused twice -- and the task stranded.
   *
   * Load-bearing after ruling 410, which makes putting that question the
   * operator's own move at the second objection.
   */
  it("ruling 409: the plan schema and the guidance both say a question_reviewer names its reviewer", () => {
    const schema = JSON.stringify(
      operatorPlanSchemaFor({
        policy: new Map<string, CapabilityMode>([
          ["append-typed-events", "direct"],
          ["generate-packets", "direct"],
          ["stage-transitions", "direct"],
          ["dispatch-agents", "direct"],
        ]),
        autonomy: "supervised",
        backend: "codex",
        model: defaultModelFor("codex"),
        effort: "",
        name: "Operator",
        skills: [],
        kb: [],
        mcps: [],
        persona: null,
        deployed: true,
        humanGatedBeforeWork: false,
      }),
    );
    // CANARY: restore "retry_other_backend only" and the first two fail.
    expect(schema).toContain("question_reviewer");
    expect(schema).toContain("reviewers[].profileId");
    expect(schema).not.toContain("retry_other_backend only: the agent profile to re-run");

    const prompt = buildCodexOperatorPrompt(snapshot({}), "manual");
    expect(prompt).toContain("`question_reviewer`");
    expect(prompt).toContain("an option that names no reviewer is refused");
  });

  /**
   * Ruling 400 (F39-27): the plan-refused retry QUOTES the refusals.
   *
   * It used to say "The refusals are on the timeline, and each one names what
   * to do instead — read them and follow them", which is the instruction
   * ruling 392 retired for agents, one level up. Live on ax-clone AX-4 the
   * operator got exactly that, planned the same malformed `create_task` option
   * again, and the board recorded a deliberate hold on a task nobody held.
   */
  const REFUSED = [
    {
      tool: "open_packet",
      message:
        '"Create a follow-on task for the missing logs baseline" is a create_task option with no task on it. Give newTask a title and a goal.',
    },
  ];

  it("ruling 400: the plan-refused retry carries the refusal text", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot(),
      "transition",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "plan-refused",
      undefined,
      REFUSED,
    );
    // CANARY: stop passing `refusedSteps` and this falls back to "read them on
    // the timeline", which is the sentence AX-4's operator was given.
    expect(prompt).toContain("Here is what was refused, in full");
    expect(prompt).toContain("create_task option with no task on it");
    expect(prompt).toContain("Each one names what was wrong with the step");
    // The standing prohibition is shared by both branches, not lost to the quote.
    expect(prompt).toContain("Do NOT plan the same refused action again");
    expect(prompt).not.toContain("read them and follow them");
  });

  it("ruling 400: falls back to the timeline only when there is nothing to quote", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot(),
      "transition",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "plan-refused",
    );
    expect(prompt).toContain("EVERY action your previous run planned was refused");
    expect(prompt).toContain("read them and follow them");
    expect(prompt).not.toContain("Here is what was refused");
  });

  it("ruling 400: the Codex plan prompt carries it too", () => {
    const prompt = buildCodexOperatorPrompt(
      snapshot(),
      "transition",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "plan-refused",
      undefined,
      REFUSED,
    );
    expect(prompt).toContain("create_task option with no task on it");
  });

  it("ruling 397: says nothing at all when no report is standing", () => {
    expect(buildOperatorTurnPrompt(snapshot(), "manual")).not.toContain("READ THIS FIRST");
  });

  it("the Codex plan prompt carries the same instruction plus the archive_task option vocabulary", () => {
    const prompt = buildCodexOperatorPrompt(snapshot(), "pr-diverged");
    expect(prompt).toContain("closed WITHOUT merging");
    expect(prompt).toContain("`archive_task` to archive the task");
    expect(prompt).toContain("deleteBranch: true");
  });

  /**
   * Ruling 178 (pass 36, G36-3): a project-declared required reviewer is a
   * rule the operator must act on, not a refusal it discovers at the boundary,
   * so every ordinary turn — and the post-delivery turn, which returns before
   * the stage rule — names the rule and what to do about it.
   */
  it("ruling 178: names the project's required reviewers and the engagement it owes, on both the ordinary and the delivered turn", () => {
    // Canary: drop `requiredReviewersRule` from `stageRule` and the delivered arm.
    const rules = [
      { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" },
      { stageId: "qa", stageName: "QA", profileId: "qa-bot", agentName: "QA Bot" },
    ];
    const line = "Required reviewers (project rule): Code Reviewer at Review, QA Bot at QA.";
    const ordinary = buildOperatorTurnPrompt(snapshot({ requiredReviewers: rules }), "manual");
    expect(ordinary).toContain(line);
    expect(ordinary).toContain("`run_agent` (`delivers: false`)");
    const delivered = buildOperatorTurnPrompt(
      snapshot({ requiredReviewers: rules, pr: { number: 318, state: "review", title: "PR", revisionDrift: null, revisionDriftSentence: "", headSha: null, unpushedRevision: null, unpushedRevisionSentence: "" } }),
      "delivered",
    );
    expect(delivered).toContain(line);
    expect(buildCodexOperatorPrompt(snapshot({ requiredReviewers: rules }), "manual")).toContain(line);
    // No rule, no line.
    expect(buildOperatorTurnPrompt(snapshot({ requiredReviewers: [] }), "manual")).not.toContain(
      "Required reviewers (project rule)",
    );
  });

  /**
   * F21-17 (live VIB-4) — the recovery packet said "review before closure was
   * clean (Approve)" and offered "Rework and resubmit", never mentioning the
   * unreviewed out-of-band commit the reconciler had already recorded. The
   * ACCEPT ceremony was disclosing it on the same task (R17-1). The packet is
   * model-authored, so the fix is the fact reaching the turn.
   */
  describe("F21-17 — the closed-PR packet carries the branch-drift fact", () => {
    const drifted = (state: "closed" | "review" = "closed") =>
      snapshot({
        pr: {
          number: 318,
          state,
          title: "PR",
          revisionDrift: { headSha: "cab10477beef1234", authored: 2, baseRefresh: null },
          revisionDriftSentence: "2 authored commits since review merge unreviewed",
          headSha: null,
          unpushedRevision: null,
          unpushedRevisionSentence: "",
        },
      });

    it("ruling 132: a base refresh is named as one, and never as unreviewed work", () => {
      // Canary: restore the blanket UNREVIEWED paragraph for any non-zero total.
      const record = { headSha: "cab10477beef1234", authored: 0, baseRefresh: { merges: 1, commits: 4 } };
      const prompt = buildOperatorTurnPrompt(
        snapshot({
          pr: {
            number: 318, state: "closed", title: "PR",
            revisionDrift: record,
            revisionDriftSentence: describeRevisionDrift(record).sentence,
            headSha: null, unpushedRevision: null, unpushedRevisionSentence: "",
          },
        }),
        "pr-diverged",
      );
      expect(prompt).toContain(describeRevisionDrift(record).sentence);
      expect(prompt).toContain("base refresh Viberr itself merged");
      expect(prompt).not.toContain("UNREVIEWED");
    });

    it("names the unreviewed commits and demands them as a packet observation", () => {
      // Canary: drop `drift` from the closed-PR arm and every line fails.
      const prompt = buildOperatorTurnPrompt(drifted(), "pr-diverged");
      expect(prompt).toContain("2 authored commits");
      expect(prompt).toContain("cab10477beef");
      expect(prompt).toContain("UNREVIEWED");
      expect(prompt).toContain("Unreviewed commits");
      expect(prompt).toMatch(/never describe this PR as "reviewed clean"/);
      // …and it must not turn the fact into a NEW false accusation (F21-21's
      // failure mode, one finding over).
      expect(prompt).toContain("Do not treat those commits as an out-of-band merge");
    });

    it("says nothing when the head equals the reviewed revision", () => {
      const prompt = buildOperatorTurnPrompt(snapshot(), "pr-diverged");
      expect(prompt).not.toContain("UNREVIEWED");
      expect(prompt).not.toContain("Unreviewed commits");
    });

    it("carries it on the terminal-stage arm too, and on the Codex plan prompt", () => {
      expect(
        buildOperatorTurnPrompt(
          snapshot({
            stage: "done",
            stageName: "Done",
            pr: {
              number: 318,
              state: "closed",
              title: "PR",
              revisionDrift: { headSha: "cab10477beef1234", authored: 1, baseRefresh: null },
              revisionDriftSentence: "1 authored commit since review merges unreviewed",
              headSha: null,
              unpushedRevision: null,
              unpushedRevisionSentence: "",
            },
          }),
          "pr-diverged",
        ),
      ).toContain("1 authored commit");
      expect(buildCodexOperatorPrompt(drifted(), "pr-diverged")).toContain("UNREVIEWED");
    });
  });

  // Ruling 138: the open_packet paragraph says what becomes the goal editor's draft.
  it("the open_packet paragraph tells the operator what becomes the draft, on a real trigger", () => {
    // Canary: remove the sentence.
    const prompt = operatorPrompts.buildCodexOperatorPrompt(snapshot(), "manual");
    expect(prompt).toContain("give it `goalDraft`: the proposed goal text itself, written AS a goal");
    expect(prompt).toContain("never phrase them as an instruction to the human");
  });

});

/* ------- stranded-operator backstop (P14 follow-up, live-caught) ------- */

describe("stranded auto-stage resume", () => {
  it("operatorLeftTaskStranded: true only for an idle auto stage with no pending decision", () => {
    const wf = [
      { from: "triage", to: "ready", boundary: "auto" },
      { from: "ready", to: "impl", boundary: "auto" },
      { from: "impl", to: "review", boundary: "approval" },
      { from: "review", to: "done", boundary: "human" },
    ];
    const base = {
      archived: false,
      stage: "triage",
      packet: null,
      recommendations: [],
      blockedBy: [],
    };
    const { operatorLeftTaskStranded } = operatorPrompts;
    expect(operatorLeftTaskStranded(base, wf)).toBe(true);
    expect(operatorLeftTaskStranded({ ...base, stage: "ready" }, wf)).toBe(true);
    expect(operatorLeftTaskStranded({ ...base, stage: "impl" }, wf)).toBe(false); // approval gate
    expect(operatorLeftTaskStranded({ ...base, stage: "done" }, wf)).toBe(false); // terminal
    expect(operatorLeftTaskStranded({ ...base, archived: true }, wf)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, packet: { title: "?" } }, wf)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, recommendations: [{}] }, wf)).toBe(false);
    // Ruling 131(d): a task waiting on other work is a RECORDED hold, never a
    // stranding. Canary: delete the `blockedBy` early return.
    expect(operatorLeftTaskStranded({ ...base, blockedBy: ["JC-3"] }, wf)).toBe(false);
    // Ruling 152(a) review: a stage THIS drive's own move landed on is stranded
    // whatever its outbound boundary, since nothing else follows that move up.
    // The guards above still rank first.
    expect(operatorLeftTaskStranded({ ...base, stage: "impl" }, wf, true)).toBe(true);
    expect(operatorLeftTaskStranded({ ...base, stage: "impl", packet: { title: "?" } }, wf, true)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, stage: "impl", blockedBy: ["JC-3"] }, wf, true)).toBe(false);
  });

  it("ruling 487: a pending schedule is a recorded wait, so the backstop does not call the task stranded", () => {
    // Canary: delete the pending-schedule early return.
    const wf = [{ from: "triage", to: "ready", boundary: "auto" }];
    const base = { archived: false, stage: "triage", packet: null, recommendations: [], blockedBy: [] };
    const { operatorLeftTaskStranded } = operatorPrompts;
    expect(operatorLeftTaskStranded({ ...base, schedules: [{ status: "pending" }] }, wf)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, schedules: [{ status: "pending" }] }, wf, true)).toBe(false);
    // Only a PENDING one: a fired or cancelled entry will move nothing.
    expect(operatorLeftTaskStranded({ ...base, schedules: [{ status: "fired" }, { status: "cancelled" }] }, wf)).toBe(true);
  });

  it("goal-drafting is labeled SETUP in the turn instruction — the live stranding's exact misreading", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      {
        key: "VIB-1",
        // Ruling 302: the window's own size, always present.
        timelineTotal: 0,
        title: "t",
        goal: "Goal to be refined at the triage quality gate.",
        priority: "normal",
        labels: [],
        dueDate: null,
        blockedBy: [],
        stage: "triage",
        stageName: "Triage",
        previousStage: null,
        readiness: "input_required",
        waiting: "human",
        validation: "changed",
        owner: null,
        specialist: null,
        reviewers: [],
        nextStages: [{ id: "ready", name: "Ready", boundary: "auto" }],
        reworkStages: [],
        stageIds: ["triage", "ready", "impl", "review", "done"],
        doneStageId: "done",
        reviewStageId: "review",
        workStageId: "impl",
        deployedSpecialists: [],
        openPacket: false,
        packet: null,
        recentTimeline: [],
        pr: null,
        branch: null,
        liveRuns: [],
        autonomy: "supervised",
        operatorPolicy: { scope: "operator", note: "", capabilities: {} },
      },
      "create",
    );
    expect(prompt).toContain("Drafting the goal is SETUP");
    expect(prompt).toContain("SAME run");
  });

  describe("settle-time resume (integration)", () => {
    let ctx2: TestDbContext;
    let store2: TestStore;
    let adapter2: ControlledAdapter;

    beforeEach(async () => {
      ctx2 = createTestDbContext();
      store2 = setupTestStore(ctx2);
      const project = readProjectFile({
        projectSlug: store2.slug,
        dataRoot: store2.dataRoot,
      })!;
      writeProject(store2.dataRoot, {
        ...project.parsed.frontmatter,
        repo: null,
        agents: [
          {
            profileId: "operator",
            capabilities: OPERATOR_POLICY,
            extras: [],
            definition: {
              kind: "operator",
              name: "Operator",
              backends: ["codex"],
              model: defaultModelFor("codex"),
            },
          },
        ],
      });
      // The live stranding shape: fresh task at the AUTO triage stage.
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          title: "list files in the project",
          stage: "triage",
          readiness: "input_required",
          waiting: "human",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "Goal to be refined at the triage quality gate.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      resetSseBrokerForTests();
      resetOperatorLeasesForTests();
      adapter2 = new ControlledAdapter();
      configureRunServiceForTests({ claude: adapter2, codex: adapter2 });
      // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
      // have this backend connected or the drive is refused before it starts.
      await connectFakeBackend(store2.db, store2.users.arda.id, "codex");
    });

    afterEach(() => {
      resetOperatorLeasesForTests();
      resetSseBrokerForTests();
      ctx2.cleanup();
    });

    const operatorRuns = () =>
      store2.db
        .prepare(`SELECT id, state FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
        .all()
        .map((row) => ({ id: String(row.id), state: String(row.state) }));

    /**
     * A drive that throws before `startRun` creates its row releases the lease
     * with the token's `runId` still null. Judging that drive by "the newest
     * operator run for this task" reads a PREVIOUS, unrelated run — usually
     * `finished` — so the "only a run that FINISHED cleanly resumes" guard
     * passed and the backstop fired an unwatched resume chain for a drive that
     * never ran at all.
     */
    it("a drive that produced no run row is not judged by a previous run", async () => {
      // One earlier operator run for this task, finished cleanly.
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      adapter2.finish(
        store2,
        JSON.stringify({ reasoning: "", actions: [] }),
        "finished",
      );
      await eventually(() => {
        expect(operatorRuns().length).toBeGreaterThan(0);
        expect(operatorRuns()[0]!.state).toBe("finished");
      });

      const { maybeResumeStrandedOperator } = await import("./operator-run.server");
      const resumed = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        dataRoot: store2.dataRoot,
        // The failure shape: the starting stage was read, the run never was.
        runId: null,
        stageAtStart: "triage",
      });
      expect(resumed).toBe(false);
    });

    /**
     * Ruling 450, live on ax-clone AX-1: walking Design to Review with nothing
     * to do at Build or Verify took five operator runs, one per stage. A plan
     * carries the whole walk, each move checked from the stage it runs at.
     */
    it("ruling 450: a plan walks two auto stages in one drive", async () => {
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      const walker = operatorRuns()[0]!.id;
      adapter2.finish(
        store2,
        JSON.stringify({
          reasoning: "",
          actions: [
            transitionAction({ toStageId: "ready", reason: "Triage done." }),
            transitionAction({ toStageId: "impl", reason: "Nothing to do at Ready." }),
          ],
        }),
        "finished",
      );
      await eventually(() => {
        const parsed = readTaskFile({ projectSlug: store2.slug, taskKey: "VIB-1", dataRoot: store2.dataRoot })!.parsed;
        expect(parsed.frontmatter.stage).toBe("impl");
      });
      // CANARY: make the executor stop after its first transition and the walk
      // needs a drive per stage again.
      const moves = readTaskFile({ projectSlug: store2.slug, taskKey: "VIB-1", dataRoot: store2.dataRoot })!
        .parsed.timeline.filter((e) => e.type === "transition" && e.actor.kind === "operator");
      expect(moves).toHaveLength(2);
      expect(operatorRuns().find((r) => r.id === walker)?.state).toBe("finished");
    });

    it("a drive that ends doing NOTHING at an auto stage is resumed; a pending decision ends the chain", async () => {
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      expect(adapter2.pending).not.toBeNull();

      // Drive 1 strands: no actions, no reasoning — the live "stopped after
      // set_goal" shape reduced to its observable effect (nothing pending).
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");

      // The settle-time backstop fires a SECOND drive instead of stamping
      // "waiting on a human" over an auto stage.
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter2.pending).not.toBeNull();
      });

      // Drive 2 crosses the AUTO boundary (recommend mode gates approval
      // boundaries; auto ones execute) — and the pass-11 transition re-trigger
      // fires drive 3 at Ready. The task is fully unstuck.
      adapter2.finish(
        store2,
        JSON.stringify({
          reasoning: "",
          actions: [transitionAction({ toStageId: "ready", reason: "Triage done." })],
        }),
        "finished",
      );
      await eventually(() => {
        const fm = readTaskFile({
          projectSlug: store2.slug,
          taskKey: "VIB-1",
          dataRoot: store2.dataRoot,
        })!.parsed.frontmatter;
        expect(fm.stage).toBe("ready");
        expect(operatorRuns()).toHaveLength(3);
        expect(adapter2.pending).not.toBeNull();
      });

      // Drive 3 opens a decision packet — a PENDING DECISION is not stranded,
      // so the settle does NOT resume: the chain rests with the human.
      adapter2.finish(
        store2,
        JSON.stringify({
          reasoning: "",
          actions: [
            {
              tool: "open_packet",
              profileId: null,
              delivers: null,
              toStageId: null,
              packetType: "input",
              text: "Scope the listing format",
              reason: "Two plausible output formats — a human should pick.",
              packetOptions: null,
            },
          ],
        }),
        "finished",
      );
      await eventually(() => {
        expect(
          readTaskFile({
            projectSlug: store2.slug,
            taskKey: "VIB-1",
            dataRoot: store2.dataRoot,
          })!.parsed.packet,
        ).not.toBeNull();
      });
      // Give the settle a beat: no fourth drive appears.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(operatorRuns()).toHaveLength(3);
    });

    /**
     * Ruling 152(a) review (pass 35, G35-5): the drive's OWN move queues no
     * re-trigger any more, so the settle-time backstop is the whole follow-up
     * for it — and on the shipped board the operator's own move lands on In
     * Progress, whose outbound boundary is `approval`. Judged by the `auto`
     * test alone the task was not "stranded", so nothing followed up at all
     * and `clearWaitingToHuman` flipped the board to "waiting on you" with no
     * agent engaged, no packet and nothing to decide.
     */
    it("a drive that MOVES the task onto a non-auto stage and then does nothing is resumed there", async () => {
      // Canary: drop the `ownMoveLandedHere` argument at the
      // `operatorLeftTaskStranded` call site — exactly one run.
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          title: "list files in the project",
          stage: "ready",
          readiness: "ready",
          waiting: "human",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "List the files.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });

      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      expect(adapter2.pending).not.toBeNull();

      // The drive crosses Ready to In Progress (auto) and stops: no dispatch,
      // no packet, no recommendation. In Progress's outbound boundary is
      // `approval`.
      adapter2.finish(
        store2,
        JSON.stringify({
          reasoning: "",
          actions: [transitionAction({ toStageId: "impl", reason: "Ready for work." })],
        }),
        "finished",
      );

      await eventually(() => {
        const fm = readTaskFile({
          projectSlug: store2.slug,
          taskKey: "VIB-1",
          dataRoot: store2.dataRoot,
        })!.parsed.frontmatter;
        expect(fm.stage).toBe("impl");
        // The settle resumed the chain at the stage the drive's own move
        // landed on, instead of leaving the task with no follow-up.
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter2.pending).not.toBeNull();
      });
    });

    /**
     * F31-11 (pass 31, live-caught): a goal that directs HOLDING an auto stage
     * ("do nothing yet") made every drive end stranded, so the resume fired
     * drive after drive back-to-back until the chain cap — and the next
     * trigger re-armed a fresh burst (fourteen paid drives on one no-op task).
     * The resume is ONE nudge: a drive that was itself the nudge and still
     * ends stranded is a deliberate hold — recorded once, then the settle
     * flips waiting to human instead of looping.
     */
    it("a resume drive that strands AGAIN records a deliberate hold instead of looping", async () => {
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      // Drive 1 strands (no actions) → the backstop fires the nudge (drive 2).
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter2.pending).not.toBeNull();
      });
      // The nudge is TOLD it is the one automatic re-invocation, with the
      // record-the-hold exit — that instruction is what makes stopping fair.
      expect(adapter2.pending!.spec.prompt).toContain("re-invoked ONCE");
      expect(adapter2.pending!.spec.prompt).toContain("record the hold");

      // Drive 2 (the nudge) ALSO strands: the deliberate-hold shape.
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");
      await eventually(() => {
        const parsed = readTaskFile({
          projectSlug: store2.slug,
          taskKey: "VIB-1",
          dataRoot: store2.dataRoot,
        })!.parsed;
        // The hold is recorded once, on the timeline, by the policy engine…
        expect(
          parsed.timeline.some((ev) => ev.text.includes("deliberate hold")),
        ).toBe(true);
        // …and DURABLY, in frontmatter (V18) — the marker later settles read.
        expect(parsed.frontmatter.heldAtStage).toBe(parsed.frontmatter.stage);
        // …and coordination settles to the human instead of a third drive.
        expect(parsed.frontmatter.waiting).toBe("human");
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(operatorRuns()).toHaveLength(2);
    });

    /**
     * Ruling 228 (F37-47, live on SHOP-3). The backstop above asks "is the
     * outbound boundary `auto`?", which is the right question for a drive that
     * CHOSE to stop and the wrong one for a drive that was STOPPED. SHOP-3 sat
     * at Verify (boundary `human`) after a plan whose only step — an
     * `update_branch_from_base` — was refused by the capability policy. The
     * refusal even told the operator what to do instead ("recommend or accept
     * the completion instead"), and no operator read it: the turn had ended.
     * 25 minutes parked, on the very run the Codex window had just been waited
     * three hours for.
     *
     * A malformed step is the cheapest whole-plan refusal there is, and it
     * exercises the same `refused.length === plan.actions.length` arithmetic a
     * policy denial does.
     */
    it("ruling 228: a plan refused IN FULL is nudged once, even at a human boundary", async () => {
      // A stage whose outbound boundary is `human`, not `auto` — the shape the
      // backstop could not see.
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          title: "list files in the project",
          stage: "review",
          readiness: "ready",
          waiting: "human",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "A goal with scope.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });

      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "manual",
        dataRoot: store2.dataRoot,
      });
      // Drive 1 plans exactly one action and it does not run.
      // Every field present-but-nullable, the shape OpenAI strict output
      // produces (B-6) — a missing key would fail the plan schema instead,
      // which is the escalation path, not this one.
      // A REAL action the policy refuses: review → done is the locked human
      // boundary, so the operator may not make this move. An empty or
      // unparseable plan is a different case viberr already catches
      // ("produced no actionable plan") — the gap is a plan that named real
      // work and was not allowed to do it.
      const refusedPlan = JSON.stringify({
        reasoning: "Move it along.",
        actions: [transitionAction({ toStageId: "done" })],
      });
      adapter2.finish(store2, refusedPlan, "finished");

      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter2.pending).not.toBeNull();
      });
      // And it is told WHY it is back — not the idle-stage sentence, which
      // would be false twice over here (the stage is not auto-advance, and the
      // run did not end idle by choice).
      const prompt = adapter2.pending!.spec.prompt;
      expect(prompt).toContain("EVERY action your previous run planned was refused");
      expect(prompt).toContain("Do NOT plan the same refused action again");
      expect(prompt).not.toContain("auto-advance stage idle");

      // Drive 2 is refused in full as well: one nudge, then the hold, exactly
      // as F31-11 requires — a refused plan must not loop either.
      adapter2.finish(store2, refusedPlan, "finished");
      await eventually(() => {
        const parsed = readTaskFile({
          projectSlug: store2.slug,
          taskKey: "VIB-1",
          dataRoot: store2.dataRoot,
        })!.parsed;
        expect(parsed.frontmatter.heldAtStage).toBe(parsed.frontmatter.stage);
        expect(parsed.frontmatter.waiting).toBe("human");
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(operatorRuns()).toHaveLength(2);
    });

    /**
     * Ruling 399 (F39-26), live on ax-clone AX-4. The operator planned one
     * `open_packet` twice; both times Viberr refused the step, because a
     * `create_task` option carried no `newTask` title or goal. Then the
     * backstop wrote, 37 milliseconds after the second refusal note:
     *
     *   "the operator held it twice in a row without advancing, dispatching,
     *    or opening a packet — treating that as a deliberate hold. Coordination
     *    is paused here: run the operator manually when the hold should end"
     *
     * Two falsehoods and a remedy that reproduces the problem. It DID try to
     * open a packet, twice; nothing about it was deliberate; and running the
     * operator again plans the same refused step, which is exactly what the one
     * automatic retry had already proved.
     *
     * `planWhollyRefused` is read eleven lines above this note to decide the
     * task is stranded at all — the fact was in the same function the whole
     * time. This pass's signature shape, in the pause that is supposed to tell
     * a human what happened.
     */
    /**
     * Ruling 487 (F40-65): the settle-time backstop read a task holding on a
     * pending schedule as stranded, and its nudge told the operator to "record
     * the hold" with a packet. Live on WEB-9 that was a packet asking the owner
     * to confirm a hold the 11:25Z schedule already explained.
     */
    it("ruling 487: a drive that ends at an auto stage holding on a pending schedule is not nudged", async () => {
      // Canary: stop passing the task's `schedules` to the predicate in
      // `maybeResumeStrandedOperator` (the resume fires).
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-7", {
          title: "read the cron run",
          stage: "triage",
          readiness: "ready",
          waiting: "human",
          ownerUserId: store2.users.arda.id,
          schedules: [
            {
              id: "sch_cron",
              action: "run-operator",
              dueAt: new Date(Date.now() + 3_600_000).toISOString(),
              profileId: null,
              prompt: "Read the 12:17Z cron run.",
              createdBy: "operator",
              createdByLabel: "operator",
              createdAt: new Date().toISOString(),
              status: "pending",
              firedAt: null,
              claimedAt: null,
              retries: 0,
            },
          ],
        }),
        goal: "Read the cron run's output.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      store2.db
        .prepare(
          `INSERT INTO agent_runs
             (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
              turns, input_tokens, cached_input_tokens, output_tokens, usage_final,
              created_at, updated_at, agent_profile_id)
           VALUES ('run_cron', 'VIB-7', ?, 't_run_cron', 'Operator', 'operator', 'codex', 'gpt-5', 'finished',
                   1, 0, 0, 0, 1, ?, ?, 'operator')`,
        )
        .run(store2.slug, "2026-09-25T10:40:00.000Z", "2026-09-25T10:40:00.000Z");
      const before = operatorRuns().length;
      const resumed = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-7",
        dataRoot: store2.dataRoot,
        runId: "run_cron",
        stageAtStart: "triage",
      });
      expect(resumed).toBe(false);
      expect(operatorRuns()).toHaveLength(before);
      // Not a stall and not a deliberate hold either: nothing is recorded.
      expect(
        readTaskFile({ projectSlug: store2.slug, taskKey: "VIB-7", dataRoot: store2.dataRoot })!.parsed
          .frontmatter.heldAtStage,
      ).toBeNull();
    });

    it("ruling 399: a plan Viberr REFUSED is not a deliberate hold", async () => {
      const finishedRun = (id: string, taskKey: string) => {
        store2.db
          .prepare(
            `INSERT INTO agent_runs
               (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
                turns, input_tokens, cached_input_tokens, output_tokens, usage_final,
                created_at, updated_at, agent_profile_id)
             VALUES (?, ?, ?, ?, 'Operator', 'operator', 'codex', 'gpt-5', 'finished',
                     1, 0, 0, 0, 1, ?, ?, 'operator')`,
          )
          .run(
            id,
            taskKey,
            store2.slug,
            `t_${id}`,
            "2026-09-13T00:00:00.000Z",
            "2026-09-13T00:00:00.000Z",
          );
      };
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-9", {
          title: "the refused plan",
          stage: "triage",
          readiness: "ready",
          waiting: "agent",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "Do the thing.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      finishedRun("run_refused", "VIB-9");
      const resumed = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-9",
        dataRoot: store2.dataRoot,
        runId: "run_refused",
        stageAtStart: "triage",
        strandedResume: true,
        ownRun: {
          backend: "codex",
          autonomy: "supervised",
          reactDepth: 0,
          movedToStageId: "triage",
          planWhollyRefused: true,
        },
      });
      expect(resumed).toBe(false);
      const parsed = readTaskFile({
        projectSlug: store2.slug,
        taskKey: "VIB-9",
        dataRoot: store2.dataRoot,
      })!.parsed;
      // The pause itself is right and stays: something IS wrong here.
      expect(parsed.frontmatter.heldAtStage).toBe("triage");
      const note = parsed.timeline[0]!.text;
      // CANARY: drop the `planRefused` branch and this note calls a refused
      // plan a deliberate hold, which is what AX-4's timeline says verbatim.
      expect(note).toContain("did not hold this stage");
      expect(note).toContain("Every action it planned was refused");
      expect(note).not.toContain("deliberate hold");
      // …and the remedy no longer sends the reader at the one move that
      // reproduces it.
      expect(note).not.toContain("run the operator manually");
      expect(note).toContain("take the action yourself");
    });

    /**
     * Ruling 202 (F37-22, live on SHOP-10). A nudged drive whose single action
     * was `deliver_for_review` — it pushed the branch and opened PR #8 — was
     * recorded by this backstop as having "held it twice in a row without
     * advancing, dispatching, or opening a packet", and the note told a human
     * "Coordination is paused here: run the operator manually". It was not
     * paused: a drive was starting 2ms before the note was written, and it
     * moved the task to Review 23 seconds later with nobody touching anything.
     *
     * The other three ways a drive can act were already covered — a transition
     * by `movedToStageId`, a dispatch by the live-run check in
     * `settleWaitingAfterOperator`, a packet or recommendation by
     * `operatorLeftTaskStranded`. Delivery was covered by nothing.
     *
     * Driven through the real backstop with a hand-written finished run row,
     * because this fixture's project has no repo and a real `deliver_for_review`
     * would be refused before `performDelivery` ever stamps anything.
     */
    it("ruling 202: a nudged drive that DELIVERED is not a deliberate hold", async () => {
      const finishedRun = (id: string, taskKey: string) => {
        store2.db
          .prepare(
            `INSERT INTO agent_runs
               (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
                turns, input_tokens, cached_input_tokens, output_tokens, usage_final,
                created_at, updated_at, agent_profile_id)
             VALUES (?, ?, ?, ?, 'Operator', 'operator', 'codex', 'gpt-5', 'finished',
                     1, 0, 0, 0, 1, ?, ?, 'operator')`,
          )
          .run(
            id,
            taskKey,
            store2.slug,
            `t_${id}`,
            "2026-09-13T00:00:00.000Z",
            "2026-09-13T00:00:00.000Z",
          );
      };
      const held = (taskKey: string) =>
        readTaskFile({ projectSlug: store2.slug, taskKey, dataRoot: store2.dataRoot })!.parsed;

      // Control: the same shape WITHOUT the delivery still records the hold,
      // so this test cannot pass by disabling the backstop.
      finishedRun("run_ctl", "VIB-1");
      const heldAgain = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        dataRoot: store2.dataRoot,
        runId: "run_ctl",
        stageAtStart: "triage",
        strandedResume: true,
        ownRun: {
          backend: "codex",
          autonomy: "supervised",
          reactDepth: 0,
          movedToStageId: "triage",
        },
      });
      expect(heldAgain).toBe(false);
      expect(held("VIB-1").frontmatter.heldAtStage).toBe("triage");
      expect(held("VIB-1").timeline.some((ev) => ev.text.includes("deliberate hold"))).toBe(true);

      // The delivering drive, on a task of its own.
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-2", {
          title: "ship the parser",
          stage: "triage",
          readiness: "ready",
          waiting: "agent",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "Ship it.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      finishedRun("run_del", "VIB-2");
      // CANARY: drop `|| ref.ownRun?.delivered === true` from nudgeMadeProgress
      // and this returns false, `heldAtStage` is stamped, and the note claiming
      // coordination is paused lands on a task that was just delivered.
      const resumed = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-2",
        dataRoot: store2.dataRoot,
        runId: "run_del",
        stageAtStart: "triage",
        strandedResume: true,
        ownRun: {
          backend: "codex",
          autonomy: "supervised",
          reactDepth: 0,
          movedToStageId: "triage",
          delivered: true,
        },
      });
      expect(resumed).toBe(true);
      expect(held("VIB-2").frontmatter.heldAtStage).toBeNull();
      expect(held("VIB-2").timeline.some((ev) => ev.text.includes("deliberate hold"))).toBe(false);
    });

    /**
     * Ruling 406 (F39-33), measured live on ax-clone AX-18.
     *
     * Viberr refused the transition -- "Open the conflict packet
     * (update_branch_from_base) or deliver the revision instead of moving the
     * task" -- and the operator planned exactly the action that sentence
     * names. `operatorUpdateBranchFromBase` succeeded; the branch was already
     * current, so it moved nothing and recorded no base refresh. A refresh is
     * not a transition, a dispatch, a delivery or a packet, so Viberr wrote
     * "the operator held it twice in a row without advancing, dispatching, or
     * opening a packet", stamped `heldAtStage` and paused coordination on a
     * task whose operator had done what it was told.
     *
     * The three clauses before this one were each added the same way (152(a),
     * 202, 228). This one is not a fourth effect: it is the fact that the
     * drive ACTED, which is what "held" was always meant to deny.
     */
    it("ruling 406: a nudged drive that CARRIED OUT its action is not a deliberate hold", async () => {
      const finishedRun = (id: string, taskKey: string) => {
        store2.db
          .prepare(
            `INSERT INTO agent_runs
               (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
                turns, input_tokens, cached_input_tokens, output_tokens, usage_final,
                created_at, updated_at, agent_profile_id)
             VALUES (?, ?, ?, ?, 'Operator', 'operator', 'codex', 'gpt-5', 'finished',
                     1, 0, 0, 0, 1, ?, ?, 'operator')`,
          )
          .run(id, taskKey, store2.slug, `t_${id}`, "2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.000Z");
      };
      const held = (taskKey: string) =>
        readTaskFile({ projectSlug: store2.slug, taskKey, dataRoot: store2.dataRoot })!.parsed;

      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-9", {
          title: "refresh the branch Viberr asked for",
          stage: "triage",
          readiness: "ready",
          waiting: "agent",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "Do the thing the refusal named.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      finishedRun("run_acted", "VIB-9");

      // CANARY: drop `|| ref.ownRun?.carriedOutAction === true` from
      // nudgeMadeProgress and this returns false, `heldAtStage` is stamped,
      // and the note lands on a drive that did exactly what Viberr asked.
      const resumedAfterAction = await maybeResumeStrandedOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-9",
        dataRoot: store2.dataRoot,
        runId: "run_acted",
        stageAtStart: "triage",
        strandedResume: true,
        ownRun: {
          backend: "codex",
          autonomy: "supervised",
          reactDepth: 0,
          // The drive ended where it started and delivered nothing -- exactly
          // AX-18's shape. The only thing that distinguishes it is that it
          // ACTED.
          movedToStageId: "triage",
          carriedOutAction: true,
        },
      });
      expect(resumedAfterAction).toBe(true);
      expect(held("VIB-9").frontmatter.heldAtStage).toBeNull();
      expect(held("VIB-9").timeline.some((ev) => ev.text.includes("deliberate hold"))).toBe(false);
    });

    /**
     * F39-69, live on ax-clone AX-5. A person's directive had three steps:
     * bring the branch up to date, rework with one agent, then another. The
     * Codex operator planned only the refresh. It merged two commits and the
     * turn ended. Review's way out is a person's, so the backstop (auto stages
     * only) did not resume it, and the board read "waiting on a human" with
     * nothing to answer until the owner pressed Run operator.
     */
    it("F39-69: a drive that refreshed and stopped at Review is resumed once, and told why", async () => {
      const finishedRun = (id: string, taskKey: string) => {
        store2.db
          .prepare(
            `INSERT INTO agent_runs
               (id, task_key, project_slug, thread_id, role, kind, backend, model, state,
                turns, input_tokens, cached_input_tokens, output_tokens, usage_final,
                created_at, updated_at, agent_profile_id)
             VALUES (?, ?, ?, ?, 'Operator', 'operator', 'codex', 'gpt-5', 'finished',
                     1, 0, 0, 0, 1, ?, ?, 'operator')`,
          )
          .run(id, taskKey, store2.slug, `t_${id}`, "2026-09-23T05:10:09.000Z", "2026-09-23T05:10:18.000Z");
      };
      writeTask(store2.dataRoot, store2.slug, {
        frontmatter: baseTaskFrontmatter("VIB-11", {
          title: "ax ssh",
          stage: "review",
          readiness: "ready",
          waiting: "agent",
          ownerUserId: store2.users.arda.id,
        }),
        goal: "Rework after the refresh.",
      });
      rebuildAll(store2.db, { dataRoot: store2.dataRoot, force: true });
      finishedRun("run_refreshed", "VIB-11");
      finishedRun("run_nudged", "VIB-11");
      const ownRun = { backend: "codex" as const, autonomy: "supervised" as const, reactDepth: 0 };
      const ref = {
        projectSlug: store2.slug,
        taskKey: "VIB-11",
        dataRoot: store2.dataRoot,
        stageAtStart: "review",
      };
      // A drive that acted without refreshing, at a stage a person closes,
      // is not stranded: the refresh is the whole difference.
      expect(
        await maybeResumeStrandedOperator(store2.db, {
          ...ref,
          runId: "run_refreshed",
          ownRun: { ...ownRun, carriedOutAction: true },
        }),
      ).toBe(false);
      // The nudge itself refreshing and stopping again re-arms nothing.
      expect(
        await maybeResumeStrandedOperator(store2.db, {
          ...ref,
          runId: "run_nudged",
          strandedResume: true,
          ownRun: { ...ownRun, carriedOutAction: true, refreshed: true },
        }),
      ).toBe(false);
      // A drive that refreshed AND delivered took the step the refresh was
      // for; the nudge would open "nothing was dispatched, delivered or asked".
      // CANARY: drop the `delivered` check and this drive is nudged anyway.
      expect(
        await maybeResumeStrandedOperator(store2.db, {
          ...ref,
          runId: "run_refreshed",
          ownRun: { ...ownRun, carriedOutAction: true, refreshed: true, delivered: true },
        }),
      ).toBe(false);
      // CANARY: drop the `refreshedAndStopped` arm and AX-5 sits at Review
      // with nobody coming.
      const resumed = await maybeResumeStrandedOperator(store2.db, {
        ...ref,
        runId: "run_refreshed",
        ownRun: { ...ownRun, carriedOutAction: true, refreshed: true },
      });
      expect(resumed).toBe(true);
      await eventually(() => expect(adapter2.pending).not.toBeNull());
      const prompt = adapter2.pending!.spec.prompt;
      // CANARY: drop the `refreshNudge` mapping and it is told the stage is an
      // idle auto-advance one, which Review is not.
      expect(prompt).toContain(REFRESH_ENDED_NUDGE);
      expect(prompt).not.toContain("auto-advance stage idle");
    });

    /**
     * V18 (pass-31 review): the hold must survive LATER external triggers. The
     * one-nudge guard alone was per-drive, in-memory — every schedule firing
     * or machine trigger started an unmarked drive, the backstop paid one
     * fresh nudge, and the second stranding appended a byte-identical hold
     * note: two drives and a duplicate note per trigger, forever. The durable
     * `heldAtStage` marker keeps the backstop quiet until a human re-litigates
     * (transition, packet resolution, goal edit).
     */
    it("a recorded hold keeps the backstop quiet on later external triggers — no duplicate note, no paid nudge", async () => {
      // Reach the recorded-hold state: drive 1 strands → nudge (drive 2) →
      // strands again → hold recorded.
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter2.pending).not.toBeNull();
      });
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");
      await eventually(() => {
        expect(
          readTaskFile({
            projectSlug: store2.slug,
            taskKey: "VIB-1",
            dataRoot: store2.dataRoot,
          })!.parsed.frontmatter.heldAtStage,
        ).not.toBeNull();
      });

      // A later EXTERNAL machine trigger (the schedule-fire shape) drives once…
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "transition",
        dataRoot: store2.dataRoot,
      });
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(3);
        expect(adapter2.pending).not.toBeNull();
      });
      // …and that drive ends stranded at the SAME held stage.
      adapter2.finish(store2, JSON.stringify({ reasoning: "", actions: [] }), "finished");
      await new Promise((resolve) => setTimeout(resolve, 120));

      // The recorded hold answers: no fourth drive, and still exactly ONE
      // hold note on the timeline.
      expect(operatorRuns()).toHaveLength(3);
      const parsed = readTaskFile({
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        dataRoot: store2.dataRoot,
      })!.parsed;
      expect(
        parsed.timeline.filter((ev) => ev.text.includes("deliberate hold")),
      ).toHaveLength(1);
      expect(parsed.frontmatter.heldAtStage).toBe(parsed.frontmatter.stage);
    });

    it("an ERRORED drive is not resumed — failures must not loop", async () => {
      await runOperator(store2.db, {
        projectSlug: store2.slug,
        taskKey: "VIB-1",
        backend: "codex",
        autonomy: "supervised",
        trigger: "create",
        dataRoot: store2.dataRoot,
      });
      adapter2.finish(store2, "provider exploded", "error");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(operatorRuns()).toHaveLength(1);
    });
  });
});

/* -------- transition context in the turn prompt (owner ruling 2026-07-26) -------- */

describe("transition trigger carries from → to and who moved it", () => {
  const snap = (): OperatorTaskSnapshot => ({
    key: "VIB-2",
    // Ruling 302: the window's own size, always present.
    timelineTotal: 0,
    title: "t",
    goal: "Write the post.",
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    stage: "impl",
    stageName: "In Progress",
    previousStage: null,
    readiness: "ready",
    waiting: "agent",
    validation: "changed",
    owner: null,
    specialist: null,
    reviewers: [],
    nextStages: [{ id: "review", name: "Review", boundary: "approval" }],
    reworkStages: [],
    stageIds: ["triage", "ready", "impl", "review", "done"],
    doneStageId: "done",
    reviewStageId: "review",
    workStageId: "impl",
    deployedSpecialists: [],
    openPacket: false,
    packet: null,
    recentTimeline: [],
    pr: null,
    branch: "vib-2",
    liveRuns: [],
    autonomy: "supervised",
    operatorPolicy: { scope: "operator", note: "", capabilities: {} },
  });

  it("a HUMAN move names them, points at their steer, and says ASK (@tag) when unclear", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap(),
      "transition",
      undefined,
      undefined,
      undefined,
      { fromName: "Review", toName: "In Progress", byHuman: "Arda" },
    );
    expect(prompt).toContain('A human (Arda) moved this task from "Review" to "In Progress"');
    expect(prompt).toContain("re-prompting the delivering profile");
    expect(prompt).toContain('tag "@Arda"');
    expect(prompt).toContain("Never guess a rework direction");
  });

  it("the generic block keys in-flight on liveRuns and covers the undelivered hand-off", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "manual");
    expect(prompt).toContain("`liveRuns` in the snapshot is the ONLY proof");
    expect(prompt).toContain("did NOT start a run");
    expect(prompt).toContain("re-send the prompt yourself");
  });

  it("the operator's OWN move keeps the normal continue-flow tone", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap(),
      "transition",
      undefined,
      undefined,
      undefined,
      { fromName: "Ready", toName: "In Progress", byHuman: null },
    );
    expect(prompt).toContain('You moved this task from "Ready" to "In Progress"');
    expect(prompt).not.toContain("Never guess");
  });

  it("the Codex plan prompt carries the same context", () => {
    const prompt = operatorPrompts.buildCodexOperatorPrompt(
      snap(),
      "transition",
      undefined,
      undefined,
      undefined,
      { fromName: "Review", toName: "In Progress", byHuman: "Arda" },
    );
    expect(prompt).toContain('A human (Arda) moved this task');
  });
});

/* ---------------- triage quality gate + scheduled origin (F15-14 / B-WF3) --------------- */

describe("turn doctrine: triage quality gate and scheduled re-runs", () => {
  const snap = (
    over: Partial<OperatorTaskSnapshot> = {},
  ): OperatorTaskSnapshot => ({
    key: "VIB-6",
    // Ruling 302: the window's own size, always present.
    timelineTotal: 0,
    title: "Improve the docs",
    // The live goal that sailed through the gate: no file, no change, no
    // acceptance criteria — and NOT the unspecified placeholder, so the
    // goal-drafting branch never fired either.
    goal: "The documentation could be improved. Make it better.",
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    stage: "triage",
    stageName: "Triage",
    previousStage: null,
    readiness: "ready",
    waiting: "human",
    validation: "changed",
    owner: null,
    specialist: null,
    reviewers: [],
    nextStages: [{ id: "ready", name: "Ready", boundary: "auto" }],
    reworkStages: [],
    stageIds: ["triage", "ready", "impl", "review", "done"],
    doneStageId: "done",
    reviewStageId: "review",
    workStageId: "impl",
    deployedSpecialists: [],
    openPacket: false,
    packet: null,
    recentTimeline: [],
    pr: null,
    branch: null,
    liveRuns: [],
    autonomy: "supervised",
    operatorPolicy: { scope: "operator", note: "", capabilities: {} },
    ...over,
  });

  /**
   * Ruling 193 (F37-14, live): the doctrine had ONE answer to a
   * request-changes — re-prompt the deliverer — and a reviewer can request
   * changes for a reason no revision can satisfy. A required reviewer
   * chartered to bring a Docker stack up ran on a host with no `make` and no
   * Docker, said so plainly, and the work went back for rework round after
   * round. The missing arm is here.
   */
  /**
   * Ruling 210 (owner). Ruling 193 covers a reviewer whose objection SURVIVES a
   * rework. The other expensive shape had no arm at all: a reviewer whose
   * objection is answered every round and who returns a new, valid one each
   * time. Live on this board, twice — SHOP-6 took seven rounds, SHOP-10 five,
   * every round correct on its own terms and nobody ever asked the reviewer
   * what else it would block on.
   */
  it("ruling 210: the turn names the DIFFERENT-objection-each-round shape too, and what to require", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "create");
    // CANARY: delete the arm and the doctrine has one answer for every
    // request-changes that was actually fixed — send it back again.
    expect(prompt).toContain("a DIFFERENT objection each round");
    expect(prompt).toContain("the COMPLETE set it would block on for that revision");
    expect(prompt).toContain(
      "name everything you would still block on across your owned surface, now",
    );
    expect(prompt).toContain(
      "Do not send the deliverer back into another round until the reviewer has answered.",
    );
  });

  /**
   * Ruling 214 (F37-34). Ruling 210's arm said "ask in ONE comment", and live
   * on SHOP-10 the operator did exactly that: it posted "@Code Reviewer, name
   * everything you would still block on" and stopped. `post_comment` writes a
   * timeline line and starts nothing, so no reviewer ever read it — and the
   * stranded backstop, which counts a transition, a dispatch, a delivery or a
   * packet as progress and a comment as nothing, recorded a deliberate hold
   * and paused coordination on the task five others were waiting behind. The
   * turn's own earlier bullet already says a directive comment is not a
   * running agent; this arm contradicted it.
   */
  it("ruling 214: the completeness question is a RUN of the reviewer, not a comment nobody reads", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "create");
    // CANARY: put "in ONE comment" back and the only action the arm names is
    // one that reaches no agent and counts as no progress.
    expect(prompt).toContain("`run_agent` THE REVIEWER with `delivers: false`");
    expect(prompt).toContain("`post_comment` is narration for the humans and reaches no agent");
    expect(prompt).not.toContain("Ask the reviewer which, in ONE comment");
  });

  it("ruling 193: a second rework on the same reviewer stops being a rework", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "create");
    // CANARY: delete the arm and the line above it — "the deliverer owes NEW
    // work" — is the only instruction the turn carries for a request-changes.
    expect(prompt).toContain("consecutiveRequestChanges");
    expect(prompt).toContain("the deliverer owes NOTHING");
    // Ruling 200(i): the SHARED doctrine names Claude's tool everywhere else
    // (`open_decision_packet`, four other places in the same turn text);
    // `open_packet` is the CODEX plan action. My arm was the only line in the
    // doctrine naming a tool a Claude operator does not have. CANARY: put
    // `open_packet` back and this fails.
    expect(prompt).toContain("`open_decision_packet` for the person who owns the task");
    expect(prompt).not.toContain("`open_packet` for the person");
    // It names the three real exits, so the packet is not an empty escalation.
    expect(prompt).toContain("drop or replace that required reviewer");
    expect(prompt).toContain("A reviewer that cannot pass is a decision, not a defect.");
    // And it points at the inventory the same prompt now carries (ruling 191)
    // rather than asking the model to intuit what is installed.
    expect(prompt).toContain("your shell inventory says is not installed on this host");

    // And the number the arm names must actually REACH the model — the whole
    // bug class this pass is about is a fact the server holds and the agent
    // cannot see. A Codex operator gets the snapshot inline as JSON; a Claude
    // one reads the same object through `get_task`, whose description points at
    // the field by name.
    const withReviewer = operatorPrompts.buildCodexOperatorPrompt(
      snap({
        reviewers: [
          {
            profileId: "reviewer",
            role: "Review & validation",
            backend: "codex",
            verdict: "request_changes",
            consecutiveRequestChanges: 3,
          },
        ],
      }),
      "agent-reply",
    );
    expect(withReviewer).toContain('"consecutiveRequestChanges": 3');
  });

  it("F15-14: the entry stage carries the gate — no forward move on a vague goal", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "create");
    expect(prompt).toContain("TRIAGE QUALITY GATE");
    expect(prompt).toContain("MUST NOT `transition_stage` forward");
    expect(prompt).toContain("`set_goal`");
    expect(prompt).toContain("2–4 concrete scopes");
    // Advancing requires SAYING why the goal is concrete.
    expect(prompt).toContain("name the deliverable and the acceptance signal");
  });

  /**
   * Ruling 85 / R21-2 — VIB-1: the operator correctly found that no deployed
   * profile held `browser` and offered three workarounds (write a Playwright
   * script / capture it by hand / let the operator write the goal). The product
   * SHIPS a grantable browser capability; the packet never said so, so the
   * human's cheapest fix was the one path the packet hid.
   */
  it("R21-2: a capability gap must point at the config remedy, not only workarounds", () => {
    // Canary: drop the CAPABILITY_GAP_REMEDY_INSTRUCTION append from
    // `operatorTurnInstruction` and all four fail.
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "create");
    expect(prompt).toContain("CAPABILITY no deployed agent declares");
    expect(prompt).toContain("grantable on an agent profile");
    expect(prompt).toContain("Agents surface");
    // The ruling's other half: it points, it never reconfigures.
    expect(prompt).toContain("never change that configuration yourself");
  });

  /**
   * Pass-35 cluster review: ruling 164's authoring door refuses a send-back
   * option whose words ask a person to edit an agent profile, and this turn
   * text (the ONE both backends receive) still told the operator to write one.
   * The remedy is still named on every turn; it is named in the packet's own
   * words instead of as an option the door answers `noop` to.
   */
  it("ruling 85 under ruling 164: the remedy is named in the packet, never authored as an option", () => {
    // Canary: restore "offer it as an option a human can act on".
    for (const prompt of [
      operatorPrompts.buildOperatorTurnPrompt(snap(), "create"),
      operatorPrompts.buildCodexOperatorPrompt(snap(), "create"),
    ]) {
      expect(prompt).toContain("grantable on an agent profile");
      expect(prompt).toContain("lists only workarounds hides the fix");
      expect(prompt).toContain("Never write it as an OPTION");
      expect(prompt).not.toMatch(/offer it as an option/i);
      // The named-resource half of the same instruction says it too.
      expect(prompt).not.toMatch(/offer granting it .{0,60} as an option/i);
    }
  });

  it("ruling 152(a): the stage rule says to walk consecutive auto boundaries in ONE turn", () => {
    // Pass 35, G35-5: the old sentence ("advancing one boundary and stopping is
    // fine") paid a fresh operator turn per stage. Canary: restore it.
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap({ stage: "ready", stageName: "Ready", goal: "Add the parser and its tests to src/parser." }),
      "transition",
    );
    expect(prompt).toContain("call transition_stage again in this same turn");
    expect(prompt).toContain("re-invoked only when your turn ends at a stage that still needs work");
    expect(prompt).not.toContain("advancing one boundary and stopping is fine");
  });

  it("R21-2: the Codex plan prompt carries the same remedy instruction", () => {
    expect(operatorPrompts.buildCodexOperatorPrompt(snap(), "create")).toContain(
      "grantable on an agent profile",
    );
  });

  /**
   * R21-2 residual (band-3 follow-up) — the remedy was emitted from
   * `triageQualityGate`, so it reached the model only at the ENTRY stage and
   * only on the triggers that splice that gate in. A capability gap is not a
   * triage-time condition: the operator meets it at the work-stage hand-off and
   * when an agent reports "I cannot drive a browser" — and at every one of those
   * it was back to offering workarounds only.
   */
  it("R21-2 residual: the remedy is STAGE- and TRIGGER-independent, on BOTH builders", () => {
    // Canary: move the append back inside `triageQualityGate` and every
    // assertion below fails while the entry-stage tests above still pass.
    const atWork = snap({
      stage: "impl",
      stageName: "In Progress",
      goal: "Screenshot the live dashboard and attach it.",
    });
    // `agent-reply` is one of the branches that RETURNS before the stage gate —
    // the shape the gap is most often discovered in.
    const claudeTurn = operatorPrompts.buildOperatorTurnPrompt(atWork, "agent-reply");
    expect(claudeTurn).not.toContain("TRIAGE QUALITY GATE");
    expect(claudeTurn).toContain("CAPABILITY no deployed agent declares");
    expect(claudeTurn).toContain("grantable on an agent profile");
    expect(claudeTurn).toContain("Agents surface");
    expect(claudeTurn).toContain("never change that configuration yourself");

    const codexPlan = operatorPrompts.buildCodexOperatorPrompt(atWork, "transition");
    expect(codexPlan).not.toContain("TRIAGE QUALITY GATE");
    expect(codexPlan).toContain("CAPABILITY no deployed agent declares");
    expect(codexPlan).toContain("grantable on an agent profile");
    expect(codexPlan).toContain("never change that configuration yourself");
  });

  it("R21-2 residual: it survives the branches that answer a human or a packet", () => {
    const atWork = snap({ stage: "impl", stageName: "In Progress", goal: "Ship it." });
    for (const prompt of [
      operatorPrompts.buildOperatorTurnPrompt(atWork, "manual", "Can you screenshot it?", undefined, "Arda"),
      operatorPrompts.buildOperatorTurnPrompt(atWork, "packet-resolved"),
      operatorPrompts.buildOperatorTurnPrompt(atWork, "delivered"),
    ]) {
      expect(prompt).toContain("grantable on an agent profile");
    }
  });

  it("ruling 136(a): the human's note and the server's outcome render as different speakers", () => {
    // Canary: embed the outcome in `resolvedOption.note` and the quoted note
    // carries a sentence the person never wrote.
    const atWork = snap({ stage: "impl", stageName: "In Progress", goal: "Ship it." });
    const prompt = operatorPrompts.buildOperatorTurnPrompt(atWork, "packet-resolved", undefined, undefined, undefined, undefined, undefined, {
      kind: "resolve_remote_collision",
      title: "Delete the stale remote branch, then redeliver",
      note: "please get it onto the PR",
      serverOutcome: { kind: "resolve_remote_collision", outcome: "own_pr_pushed", prNumber: 5 },
    });
    expect(prompt).toContain('the human added: "please get it onto the PR"');
    expect(prompt).toContain("Viberr then performed that option's own steps and reports, in its own words and not the person's: there was no collision to clear (PR #5 is this task's own review PR); the delivered revision was pushed to it and the block is lifted.");
    const quoted = /the human added: "([^"]*)"/.exec(prompt)![1]!;
    expect(quoted).not.toContain("no collision");
    const withoutNote = operatorPrompts.buildOperatorTurnPrompt(atWork, "packet-resolved", undefined, undefined, undefined, undefined, undefined, {
      kind: "resolve_remote_collision",
      title: "Delete the stale remote branch, then redeliver",
      serverOutcome: { kind: "resolve_remote_collision", outcome: "refused", reason: "GitHub refused the deletion (boom)." },
    });
    expect(withoutNote).not.toContain("the human added");
    expect(withoutNote).toContain("the collision was not cleared (GitHub refused the deletion (boom).); nothing was re-delivered and the block stays.");
  });

  it("ruling 131(d): a held prompt REPLACES the stage rule: no 'NEVER end your turn', no hold-packet exit, and it names set_dependencies", () => {
    // Canary: append the held doctrine to the ordinary tail instead of
    // returning it (both orders then appear in one prompt).
    const held = snap({
      stage: "impl",
      stageName: "In Progress",
      goal: "Ship it.",
      blockedBy: [
        { ref: "JC-3", label: "JC-3", state: "open", taskKey: "JC-3" },
        { ref: "JC-6", label: "JC-6", state: "failed", taskKey: "JC-6" },
      ],
    });
    for (const prompt of [
      operatorPrompts.buildOperatorTurnPrompt(held, "manual"),
      operatorPrompts.buildOperatorTurnPrompt(held, "agent-reply", undefined, "I finished.", undefined, undefined, undefined, undefined, true),
      operatorPrompts.buildCodexOperatorPrompt(held, "manual"),
    ]) {
      expect(prompt).toContain("This task WAITS ON OTHER WORK and Viberr is holding it: JC-3 (open), JC-6 (archived, can never complete).");
      expect(prompt).toContain("`set_dependencies`");
      expect(prompt).toContain("do NOT open a decision packet about the wait");
      expect(prompt).not.toContain("NEVER end your turn");
      expect(prompt).not.toContain("asking the human to confirm the hold");
      expect(prompt).not.toContain("You are at stage");
    }
    // A human's direct question still gets the answer branch, and the hold
    // still binds what the answer may do.
    const asked = operatorPrompts.buildOperatorTurnPrompt(held, "manual", "Why is this waiting?", undefined, "Arda");
    expect(asked).toContain("addressed you directly");
    expect(asked).toContain("This task waits on other work (JC-3 (open), JC-6 (archived, can never complete)) and Viberr is holding it: answer them");
    expect(asked).not.toContain("NEVER end your turn");
    // Every waking trigger, not only `manual`, gets the held doctrine.
    for (const trigger of ["goal-updated", "pr-diverged", "packet-resolved", "delivered", "transition", "scheduled"] as const) {
      const prompt = operatorPrompts.buildOperatorTurnPrompt(held, trigger);
      expect(prompt, trigger).toContain("This task WAITS ON OTHER WORK");
      expect(prompt, trigger).not.toContain("NEVER end your turn");
    }
  });

  it("ruling 131(e): the dependencies-released doctrine names the entries, the base re-read and the moot packet, then continues with the stage rule", () => {
    // Canary: return "" from `dependenciesInstruction`.
    const atWork = snap({ stage: "impl", stageName: "In Progress", goal: "Ship it.", openPacket: true });
    const prompt = operatorPrompts.buildOperatorTurnPrompt(atWork, "dependencies-released", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      entries: ["JC-2", "JC-3"],
      clearedBy: null,
    });
    expect(prompt).toContain("The work this task waited on has landed: JC-2, JC-3 is done.");
    expect(prompt).toContain("The base branch has CHANGED since the hold");
    expect(prompt).toContain("it is now MOOT: `resolve_decision_packet` it first");
    expect(prompt).toContain("You are at stage \"In Progress\"");
    const byHand = operatorPrompts.buildOperatorTurnPrompt(atWork, "dependencies-released", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      entries: ["JC-3"],
      clearedBy: "arda@viberr.dev",
    });
    expect(byHand).toContain("arda@viberr.dev cleared the wait on JC-3");
  });

  it("F39-65: a release at birth tells the operator nothing held the task and there is nothing to refresh", () => {
    const atStart = snap({ stage: "design", stageName: "Design", goal: "Ship it." });
    const prompt = operatorPrompts.buildOperatorTurnPrompt(atStart, "dependencies-released", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      entries: ["AX-4", "goal-4 link 7 (AX-27)"],
      clearedBy: null,
      atBirth: true,
    });
    // CANARY: drop the `atBirth` arm and a task born minutes ago is told the
    // base "CHANGED since the hold" and that its delivered work may need it.
    expect(prompt).toContain("was done before it was created (AX-4, goal-4 link 7 (AX-27)), so nothing held it");
    expect(prompt).toContain("there is nothing to bring up to date");
    expect(prompt).not.toContain("CHANGED since the hold");
    expect(prompt).not.toContain("delivered work from before the hold");
  });

  it("ruling 133 (A19): the agent-reply doctrine re-prompts the deliverer in place on BOTH builders", () => {
    // Canary: restore either builder's old rework sentence.
    const atWork = snap({ stage: "impl", stageName: "In Progress", goal: "Ship it." });
    for (const prompt of [
      operatorPrompts.buildOperatorTurnPrompt(atWork, "manual"),
      operatorPrompts.buildCodexOperatorPrompt(atWork, "manual"),
    ]) {
      expect(prompt).toContain("The engaged deliverer runs at EVERY stage (ruling 133): re-prompt it in place, never hand delivery to another profile to get around a stage");
      expect(prompt).toContain("rework for the profile that built it (which runs at every stage, ruling 133)");
    }
  });

  it("ruling 130(c): the packet-resolved instruction bolds the decided title and claims no policy or credential fix", () => {
    // Live (JC-6): the old parenthetical "(a policy/credential fix means
    // re-check the work that was blocked)" plus a record saying "policy /
    // credential updated" had the operator tell the specialist a GitHub-scope
    // block was lifted when nothing had changed.
    // Canary: restore that parenthetical.
    const atWork = snap({ stage: "impl", stageName: "In Progress", goal: "Ship it." });
    const prompt = operatorPrompts.buildOperatorTurnPrompt(atWork, "packet-resolved", undefined, undefined, undefined, undefined, undefined, {
      kind: "block_on_policy",
      title: "Re-run the operator now",
    });
    expect(prompt).toContain("**Re-run the operator now**");
    expect(prompt).toContain("Assume NOTHING about credentials or policy beyond what the decision itself says");
    expect(prompt).toContain("stays in force until its own record says otherwise");
    expect(prompt).not.toContain("policy/credential fix");
  });

  it("F15-14: the gate is stage-scoped — a work stage never carries it", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap({ stage: "impl", stageName: "In Progress", goal: "Ship the parser." }),
      "transition",
    );
    expect(prompt).not.toContain("TRIAGE QUALITY GATE");
  });

  it("F15-14: the Codex plan prompt carries the same gate", () => {
    const prompt = operatorPrompts.buildCodexOperatorPrompt(snap(), "create");
    expect(prompt).toContain("TRIAGE QUALITY GATE");
    expect(prompt).toContain("MUST NOT `transition_stage` forward");
  });

  it("F15-14: the GOAL-EDIT turn carries the gate — a still-vague edit buys no move", () => {
    // The turn right after a human edits a vague goal is where the gate is most
    // needed, and it had its own branch that returned before the gate spliced in.
    const prompt = operatorPrompts.buildOperatorTurnPrompt(snap(), "goal-updated");
    expect(prompt).toContain("The goal was edited");
    expect(prompt).toContain("TRIAGE QUALITY GATE");
    expect(prompt).toContain("MUST NOT `transition_stage` forward");
    // Still stage-scoped: a work-stage goal edit gets the plain branch.
    expect(
      operatorPrompts.buildOperatorTurnPrompt(
        snap({ stage: "impl", stageName: "In Progress", goal: "Ship the parser." }),
        "goal-updated",
      ),
    ).not.toContain("TRIAGE QUALITY GATE");
  });

  it("F15-14: the Codex goal-edit turn carries it too", () => {
    const prompt = operatorPrompts.buildCodexOperatorPrompt(snap(), "goal-updated");
    expect(prompt).toContain("TRIAGE QUALITY GATE");
  });

  it("S3-1: a question answered while a packet is open must not open a SECOND one", () => {
    // Each queued question drains as its own governed turn. B3 made a second
    // packet a REFUSAL rather than a silent replacement, so the turn says what
    // the tool now does: answer from the open packet, withdraw it first if it
    // is genuinely moot.
    const withPacket = operatorPrompts.buildOperatorTurnPrompt(
      snap({ stage: "impl", stageName: "In Progress", openPacket: true }),
      "manual",
      "@operator should we ship without the migration?",
      undefined,
      "Arda",
    );
    expect(withPacket).toContain("A decision packet is ALREADY OPEN");
    expect(withPacket).toContain("`open_decision_packet` is REFUSED while it stands");
    expect(withPacket).not.toContain("REPLACES the open one");
    expect(withPacket).toContain("ONE reply that answers everything quoted");
    // No open packet → no clause, so the turn never invents a packet to defer to.
    expect(
      operatorPrompts.buildOperatorTurnPrompt(
        snap({ stage: "impl", stageName: "In Progress" }),
        "manual",
        "@operator should we ship without the migration?",
        undefined,
        "Arda",
      ),
    ).not.toContain("A decision packet is ALREADY OPEN");
  });

  it("B-WF3: a scheduled run says so and quotes the note that scheduled it", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap({ stage: "impl", stageName: "In Progress" }),
      "scheduled",
      undefined,
      undefined,
      undefined,
      undefined,
      "re-check whether CI went green",
    );
    expect(prompt).toContain("SCHEDULED re-check");
    expect(prompt).toContain('"re-check whether CI went green"');
    // A bare tick is not new evidence.
    expect(prompt).toContain("not new evidence by itself");
  });

  it("B-WF3: a scheduled run with no note still names its origin", () => {
    const prompt = operatorPrompts.buildCodexOperatorPrompt(
      snap({ stage: "impl", stageName: "In Progress" }),
      "scheduled",
    );
    expect(prompt).toContain("SCHEDULED re-check");
    expect(prompt).toContain("no stated reason");
  });

  /**
   * Ruling 487 (F40-65). Live on WEB-9 the operator opened "Build holds for
   * the scheduled 11:25Z Platform Engineer run. Confirm the hold?", whose body
   * said it existed only so the stage was "not left idle with nothing
   * recorded": the idle-stage nudge's own words, which sent every hold to a
   * packet. A wait on a clock is scheduled; the packet stays for a hold a
   * person directed (ruling 131(f)).
   */
  it("ruling 487: the idle-stage nudge schedules a wait on a clock and keeps the packet for a hold a person directed", () => {
    // Canary: restore the nudge's old sentence.
    const idle = snap({ goal: "Publish the notes feed at /notes.xml." });
    for (const prompt of [
      operatorPrompts.buildOperatorTurnPrompt(idle, "transition", undefined, undefined, undefined, undefined, undefined, undefined, true),
      operatorPrompts.buildCodexOperatorPrompt(idle, "transition", undefined, undefined, undefined, undefined, undefined, undefined, true),
    ]) {
      expect(prompt).toContain("auto-advance stage idle");
      expect(prompt).toContain(
        "when the task must wait for a moment in time (a deployed cron run, a provider window reopening, a deploy landing), `schedule_task_action` the run that picks it up then and write one note naming the schedule: a pending schedule is the record, it needs no packet, and nobody is asked to confirm it.",
      );
      expect(prompt).toContain("Only if the goal or a human directive tells you to HOLD this stage for a reason no clock ends");
    }
  });

  it("ruling 487: the stage rule's tail names the schedule as a way out and says a wait on a time is never a packet", () => {
    // Canary: restore "with nothing done and no packet: either advance the
    // boundary, hand off to a specialist, or `open_decision_packet`".
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      snap({ goal: "Publish the notes feed at /notes.xml." }),
      "manual",
    );
    expect(prompt).toContain("with nothing done, no packet and no pending schedule");
    expect(prompt).toContain("`schedule_task_action` the run a clock is waiting for (a cron run, a window reopening)");
    expect(prompt).toContain("a wait on a time is never a packet (ruling 487)");
  });

  it("ruling 487: the runs already scheduled are named on every trigger, with whose each is", () => {
    // Canary: return "" from `pendingSchedulesInstruction`.
    const scheduled = snap({
      stage: "impl",
      stageName: "In Progress",
      goal: "Publish the notes feed at /notes.xml.",
      schedules: [
        {
          id: "sch_mine",
          action: "run-agent",
          dueAt: "2026-09-25T12:25:00.000Z",
          profileId: "platform",
          prompt: "Read the 12:17Z cron run.",
          by: "operator",
          yours: true,
        },
        {
          id: "sch_arda",
          action: "run-operator",
          dueAt: "2026-09-26T09:00:00.000Z",
          profileId: null,
          prompt: "",
          by: "Arda",
          yours: false,
        },
      ],
    });
    const named =
      "Already scheduled on this task: `sch_mine`, a platform run at 2026-09-25T12:25:00.000Z (scheduled by you); " +
      "`sch_arda`, your own re-run at 2026-09-26T09:00:00.000Z (scheduled by Arda). When the task is holding for one " +
      "of these, the hold needs no decision packet and no question to anyone: write one note naming the schedule, then end your turn.";
    for (const trigger of ["manual", "agent-reply", "packet-resolved", "scheduled"] as const) {
      expect(operatorPrompts.buildOperatorTurnPrompt(scheduled, trigger), trigger).toContain(named);
    }
    expect(operatorPrompts.buildCodexOperatorPrompt(scheduled, "manual")).toContain(named);
    expect(operatorPrompts.buildOperatorTurnPrompt(snap(), "manual")).not.toContain("Already scheduled");
  });
});

/* -------- queued triggers: a human's question is never overwritten (B-OP2) -------- */

describe("pending trigger queue", () => {
  let ctx3: TestDbContext;
  let store3: TestStore;
  let adapter3: ControlledAdapter;

  const seedOperatorProject = (): void => {
    const project = readProjectFile({
      projectSlug: store3.slug,
      dataRoot: store3.dataRoot,
    })!;
    writeProject(store3.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
  };

  beforeEach(async () => {
    ctx3 = createTestDbContext();
    store3 = setupTestStore(ctx3);
    seedOperatorProject();
    // A work stage (impl → review is an APPROVAL boundary), so nothing here is
    // "stranded" and the only re-runs are the queued triggers under test.
    writeTask(store3.dataRoot, store3.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store3.users.arda.id,
      }),
      goal: "Ship the parser.",
    });
    rebuildAll(store3.db, { dataRoot: store3.dataRoot, force: true });
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter3 = new ControlledAdapter();
    configureRunServiceForTests({ claude: adapter3, codex: adapter3 });
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have this backend connected or the drive is refused before it starts.
    await connectFakeBackend(store3.db, store3.users.arda.id, "codex");
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx3.cleanup();
  });

  const drive = (over: Partial<Parameters<typeof runOperator>[1]> = {}) =>
    runOperator(store3.db, {
      projectSlug: store3.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "supervised",
      dataRoot: store3.dataRoot,
      ...over,
    });

  const emptyPlan = JSON.stringify({ reasoning: "Nothing to do.", actions: [] });
  const operatorRuns = () =>
    store3.db
      .prepare(`SELECT id FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
      .all()
      .map((row) => ({ id: String(row.id) }));

  it("ruling 417: a Codex plan's lease_files step lands the lease on the project", async () => {
    await drive({ trigger: "manual" });
    // CANARY: drop the executor's `lease_files` case and the step is skipped
    // as an unknown tool; the project holds no lease.
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "lease_files",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: "Rewriting the sandbox lifetime; AX-21 waits on it.",
            reason: null,
            packetOptions: null,
            kbSource: null,
            repoSource: null,
            blockedBy: null,
            paths: ["internal/sandbox/**"],
          },
        ],
      }),
      "finished",
    );
    await eventually(() => {
      const leases = readProjectFile({ projectSlug: store3.slug, dataRoot: store3.dataRoot })!.parsed
        .frontmatter.fileLeases;
      expect(leases).toEqual([
        {
          paths: ["internal/sandbox/**"],
          taskKey: "VIB-1",
          reason: "Rewriting the sandbox lifetime; AX-21 waits on it.",
        },
      ]);
    });
  });

  it("ruling 487: a Codex plan schedules its own re-run and cancels one it scheduled, as the operator", async () => {
    // CANARY: drop the executor's `schedule_task_action` case (the step is
    // skipped and nothing is scheduled), or its `cancel_task_schedule` case.
    const step = (over: {
      tool: "schedule_task_action" | "cancel_task_schedule";
      dueAt?: string;
      delayMinutes?: number;
      text?: string;
      scheduleId?: string;
    }) => ({
      profileId: null,
      delivers: null,
      toStageId: null,
      packetType: null,
      text: null,
      reason: null,
      packetOptions: null,
      kbSource: null,
      repoSource: null,
      blockedBy: null,
      paths: null,
      completeness: null,
      dueAt: null,
      delayMinutes: null,
      scheduleId: null,
      ...over,
    });
    const dueAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await drive({ trigger: "manual" });
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [
          step({ tool: "schedule_task_action", dueAt, text: "Read the 12:17Z cron run." }),
          step({ tool: "schedule_task_action", delayMinutes: 30 }),
        ],
      }),
      "finished",
    );
    const schedulesOf = () =>
      readTaskFile({ projectSlug: store3.slug, taskKey: "VIB-1", dataRoot: store3.dataRoot })!.parsed
        .frontmatter.schedules;
    await eventually(() => {
      expect(schedulesOf()).toHaveLength(2);
    });
    expect(schedulesOf()[0]).toMatchObject({
      action: "run-operator",
      dueAt,
      prompt: "Read the 12:17Z cron run.",
      createdBy: "operator",
      status: "pending",
    });
    const second = schedulesOf()[1]!.id;

    // The next turn cancels the second one. It may queue behind the first
    // drive's settle, so wait for its run to be the pending one.
    await drive({ trigger: "manual" });
    await eventually(() => {
      expect(adapter3.pending).not.toBeNull();
    });
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [step({ tool: "cancel_task_schedule", scheduleId: second })],
      }),
      "finished",
    );
    await eventually(() => {
      expect(schedulesOf().map((s) => s.status)).toEqual(["pending", "cancelled"]);
    });
  });

  it("rulings 483 and 498: a Codex plan's correct_knowledge_doc writes `<kb>/<doc>` of an engaged agent's knowledge base, in place of the passage in `reason`", async () => {
    const { saveKnowledgeBase, resolveStoreTarget } = await import("~/server/org/resources.server");
    const { writeStoreDoc } = await import("~/server/org/store-files.server");
    const admin = { userId: store3.users.arda.id, label: "arda" };
    const { kb } = await saveKnowledgeBase(
      store3.db,
      { name: "akin-dossier", refresh: "on change" },
      admin,
      { dataRoot: store3.dataRoot },
    );
    const target = resolveStoreTarget(store3.db, "kb", kb.id, { dataRoot: store3.dataRoot })!;
    writeStoreDoc(store3.db, target, [], "06-platform-facts.md", "# Facts\n\n- T-013: output in dist/server/\n", admin);
    const project = readProjectFile({ projectSlug: store3.slug, dataRoot: store3.dataRoot })!;
    writeProject(store3.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "platform",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Platform Engineer",
            role: "Platform",
            backends: ["codex"],
            model: defaultModelFor("codex"),
            resources: { skills: [], mcps: [], kb: [kb.dir] },
          },
        },
      ],
    });
    await updateTaskFile(
      { projectSlug: store3.slug, taskKey: "VIB-1", dataRoot: store3.dataRoot },
      (parsed) => {
        parsed.frontmatter.engagements = [
          { profileId: "platform", backend: "codex", role: "Platform", delivers: true, verdictCapable: false },
        ];
      },
    );
    rebuildAll(store3.db, { dataRoot: store3.dataRoot, force: true });
    await drive({ trigger: "manual" });
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "correct_knowledge_doc",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: "- T-013: output in dist/worker/ and dist/client/",
            reason: "- T-013: output in dist/server/",
            packetOptions: null,
            kbSource: `${kb.dir}/06-platform-facts.md`,
            repoSource: "`ls dist` after `npm run build` listed client and worker.",
            blockedBy: null,
            paths: null,
            completeness: null,
          },
        ],
      }),
      "finished",
    );
    // CANARY: read `kbSource` as a rulings document again (no split) and the
    // project, which names no rulings knowledge base, refuses it.
    await eventually(() => {
      const body = readFileSync(
        path.join(store3.dataRoot, "kb", kb.dir, "06-platform-facts.md"),
        "utf8",
      );
      expect(body).toBe("# Facts\n\n- T-013: output in dist/worker/ and dist/client/\n");
    });
  });

  it("ruling 421: a Codex plan's run_agent with `completeness` stamps the engagement with the run it started", async () => {
    const project = readProjectFile({ projectSlug: store3.slug, dataRoot: store3.dataRoot })!;
    writeProject(store3.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "reviewer",
          capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Reviewer",
            role: "Review & validation",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    rebuildAll(store3.db, { dataRoot: store3.dataRoot, force: true });
    await drive({ trigger: "manual" });
    // CANARY: drop `if (a.completeness) dispatch.completeness = true` from the
    // executor and the engagement carries no question.
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "run_agent",
            profileId: "reviewer",
            delivers: false,
            toStageId: null,
            packetType: null,
            text: "Review the rework and name everything you would still block on.",
            reason: null,
            packetOptions: null,
            kbSource: null,
            repoSource: null,
            blockedBy: null,
            paths: null,
            completeness: true,
          },
        ],
      }),
      "finished",
    );
    await eventually(() => {
      const task = readTaskFile({ projectSlug: store3.slug, taskKey: "VIB-1", dataRoot: store3.dataRoot })!;
      const engaged = task.parsed.frontmatter.engagements.find((e) => e.profileId === "reviewer");
      const reviewerRun = store3.db
        .prepare(`SELECT id FROM agent_runs WHERE agent_profile_id = 'reviewer' ORDER BY rowid DESC LIMIT 1`)
        .get();
      expect(engaged?.question).toMatchObject({ kind: "completeness", runId: String(reviewerRun?.id) });
    });
  });

  it("ruling 415: the Codex plan's snapshot never sends it to a tool it cannot call", async () => {
    // A timeline longer than the six-entry window, so the window note is
    // written, as it was on every ax-clone task by mid-afternoon.
    writeTask(store3.dataRoot, store3.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store3.users.arda.id,
      }),
      goal: "Ship the parser.",
      timeline: Array.from({ length: 10 }, (_, i) => ({
        occurredAt: `2026-09-22T20:${String(10 + i).padStart(2, "0")}:00.000Z`,
        type: "note" as const,
        actor: { kind: "system" as const, systemId: "schedule-runner" },
        title: null,
        text: `note ${i}`,
        toAgent: false,
        evidence: null,
      })).reverse(),
    });
    rebuildAll(store3.db, { dataRoot: store3.dataRoot, force: true });
    await drive({ trigger: "manual" });
    const prompt = adapter3.pending!.spec.prompt;
    // CANARY: drop `{ toolless: true }` at the Codex call site and this is
    // "Call get_task with events up to 50", which the same prompt says a
    // Codex operator cannot do.
    expect(prompt).toContain("You cannot call tools");
    expect(prompt).toContain("This turn cannot fetch them");
    expect(prompt).not.toContain("Call get_task with events");
  });

  it("FR39: a queued scheduled re-check survives a later machine trigger", async () => {
    // CANARY: route `scheduled` back into the newest-wins `latest` slot — the
    // transition below overwrites it and the re-check never happens.
    //
    // The schedule runner stamps the occurrence `fired` the moment this
    // trigger is queued, so an overwritten one is a run FR39 promised, recorded
    // in the file, the audit row and the timeline as delivered, that never ran.
    // Its note exists nowhere else in the run's input — the same reason a human
    // question is queued rather than replaced.
    await drive({ trigger: "manual" });
    expect(adapter3.pending).not.toBeNull();

    await drive({
      trigger: "scheduled",
      scheduleNote: "re-check the flaky test before we ship",
    });
    await drive({
      trigger: "transition",
      transitionFromName: "Ready",
      transitionToName: "In Progress",
    });

    adapter3.finish(store3, emptyPlan, "finished");

    // The SCHEDULED trigger fires first, its note intact.
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2);
      expect(adapter3.pending?.spec.prompt).toContain(
        "re-check the flaky test before we ship",
      );
    });

    // …and the machine trigger is still queued behind it.
    adapter3.finish(store3, emptyPlan, "finished");
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(3);
      expect(adapter3.pending?.spec.prompt).toContain(
        'moved this task from "Ready" to "In Progress"',
      );
    });
  });

  it("V13 (pass-31 review): a queued stranded-resume nudge keeps its marker through machine-trigger coalescing", async () => {
    // The nudge fires as a machine trigger carrying `strandedResume: true`.
    // Machine triggers are newest-wins in `queue.latest`, and a wholesale
    // overwrite dropped the marker — the drive that eventually ran was
    // unmarked, so a second stranding re-armed another paid nudge instead of
    // recording the deliberate hold (the F31-11 burst, narrowly re-opened).
    await drive({ trigger: "manual" });
    expect(adapter3.pending).not.toBeNull();

    // The nudge lands while the lease is held…
    await drive({ trigger: "transition", strandedResume: true });
    // …and a later machine trigger overwrites the queued slot.
    await drive({
      trigger: "transition",
      transitionFromName: "Ready",
      transitionToName: "In Progress",
    });

    adapter3.finish(store3, emptyPlan, "finished");

    // The drained drive is still MARKED: its turn instruction carries the
    // nudge's advance-or-record-the-hold context.
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2);
      expect(adapter3.pending?.spec.prompt).toContain("re-invoked ONCE");
    });
  });

  it("ruling 488: a queued relay survives a later machine trigger, and its turn quotes what arrived", async () => {
    // CANARY: route a relay back into the newest-wins `latest` slot (drop
    // `|| input.relay` from the carried test): the transition below
    // overwrites it and the relayed numbers never reach a turn.
    await drive({ trigger: "manual" });
    expect(adapter3.pending).not.toBeNull();

    await drive({
      trigger: "relayed",
      relay: {
        fromTaskKey: "VIB-9",
        by: "Platform Engineer",
        text: "Deployed cron CPU: 5 ms and 6 ms of 10.",
        occurredAt: "2026-09-25T12:56:00.000Z",
      },
    });
    await drive({
      trigger: "transition",
      transitionFromName: "Ready",
      transitionToName: "In Progress",
    });

    adapter3.finish(store3, emptyPlan, "finished");

    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2);
      expect(adapter3.pending?.spec.prompt).toContain(
        'VIB-9 relayed this to you (ruling 488): the Platform Engineer there posted it on this task\'s timeline as a comment headed "From VIB-9 (Platform Engineer)", at 2026-09-25T12:56:00.000Z.',
      );
    });
    expect(adapter3.pending?.spec.prompt).toContain("Deployed cron CPU: 5 ms and 6 ms of 10.");
    expect(adapter3.pending?.spec.prompt).toContain("never ask a person to copy it here or to confirm it arrived");

    adapter3.finish(store3, emptyPlan, "finished");
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(3);
      expect(adapter3.pending?.spec.prompt).toContain('moved this task from "Ready" to "In Progress"');
    });
  });

  it("ruling 488: a Codex plan's relay_to_task posts on the other task as the operator", async () => {
    // CANARY: drop the executor's `relay_to_task` case (the step is skipped
    // and VIB-2 gets nothing).
    writeTask(store3.dataRoot, store3.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", ownerUserId: store3.users.arda.id }),
    });
    rebuildAll(store3.db, { dataRoot: store3.dataRoot, force: true });
    await drive({ trigger: "manual" });
    adapter3.finish(
      store3,
      JSON.stringify({
        reasoning: "",
        actions: [
          {
            tool: "relay_to_task",
            profileId: null,
            delivers: null,
            toStageId: null,
            packetType: null,
            text: "Deployed cron CPU: 5 ms and 6 ms of 10.",
            reason: null,
            packetOptions: null,
            kbSource: null,
            repoSource: null,
            blockedBy: null,
            paths: null,
            completeness: null,
            dueAt: null,
            delayMinutes: null,
            scheduleId: null,
            taskKey: "VIB-2",
          },
        ],
      }),
      "finished",
    );
    const vib2 = () =>
      readTaskFile({ projectSlug: store3.slug, taskKey: "VIB-2", dataRoot: store3.dataRoot })!.parsed.timeline;
    await eventually(() => {
      expect(vib2().some((e) => e.type === "comment")).toBe(true);
    });
    expect(vib2().find((e) => e.type === "comment")).toMatchObject({
      actor: { kind: "operator" },
      text: "**From VIB-1 (operator):**\n\nDeployed cron CPU: 5 ms and 6 ms of 10.",
    });
    const vib1 = readTaskFile({ projectSlug: store3.slug, taskKey: "VIB-1", dataRoot: store3.dataRoot })!.parsed
      .timeline;
    expect(vib1.some((e) => e.text === "Relayed to VIB-2: Deployed cron CPU: 5 ms and 6 ms of 10.")).toBe(true);
  });

  it("B-OP2: a queued @operator question survives a later machine trigger", async () => {
    await drive({ trigger: "manual" });
    expect(adapter3.pending).not.toBeNull();

    // A human asks the operator something WHILE a drive holds the lease…
    await drive({
      trigger: "manual",
      humanComment: "@operator why is this still in progress?",
      humanCommentBy: "Arda",
    });
    // …and a machine trigger lands behind it. Newest-wins used to overwrite the
    // question here, so the person was never answered at all.
    await drive({
      trigger: "transition",
      transitionFromName: "Ready",
      transitionToName: "In Progress",
    });

    adapter3.finish(store3, emptyPlan, "finished");

    // The HUMAN's trigger fires first, question intact.
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2);
      expect(adapter3.pending?.spec.prompt).toContain(
        "why is this still in progress?",
      );
    });
    expect(adapter3.pending?.spec.prompt).toContain('tag them "@Arda"');

    // The machine trigger is still queued behind it — nothing was lost either way.
    adapter3.finish(store3, emptyPlan, "finished");
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(3);
      expect(adapter3.pending?.spec.prompt).toContain(
        'moved this task from "Ready" to "In Progress"',
      );
    });
  });

  it("C2: overflowing the pending-@operator queue notes the dropped turn on the timeline", async () => {
    await drive({ trigger: "manual" }); // holds the lease
    expect(adapter3.pending).not.toBeNull();

    // Nine DISTINCT authors queue behind the held lease (distinct so none merge).
    // The cap is 8, so the oldest — Asker1 — is dropped.
    for (let i = 1; i <= 9; i += 1) {
      await drive({
        trigger: "manual",
        humanComment: `@operator question ${i}`,
        humanCommentBy: `Asker${i}`,
      });
    }

    // The drop is SURFACED, not a silent log: a system note names who fell off.
    await eventually(() => {
      const note = readTaskFile({
        projectSlug: store3.slug,
        taskKey: "VIB-1",
        dataRoot: store3.dataRoot,
      })!.parsed.timeline.find(
        (e) => e.type === "note" && e.text.includes("did not get its own operator turn"),
      );
      expect(note?.text).toContain("Asker1");
    });
    // The drop note is written fire-and-forget; let its projection rebuild drain
    // before teardown closes the DB (matches the run-service settle pattern).
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("S3-1: consecutive questions from the SAME human are ONE turn", async () => {
    await drive({ trigger: "manual" });
    await drive({
      trigger: "manual",
      humanComment: "@operator first question",
      humanCommentBy: "Arda",
    });
    await drive({
      trigger: "manual",
      humanComment: "@operator and while you are at it, the second",
      humanCommentBy: "Arda",
    });

    adapter3.finish(store3, emptyPlan, "finished");
    // ONE follow-up drive carrying BOTH messages — not two governed turns, each
    // able to open a packet that replaces the other's.
    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2);
      expect(adapter3.pending?.spec.prompt).toContain("first question");
    });
    expect(adapter3.pending?.spec.prompt).toContain("the second");

    adapter3.finish(store3, emptyPlan, "finished");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(operatorRuns()).toHaveLength(2);
    expect(adapter3.pending).toBeNull();
  });

  it("B-OP2: two queued questions both get a turn, oldest first", async () => {
    await drive({ trigger: "manual" });
    await drive({
      trigger: "manual",
      humanComment: "@operator first question",
      humanCommentBy: "Arda",
    });
    await drive({
      trigger: "manual",
      humanComment: "@operator second question",
      humanCommentBy: "Murat",
    });

    adapter3.finish(store3, emptyPlan, "finished");
    await eventually(() => {
      expect(adapter3.pending?.spec.prompt).toContain("first question");
    });
    adapter3.finish(store3, emptyPlan, "finished");
    await eventually(() => {
      expect(adapter3.pending?.spec.prompt).toContain("second question");
    });
  });
});

/* ---- cross-boot stranded-plan recovery resumes an auto stage (B-OP3) ---- */

describe("stranded codex plan recovery", () => {
  let ctx4: TestDbContext;
  let store4: TestStore;
  let adapter4: ControlledAdapter;

  beforeEach(async () => {
    ctx4 = createTestDbContext();
    store4 = setupTestStore(ctx4);
    const project = readProjectFile({
      projectSlug: store4.slug,
      dataRoot: store4.dataRoot,
    })!;
    writeProject(store4.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    // The cross-boot shape: an AUTO stage (triage → ready) the restart left
    // idle, with no packet and no recommendation for a human to act on.
    writeTask(store4.dataRoot, store4.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store4.users.arda.id,
      }),
      goal: "Add the changelog entry for 2.4.",
    });
    rebuildAll(store4.db, { dataRoot: store4.dataRoot, force: true });
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter4 = new ControlledAdapter();
    configureRunServiceForTests({ claude: adapter4, codex: adapter4 });
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have this backend connected or the drive is refused before it starts.
    await connectFakeBackend(store4.db, store4.users.arda.id, "codex");
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx4.cleanup();
  });

  it("B-OP3: a plan replayed after a restart still resumes the stranded stage", async () => {
    // A previous boot's operator run: finished, its plan never executed.
    upsertRun(store4.db, {
      id: "run_prev_boot",
      taskKey: "VIB-1",
      projectSlug: store4.slug,
      threadId: "op-prevboot",
      role: "Operator",
      kind: "operator",
      backend: "codex",
      agentProfileId: "operator",
      model: defaultModelFor("codex"),
      sdk: "Codex SDK",
      state: "finished",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    insertRunLine(store4.db, {
      runId: "run_prev_boot",
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: {
        t: "1",
        ev: "text",
        tag: "agent_message",
        // A plan that changes nothing: the exact shape that used to leave the
        // task stamped "waiting on a human" at an auto stage forever, because
        // the recovery path passed stageAtStart: null and switched the
        // stranded-resume backstop off.
        text: JSON.stringify({ reasoning: "", actions: [] }),
      },
    });

    const executed = await executeStrandedCodexPlan(
      store4.db,
      { dataRoot: store4.dataRoot },
      { projectSlug: store4.slug, taskKey: "VIB-1", runId: "run_prev_boot" },
    );
    expect(executed).toBe(true);

    // The backstop drives the task again instead of leaving the auto stage idle.
    await eventually(() => {
      const runs = store4.db
        .prepare(`SELECT id FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
        .all()
        .map((row) => ({ id: String(row.id) }));
      expect(runs).toHaveLength(2);
      expect(adapter4.pending).not.toBeNull();
    });
  });
});

/* ---- runOperator entry-point behaviour: A4 / B4 / B5 / B6 / B8 / B10 ---- */

/** A ControlledAdapter that records, at each run START, whether the task
 *  already carries a decision packet — the ordering probe for B5. */
class ProbeAdapter extends ControlledAdapter {
  packetAtStart: boolean[] = [];
  probe: (() => boolean) | null = null;

  override start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.packetAtStart.push(this.probe ? this.probe() : false);
    return super.start(spec, callbacks);
  }
}

describe("runOperator — authority, ordering, orphans", () => {
  let ctx5: TestDbContext;
  let store5: TestStore;
  let adapter5: ProbeAdapter;

  const deployAgents = (agents: AgentDeployment[]): void => {
    const project = readProjectFile({
      projectSlug: store5.slug,
      dataRoot: store5.dataRoot,
    })!;
    writeProject(store5.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents,
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
  };

  const operatorAgent = (
    over: AgentDeploymentDefinition = {},
  ): AgentDeployment => ({
    profileId: "operator",
    capabilities: OPERATOR_POLICY,
    extras: [],
    definition: {
      kind: "operator",
      name: "Operator",
      backends: ["claude"],
      model: "sonnet",
      ...over,
    },
  });

  const seed = (stage: string): void => {
    writeTask(store5.dataRoot, store5.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage,
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store5.users.arda.id,
      }),
      goal: "Ship the parser.",
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
  };

  const task = () =>
    readTaskFile({
      projectSlug: store5.slug,
      taskKey: "VIB-1",
      dataRoot: store5.dataRoot,
    })!.parsed;

  const operatorRuns = () =>
    store5.db
      .prepare(`SELECT id, state FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
      .all()
      .map((row) => ({ id: String(row.id), state: String(row.state) }));

  const drive = (over: Partial<Parameters<typeof runOperator>[1]> = {}) =>
    runOperator(store5.db, {
      projectSlug: store5.slug,
      taskKey: "VIB-1",
      autonomy: "supervised",
      dataRoot: store5.dataRoot,
      ...over,
    });

  beforeEach(async () => {
    ctx5 = createTestDbContext();
    store5 = setupTestStore(ctx5);
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter5 = new ProbeAdapter();
    configureRunServiceForTests({ claude: adapter5, codex: adapter5 });
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have the backend connected or the drive is refused before it starts.
    await connectFakeBackends(store5.db, store5.users.arda.id);
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx5.cleanup();
  });

  /**
   * A4 — every entry point (the Run-operator button, a schedule, boot
   * recovery, an `@operator` comment) funnels through runOperator without
   * checking `authority.deployed`, so the toolkit is where "no deployment"
   * has to mean "no delivery". A project with no operator agent used to hand
   * the run `get_task` + `deliver_for_review` on a non-strict board.
   */
  it("A4: a project with NO operator deployed gets a read-only toolkit on a real run", async () => {
    deployAgents([
      {
        profileId: "developer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "Dev",
          role: "Implementation",
          backends: ["claude"],
          model: "sonnet",
        },
      },
    ]);
    seed("impl");

    const started = await drive({ trigger: "manual" });
    expect(started.queued).toBe(false);
    const spec = adapter5.pending!.spec;
    // R19-1: an undeployed operator may LOOK at the repository — but through the
    // read-only checkout under its cwd (Read/Grep/Glob), so the in-process MCP
    // floor is the READS, and they still change nothing. Ruling 282 adds
    // `read_board` to that floor and ruling 285 adds `read_timeline_entry`:
    // seeing a board it holds no authority over takes nothing away, the task
    // page already shows a person the whole comment that tool returns, and
    // reading is never the thing being withheld.
    expect(spec.allowedTools).toEqual([
      "mcp__viberr__get_task",
      "mcp__viberr__read_board",
      "mcp__viberr__read_task_attachment",
      "mcp__viberr__read_timeline_entry",
    ]);
    expect(spec.allowedTools).not.toContain("mcp__viberr__deliver_for_review");
  });

  /**
   * Ruling 127 — an operator drive bills the TASK OWNER's own accounts, so a
   * task with no owner (or an owner who has not connected the backend) cannot
   * coordinate at all. The refusal is recorded as the drive's whole outcome:
   * a run row in `error` carrying the one refusal sentence, no clone, no
   * process, and the same blocked recovery packet any failed operator run
   * raises — with the sentence as its body rather than the generic
   * "fix the credential" advice, which names a fix nobody here can make.
   */
  it("an UNOWNED task refuses the drive: no process, a NULL principal", async () => {
    // Canary: drop the `resolveTaskRunPrincipal` call in runOperator and the
    // drive clones, reserves and hands a spec to the adapter.
    deployAgents([operatorAgent()]);
    writeTask(store5.dataRoot, store5.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: null,
      }),
      goal: "Ship the parser.",
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });

    const result = await drive({ trigger: "manual" });

    expect(adapter5.pending).toBeNull();
    const runs = operatorRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("error");
    const run = getRun(store5.db, result.runId!)!;
    // Null ONLY here: a run that ever spawned a process has a principal.
    expect(run.credential_user_id).toBeNull();
    const text = listRunLines(store5.db, run.id)[0]!.display.text ?? "";
    expect(text).toContain("need a task owner");
    expect(text).toContain("No agent process was started.");
  });

  it("an OWNER with no connected backend: the run names them, the packet quotes it", async () => {
    deployAgents([operatorAgent()]);
    seed("impl");
    await disconnectFakeBackend(store5.db, store5.users.arda.id, "claude");

    const result = await drive({ trigger: "manual" });

    expect(adapter5.pending).toBeNull();
    const run = getRun(store5.db, result.runId!)!;
    expect(run.state).toBe("error");
    // The principal IS recorded: the refusal says whose account it would have
    // billed, which is what makes it auditable rather than anonymous.
    expect(run.credential_user_id).toBe(store5.users.arda.id);
    const text = listRunLines(store5.db, run.id)[0]!.display.text ?? "";
    expect(text).toContain(store5.users.arda.name);
    expect(text).toContain("Profile → Agent accounts");

    // The escalation packet carries that same sentence — one refusal, one
    // story — and stops advising a fix ("retry on the other backend") that is
    // refused for exactly the same reason.
    await eventually(() => {
      const packet = task().packet;
      expect(packet).not.toBeNull();
      expect(packet!.body).toContain("Profile → Agent accounts");
      expect(packet!.body).not.toContain("Retry on the other backend");
    });
  });

  /**
   * Ruling 130(b)/(c) (pass 34, F34-12 / F34-1): the operator's OWN failure
   * packet names the cause Viberr classified and the credential principal's
   * own remedy, and its recommended option asserts only what the human says.
   * Live, a five-hour session limit and a 403 `oauth_org_not_allowed` both
   * produced "Retry on the other backend, fix the credential, or redirect the
   * task" and recommended "I've updated the policy / credential".
   *
   * Canaries: (1) restore `options: defaultPacketOptions("blocked")` in
   * `escalateFailedOperatorRun` and the quota/auth cases fail on the
   * recommended title and `ev`; (2) restore the generic body sentence and
   * every case fails on the body.
   */
  describe("ruling 177: a closed task refuses every operator trigger at no cost", () => {
    const seedClosed = (over: Partial<Parameters<typeof baseTaskFrontmatter>[1]> = {}): void => {
      writeTask(store5.dataRoot, store5.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "done",
          readiness: "ready",
          waiting: "none",
          ownerUserId: store5.users.arda.id,
          ...over,
        }),
        goal: "Ship the parser.",
      });
      rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
    };
    const EVERY_TRIGGER = [
      "create",
      "transition",
      "agent-reply",
      "goal-updated",
      "pr-diverged",
      "delivered",
      "packet-resolved",
      "dependencies-released",
      "scheduled",
      "manual",
    ] as const;

    it("a task at the terminal stage refuses every trigger with `closed` and starts no run", async () => {
      // Canary: scope the closure check back to `trigger === "scheduled"`
      // (the pre-177 shape): `agent-reply` and `manual` then start a run on a
      // shipped task — the F36-5 / F36-4 doors.
      deployAgents([operatorAgent()]);
      seedClosed();
      for (const trigger of EVERY_TRIGGER) {
        const result = await drive({ trigger });
        expect(result.refused, trigger).toBe("closed");
        expect(result.runId, trigger).toBeNull();
        expect(adapter5.pending, trigger).toBeNull();
      }
      expect(operatorRuns()).toHaveLength(0);
    });

    it("an archived task at an open stage refuses the same way", async () => {
      // Canary: drop the `archived` half of `taskClosure` — the mention door
      // (`manual`) then runs the operator on an archived task (F36-4).
      deployAgents([operatorAgent()]);
      seedClosed({ stage: "impl", archived: true });
      const manual = await drive({ trigger: "manual" });
      expect(manual.refused).toBe("closed");
      const reply = await drive({ trigger: "agent-reply" });
      expect(reply.refused).toBe("closed");
      expect(operatorRuns()).toHaveLength(0);
    });

    it("a refused trigger on a closed task settles waiting to `none`, never `agent`", async () => {
      // Canary: delete the settle from the `closed` branch.
      deployAgents([operatorAgent()]);
      seedClosed({ waiting: "agent" });
      await drive({ trigger: "agent-reply" });
      await vi.waitFor(() => {
        const fm = readTaskFile({ projectSlug: store5.slug, taskKey: "VIB-1", dataRoot: store5.dataRoot })!.parsed.frontmatter;
        expect(fm.waiting).toBe("none");
      });
    });
  });

  describe("ruling 131(d): a held task refuses the coordinating triggers at no cost", () => {
    const seedHeld = (over: Partial<Parameters<typeof baseTaskFrontmatter>[1]> = {}): void => {
      writeTask(store5.dataRoot, store5.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          readiness: "ready",
          waiting: "none",
          ownerUserId: store5.users.arda.id,
          blockedBy: ["VIB-2"],
          ...over,
        }),
        goal: "Ship the parser.",
      });
      writeTask(store5.dataRoot, store5.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl" }) });
      rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
    };

    it("create, transition and scheduled are refused `blocked-by` with no run row; reactive triggers still drive", async () => {
      // Canary: remove "transition" from HELD_TRIGGERS.
      deployAgents([operatorAgent()]);
      seedHeld();
      for (const trigger of ["create", "transition", "scheduled"] as const) {
        const result = await drive({ trigger });
        expect(result.refused, trigger).toBe("blocked-by");
        expect(result.runId).toBeNull();
        expect(adapter5.pending).toBeNull();
      }
      expect(operatorRuns()).toHaveLength(0);
      const reactive = await drive({ trigger: "manual" });
      expect(reactive.refused).toBeUndefined();
      expect(adapter5.pending).not.toBeNull();
    });

    it("a transition drained off the lease queue and refused settles waiting to `none`, never `agent`", async () => {
      // Canary: delete the settle from the `blocked-by` branch (waiting
      // stays `agent` after the drained refusal).
      deployAgents([operatorAgent()]);
      seedHeld({ blockedBy: [] });
      // A drive holds the lease; a transition queues behind it; THEN the task
      // becomes held (the operator's own `set_dependencies` mid-drive is the
      // live shape). The drained trigger is refused, and its settle is the
      // only thing that turns `agent` back off.
      await drive({ trigger: "manual" });
      expect(adapter5.pending).not.toBeNull();
      const queued = await drive({ trigger: "transition" });
      expect(queued.queued).toBe(true);
      expect(task().frontmatter.waiting).toBe("agent");
      await updateTaskFile({ projectSlug: store5.slug, taskKey: "VIB-1", dataRoot: store5.dataRoot }, (parsed) => {
        parsed.frontmatter.blockedBy = ["VIB-2"];
      });
      rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
      adapter5.finish(store5, JSON.stringify({ reasoning: "held", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(1);
        expect(task().frontmatter.waiting).toBe("none");
      });
      expect(task().frontmatter.blockedBy).toEqual(["VIB-2"]);
    });
  });

  /**
   * Ruling 357 (pass 38, F38-11). A delivery made inside an operator drive
   * queued a `delivered` turn behind the drive's own lease; 140 of 148 such
   * drives then moved the task or dispatched the reviewer themselves and the
   * queued turn was a paid no-op (13 of 13 on the airbnb board). The other 8
   * stopped right after delivering, and the follow-up did the move. The
   * delivery now stamps the drive, and the lease release fires the follow-up
   * only for a drive that stopped there.
   */
  describe("ruling 357: a drive's own delivery owes a follow-up only if the drive stopped there", () => {
    it("deliveredFollowUpFor: owed when delivered and not acted on; nothing otherwise", () => {
      const base = { projectSlug: "p", taskKey: "VIB-1", dataRoot: "/tmp/x", transitionDepth: 2 };
      expect(deliveredFollowUpFor({ ...base, ownRun: null })).toBeNull();
      expect(
        deliveredFollowUpFor({ ...base, ownRun: { backend: "claude", autonomy: "full", reactDepth: 0 } }),
      ).toBeNull();
      expect(
        deliveredFollowUpFor({
          ...base,
          ownRun: { backend: "claude", autonomy: "full", reactDepth: 0, deliveredHeadMoved: true, actedAfterDelivery: true },
        }),
      ).toBeNull();
      expect(
        deliveredFollowUpFor({
          ...base,
          ownRun: { backend: "claude", autonomy: "full", reactDepth: 0, deliveredHeadMoved: true },
        }),
      ).toEqual({ projectSlug: "p", taskKey: "VIB-1", dataRoot: "/tmp/x", trigger: "delivered", transitionDepth: 3 });
    });

    it("the lease release fires the follow-up for a drive that delivered and stopped, and none for one that kept going", async () => {
      // CANARY: drop the `deliveredFollowUpFor` call from releaseOperatorLease
      // (the second drive never starts).
      deployAgents([operatorAgent()]);
      seed("impl");
      await drive({ trigger: "manual" });
      expect(adapter5.pending).not.toBeNull();
      const own = ownOperatorRunForTests(store5.slug, "VIB-1");
      expect(own).not.toBeNull();
      own!.deliveredHeadMoved = true; // the drive delivered …
      adapter5.finish(store5, JSON.stringify({ reasoning: "delivered", actions: [] }), "finished");
      // … and stopped: the follow-up is the second drive.
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
      });
      await eventually(() => {
        expect(adapter5.pending).not.toBeNull();
      });
      adapter5.finish(store5, JSON.stringify({ reasoning: "nothing left", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns().every((r) => r.state === "finished")).toBe(true);
        // The row flips before the lease goes; wait for the lease too, or the
        // control drive below queues behind it.
        expect(ownOperatorRunForTests(store5.slug, "VIB-1")).toBeNull();
      });

      // Control: the same delivery followed by a move owes nothing.
      const control = await drive({ trigger: "manual" });
      expect(control.refused).toBeUndefined();
      expect(control.queued).toBeFalsy();
      const kept = ownOperatorRunForTests(store5.slug, "VIB-1");
      expect(kept).not.toBeNull();
      kept!.deliveredHeadMoved = true;
      kept!.actedAfterDelivery = true;
      adapter5.finish(store5, JSON.stringify({ reasoning: "delivered and moved", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(3);
        expect(operatorRuns()[2]!.state).toBe("finished");
      });
      await new Promise((r) => setTimeout(r, 120));
      expect(operatorRuns()).toHaveLength(3);
    });
  });

  /**
   * Ruling 489(d): the react hop count rides the chain from drive to agent and
   * back, through the drive's own follow-ups, and only a person restarts it.
   * The completion side (`agent-completion.server.test.ts`) stops the chain
   * at the ceiling; these prove the count reaches it intact.
   */
  describe("ruling 489(d): the react hop count rides the chain, and a person restarts it", () => {
    const plan = (reasoning: string) => JSON.stringify({ reasoning, actions: [] });
    const hopsNow = () => ownOperatorRunForTests(store5.slug, "VIB-1")?.reactHops;

    it("a chain's drive carries its count; a person's packet answer restarts it; two chain triggers keep the deeper", async () => {
      deployAgents([operatorAgent()]);
      seed("impl");
      await drive({ trigger: "agent-reply", reactDepth: 1, reactHops: 7 });
      // CANARY: drop `reactHops` from the drive's ctx and every agent it
      // dispatches starts the count over.
      expect(hopsNow()).toBe(7);

      // Behind the live drive: the chain's next react, then a person answers
      // a packet. Machine triggers are newest-wins, so the answer's drive runs.
      await drive({ trigger: "agent-reply", reactDepth: 1, reactHops: 9 });
      await drive({
        trigger: "packet-resolved",
        resolvedOption: { kind: "redirect", title: "Redirect with sharper guidance" },
      });
      adapter5.finish(store5, plan("reacted"), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter5.pending).not.toBeNull();
      });
      // CANARY: keep the deeper count whatever overwrites it, and the person's
      // answer inherits the 9 hops it was meant to end.
      expect(hopsNow()).toBe(0);

      // Two triggers of the chain itself: the deeper count survives.
      await drive({ trigger: "agent-reply", reactDepth: 1, reactHops: 9 });
      await drive({ trigger: "delivered", reactHops: 2 });
      adapter5.finish(store5, plan("answered"), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(3);
        expect(adapter5.pending).not.toBeNull();
      });
      // CANARY: drop the deeper-count merge and the chain loses seven hops.
      expect(hopsNow()).toBe(9);
      adapter5.finish(store5, plan("done"), "finished");
      await eventually(() => {
        expect(ownOperatorRunForTests(store5.slug, "VIB-1")).toBeNull();
      });
    });

    it("the drive's own follow-ups carry the count: the delivered follow-up and the stranded resume", async () => {
      deployAgents([operatorAgent()]);
      seed("impl");
      await drive({ trigger: "agent-reply", reactDepth: 1, reactHops: 7 });
      ownOperatorRunForTests(store5.slug, "VIB-1")!.deliveredHeadMoved = true;
      adapter5.finish(store5, plan("delivered"), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(2);
        expect(adapter5.pending).not.toBeNull();
      });
      // CANARY: drop the carry in `deliveredFollowUpFor` and the follow-up
      // starts the count over.
      expect(hopsNow()).toBe(7);
      adapter5.finish(store5, plan("moved on"), "finished");
      await eventually(() => {
        expect(ownOperatorRunForTests(store5.slug, "VIB-1")).toBeNull();
      });

      // Ready's outbound boundary is `auto`: a drive that ends there having
      // done nothing is stranded, and the settle nudges it once.
      seed("ready");
      await drive({ trigger: "agent-reply", reactDepth: 1, reactHops: 7 });
      adapter5.finish(store5, plan("nothing to do"), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(4);
        expect(adapter5.pending).not.toBeNull();
      });
      // CANARY: drop the carry in the stranded resume and the nudge starts
      // the count over.
      expect(hopsNow()).toBe(7);
      adapter5.finish(store5, plan("still nothing"), "finished");
      await eventually(() => {
        expect(ownOperatorRunForTests(store5.slug, "VIB-1")).toBeNull();
      });
    });
  });

  describe("ruling 157: a hold ends when a person starts the operator", () => {
    // Pass 35, F35-8 (KNC-25): `hold_runtime_debug` stored `readiness: blocked`
    // with no packet; a person's Run operator passed every fire-time refusal
    // (both read the packet or the `blockedBy` list) and the projection read
    // `blocked` beside `waiting: agent`. Canary: delete the `liftHoldForRun`
    // call in runOperator: the run still starts and the `"ready"` assert is red.
    const holdThroughTheWriter = async (over: Partial<Parameters<typeof baseTaskFrontmatter>[1]> = {}): Promise<void> => {
      writeTask(store5.dataRoot, store5.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          readiness: "blocked",
          waiting: "human",
          ownerUserId: store5.users.arda.id,
          ...over,
        }),
        goal: "Ship the parser.",
        packet: {
          type: "blocked",
          kind: "Work stalled",
          from: "operator",
          title: "The Developer's run failed",
          body: "",
          observations: [],
          options: [{ kind: "hold_runtime_debug", t: "Hold for runtime debug", d: "", rec: false }],
        },
      });
      writeTask(store5.dataRoot, store5.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl" }) });
      rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
      const { resolvePacket } = await import("~/server/tasks/task-actions.server");
      await resolvePacket(
        store5.db,
        { projectSlug: store5.slug, taskKey: "VIB-1", optionIndex: 0, ack: null },
        { userId: store5.users.arda.id, label: store5.users.arda.email },
        { dataRoot: store5.dataRoot },
      );
      expect(task().frontmatter.readiness).toBe("blocked");
      expect(task().packet).toBeNull();
    };
    const arda = () => ({ userId: store5.users.arda.id, label: store5.users.arda.email });

    it("a person's manual run lifts the hold: readiness ready, a 'Hold lifted' note, task.hold.lifted", async () => {
      deployAgents([operatorAgent()]);
      await holdThroughTheWriter();
      const result = await drive({ trigger: "manual", actor: arda() });
      expect(result.refused).toBeUndefined();
      expect(adapter5.pending).not.toBeNull();
      expect(task().frontmatter.readiness).toBe("ready");
      expect(task().frontmatter.waiting).toBe("agent");
      const note = task().timeline[0]!;
      expect(note).toMatchObject({ type: "note", title: "Hold lifted" });
      expect(note.text).toContain("started an operator run, so VIB-1 is no longer held");
      const rows = listAuditEvents(store5.db, { action: "task.hold.lifted" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ cause: "operator-run", trigger: "manual", byUserId: store5.users.arda.id });
      expect(rows[0]!.actorUserId).toBe(store5.users.arda.id);
    });

    it("a scheduled run lifts it too (owner, Q35-9)", async () => {
      deployAgents([operatorAgent()]);
      await holdThroughTheWriter();
      const result = await drive({ trigger: "scheduled" });
      expect(result.refused).toBeUndefined();
      expect(task().frontmatter.readiness).toBe("ready");
      expect(task().timeline[0]!.text).toContain("a scheduled operator run started");
      expect(listAuditEvents(store5.db, { action: "task.hold.lifted" })[0]!.details).toMatchObject({ trigger: "scheduled" });
    });

    it("a bare manual with no actor and a machine trigger lift nothing", async () => {
      deployAgents([operatorAgent()]);
      await holdThroughTheWriter();
      const bare = await drive({ trigger: "manual" });
      expect(bare.refused).toBeUndefined();
      expect(task().frontmatter.readiness).toBe("blocked");
      adapter5.finish(store5, JSON.stringify({ reasoning: "held", actions: [] }), "finished");
      await eventually(() => {
        expect(operatorRuns()).toHaveLength(1);
        expect(operatorRuns()[0]!.state).toBe("finished");
      });
      const reactive = await drive({ trigger: "agent-reply" });
      expect(reactive.refused).toBeUndefined();
      expect(task().frontmatter.readiness).toBe("blocked");
      expect(task().timeline.some((e) => e.title === "Hold lifted")).toBe(false);
      expect(listAuditEvents(store5.db, { action: "task.hold.lifted" })).toHaveLength(0);
    });

    it("a hold that also waits on other work keeps ruling 131's floor", async () => {
      deployAgents([operatorAgent()]);
      await holdThroughTheWriter({ blockedBy: ["VIB-2"] });
      const result = await drive({ trigger: "manual", actor: arda() });
      // Ruling 131(d): a manual run still answers a person on a held task.
      expect(result.refused).toBeUndefined();
      expect(adapter5.pending).not.toBeNull();
      expect(task().frontmatter.readiness).toBe("blocked");
      expect(task().timeline.some((e) => e.title === "Hold lifted")).toBe(false);
    });
  });

  /**
   * Ruling 216 (F37-36): the SAME press, against the OTHER hold. `heldAtStage`
   * is the stranded backstop's durable marker and its note names running the
   * operator manually as the remedy — live on SHOP-10 that remedy left the
   * marker standing, so the board kept reading "Coordination is paused here"
   * while a person was manually coordinating the task, and the drive they paid
   * for got no nudge when it stranded.
   */
  describe("ruling 216: a person's run ends the deliberate STAGE hold too", () => {
    const stageHeld = (): void => {
      writeTask(store5.dataRoot, store5.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          waiting: "human",
          heldAtStage: "impl",
          ownerUserId: store5.users.arda.id,
        }),
        goal: "Ship the parser.",
      });
      rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
    };
    const arda2 = () => ({ userId: store5.users.arda.id, label: store5.users.arda.email });

    it("clears heldAtStage and says who ended it", async () => {
      deployAgents([operatorAgent()]);
      stageHeld();
      // CANARY: drop the `liftStageHoldForPerson` call in runOperator and the
      // marker survives the one action its own note tells a human to take.
      const result = await drive({ trigger: "manual", actor: arda2() });
      expect(result.refused).toBeUndefined();
      expect(task().frontmatter.heldAtStage).toBeNull();
      expect(
        task().timeline.find((e) => e.title === "Hold lifted")?.text,
      ).toContain("no longer stands");
    });

    it("a SCHEDULE does not — re-arming the nudge hourly is what V18 stopped", async () => {
      deployAgents([operatorAgent()]);
      stageHeld();
      const result = await drive({ trigger: "scheduled" });
      expect(result.refused).toBeUndefined();
      expect(task().frontmatter.heldAtStage).toBe("impl");
      expect(task().timeline.some((e) => e.title === "Hold lifted")).toBe(false);
    });
  });

  describe("ruling 130: a failed operator run's packet", () => {
    const RESET = "2026-09-07T11:50:00.000Z";
    const RESET_LABEL = "Sep 7, 2026 · 11:50 UTC";
    const failed = async (text: string, facts: RunFailureFacts) => {
      deployAgents([operatorAgent()]);
      seed("impl");
      await drive({ trigger: "manual", backend: "claude" });
      expect(adapter5.pending).not.toBeNull();
      adapter5.fail(store5, text, facts);
      await eventually(() => expect(task().packet).not.toBeNull());
      return task().packet!;
    };

    it("quota: names the spent window, the reset instant, the owner and Profile → Agent accounts; the recommended option asserts the window/account, never 'policy / credential'", async () => {
      const packet = await failed("Claude refused the run: usage limit reached.", {
        ...emptyRunFailureFacts("quota"),
        windowRejected: true,
        window: "five_hour",
        resetsAt: RESET,
        apiErrorStatus: 429,
      });
      expect(packet.title).toBe("Operator run failed: pick a recovery path");
      expect(packet.body).toContain(
        `${store5.users.arda.name}'s five-hour usage window is spent and reopens at ${RESET_LABEL}`,
      );
      expect(packet.body).toContain("No coordination was performed.");
      expect(packet.body).toContain("Profile → Agent accounts");
      expect(packet.body).not.toMatch(/retry on the other backend|fix the credential|redirect the task/i);
      expect(packet.observations.some((o) => o.k === "Window reopens" && o.v === RESET_LABEL)).toBe(true);
      const rec = packet.options.find((o) => o.rec)!;
      expect(rec.kind).toBe("block_on_policy");
      expect(rec.t).toBe(`The usage window has reset (${RESET_LABEL}), or I switched the Claude account: re-run`);
      expect(rec.ev).toContain("the usage window has reset or the account was switched");
      expect(rec.ev).not.toContain("policy / credential updated");
      for (const o of packet.options) expect(o.t).not.toMatch(/updated the policy|[–—]/);
    });

    it("names the backend the run was LAUNCHED on, not a per-call override's default (pass 34 review)", async () => {
      // Canary: `const backend = input.backend ?? "claude"` — every machine
      // trigger (which carries no override) then names Claude on a Codex
      // operator, in the packet body and in its options.
      deployAgents([operatorAgent({ backends: ["codex"], model: "gpt-5.6-terra" })]);
      seed("impl");
      await drive({ trigger: "transition" });
      expect(adapter5.pending).not.toBeNull();
      adapter5.fail(store5, "Codex refused the run: usage limit reached.", {
        ...emptyRunFailureFacts("quota"),
        windowRejected: true,
        window: "five_hour",
        resetsAt: RESET,
      });
      await eventually(() => expect(task().packet).not.toBeNull());
      const packet = task().packet!;
      const rendered = [packet.body, ...packet.options.map((o) => `${o.t} ${o.d ?? ""} ${o.ev ?? ""}`)].join("\n");
      expect(rendered).toContain("Codex");
      expect(rendered).not.toContain("Claude");
    });

    it("auth: names the org restriction and the account remedy; recommends 'I connected a different account or an API key'", async () => {
      const packet = await failed("Claude refused the run: the account was rejected.", {
        ...emptyRunFailureFacts("auth"),
        apiError: "oauth_org_not_allowed",
        apiErrorStatus: 403,
        terminalReason: "api_error",
      });
      expect(packet.body).toContain("the account's organization does not allow Claude Code");
      expect(packet.body).toContain("Retrying with the same account fails the same way");
      expect(packet.body).toContain("Profile → Agent accounts");
      expect(packet.body).not.toMatch(/retry on the other backend|fix the credential/i);
      const rec = packet.options.find((o) => o.rec)!;
      expect(rec.kind).toBe("block_on_policy");
      expect(rec.t).toBe("I connected a different Claude account or an API key on Profile → Agent accounts: re-run");
      expect(rec.ev).toContain("No project policy was changed");
    });

    it("unknown: a plain re-run is recommended and its record claims no credential change", async () => {
      const packet = await failed("provider exploded", emptyRunFailureFacts("unknown"));
      expect(packet.body).toContain("The operator run did not complete: provider exploded.");
      expect(packet.body).toContain("read the run's console for the cause");
      expect(packet.body).not.toMatch(/fix the credential|retry on the other backend|\.\./i);
      const rec = packet.options.find((o) => o.rec)!;
      expect(rec.t).toBe("Re-run the operator now");
      expect(rec.ev).toBe("**Decision:** re-run the operator. No policy or credential was changed.");
      expect(packet.options.map((o) => o.kind)).toEqual(["block_on_policy", "redirect", "hold_runtime_debug"]);
    });

    it("the Codex no-plan packet's stock re-run option claims no credential change", async () => {
      // Canary: restore the "I've updated the policy / credential" title in
      // `defaultPacketOptions("blocked")`.
      deployAgents([operatorAgent({ backends: ["codex"], model: defaultModelFor("codex") })]);
      seed("impl");
      await drive({ trigger: "manual", backend: "codex" });
      expect(adapter5.pending).not.toBeNull();
      adapter5.finish(store5, "not a plan", "finished");
      await eventually(() => expect(task().packet).not.toBeNull());
      const packet = task().packet!;
      expect(packet.title).toBe("Operator turn produced no actionable plan");
      const rec = packet.options.find((o) => o.rec)!;
      expect(rec.t).toBe("Re-run the operator now");
      expect(rec.ev).toBe("**Decision:** re-run the operator. No policy or credential was changed.");
      for (const o of packet.options) expect(o.t).not.toMatch(/policy \/ credential|[–—]/);
    });
  });

  /**
   * F19-20 / FR39 — "a scheduled re-run never fires on a terminal stage",
   * enforced where the run STARTS.
   *
   * The schedule runner decided mootness from the tick's projection snapshot,
   * and `runOperator` had no terminal-stage guard of its own. Two windows
   * survived that: the runner drains its claimed list sequentially, and — far
   * wider — a trigger arriving while a drive holds the lease is QUEUED and
   * fired on release with no mootness re-check at all. That in-flight turn is
   * frequently the one that calls `accept_completion`, so the human watched a
   * fresh unwatched agent turn start on the task they had just closed.
   */
  it("F19-20: a SCHEDULED trigger on a Done task starts no run", async () => {
    // Canary: delete the `input.trigger === "scheduled"` guard in runOperator
    // and a run row appears / adapter5.pending is non-null.
    deployAgents([operatorAgent()]);
    seed("done");

    const result = await drive({ trigger: "scheduled" });

    // Ruling 177 (pass 36): the refusal is the one closed-task refusal every
    // trigger gets, no longer a scheduled-only `terminal-stage`.
    expect(result.refused).toBe("closed");
    expect(result.refusalReason).toMatch(/VIB-1 is closed \(Done is the terminal stage\)/);
    expect(result.runId).toBeNull();
    expect(result.queued).toBe(false);
    expect(adapter5.pending).toBeNull();
    expect(operatorRuns()).toHaveLength(0);
  });

  it("ruling 177 (was F19-20's scope): a human trigger on a Done task is refused too", async () => {
    // FR39 scoped the terminal refusal to `scheduled` ("every other trigger on
    // a terminal task is legitimate — an @operator question about finished
    // work"). Pass 36 watched that legitimacy start paid runs on shipped and
    // archived tasks (F36-4, F36-5); ruling 177 closes every door. A person
    // with a question about finished work reopens the task (a stage move) or
    // asks in a comment nobody is dispatched for.
    deployAgents([operatorAgent()]);
    seed("done");

    const result = await drive({ trigger: "manual" });

    expect(result.refused).toBe("closed");
    expect(adapter5.pending).toBeNull();
  });

  /**
   * R20-1 (F20-5) — a HUMAN-pressed "Run operator" while a decision packet is
   * open is a paid no-op (coordination is paused). Refuse it, scoped to the
   * `manual` trigger so machine recovery paths still run.
   */
  const seedWithOpenPacket = (): void => {
    writeTask(store5.dataRoot, store5.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "blocked",
        waiting: "human",
        ownerUserId: store5.users.arda.id,
      }),
      goal: "Ship the parser.",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Operator run failed — pick a recovery path",
        body: "",
        observations: [],
        options: [{ kind: "block_on_policy", t: "Unblock", d: "", rec: true }],
      },
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
  };

  it("R20-1: a MANUAL run is refused while a decision packet is open", async () => {
    deployAgents([operatorAgent()]);
    seedWithOpenPacket();

    const result = await drive({ trigger: "manual" });

    expect(result.refused).toBe("open-packet");
    expect(result.runId).toBeNull();
    expect(result.queued).toBe(false);
    expect(adapter5.pending).toBeNull();
    expect(operatorRuns()).toHaveLength(0);
  });

  it("ruling 227: a refused MANUAL turn says so on the task, not only in the log", async () => {
    // Live on SHOP-2 at 02:44 UTC. A person wrote "@operator PR #13 conflicts
    // with main, rebase and re-review", the comment landed on the timeline with
    // the mention rendered as routed, the composer's footer said "@mentions
    // route to agents" — and the operator was refused at the door because a
    // packet was open. Nothing anywhere on the task said so. Ruling 141 had
    // taught this refusal to speak at the front of the LEASE QUEUE and left the
    // door silent.
    //
    // Canary: drop the `noteQueuedTriggerRefused` call from the open-packet arm.
    deployAgents([operatorAgent()]);
    seedWithOpenPacket();

    const result = await drive({ trigger: "manual" });
    expect(result.refused).toBe("open-packet");

    await vi.waitFor(() => {
      const note = readTaskFile({
        projectSlug: store5.slug,
        taskKey: "VIB-1",
        dataRoot: store5.dataRoot,
      })!.parsed.timeline.find((e) => /An @operator turn was refused/.test(e.text));
      expect(note).toBeTruthy();
      // It names the cause, and says plainly that nothing was acted on — the
      // sentence a person reading their own unanswered instruction needs.
      expect(note!.text).toContain("a decision packet is open on VIB-1");
      expect(note!.text).toContain("nothing on this task has been acted on");
      // And NOT the queue sentence: this one never reached a queue.
      expect(note!.text).not.toContain("front of the queue");
    });
  });

  it("ruling 141: a SCHEDULED run is refused like a manual one while a decision packet is open", async () => {
    // Canary: restore the manual-only guard (`=== "manual"`).
    deployAgents([operatorAgent()]);
    seedWithOpenPacket();

    const result = await drive({ trigger: "scheduled" });

    expect(result.refused).toBe("open-packet");
    expect(result.runId).toBeNull();
    expect(result.queued).toBe(false);
    expect(adapter5.pending).toBeNull();
    expect(operatorRuns()).toHaveLength(0);
  });

  /**
   * Ruling 195 (F37-17, live): a packet opened mid-work does not stop the
   * MACHINE triggers, so the operator kept coordinating on SHOP-6 and
   * dispatched a deliverer — `waiting: agent`. The server restarted, boot
   * finalized that orphan and re-invoked the operator as `manual`, straight
   * into this refusal, which skipped its settle on the belief that "the packet
   * already owns waiting: human". It did not. SHOP-6 sat at `waiting: agent`
   * with nothing running and a decision nobody was told about for 75 minutes,
   * holding ten downstream tasks, while the board showed an agent working.
   */
  it("ruling 195: a refusal over a packet settles `waiting` off a dead agent, onto the human the packet is for", async () => {
    deployAgents([operatorAgent()]);
    writeTask(store5.dataRoot, store5.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        // The state the restart leaves: an agent was dispatched WITH the packet
        // open, and its run is gone.
        waiting: "agent",
        ownerUserId: store5.users.arda.id,
      }),
      goal: "Ship the parser.",
      packet: {
        type: "input",
        kind: "Agent question",
        from: "agent:codex/developer (Dev)",
        title: "Lockfile ownership",
        body: "Who regenerates the lockfile?",
        observations: [],
        options: [{ kind: "custom", t: "Coordinate root fix", d: "", rec: true }],
      },
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });

    const result = await drive({ trigger: "manual" });
    expect(result.refused).toBe("open-packet");
    expect(operatorRuns()).toHaveLength(0);

    // The settle is fire-and-forget; let it land.
    await vi.waitFor(() => {
      const fm = readTaskFile({
        projectSlug: store5.slug,
        taskKey: "VIB-1",
        dataRoot: store5.dataRoot,
      })!.parsed.frontmatter;
      // CANARY: drop the `settleWaitingAfterOperator` call and this stays
      // "agent" forever — a board claiming an agent is working on a task whose
      // every trigger is refused.
      expect(fm.waiting).toBe("human");
    });
  });

  it("ruling 141: a queued SCHEDULED occurrence refused at the front of the lease queue says so on the task and writes its final row", async () => {
    // Canary: restore the bare `.catch(...)` at the drain site (drop the
    // `.then` that chains on the result) — the refusal exists only in the log.
    deployAgents([operatorAgent()]);
    seed("impl");
    await drive({ trigger: "manual" });
    expect(adapter5.pending).not.toBeNull();
    const queued = await drive({ trigger: "scheduled", scheduleId: "sch_1" });
    expect(queued.queued).toBe(true);
    // The live drive opens a packet before the queued turn gets its chance.
    await updateTaskFile({ projectSlug: store5.slug, taskKey: "VIB-1", dataRoot: store5.dataRoot }, (parsed) => {
      parsed.packet = {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Branch conflicts with main",
        body: "",
        observations: [],
        options: [{ kind: "redirect", t: "Have the developer resolve it", d: "", rec: true }],
      };
      parsed.frontmatter.waiting = "human";
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
    adapter5.finish(store5, JSON.stringify({ reasoning: "done", actions: [] }), "finished");
    await eventually(() => {
      expect(
        task().timeline.some((e) =>
          /Scheduled action skipped:.*reached the front of the queue, but a decision packet is open on VIB-1 \("Branch conflicts with main"\)/.test(e.text),
        ),
      ).toBe(true);
    });
    expect(operatorRuns()).toHaveLength(1); // the live drive only — no second run
    expect(task().frontmatter.waiting).toBe("human"); // the packet owns it; the refusal settles nothing
    const rows = listAuditEvents(store5.db).filter((e) => e.action === "task.schedule.fired");
    expect(rows[0]!.details).toMatchObject({ scheduleId: "sch_1", outcome: "skipped-packet", refusedAtStart: true, atDrain: true });
  });

  it("ruling 141: a queued human @operator turn refused at the front of the queue gets the note, settling nothing", async () => {
    deployAgents([operatorAgent()]);
    seed("impl");
    await drive({ trigger: "manual" });
    expect(adapter5.pending).not.toBeNull();
    const queued = await drive({ trigger: "manual" });
    expect(queued.queued).toBe(true);
    await updateTaskFile({ projectSlug: store5.slug, taskKey: "VIB-1", dataRoot: store5.dataRoot }, (parsed) => {
      parsed.packet = {
        type: "input",
        kind: "Decision required",
        from: "operator",
        title: "Scope needed",
        body: "",
        observations: [],
        options: [{ kind: "edit_goal", t: "Specify the goal", d: "", rec: true }],
      };
      parsed.frontmatter.waiting = "human";
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
    adapter5.finish(store5, JSON.stringify({ reasoning: "done", actions: [] }), "finished");
    await eventually(() => {
      expect(
        task().timeline.some((e) =>
          e.text.startsWith("An @operator turn was refused when it reached the front of the queue: a decision packet is open on VIB-1"),
        ),
      ).toBe(true);
    });
    expect(operatorRuns()).toHaveLength(1);
    expect(task().frontmatter.waiting).toBe("human");
    expect(listAuditEvents(store5.db).filter((e) => e.action === "task.schedule.fired")).toHaveLength(0);
  });

  it("R20-1: a MACHINE pr-diverged trigger still runs with a packet open (ruling 17 recovery)", async () => {
    // Canary for the `manual` scoping: pr-diverged WITHDRAWS a moot packet, so
    // it must NOT be refused. Remove the `=== "manual"` scoping in runOperator
    // and this goes red.
    deployAgents([operatorAgent()]);
    seedWithOpenPacket();

    const diverged = await drive({ trigger: "pr-diverged" });

    expect(diverged.refused).toBeUndefined();
    expect(adapter5.pending).not.toBeNull();
  });

  it("R20-1: a MACHINE agent-reply trigger still runs with a packet open", async () => {
    // agent-reply reacts to a run already in flight — also never refused.
    deployAgents([operatorAgent()]);
    seedWithOpenPacket();

    const replied = await drive({ trigger: "agent-reply", agentReply: "done" });

    expect(replied.refused).toBeUndefined();
    expect(adapter5.pending).not.toBeNull();
  });

  it("F19-20: a scheduled trigger QUEUED behind a live drive is re-checked when it FIRES", async () => {
    // The wide window the claim-time check cannot cover: a trigger arriving
    // while a drive holds the lease is queued and fired on release with no
    // mootness re-check anywhere — and that in-flight turn is frequently the
    // one that calls `accept_completion`. So the human watched a fresh
    // unwatched agent turn start on the task they had just closed.
    //
    // Canary: delete the `input.trigger === "scheduled"` guard in runOperator —
    // the drain starts a second run, so `waiting` never settles and the
    // eventually() below times out on a 2-run list.
    deployAgents([operatorAgent()]);
    seed("impl");

    await drive({ trigger: "manual" });
    expect(adapter5.pending).not.toBeNull();
    const queued = await drive({ trigger: "scheduled" });
    expect(queued.queued).toBe(true);
    const firstRunId = adapter5.pending!.spec.runId;

    // The live turn closes the task, THEN releases the lease and drains.
    seed("done");
    adapter5.pending!.callbacks.onExit({
      outcome: "finished",
      effectiveBackend: "claude",
      sessionId: "s1",
    });

    // Wait on a POSITIVE observable of the drain having landed — the refusal
    // settles the waiting flag the lease release skipped (it skipped it exactly
    // because a trigger was queued to fire). Asserting the ABSENCE of a second
    // run without this would pass on the first tick, before the drain ran.
    await eventually(() => {
      expect(task().frontmatter.waiting).not.toBe("agent");
      expect(operatorRuns().filter((r) => r.id !== firstRunId)).toHaveLength(0);
    });
    // A closed task with no packet and no recommendation waits on nobody.
    expect(task().frontmatter.waiting).toBe("none");
  });

  /**
   * B8 — the prompt used to print the GRANT list. An operator granted a server
   * the registry does not have was told "Attached MCP servers: ghost-mcp" and
   * then reported it as available; zero servers mounted.
   */
  it("B8: a granted-but-unregistered MCP is reported as UNAVAILABLE, never as attached", async () => {
    deployAgents([
      operatorAgent({ resources: { skills: [], kb: [], mcps: ["ghost-mcp"] } }),
    ]);
    seed("impl");

    await drive({ trigger: "manual" });
    const systemPrompt = joinedPrompt(adapter5.pending!.spec.systemPrompt ?? "");
    expect(systemPrompt).not.toContain("Attached MCP servers: ghost-mcp");
    expect(systemPrompt).toContain("No MCP servers are attached to you.");
    expect(systemPrompt).toContain("Unavailable MCP servers");
    expect(systemPrompt).toContain("ghost-mcp");
    // Nothing mounted → no governance paragraph claiming tools it lacks.
    expect(systemPrompt).not.toContain("MCP tools are governed too");
  });

  /**
   * B5 — the Claude completion hook released the lease FIRST, which
   * synchronously fires the queued trigger, and only then wrote the blocked
   * recovery packet. The successor drive therefore read the task while the
   * packet that explains the failure was still being written.
   */
  it("B5: the blocked packet is written BEFORE the queued successor drive starts", async () => {
    deployAgents([operatorAgent()]);
    seed("impl");
    adapter5.probe = () => task().packet !== null;

    await drive({ trigger: "manual" });
    expect(adapter5.pending).not.toBeNull();
    // A second trigger lands mid-drive and is queued behind the lease.
    const queued = await drive({ trigger: "transition" });
    expect(queued.queued).toBe(true);

    // The drive fails: the escalation writes a blocked recovery packet.
    adapter5.finish(store5, "provider exploded", "error");

    await eventually(() => {
      expect(operatorRuns()).toHaveLength(2); // the queued trigger drove
    });
    expect(task().packet?.type).toBe("blocked");
    // Run 1 started with no packet; run 2 — the successor — started with the
    // escalation ALREADY on the task.
    expect(adapter5.packetAtStart).toEqual([false, true]);
  });

  /**
   * B10 — a queued/running row left behind by a previous process has no
   * completion callback in this one, so chaining the drain onto it stranded
   * the trigger until some unrelated drive released the lease.
   */
  it("B10: a restart-orphaned run row is finalized and the trigger drives now", async () => {
    deployAgents([operatorAgent()]);
    seed("impl");
    upsertRun(store5.db, {
      id: "run_prev_boot",
      taskKey: "VIB-1",
      projectSlug: store5.slug,
      threadId: "op-prevboot",
      role: "Operator",
      kind: "operator",
      backend: "claude",
      agentProfileId: "operator",
      model: "sonnet",
      sdk: "Claude Agent SDK",
      state: "running",
    });
    // The row predates this process — the fact that makes it an orphan.
    store5.db
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), "run_prev_boot");

    const started = await drive({ trigger: "manual" });
    expect(started.queued).toBe(false);
    expect(started.runId).not.toBe("run_prev_boot");
    // A real run started instead of the trigger sitting in `pending` forever…
    expect(adapter5.pending).not.toBeNull();
    // …and the orphan row no longer reads as live work on the board. Pass 35
    // U35-7: the same shape boot recovery writes, interrupted by a restart.
    const orphan = getRun(store5.db, "run_prev_boot")!;
    expect(orphan.state).toBe("interrupted");
    expect(orphan.interrupted_reason).toBe("restart");
    expect(orphan.interrupted_by).toBeNull();
  });

  it("B10: a run row from THIS process still coalesces (the backstop is not a free-for-all)", async () => {
    deployAgents([operatorAgent()]);
    seed("impl");
    await drive({ trigger: "manual" });
    const first = operatorRuns();
    expect(first).toHaveLength(1);
    // Drop the process lease but leave the run row live: the DB-row backstop.
    resetOperatorLeasesForTests();

    const second = await drive({ trigger: "transition" });
    expect(second.queued).toBe(true);
    expect(second.runId).toBe(first[0]!.id);
    expect(operatorRuns()).toHaveLength(1); // no second overlapping drive
  });

  /**
   * B6 — a task file that cannot be read leaves `stageAtStart: null`, which
   * switches the stranded-resume backstop off for the whole drive. It used to
   * do that in silence.
   */
  it("B6: a failed task-file read says so, twice — at the read and at the backstop", async () => {
    deployAgents([operatorAgent({ backends: ["codex"], model: defaultModelFor("codex") })]);
    // No task file at all: the read failure this drive cannot recover from.
    upsertRun(store5.db, {
      id: "run_ghost",
      taskKey: "GHOST-1",
      projectSlug: store5.slug,
      threadId: "op-ghost",
      role: "Operator",
      kind: "operator",
      backend: "codex",
      agentProfileId: "operator",
      model: defaultModelFor("codex"),
      sdk: "Codex SDK",
      state: "finished",
      finishedAt: new Date().toISOString(),
    });
    const warn = vi.spyOn(logger, "warn");

    await executeStrandedCodexPlan(
      store5.db,
      { dataRoot: store5.dataRoot },
      { projectSlug: store5.slug, taskKey: "GHOST-1", runId: "run_ghost" },
    );

    const warned = () => warn.mock.calls.map(([msg]) => String(msg));
    expect(
      warned().some((m) => m.includes("could not read the task's starting stage")),
    ).toBe(true);
    await eventually(() => {
      expect(
        warned().some((m) => m.includes("stranded-operator backstop DISABLED")),
      ).toBe(true);
    });
    warn.mockRestore();
  });
});

/* ------------- B4: one cap, one comparison, one meaning ------------- */

describe("stranded-resume shares the transition chain cap (B4)", () => {
  let ctx6: TestDbContext;
  let store6: TestStore;
  let adapter6: ControlledAdapter;

  beforeEach(async () => {
    ctx6 = createTestDbContext();
    store6 = setupTestStore(ctx6);
    const project = readProjectFile({
      projectSlug: store6.slug,
      dataRoot: store6.dataRoot,
    })!;
    writeProject(store6.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["codex"],
            model: defaultModelFor("codex"),
          },
        },
      ],
    });
    // An AUTO stage with nothing pending — the stranded shape the backstop
    // resumes, so the ONLY thing bounding the chain is the cap.
    writeTask(store6.dataRoot, store6.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store6.users.arda.id,
      }),
      goal: "Add the changelog entry.",
    });
    rebuildAll(store6.db, { dataRoot: store6.dataRoot, force: true });
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter6 = new ControlledAdapter();
    configureRunServiceForTests({ claude: adapter6, codex: adapter6 });
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have this backend connected or the drive is refused before it starts.
    await connectFakeBackend(store6.db, store6.users.arda.id, "codex");
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx6.cleanup();
  });

  const runs = () =>
    store6.db
      .prepare(`SELECT id FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
      .all()
      .map((row) => ({ id: String(row.id) }));

  const driveAtDepth = async (transitionDepth: number): Promise<void> => {
    await runOperator(store6.db, {
      projectSlug: store6.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "supervised",
      trigger: "transition",
      transitionDepth,
      dataRoot: store6.dataRoot,
    });
    adapter6.finish(store6, JSON.stringify({ reasoning: "", actions: [] }), "finished");
  };

  it("refuses the link that would REACH the cap — the same comparison the transition side makes", async () => {
    const { OPERATOR_TRANSITION_CHAIN_CAP } = await import(
      "~/server/tasks/task-actions.server"
    );
    // depth + 1 === CAP. `transitionStage` stops here (`chainDepth >= CAP`);
    // this side used `>`, so it granted a 9th consecutive link.
    await driveAtDepth(OPERATOR_TRANSITION_CHAIN_CAP - 1);

    await eventually(() => {
      const note = readTaskFile({
        projectSlug: store6.slug,
        taskKey: "VIB-1",
        dataRoot: store6.dataRoot,
      })!.parsed.timeline.find((e) => e.text.includes("consecutive runs without advancing"));
      expect(note).toBeDefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runs()).toHaveLength(1); // no extra link
    expect(adapter6.pending).toBeNull();
  });

  it("still resumes one link below the cap", async () => {
    const { OPERATOR_TRANSITION_CHAIN_CAP } = await import(
      "~/server/tasks/task-actions.server"
    );
    await driveAtDepth(OPERATOR_TRANSITION_CHAIN_CAP - 2);
    await eventually(() => {
      expect(runs()).toHaveLength(2);
      expect(adapter6.pending).not.toBeNull();
    });
  });
});

/**
 * R19-1 (owner ruling, extends F19-4) — the operator gets a FULL READ-ONLY
 * CLONE of the project repository before it reasons about the repository.
 *
 * Live: at triage the operator's cwd (the task's canonical store folder) held
 * exactly `task.md`, and the model published a decision packet stating "Repo
 * contents visible to operator: only task.md — no docs/ or README found" about
 * a repository that has both, then offered "add a README" as a scoping option.
 * It was describing its own empty workspace. A summary-only view and a
 * persona-only fix were both rejected: the packets have to be grounded in the
 * real tree.
 *
 * These tests never reach the network. `createGitHubClonePlan` clones
 * `https://github.com/<repo>.git` with the server process env inherited, so a
 * `url.<local>.insteadOf` entry in a temp `GIT_CONFIG_GLOBAL` redirects the
 * real code path at a local origin — the clone that runs is the production one,
 * only its remote is local.
 */
describe("R19-1 — the operator's read-only repository view", () => {
  let ctx7: TestDbContext;
  let store7: TestStore;
  let adapter7: ControlledAdapter;
  let origins: string;

  const exec = promisify(execFile);

  const deploy = (
    repo: string | null,
    definitionOver: AgentDeploymentDefinition = {},
  ): void => {
    const project = readProjectFile({
      projectSlug: store7.slug,
      dataRoot: store7.dataRoot,
    })!;
    writeProject(store7.dataRoot, {
      ...project.parsed.frontmatter,
      repo,
      agents: [
        {
          profileId: "operator",
          capabilities: OPERATOR_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
            ...definitionOver,
          },
        },
      ],
    });
    writeTask(store7.dataRoot, store7.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store7.users.arda.id,
      }),
      goal: "Ship the parser.",
    });
    rebuildAll(store7.db, { dataRoot: store7.dataRoot, force: true });
  };

  const drive = (over: Partial<Parameters<typeof runOperator>[1]> = {}) =>
    runOperator(store7.db, {
      projectSlug: store7.slug,
      taskKey: "VIB-1",
      autonomy: "supervised",
      trigger: "manual",
      dataRoot: store7.dataRoot,
      ...over,
    });

  const workspaceRoot = () =>
    path.join(store7.dataRoot, "projects", store7.slug, "tasks", "VIB-1", "workspace");
  const checkoutDir = () => path.join(workspaceRoot(), "widgets");
  const systemPrompt = () => joinedPrompt(adapter7.pending?.spec.systemPrompt ?? "");

  /**
   * A local origin for `acme/widgets` (test-support/git-origin.ts), carrying
   * the two things the live confabulation denied existed (a README and a
   * `docs/` folder) plus a `.claude` catalog, which a clone Viberr creates must
   * strip (R18-3).
   */
  async function makeOrigin(): Promise<void> {
    await createLocalOrigin(origins, {
      repo: "acme/widgets",
      files: {
        "README.md": "# widgets\n",
        "docs/guide.md": "the guide\n",
        ".claude/skills/repo-own/SKILL.md": "# ungoverned\n",
      },
    });
  }

  beforeEach(async () => {
    ctx7 = createTestDbContext();
    store7 = setupTestStore(ctx7);
    origins = ctx7.makeTempDir();
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter7 = new ControlledAdapter();
    configureRunServiceForTests({ claude: adapter7, codex: adapter7 });
    // Ruling 127: an operator drive bills the TASK OWNER, so the owner has to
    // have the backend connected or the drive is refused before it starts.
    await connectFakeBackends(store7.db, store7.users.arda.id);
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx7.cleanup();
  });

  it("clones the repository into the task workspace and tells the operator where it is", async () => {
    // Canary: drop the `ensureOperatorRepoCheckout` call from `runOperator` and
    // the checkout assertions fail; drop `workspaceSection` from
    // `buildOperatorSystemPrompt` and the prompt assertions fail.
    deploy("acme/widgets");
    await makeOrigin();

    await withLocalGithub(origins, () => drive());

    // The real tree is on disk — the two things the live packet claimed were
    // absent are the two things asserted here.
    expect(existsSync(path.join(checkoutDir(), "README.md"))).toBe(true);
    expect(readFileSync(path.join(checkoutDir(), "docs", "guide.md"), "utf8")).toContain(
      "the guide",
    );
    // R18-3 still holds for a clone Viberr creates: the repo's own catalog is
    // not discoverable by the run.
    expect(existsSync(path.join(checkoutDir(), ".claude"))).toBe(false);

    // …and the model is TOLD, in the path it can actually use (its cwd is the
    // task folder, so the checkout is one level down).
    const prompt = systemPrompt();
    expect(prompt).toContain("# Your workspace");
    expect(prompt).toContain("read-only checkout of **acme/widgets**");
    expect(prompt).toContain("`./workspace/widgets/`");
    expect(prompt).toContain('as "the repository"');
    // Read-only means the MODEL's hands, and the prompt must not over-correct
    // into "you cannot push": `deliver_for_review` pushes the deliverer's
    // branch, and the operator definition tells the model delivery is its
    // decision. A prompt that denies it would make a careful operator stop
    // delivering — a repo-view fix that broke shipping.
    expect(prompt).toContain("Your own hands never touch that tree");
    expect(prompt).toContain("the SERVER executes");
    expect(prompt).not.toMatch(/cannot write, commit, push/);
  });

  it("reuses an existing checkout WITHOUT touching it (F19-15)", async () => {
    // The checkout is shared with the delivering engagement, and a run may be
    // streaming against it right now. So the operator's provisioning is
    // ensure-only: no re-clone, no remote re-sanitization, no `.claude`
    // re-strip — that strip is exactly what deleted a live run's mounted
    // skills.
    // Canary: replace the existing-checkout early return with a `cloneRepo`
    // style reuse (sanitize + strip) and both survival assertions fail.
    deploy("acme/widgets");
    const dir = checkoutDir();
    mkdirSync(path.join(dir, ".claude", "skills", "mounted"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "skills", "mounted", "SKILL.md"), "MOUNTED");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/x.git"]);

    // No origin rewrite in scope: a clone attempt here would have to reach the
    // network, and `GIT_ALLOW_PROTOCOL` is not even set — the only way this
    // passes fast is by not cloning at all.
    await drive();

    expect(readFileSync(path.join(dir, ".claude", "skills", "mounted", "SKILL.md"), "utf8"))
      .toBe("MOUNTED");
    const { stdout } = await exec("git", ["-C", dir, "config", "--get", "remote.origin.url"]);
    expect(stdout.trim()).toBe("https://example.invalid/x.git");
    expect(systemPrompt()).toContain("`./workspace/widgets/`");
  });

  it("the run is READ-ONLY: the write and shell built-ins are denied", async () => {
    // R19-1 is a coordinator holding a checkout, so "read-only" has to be a
    // property of the RUN — a persona sentence is overridable by the next thing
    // the model reads. `disallowedTools` removes the tool from its context even
    // under bypassPermissions.
    // Canary: return `[]` from `operatorDisallowedTools` and this fails.
    deploy("acme/widgets");
    await makeOrigin();

    await withLocalGithub(origins, () => drive());

    const spec = adapter7.pending!.spec;
    for (const tool of ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"]) {
      expect(spec.disallowedTools).toContain(tool);
    }
    // Reading is the whole point of the checkout — those tools must survive.
    expect(spec.disallowedTools).not.toContain("Read");
    expect(spec.disallowedTools).not.toContain("Grep");
    expect(spec.disallowedTools).not.toContain("Glob");
  });

  it("the CODEX operator carries the same read-only confinement", async () => {
    // Codex has no denylist channel: the denied write set is what makes
    // `startRun` mark the run repo-write-withheld.
    deploy("acme/widgets", { backends: ["codex"], model: defaultModelFor("codex") });
    await makeOrigin();

    await withLocalGithub(origins, () => drive({ backend: "codex" }));

    const spec = adapter7.pending!.spec;
    expect(spec.backend).toBe("codex");
    expect(spec.disallowedTools).toContain("Write");
    expect(spec.repoWriteWithheld).toBe(true);
    // B-1 (pass 24, owner ruling): the Codex operator's cwd is a dedicated
    // scratch folder — NOT the task dir (the default) — so `task.md` and the
    // shared checkout below it sit outside it (placement, not a wall: ruling 185
    // runs the thread `danger-full-access`). Its prompt therefore describes the
    // isolated scratch root and names the checkout by ABSOLUTE path, not the
    // cwd-relative `./workspace/…/`.
    expect(spec.workdir ?? "").toContain(".operator-scratch");
    expect(spec.workdir ?? "").not.toContain(path.join("workspace", "widgets"));
    const p = joinedPrompt(spec.systemPrompt ?? "");
    expect(p).toContain("separate, empty scratch folder");
    expect(p).toContain(checkoutDir());
    expect(p).not.toContain("`./workspace/widgets/`");
  });

  it("a FAILED clone degrades honestly — the drive still runs, and the prompt says it is blind", async () => {
    // The failure must not strand the coordinator (it can still ask, assign,
    // transition), but it must not silently look like an empty repository
    // either — that is the F19-4 confabulation with extra steps.
    // Canary: let the clone failure throw out of `ensureOperatorRepoCheckout`
    // (drop its catch) and the run never starts.
    deploy("acme/widgets");

    const result = await withLocalGithub(path.join(origins, "nope"), () => drive());

    expect(result.runId).not.toBeNull();
    expect(adapter7.pending).not.toBeNull();
    expect(existsSync(path.join(checkoutDir(), ".git"))).toBe(false);
    const prompt = systemPrompt();
    expect(prompt).toContain("NO checkout of **acme/widgets** is available on this run");
    expect(prompt).not.toContain("read-only checkout of");
    expect(prompt).toContain('as "the repository"');
    // F19-6: the sentence names WHY, and quotes git rather than only its exit
    // code — "git exit 128" alone told a human with a working credential
    // nothing they could act on.
    expect(prompt).toContain("The workspace checkout failed");
    expect(prompt).toContain("The checkout reported:");
  });

  it("ruling 485: a checkout left with no `.git/HEAD` is removed as its person before the clone, which then lands from the mirror", async () => {
    // F40-62 left a tree like this behind: files, a `.git` whose HEAD is gone,
    // and a directory the server's own recursive remove could not empty.
    // CANARY: skip the heal in `ensureOperatorRepoCheckout` and the mirror's
    // clone is refused the occupied path, so it falls back to a full clone
    // from GitHub (the warning below).
    deploy("acme/widgets");
    await makeOrigin();
    const dir = checkoutDir();
    mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
    writeFileSync(path.join(dir, "stale.txt"), "left behind\n");
    const tool = path.join(dir, ".wrangler", "tmp", "dev-1wnDsF");
    mkdirSync(tool, { recursive: true });
    writeFileSync(path.join(tool, "bundle.js"), "export {};\n");
    chmodSync(tool, 0o500);
    const warn = vi.spyOn(logger, "warn");
    let warned: string[] = [];
    try {
      await withLocalGithub(origins, () => drive());
      warned = warn.mock.calls.map((call) => call[0]);
    } finally {
      if (existsSync(tool)) chmodSync(tool, 0o700);
      warn.mockRestore();
    }

    expect(existsSync(path.join(dir, ".git", "HEAD"))).toBe(true);
    expect(existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(existsSync(path.join(dir, "stale.txt"))).toBe(false);
    expect(warned).toContain("a checkout with no .git/HEAD is removed as its person and cloned again");
    expect(warned).not.toContain(
      "cloning from the project's repository mirror failed — cloning from GitHub",
    );
    expect(systemPrompt()).toContain("read-only checkout of **acme/widgets**");
  });

  it("a repo-less project gets the no-checkout arm and no clone is attempted", async () => {
    deploy(null);

    await drive();

    expect(existsSync(workspaceRoot())).toBe(false);
    const prompt = systemPrompt();
    expect(prompt).toContain("There is no repository checkout on this run");
    expect(prompt).toContain('as "the repository"');
  });

  /**
   * R21-4 / OBS-8 (live VIB-3) — the operator's OWN clone spent 3+ minutes on a
   * 113 MB repository before "operator run started" ever appeared, and for that
   * whole window the task page said the operator "hasn't started its operator
   * loop": a healthy drive was indistinguishable from a wedged one.
   */
  describe("R21-4 — the pre-run clone is visible", () => {
    it("claims a live 'Preparing workspace' row before the clone, then adopts it", async () => {
      // Canary: drop the `reserveRun` call in `runOperator` and nothing is
      // observable during the clone; drop `spec.reservation` and a SECOND run
      // row appears beside the reserved one (which then never finishes).
      deploy("acme/widgets");
      await makeOrigin();

      const seen: { id: string; step: string | null }[] = [];
      await withLocalGithub(origins, async () => {
        const pending = drive();
        // Poll while the clone's child processes are in flight. Bounded, and it
        // can only end early by the drive finishing — which would itself be the
        // failure this asserts against (nothing visible during preparation).
        for (let i = 0; i < 400; i++) {
          const row = listRunsForTaskRows(store7.db, store7.slug, "VIB-1")[0];
          if (row?.phase === "Preparing workspace") {
            seen.push({ id: row.id, step: row.step });
            break;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
        return pending;
      });

      expect(seen).toHaveLength(1);
      // Named: a spinner over a blank line is what the human already had. D1:
      // first task in the project (no mirror yet) → the step names the one-time
      // cold clone so the multi-minute wait reads as setup, not a stall.
      expect(seen[0]!.step).toBe(
        "Cloning acme/widgets · first task in this project, this can take a few minutes",
      );
      // ONE row for the whole drive — the reserved row IS the run's row, so the
      // strip the human watched never blinks or duplicates, and the launched
      // run keeps the thread the reservation opened.
      const rows = listRunsForTaskRows(store7.db, store7.slug, "VIB-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(seen[0]!.id);
      expect(rows[0]!.state).toBe("running");
      expect(adapter7.pending!.spec.threadId).toBe(rows[0]!.thread_id);
    });

    it("only a drive that must actually CLONE reserves a row", async () => {
      // A reservation is worth a row when the human would otherwise stare at
      // nothing for minutes. The reuse and no-repo arms return in microseconds,
      // and a row for those is noise.
      // Canary: return `target.repo` unconditionally from `pendingOperatorClone`
      // and the last two expectations fail.
      deploy("acme/widgets");
      const ref = { projectSlug: store7.slug, taskKey: "VIB-1", dataRoot: store7.dataRoot };
      expect(operatorPrompts.pendingOperatorClone(ref)).toBe("acme/widgets");

      mkdirSync(path.join(checkoutDir(), ".git"), { recursive: true });
      writeFileSync(path.join(checkoutDir(), ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(operatorPrompts.pendingOperatorClone(ref)).toBeNull();

      deploy(null);
      expect(operatorPrompts.pendingOperatorClone(ref)).toBeNull();
    });
  });

  /**
   * F21-21 (live VIB-7) — the checkout is the DELIVERING AGENT'S workspace, so
   * once that agent commits it stands on the task branch. The operator read a
   * row its own deliverer had just written, declared "the repository's DEFAULT
   * branch already contains that exact row … landed outside the governed
   * pipeline", and opened a blocking packet against a healthy flow. Main was
   * row-free.
   */
  describe("F21-21 — the checkout is the TASK branch, not the default branch", () => {
    it("the prompt says which branch the tree is on and points at the anchored read", async () => {
      // Canary: restore "a read-only checkout … on its default branch" and drop
      // the task-branch paragraph — every assertion here fails.
      deploy("acme/widgets");
      await makeOrigin();

      await withLocalGithub(origins, () => drive());

      const prompt = systemPrompt();
      expect(prompt).toContain("SAME working tree the delivering agent uses");
      expect(prompt).toContain("NOT on `main`");
      expect(prompt).toContain("read_default_branch_file");
      expect(prompt).toContain("never evidence that they landed out-of-band");
      // The old claim must be gone: it is the sentence that licensed the
      // accusation.
      expect(prompt).not.toMatch(/checkout of the project repository on its default branch/);
    });

    it("offers `read_default_branch_file` when the run holds a checkout", async () => {
      deploy("acme/widgets");
      await makeOrigin();
      await withLocalGithub(origins, () => drive());
      expect(adapter7.pending!.spec.allowedTools).toContain(
        "mcp__viberr__read_default_branch_file",
      );
    });

    it("withholds it on a run with NO checkout — a read that could only fail", async () => {
      deploy(null);
      await drive();
      expect(adapter7.pending!.spec.allowedTools).not.toContain(
        "mcp__viberr__read_default_branch_file",
      );
    });

    it("the anchored read answers from origin/main while the tree says otherwise", async () => {
      // The mechanism, on the exact shape of the live incident: the deliverer's
      // commits are IN THE TREE and NOT on main.
      // Canary: point `readDefaultBranchFile` at the working tree (drop the
      // `origin/<branch>:` ref) and both assertions flip.
      deploy("acme/widgets");
      await makeOrigin();
      await withLocalGithub(origins, () => drive());

      const dir = checkoutDir();
      await exec("git", ["-C", dir, "config", "user.email", "t@t.dev"]);
      await exec("git", ["-C", dir, "config", "user.name", "T"]);
      await exec("git", ["-C", dir, "checkout", "-qb", "vib-1"]);
      writeFileSync(path.join(dir, "docs", "guide.md"), "the guide\nthe governed row\n");
      writeFileSync(path.join(dir, "docs", "new.md"), "brand new\n");
      await exec("git", ["-C", dir, "add", "-A"]);
      await exec("git", ["-C", dir, "commit", "-qm", "the deliverer's work"]);

      // What a `Read` of the checkout shows — the false-positive input.
      expect(readFileSync(path.join(dir, "docs", "guide.md"), "utf8")).toContain(
        "the governed row",
      );

      const reads = await withLocalGithub(origins, async () => ({
        changed: await readDefaultBranchFile(store7.db, {
          projectSlug: store7.slug,
          dir,
          defaultBranch: "main",
          path: "docs/guide.md",
        }),
        added: await readDefaultBranchFile(store7.db, {
          projectSlug: store7.slug,
          dir,
          defaultBranch: "main",
          path: "docs/new.md",
        }),
      }));

      expect(reads.changed.kind).toBe("found");
      expect(reads.changed.kind === "found" && reads.changed.text).toContain("the guide");
      expect(reads.changed.kind === "found" && reads.changed.text).not.toContain(
        "the governed row",
      );
      // The whole point: a file only the task branch has is ABSENT from main.
      expect(reads.added.kind).toBe("absent");
    });

    /**
     * F21-3 — the operator's org MCP mounts were never pre-flighted. The
     * specialist path got that in pass 20 (F20-10); the operator, which holds
     * the highest-authority toolkit in the product, kept mounting whatever the
     * registry row remembered and announcing tools it might never get. The
     * in-code TODO said exactly this.
     */
    it("F21-3: a stdio MCP that cannot start is dropped from the mount and disclosed", async () => {
      // Canary: drop the `verifyStdioMcpMountsForRun` await in
      // `operatorMcpResolution` and both halves fail — the prompt announces the
      // server and the toolkit mounts it.
      const now = new Date().toISOString();
      store7.db
        .prepare(
          `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at, up, tools_count)
           VALUES (?, ?, 'stdio', ?, NULL, ?, ?, 1, 16)`,
        )
        .run(
          "mcp_dead",
          "dead-mcp",
          // Nothing to spawn: the pre-flight fails fast and offline. The row
          // above still claims "up · 16 tools", which is the F20-10 setup.
          path.join(origins, "no-such-viberr-mcp-binary"),
          now,
          now,
        );
      deploy("acme/widgets", {
        resources: { skills: [], mcps: ["dead-mcp"], kb: [] },
      });
      await makeOrigin();

      await withLocalGithub(origins, () => drive());

      const spec = adapter7.pending!.spec;
      // The prompt does not claim it, and says why.
      expect(joinedPrompt(spec.systemPrompt ?? "")).not.toContain("Attached MCP servers: dead-mcp");
      expect(joinedPrompt(spec.systemPrompt ?? "")).toContain("Unavailable MCP servers");
      expect(joinedPrompt(spec.systemPrompt ?? "")).toContain("dead-mcp");
      // …and the toolkit did not mount it either: the prompt and the mount are
      // built from ONE resolution, so they cannot disagree.
      expect(Object.keys(spec.mcpServers ?? {})).toEqual(["viberr"]);
      expect(spec.allowedTools ?? []).not.toContain("mcp__dead-mcp");
    });

    it("refuses a path that is not a repository-relative file path", async () => {
      deploy("acme/widgets");
      await makeOrigin();
      await withLocalGithub(origins, () => drive());

      const bad = await readDefaultBranchFile(store7.db, {
        projectSlug: store7.slug,
        dir: checkoutDir(),
        defaultBranch: "main",
        // A ref-ish argument would let the read escape the default branch —
        // which is the one thing this tool exists to pin down.
        path: "vib-1:docs/guide.md",
      });
      expect(bad.kind).toBe("unavailable");
    });
  });
});

/**
 * F37-61: the held-task doctrine told the operator that BOTH `run_agent` and
 * `deliver_for_review` are "REFUSED by the server". Only the first is. Ruling
 * 186's gate lives in `startAgentRun` ("every dispatch door lands here"), and
 * delivery is `performDelivery`, a different path with no `blockedBy` check
 * anywhere in it.
 *
 * Asserting a gate that does not exist is the same defect ruling 186 was written
 * about, inverted: there it was a prompt ASKING where a gate was needed; here it
 * is a prompt CLAIMING a gate that was never built.
 */
describe("F37-61 / ruling 240: the held-task doctrine names two gates, and both exist", () => {
  it("names both doors, and both are really gated", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/server/runtimes/operator-run.server.ts", "utf8");
    // The sentence names both doors, and BOTH gates now exist — ruling 240 built
    // the second after the owner's call. The point of this test is that the
    // claim is checked against the code rather than restated.
    expect(src).toContain("`run_agent` and `deliver_for_review` are BOTH REFUSED");

    const specialist = readFileSync("app/server/tasks/specialist-run.server.ts", "utf8");
    expect(specialist).toContain('holdRefusalFor(db, input.projectSlug, input.taskKey, held, "running an agent on it")');
    // CANARY: delete the hold gate from `performDelivery` and this fails — the
    // prompt would be back to asserting a gate that was never built.
    const actions = readFileSync("app/server/tasks/task-actions.server.ts", "utf8");
    expect(actions).toContain('holdRefusalFor(db, projectSlug, taskKey, held, "delivering it for review")');
  });
});
