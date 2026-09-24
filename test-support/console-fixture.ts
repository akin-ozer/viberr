import type { DatabaseSync } from "node:sqlite";
import type { LogLine, RunKind } from "~/features/runtime/runtime-types";

/**
 * Ruling 457, journeys `task-open` and `live-run`: the enlarged console the
 * console ratchets measure on. Three agent groups on one task, the way a long
 * task accumulates them, each line carrying a unique display text of about
 * 560 characters and a stored envelope of about 1.3 KB (the measured ratio of
 * a real Claude console, where tool output dominates the raw envelope):
 *
 *   - the operator: 2 finished runs of 150 lines;
 *   - the developer: 3 runs of 150 lines, the newest RUNNING, the second
 *     ending in a `session_missing` marker (a continuity reset);
 *   - the reviewer: 1 finished run of 120 lines.
 *
 * 870 stored lines; every group's window is bound by the 384 KB byte budget.
 */

export interface ConsoleFixtureRun {
  id: string;
  threadId: string;
  lines: number;
  state: "finished" | "running";
}

export interface ConsoleFixtureGroup {
  profileId: string;
  kind: RunKind;
  role: string;
  runs: ConsoleFixtureRun[];
}

export const CONSOLE_FIXTURE: ConsoleFixtureGroup[] = [
  {
    profileId: "operator",
    kind: "operator",
    role: "Operator",
    runs: [
      { id: "run_op_1", threadId: "op", lines: 150, state: "finished" },
      { id: "run_op_2", threadId: "op-r1", lines: 150, state: "finished" },
    ],
  },
  {
    profileId: "developer",
    kind: "primary",
    role: "Primary specialist",
    runs: [
      { id: "run_dev_1", threadId: "primary", lines: 150, state: "finished" },
      { id: "run_dev_2", threadId: "primary-r1", lines: 150, state: "finished" },
      { id: "run_dev_3", threadId: "primary-r2", lines: 150, state: "running" },
    ],
  },
  {
    profileId: "reviewer",
    kind: "reviewer",
    role: "Reviewer",
    runs: [{ id: "run_rev_1", threadId: "c0", lines: 120, state: "finished" }],
  },
];

/** The dead provider session the developer's second run records. */
export const DEAD_SESSION_ID = "sess-dead-0001";

/** One stored console line: its display projection and its wire envelope. */
export interface FixtureLine {
  display: LogLine;
  raw: string;
}

/** The console lines a fixture run carries, oldest first. */
export function fixtureLine(runId: string, seq: number): FixtureLine {
  const text =
    `${runId} line ${seq}: ` +
    "Reading the repository layout and the failing test before changing anything. ".repeat(7);
  const display: LogLine = {
    t: `10:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`,
    ev: "text",
    tag: "assistant",
    text,
  };
  const raw = JSON.stringify({
    type: "assistant",
    message: { id: `${runId}-${seq}`, content: [{ type: "text", text }] },
    tool_output: "x".repeat(700),
  });
  return { display, raw };
}

/** Writes the fixture's runs and lines onto `projectSlug/taskKey`. */
export async function seedConsoleFixture(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  const { insertRunLine, upsertRun } = await import("~/server/runtimes/run-store.server");
  for (const group of CONSOLE_FIXTURE) {
    for (const run of group.runs) {
      upsertRun(db, {
        id: run.id,
        projectSlug,
        taskKey,
        threadId: run.threadId,
        role: group.role,
        kind: group.kind,
        backend: "claude",
        model: "claude-sonnet-4-5",
        sdk: "Claude Agent SDK",
        state: run.state,
        agentName: group.profileId,
        agentProfileId: group.profileId,
        startedAt: "2026-09-24T10:00:00.000Z",
        finishedAt: run.state === "finished" ? "2026-09-24T10:30:00.000Z" : null,
        phase: run.state === "running" ? "Implementing" : null,
        step: run.state === "running" ? "Bash · npm test" : null,
        turns: 3,
        inputTokens: 1200,
        outputTokens: 300,
        sessionId: `sess-${run.id}`,
      });
      for (let seq = 0; seq < run.lines; seq++) {
        const marker = run.id === "run_dev_2" && seq === run.lines - 1;
        const { display, raw }: FixtureLine = marker
          ? {
              display: {
                t: "10:29:59",
                ev: "err" as const,
                tag: "run·session_missing",
                text: "The Claude session was not found; starting fresh from the task record.",
              },
              raw: JSON.stringify({
                type: "error",
                source: "viberr",
                reason: "session_missing",
                session_id: DEAD_SESSION_ID,
                message: "The Claude session was not found.",
              }),
            }
          : fixtureLine(run.id, seq);
        insertRunLine(db, {
          runId: run.id,
          seq,
          occurredAt: `2026-09-24T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
          raw,
          display,
        });
      }
    }
  }
}
