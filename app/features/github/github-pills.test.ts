import { describe, expect, it } from "vitest";
import {
  checksPill,
  connectionPill,
  prStatePill,
  reviewPill,
  syncPill,
} from "./github-pills";

describe("syncPill (ruling 12 vocabulary)", () => {
  it("maps the three sync states to the mock pill kinds", () => {
    expect(syncPill("merged")).toEqual({ kind: "done", label: "merged", quiet: true });
    expect(syncPill("behind_main")).toEqual({
      kind: "risk",
      label: "behind main",
    });
    expect(syncPill("synced")).toEqual({ kind: "ready", label: "synced", quiet: true });
  });
});

describe("prStatePill (ruling 12 incl. the closed-unmerged risk state)", () => {
  it("merged → done pill", () => {
    expect(prStatePill("merged")).toEqual({ kind: "done", label: "merged", quiet: true });
  });
  it("closed-unmerged → risk pill 'closed'", () => {
    expect(prStatePill("closed")).toEqual({ kind: "risk", label: "closed" });
  });
  it("review (open/draft) → info 'in review'", () => {
    expect(prStatePill("review")).toEqual({ kind: "info", label: "in review" });
  });
  it("accepted (human accepted, merge pending) → amber 'merge pending'", () => {
    expect(prStatePill("accepted")).toEqual({
      kind: "input",
      label: "merge pending",
    });
  });
  it("unknown states fall back to 'in review'", () => {
    expect(prStatePill("open")).toEqual({ kind: "info", label: "in review" });
  });
});

describe("connectionPill (spec §7.9c: never claim connected when degraded)", () => {
  it("connected → ready pill", () => {
    expect(connectionPill({ status: "connected" })).toEqual({
      kind: "ready",
      label: "connected",
      quiet: true,
    });
  });
  it("every degraded status renders a non-ready pill", () => {
    const degraded = [
      { status: "no_repo_configured" },
      { status: "no_pat_configured" },
      { status: "repo_not_found" },
      { status: "auth_failed", reason: "expired" },
      { status: "auth_failed", reason: "revoked" },
      { status: "org_approval_missing" },
      { status: "forbidden" },
      { status: "network_unavailable" },
    ] as const;
    for (const c of degraded) {
      expect(connectionPill(c).kind).not.toBe("ready");
      expect(connectionPill(c).label).not.toBe("connected");
    }
  });
  it("labels the interesting cases", () => {
    expect(connectionPill({ status: "no_pat_configured" }).label).toBe(
      "no credential",
    );
    expect(
      connectionPill({ status: "auth_failed", reason: "expired" }).label,
    ).toBe("token expired");
    expect(connectionPill({ status: "network_unavailable" }).label).toBe(
      "offline",
    );
  });
});

describe("checksPill / reviewPill (P13-D-28)", () => {
  type ChecksRollup = Parameters<typeof checksPill>[0];
  const checks = (o: Partial<Omit<ChecksRollup, "state">>): ChecksRollup => {
    const total = o.total ?? 3;
    const failing = o.failing ?? 0;
    const pending = o.pending ?? 0;
    return {
      total,
      failing,
      pending,
      passing: o.passing ?? total - failing - pending,
      state: failing > 0 ? "failing" : pending > 0 ? "pending" : "passing",
    };
  };

  it("ranks failing over pending over passing", () => {
    // The worst TRUE statement wins, matching the sync column's precedence —
    // a run with one red check is not "2 running".
    expect(checksPill(checks({ total: 3, failing: 1, pending: 1 })).kind).toBe("blocked");
    expect(checksPill(checks({ total: 3, pending: 2 })).kind).toBe("input");
    expect(checksPill(checks({ total: 3 })).kind).toBe("ready");
  });

  it("counts the relevant checks, not the total, when something is wrong", () => {
    expect(checksPill(checks({ total: 9, failing: 2 })).label).toBe("2/9 checks failing");
    expect(checksPill(checks({ total: 9, pending: 4 })).label).toBe("4/9 checks running");
    expect(checksPill(checks({ total: 9 })).label).toBe("9 checks passing");
  });

  it("F21-7: unaccounted runs get a grey pill, never the green one", () => {
    const drifted = {
      total: 3,
      passing: 0,
      failing: 0,
      pending: 0,
      unknown: 3,
      state: "unknown",
    } as const;
    expect(checksPill(drifted)).toEqual({
      kind: "neutral",
      label: "3/3 checks unknown",
    });
    // Partially readable: only the unaccounted share is named.
    expect(
      checksPill({ total: 4, passing: 2, failing: 0, pending: 0, unknown: 2, state: "unknown" })
        .label,
    ).toBe("2/4 checks unknown");
  });

  it("never claims a green build from GitHub's opinion alone", () => {
    // changes_requested is `risk`, not `blocked`: GitHub's review state is a
    // real signal but it is not this app's acceptance gate — an in-product
    // request_changes verdict is what actually blocks.
    expect(reviewPill("changes_requested")).toEqual({
      kind: "risk",
      label: "changes requested",
    });
    expect(reviewPill("approved")).toEqual({ kind: "ready", label: "approved", quiet: true });
    expect(reviewPill("review_required")).toEqual({
      kind: "input",
      label: "review required",
    });
  });
});

// Design pass 2026-09-08: the second pill tier lives in this vocabulary, not in
// the components — a fill is a problem or a demand, an outline describes.
describe("the quiet tier marks the settled facts, never the states that want a person", () => {
  it("settled facts are quiet", () => {
    expect(syncPill("merged").quiet).toBe(true);
    expect(syncPill("synced").quiet).toBe(true);
    expect(prStatePill("merged").quiet).toBe(true);
    expect(reviewPill("approved").quiet).toBe(true);
    expect(connectionPill({ status: "connected" }).quiet).toBe(true);
    expect(
      checksPill({ total: 3, passing: 3, failing: 0, pending: 0, state: "passing" }).quiet,
    ).toBe(true);
  });
  it("demands keep their fill", () => {
    for (const view of [
      syncPill("behind_main"),
      syncPill("unknown"),
      prStatePill("closed"),
      prStatePill("accepted"),
      prStatePill("review"),
      reviewPill("changes_requested"),
      reviewPill("review_required"),
      connectionPill({ status: "no_pat_configured" }),
      connectionPill({ status: "auth_failed", reason: "expired" }),
      checksPill({ total: 3, passing: 2, failing: 1, pending: 0, state: "failing" }),
      checksPill({ total: 3, passing: 2, failing: 0, pending: 1, state: "pending" }),
    ]) {
      expect(view.quiet, view.label).toBeUndefined();
    }
  });
});
