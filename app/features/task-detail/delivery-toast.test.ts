import { describe, expect, it } from "vitest";
import { deliveryToast } from "./delivery-toast";

/**
 * Ruling 229: one toast for every human delivery door. Canary: swap the
 * `created` and `moved` branches and the first two cases fail.
 */
describe("deliveryToast", () => {
  const base = { status: "delivered" as const, prNumber: 13, url: "https://x/pull/13", pushStatus: "pushed", operatorRequeued: false, recompare: null };
  it("names a newly opened PR", () => {
    expect(deliveryToast({ ...base, created: true, moved: true, headSha: "a".repeat(40) })).toBe(
      "Delivered · opened review PR #13",
    );
  });
  it("names a pushed head on a reused PR", () => {
    expect(deliveryToast({ ...base, created: false, moved: true, headSha: "385047c".padEnd(40, "0") })).toBe(
      "Delivered · pushed `385047c` to PR #13",
    );
  });
  it("says nothing moved for an up-to-date reuse", () => {
    expect(
      deliveryToast({ ...base, created: false, moved: false, headSha: "385047c".padEnd(40, "0"), pushStatus: "up_to_date" }),
    ).toBe("PR #13 already carries `385047c` · nothing to push");
    expect(deliveryToast({ ...base, created: false, moved: false, headSha: null, pushStatus: "no_commits" })).toBe(
      "PR #13 already carries the delivered revision · nothing to push",
    );
  });
  it("carries a failure's own message", () => {
    expect(deliveryToast({ status: "push_failed", message: "git push failed" })).toBe(
      "Delivery did not complete: git push failed",
    );
  });
});
