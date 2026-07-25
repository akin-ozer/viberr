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
import { insertRunLine } from "./run-store.server";
import { defaultModelFor } from "./model-catalog.server";
import {
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
    expect(operatorPlanToolsFor(authority({}))).toHaveLength(9);
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
