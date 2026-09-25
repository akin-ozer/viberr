// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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

describe("ruling 478(f): headings under a page heading (F40-35)", () => {
  const levels = (root: HTMLElement) =>
    [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => h.tagName);

  it("renders headings as written by default", () => {
    const { container } = render(<Markdown text={"# One\n\n## Two"} />);
    expect(levels(container)).toEqual(["H1", "H2"]);
  });

  it("puts the text's top heading at the base, keeps the steps below it, and stops at h6", () => {
    // CANARY: skip the depth rewrite in `remarkHeadingBase`.
    const { container } = render(
      <Markdown text={"## Part\n\n### Step\n\n> ## Quoted part\n\n###### Deepest"} headingBase={3} />,
    );
    expect(levels(container)).toEqual(["H3", "H4", "H3", "H6"]);
  });

  it("re-renders when only the base changes (the memo compares it)", () => {
    // CANARY: drop `headingBase` from `sameMarkdownProps`.
    const view = render(<Markdown text={"# Title"} />);
    expect(levels(view.container)).toEqual(["H1"]);
    view.rerender(<Markdown text={"# Title"} headingBase={3} />);
    expect(levels(view.container)).toEqual(["H3"]);
  });
});

describe("attachment link repair (owner ask 2026-08-20)", () => {
  const BASE = "/projects/p/tasks/T-1/attachments";
  const props = {
    attachmentNames: new Set(["shot.png", "notes.yml"]),
    attachmentsBase: BASE,
  };

  it("F32-5 (pass 32): a malformed percent-escape never throws mid-render — links, images and the broken-image label", () => {
    // Live: one hand-typed "%zz" in an attachments link dropped the WHOLE task
    // page to the error boundary. Canary: put `decodeURIComponent` back at any
    // of the three call sites in markdown.tsx.
    const text =
      "before [bad](attachments/sh%zzot.png) " +
      `![img](${BASE}/sh%zzot.png) ` +
      "[ok](attachments/notes.yml) after";
    const { container } = render(<Markdown text={text} {...props} />);
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
    // The undecodable name is NOT an attachment reference: the href stays as written.
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("attachments/sh%zzot.png");
    expect(hrefs).toContain(`${BASE}/notes.yml`);
  });

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

  it("does NOT nest an image-button inside a link (axe nested-interactive)", () => {
    // `[![alt](attachments/x)](url)` would otherwise render the `.md-img-btn`
    // <button> (added for the lightbox) inside the <a> — a nested-interactive
    // a11y violation. The link is the interactive element; the image renders
    // plain inside it. Canary: drop the `a`-override unwrap and this goes red.
    const { container } = render(
      <Markdown
        text={"[![shot](attachments/shot.png)](https://example.com/full)"}
        {...props}
        onAttachmentOpen={() => () => {}}
      />,
    );
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/full");
    // No <button> anywhere (neither inside the anchor nor in the tree).
    expect(container.querySelector("button")).toBeNull();
    // The image still renders inside the anchor, src repaired.
    expect(anchor.querySelector("img")!.getAttribute("src")).toBe(
      `${BASE}/shot.png`,
    );
  });

  it("still makes a standalone attachment image a lightbox button", () => {
    const { container } = render(
      <Markdown
        text={"![shot](attachments/shot.png)"}
        {...props}
        onAttachmentOpen={() => () => {}}
      />,
    );
    // A bare embedded attachment (not inside a link) keeps its lightbox button.
    const btn = container.querySelector("button.md-img-btn");
    expect(btn).toBeTruthy();
    expect(btn!.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/shot.png`);
  });

  it("degrades a failed embedded attachment image to a placeholder (broken-tile fix, 3rd surface)", () => {
    const { container } = render(
      <Markdown
        text={"![shot](attachments/shot.png)"}
        {...props}
        onAttachmentOpen={() => () => {}}
      />,
    );
    fireEvent.error(container.querySelector<HTMLImageElement>("img")!);
    // The broken <img>/button is replaced by the same labeled placeholder the
    // timeline and side-panel tiles use, instead of a browser broken glyph.
    expect(container.querySelector("img")).toBeNull();
    const broken = container.querySelector(".attach-broken.md-img-broken")!;
    expect(broken.getAttribute("aria-label")).toContain("preview unavailable");
  });

  it("renders links exactly as written when the surface passes no attachments", () => {
    const { container } = render(
      <Markdown text={"[a](../../attachments/shot.png)"} />,
    );
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      "../../attachments/shot.png",
    );
  });

  it("U39-29: links the task keys it was given, in the same tab, and leaves the rest as text", () => {
    // CANARY: drop `rehypeTaskLinks` from the plugin list and nothing links.
    const { container } = render(
      <MemoryRouter>
        <Markdown
          text={"Created AX-33 and AX-34. AX-99 is unknown, `AX-33` is code, and [AX-34](https://x.test) is a link already."}
          taskLinks={{ "AX-33": "/projects/ax-clone/tasks/AX-33", "AX-34": "/projects/ax-clone/tasks/AX-34" }}
        />
      </MemoryRouter>,
    );
    const refs = [...container.querySelectorAll("a.task-ref")];
    expect(refs.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["AX-33", "/projects/ax-clone/tasks/AX-33"],
      ["AX-34", "/projects/ax-clone/tasks/AX-34"],
    ]);
    // Same tab: a task is a page of this app.
    expect(refs.every((a) => !a.hasAttribute("target"))).toBe(true);
    expect(container.textContent).toContain("AX-99 is unknown");
    expect(container.querySelector("code")!.textContent).toBe("AX-33");
    expect(container.querySelector("a:not(.task-ref)")!.getAttribute("href")).toBe("https://x.test");
  });
});

describe("re-rendering a live page", () => {
  /**
   * A task page re-renders on every console line of its running agent and on
   * every revalidation, and a revalidation hands it NEW loader objects with the
   * same content. Each of those used to re-run the remark/rehype pipeline for
   * every comment, and — with attachments — to remount every link, image and
   * code block, because `componentsFor` built fresh component types per render.
   */
  it("keeps the rendered elements when the content has not changed", () => {
    const BASE = "/projects/p/tasks/T-1/attachments";
    const text = "see [shot](attachments/shot.png) and `code` and TP-2";
    const view = (names: string[], links: Record<string, string>) => (
      <MemoryRouter>
        <Markdown
          text={text}
          mentionNames={["Arda Kaya"]}
          taskLinks={links}
          attachmentNames={new Set(names)}
          attachmentsBase={BASE}
        />
      </MemoryRouter>
    );
    const { container, rerender } = render(view(["shot.png"], { "TP-2": "/projects/p/tasks/TP-2" }));
    const link = container.querySelector(`a[href="${BASE}/shot.png"]`);
    const code = container.querySelector("code");
    expect(link).not.toBeNull();

    // Equal content, every object new — what a revalidation delivers.
    // CANARY: drop `sameMarkdownProps` from the `memo` call and both nodes are
    // replaced (new component types remount them).
    rerender(view(["shot.png"], { "TP-2": "/projects/p/tasks/TP-2" }));
    expect(container.querySelector(`a[href="${BASE}/shot.png"]`)).toBe(link);
    expect(container.querySelector("code")).toBe(code);

    // A change elsewhere in the comment re-renders it, but its attachment-aware
    // elements keep their component types, so the code block is not remounted.
    // CANARY: key the `components` memo on the Set's identity (the timeline
    // passes a new one on every page render) and this node is replaced.
    rerender(view(["shot.png"], { "TP-2": "/projects/p/tasks/TP-2?v2" }));
    expect(container.querySelector("a.task-ref")!.getAttribute("href")).toBe(
      "/projects/p/tasks/TP-2?v2",
    );
    expect(container.querySelector("code")).toBe(code);

    // A real change still renders: the attachment is gone, so the link is
    // left as the agent wrote it.
    rerender(view([], { "TP-2": "/projects/p/tasks/TP-2" }));
    expect(container.querySelector(`a[href="${BASE}/shot.png"]`)).toBeNull();
    expect(container.querySelector('a[href="attachments/shot.png"]')).not.toBeNull();
    // And a changed task link re-renders the key.
    rerender(view([], { "TP-2": "/projects/p/tasks/TP-2?moved" }));
    expect(container.querySelector("a.task-ref")!.getAttribute("href")).toBe(
      "/projects/p/tasks/TP-2?moved",
    );
  });
});
