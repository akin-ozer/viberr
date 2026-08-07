import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "~/server/logging/logger.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";
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
  setBackendAvailability,
  type AdapterSet,
} from "./runtime-registry.server";
import { insertRunLine, upsertRun } from "./run-store.server";
import { defaultModelFor } from "./model-catalog.server";
import {
  executeStrandedCodexPlan,
  operatorPlanToolsFor,
  resetOperatorLeasesForTests,
  runOperator,
} from "./operator-run.server";
import * as operatorPrompts from "./operator-run.server";
import type {
  OperatorAuthority,
  OperatorAutonomy,
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
import { listAuditEvents } from "../../../test-support/audit-log";

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

  finish(store: TestStore, text: string, outcome: RunExit["outcome"]): void {
    const pending = this.pending;
    if (!pending) throw new Error("No Codex operator run is pending.");
    // Persist the projected assistant line exactly where executeCodexPlan reads
    // it. The controlled adapter deliberately leaves completion to the test so
    // startCodexOperatorRun has registered its callback first.
    insertRunLine(store.db, {
      runId: pending.spec.runId,
      seq: 0,
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

function transitionAction(extra: Record<string, unknown> = {}) {
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

  beforeEach(() => {
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
          },
        },
      ] as never,
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
    setBackendAvailability("codex", true);
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
      ] as never,
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
      ] as never,
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
      ] as never,
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
    await start();
    const reasoning = `Observed: ${"implementation evidence ".repeat(70)}`;
    const text = JSON.stringify({
      reasoning,
      actions: [transitionAction()],
    });
    expect(text.length).toBeGreaterThan(1_200);
    adapter.finish(store, text, "finished");

    await eventually(() => {
      expect(task().frontmatter.stage).toBe("review");
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
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    expect(adapter.pending!.spec.mcpServers).toEqual({
      "ops-readonly": { type: "http", url: "https://mcp.example/sse" },
    });
    // …and the operator is told which servers it holds, so it can report them
    // honestly instead of guessing (P14-LV-11).
    expect(adapter.pending!.spec.systemPrompt).toContain(
      "Attached MCP servers: ops-readonly.",
    );
  });

  // P14-LV-11: asked which backend it was on, an operator running on Claude
  // reported "Codex backend run" — it had no runtime identity at all, so it
  // echoed the premise in the task goal.
  it("tells the operator which backend and model it is actually running on", async () => {
    await start();
    const systemPrompt = adapter.pending!.spec.systemPrompt ?? "";
    expect(systemPrompt).toContain("# Your runtime");
    expect(systemPrompt).toContain("You are running on the **Codex** backend");
    expect(systemPrompt).toContain(defaultModelFor("codex"));
    expect(systemPrompt).toContain("No MCP servers are attached to you.");
    expect(systemPrompt).toContain("never repeat");
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
        "assign-primary-specialist": "direct",
        "summon-reviewers": "direct",
        "completion-for-acceptance": "human",
      }),
    );
    expect(tools).toContain("post_comment");
    expect(tools).toContain("set_goal");
    expect(tools).toContain("engage_agent");
    expect(tools).not.toContain("open_packet");
    expect(tools).not.toContain("resolve_packet");
    expect(tools).not.toContain("transition_stage");
    expect(tools).not.toContain("accept_completion");
  });

  it("either agent grant admits the engagement tools (mirrors the Claude toolkit)", () => {
    const tools = operatorPlanToolsFor(
      authority({ "summon-reviewers": "recommend" }),
    );
    expect(tools).toEqual(
      expect.arrayContaining(["engage_agent", "run_agent", "prompt_agent"]),
    );
  });

  it("an all-denied operator falls back to the full list MINUS delivery (an enum may not be empty)", () => {
    // A misconfiguration rather than an expressible run shape — every action it
    // then proposes is refused VISIBLY by the executor rather than silently.
    // R15-2: `deliver-review-pr` must be EXPLICITLY off here — an absent grant
    // means granted (the capability postdates live deployments).
    // A4: the fallback must not re-advertise the one action with effects
    // outside Viberr (push a branch, open a PR) that this policy just withheld.
    const tools = operatorPlanToolsFor(authority({ "deliver-review-pr": "off" }));
    expect(tools).toHaveLength(9);
    expect(tools).not.toContain("deliver_for_review");
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
});

describe("pr-diverged turn instruction (both backends)", () => {
  function snapshot(
    over: Partial<import("~/server/tasks/operator-actions.server").OperatorTaskSnapshot> = {},
  ): import("~/server/tasks/operator-actions.server").OperatorTaskSnapshot {
    return {
      key: "VIB-9",
      title: "T",
      goal: "Do the thing.",
      stage: "review",
      stageName: "Review",
      readiness: "ready",
      waiting: "human",
      owner: null,
      specialist: null,
      reviewers: [],
      nextStages: [{ id: "done", name: "Done", boundary: "human" }],
      stageIds: ["triage", "ready", "impl", "review", "done"],
      doneStageId: "done",
      reviewStageId: "review",
      workStageId: "impl",
      deployedSpecialists: [],
      openPacket: false,
      packet: null,
      recentTimeline: [],
      pr: { number: 318, state: "closed", title: "PR" },
      branch: "vib-9",
      liveRuns: [],
      autonomy: "supervised" as OperatorAutonomy,
      policy: {},
      ...over,
    };
  }
  const { buildOperatorTurnPrompt, buildCodexOperatorPrompt } = operatorPrompts;

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
      snapshot({ pr: { number: 318, state: "merged", title: "PR" } }),
      "pr-diverged",
    );
    expect(prompt).toContain("merged OUT-OF-BAND");
    expect(prompt).toContain("`accept_completion`");
    expect(prompt).not.toContain("archive_task");
  });

  it("PR live again → withdraw the moot packet and continue", () => {
    const prompt = buildOperatorTurnPrompt(
      snapshot({ pr: { number: 318, state: "review", title: "PR" } }),
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

  it("the Codex plan prompt carries the same instruction plus the archive_task option vocabulary", () => {
    const prompt = buildCodexOperatorPrompt(snapshot(), "pr-diverged");
    expect(prompt).toContain("closed WITHOUT merging");
    expect(prompt).toContain("`archive_task` to archive the task");
    expect(prompt).toContain("deleteBranch: true");
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
      packet: null as unknown,
      recommendations: [] as unknown[],
    };
    const { operatorLeftTaskStranded } = operatorPrompts;
    expect(operatorLeftTaskStranded(base, wf)).toBe(true);
    expect(operatorLeftTaskStranded({ ...base, stage: "ready" }, wf)).toBe(true);
    expect(operatorLeftTaskStranded({ ...base, stage: "impl" }, wf)).toBe(false); // approval gate
    expect(operatorLeftTaskStranded({ ...base, stage: "done" }, wf)).toBe(false); // terminal
    expect(operatorLeftTaskStranded({ ...base, archived: true }, wf)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, packet: { title: "?" } }, wf)).toBe(false);
    expect(operatorLeftTaskStranded({ ...base, recommendations: [{}] }, wf)).toBe(false);
  });

  it("goal-drafting is labeled SETUP in the turn instruction — the live stranding's exact misreading", () => {
    const prompt = operatorPrompts.buildOperatorTurnPrompt(
      {
        key: "VIB-1",
        title: "t",
        goal: "Goal to be refined at the triage quality gate.",
        stage: "triage",
        stageName: "Triage",
        readiness: "input_required",
        waiting: "human",
        owner: null,
        specialist: null,
        reviewers: [],
        nextStages: [{ id: "ready", name: "Ready", boundary: "auto" }],
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
        policy: {},
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

    beforeEach(() => {
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
        ] as never,
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
      setBackendAvailability("codex", true);
    });

    afterEach(() => {
      resetOperatorLeasesForTests();
      resetSseBrokerForTests();
      ctx2.cleanup();
    });

    const operatorRuns = () =>
      store2.db
        .prepare(`SELECT id, state FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
        .all() as { id: string; state: string }[];

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
  const snap = () => ({
    key: "VIB-2",
    title: "t",
    goal: "Write the post.",
    stage: "impl",
    stageName: "In Progress",
    readiness: "ready",
    waiting: "agent",
    owner: null,
    specialist: null,
    reviewers: [],
    nextStages: [{ id: "review", name: "Review", boundary: "approval" }],
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
    autonomy: "supervised" as OperatorAutonomy,
    policy: {},
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
    over: Partial<import("~/server/tasks/operator-actions.server").OperatorTaskSnapshot> = {},
  ): import("~/server/tasks/operator-actions.server").OperatorTaskSnapshot => ({
    key: "VIB-6",
    title: "Improve the docs",
    // The live goal that sailed through the gate: no file, no change, no
    // acceptance criteria — and NOT the unspecified placeholder, so the
    // goal-drafting branch never fired either.
    goal: "The documentation could be improved. Make it better.",
    stage: "triage",
    stageName: "Triage",
    readiness: "ready",
    waiting: "human",
    owner: null,
    specialist: null,
    reviewers: [],
    nextStages: [{ id: "ready", name: "Ready", boundary: "auto" }],
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
    autonomy: "supervised" as OperatorAutonomy,
    policy: {},
    ...over,
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
      ] as never,
    });
  };

  beforeEach(() => {
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
    setBackendAvailability("codex", true);
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
      .all() as { id: string }[];

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

  beforeEach(() => {
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
      ] as never,
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
    setBackendAvailability("codex", true);
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
    } as Parameters<typeof upsertRun>[1]);
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
        .all() as { id: string }[];
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

  const deployAgents = (agents: unknown[]): void => {
    const project = readProjectFile({
      projectSlug: store5.slug,
      dataRoot: store5.dataRoot,
    })!;
    writeProject(store5.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: agents as never,
    });
    rebuildAll(store5.db, { dataRoot: store5.dataRoot, force: true });
  };

  const operatorAgent = (over: Record<string, unknown> = {}) => ({
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
      .all() as { id: string; state: string }[];

  const drive = (over: Partial<Parameters<typeof runOperator>[1]> = {}) =>
    runOperator(store5.db, {
      projectSlug: store5.slug,
      taskKey: "VIB-1",
      autonomy: "supervised",
      dataRoot: store5.dataRoot,
      ...over,
    });

  beforeEach(() => {
    ctx5 = createTestDbContext();
    store5 = setupTestStore(ctx5);
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter5 = new ProbeAdapter();
    configureRunServiceForTests({ claude: adapter5, codex: adapter5 });
    setBackendAvailability("claude", true);
    setBackendAvailability("codex", true);
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
    // R19-4: the read-only repo view rides along on the read-only floor — an
    // undeployed operator may LOOK at the repository, and still change nothing.
    expect(spec.allowedTools).toEqual([
      "mcp__viberr__get_task",
      "mcp__viberr__list_repo_files",
      "mcp__viberr__read_repo_file",
    ]);
    expect(spec.allowedTools).not.toContain("mcp__viberr__deliver_for_review");
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
    const systemPrompt = adapter5.pending!.spec.systemPrompt ?? "";
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
    } as Parameters<typeof upsertRun>[1]);
    // The row predates this process — the fact that makes it an orphan.
    store5.db
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), "run_prev_boot");

    const started = await drive({ trigger: "manual" });
    expect(started.queued).toBe(false);
    expect(started.runId).not.toBe("run_prev_boot");
    // A real run started instead of the trigger sitting in `pending` forever…
    expect(adapter5.pending).not.toBeNull();
    // …and the orphan row no longer reads as live work on the board.
    const orphan = operatorRuns().find((r) => r.id === "run_prev_boot")!;
    expect(orphan.state).toBe("error");
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
    } as Parameters<typeof upsertRun>[1]);
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

  beforeEach(() => {
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
      ] as never,
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
    setBackendAvailability("codex", true);
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx6.cleanup();
  });

  const runs = () =>
    store6.db
      .prepare(`SELECT id FROM agent_runs WHERE kind = 'operator' ORDER BY rowid`)
      .all() as { id: string }[];

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
