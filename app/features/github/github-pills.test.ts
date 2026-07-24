import { describe, expect, it } from "vitest";
import { connectionPill, prStatePill, syncPill } from "./github-pills";

describe("syncPill (ruling 12 vocabulary)", () => {
  it("maps the three sync states to the mock pill kinds", () => {
    expect(syncPill("merged")).toEqual({ kind: "done", label: "merged" });
    expect(syncPill("behind_main")).toEqual({
      kind: "risk",
      label: "behind main",
    });
    expect(syncPill("synced")).toEqual({ kind: "ready", label: "synced" });
  });
});

describe("prStatePill (ruling 12 incl. the closed-unmerged risk state)", () => {
  it("merged → done pill", () => {
    expect(prStatePill("merged")).toEqual({ kind: "done", label: "merged" });
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
