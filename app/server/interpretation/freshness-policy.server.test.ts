import { describe, expect, it } from "vitest";
import { isMcpHealthStale } from "~/shared/freshness";
import { isReconcileStale } from "./freshness-policy.server";

/**
 * P13-D-32: the GitHub reconcile chip and the MCP health dot each carried their
 * own 1-hour constant, the second inside a React component. One policy now: the
 * predicates live in `~/shared/freshness`, which the client component reads,
 * and the server reads the reconcile rule through the `server/interpretation/`
 * door the architecture names.
 */

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("isReconcileStale", () => {
  it("is stale when never reconciled, unreadable, or older than an hour", () => {
    expect(isReconcileStale(null, NOW)).toBe(true);
    expect(isReconcileStale(undefined, NOW)).toBe(true);
    expect(isReconcileStale("not a date", NOW)).toBe(true);
    expect(isReconcileStale(ago(5 * 60_000), NOW)).toBe(false);
    expect(isReconcileStale(ago(61 * 60_000), NOW)).toBe(true);
  });

  it("flips exactly at the hour, not before", () => {
    expect(isReconcileStale(ago(HOUR), NOW)).toBe(false);
    expect(isReconcileStale(ago(HOUR + 1), NOW)).toBe(true);
  });
});

describe("isMcpHealthStale", () => {
  it("distinguishes NEVER checked (unknown, not stale) from an old check", () => {
    // The panel renders "never" separately — an unchecked server must not be
    // painted amber-stale, which the shared `isStale` default would do.
    expect(isMcpHealthStale(null, NOW)).toBe(false);
    expect(isMcpHealthStale(ago(30 * 60_000), NOW)).toBe(false);
    expect(isMcpHealthStale(ago(2 * 60 * 60_000), NOW)).toBe(true);
  });

  it("shares ONE threshold with the reconcile rule", () => {
    const at = ago(HOUR + 1);
    expect(isMcpHealthStale(at, NOW)).toBe(isReconcileStale(at, NOW));
  });
});
