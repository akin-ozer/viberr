import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("an all-denied operator falls back to the full list (an enum may not be empty)", () => {
    // A misconfiguration rather than an expressible run shape — every action it
    // then proposes is refused VISIBLY by the executor rather than silently.
    // R15-2: `deliver-review-pr` must be EXPLICITLY off here — an absent grant
    // means granted (the capability postdates live deployments).
    expect(
      operatorPlanToolsFor(authority({ "deliver-review-pr": "off" })),
    ).toHaveLength(10);
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
    // Each queued question drains as its own governed turn and
    // `open_decision_packet` REPLACES the open packet — the human answering the
    // first is then told their decision "was replaced by a newer one".
    const withPacket = operatorPrompts.buildOperatorTurnPrompt(
      snap({ stage: "impl", stageName: "In Progress", openPacket: true }),
      "manual",
      "@operator should we ship without the migration?",
      undefined,
      "Arda",
    );
    expect(withPacket).toContain("A decision packet is ALREADY OPEN");
    expect(withPacket).toContain("REPLACES the open one");
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
