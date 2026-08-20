import { describe, expect, it } from "vitest";
import {
  engagementVocabulary,
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
  const view: DeployedSpecialistView = {
    id,
    name: id,
    role: "reviewer",
    backend: "claude",
    model: "sonnet",
  };
  // An ABSENT `capabilities` key is the pre-UI-39 loader shape the label has to
  // keep reading as "unknown", so it is only set when the caller states one.
  if (verdict !== undefined) {
    view.capabilities = { delivery: false, verdict, askHuman: false, browser: false };
  }
  return view;
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

/**
 * UX19-4 — UC-13 renamed the heading and stopped there, so the cell could read
 * "Supporting agents" while every control inside it said "reviewer", including
 * an empty state that flatly contradicted the heading ("All deployed agents are
 * already reviewing."). Heading and verbs now come from ONE call, so they
 * cannot drift apart again.
 */
describe("engagementVocabulary", () => {
  it("gives the supporting cell engagement verbs — no reviewer word anywhere", () => {
    const v = engagementVocabulary(
      [{ profileId: "docs" }],
      [profile("docs", false)],
    );
    expect(v.heading).toBe("Supporting agents");
    const strings = [
      v.add,
      v.panel,
      v.allEngaged,
      v.closed,
      v.release,
      v.releaseOf("Documentation"),
    ];
    expect(strings).toEqual([
      "Engage agent",
      "Engage an agent",
      "All deployed agents are already engaged.",
      "Task closed. No new engagements.",
      "Release agent",
      "Release Documentation agent",
    ]);
    // The contradiction that made this a defect rather than drift: a cell that
    // says these engagements are NOT reviewing must not also say they are.
    expect(strings.join(" ")).not.toMatch(/review/i);
  });

  it("keeps the reviewer vocabulary as soon as one engagement gates acceptance", () => {
    const v = engagementVocabulary(
      [{ profileId: "docs" }, { profileId: "senior" }],
      [profile("docs", false), profile("senior", true)],
    );
    expect(v.heading).toBe("Reviewing agents");
    expect([v.add, v.panel, v.allEngaged, v.closed, v.release]).toEqual([
      "Engage reviewer",
      "Engage a reviewer",
      "All deployed agents are already reviewing.",
      "Task closed. No new reviewer engagements.",
      "Release reviewer",
    ]);
    expect(v.releaseOf("Code review")).toBe("Release Code review reviewer");
  });

  it("an empty cell keeps the reviewer vocabulary (nothing has been demoted yet)", () => {
    const v = engagementVocabulary([], []);
    expect(v.heading).toBe("Reviewing agents");
    expect(v.add).toBe("Engage reviewer");
  });
});
