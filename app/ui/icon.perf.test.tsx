// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Icon, type IconName } from "./icon";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { observeMutations } from "../../test-support/render-counter";

/**
 * Ruling 457 (TASK-8 / LIVE-6 / BOARD-4 / CTL-5): an icon that re-renders with
 * the same name must not touch the DOM. React 19 compares
 * `dangerouslySetInnerHTML` by the identity of its `{__html}` object, and a new
 * object on each render made every re-render re-parse the SVG's markup and
 * replace its children: 60 per task-page render, 133 per board revalidation,
 * 21 per dock update.
 *
 * Fixture: twelve icons the board, the task page and the dock draw, under a
 * parent that re-renders with nothing changed.
 */

afterEach(cleanup);

const NAMES: IconName[] = [
  "board", "plus", "pr", "branch", "check", "clock",
  "alert", "x", "chevron", "cpu", "refresh", "dot",
];

function renderIcons() {
  let rerender: () => void = () => {};
  function Parent() {
    const [n, setN] = useState(0);
    rerender = () => setN((v) => v + 1);
    return (
      <div data-n={n}>
        {NAMES.map((name) => (
          <Icon key={name} name={name} className="sm" />
        ))}
      </div>
    );
  }
  const utils = render(<Parent />);
  return { ...utils, rerender: () => act(() => rerender()) };
}

describe("Icon re-renders (ruling 457)", () => {
  it("draws each glyph's markup, and the dot for a name it does not know", () => {
    // SAFETY: a bad cast from free-form data is exactly the case the runtime
    // fallback exists for.
    const unknownName = "nope" as IconName;
    const { container } = render(
      <>
        <Icon name="plus" />
        <Icon name={unknownName} />
      </>,
    );
    const [plus, unknown] = container.querySelectorAll("svg.ico");
    expect(plus!.innerHTML).toBe('<path d="M12 5v14M5 12h14"></path>');
    expect(unknown!.innerHTML).toBe('<circle cx="12" cy="12" r="4"></circle>');
  });

  it("a re-render with the same names writes nothing to the icons", () => {
    const view = renderIcons();
    const dom = observeMutations(view.container);
    view.rerender();
    const writes = dom.take().filter((r) => r.target.nodeName === "svg");
    expect(view.container.querySelectorAll("svg.ico")).toHaveLength(NAMES.length);
    expectWithinBudget("render:icon.dom-writes-per-rerender", writes.length);
  });
});
