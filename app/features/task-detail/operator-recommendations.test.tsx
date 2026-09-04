import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
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
