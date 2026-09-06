// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentGlyph } from "./identity";

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
        <AgentGlyph op lg />
        <AgentGlyph backend="anything-else" />
      </>,
    );
    const [op, codex] = [...container.querySelectorAll(".agent-glyph")];
    expect(op.getAttribute("aria-label")).toBe("Operator");
    expect(op.className).toBe("agent-glyph op lg");
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
