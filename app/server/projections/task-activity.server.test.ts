import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { listProjectTasks } from "./board-query.server";
import { getTaskDetail } from "./task-query.server";
import { rebuildAll } from "./rebuilder.server";
import {
  isQuiet,
  QUIET_AFTER_AGENT_MS,
  QUIET_AFTER_HUMAN_MS,
  readProjectActivity,
} from "./task-activity.server";

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

/** A run row is 12 NOT NULL columns of ceremony; only state/task matter here. */
function insertRun(
  db: DatabaseSync,
  slug: string,
  taskKey: string,
  state: "queued" | "running" | "finished" | "error",
): void {
  db.prepare(
    `INSERT INTO agent_runs
       (id, task_key, project_slug, thread_id, role, kind, backend, model,
        state, created_at, updated_at, agent_profile_id)
     VALUES (?, ?, ?, ?, 'developer', 'primary', 'claude', 'opus',
             ?, ?, ?, 'developer')`,
  ).run(
    `run_${taskKey}_${state}`,
    taskKey,
    slug,
    `thread_${taskKey}_${state}`,
    state,
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function quietByKey(store: { db: DatabaseSync; dataRoot: string; slug: string }) {
  const tasks = listProjectTasks(store.db, store.slug, {
    includeArchived: true,
    now: NOW,
  });
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
    now: NOW,
  };

  it("flags an agent-waiting task after an hour of silence", () => {
    expect(
      isQuiet({
        ...base,
        waiting: "agent",
        lastActivityAt: ago(QUIET_AFTER_AGENT_MS + 1000),
      }),
    ).toBe(true);
    expect(
      isQuiet({
        ...base,
        waiting: "agent",
        lastActivityAt: ago(QUIET_AFTER_AGENT_MS - 1000),
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
        lastActivityAt: ago(QUIET_AFTER_HUMAN_MS + 1000),
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
    const detail = getTaskDetail(store.db, store.slug, "VIB-400", { now: NOW })!;
    expect(detail.lastActivityAt).toBe(ago(3 * 60 * 60_000));
    expect(detail.quiet).toBe(true);
  });
});
