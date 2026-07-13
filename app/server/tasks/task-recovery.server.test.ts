import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  configureSystemRecoveryAfterCanonicalWriteHookForTests,
  openSystemRecovery,
} from "./task-recovery.server";

const ctx = createTestDbContext();
afterEach(() => {
  configureSystemRecoveryAfterCanonicalWriteHookForTests(null);
  ctx.cleanup();
});

describe("openSystemRecovery", () => {
  it("opens a durable packet without consulting operator capabilities", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("ATL-7", {
        stage: "impl",
        waiting: "agent",
        readiness: "ready",
      }),
      goal: "Run the specialist.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const result = await openSystemRecovery(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-7",
        code: "checkout_failed",
        occurrenceId: "checkout-1",
        title: "Repository checkout failed",
        body: "No model was started. Fix repository access and retry.",
      },
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ recorded: true, packetCreated: true });
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "ATL-7",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.packet).toMatchObject({
      type: "blocked",
      from: "system:runtime-recovery",
    });
    expect(task.frontmatter).toMatchObject({
      waiting: "human",
      readiness: "blocked",
      validation: "failing",
    });
    expect(task.timeline[0]?.actor).toEqual({
      kind: "system",
      systemId: "runtime-recovery-checkout-failed-checkout-1",
    });
    expect(
      listAuditEvents(store.db, { action: "task.recovery.opened" }),
    ).toHaveLength(1);
  });

  it("is idempotent and never overwrites an existing human packet", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("ATL-8", { stage: "impl" }),
      goal: "Run the specialist.",
      packet: {
        type: "input",
        kind: "Decision required",
        from: "operator",
        title: "Existing product decision",
        body: "Choose scope.",
        observations: [],
        options: [
          { kind: "custom", t: "Choose later", d: "", rec: true },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const input = {
      projectSlug: store.slug,
      taskKey: "ATL-8",
      code: "operator_failed",
      occurrenceId: "operator-run-1",
      title: "Operator failed",
      body: "The coordinating run did not complete.",
    };
    const first = await openSystemRecovery(store.db, input, {
      dataRoot: store.dataRoot,
    });
    const second = await openSystemRecovery(store.db, input, {
      dataRoot: store.dataRoot,
    });
    const nextOccurrence = await openSystemRecovery(
      store.db,
      { ...input, occurrenceId: "operator-run-2" },
      { dataRoot: store.dataRoot },
    );
    expect(first).toMatchObject({ recorded: true, packetCreated: false });
    expect(second).toEqual({
      recorded: false,
      packetCreated: false,
      notifiedUserIds: [],
    });
    expect(nextOccurrence).toMatchObject({
      recorded: true,
      packetCreated: false,
    });
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "ATL-8",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.packet?.title).toBe("Existing product decision");
    expect(
      task.timeline.filter(
        (event) =>
          event.actor.kind === "system" &&
          event.actor.systemId ===
            "runtime-recovery-operator-failed-operator-run-1",
      ),
    ).toHaveLength(1);
    expect(
      task.timeline.filter(
        (event) =>
          event.actor.kind === "system" &&
          event.actor.systemId ===
            "runtime-recovery-operator-failed-operator-run-2",
      ),
    ).toHaveLength(1);
  });

  it("converges audit and notifications when the process crashes after the canonical write", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("ATL-9", {
        stage: "impl",
        waiting: "agent",
        readiness: "ready",
        ownerUserId: store.users.arda.id,
      }),
      goal: "Recover a failed runtime exactly once.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const input = {
      projectSlug: store.slug,
      taskKey: "ATL-9",
      code: "provider_failed",
      occurrenceId: "run-crash-1",
      title: "Provider failed",
      body: "The provider exited before returning evidence.",
    };
    configureSystemRecoveryAfterCanonicalWriteHookForTests(() => {
      throw new Error("injected crash after canonical recovery write");
    });

    await expect(
      openSystemRecovery(store.db, input, { dataRoot: store.dataRoot }),
    ).rejects.toThrow("injected crash after canonical recovery write");
    expect(
      listAuditEvents(store.db, { action: "task.recovery.opened" }),
    ).toHaveLength(0);
    expect(
      store.db.prepare(`SELECT COUNT(*) AS count FROM notifications`).get(),
    ).toEqual({ count: 0 });

    configureSystemRecoveryAfterCanonicalWriteHookForTests(null);
    const replay = await openSystemRecovery(store.db, input, {
      dataRoot: store.dataRoot,
    });
    expect(replay).toEqual({
      recorded: false,
      packetCreated: false,
      notifiedUserIds: [],
    });
    expect(
      listAuditEvents(store.db, { action: "task.recovery.opened" }),
    ).toHaveLength(1);
    const notificationCount = store.db
      .prepare(`SELECT COUNT(*) AS count FROM notifications`)
      .get() as { count: number };
    expect(notificationCount.count).toBeGreaterThan(0);

    await openSystemRecovery(store.db, input, { dataRoot: store.dataRoot });
    expect(
      listAuditEvents(store.db, { action: "task.recovery.opened" }),
    ).toHaveLength(1);
    expect(
      store.db.prepare(`SELECT COUNT(*) AS count FROM notifications`).get(),
    ).toEqual(notificationCount);
  });
});
