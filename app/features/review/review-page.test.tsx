// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ReviewQueuePage } from "./review-page";
import type { ReviewRowView } from "./review-helpers";

afterEach(cleanup);

const rowHuman: ReviewRowView = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  waiting: "human",
  packet: {
    kind: "Completion report",
    title: "Accept completion, or send back for one fix?",
  },
  latestEventText: null,
  pr: { number: 318, state: "review" },
  validation: "changed",
};

const rowAgent: ReviewRowView = {
  key: "VIB-145",
  title: "Live task activity via SSE",
  waiting: "agent",
  packet: null,
  latestEventText:
    "**Transition request:** move VIB-145 from In Progress to Review — evidence attached.",
  pr: { number: 311, state: "merged" },
  validation: "healthy",
};

function renderQueue(
  ready: ReviewRowView[],
  working: ReviewRowView[],
  total = ready.length + working.length,
) {
  const Stub = createRoutesStub([
    {
      path: "/projects/:slug/review",
      Component: () => (
        <ReviewQueuePage
          projectSlug="viberr-core"
          ready={ready}
          working={working}
          total={total}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/review"]} />);
}

describe("ReviewQueuePage", () => {
  it("renders header counts, the policy chip, and both panels", () => {
    const { container, getByText, getByTitle } = renderQueue(
      [rowHuman],
      [rowAgent],
    );
    expect(getByText("Review queue")).toBeTruthy();
    expect(
      getByText(
        "2 tasks at the review boundary · 1 waiting on your decision",
      ),
    ).toBeTruthy();
    // Policy chip with its explanatory tooltip (the only pre-click hint).
    const chip = getByTitle(
      "Review → Done follows the configured completion policy — see Policy",
    );
    expect(chip.classList.contains("hero-file")).toBe(true);
    expect(chip.textContent).toContain("Review → Done · governed completion");
    // Panel heads + "X of Y" count pair.
    expect(getByText("Waiting on your decision")).toBeTruthy();
    expect(getByText("1 of 2")).toBeTruthy();
    expect(getByText("Waiting on agents")).toBeTruthy();
    // The pol-note acceptance explainer always renders.
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "merge pending",
    );
  });

  it("rows carry key, subline, PR pill, validation pill and the divergent wait-tag copy", () => {
    const { container } = renderQueue([rowHuman], [rowAgent]);
    const rows = container.querySelectorAll(".rq-row");
    expect(rows).toHaveLength(2);

    const first = rows[0]!;
    expect(first.querySelector(".rq-key")!.textContent).toBe("VIB-142");
    expect(first.querySelector(".sub")!.textContent).toBe(
      "Completion report — Accept completion, or send back for one fix?",
    );
    // Review responsibility is personal rather than project-wide.
    expect(first.querySelector(".wait-tag.human")!.textContent).toContain(
      "your decision",
    );
    expect(first.textContent).toContain("PR #318 · in review");
    expect(first.textContent).toContain("evidence changed");

    const second = rows[1]!;
    // Markdown markers stripped from the timeline subline.
    expect(second.querySelector(".sub")!.textContent).toContain(
      "Transition request:",
    );
    expect(second.querySelector(".sub")!.textContent).not.toContain("**");
    expect(second.querySelector(".wait-tag.agent")!.textContent).toContain(
      "waiting on agent",
    );
    expect(second.querySelector(".wait-tag.agent .working")).toBeNull();
    // Merged PR renders the done pill kind.
    expect(second.querySelector(".pill.done")!.textContent).toBe(
      "PR #311 · merged",
    );
  });

  it("keeps closed and accepted PR states distinct", () => {
    const closed = {
      ...rowHuman,
      key: "VIB-146",
      pr: { number: 320, state: "closed" as const },
    };
    const accepted = {
      ...rowHuman,
      key: "VIB-147",
      pr: { number: 321, state: "accepted" as const },
    };
    const { getByText } = renderQueue([closed, accepted], []);
    expect(getByText("PR #320 · closed").classList.contains("risk")).toBe(true);
    expect(
      getByText("PR #321 · merge pending").classList.contains("input"),
    ).toBe(true);
  });

  it("renders both empty states with exact copy (no all-empty hero)", () => {
    const { getByText } = renderQueue([], []);
    expect(
      getByText(
        "Nothing waits on you. Completion reports land here when a task reaches the boundary.",
      ),
    ).toBeTruthy();
    expect(getByText("No review tasks are waiting on an agent.")).toBeTruthy();
    expect(
      getByText("0 tasks at the review boundary · 0 waiting on your decision"),
    ).toBeTruthy();
  });

  it("singular header copy for exactly one review task", () => {
    const { getByText } = renderQueue([rowHuman], []);
    expect(
      getByText("1 task at the review boundary · 1 waiting on your decision"),
    ).toBeTruthy();
  });
});
