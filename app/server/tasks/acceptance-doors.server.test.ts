import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { actorOf, baseTaskFrontmatter, writeTask, type TestStore } from "../../../test-support/test-store";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { listAuditEvents } from "../../../test-support/audit-log";
import { pollUntil } from "../../../test-support/polling";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { readEpicFile } from "~/server/files/epic-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { createEpic } from "./epic-actions.server";
import { resolvePacket } from "./packet-resolution.server";
import { acceptCompletion } from "./task-acceptance.server";
import type { TaskActionDeps } from "./task-action-core.server";

/**
 * Ruling 686: an acceptance does the same things whichever control a person
 * used. Two writes set a board's last stage, the shared acceptance write and
 * the decision packet's "accept completion" option, which writes the stage
 * itself. The option told no epic its last task was done, left the tasks
 * waiting on this one to the release runner's next tick, and let a run still
 * live on the task go on spending.
 *
 * The operator's hand-off and the controller's turn are the only things
 * stubbed, through the task doors' own seam: a real one starts a model. What
 * an acceptance does for a waiting controller conversation is
 * `controller-continuation.server.test.ts`'s, by the same two doors.
 */
const runOp = vi.fn<typeof runOperator>(async () => ({
  runId: null,
  queued: true,
  backend: "claude" as const,
  autonomy: "supervised" as const,
}));
const runControllerTurn = vi.fn<NonNullable<TaskActionDeps["runControllerTurn"]>>();

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupProjectedStore(ctx);
  deployDeliveryOperator(store, "supervised");
  runOp.mockClear();
});

afterEach(() => ctx.cleanup());

/** The decision an operator opens when a task is ready: accepting is one of its answers. */
const READY_PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "VIB-1 ready to accept",
  body: "",
  observations: [],
  options: [
    { kind: "request_edit", t: "Send back for one fix", d: "", rec: false },
    { kind: "accept_completion", t: "Accept VIB-1", d: "", rec: true },
  ],
};

const doorCtx = () => ({ dataRoot: store.dataRoot, deps: { runOperator: runOp, runControllerTurn } });
const task = (taskKey: string) =>
  readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })!.parsed;

/**
 * VIB-1 stands at Review with the decision open. It is the last open task of
 * an epic Murat leads, VIB-2 waits on it, and a developer's run is still
 * going on it.
 */
async function lastTaskOfAnEpic(): Promise<string> {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", ownerUserId: store.users.arda.id }),
    packet: READY_PACKET,
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "impl",
      waiting: "none",
      readiness: "blocked",
      heldAtStage: "impl",
      blockedBy: ["VIB-1"],
      ownerUserId: store.users.arda.id,
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl", ownerUserId: store.users.arda.id }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const { epic } = await createEpic(
    store.db,
    {
      projectSlug: store.slug,
      title: "Launch",
      status: "in_progress",
      leadUserId: store.users.murat.id,
      taskKeys: ["VIB-1", "VIB-3"],
    },
    actorOf(store.users.arda),
    { dataRoot: store.dataRoot },
  );
  // VIB-3 was finished by hand, so no hook has looked at the epic yet.
  await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-3", dataRoot: store.dataRoot }, (parsed) => {
    parsed.frontmatter.previousStageId = parsed.frontmatter.stage;
    parsed.frontmatter.stage = "done";
    parsed.frontmatter.waiting = "none";
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  upsertRun(store.db, {
    id: "run_live_dev",
    taskKey: "VIB-1",
    projectSlug: store.slug,
    threadId: "th-live-dev",
    role: "Implementation",
    kind: "primary",
    backend: "codex",
    agentProfileId: "developer",
    agentName: "Server Developer",
    model: "gpt-5.6-luna",
    sdk: "codex-sdk",
    state: "running",
    startedAt: new Date().toISOString(),
  });
  return epic.id;
}

describe("ruling 686: what follows an acceptance does not depend on the door", () => {
  /** The two writers of a board's last stage, as a person reaches each. */
  const doors: [string, () => Promise<void>][] = [
    [
      "the Accept button",
      async () => {
        await acceptCompletion(store.db, { projectSlug: store.slug, taskKey: "VIB-1" }, actorOf(store.users.arda), doorCtx());
      },
    ],
    [
      "the decision's accept option",
      async () => {
        await resolvePacket(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
          actorOf(store.users.arda),
          doorCtx(),
        );
      },
    ],
  ];

  it.each(doors)(
    "%s tells the epic its last task is done, releases the task that waited, and ends the run still live",
    async (_door, accept) => {
      const epicId = await lastTaskOfAnEpic();
      const epicHistory = () =>
        readEpicFile({ projectSlug: store.slug, epicId, dataRoot: store.dataRoot })!.parsed.timeline.map((entry) => entry.text);
      expect(epicHistory()).not.toContain("Every task is done (2 tasks).");

      await accept();
      expect(task("VIB-1").frontmatter.stage).toBe("done");

      // CANARY: run the epic's check from one writer only and an epic whose
      // last task was accepted from a decision is never told it is done: no
      // line in its history, and nothing sent to its lead.
      expect(await pollUntil(() => epicHistory()[0] === "Every task is done (2 tasks).")).toBe(true);
      const told = () =>
        store.db
          .prepare(`SELECT text FROM notifications WHERE user_id = ? AND kind = 'epic' AND text LIKE 'Every task in%'`)
          .all(store.users.murat.id)
          .map((row) => row.text);
      expect(await pollUntil(() => told().length > 0)).toBe(true);
      expect(told()).toEqual([
        `Every task in **${epicId}** (Launch) is done. Set the epic to Done once the work has landed.`,
      ]);

      // CANARY: leave the release to the runner's tick and the task that
      // waited stays held for up to a minute after the acceptance it waited for.
      // The note is the release's last write on the task.
      expect(
        await pollUntil(() => task("VIB-2").timeline.some((event) => event.title === "Dependencies released")),
      ).toBe(true);
      expect(task("VIB-2").frontmatter.blockedBy).toEqual([]);

      // CANARY: end live runs from the button only and a run goes on spending
      // on a task a person accepted from its decision.
      expect(store.db.prepare(`SELECT state, interrupted_by FROM agent_runs WHERE id = 'run_live_dev'`).get()).toEqual({
        state: "interrupted",
        interrupted_by: store.users.arda.id,
      });
      const note = task("VIB-1").timeline.find((event) => event.title === "Interrupted by acceptance");
      expect(note?.text).toContain("`run_live_dev` (Server Developer) was still live when VIB-1 was accepted");
      expect(listAuditEvents(store.db, { action: "task.acceptance.interrupted_runs" }).map((row) => row.details)).toEqual([
        { cause: "accept", runIds: ["run_live_dev"] },
      ]);
    },
  );

  it("does none of it for the decision's other answer, which is no acceptance", async () => {
    // CANARY: run what follows an acceptance for every answer and sending a
    // task back ends the run that was working on it.
    await lastTaskOfAnEpic();
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0, note: "Fix the footer." },
      actorOf(store.users.arda),
      doorCtx(),
    );
    // The answer is written and the operator handed the task: nothing else is on its way.
    expect(await pollUntil(() => runOp.mock.calls.length > 0)).toBe(true);
    expect(task("VIB-1").frontmatter.stage).not.toBe("done");
    expect(store.db.prepare(`SELECT state FROM agent_runs WHERE id = 'run_live_dev'`).get()).toEqual({ state: "running" });
    expect(task("VIB-1").timeline.some((event) => event.title === "Interrupted by acceptance")).toBe(false);
    expect(listAuditEvents(store.db, { action: "task.acceptance.interrupted_runs" })).toEqual([]);
  });
});
