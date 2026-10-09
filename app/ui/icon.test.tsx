// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Icon } from "./icon";

afterEach(cleanup);

/**
 * Ruling 297: the glyphs the mock drew as local SVGs (the folder, folder
 * upload, upload, pencil and pin star) are `Icon` names, and a state is its own
 * name. These pin the frame every glyph shares and the two state pairs.
 */
describe("Icon's state pairs (ruling 297)", () => {
  function draw(name: Parameters<typeof Icon>[0]["name"]) {
    const { container } = render(<Icon name={name} />);
    return container.querySelector("svg.ico")!;
  }

  it("draws every glyph in the one 24px stroke frame", () => {
    const svg = draw("starfilled");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.7");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("fills the pinned star on its path and leaves the outline star unfilled", () => {
    const outline = draw("star").querySelector("path")!;
    const filled = draw("starfilled").querySelector("path")!;
    expect(outline.getAttribute("fill")).toBeNull();
    expect(filled.getAttribute("fill")).toBe("currentColor");
    expect(filled.getAttribute("d")).toBe(outline.getAttribute("d"));
  });

  it("draws an expanded folder with its own outline", () => {
    const closed = draw("folder").querySelector("path")!.getAttribute("d");
    const open = draw("folderopen").querySelector("path")!.getAttribute("d");
    expect(open).not.toBe(closed);
    // The upload variant is the closed folder plus its arrow.
    const up = draw("folderup").querySelectorAll("path");
    expect(up).toHaveLength(2);
    expect(up[0]!.getAttribute("d")).toBe(closed);
  });
});
