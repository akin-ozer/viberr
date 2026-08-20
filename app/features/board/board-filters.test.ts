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
  it('"risk" ("Blocked or waiting") = work that cannot proceed (contracts §2.3)', () => {
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
  });

  // R16-2 (owner ruling, live in pass 16): this filter matched 0 of 4 tasks on a
  // board that was drawing an amber "input required" chip on one of the cards.
  // This case asserted the OPPOSITE — that input_required is not attention-worthy
  // — which is what let the incoherence ship: the board flagged a state and then
  // hid it from its own filter. A task holding for a human answer cannot proceed,
  // which is exactly what the renamed chip promises.
  it('"risk" counts input_required — the state the board chips amber (R16-2)', () => {
    expect(
      matchesBoardFilter({ ...base, readiness: "input_required" }, "risk"),
    ).toBe(true);
    // …and it is not a blanket match: an ordinary in-flight task stays out.
    expect(
      matchesBoardFilter({ ...base, readiness: "in_review" }, "risk"),
    ).toBe(false);
    expect(matchesBoardFilter({ ...base, readiness: "ready" }, "risk")).toBe(false);
    // Archived still wins over every signal (R14-3).
    expect(
      matchesBoardFilter(
        { ...base, readiness: "input_required", archived: true },
        "risk",
      ),
    ).toBe(false);
  });

  // P14-WL-03: live, PST-5's PR was closed without merging — the review queue
  // filed it under "Decision required" and the board's own "Blocked or waiting"
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

  /** Gap-10: the board had no way to ask for the tasks that stopped moving. */
  it('"quiet" ("No activity") selects on the server-derived flag, and only that', () => {
    const quiet: FilterableTask = { ...base, quiet: true };
    expect(matchesBoardFilter(quiet, "quiet")).toBe(true);
    expect(matchesBoardFilter(base, "quiet")).toBe(false);
    // An ARCHIVED task never reaches the predicate — the same exclusion every
    // non-"archived" filter has (R14-3). Belt and braces: `isQuiet` refuses
    // archived tasks server-side too.
    expect(matchesBoardFilter({ ...quiet, archived: true }, "quiet")).toBe(false);
    // And going quiet is NOT folded into "Blocked or waiting": that filter
    // selects states the system asserted, this one an inference from an absence.
    expect(matchesBoardFilter(quiet, "risk")).toBe(false);
    expect(matchesBoardFilter(quiet, "all")).toBe(true);
    expect(isBoardFilterId("quiet")).toBe(true);
  });

  /** D4: "degraded continuity" existed only on the task page's Continuity
   *  Recovery panel; the board's default filters gained no way to ask for it. */
  it('"continuity" ("Degraded continuity") selects on the projected fact, and only that', () => {
    const degraded: FilterableTask = { ...base, continuity: "degraded" };
    expect(matchesBoardFilter(degraded, "continuity")).toBe(true);
    // A healthy task (null continuity) stays out — and so does the base fixture.
    expect(matchesBoardFilter(base, "continuity")).toBe(false);
    expect(
      matchesBoardFilter({ ...base, continuity: null }, "continuity"),
    ).toBe(false);
    // It is its OWN state, not folded into "Blocked or waiting": a task can lose
    // continuity while otherwise healthy (ready + validation none), and the risk
    // predicate must still not claim it.
    expect(matchesBoardFilter(degraded, "risk")).toBe(false);
    expect(matchesBoardFilter(degraded, "all")).toBe(true);
    // Archived wins the exclusion, like every non-"archived" filter (R14-3).
    expect(
      matchesBoardFilter({ ...degraded, archived: true }, "continuity"),
    ).toBe(false);
    expect(isBoardFilterId("continuity")).toBe(true);
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
      boardEmptyCopy({ total: 0, filterLabel: "Blocked or waiting", query: "x" }),
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

describe("boardEmptyCopy — the first empty board teaches (R15-10)", () => {
  const bare = "No tasks";
  const teach = "No tasks yet. Create one to start the flow";

  it("teaches ONCE on a project with no tasks: entry column only", () => {
    // The owner's call: five columns each saying "No tasks" is the one empty
    // state in the app that does not teach, and it is the first thing a new
    // user sees. One message, in the column where the first task lands.
    // Canary: drop `isEntryColumn` from the condition and the second
    // expectation starts teaching too — five messages again.
    expect(
      boardEmptyCopy({
        total: 0,
        filterLabel: null,
        query: "",
        boardTotal: 0,
        isEntryColumn: true,
      }),
    ).toBe(teach);
    expect(
      boardEmptyCopy({
        total: 0,
        filterLabel: null,
        query: "",
        boardTotal: 0,
        isEntryColumn: false,
      }),
    ).toBe(bare);
  });

  it("stops teaching the moment ANY task exists — P13-D-34 still holds", () => {
    // The ruling P13-D-34 protected is "do not repeat an explanation five times
    // beside real work". That is untouched: with even one task on the board, an
    // empty entry column is bare again.
    expect(
      boardEmptyCopy({
        total: 0,
        filterLabel: null,
        query: "",
        boardTotal: 1,
        isEntryColumn: true,
      }),
    ).toBe(bare);
  });

  it("never teaches when a filter or search is what emptied the column", () => {
    // The ordering must not let a teaching line pre-empt the "N tasks hidden
    // by …" explanation, which is strictly more informative.
    expect(
      boardEmptyCopy({
        total: 4,
        filterLabel: "Waiting on me",
        query: "",
        boardTotal: 0,
        isEntryColumn: true,
      }),
    ).toBe("All 4 tasks here are hidden by the “Waiting on me” filter.");
    expect(
      boardEmptyCopy({
        total: 4,
        filterLabel: null,
        query: "auth",
        boardTotal: 0,
        isEntryColumn: true,
      }),
    ).toBe("All 4 tasks here are hidden by the search “auth”.");
  });

  it("still teaches when the board's only tasks are ARCHIVED", () => {
    // Caught live, not by a test: DevOps Skills held exactly one archived task,
    // sitting in the entry column. `total` counts archived tasks, but
    // matchesBoardFilter hides them under every filter except "Archived" — so
    // the column rendered nothing, read as non-empty, and the board that most
    // needed the teaching line was the only board that never got it. The
    // decision is keyed on the board's LIVE count, and this column's own
    // archived-inclusive `total` must not veto it.
    // Canary: add `total === 0 &&` back to the condition.
    expect(
      boardEmptyCopy({
        total: 1,
        filterLabel: null,
        query: "",
        boardTotal: 0,
        isEntryColumn: true,
      }),
    ).toBe(teach);
    // …and a non-entry column with the same shape still stays bare.
    expect(
      boardEmptyCopy({
        total: 1,
        filterLabel: null,
        query: "",
        boardTotal: 0,
        isEntryColumn: false,
      }),
    ).toBe(bare);
  });

  it("omitting boardTotal keeps the pre-R15-10 bare behavior", () => {
    expect(
      boardEmptyCopy({ total: 0, filterLabel: null, query: "", isEntryColumn: true }),
    ).toBe(bare);
  });
});
