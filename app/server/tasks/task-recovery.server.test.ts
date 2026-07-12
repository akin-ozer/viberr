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
import { openSystemRecovery } from "./task-recovery.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

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
      systemId: "runtime-recovery-checkout-failed",
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
      title: "Operator failed",
      body: "The coordinating run did not complete.",
    };
    const first = await openSystemRecovery(store.db, input, {
      dataRoot: store.dataRoot,
    });
    const second = await openSystemRecovery(store.db, input, {
      dataRoot: store.dataRoot,
    });
    expect(first).toMatchObject({ recorded: true, packetCreated: false });
    expect(second).toEqual({
      recorded: false,
      packetCreated: false,
      notifiedUserIds: [],
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
          event.actor.systemId === "runtime-recovery-operator-failed",
      ),
    ).toHaveLength(1);
  });
});
