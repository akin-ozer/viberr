// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  OperatorRecommendations,
  type RecommendationView,
} from "./operator-recommendations";

/**
 * Ruling 137 (pass 34, F34-15): an `accept_completion` card names the work
 * revision it was authored against, so a reader can tell whether the offer
 * still describes the branch. Other kinds never render one, and a card written
 * before the binding existed renders nothing special.
 */
describe("OperatorRecommendations", () => {
  it("an accept card says which revision it is for; other cards and unbound cards do not", () => {
    // Canary: remove the `op-rec-revision` render.
    const cards: RecommendationView[] = [
      {
        id: "r1",
        kind: "accept_completion",
        label: "Accept completion and move VIB-1 to Done",
        detail: "The review is clean.",
        forHeadSha: "6548677abcdef0123456789abcdef0123456789a",
      },
      {
        id: "r2",
        kind: "run_agent",
        label: "Run Developer",
        detail: "",
        forHeadSha: "deadbeef".padEnd(40, "0"),
      },
      { id: "r3", kind: "accept_completion", label: "Accept completion (older card)", detail: "" },
    ];
    const html = renderToString(
      <OperatorRecommendations
        recommendations={cards}
        canApply
        busy={false}
        onApply={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("for revision <code>6548677</code>");
    expect(html).not.toContain("deadbee");
    expect(html.match(/for revision/g) ?? []).toHaveLength(1);
  });
});

afterEach(cleanup);

/**
 * U39-7 (pass 39): the operator writes a card's reason with `code` and
 * **bold**, like every comment it writes, and the card printed the backticks:
 * "Reviewer approved `9471594`. Accepting completion moves AX-24 to Done".
 */
describe("OperatorRecommendations: the operator's reason renders its inline format", () => {
  it("renders `code` and **bold** in the reason and the directive instead of printing the marks", () => {
    // CANARY: render `{r.detail}` as plain text again.
    const html = renderToString(
      <OperatorRecommendations
        recommendations={[
          { id: "r1", kind: "accept_completion", label: "Accept completion and move AX-24 to Done", detail: "Reviewer approved `9471594`. **Clean** review." },
          { id: "r2", kind: "run_agent", profileId: "dev", label: "Run Developer", detail: "Rework the gate.", prompt: "Fix `apply.go` only." },
        ]}
        canApply
        busy={false}
        onApply={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('Reviewer approved <code class="mono">9471594</code>');
    expect(html).toContain("<strong>Clean</strong>");
    expect(html).toContain('Fix <code class="mono">apply.go</code> only.');
    expect(html).not.toContain("`");
  });
});

/**
 * Ruling 162 (pass 35, F35-12 (c)): no surface offers an acceptance the gate
 * will refuse. The acceptance card keeps its control (ruling 147's shape) but
 * prints the gate's refusal as a keyed alert, and Apply re-announces it
 * instead of opening a confirm the server would answer 409 (KNC-6: the card
 * said "Accept completion", the click said "conflicts with the base branch").
 */
describe("OperatorRecommendations: the acceptance gate's refusal on the card (ruling 162)", () => {
  const REFUSAL =
    "VIB-1's review PR #7 conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Resolve the conflict on the branch by merging the base INTO it — never by rebasing, which rewrites commits the pull request already published — then re-review, or archive the task.";
  const cards: RecommendationView[] = [
    { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-1 to Done", detail: "The review is clean." },
    { id: "r-done", kind: "transition", toStageId: "done", label: "Move the task to Done", detail: "" },
    { id: "r-run", kind: "run_agent", profileId: "dev", label: "Run Developer", detail: "" },
  ];

  it("renders the refusal on the acceptance cards only, and Apply there refuses the click", () => {
    // Canary: drop the `acceptanceRefusal` branch from the Apply handler.
    const onApply = vi.fn();
    const { container, getAllByRole } = render(
      <OperatorRecommendations
        recommendations={cards}
        canApply
        busy={false}
        onApply={onApply}
        onDismiss={() => {}}
        acceptanceRefusal={REFUSAL}
        terminalStageId="done"
      />,
    );
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.textContent).toContain("Not acceptable now.");
    expect(alerts[0]!.textContent).toContain(REFUSAL);
    const applies = getAllByRole("button", { name: /Apply/ });
    expect(applies).toHaveLength(3);
    fireEvent.click(applies[0]!);
    fireEvent.click(applies[1]!);
    expect(onApply).not.toHaveBeenCalled();
    // The refused click re-keys the alert: a fresh element, announced again.
    expect(container.querySelectorAll('[role="alert"]')[0]).not.toBe(alerts[0]);
    // The run_agent card is not an acceptance; its Apply still applies.
    fireEvent.click(applies[2]!);
    expect(onApply).toHaveBeenCalledWith("r-run");
  });

  it("with no refusal the acceptance card applies as before and shows no alert", () => {
    const onApply = vi.fn();
    const { container, getAllByRole } = render(
      <OperatorRecommendations
        recommendations={cards}
        canApply
        busy={false}
        onApply={onApply}
        onDismiss={() => {}}
        acceptanceRefusal={null}
        terminalStageId="done"
      />,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(getAllByRole("button", { name: /Apply/ })[0]!);
    expect(onApply).toHaveBeenCalledWith("r-accept");
  });
});
