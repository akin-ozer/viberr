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
        "2 tasks at the review boundary · 1 waiting on your acceptance",
      ),
    ).toBeTruthy();
    // Policy chip with its explanatory tooltip (the only pre-click hint).
    const chip = getByTitle("Review → Done is locked to humans — see Policy");
    expect(chip.classList.contains("hero-file")).toBe(true);
    expect(chip.textContent).toContain("Review → Done · human only");
    // Panel heads + "X of Y" count pair.
    expect(getByText("Waiting on your acceptance")).toBeTruthy();
    expect(getByText("1 of 2")).toBeTruthy();
    expect(getByText("Still with agents")).toBeTruthy();
    // The pol-note acceptance explainer always renders.
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action, always in the audit log",
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
    // "your acceptance" — deliberately NOT the board's "waiting on you".
    expect(first.querySelector(".wait-tag.human")!.textContent).toContain(
      "your acceptance",
    );
    expect(first.textContent).toContain("PR #318");
    expect(first.textContent).toContain("evidence changed");

    const second = rows[1]!;
    // Markdown markers stripped from the timeline subline.
    expect(second.querySelector(".sub")!.textContent).toContain(
      "Transition request:",
    );
    expect(second.querySelector(".sub")!.textContent).not.toContain("**");
    expect(second.querySelector(".wait-tag.agent")!.textContent).toContain(
      "agent working",
    );
    expect(second.querySelector(".wait-tag.agent .working")).toBeTruthy();
    // Merged PR renders the done pill kind.
    expect(second.querySelector(".pill.done")!.textContent).toBe("PR #311");
  });

  it("renders both empty states with exact copy (no all-empty hero)", () => {
    const { getByText } = renderQueue([], []);
    expect(
      getByText(
        "Nothing waits on you. Completion reports land here when a task reaches the boundary.",
      ),
    ).toBeTruthy();
    expect(getByText("No review work in flight.")).toBeTruthy();
    expect(
      getByText("0 tasks at the review boundary · 0 waiting on your acceptance"),
    ).toBeTruthy();
  });

  it("singular header copy for exactly one review task", () => {
    const { getByText } = renderQueue([rowHuman], []);
    expect(
      getByText("1 task at the review boundary · 1 waiting on your acceptance"),
    ).toBeTruthy();
  });
});
