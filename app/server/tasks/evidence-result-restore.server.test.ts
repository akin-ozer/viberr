import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { EvidenceRow, TaskFileEvent } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";
import { restoreCutEvidenceResults } from "./evidence-result-restore.server";

/**
 * Ruling 639: the old writer kept 39 characters of a result and an ellipsis,
 * and the task file was the row's only copy. Once at boot, a cut row takes the
 * words its run reported: the run of the same task and agent profile that
 * finished nearest before the event, when that run reported one result for the
 * row's label starting with what the file kept.
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

const KEY = "VIB-1";
const AT = "2026-10-02T20:09:25.274Z";
const STAMP = "2026-10-02T20:09:26.000Z";
const cut = (whole: string) => `${whole.slice(0, 39)}…`;

function writeVerdict(rows: EvidenceRow[], profileId = "estimate-judge") {
  const event: TaskFileEvent = {
    occurredAt: AT,
    type: "quality",
    actor: { kind: "agent", backend: "codex", profileId, roleHint: "Estimate Judge" },
    title: "Changes requested",
    text: "**Validation:** failing. Estimate Judge requested changes on the files delivered on this task.",
    toAgent: false,
    evidence: rows,
  };
  // The completion writes the agent's reply in the same millisecond, and the
  // file lists it first: the instant alone names two events.
  const reply: TaskFileEvent = {
    occurredAt: AT,
    type: "comment",
    actor: event.actor,
    title: null,
    text: "Reviewed the delivered files; findings in the verdict.",
    toAgent: false,
    evidence: null,
  };
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(KEY, { stage: "review", updatedAt: STAMP }),
    timeline: [reply, event],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function judgeRun(id: string, finishedAt: string, backend: "codex" | "claude" = "codex") {
  upsertRun(store.db, {
    id,
    projectSlug: store.slug,
    taskKey: KEY,
    threadId: id,
    role: "Reviewer",
    kind: "reviewer",
    agentProfileId: "estimate-judge",
    backend,
    model: backend === "codex" ? "gpt-6-luna" : "claude-sonnet-5",
    sdk: backend === "codex" ? "Codex SDK" : "Claude Agent SDK",
    state: "finished",
    startedAt: finishedAt,
    finishedAt,
  });
}

function logLine(runId: string, seq: number, raw: string) {
  insertRunLine(store.db, {
    runId,
    seq,
    occurredAt: AT,
    raw,
    display: { t: "1", ev: "text", tag: "agent_message", text: "" },
  });
}

/** A Codex run's final envelope: its text is the outcome JSON. */
function codexReport(runId: string, rows: { label: string; result: string; status: string }[]) {
  logLine(
    runId,
    1,
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_61", type: "agent_message", text: JSON.stringify({ relay: null, evidence: rows }) },
    }),
  );
}

/** A Claude run's `report_outcome` call. */
function claudeReport(runId: string, seq: number, rows: { label: string; result: string; status: string }[]) {
  logLine(
    runId,
    seq,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: `toolu_${seq}`, name: "mcp__viberr__report_outcome", input: { evidence: rows } }],
      },
    }),
  );
}

function rowsOnFile(): EvidenceRow[] {
  return readTaskFile({ projectSlug: store.slug, taskKey: KEY, dataRoot: store.dataRoot })!.parsed.timeline.find(
    (e) => e.evidence,
  )!.evidence!;
}

const projectedSchema = z.object({ evidence_json: z.string() });
const projectedRowsSchema = z.array(z.object({ label: z.string(), result: z.string(), status: z.string() }));

function projectedResults(): string[] {
  const row = projectedSchema.parse(
    store.db
      .prepare(`SELECT evidence_json FROM task_events WHERE project_slug = ? AND task_key = ? AND evidence_json IS NOT NULL`)
      .get(store.slug, KEY),
  );
  return projectedRowsSchema.parse(JSON.parse(row.evidence_json)).map((r) => r.result);
}

describe("restoreCutEvidenceResults (ruling 639)", () => {
  const WHY =
    "The proposed pay-as-you-go default lists the old tier price and leaves the flat-rate plan out of the totals.";

  it("restores a cut result from the run that wrote it, keeping the task's stamp", async () => {
    writeVerdict([
      { label: "questions.md Q35", result: cut(WHY), status: "fail" },
      { label: "npm test (vitest)", result: "102 passed, 0 failed", status: "pass" },
    ]);
    // An older run reported the label too; the nearest one wrote the event.
    judgeRun("run_old", "2026-10-02T20:01:00.000Z");
    codexReport("run_old", [
      { label: "questions.md Q35", result: `${WHY.slice(0, 39)} as asked in round six, not now.`, status: "fail" },
    ]);
    judgeRun("run_judge", "2026-10-02T20:08:50.000Z");
    codexReport("run_judge", [
      { label: "questions.md Q35", result: WHY, status: "fail" },
      { label: "npm test (vitest)", result: "102 passed, 0 failed", status: "pass" },
    ]);

    // CANARY: find the event by its instant alone and the reply, listed first,
    // is taken for it: nothing is restored (live, 121 rows on the first boot).
    expect(await restoreCutEvidenceResults(store.db, { dataRoot: store.dataRoot })).toBe(1);
    // CANARY: take the farthest run instead of the nearest and Q35 reads the
    // round-six sentence.
    expect(rowsOnFile()).toEqual([
      { label: "questions.md Q35", result: WHY, status: "fail" },
      { label: "npm test (vitest)", result: "102 passed, 0 failed", status: "pass" },
    ]);
    expect(projectedResults()[0]).toBe(WHY);
    // CANARY: drop `stamp: false` and every old task reads as changed today.
    expect(
      readTaskFile({ projectSlug: store.slug, taskKey: KEY, dataRoot: store.dataRoot })!.parsed.frontmatter.updatedAt,
    ).toBe(STAMP);
    // A restored row is no longer cut, so the next boot leaves the file be.
    expect(await restoreCutEvidenceResults(store.db, { dataRoot: store.dataRoot })).toBe(0);
  });

  it("reads a Claude run's report_outcome, and leaves a row its run reported two ways", async () => {
    const LOG = "The read-only estimate opened and its eight service totals match summary.md line for line.";
    writeVerdict([
      { label: "questions.md Q35", result: cut(WHY), status: "fail" },
      { label: "calculator link", result: cut(LOG), status: "pass" },
    ]);
    judgeRun("run_claude", "2026-10-02T20:09:00.000Z", "claude");
    claudeReport("run_claude", 1, [
      { label: "questions.md Q35", result: WHY, status: "fail" },
      { label: "calculator link", result: LOG, status: "pass" },
    ]);
    claudeReport("run_claude", 2, [
      { label: "questions.md Q35", result: `${WHY.slice(0, 39)} as revised after the second read.`, status: "fail" },
    ]);

    // CANARY: restore the first sentence found and Q35 reads one of two.
    expect(await restoreCutEvidenceResults(store.db, { dataRoot: store.dataRoot })).toBe(1);
    expect(rowsOnFile()).toEqual([
      { label: "questions.md Q35", result: cut(WHY), status: "fail" },
      { label: "calculator link", result: LOG, status: "pass" },
    ]);
  });
});
