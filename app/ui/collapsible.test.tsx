// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Collapsible, type Hidden } from "./collapsible";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom lays nothing out, so the fold's box reports the height given here
 * (`scrollHeight` is what the fold measures) and every other element 0.
 */
function contentHeight(px: () => number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("attach-list") ? px() : 0;
  });
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => (
    <a key={i} href={`#row-${i}`} data-row={i}>
      row {i}
    </a>
  ));

const toggle = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(".md-collapse-toggle");
const body = (container: HTMLElement) => container.querySelector<HTMLElement>(".attach-list")!;

describe("Collapsible: the comment fold, shared (ruling 314)", () => {
  it("renders short content whole, with no toggle", () => {
    contentHeight(() => 200);
    const { container } = render(
      <Collapsible className="attach-list" contentKey={3}>
        {rows(3)}
      </Collapsible>,
    );
    expect(body(container).classList.contains("clamped")).toBe(false);
    expect(body(container).style.maxHeight).toBe("");
    expect(toggle(container)).toBeNull();
  });

  it("clamps tall content at 340px behind Show more, and the toggle opens and folds it", () => {
    // CANARY: measure against 3400 instead of 340 and nothing clamps.
    contentHeight(() => 900);
    const { container } = render(
      <Collapsible className="attach-list" contentKey={20}>
        {rows(20)}
      </Collapsible>,
    );
    const box = body(container);
    expect(box.classList.contains("clamped")).toBe(true);
    expect(box.style.maxHeight).toBe("340px");
    expect(toggle(container)!.textContent).toBe("Show more");
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("false");
    // Only the view is clamped: every row is still there.
    expect(box.querySelectorAll("a")).toHaveLength(20);

    fireEvent.click(toggle(container)!);
    expect(box.classList.contains("clamped")).toBe(false);
    expect(box.style.maxHeight).toBe("");
    expect(toggle(container)!.textContent).toBe("Show less");
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle(container)!);
    expect(box.classList.contains("clamped")).toBe(true);
    expect(toggle(container)!.textContent).toBe("Show more");
  });

  it("measures again when its content changes, which a clamped box's size never shows", () => {
    // CANARY: run the measuring effect once (`[]`) and a list that grows past
    // the fold on a revalidation never clamps.
    let height = 200;
    contentHeight(() => height);
    const { container, rerender } = render(
      <Collapsible className="attach-list" contentKey={3}>
        {rows(3)}
      </Collapsible>,
    );
    expect(toggle(container)).toBeNull();
    height = 900;
    rerender(
      <Collapsible className="attach-list" contentKey={20}>
        {rows(20)}
      </Collapsible>,
    );
    expect(body(container).classList.contains("clamped")).toBe(true);
    height = 200;
    rerender(
      <Collapsible className="attach-list" contentKey={3}>
        {rows(3)}
      </Collapsible>,
    );
    expect(body(container).classList.contains("clamped")).toBe(false);
    expect(toggle(container)).toBeNull();
  });

  it("opens when keyboard focus lands under the fade, and stays folded for a row in plain sight or a pointer's focus", () => {
    // CANARY: drop the `onFocus` handler and tabbing to row 7 leaves the box
    // clamped (in Chromium the row scrolls up behind the fade).
    contentHeight(() => 900);
    // Rows are 40px apart from the top of a 340px box: rows 0-5 end above the
    // fade, which starts at 78% (265px), and row 6 ends under it.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("attach-list")) return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 340 });
      const row = Number(this.dataset.row ?? 0);
      return DOMRect.fromRect({ x: 0, y: row * 40, width: 600, height: 32 });
    });
    // jsdom has no focus-visible heuristic: say which focus came from a key.
    let keyboard = false;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? keyboard : matches.call(this, selector);
    });
    const { container } = render(
      <Collapsible className="attach-list" contentKey={20}>
        {rows(20)}
      </Collapsible>,
    );
    const row = (i: number) => container.querySelector<HTMLElement>(`[data-row="${i}"]`)!;

    // A click in the fade focuses its row too, and a pointer never opens it.
    fireEvent.focus(row(6));
    expect(body(container).classList.contains("clamped")).toBe(true);

    keyboard = true;
    // Closing an attachment's card with Escape hands focus back to its row,
    // which a browser counts as keyboard focus: a row in plain sight stays put.
    fireEvent.focus(row(5));
    expect(body(container).classList.contains("clamped")).toBe(true);

    fireEvent.focus(row(6));
    expect(body(container).classList.contains("clamped")).toBe(false);
    expect(toggle(container)!.textContent).toBe("Show less");
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("true");
  });
});

/** A fold whose state its owner holds, as a comment holds it for the pictures
 *  under its card (ruling 314). */
function Shared({ more }: { more: Hidden | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible className="attach-list" contentKey={3} open={open} onOpenChange={setOpen} more={more}>
      {rows(3)}
    </Collapsible>
  );
}

describe("Collapsible: a fold that also hides pictures outside its box (ruling 314)", () => {
  it("counts them, and shows its toggle for them when the box itself is short", () => {
    // CANARY: render the toggle for `overflowing` alone and a short comment
    // with ten screenshots has nothing that shows the six past its first row.
    contentHeight(() => 200);
    const { container, unmount } = render(<Shared more={{ count: 6, noun: "images" }} />);
    expect(body(container).classList.contains("clamped")).toBe(false);
    expect(toggle(container)!.textContent).toBe("Show 6 more images");
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle(container)!);
    expect(toggle(container)!.textContent).toBe("Show less");
    expect(toggle(container)!.getAttribute("aria-expanded")).toBe("true");
    unmount();

    // A long box says Show more, and the count rides after it.
    contentHeight(() => 900);
    const tall = render(<Shared more={{ count: 1, noun: "image" }} />);
    expect(body(tall.container).classList.contains("clamped")).toBe(true);
    expect(toggle(tall.container)!.textContent).toBe("Show more · +1 image");
  });

  it("closing keeps the toggle where it stood on screen", () => {
    // CANARY: drop the toggle's layout effect and Show less leaves it 560px
    // higher, off the top of the box that scrolls it.
    contentHeight(() => 900);
    const { container } = render(
      <div data-scroller style={{ overflowY: "auto" }}>
        <Shared more={null} />
      </div>,
    );
    const scroller = container.querySelector<HTMLElement>("[data-scroller]")!;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-scroller") ? 5000 : this.classList.contains("attach-list") ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-scroller") ? 800 : 0;
    });
    // The box starts 100px into the scroller and the toggle follows it, 8px
    // below its clamped 340px or its whole 900.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("md-collapse-toggle")) return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 0 });
      const clamped = body(container).classList.contains("clamped");
      return DOMRect.fromRect({ x: 0, y: 100 + (clamped ? 340 : 900) + 8 - scroller.scrollTop, width: 80, height: 20 });
    });
    fireEvent.click(toggle(container)!);
    // Read to the end: the toggle stands 208px down the screen.
    scroller.scrollTop = 800;
    expect(toggle(container)!.getBoundingClientRect().top).toBe(208);

    fireEvent.click(toggle(container)!);
    expect(body(container).classList.contains("clamped")).toBe(true);
    expect(scroller.scrollTop).toBe(240);
    expect(toggle(container)!.getBoundingClientRect().top).toBe(208);
  });
});
