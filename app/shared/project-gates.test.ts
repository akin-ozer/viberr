import { describe, expect, it } from "vitest";
import type { GateRun, WorkRevision } from "~/schemas/task-file.schema";
import {
  gateLogName,
  isGateLogName,
  gateWallTime,
  projectGatesRefusal,
  projectGatesView,
} from "./project-gates";

/**
 * Ruling 482: the one reading of a task's gate record. The acceptance gate,
 * the projection, the PR card, the accept dialog, the operator and every
 * agent's anchor print what this answers, so a sha, a count and a refusal can
 * never disagree between two surfaces.
 */

const SHA = "a95c3370000000000000000000000000000000ff";
const REV: WorkRevision = {
  id: "rev_1",
  headSha: SHA,
  treeSha: null,
  branch: "web-4",
  createdAt: "2026-09-25T09:00:00.000Z",
  sourceProfileId: "dev",
};
const GATES = [
  { name: "install", command: "pnpm install --frozen-lockfile" },
  { name: "check", command: "pnpm astro check" },
  { name: "build", command: "pnpm build" },
  { name: "deploy-dry-run", command: "pnpm wrangler deploy --dry-run" },
];

function finished(exitCodes: (number | null)[], over: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate_1",
    revisionId: "rev_1",
    headSha: SHA,
    status: "finished",
    reason: "delivery",
    requestedAt: "2026-09-25T10:00:00.000Z",
    startedAt: "2026-09-25T10:00:01.000Z",
    finishedAt: "2026-09-25T10:03:00.000Z",
    error: null,
    results: GATES.map((g, i) => ({
      name: g.name,
      command: g.command,
      exitCode: exitCodes[i] ?? null,
      timedOut: exitCodes[i] === null,
      wallMs: 12_000,
      log: `gate-a95c337-0${i + 1}-${g.name}-20260925T100001Z.log`,
    })),
    ...over,
  };
}

describe("projectGatesView (ruling 482)", () => {
  it("says the PR card's line for a clean run", () => {
    const view = projectGatesView(GATES, { workRevision: REV, gateRun: finished([0, 0, 0, 0]) });
    expect(view).toMatchObject({ state: "passed", passed: 4, total: 4 });
    expect(view?.line).toBe("Gates on a95c337: 4/4 exit 0 (run by Viberr)");
    expect(view?.rows[0]).toEqual({
      name: "install",
      command: "pnpm install --frozen-lockfile",
      outcome: "exit 0",
      wall: "12 s",
      ok: true,
      log: "gate-a95c337-01-install-20260925T100001Z.log",
    });
  });

  it("counts a failure and a timeout against the total", () => {
    const view = projectGatesView(GATES, { workRevision: REV, gateRun: finished([0, 0, 1, null]) });
    expect(view).toMatchObject({ state: "failed", passed: 2 });
    expect(view?.line).toBe("Gates on a95c337: 2/4 exit 0 (run by Viberr)");
    expect(view?.rows.map((r) => r.outcome)).toEqual(["exit 0", "exit 0", "exit 1", "timed out"]);
  });

  it("does not read a run on another revision as evidence about this one", () => {
    // CANARY: drop the revision-id comparison in gatesViewOf.
    const view = projectGatesView(GATES, {
      workRevision: { ...REV, id: "rev_2" },
      gateRun: finished([0, 0, 0, 0]),
    });
    expect(view).toMatchObject({ state: "not_run", passed: 0, results: [] });
    expect(view?.line).toBe("Gates on a95c337: not run yet");
  });

  it("reads nothing when no gate is declared, nothing is delivered, or the revision is a no-change verification", () => {
    expect(projectGatesView([], { workRevision: REV })).toBeNull();
    expect(projectGatesView(undefined, { workRevision: REV })).toBeNull();
    expect(projectGatesView(GATES, { workRevision: null })).toBeNull();
    expect(projectGatesView(GATES, { workRevision: { ...REV, kind: "verified" } })).toBeNull();
    expect(projectGatesView(GATES, { workRevision: { ...REV, kind: "discarded" } })).toBeNull();
  });

  it("shows a run in flight and a run that could not execute", () => {
    const running = finished([0], { status: "running", finishedAt: null });
    running.results = running.results.slice(0, 1);
    expect(projectGatesView(GATES, { workRevision: REV, gateRun: running })?.line).toBe(
      "Gates on a95c337: running, 1 of 4 done (run by Viberr)",
    );
    const broken = finished([], { status: "error", results: [], error: "the checkout is gone" });
    expect(projectGatesView(GATES, { workRevision: REV, gateRun: broken })).toMatchObject({
      state: "error",
      error: "the checkout is gone",
    });
  });

  it("marks a run under an earlier gate list as stale", () => {
    const view = projectGatesView([...GATES, { name: "e2e", command: "pnpm e2e" }], {
      workRevision: REV,
      gateRun: finished([0, 0, 0, 0]),
    });
    expect(view?.state).toBe("stale");
  });
});

describe("projectGatesRefusal (ruling 482)", () => {
  it("refuses a failing, missing, running or stale record and passes a clean one", () => {
    expect(projectGatesRefusal(GATES, { workRevision: REV, gateRun: finished([0, 0, 0, 0]) }, "WEB-4")).toBeNull();
    // CANARY: return null for `failed` in projectGatesRefusal.
    expect(
      projectGatesRefusal(GATES, { workRevision: REV, gateRun: finished([0, 0, 1, 0]) }, "WEB-4"),
    ).toBe(
      "The project's gates failed on WEB-4's revision `a95c337`: 3/4 exit 0 (`build` exit 1). Rework the branch; the next delivered revision is gated again. An admin can force-accept, and the bypass is recorded.",
    );
    expect(projectGatesRefusal(GATES, { workRevision: REV }, "WEB-4")).toContain("have not run");
    expect(
      projectGatesRefusal(GATES, { workRevision: REV, gateRun: finished([], { status: "queued", results: [] }) }, "WEB-4"),
    ).toContain("still running");
    expect(projectGatesRefusal(undefined, { workRevision: REV }, "WEB-4")).toBeNull();
  });
});

describe("gate log names", () => {
  it("names a log by sha, place, gate and start, and recognises only that shape", () => {
    const name = gateLogName(SHA, 2, "Astro check!", "2026-09-25T10:15:00.123Z");
    expect(name).toBe("gate-a95c337-02-astro-check-20260925T101500Z.log");
    expect(isGateLogName(name)).toBe(true);
    expect(isGateLogName("review-evidence.log")).toBe(false);
    expect(isGateLogName("page-2026-09-25T10-15-00-000Z.png")).toBe(false);
  });

  it("prints wall time the way a person reads it", () => {
    expect(gateWallTime(850)).toBe("850 ms");
    expect(gateWallTime(12_400)).toBe("12 s");
    expect(gateWallTime(64_000)).toBe("1 min 04 s");
  });
});
