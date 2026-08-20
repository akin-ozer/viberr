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

  it("labels every chip for screen readers without changing what is on screen (P16-UI-20)", () => {
    // Colour + background was the chip's ONLY distinction from the prose around
    // it, so "@Selin" read exactly like the word "Selin". The label is a
    // SIBLING of the chip, so `.mention`'s own text stays the literal mention.
    const { container } = render(
      <Markdown text={"thanks @dev and @operator"} mentionNames={["dev"]} />,
    );
    const labels = [...container.querySelectorAll(".mention-vh")];
    expect(labels.map((n) => n.textContent)).toEqual(["mention ", "mention "]);
    for (const label of labels) {
      expect(label.nextElementSibling!.className).toBe("mention");
    }
    // SAFETY: `cloneNode` is declared on `Node` and typed as returning one, but a
    // deep clone is always an instance of the interface it was taken from — and
    // `container` is the HTMLElement testing-library rendered into.
    const clone = container.cloneNode(true) as HTMLElement;
    for (const vh of clone.querySelectorAll(".mention-vh")) vh.remove();
    expect(clone.textContent).toBe("thanks @dev and @operator");
  });

  it("chips a KNOWN multi-word name as one .mention span", () => {
    const { container } = render(
      <Markdown text={"thanks @Arda Kaya for the review"} mentionNames={["Arda Kaya"]} />,
    );
    const chips = [...container.querySelectorAll("span.mention")].map((n) => n.textContent);
    expect(chips).toEqual(["@Arda Kaya"]); // the whole name, not just "@Arda"
    expect(container.textContent).toContain("for the review");
  });

  it("re-chips @mentions inside comment text as .mention spans", () => {
    // Regression: switching comments from RichText to GFM dropped the chip.
    // P13-LV-12: only handles that actually route chip, so the agent's name is
    // passed in; `@operator` is a reserved handle and always routes.
    const { container } = render(
      <Markdown text={"thanks @dev — please loop in @operator"} mentionNames={["dev"]} />,
    );
    const chips = [...container.querySelectorAll("span.mention")].map(
      (n) => n.textContent,
    );
    expect(chips).toEqual(["@dev", "@operator"]);
    // Surrounding prose is preserved.
    expect(container.textContent).toContain("please loop in");
  });

  it("chips mentions inside list items and table cells too", () => {
    const { container } = render(
      <Markdown
        text={"- assigned to @dev\n\n| who |\n| --- |\n| @codex |"}
        mentionNames={["dev"]}
      />,
    );
    const chips = [...container.querySelectorAll("span.mention")].map(
      (n) => n.textContent,
    );
    expect(chips).toContain("@dev");
    expect(chips).toContain("@codex");
  });

  it("does NOT chip an @ inside code (stays literal)", () => {
    const { container } = render(
      <Markdown text={"run `deploy @prod` now\n\n```\nssh @host\n```"} />,
    );
    // No mention chips anywhere — both @s live inside code.
    expect(container.querySelector("span.mention")).toBeNull();
    expect(container.textContent).toContain("@prod");
    expect(container.textContent).toContain("@host");
  });
});

describe("attachment link repair (owner ask 2026-08-20)", () => {
  const BASE = "/projects/p/tasks/T-1/attachments";
  const props = {
    attachmentNames: new Set(["shot.png", "notes.yml"]),
    attachmentsBase: BASE,
  };

  it("rewrites attachment-shaped relative hrefs whose filename is real", () => {
    const { container } = render(
      <Markdown
        text={
          "[a](../../attachments/shot.png) [b](attachments/notes.yml) [c](shot.png)"
        }
        {...props}
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      `${BASE}/shot.png`,
      `${BASE}/notes.yml`,
      `${BASE}/shot.png`,
    ]);
  });

  it("never touches absolute URLs, foreign paths, or unknown names", () => {
    const { container } = render(
      <Markdown
        text={
          "[a](https://example.com/attachments/shot.png) " +
          "[b](../../src/shot.png) [c](attachments/missing.png)"
        }
        {...props}
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "https://example.com/attachments/shot.png",
      "../../src/shot.png",
      "attachments/missing.png",
    ]);
  });

  it("repairs an embedded image the same way", () => {
    const { container } = render(
      <Markdown text={"![the capture](../../attachments/shot.png)"} {...props} />,
    );
    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      `${BASE}/shot.png`,
    );
    expect(container.querySelector("img")!.getAttribute("alt")).toBe(
      "the capture",
    );
  });

  it("renders links exactly as written when the surface passes no attachments", () => {
    const { container } = render(
      <Markdown text={"[a](../../attachments/shot.png)"} />,
    );
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      "../../attachments/shot.png",
    );
  });
});
