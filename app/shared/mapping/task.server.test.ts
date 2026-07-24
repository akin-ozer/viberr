import { describe, expect, it } from "vitest";
import {
  mapOperatorRef,
  mapPrChecks,
  mapPrReview,
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
    validation_block_reason: null,
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

describe("mapPrChecks / mapPrReview (P13-D-28)", () => {
  const pr = (patch: Record<string, unknown> = {}) =>
    ({ number: 7, state: "review", title: "PR", ...patch }) as never;

  it("rolls check-runs up to failing > pending > passing", () => {
    expect(
      mapPrChecks(pr({ checks: { total: 4, passing: 2, failing: 1, pending: 1 } })),
    ).toMatchObject({ state: "failing", failing: 1, total: 4 });
    expect(
      mapPrChecks(pr({ checks: { total: 3, passing: 2, failing: 0, pending: 1 } })),
    ).toMatchObject({ state: "pending" });
    expect(
      mapPrChecks(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "passing" });
  });

  it("null when there is nothing honest to draw", () => {
    expect(mapPrChecks(null)).toBeNull();
    // Never read (the key is absent) is NOT "green".
    expect(mapPrChecks(pr())).toBeNull();
    // A repo with no CI must not render a passing pill off zero checks.
    expect(
      mapPrChecks(pr({ checks: { total: 0, passing: 0, failing: 0, pending: 0 } })),
    ).toBeNull();
  });

  it("the review verdict only shows while the PR is open or merge-pending", () => {
    expect(mapPrReview(pr({ review: "changes_requested" }))).toBe("changes_requested");
    expect(mapPrReview(pr({ state: "accepted", review: "approved" }))).toBe("approved");
    // Stale by construction next to a merged/closed PR pill.
    expect(mapPrReview(pr({ state: "merged", review: "approved" }))).toBeNull();
    expect(mapPrReview(pr({ state: "closed", review: "review_required" }))).toBeNull();
    expect(mapPrReview(pr())).toBeNull();
    expect(mapPrReview(null)).toBeNull();
  });

  it("mapTaskProjectionRow threads both onto the summary the UI renders", () => {
    const summary = summarize(
      row({
        pr_json: JSON.stringify({
          number: 318,
          state: "review",
          title: "PR",
          checks: { total: 3, passing: 1, failing: 2, pending: 0 },
          review: "changes_requested",
        }),
      }),
      false,
    );
    expect(summary.prChecks).toMatchObject({ state: "failing", failing: 2, total: 3 });
    expect(summary.prReview).toBe("changes_requested");
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
