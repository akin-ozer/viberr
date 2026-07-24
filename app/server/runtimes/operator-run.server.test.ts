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
});
