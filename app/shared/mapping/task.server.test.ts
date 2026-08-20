import { describe, expect, it } from "vitest";
import type { PrRef } from "~/schemas/task-file.schema";
import {
  isAtAcceptanceBoundary,
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
    archived: 0,
    validation: "healthy",
    validation_block_reason: null,
    acceptance: null,
    continuity: null,
    owner_user_id: null,
    specialist_json: null,
    reviewers_json: "[]",
    operator_json: null,
    branch: null,
    repo: null,
    pr_json: null,
    github_json: null,
    work_revision_sha: null,
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

/** The template graph: triage → ready → review → done. */
const WORKFLOW = [
  { from: "triage", to: "ready" },
  { from: "ready", to: "review" },
  { from: "review", to: "done" },
];

function summarize(
  r: TaskProjectionRow,
  accepted: boolean,
  workflow: { from: string; to: string }[] = WORKFLOW,
) {
  return mapTaskProjectionRow(r, {
    stages: STAGES,
    workflow,
    owner: null,
    accepted,
  });
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

describe("N20-14: acceptance fact surfaces on the summary", () => {
  it("carries a force-accept fact through to TaskSummary", () => {
    expect(summarize(row({ acceptance: "forced" }), true).acceptance).toBe("forced");
  });
  it("is null when the task was accepted the ordinary way", () => {
    expect(summarize(row({ acceptance: null }), true).acceptance).toBeNull();
  });
});

describe("ruling 53/88: the delivered revision surfaces on the summary", () => {
  it("carries the projected head sha through to TaskSummary", () => {
    // The board's acceptance ceremony discloses this row and echoes it back for
    // the server to compare against the live task — it can only do that if the
    // summary the board renders from carries the sha.
    expect(
      summarize(row({ work_revision_sha: "a".repeat(40) }), false)
        .workRevisionSha,
    ).toBe("a".repeat(40));
  });
  it("is null before delivery — the ceremony's honest-absence row", () => {
    expect(
      summarize(row({ work_revision_sha: null }), false).workRevisionSha,
    ).toBeNull();
  });
});

describe("D4: continuity fact surfaces on the summary", () => {
  it("carries the projected 'degraded' continuity through to TaskSummary", () => {
    expect(summarize(row({ continuity: "degraded" }), false).continuity).toBe(
      "degraded",
    );
  });
  it("is null when runtime continuity is healthy", () => {
    expect(summarize(row({ continuity: null }), false).continuity).toBeNull();
  });
});

describe("mapPrChecks / mapPrReview (P13-D-28)", () => {
  const pr = (patch: Partial<PrRef> = {}): PrRef => ({
    number: 7,
    state: "review",
    title: "PR",
    ...patch,
  });

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

  it("F21-7: runs nobody could read degrade to unknown — never to passing", () => {
    // The linker's own count (a drifted check-runs payload).
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 } }),
      ),
    ).toMatchObject({ state: "unknown", unknown: 3, total: 3 });
    // The belt: counters that do not add up to `total` are short by the
    // difference, whoever wrote them and whether or not they said so.
    expect(
      mapPrChecks(pr({ checks: { total: 3, passing: 1, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "unknown", unknown: 2 });
    // A drifted `unknown` on the loose persisted object is read tolerantly, and
    // the arithmetic still answers.
    expect(
      mapPrChecks(
        pr({ checks: { total: 2, passing: 0, failing: 0, pending: 0, unknown: "lots" } }),
      ),
    ).toMatchObject({ state: "unknown", unknown: 2 });
    // Real failures and real running checks still outrank it.
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 1, pending: 0, unknown: 2 } }),
      ),
    ).toMatchObject({ state: "failing" });
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 0, pending: 1, unknown: 2 } }),
      ),
    ).toMatchObject({ state: "pending" });
    // A complete, clean read is still green.
    expect(
      mapPrChecks(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "passing", unknown: 0 });
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

/**
 * F19-27 — the STAGE gate the task file cannot answer. `blockReason` covers the
 * closed-PR / revision / verdict / packet / conflicting-PR refusals; the one it
 * deliberately leaves out is `acceptanceStageBlockedReason`, which turns on the
 * PROJECT's workflow graph. Projected here so the board's accept dialog can
 * name it instead of letting the click reach a 409.
 */
describe("isAtAcceptanceBoundary mirrors the server's stage gate", () => {
  it("accepts from the stage with a declared edge into the terminal one", () => {
    expect(isAtAcceptanceBoundary("review", STAGES, WORKFLOW)).toBe(true);
  });

  it("refuses every stage the workflow puts before that boundary", () => {
    expect(isAtAcceptanceBoundary("triage", STAGES, WORKFLOW)).toBe(false);
    expect(isAtAcceptanceBoundary("ready", STAGES, WORKFLOW)).toBe(false);
  });

  it("honors a custom graph with a SECOND edge into the terminal stage", () => {
    // The server allows any declared edge into terminal, not just the resolved
    // review stage — refusing this would be the forked mapping rulings 12/14 ban.
    expect(
      isAtAcceptanceBoundary("ready", STAGES, [
        ...WORKFLOW,
        { from: "ready", to: "done" },
      ]),
    ).toBe(true);
  });

  it("falls back positionally when the project declares no edges at all", () => {
    // resolveStageRoles' own fallback: review = the stage before terminal.
    expect(isAtAcceptanceBoundary("review", STAGES, [])).toBe(true);
    expect(isAtAcceptanceBoundary("ready", STAGES, [])).toBe(false);
  });

  it("refuses nothing when the task is already terminal, or there are no stages", () => {
    // The writers' idempotent "already Done" return owns the first; a projected
    // `false` would put a refusal on a click the server accepts.
    expect(isAtAcceptanceBoundary("done", STAGES, WORKFLOW)).toBe(true);
    expect(isAtAcceptanceBoundary("review", [], [])).toBe(true);
  });

  it("threads onto the summary the board renders", () => {
    expect(summarize(row({ stage: "review" }), false).atAcceptanceBoundary).toBe(
      true,
    );
    expect(summarize(row({ stage: "triage" }), false).atAcceptanceBoundary).toBe(
      false,
    );
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
      sinceLabel: "since a removed stage",
    });
  });

  it("null ref maps to null", () => {
    expect(mapOperatorRef(null, STAGES)).toBeNull();
  });
});
