import { describe, expect, it } from "vitest";
import {
  boardEmptyCopy,
  countArchived,
  isArchived,
  isBoardFilterId,
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

  // P14-WL-03: live, PST-5's PR was closed without merging — the review queue
  // filed it under "Decision required" and the board's own "Needs attention"
  // filter hid it, because a rejected PR leaves readiness `in_review`,
  // validation healthy and urgent off. None of the four old signals fire.
  it('"risk" counts a PR closed without merging — the review queue calls it a decision', () => {
    const rejected: FilterableTask = {
      ...base,
      readiness: "in_review",
      validation: "healthy",
      pr: { state: "closed" },
    };
    expect(matchesBoardFilter(rejected, "risk")).toBe(true);
    // Every other PR state is ordinary progress, not an alarm.
    for (const state of ["review", "accepted", "merged", "draft"]) {
      expect(
        matchesBoardFilter({ ...rejected, pr: { state } }, "risk"),
      ).toBe(false);
    }
  });

  // R14-3: the archive is a disposition, so archived tasks leave every view
  // except the one that exists to find them again.
  it("archived tasks are excluded from every filter but Archived", () => {
    const archived: FilterableTask = {
      ...base,
      archived: true,
      waiting: "human",
      waitingOnMe: true,
      readiness: "blocked",
      urgent: true,
    };
    expect(matchesBoardFilter(archived, "all")).toBe(false);
    expect(matchesBoardFilter(archived, "human")).toBe(false);
    expect(matchesBoardFilter(archived, "risk")).toBe(false);
    expect(matchesBoardFilter(archived, "archived")).toBe(true);
    // …and a live task never shows up under Archived.
    expect(matchesBoardFilter(base, "archived")).toBe(false);
    expect(isArchived(archived)).toBe(true);
    expect(isArchived(base)).toBe(false);
    expect(countArchived([base, archived, { ...base, archived: true }])).toBe(2);
  });

  it("accepts 'archived' as a URL filter id", () => {
    expect(isBoardFilterId("archived")).toBe(true);
    expect(isBoardFilterId("nonsense")).toBe(false);
  });
});

const task: SearchableTask = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  branch: "vib-142-attach-workspace",
  owner: { name: "Arda Kaya" },
  specialist: { name: "Codex", role: "Developer", profileId: "docs-writer" },
  reviewers: [
    { name: "Claude Code", role: "Reviewer", profileId: "senior-reviewer" },
  ],
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
  // F15-16: `AgentRender.name` is the BACKEND label, so the only thing on a
  // card that carries an agent's own identity is its profile id. Typing the
  // deployment's name used to match nothing while the box promised agents.
  it("matches an assigned/engaged agent by its profile name", () => {
    expect(matchesSearch(task, "docs-writer")).toBe(true);
    expect(matchesSearch(task, "docs writer")).toBe(true);
    expect(matchesSearch(task, "senior reviewer")).toBe(true);
  });
  it("misses unrelated text", () => {
    expect(matchesSearch(task, "billing")).toBe(false);
    expect(matchesSearch(task, "junior-reviewer")).toBe(false);
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
