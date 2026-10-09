import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { listProjectTasks } from "./board-query.server";
import { getTaskDetail } from "./task-query.server";
import { rebuildAll } from "./rebuilder.server";
import { isQuiet, readProjectActivity } from "./task-activity.server";

/**
 * Pass-19 gap 10 — nothing detected or displayed a task that quietly stopped
 * moving. These pin the two halves: the SIGNAL (which stamp counts as activity)
 * and the DETECTOR (when a task has gone quiet, and the four cases where it
 * must stay silent).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const NOW = new Date("2026-08-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** The two thresholds the module documents: an hour of silence while an agent
 *  is on the hook, three days while a person is. */
const AGENT_QUIET_MS = 60 * 60_000;
const HUMAN_QUIET_MS = 72 * 60 * 60_000;

// The quiet check reads the clock: every case asks it at NOW.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function event(occurredAt: string, text = "did a thing"): TaskFileEvent {
  return {
    occurredAt,
    type: "note",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

/** A run of the task in `state`, through the run store's own writer; only
 *  state and task matter here. */
function insertRun(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
  state: "queued" | "running" | "finished" | "error",
): void {
  upsertRun(db, {
    id: `run_${taskKey}_${state}`,
    taskKey,
    projectSlug: slug,
    threadId: `thread_${taskKey}_${state}`,
    role: "developer",
    kind: "primary",
    backend: "claude",
    model: "opus",
    sdk: "sdk",
    agentProfileId: "developer",
    state,
  });
}

function quietByKey(store: { db: DatabaseSync; dataRoot: string; slug: string }) {
  const tasks = listProjectTasks(store.db, store.slug, { includeArchived: true });
  return new Map(tasks.map((t) => [t.key, t]));
}

describe("the activity signal is the timeline, not the file-write stamp", () => {
  it("reads lastActivityAt from the newest task_events.occurred_at", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-100", { stage: "impl" }),
      timeline: [
        event(ago(2 * 60 * 60_000), "newest"),
        event(ago(9 * 60 * 60_000), "older"),
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const facts = readProjectActivity(store.db, store.slug);
    expect(facts.get("VIB-100")!.lastActivityAt).toBe(ago(2 * 60 * 60_000));
  });

  it("ignores updatedAt — a task file re-stamped by a background write is not activity", () => {
    const store = setupTestStore(ctx);
    // Exactly the shape the GitHub reconcile poller produces every 5 minutes on
    // any branched task: the FILE was rewritten seconds ago (a refreshed pr/
    // github cache), while nothing has happened on the task for four hours.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-101", {
        stage: "impl",
        waiting: "agent",
        updatedAt: ago(30_000),
      }),
      timeline: [event(ago(4 * 60 * 60_000))],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const task = quietByKey(store).get("VIB-101")!;
    // The projection still carries the file stamp — this is not about deleting
    // it, it is about which one the supervisor's surfaces read.
    expect(task.updatedAt).toBe(ago(30_000));
    expect(task.lastActivityAt).toBe(ago(4 * 60 * 60_000));
    expect(task.quiet).toBe(true);
  });
});

describe("isQuiet — the threshold follows who is on the hook", () => {
  const base = {
    archived: false,
    terminal: false,
    runInFlight: false,
    held: false,
  };

  it("flags an agent-waiting task after an hour of silence", () => {
    expect(
      isQuiet({
        ...base,
        waiting: "agent",
        lastActivityAt: ago(AGENT_QUIET_MS + 1000),
      }),
    ).toBe(true);
    expect(
      isQuiet({
        ...base,
        waiting: "agent",
        lastActivityAt: ago(AGENT_QUIET_MS - 1000),
      }),
    ).toBe(false);
  });

  /**
   * Ruling 45 (F37-45). A task resting on a clock is between two moves, on
   * purpose, and the gap can be hours — the agent threshold would light the
   * "no activity" cue on the healthiest wait there is. But a schedule that came
   * DUE and did not fire is a real stall (the runner is what broke), so the
   * idle clock restarts at the due instant instead of being switched off.
   */
  it("measures a clock rest from its due instant, not its last event", () => {
    // Silent for six hours, resuming in two: not quiet, whatever the timeline
    // says — the agent threshold is one hour.
    expect(
      isQuiet({
        ...base,
        waiting: "schedule",
        lastActivityAt: ago(6 * 60 * 60_000),
        resumesAt: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString(),
      }),
    ).toBe(false);

    // Due an hour ago and still sitting there: late, but a schedule runner is
    // allowed to be late. Only past the human threshold is it a stall.
    expect(
      isQuiet({
        ...base,
        waiting: "schedule",
        lastActivityAt: ago(6 * 60 * 60_000),
        resumesAt: ago(60 * 60_000),
      }),
    ).toBe(false);
    expect(
      isQuiet({
        ...base,
        waiting: "schedule",
        lastActivityAt: ago(6 * 60 * 60_000),
        resumesAt: ago(HUMAN_QUIET_MS + 1000),
      }),
    ).toBe(true);

    // No instant to measure against: say nothing rather than guess.
    expect(
      isQuiet({
        ...base,
        waiting: "schedule",
        lastActivityAt: ago(30 * 24 * 60 * 60_000),
        resumesAt: null,
      }),
    ).toBe(false);
  });

  it("leaves a human-waiting task alone overnight, and over a weekend", () => {
    // The explicit design constraint: a task waiting on a human overnight is
    // normal, and a Friday-evening decision picked up Monday morning (~60h) must
    // not fire either.
    for (const hours of [12, 24, 60]) {
      expect(
        isQuiet({
          ...base,
          waiting: "human",
          lastActivityAt: ago(hours * 60 * 60_000),
        }),
      ).toBe(false);
    }
    expect(
      isQuiet({
        ...base,
        waiting: "human",
        lastActivityAt: ago(HUMAN_QUIET_MS + 1000),
      }),
    ).toBe(true);
  });

  it("stays silent for an archived, terminal, running or never-started task", () => {
    const longAgo = ago(30 * 24 * 60 * 60_000);
    expect(
      isQuiet({ ...base, waiting: "agent", lastActivityAt: longAgo, archived: true }),
    ).toBe(false);
    expect(
      isQuiet({ ...base, waiting: "agent", lastActivityAt: longAgo, terminal: true }),
    ).toBe(false);
    expect(
      isQuiet({ ...base, waiting: "agent", lastActivityAt: longAgo, runInFlight: true }),
    ).toBe(false);
    // A task with an empty timeline never started — a backlog is not a stall.
    expect(isQuiet({ ...base, waiting: "agent", lastActivityAt: null })).toBe(false);
  });

  it("ruling 55: a task waiting on other work is held, never quiet", () => {
    // Canary: delete the `held` early return in `isQuiet`.
    const longAgo = ago(30 * 24 * 60 * 60_000);
    expect(isQuiet({ ...base, waiting: "none", lastActivityAt: longAgo, held: true })).toBe(false);
    expect(isQuiet({ ...base, waiting: "agent", lastActivityAt: longAgo, held: true })).toBe(false);
    expect(isQuiet({ ...base, waiting: "none", lastActivityAt: longAgo, held: false })).toBe(true);
  });
});

describe("listProjectTasks annotates the whole board", () => {
  function setup() {
    const store = setupTestStore(ctx);
    // Waiting on an agent, four hours of silence, nothing running → quiet.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-200", {
        stage: "impl",
        waiting: "agent",
      }),
      timeline: [event(ago(4 * 60 * 60_000))],
    });
    // Same silence, but a run is genuinely in flight → NOT quiet. A run can work
    // for an hour and report once at the end; the runtime's own idle guard owns
    // the "the run itself hung" case.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        stage: "impl",
        waiting: "agent",
      }),
      timeline: [event(ago(4 * 60 * 60_000))],
    });
    // Waiting on a human for four hours → normal, stays silent.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-202", {
        stage: "review",
        waiting: "human",
      }),
      timeline: [event(ago(4 * 60 * 60_000))],
    });
    // Archived, dead for a month → out of the flow, owes nobody anything.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-203", {
        stage: "impl",
        waiting: "agent",
        archived: true,
      }),
      timeline: [event(ago(30 * 24 * 60 * 60_000))],
    });
    // Terminal stage, dead for a month → accepted work is not waiting.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-204", {
        stage: "done",
        waiting: "none",
      }),
      timeline: [event(ago(30 * 24 * 60 * 60_000))],
    });
    // Created and never touched → a backlog item, not a stall.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-205", { stage: "triage" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    insertRun(store.db, store.slug, "VIB-201", "running");
    // A FINISHED run must not suppress the cue — that is the exact stranding
    // case (a run that ended and nobody re-engaged).
    insertRun(store.db, store.slug, "VIB-200", "finished");
    return store;
  }

  it("marks only the genuinely quiet task", () => {
    const store = setup();
    const byKey = quietByKey(store);
    expect(byKey.get("VIB-200")!.quiet).toBe(true);
    expect(byKey.get("VIB-201")!.quiet).toBe(false);
    expect(byKey.get("VIB-202")!.quiet).toBe(false);
    expect(byKey.get("VIB-203")!.quiet).toBe(false);
    expect(byKey.get("VIB-204")!.quiet).toBe(false);
    expect(byKey.get("VIB-205")!.quiet).toBe(false);
    expect(byKey.get("VIB-205")!.lastActivityAt).toBeNull();
  });

  it("a queued run also counts as in flight", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-300", {
        stage: "impl",
        waiting: "agent",
      }),
      timeline: [event(ago(4 * 60 * 60_000))],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    insertRun(store.db, store.slug, "VIB-300", "queued");
    expect(quietByKey(store).get("VIB-300")!.quiet).toBe(false);
  });

  it("ruling 55: a held task carries its resolved list and is never quiet, however long it waits", () => {
    // Canary: drop `held` from the board query's QuietCheck (VIB-301 reads
    // quiet), or resolve nothing (`blockedBy` reads empty).
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "done", waiting: "none" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        stage: "impl",
        waiting: "none",
        blockedBy: ["VIB-1", "VIB-999"],
      }),
      timeline: [event(ago(30 * 24 * 60 * 60_000))],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const held = quietByKey(store).get("VIB-301")!;
    expect(held.quiet).toBe(false);
    expect(held.readiness).toBe("blocked");
    expect(held.blockedBy.map((e) => [e.ref, e.state])).toEqual([
      ["VIB-1", "done"],
      ["VIB-999", "missing"],
    ]);
    expect(quietByKey(store).get("VIB-1")!.blockedBy).toEqual([]);
  });
});

describe("getTaskDetail carries the same two fields", () => {
  it("annotates the task page from the same predicate", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-400", {
        stage: "impl",
        waiting: "agent",
        updatedAt: ago(30_000),
      }),
      timeline: [event(ago(3 * 60 * 60_000))],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const detail = getTaskDetail(store.db, store.slug, "VIB-400")!;
    expect(detail.lastActivityAt).toBe(ago(3 * 60 * 60_000));
    expect(detail.quiet).toBe(true);
  });

  it("ruling 55: the task page carries the resolved list and a held task is not quiet", () => {
    // Canary: drop `held` from the detail query's QuietCheck.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-401", {
        stage: "impl",
        waiting: "none",
        blockedBy: ["VIB-77"],
      }),
      timeline: [event(ago(3 * 60 * 60_000))],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const detail = getTaskDetail(store.db, store.slug, "VIB-401")!;
    expect(detail.quiet).toBe(false);
    expect(detail.blockedBy).toEqual([
      { ref: "VIB-77", label: "VIB-77", state: "missing", taskKey: "VIB-77" },
    ]);
  });
});
