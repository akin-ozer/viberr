import { describe, expect, it } from "vitest";
import { deploymentDot, deploymentStatusLabel } from "./agent-types";

describe("deployment live-status truth", () => {
  it("does not turn a waiting-side hint into a fake running claim", () => {
    expect(deploymentStatusLabel({ status: "working", running: false })).toBe(
      "awaiting agent",
    );
    expect(
      deploymentStatusLabel({ status: "coordinating", running: false }),
    ).toBe("engaged");
    expect(deploymentDot({ status: "working", running: false })).toBe(false);
  });

  it("uses the non-simulated active-run join as the running signal", () => {
    expect(deploymentStatusLabel({ status: "on call", running: true })).toBe(
      "running",
    );
    expect(deploymentDot({ status: "on call", running: true })).toBe(true);
  });
});
