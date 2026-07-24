import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "./rebuilder.server";
import { getBoard, labelUnresolvedHuman } from "./board-query.server";
import { decisionsRequiring } from "./decisions.server";
import { getTaskSummary } from "./task-query.server";
import { listHomeProjects } from "~/features/home/home-query.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/**
 * LV-20 — a terminal-stage task is CLOSED, so nothing can be waiting on a human.
 *
 * Live-proven: a conversational operator turn on a Done+merged task left
 * `waiting: human` in the task file forever (the run start flips it to `agent`,
 * `clearWaitingToHuman` flips it back to `human` when the run ends — see
 * app/server/tasks/task-actions.server.ts). The task detail then reported
 * "Waiting on: Human decision", the board counted it in "N waiting on a human
 * decision", and the review queue (which filters on the review boundary)
 * reported 0 — two surfaces disagreeing about one task.
 */
describe("LV-20: waiting is normalized at the terminal stage", () => {
  it("projects a done task's stored `waiting: human` as `none`", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-900", {
        stage: "done",
        waiting: "human",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const summary = getTaskSummary(store.db, store.slug, "VIB-900")!;
    expect(summary.stage).toBe("done");
    expect(summary.waiting).toBe("none");

    // The board counter reads the same projection, so it agrees.
    const board = getBoard(store.db, store.slug)!;
    const all = board.columns.flatMap((c) => c.tasks);
    expect(all.filter((t) => t.waiting === "human")).toHaveLength(0);
  });

  it("leaves a NON-terminal task's waiting state untouched", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-901", {
        stage: "review",
        waiting: "human",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(getTaskSummary(store.db, store.slug, "VIB-901")!.waiting).toBe(
      "human",
    );
  });

  it("a done task with a leftover packet is not a pending decision", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-902", {
        stage: "done",
        waiting: "human",
      }),
      packet: {
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Ready to accept",
        body: "Everything passed.",
        observations: [],
        options: [
          { kind: "accept_completion", t: "Accept", d: "Move to Done", rec: true },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const mine = decisionsRequiring(store.db, store.users.arda.id, {
      projectSlug: store.slug,
    }).mine;
    expect(mine.map((d) => d.taskKey)).not.toContain("VIB-902");
  });
});

/**
 * UI-02 — "updated just now" on projects that did not change.
 *
 * `updatedAt` used to fall back to `projects.parsed_at`, which is `nowIso()` at
 * (re)projection time, so "Rebuild projections" made every TASK-LESS project
 * card read "updated just now" although nothing had changed.
 */
describe("UI-02: a task-less project has no recency signal", () => {
  it("returns null updatedAt instead of the projection timestamp", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const card = listHomeProjects(store.db).find((p) => p.slug === store.slug)!;
    expect(card.total).toBe(0);
    expect(card.updatedAt).toBeNull();
  });

  it("still reports the newest task updated_at when tasks exist", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-903", {
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const card = listHomeProjects(store.db).find((p) => p.slug === store.slug)!;
    expect(card.updatedAt).toBe("2026-07-20T10:00:00.000Z");
  });
});

/**
 * LV-04 — an unresolvable user id must never render as the raw `u_…` string.
 */
describe("LV-04: removed accounts are named honestly", () => {
  it("labels an owner whose account no longer exists", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-904", {
        ownerUserId: "u_RT7-QeTWOwP4",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const owner = getTaskSummary(store.db, store.slug, "VIB-904")!.owner!;
    expect(owner.kind).toBe("human");
    expect(owner.name).not.toBe("u_RT7-QeTWOwP4");
    expect(owner.name).toContain("Removed account");
  });

  it("leaves a resolvable human untouched", () => {
    const store = setupTestStore(ctx);
    const render = labelUnresolvedHuman({
      kind: "human",
      userId: "u_arda",
      name: "Arda Test",
      initials: "AT",
      tone: "",
    });
    expect(render).toMatchObject({ name: "Arda Test", initials: "AT" });
    // (store is only created so the fixture cleanup path stays uniform)
    expect(store.slug).toBe("viberr-core");
  });
});
