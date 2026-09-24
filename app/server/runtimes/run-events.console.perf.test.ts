import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectSseClient,
  resetSseBrokerForTests,
  type SseScope,
} from "~/server/events/sse-broker.server";
import { publishRunLogAppended } from "./run-events.server";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";

/**
 * Ruling 454, journey `live-run` (LIVE-5): which open tabs a console line
 * reaches. The sink publishes one `run.log-appended` reference per line; the
 * only thing that reads it is the console of the page showing THAT task.
 *
 * Fixture: two connections as the browser opens them, a board tab (the
 * workspace layout's `project:` + `user`) and a task tab (the same plus the
 * open task's `task:` scope), and ten lines of one run on that task.
 */

function connect(scopes: SseScope[]) {
  const writes: string[] = [];
  connectSseClient({ userId: "u_watcher", scopes, lastEventId: null, write: (c) => void writes.push(c) });
  return {
    frames: (name: string) =>
      writes
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line === `event: ${name}`).length,
  };
}

beforeEach(() => resetSseBrokerForTests());
afterEach(() => resetSseBrokerForTests());

describe("run-line frames per open tab (ruling 454)", () => {
  it("reaches the task's own page and no board", () => {
    const board = connect([{ kind: "project", slug: "viberr-core" }, { kind: "user" }]);
    const taskTab = connect([
      { kind: "project", slug: "viberr-core" },
      { kind: "task", slug: "viberr-core", key: "VIB-42" },
      { kind: "user" },
    ]);
    const LINES = 10;
    for (let seq = 0; seq < LINES; seq++) {
      publishRunLogAppended({
        projectSlug: "viberr-core",
        taskKey: "VIB-42",
        runId: "run_9",
        threadId: "primary",
        seq,
      });
    }
    // The watching page receives every line exactly once per connection.
    expect(taskTab.frames("run.log-appended")).toBe(LINES);
    expectWithinBudget("console:sse.run-line-frames-per-line-task-tab", taskTab.frames("run.log-appended") / LINES);
    expectWithinBudget("console:sse.run-line-frames-per-line-board-tab", board.frames("run.log-appended") / LINES);
  });
});
