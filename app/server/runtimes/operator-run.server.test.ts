import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
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
  resetOperatorLeasesForTests,
  runOperator,
} from "./operator-run.server";
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

interface PendingRun {
  spec: RunSpec;
  callbacks: RunCallbacks;
}

class ControlledAdapter implements RuntimeAdapter {
  readonly backend = "codex" as const;
  pending: PendingRun | null = null;
  readonly starts: PendingRun[] = [];

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.pending = { spec, callbacks };
    this.starts.push(this.pending);
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
    // Completion can synchronously start the queued successor. Clear the
    // predecessor first so that successor remains observable as pending.
    this.pending = null;
    pending.callbacks.onExit({
      outcome,
      effectiveBackend: "codex",
      simulated: false,
      sessionId: "codex-operator-test",
    });
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
    toStageId: "review",
    packetType: null,
    readiness: null,
    text: null,
    reason: "Implementation is complete.",
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
      simulated: adapter,
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

  it("records operator failure through system recovery when generate-packets is denied", async () => {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          ...project.parsed.frontmatter.agents[0],
          capabilities: OPERATOR_POLICY.map((grant) =>
            grant.capabilityId === "generate-packets"
              ? { ...grant, mode: "off" as const }
              : grant,
          ),
        },
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await start();
    adapter.finish(store, "partial output", "error");
    await eventually(() => {
      expect(task().packet?.from).toBe("system:runtime-recovery");
    });
    expect(task().frontmatter).toMatchObject({
      waiting: "human",
      readiness: "blocked",
      validation: "failing",
    });
    expect(task().timeline[0]?.actor).toMatchObject({
      kind: "system",
      systemId: "runtime-recovery-operator-run-failed",
    });
  });

  it("starts Codex in a fresh repo-free operator workdir", async () => {
    await start();
    const spec = adapter.pending!.spec;
    expect(spec.workdir).toContain("/runtimes/operator-workspaces/");
    expect(spec.workdir).not.toContain("/tasks/VIB-1");
    expect(readdirSync(spec.workdir)).toEqual([]);
    expect(spec.autonomous).toBe(false);
    expect(spec.env?.GIT_CEILING_DIRECTORIES).toBeTruthy();
  });

  it("keeps a recovered successor lease when the stale predecessor releases", async () => {
    const noopPlan = JSON.stringify({ reasoning: "", actions: [] });
    const first = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "first trigger",
      dataRoot: store.dataRoot,
    });
    expect(adapter.starts).toHaveLength(1);

    // Model a process restart: the DB still says the first run is in flight,
    // but its in-memory lease is gone. The next trigger must recover that row
    // with a new token, and a later trigger must coalesce behind that token.
    resetOperatorLeasesForTests();
    const recovered = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "recovery trigger",
      dataRoot: store.dataRoot,
    });
    const queuedBehindRecovery = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "queued behind recovery",
      dataRoot: store.dataRoot,
    });
    expect(recovered.runId).toBe(first.runId);
    expect(queuedBehindRecovery.runId).toBe(first.runId);
    expect(adapter.starts).toHaveLength(1);

    adapter.finish(store, noopPlan, "finished");
    await eventually(() => expect(adapter.starts).toHaveLength(2));
    const successorRunId = adapter.starts[1]!.spec.runId;
    expect(successorRunId).not.toBe(first.runId);

    // executeCodexPlan(first) releases its original, now-stale token on a
    // microtask after recovery has already launched the successor. Give that
    // stale release time to run, then prove it did not evict the new lease.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const coalescedA = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "older successor trigger",
      dataRoot: store.dataRoot,
    });
    const coalescedB = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "codex",
      autonomy: "full",
      trigger: "manual",
      humanComment: "newest successor trigger",
      dataRoot: store.dataRoot,
    });
    expect(coalescedA.runId).toBe(successorRunId);
    expect(coalescedB.runId).toBe(successorRunId);
    expect(adapter.starts).toHaveLength(2);

    adapter.finish(store, noopPlan, "finished");
    await eventually(() => expect(adapter.starts).toHaveLength(3));
    expect(adapter.starts[2]!.spec.prompt).toContain("newest successor trigger");
    expect(adapter.starts[2]!.spec.prompt).not.toContain("older successor trigger");

    adapter.finish(store, noopPlan, "finished");
  });

  it("freezes an unresolved-readiness turn so a verdict cannot also transition", async () => {
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.readiness = "input_required";
        parsed.frontmatter.waiting = "human";
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await start();
    adapter.finish(
      store,
      JSON.stringify({
        reasoning: "The goal is concrete enough to enter the workflow.",
        actions: [
          {
            tool: "assess_readiness",
            profileId: null,
            toStageId: null,
            packetType: null,
            readiness: "ready",
            text: null,
            reason: "The canonical goal names coordination into review and its completion boundary.",
          },
          transitionAction(),
        ],
      }),
      "finished",
    );
    await eventually(() => expect(task().frontmatter.readiness).toBe("ready"));
    expect(task().frontmatter.stage).toBe("impl");
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
});
