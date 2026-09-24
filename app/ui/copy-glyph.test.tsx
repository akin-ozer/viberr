// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CopyGlyph, GlyphSwap } from "./copy-glyph";
import { Icon, type IconName } from "./icon";

afterEach(cleanup);

/** The path markup a glyph renders, to tell two `svg.ico`s apart. */
const glyph = (name: IconName) => {
  const { container, unmount } = render(<Icon name={name} />);
  const inner = container.querySelector("svg")!.innerHTML;
  unmount();
  return inner;
};

/**
 * Ruling 459 (extending ruling 451(c)): a glyph that trades with its
 * control's state keeps both marks drawn in one cell, and only `data-copied`
 * changes, so the sheet can cross-fade them. A ternary on the icon name
 * swapped them in one frame.
 */
describe("ruling 459: GlyphSwap keeps both glyphs and flips one attribute", () => {
  it("draws the resting mark first and the alternate last, and trades them on `on`", () => {
    // CANARY: render `<Icon name={on ? alt : rest} />` alone and the cell
    // holds one glyph, remounted on every change.
    const { container, rerender } = render(<GlyphSwap rest="plus" alt="loader" on={false} spinAlt />);
    const cell = container.querySelector(".copy-glyph")!;
    expect(cell.getAttribute("aria-hidden")).toBe("true");
    expect(cell.hasAttribute("data-copied")).toBe(false);
    const [first, last] = [...cell.children];
    expect(cell.children).toHaveLength(2);
    expect(first!.innerHTML).toBe(glyph("plus"));
    expect(last!.innerHTML).toBe(glyph("loader"));

    rerender(<GlyphSwap rest="plus" alt="loader" on spinAlt />);
    expect(cell.getAttribute("data-copied")).toBe("true");
    // Nothing remounted: the same two nodes carry the trade.
    expect(container.querySelector(".copy-glyph")).toBe(cell);
    expect([...cell.children]).toEqual([first, last]);

    rerender(<GlyphSwap rest="plus" alt="loader" on={false} spinAlt />);
    expect(cell.hasAttribute("data-copied")).toBe(false);
  });

  it("spins the alternate for good under `spinAlt`, so the sheet can pause it rather than reset it", () => {
    // CANARY: spin only while `on` (`className={spinAlt && on ? "spin" : ""}`)
    // and the leaving loader drops its turn on the first frame of its exit.
    const { container, rerender } = render(<GlyphSwap rest="check" alt="loader" on={false} spinAlt />);
    const loader = container.querySelector(".copy-glyph > :last-child")!;
    expect(loader.matches("svg.ico.spin")).toBe(true);
    rerender(<GlyphSwap rest="check" alt="loader" on spinAlt />);
    expect(loader.matches("svg.ico.spin")).toBe(true);
    // The resting mark never spins, and neither glyph does without the flag.
    expect(container.querySelector(".copy-glyph > :first-child")!.matches(".spin")).toBe(false);
    rerender(<GlyphSwap rest="shield" alt="clock" on />);
    expect(container.querySelector(".copy-glyph .spin")).toBeNull();
  });

  it("CopyGlyph is the copy mark trading for the check", () => {
    const { container } = render(<CopyGlyph copied />);
    const cell = container.querySelector(".copy-glyph")!;
    expect(cell.getAttribute("data-copied")).toBe("true");
    expect(cell.firstElementChild!.innerHTML).toBe(glyph("copy"));
    expect(cell.lastElementChild!.innerHTML).toBe(glyph("check"));
  });
});
