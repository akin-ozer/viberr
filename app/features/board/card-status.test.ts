import { describe, expect, it } from "vitest";
import type { BoardCard } from "./board-card";
import { cardProblems, cardStatus, PROBLEM_CAP } from "./card-status";

/**
 * Ruling 365: the board card's one status seat and its problem chips, decided
 * here and drawn by the card and the list row alike. These pin the seat rules
 * that used to be `readinessYields` (rulings 168(a), 225, 349, R21-8) and the
 * problem order the fold counts against.
 */

/** A board card (ruling 457, BOARD-3: the board ships these, not the whole
 *  task summary). */
function task(patch: Partial<BoardCard> = {}): BoardCard {
  return {
    projectSlug: "viberr-core",
    key: "VIB-1",
    title: "t",
    stage: "impl",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "none",
    urgent: false,
    labels: [],
    archived: false,
    validation: "none",
    blockReason: null,
    atAcceptanceBoundary: true,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    pr: null,
    prChecks: null,
    prReview: null,
    packet: null,
    continuity: null,
    quiet: false,
    epicId: null,
    ...patch,
  };
}

describe("cardStatus: the wait takes the seat, else the readiness word", () => {
  it("an agent at work is the pulse, queued is the ring (ruling 349)", () => {
    expect(cardStatus(task({ waiting: "agent", liveRun: "running", displayReadiness: "agent_working" })))
      .toEqual({ kind: "agent", label: "agent working", icon: null });
    expect(cardStatus(task({ waiting: "agent", liveRun: "queued", displayReadiness: "agent_queued" })))
      .toEqual({ kind: "queued", label: "agent queued", icon: "ring" });
  });

  it("a human wait names the viewer only when the decision is theirs (R8-3)", () => {
    expect(cardStatus(task({ waiting: "human", waitingOnMe: true })))
      .toEqual({ kind: "you", label: "waiting on you", icon: "hand" });
    expect(cardStatus(task({ waiting: "human", waitingOnMe: false })))
      .toEqual({ kind: "human", label: "waiting on a human", icon: "hand" });
  });

  it("a clock rest carries its instant, or the honest absence of one (ruling 225)", () => {
    expect(cardStatus(task({ waiting: "schedule", resumesAt: "2026-09-21T02:30:00.000Z" })))
      .toEqual({ kind: "scheduled", label: "resumes", icon: "clock", resumesAt: "2026-09-21T02:30:00.000Z" });
    expect(cardStatus(task({ waiting: "schedule", resumesAt: null }))!.resumesAt).toBeNull();
  });

  it.each([
    ["ready", "ready", "ready"],
    ["input_required", "input", "input required"],
    ["goal_edit_pending", "input", "goal edit pending"],
    ["blocked", "blocked", "blocked"],
    ["accepted", "done", "accepted"],
    ["merged", "done", "merged"],
  ] as const)("readiness %s is the %s seat when nobody is waited on", (r, kind, label) => {
    const s = cardStatus(task({ displayReadiness: r }))!;
    expect(s.kind).toBe(kind);
    expect(s.label).toBe(label);
  });

  it("a demand yields to the wait that says who is asked (ruling 168(a), R21-8)", () => {
    for (const r of ["ready", "input_required", "goal_edit_pending", "blocked"] as const) {
      expect(cardStatus(task({ displayReadiness: r, waiting: "human", waitingOnMe: true }))!.kind).toBe("you");
      expect(cardStatus(task({ displayReadiness: r, waiting: "agent", liveRun: "running" }))!.kind).toBe("agent");
      expect(cardStatus(task({ displayReadiness: r, waiting: "schedule" }))!.kind).toBe("scheduled");
    }
  });

  it("an inconsistency risk is a problem, never the seat", () => {
    expect(cardStatus(task({ displayReadiness: "inconsistency_risk_detected" }))).toBeNull();
    expect(cardProblems(task({ displayReadiness: "inconsistency_risk_detected" })).map((p) => p.key)).toEqual(["risk"]);
  });

  it("an unknown value never greenwashes (C12)", () => {
    // SAFETY: the point of the case is a value outside the enum reaching the card.
    const s = cardStatus(task({ displayReadiness: "on_track" as BoardCard["displayReadiness"] }))!;
    expect(s).toEqual({ kind: "unknown", label: "unknown", icon: "activity" });
  });

  it("an archived card says archived and nothing else (F19-8)", () => {
    const t = task({ archived: true, waiting: "human", waitingOnMe: true, validation: "failing", continuity: "degraded" });
    expect(cardStatus(t)).toEqual({ kind: "archived", label: "archived", icon: "lock" });
    expect(cardProblems(t)).toEqual([]);
  });
});

describe("cardProblems: everything wrong, most severe first", () => {
  it("orders failures before demands and keeps the vocabulary's words", () => {
    const stormy = task({
      displayReadiness: "inconsistency_risk_detected",
      validation: "failing",
      prChecks: { total: 5, passing: 3, failing: 2, pending: 0, state: "failing" },
      prReview: "changes_requested",
      pr: { number: 9, state: "closed", title: "t" },
      continuity: "degraded",
    });
    expect(cardProblems(stormy).map((p) => [p.key, p.label])).toEqual([
      ["validation", "validation failing"],
      ["checks", "2/5 checks failing"],
      ["review", "changes requested"],
      ["closed", "closed"],
      ["risk", "inconsistency risk"],
      ["continuity", "degraded continuity"],
    ]);
    expect(PROBLEM_CAP).toBe(2);
  });

  it("a hold beside a working agent is an amber chip; beside a human wait it is absorbed (ruling 168(a))", () => {
    const working = task({ displayReadiness: "blocked", waiting: "agent", liveRun: "running" });
    expect(cardProblems(working)).toEqual([{ key: "blocked", label: "blocked", icon: "ban", tone: "amber" }]);
    expect(cardProblems(task({ displayReadiness: "blocked", waiting: "human", waitingOnMe: true }))).toEqual([]);
  });

  it("merge pending is amber, and the only chip a clean accepted card carries (R16-6)", () => {
    const accepted = task({ displayReadiness: "accepted", pr: { number: 9, state: "accepted", title: "t" }, validation: "bypassed" });
    expect(cardProblems(accepted)).toEqual([{ key: "merge", label: "merge pending", icon: "pr", tone: "amber" }]);
  });

  it("validation is a problem or nothing: the fill tier only (ruling 168(b)), withdrawn on terminal work (C2)", () => {
    expect(cardProblems(task({ validation: "bypassed" })).map((p) => p.label)).toEqual(["accepted · gate bypassed"]);
    for (const v of ["changed", "healthy", "none"] as const) {
      expect(cardProblems(task({ validation: v }))).toEqual([]);
    }
    expect(cardProblems(task({ validation: "failing", displayReadiness: "merged" }))).toEqual([]);
  });

  it("checks and reviews speak only when actionable (P13-D-28)", () => {
    expect(cardProblems(task({ prChecks: { total: 3, passing: 3, failing: 0, pending: 0, state: "passing" } }))).toEqual([]);
    expect(cardProblems(task({ prReview: "approved" }))).toEqual([]);
    expect(cardProblems(task({ pr: { number: 9, state: "merged", title: "t" } }))).toEqual([]);
  });
});
