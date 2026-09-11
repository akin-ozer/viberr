import { describe, expect, it } from "vitest";
import { formatUsd } from "./run-failure";

describe("formatUsd (ruling 175)", () => {
  it("prints cents from a dollar up", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("below a dollar keeps up to four decimals, never fewer than two, so a spend past a small cap never prints as the cap", () => {
    // The live canary: a $0.01 cap, $0.010638 spent, used to read "…after
    // spending $0.01".
    expect(formatUsd(0.010638)).toBe("$0.0106");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
