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
  blockReason: null,
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
  blockReason: null,
};

function renderQueue(
  ready: ReviewRowView[],
  working: ReviewRowView[],
  total = ready.length + working.length,
  acceptance?: { operatorCanAccept: boolean; operatorName: string },
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
          acceptance={acceptance}
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
    // UI-27/UI-49: REWRITTEN. The chip used to be a `<button class="hero-file">`
    // — visually identical to the non-interactive `hero-file` spans elsewhere,
    // so nothing announced it navigates; it is a real button now. And the
    // "Review → Done" wording is no longer hardcoded: the page renders the
    // project's RESOLVED stage names (the default prop keeps this fixture's).
    const chip = getByTitle("Review → Done is locked to humans — see Policy");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.classList.contains("btn")).toBe(true);
    expect(chip.textContent).toContain("Review → Done · human only");
    // Panel heads + "X of Y" count pair.
    expect(getByText("Waiting on your acceptance")).toBeTruthy();
    expect(getByText("1 of 2")).toBeTruthy();
    expect(getByText("Still in review")).toBeTruthy();
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
    // validation `changed` names what is OWED, not the mechanism (owner
    // feedback 2026-07-26 — was "evidence changed").
    expect(first.textContent).toContain("awaiting verdict");

    const second = rows[1]!;
    // P14-LV-05: a row that carries a PR describes the PR's LIVE state — the
    // newest timeline note (here a stale "Transition request") is history, and
    // rendering it as the row's current state is how a REOPENED PR kept reading
    // "closed on GitHub without merging".
    expect(second.querySelector(".sub")!.textContent).toBe(
      "PR #311 is merged on GitHub — accept the completion to close the task.",
    );
    expect(second.querySelector(".wait-tag.agent")!.textContent).toContain(
      "agent working",
    );
    expect(second.querySelector(".wait-tag.agent .working")).toBeTruthy();
    // Merged PR renders the done pill kind.
    expect(second.querySelector(".pill.done")!.textContent).toBe("PR #311");
  });

  it("labels a human-waiting row in the working panel 'waiting on a human', never 'agent working'", () => {
    // R8-3: a review task waiting on a human someone ELSE must accept lands in
    // "Still in review" — it must read "waiting on a human", not the false
    // "agent working" (no agent is running on a human-waiting task).
    const humanNotMine: ReviewRowView = {
      ...rowAgent,
      key: "VIB-150",
      waiting: "human",
    };
    const { container } = renderQueue([], [humanNotMine]);
    const row = container.querySelector(".rq-row")!;
    expect(row.querySelector(".wait-tag.human")!.textContent).toContain(
      "waiting on a human",
    );
    expect(row.querySelector(".wait-tag.agent")).toBeNull();
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

describe("P13-D-9: the queue stops promising human-only Done unconditionally", () => {
  it("keeps the absolute claim when no operator holds the direct grant", () => {
    const { container, getByTitle } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: false,
      operatorName: "Operator",
    });
    expect(
      getByTitle("Review → Done is locked to humans — see Policy").textContent,
    ).toContain("Review → Done · human only");
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action, always in the audit log",
    );
  });

  it("qualifies the chip and the footer for a direct-authority operator", () => {
    // Owner ruling Q1: a full-autonomy operator with an explicit
    // `completion-for-acceptance: direct` grant moves tasks to Done itself
    // (operator-actions.server.ts:1632). The create modal and the Policy note
    // were updated to disclose it; the Review queue — where a maintainer forms
    // the acceptance belief — shipped "always a human action" regardless.
    const { container, getByText } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: true,
      operatorName: "Atlas",
    });
    const chip = getByText("Review → Done · human or operator");
    expect(chip).toBeTruthy();
    expect(chip.closest("button")!.getAttribute("title")).toContain(
      "Atlas runs at full autonomy",
    );

    const note = container.querySelector(".pol-note")!.textContent!;
    expect(note).not.toContain("always a human action");
    expect(note).toContain("Atlas");
    expect(note).toContain("full autonomy");
    expect(note).toContain("Completion for human acceptance");
    expect(note).toContain("Direct");
    // It stays an exception, not a licence.
    expect(note).toContain("one exception");
    expect(note).toContain("always in the audit log");
  });

  it("defaults to the strict boundary when the caller passes no acceptance data", () => {
    const { container } = renderQueue([rowHuman], []);
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action",
    );
  });
});
