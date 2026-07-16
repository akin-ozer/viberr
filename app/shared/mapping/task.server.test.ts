import { describe, expect, it } from "vitest";
import {
  mapOperatorRef,
  mapTaskProjectionRow,
  type TaskProjectionRow,
} from "./task.server";

/** Minimal valid projection row — tests patch what they assert on. */
function row(patch: Partial<TaskProjectionRow> = {}): TaskProjectionRow {
  return {
    project_slug: "viberr-core",
    task_key: "VIB-1",
    title: "A task",
    stage: "review",
    readiness: "ready",
    stored_readiness: "ready",
    waiting: "human",
    urgent: 0,
    validation: "healthy",
    owner_user_id: null,
    specialist_json: null,
    reviewers_json: "[]",
    operator_json: null,
    branch: null,
    repo: null,
    pr_json: null,
    github_json: null,
    goal: "",
    packet_json: null,
    recommendation_count: 0,
    event_count: 0,
    comment_count: 0,
    diagnostic_count: 0,
    created_at: null,
    updated_at: null,
    board_rank: null,
    source_path: "projects/viberr-core/tasks/VIB-1/task.md",
    content_hash: "h",
    parsed_at: "2026-07-16T00:00:00.000Z",
    ...patch,
  };
}

const STAGES = [
  { id: "triage", name: "Triage" },
  { id: "ready", name: "Ready" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];

function summarize(r: TaskProjectionRow, accepted: boolean) {
  return mapTaskProjectionRow(r, { stages: STAGES, owner: null, accepted });
}

describe("displayReadiness derivation (F7-UI3)", () => {
  it("non-terminal tasks pass raw readiness through", () => {
    expect(summarize(row({ readiness: "blocked" }), false).displayReadiness).toBe(
      "blocked",
    );
  });

  it('accepted + PR still merge-pending → "accepted"', () => {
    const r = row({
      stage: "done",
      pr_json: JSON.stringify({ number: 7, state: "accepted", title: "PR" }),
    });
    expect(summarize(r, true).displayReadiness).toBe("accepted");
  });

  it('accepted with no linked PR → "accepted"', () => {
    expect(summarize(row({ stage: "done" }), true).displayReadiness).toBe(
      "accepted",
    );
  });

  it('accepted + PR really merged → "merged", never a stale "accepted"', () => {
    const r = row({
      stage: "done",
      pr_json: JSON.stringify({ number: 7, state: "merged", title: "PR" }),
    });
    expect(summarize(r, true).displayReadiness).toBe("merged");
  });

  it("a merged PR on a NON-terminal task does not flip the pill", () => {
    const r = row({
      readiness: "ready",
      pr_json: JSON.stringify({ number: 7, state: "merged", title: "PR" }),
    });
    expect(summarize(r, false).displayReadiness).toBe("ready");
  });
});

describe("mapOperatorRef sinceLabel (F7-UI2)", () => {
  it("renders the real stage NAME, not an index", () => {
    expect(mapOperatorRef({ assignedAtStageId: "ready" }, STAGES)).toEqual({
      name: "Operator",
      assignedAtStageId: "ready",
      sinceStageIndex: 2,
      sinceLabel: "since Ready",
    });
  });

  it("an unknown/removed stage id renders an honest dash", () => {
    expect(mapOperatorRef({ assignedAtStageId: "ghost" }, STAGES)).toMatchObject({
      sinceStageIndex: null,
      sinceLabel: "since —",
    });
  });

  it("null ref maps to null", () => {
    expect(mapOperatorRef(null, STAGES)).toBeNull();
  });
});
