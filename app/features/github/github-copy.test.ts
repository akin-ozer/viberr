import { describe, expect, it } from "vitest";
import {
  grantScopeToast,
  reconcileToast,
  RECONCILE_DONE_TOAST,
  RECONCILE_START_TOAST,
} from "./github-copy";

describe("reconcile toast matrix", () => {
  it("keeps the two verbatim spec strings", () => {
    expect(RECONCILE_START_TOAST).toBe(
      "Reconciling branches and PRs with GitHub…",
    );
    expect(RECONCILE_DONE_TOAST).toBe(
      "Reconciled — every branch and PR maps to its task key",
    );
  });

  it("full success → verbatim completion toast", () => {
    expect(
      reconcileToast({
        status: "ok",
        reconciled: 7,
        failed: 0,
        allFailuresOffline: false,
      }),
    ).toBe(RECONCILE_DONE_TOAST);
  });

  it("no PAT / no repo → honest configuration copy", () => {
    expect(
      reconcileToast({
        status: "no_pat_configured",
        reconciled: 0,
        failed: 0,
        allFailuresOffline: false,
      }),
    ).toBe(
      "No GitHub credential configured — connect a PAT to reconcile branches and PRs.",
    );
    expect(
      reconcileToast({
        status: "no_repo_configured",
        reconciled: 0,
        failed: 0,
        allFailuresOffline: false,
      }),
    ).toBe("No repository configured for this project.");
  });

  it("all failures offline → stale-but-labeled copy (spec §7.10)", () => {
    expect(
      reconcileToast({
        status: "ok",
        reconciled: 0,
        failed: 7,
        allFailuresOffline: true,
      }),
    ).toBe(
      "GitHub is unreachable — showing the last-known branch and PR state.",
    );
  });

  it("partial failure → counted honest copy", () => {
    expect(
      reconcileToast({
        status: "ok",
        reconciled: 5,
        failed: 2,
        allFailuresOffline: false,
      }),
    ).toBe(
      "Reconciled 5 of 7 branches — 2 couldn't sync; last-known state kept.",
    );
  });
});

describe("grant-scope toast matrix", () => {
  it("no PAT → typed honest copy (never a crash)", () => {
    expect(grantScopeToast({ status: "no_pat_configured", resolvedCount: 0 })).toBe(
      "No GitHub credential configured — connect a PAT before re-checking scopes.",
    );
  });

  it("offline → last-known copy", () => {
    expect(
      grantScopeToast({ status: "network_unavailable", resolvedCount: 0 }),
    ).toBe("GitHub is unreachable — kept the last-known scope results.");
  });

  it("resolution → the mock string with the task key interpolated", () => {
    expect(
      grantScopeToast({
        status: "revalidated",
        validationStatus: "valid",
        resolvedCount: 1,
        resolvedTaskKey: "VIB-142",
      }),
    ).toBe("Scope granted · VIB-142 policy flag resolved");
  });

  it("revoked / expired / repo_not_found / org approval → honest failures", () => {
    const base = { status: "revalidated", resolvedCount: 0 } as const;
    expect(grantScopeToast({ ...base, validationStatus: "revoked" })).toBe(
      "Re-check failed — the credential was revoked on GitHub.",
    );
    expect(grantScopeToast({ ...base, validationStatus: "expired" })).toBe(
      "Re-check failed — the credential has expired.",
    );
    expect(
      grantScopeToast({ ...base, validationStatus: "repo_not_found" }),
    ).toBe(
      "Re-check couldn't see the repository — the credential may lack repo access.",
    );
    expect(
      grantScopeToast({ ...base, validationStatus: "org_approval_missing" }),
    ).toBe("Re-check blocked — the token is pending organization approval.");
  });

  it("still-missing scope after a clean re-check → named in the copy", () => {
    expect(
      grantScopeToast({
        status: "revalidated",
        validationStatus: "insufficient_scope",
        resolvedCount: 0,
        stillMissingScope: "pull_request:write",
      }),
    ).toBe(
      "Re-checked — pull_request:write is still missing on the project credential.",
    );
  });

  it("nothing to resolve, everything granted → quiet all-clear", () => {
    expect(
      grantScopeToast({
        status: "revalidated",
        validationStatus: "valid",
        resolvedCount: 0,
        stillMissingScope: null,
      }),
    ).toBe("Scopes re-checked — all required scopes granted.");
  });
});
