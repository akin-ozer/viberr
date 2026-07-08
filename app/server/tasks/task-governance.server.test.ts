import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { getBoard } from "~/server/projections/board-query.server";
import {
  reorderTask,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

const PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "Accept completion, or send back for one fix?",
  body: "Body.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "", rec: true, accept: true },
    { kind: "request_edit", t: "Request one edit", d: "", rec: false, ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance." },
    { kind: "block_on_policy", t: "Block on policy", d: "", rec: false },
    { kind: "hold_runtime_debug", t: "Hold for runtime debug", d: "", rec: false },
    { kind: "redirect", t: "Start a fresh specialist", d: "", rec: false },
  ],
};

function withTask(
  store: TestStore,
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
  packet: TaskPacket | null = null,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function prepared(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function seedTasks(store: TestStore, tasks: { key: string; stage: string }[]): void {
  for (const t of tasks) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(t.key, { stage: t.stage }),
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function stageOrder(store: TestStore, stageId: string): string[] {
  const board = getBoard(store.db, store.slug)!;
  return board.columns.find((c) => c.stage.id === stageId)!.tasks.map((t) => t.key);
}

describe("transitionStage boundary enforcement", () => {
  it("undeclared boundary (triage→impl) → validation error", async () => {
    const store = prepared();
    withTask(store);
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("approval boundary (triage→ready): reviewer forbidden, maintainer ok", async () => {
    const store = prepared();
    withTask(store);
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
        actor(store.users.selin), // reviewer
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.murat), // maintainer
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
    // Leaving triage without an operator assigns one (ruling 16 semantics).
    expect(task.operator).toMatchObject({ assignedAtStageId: "ready" });
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "transition" });
  });

  it("auto boundary (ready→impl): any member incl. viewer; guests rejected", async () => {
    const store = prepared();
    withTask(store, { stage: "ready" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.deniz), // non-member
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      actor(store.users.elif), // viewer — auto boundary is any-member
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("impl");
  });

  it("human boundary (review→done locked): reviewer forbidden, admin ok, waiting→none", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
    expect(task.waiting).toBe("none");
    expect(task.displayReadiness).toBe("accepted"); // derived, not stored
  });

  it("is idempotent — transitioning to the current stage writes nothing", async () => {
    const store = prepared();
    withTask(store, { stage: "ready" });
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.length;
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.timeline).toHaveLength(before);
  });

  it("marks the task's approval notifications read on transition", async () => {
    const store = prepared();
    withTask(store, { stage: "impl" });
    createNotification(store.db, {
      id: "n-test-approval",
      userId: store.users.arda.id,
      kind: "approval",
      text: "Transition request",
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const row = store.db
      .prepare(`SELECT read_at FROM notifications WHERE id = 'n-test-approval'`)
      .get() as { read_at: string | null };
    expect(row.read_at).not.toBeNull();
  });
});

describe("transitionStage manual mode (board / task-detail dropdown)", () => {
  it("moves across a NON-boundary edge (triage→impl) for a maintainer, forbidden for a reviewer", async () => {
    const store = prepared();
    withTask(store);
    // triage→impl is not a declared boundary — rejected without `manual`.
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });

    // A reviewer cannot manual-move (admin|maintainer only).
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // An admin can — and it lands + posts a transition timeline comment.
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("impl");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({ type: "transition" });
    expect(detail?.timeline[0]?.text).toContain("moved VIB-1 from Triage to In Progress");
  });

  it("allows a BACKWARD manual move (review→ready) for a maintainer", async () => {
    const store = prepared();
    withTask(store, { stage: "review" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("ready");
  });

  it("rejects a manual move to an unknown stage", async () => {
    const store = prepared();
    withTask(store);
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "nope", manual: true },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("reorderTask (drag-to-reorder, persistent board order)", () => {
  it("reorders WITHIN a stage via a midpoint boardRank — persists a rebuild, no comment", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
      { key: "VIB-3", stage: "impl" },
    ]);
    expect(stageOrder(store, "impl")).toEqual(["VIB-1", "VIB-2", "VIB-3"]);

    // Move VIB-1 to the end of the column (beforeKey null → append).
    await reorderTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-3", "VIB-1"]);

    // The rank lives in the FILE, so it survives a full projection rebuild.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(typeof file.parsed.frontmatter.boardRank).toBe("number");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-3", "VIB-1"]);

    // A same-stage reorder is quiet — no transition timeline comment.
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.timeline.some((e) => e.type === "transition")).toBe(false);
  });

  it("inserts a card immediately before another (beforeKey)", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
      { key: "VIB-3", stage: "impl" },
    ]);
    // Move VIB-3 before VIB-2 → VIB-1, VIB-3, VIB-2.
    await reorderTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-3", toStageId: "impl", beforeKey: "VIB-2" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(stageOrder(store, "impl")).toEqual(["VIB-1", "VIB-3", "VIB-2"]);
  });

  it("a cross-stage drag moves the stage AND writes the transition comment", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "triage" },
      { key: "VIB-2", stage: "impl" },
    ]);
    const res = await reorderTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(res.movedStage).toBe(true);
    expect(stageOrder(store, "impl")).toEqual(["VIB-2", "VIB-1"]);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.timeline.some((e) => e.type === "transition")).toBe(true);
  });

  it("is admin|maintainer only — a reviewer is rejected", async () => {
    const store = prepared();
    seedTasks(store, [
      { key: "VIB-1", stage: "impl" },
      { key: "VIB-2", stage: "impl" },
    ]);
    await expect(
      reorderTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: "VIB-2" },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("resolvePacket kind matrix", () => {
  it("accept_completion is human-acceptance-gated (admin|maintainer only)", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human", pr: { number: 318, state: "review", title: "PR" } }, PACKET);
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.selin), // reviewer — cannot accept
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.stage).toBe("done");
    expect(task.waiting).toBe("none");
    expect(task.displayReadiness).toBe("accepted");
    expect(task.pr).toMatchObject({ state: "merged" });
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "completion",
      title: "Completion accepted",
      text: "Human acceptance recorded. Task transitioned to **Done** and review PR approved for merge.",
    });
  });

  it("request_edit: waiting→agent, readiness→ready, packet cleared, ev copy written", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.selin), // any member may send back
      { dataRoot: store.dataRoot },
    );
    expect(task.waiting).toBe("agent");
    expect(task.readiness).toBe("ready");
    expect(task.packet).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "transition",
      text: PACKET.options[1]!.ev,
    });
  });

  it("block_on_policy: readiness→blocked, waiting→human, packet KEPT", async () => {
    const store = prepared();
    withTask(store, { stage: "review", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.readiness).toBe("blocked");
    expect(task.waiting).toBe("human");
    expect(task.packet).not.toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "blocked",
      text: "**Decision:** hold on policy. VIB-1 stays blocked until the project credential policy is updated.",
    });
  });

  it("hold_runtime_debug: readiness→blocked, packet KEPT, waiting untouched", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", waiting: "human" }, PACKET);
    const { task } = await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 3 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(task.readiness).toBe("blocked");
    expect(task.waiting).toBe("human");
    expect(task.packet).not.toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      "**Decision:** hold for runtime debug. VIB-1 stays blocked while the provider-native session is inspected — findings come back as task comments.",
    );
  });

  it("redirect without ev → fallback decision copy", async () => {
    const store = prepared();
    withTask(store, { stage: "impl", waiting: "human" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 4 },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      "**Decision:** Start a fresh specialist. Operator re-engages the specialist with a summon note.",
    );
  });

  it("resolving an already-resolved packet → 409 conflict, no crash", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("every resolve marks the task's packet + approval notifications read", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    createNotification(store.db, {
      id: "n-test-packet", userId: store.users.arda.id, kind: "packet",
      ptype: "input", text: "t", projectSlug: store.slug, taskKey: "VIB-1",
    });
    createNotification(store.db, {
      id: "n-test-mention", userId: store.users.arda.id, kind: "mention",
      text: "t", projectSlug: store.slug, taskKey: "VIB-1",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const rows = store.db
      .prepare(`SELECT id, read_at FROM notifications ORDER BY id`)
      .all() as { id: string; read_at: string | null }[];
    expect(rows.find((r) => r.id === "n-test-packet")?.read_at).not.toBeNull();
    // mention rows are NOT auto-read by packet resolution
    expect(rows.find((r) => r.id === "n-test-mention")?.read_at).toBeNull();
  });

  it("the decision survives in the file — canonical truth check", async () => {
    const store = prepared();
    withTask(store, { stage: "review" }, PACKET);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.packet).toBeNull();
    expect(file?.parsed.frontmatter.waiting).toBe("agent");
    expect(file?.parsed.timeline[0]?.type).toBe("transition");
  });
});
