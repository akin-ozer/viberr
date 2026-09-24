import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { countFileWrites, countSql } from "../../../test-support/perf-counters";
import { pinPerfClock } from "../../../test-support/perf-clock";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import type { EmittedLine } from "./adapter.server";

/**
 * Ruling 454 (LIVE-10, SRV-8): the run sink's work per console line, paid on
 * the event loop every agent and every page share, once per streamed line.
 */

let app: AppTestContext;

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
});
afterAll(() => {
  vi.useRealTimers();
  app.cleanup();
});

function line(n: number, facts: EmittedLine["facts"] = {}): EmittedLine {
  return {
    raw: JSON.stringify({ type: "assistant", n }),
    display: { t: "09:00:00", ev: "text", tag: "assistant", text: `line ${n}` },
    facts,
    occurredAt: "2026-09-24T09:00:00.000Z",
  };
}

describe("run sink cost per line (ruling 454)", () => {
  it("LIVE-10/SRV-8: a line with no facts is one statement and no mkdir", async () => {
    const { upsertRun, listRunLines, getRun } = await import("./run-store.server");
    const { createRunSink } = await import("./run-sink.server");
    upsertRun(app.db, {
      id: "run_sinkperf",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      threadId: "thread_sinkperf",
      role: "developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "running",
    });
    const sink = createRunSink(app.db, {
      runId: "run_sinkperf",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      threadId: "thread_sinkperf",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "claude-opus-4-8",
      prompt: "go",
      workdir: app.dataRoot,
    });
    sink.line(line(0, { sessionId: "sess_1" })); // the first line opens the run's files

    const sql = countSql(app.db);
    const files = countFileWrites(app.dataRoot);
    for (let n = 1; n <= 10; n += 1) sink.line(line(n));
    const plain = sql.stop();
    const plainFiles = files.stop();

    const factsSql = countSql(app.db);
    sink.line(
      line(11, {
        usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 40, outputEstimated: true },
      }),
    );
    const withFacts = factsSql.stop();

    expectWithinBudget("writes:run-line-10.sql", plain.statements);
    expectWithinBudget("writes:run-line-10.commits", plain.commits);
    expectWithinBudget("writes:run-line-10.mkdirs", plainFiles.mkdirs.length);
    expectWithinBudget("writes:run-line-facts.commits", withFacts.commits);

    // Behaviour kept: every line is persisted, numbered in order, appended to
    // the raw .jsonl, and the facts reach the run row.
    expect(listRunLines(app.db, "run_sinkperf").map((l) => l.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(plainFiles.appends).toHaveLength(10);
    const row = getRun(app.db, "run_sinkperf")!;
    expect(row.session_id).toBe("sess_1");
    expect(row.input_tokens).toBe(120);
    expect(row.output_tokens).toBe(40);
  });
});
