import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { configureRunServiceForTests } from "./run-service.server";
import { setBackendAvailability, type AdapterSet } from "./runtime-registry.server";
import {
  getOperatorDispatchStatus,
  resetOperatorDispatchForTests,
} from "./operator-dispatch.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import { setupTestStore, writeProject, type TestStore } from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTask } from "~/server/tasks/task-actions.server";
import { resetOperatorLeasesForTests } from "./operator-run.server";
import { listAuditEvents } from "../../../test-support/audit-log";

class HeldAdapter implements RuntimeAdapter {
  readonly backend = "claude" as const;
  pending: Array<{ spec: RunSpec; callbacks: RunCallbacks }> = [];

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.pending.push({ spec, callbacks });
    return { runId: spec.runId, interrupt() {} };
  }

  finishOne(): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No held operator run.");
    pending.callbacks.onExit({
      outcome: "finished",
      effectiveBackend: "claude",
      simulated: false,
      sessionId: `held-${pending.spec.runId}`,
    });
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 100; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw last;
}

describe("bounded automatic operator dispatch", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let adapter: HeldAdapter;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    adapter = new HeldAdapter();
    const adapters: AdapterSet = {
      claude: adapter,
      codex: adapter,
      simulated: adapter,
    };
    configureRunServiceForTests(adapters);
    setBackendAvailability("claude", true);
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
  });

  afterEach(async () => {
    while (adapter.pending.length > 0) adapter.finishOne();
    await new Promise((resolve) => setTimeout(resolve, 5));
    resetOperatorLeasesForTests();
    resetOperatorDispatchForTests();
    ctx.cleanup();
  });

  it("queues a burst, runs at most two, then drains after completion", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await createTask(
        store.db,
        {
          projectSlug: store.slug,
          title: `Bounded assessment ${i}`,
          goal: `Implement the explicit bounded routing behavior ${i} and verify it with a focused test.`,
        },
        { userId: store.users.arda.id, label: store.users.arda.email },
        { dataRoot: store.dataRoot },
      );
      keys.push(created.key);
      expect(created.operatorTrigger).toBe("queued");
    }

    await eventually(() => expect(adapter.pending).toHaveLength(2));
    expect(
      keys.map((key) => getOperatorDispatchStatus(store.db, store.slug, key)?.state),
    ).toEqual(["running", "running", "queued"]);
    expect(listAuditEvents(store.db, { action: "task.operator.auto_queued" })).toHaveLength(3);

    adapter.finishOne();
    await eventually(() => expect(adapter.pending).toHaveLength(2));
    expect(getOperatorDispatchStatus(store.db, store.slug, keys[0]!)?.state).toBe("finished");
    expect(getOperatorDispatchStatus(store.db, store.slug, keys[2]!)?.state).toBe("running");
  });

  it("does not spend an operator turn for the placeholder goal", async () => {
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Needs concrete intent" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(created.operatorTrigger).toBe("awaiting_input");
    expect(adapter.pending).toHaveLength(0);
    expect(getOperatorDispatchStatus(store.db, store.slug, created.key)).toBeNull();
  });
});
