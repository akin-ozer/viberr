import { describe, expect, it } from "vitest";
import {
  reviewingAgentsLabel,
  type DeployedSpecialistView,
} from "./execution-profile";

/**
 * UC-13 — the engagements cell used to be headed "Reviewing agents" whatever
 * was engaged, so a task whose only engagements were supporting agents (no
 * `report-validation-verdict` grant) read as if reviewers held its acceptance
 * gate.
 */

function profile(
  id: string,
  verdict: boolean | undefined,
): DeployedSpecialistView {
  return {
    id,
    name: id,
    role: "reviewer",
    backend: "claude",
    model: "sonnet",
    ...(verdict === undefined
      ? {}
      : { capabilities: { delivery: false, verdict, askHuman: false } }),
  };
}

describe("reviewingAgentsLabel", () => {
  it("keeps the review framing when nothing is engaged yet", () => {
    expect(reviewingAgentsLabel([], [])).toBe("Reviewing agents");
  });

  it("says SUPPORTING when every engagement is verdict-less", () => {
    expect(
      reviewingAgentsLabel(
        [{ profileId: "docs" }, { profileId: "perf" }],
        [profile("docs", false), profile("perf", false)],
      ),
    ).toBe("Supporting agents");
  });

  it("says REVIEWING as soon as one engagement gates acceptance", () => {
    expect(
      reviewingAgentsLabel(
        [{ profileId: "docs" }, { profileId: "senior" }],
        [profile("docs", false), profile("senior", true)],
      ),
    ).toBe("Reviewing agents");
  });

  it("never downgrades on missing capability data", () => {
    // A profile that is no longer deployed, or a payload without capabilities.
    expect(
      reviewingAgentsLabel([{ profileId: "gone" }], []),
    ).toBe("Reviewing agents");
    expect(
      reviewingAgentsLabel(
        [{ profileId: "old" }],
        [profile("old", undefined)],
      ),
    ).toBe("Reviewing agents");
  });
});
