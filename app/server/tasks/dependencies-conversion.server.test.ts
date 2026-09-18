import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { connectFakeBackends } from "../../../test-support/backend-credentials";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import type { RunCallbacks, RunHandle, RunSpec, RuntimeAdapter } from "~/server/runtimes/adapter.server";
import { configureRunServiceForTests } from "~/server/runtimes/run-service.server";
import { insertRunLine, nextSeq } from "~/server/runtimes/run-store.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import { resetOperatorLeasesForTests } from "~/server/runtimes/operator-run.server";
import { resolvePacket } from "./task-actions.server";
import { releaseDependents, setTaskDependencies } from "./dependencies.server";

/**
 * Ruling 131(f) (pass 34, A15): the two live holds convert by setting the
 * list, and Viberr releases them itself. Both shapes drive the REAL
 * `runOperator` behind a controlled Codex adapter, so the run start flips
 * `waiting` to `agent` and the settle is actually exercised.
 *
 * JC-7 ended its hold as `waiting: human` with one comment and no packet.
 * JC-9 ended with an operator `blocked` packet used as a standing token after
 * five paid runs: "nothing will re-check main for JC-9 again".
 */
interface PendingRun {
  spec: RunSpec;
  callbacks: RunCallbacks;
}

class ControlledAdapter implements RuntimeAdapter {
  readonly backend = "codex" as const;
  pending: PendingRun | null = null;
  started = 0;

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.started += 1;
    this.pending = { spec, callbacks };
    return { runId: spec.runId, interrupt() {} };
  }

  finish(store: TestStore, plan: { reasoning: string; actions: unknown[] }): void {
    const pending = this.pending;
    if (!pending) throw new Error("No Codex operator run is pending.");
    const text = JSON.stringify(plan);
    insertRunLine(store.db, {
      runId: pending.spec.runId,
      // Ruling 344: the numbering the real sink uses. A run now carries
      // Viberr's own `run·inputs` disclosure at its head, and `insertRunLine`
      // is `ON CONFLICT DO NOTHING` — a fixture claiming seq 0 drops its own
      // line and the drive looks like it planned nothing.
      seq: nextSeq(store.db, pending.spec.runId),
      occurredAt: new Date().toISOString(),
      raw: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
      display: { t: "12:00:00", ev: "text", tag: "agent_message", text },
    });
    pending.callbacks.onExit({ outcome: "finished", effectiveBackend: "codex", sessionId: "codex-operator-test" });
    this.pending = null;
  }
}

async function eventually(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const planStep = (tool: string, reason: string) => ({
  tool,
  profileId: null,
  delivers: null,
  toStageId: null,
  packetType: null,
  text: null,
  reason,
  packetOptions: null,
  blockedBy: null,
});

describe("ruling 131(f): converting the two live holds", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let adapter: ControlledAdapter;
  const actor = () => ({ userId: store.users.arda.id, label: store.users.arda.email });
  const file = (key: string) =>
    readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;

  beforeEach(async () => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "append-typed-events", mode: "direct" },
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "stage-transitions", mode: "recommend" },
          ],
          extras: [],
          definition: { kind: "operator", name: "Operator", backends: ["codex"], model: defaultModelFor("codex"), autonomy: "supervised" },
        },
      ],
    });
    // goal-1's links 2 to 4, as live: three tasks the holds waited on.
    for (const key of ["JC-2", "JC-3", "JC-4"]) {
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, { stage: "impl", waiting: "none" }) });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    resetSseBrokerForTests();
    resetOperatorLeasesForTests();
    adapter = new ControlledAdapter();
    configureRunServiceForTests({ claude: adapter, codex: adapter });
    await connectFakeBackends(store.db, store.users.arda.id);
  });

  afterEach(() => {
    resetOperatorLeasesForTests();
    resetSseBrokerForTests();
    ctx.cleanup();
  });

  const done = async (key: string): Promise<void> => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, { stage: "done", waiting: "none" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("JC-7 shape: a task held as waiting: human converts, the backstop stays quiet, and the release clears heldAtStage and re-invokes the operator", async () => {
    // Canary: remove the `heldAtStage = null` line from `clearDependencies`.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-7", {
        stage: "impl",
        readiness: "ready",
        waiting: "human",
        heldAtStage: "impl",
        ownerUserId: store.users.arda.id,
      }),
      goal: "Build on goal-1.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const converted = await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "JC-7", blockedBy: ["JC-2", "JC-3", "JC-4"] },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(converted.task.readiness).toBe("blocked");
    expect(file("JC-7").frontmatter.waiting).toBe("none");
    // The backstop never nudges: no run starts on its own while the wait stands.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(adapter.started).toBe(0);
    // A coordinating trigger is refused at no cost (A12); the wait stands.
    const refused = await (await import("~/server/runtimes/operator-run.server")).runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "JC-7",
      trigger: "transition",
      dataRoot: store.dataRoot,
    });
    expect(refused.refused).toBe("blocked-by");
    expect(adapter.started).toBe(0);

    // Two of three land: nothing releases.
    await done("JC-2");
    await done("JC-3");
    expect(await releaseDependents(store.db, { dataRoot: store.dataRoot }, store.slug)).toEqual([]);
    // The last lands: the release clears the list and the hold, lifts the
    // readiness, and re-invokes the REAL operator with the release trigger.
    await done("JC-4");
    expect(await releaseDependents(store.db, { dataRoot: store.dataRoot }, store.slug)).toEqual(["JC-7"]);
    const released = file("JC-7");
    expect(released.frontmatter.blockedBy).toEqual([]);
    expect(released.frontmatter.heldAtStage).toBeNull();
    expect(released.frontmatter.readiness).toBe("ready");
    expect(released.timeline.some((e) => e.title === "Dependencies released")).toBe(true);
    await eventually(() => expect(adapter.started).toBe(1));
    expect(adapter.pending!.spec.prompt).toContain("The work this task waited on has landed: JC-2, JC-3, JC-4 is done.");
    expect(file("JC-7").frontmatter.waiting).toBe("agent");
    adapter.finish(store, { reasoning: "Base re-read; continuing.", actions: [] });
    await eventually(() => expect(file("JC-7").frontmatter.waiting).not.toBe("agent"));
  });

  it("JC-9 shape: setting the wait leaves the standing packet open; resolving it runs ONE reactive turn that reads the wait and stops; the release lifts the stored blocked and the next turn withdraws the moot packet", async () => {
    // Canary: stop lifting readiness from `blocked` to `ready` in
    // `clearDependencies` (the release leaves the task red).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-9", {
        stage: "impl",
        readiness: "blocked",
        waiting: "human",
        heldAtStage: "impl",
        ownerUserId: store.users.arda.id,
      }),
      goal: "Build on goal-1.",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "JC-9 waits for goal-1: this packet is the standing token",
        body: "Nothing will re-check main for JC-9 again.",
        observations: [],
        options: [
          { kind: "hold_runtime_debug", t: "Keep holding", d: "", rec: true },
          { kind: "redirect", t: "Redirect", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // 1. The wait is set FIRST: a wait never touches a packet (A9), so the
    //    packet stays open and `waiting` stays `human` (the packet owns it).
    await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "JC-9", blockedBy: ["JC-2", "JC-3", "JC-4"] },
      actor(),
      { dataRoot: store.dataRoot },
    );
    let f = file("JC-9");
    expect(f.packet).not.toBeNull();
    expect(f.frontmatter.waiting).toBe("human");
    expect(f.frontmatter.blockedBy).toEqual(["JC-2", "JC-3", "JC-4"]);

    // 2. Resolving the standing packet with its recommended option (a hold)
    //    starts NO run (hold_runtime_debug is in the no-requeue set); the
    //    redirect option re-queues ONE reactive turn under the held doctrine.
    await resolvePacket(store.db, { projectSlug: store.slug, taskKey: "JC-9", optionIndex: 1 }, actor(), { dataRoot: store.dataRoot });
    await eventually(() => expect(adapter.started).toBe(1));
    expect(adapter.pending!.spec.prompt).toContain("This task WAITS ON OTHER WORK and Viberr is holding it: JC-2 (open), JC-3 (open), JC-4 (open).");
    expect(adapter.pending!.spec.prompt).not.toContain("NEVER end your turn");
    expect(file("JC-9").packet).toBeNull();
    adapter.finish(store, { reasoning: "Held; waiting on goal-1.", actions: [planStep("post_comment", "held")].map((a) => ({ ...a, text: "Holding for goal-1 links 2 to 4." })) });
    await eventually(() => expect(file("JC-9").frontmatter.waiting).toBe("none"));
    // The turn read the wait and stopped: no second run, no new packet.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(adapter.started).toBe(1);
    expect(file("JC-9").packet).toBeNull();

    // 3. goal-1's links land: the release lifts the STORED blocked readiness,
    //    clears the hold and re-invokes the operator with the release trigger.
    await done("JC-2");
    await done("JC-3");
    await done("JC-4");
    expect(await releaseDependents(store.db, { dataRoot: store.dataRoot }, store.slug)).toEqual(["JC-9"]);
    f = file("JC-9");
    expect(f.frontmatter.readiness).toBe("ready");
    expect(f.frontmatter.heldAtStage).toBeNull();
    expect(f.frontmatter.blockedBy).toEqual([]);
    await eventually(() => expect(adapter.started).toBe(2));
    expect(adapter.pending!.spec.prompt).toContain("The work this task waited on has landed");
    adapter.finish(store, { reasoning: "Base branch changed; continuing.", actions: [] });
    await eventually(() => expect(file("JC-9").frontmatter.waiting).not.toBe("agent"));
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.dependencies.released" && e.taskKey === "JC-9")).toHaveLength(1);
  });

  it("a moot hold packet the operator opened itself is withdrawn by the release turn's own plan", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-10", {
        stage: "impl",
        readiness: "blocked",
        waiting: "human",
        blockedBy: ["JC-2"],
        ownerUserId: store.users.arda.id,
      }),
      goal: "Build on goal-1.",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Hold for goal-1",
        body: "",
        observations: [],
        options: [{ kind: "hold_runtime_debug", t: "Keep holding", d: "", rec: true }],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await done("JC-2");
    expect(await releaseDependents(store.db, { dataRoot: store.dataRoot }, store.slug)).toEqual(["JC-10"]);
    // Nothing resolved the packet before the release here, so the STORED
    // `blocked` is lifted by the release itself (the JC-9 case's redirect
    // resolution had already lifted it there).
    expect(file("JC-10").frontmatter.readiness).toBe("ready");
    await eventually(() => expect(adapter.started).toBe(1));
    const prompt = adapter.pending!.spec.prompt;
    expect(prompt).toContain("If it is a hold packet you opened about this very wait, it is now MOOT: `resolve_decision_packet` it first");
    adapter.finish(store, { reasoning: "The wait is over.", actions: [planStep("resolve_packet", "the wait on JC-2 is over; goal-1 landed")] });
    await eventually(() => expect(file("JC-10").packet).toBeNull());
  });
});
