import { describe, expect, it } from "vitest";
import {
  boardEmptyCopy,
  matchesBoardFilter,
  matchesSearch,
  shortBranch,
  type FilterableTask,
  type SearchableTask,
} from "./board-filters";

const base: FilterableTask = {
  waiting: "none",
  readiness: "ready",
  validation: "none",
  urgent: false,
};

describe("matchesBoardFilter", () => {
  it('"all" matches everything', () => {
    expect(matchesBoardFilter(base, "all")).toBe(true);
  });
  it('"human" filter is member-scoped (R8-3: waitingOnMe, not the waiting enum)', () => {
    // A human-waiting task the viewer CAN'T act on is not "waiting on me".
    expect(matchesBoardFilter({ ...base, waiting: "human", waitingOnMe: false }, "human")).toBe(false);
    // Only when the loader marks it as the viewer's decision.
    expect(matchesBoardFilter({ ...base, waiting: "human", waitingOnMe: true }, "human")).toBe(true);
    // The "agent" filter still keys off the waiting enum.
    expect(matchesBoardFilter({ ...base, waiting: "agent" }, "human")).toBe(false);
    expect(matchesBoardFilter({ ...base, waiting: "agent" }, "agent")).toBe(true);
  });
  it('"risk" = canonical risk/blocked readiness OR failing validation OR urgent (contracts §2.3)', () => {
    expect(
      matchesBoardFilter(
        { ...base, readiness: "inconsistency_risk_detected" },
        "risk",
      ),
    ).toBe(true);
    expect(matchesBoardFilter({ ...base, readiness: "blocked" }, "risk")).toBe(true);
    expect(matchesBoardFilter({ ...base, validation: "failing" }, "risk")).toBe(true);
    expect(matchesBoardFilter({ ...base, urgent: true }, "risk")).toBe(true);
    expect(matchesBoardFilter(base, "risk")).toBe(false);
    // input_required is NOT "needs attention"
    expect(
      matchesBoardFilter({ ...base, readiness: "input_required" }, "risk"),
    ).toBe(false);
  });
});

const task: SearchableTask = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  branch: "vib-142-attach-workspace",
  owner: { name: "Arda Kaya" },
  specialist: { name: "Codex", role: "Developer" },
  reviewers: [{ name: "Claude Code", role: "Reviewer" }],
  operator: { name: "Operator" },
};

describe("matchesSearch", () => {
  it("empty query matches", () => {
    expect(matchesSearch(task, "")).toBe(true);
    expect(matchesSearch(task, "   ")).toBe(true);
  });
  it("matches key, title, branch case-insensitively", () => {
    expect(matchesSearch(task, "vib-142")).toBe(true);
    expect(matchesSearch(task, "WORKSPACE")).toBe(true);
    expect(matchesSearch(task, "attach-work")).toBe(true);
  });
  it("matches agents and owner", () => {
    expect(matchesSearch(task, "codex")).toBe(true);
    expect(matchesSearch(task, "claude")).toBe(true);
    expect(matchesSearch(task, "arda")).toBe(true);
    expect(matchesSearch(task, "operator")).toBe(true);
  });
  it("misses unrelated text", () => {
    expect(matchesSearch(task, "billing")).toBe(false);
  });
});

describe("shortBranch", () => {
  it("keeps ≤16 chars, truncates to 15 + ellipsis beyond", () => {
    expect(shortBranch("main")).toBe("main");
    expect(shortBranch("1234567890123456")).toBe("1234567890123456");
    expect(shortBranch("vib-142-attach-workspace")).toBe("vib-142-attach-…");
  });
});

describe("boardEmptyCopy (P13-D-34)", () => {
  it("keeps the bare copy when the column really is empty", () => {
    expect(
      boardEmptyCopy({ total: 0, filterLabel: "Needs attention", query: "x" }),
    ).toBe("No tasks");
  });

  it("names the filter, the search, or both", () => {
    expect(
      boardEmptyCopy({ total: 4, filterLabel: "Waiting on me", query: "" }),
    ).toBe("All 4 tasks here are hidden by the “Waiting on me” filter.");
    expect(boardEmptyCopy({ total: 1, filterLabel: null, query: "auth" })).toBe(
      "The 1 task here is hidden by the search “auth”.",
    );
    expect(
      boardEmptyCopy({ total: 2, filterLabel: "Agent working", query: "auth" }),
    ).toBe(
      "All 2 tasks here are hidden by the “Agent working” filter and the search “auth”.",
    );
  });

  it("treats a whitespace-only query as no search", () => {
    expect(boardEmptyCopy({ total: 3, filterLabel: null, query: "   " })).toBe(
      "No tasks",
    );
  });
});
