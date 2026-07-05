// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./markdown";

/**
 * The GFM markdown renderer for multi-line comment content (BUG 1: agent
 * replies were rendering as a blob through the inline-only RichText). Asserts
 * real GFM structure — tables, lists, line breaks, code, links, emoji.
 */

afterEach(cleanup);

describe("Markdown", () => {
  it("renders a GFM table with rows and cells", () => {
    const { container } = render(
      <Markdown
        text={"| Col A | Col B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"}
      />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    // Header + 2 body rows.
    expect(container.querySelectorAll("thead th").length).toBe(2);
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    // Wide tables scroll inside their own container.
    expect(container.querySelector(".md-table-wrap")).not.toBeNull();
  });

  it("renders bullet and ordered lists as list elements", () => {
    const { container } = render(
      <Markdown text={"- one\n- two\n- three\n\n1. first\n2. second"} />,
    );
    expect(container.querySelectorAll("ul li").length).toBe(3);
    expect(container.querySelectorAll("ol li").length).toBe(2);
  });

  it("splits paragraphs on blank lines (real newlines, not a blob)", () => {
    const { container } = render(
      <Markdown text={"First paragraph.\n\nSecond paragraph."} />,
    );
    const paras = container.querySelectorAll("p");
    expect(paras.length).toBe(2);
    expect(paras[0]!.textContent).toBe("First paragraph.");
    expect(paras[1]!.textContent).toBe("Second paragraph.");
  });

  it("honors GFM hard line breaks within a paragraph", () => {
    // Two trailing spaces → a hard break (<br>).
    const { container } = render(<Markdown text={"line one  \nline two"} />);
    expect(container.querySelector("br")).not.toBeNull();
  });

  it("renders inline code and fenced code with the mono class", () => {
    const { container } = render(
      <Markdown text={"inline `code` here\n\n```\nblock code\n```"} />,
    );
    const codes = container.querySelectorAll("code.mono");
    expect(codes.length).toBeGreaterThanOrEqual(2);
    // A fenced block is wrapped in <pre>.
    expect(container.querySelector("pre code.mono")).not.toBeNull();
  });

  it("renders bold and italic emphasis", () => {
    const { container } = render(<Markdown text={"**bold** and *italic*"} />);
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("italic");
  });

  it("renders links opening safely in a new tab", () => {
    const { container } = render(
      <Markdown text={"see [the docs](https://example.com/docs)"} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("passes emoji (unicode) through untouched", () => {
    const { container } = render(<Markdown text={"shipped it 🚀 ✅"} />);
    expect(container.textContent).toContain("🚀");
    expect(container.textContent).toContain("✅");
  });

  it("does NOT execute raw HTML in the source (default-safe)", () => {
    const { container } = render(
      <Markdown text={"<script>alert(1)</script> and <b>x</b>"} />,
    );
    // Raw HTML is escaped/stripped, never rendered as live elements.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});
