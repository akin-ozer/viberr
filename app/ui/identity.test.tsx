// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentGlyph, IconTile } from "./identity";

afterEach(cleanup);

/**
 * Interface review 2026-09-06: the glyph named itself by `title` alone, which
 * no screen reader used as a name, and beside the printed backend name a card
 * read "Codex Codex". By default it is an image with a real name; a caller
 * that prints the name beside it renders it decorative.
 */
describe("AgentGlyph", () => {
  it("is a named image by default", () => {
    const { container } = render(<AgentGlyph backend="claude" />);
    const glyph = container.querySelector(".agent-glyph")!;
    expect(glyph.getAttribute("role")).toBe("img");
    expect(glyph.getAttribute("aria-label")).toBe("Claude");
    expect(glyph.className).toBe("agent-glyph claude");
  });

  it("names the operator shield and the codex fallback", () => {
    const { container } = render(
      <>
        <AgentGlyph op />
        <AgentGlyph backend="anything-else" />
      </>,
    );
    const [op, codex] = [...container.querySelectorAll(".agent-glyph")];
    expect(op.getAttribute("aria-label")).toBe("Operator");
    expect(op.className).toBe("agent-glyph op");
    expect(codex.getAttribute("aria-label")).toBe("Codex");
  });

  it("leaves the accessibility tree when the name is printed beside it", () => {
    const { container } = render(<AgentGlyph backend="codex" decorative />);
    const glyph = container.querySelector(".agent-glyph")!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.getAttribute("role")).toBeNull();
    expect(glyph.getAttribute("aria-label")).toBeNull();
    expect(glyph.getAttribute("title")).toBeNull();
  });
});

/**
 * Phase 1 (2026-09-08): `.agent-glyph.warn` had a CSS rule and no component,
 * so the release-ownership dialog hand-wrote the medallion's markup — a second
 * copy of AgentGlyph's shape that no prop could reach. IconTile is that shape
 * with a name; AgentGlyph is now one of its callers.
 */
describe("IconTile", () => {
  it("draws the warn tone the release dialog needs", () => {
    const { container } = render(<IconTile tone="warn" icon="hand" lg />);
    const tile = container.querySelector(".agent-glyph")!;
    expect(tile.className).toBe("agent-glyph warn lg");
    // No label passed: decorative, because the dialog's own heading says it.
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.querySelector("svg.ico")).toBeTruthy();
  });

  it("makes the same aria decision AgentGlyph does", () => {
    const { container } = render(<IconTile tone="op" icon="shield" label="Operator" />);
    const tile = container.querySelector(".agent-glyph")!;
    expect(tile.getAttribute("role")).toBe("img");
    expect(tile.getAttribute("aria-label")).toBe("Operator");
    expect(tile.getAttribute("title")).toBe("Operator");
  });
});
