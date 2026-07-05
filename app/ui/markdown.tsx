import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Real GFM markdown renderer for MULTI-LINE comment content (agent replies AND
 * user comments) — the counterpart to the inline-only `RichText`
 * micro-format renderer (bold/code/@mention on a single line).
 *
 * Agent replies are genuine markdown (paragraphs, hard/soft line breaks,
 * bullet/ordered lists, tables, headings, fenced/inline code, links, emoji)
 * so rendering them through `RichText` collapsed everything into one blob.
 * This component runs react-markdown with `remark-gfm` and NO raw HTML (the
 * react-markdown default is HTML-safe — raw HTML in the source is escaped, not
 * executed), so it is safe for untrusted agent/user text.
 *
 * Design-system integration:
 *  - wrap the output in `.md-body` (spacing/typography tokens live in app.css).
 *  - `code` → `className="mono"` (the shared mono chip look).
 *  - `table` is wrapped in an `overflow-x:auto` container so wide tables scroll
 *    rather than blowing out the comment card / page width.
 *  - links open in a new tab with `rel="noopener noreferrer"`.
 *
 * @mention handling: switching comments from `RichText` to this GFM renderer
 * dropped the `@mention` chip (markdown's AST has no mention concept). We
 * restore it with a tiny rehype pass (`rehypeMentions`) that splits plain text
 * nodes on the same mention grammar the server uses and wraps each hit in the
 * shared `.mention` chip — WITHOUT touching text inside `code`/`pre`, so a `@`
 * in a code sample stays literal. Everything else (bold/lists/tables/emoji)
 * flows through react-markdown untouched.
 */

// Mirrors the server's MENTION_RE (mention-suggestions) and RichText: a letter
// start, then word chars / hyphens. Non-global here — we exec-loop our own.
const MENTION_RE = /@[A-Za-z][\w-]*/g;

// Minimal hast node shapes we touch (react-markdown's tree post mdast→hast).
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/**
 * Split a text value into text nodes + `.mention` span elements. Returns null
 * when the value has no mention at all — the caller then leaves the node as-is.
 * (A returned array of length 1 is legitimate: a text node that is ENTIRELY a
 * mention, e.g. a table cell `@codex`, chips to a single span.)
 */
function chipMentions(value: string): HastNode[] | null {
  const out: HastNode[] = [];
  let last = 0;
  let found = false;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(value))) {
    found = true;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["mention"] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (!found) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** rehype plugin: re-chip @mentions in text nodes, skipping code/pre subtrees. */
function rehypeMentions() {
  return function transform(tree: HastNode) {
    walk(tree);
  };
  function walk(node: HastNode) {
    const children = (node as HastElement).children;
    if (!Array.isArray(children)) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "element") {
        const tag = (child as HastElement).tagName;
        // Leave code samples literal — a `@foo` in code is not a mention.
        if (tag === "code" || tag === "pre") continue;
        walk(child);
      } else if (child.type === "text") {
        const value = (child as HastText).value;
        if (value.indexOf("@") === -1) continue;
        const parts = chipMentions(value);
        if (parts) {
          children.splice(i, 1, ...parts);
          i += parts.length - 1;
        }
      }
    }
  }
}

const COMPONENTS = {
  a({ children, href }: ComponentPropsWithoutRef<"a">) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  code({ children, className }: ComponentPropsWithoutRef<"code">) {
    // Inline code and fenced-block code both flow through here; the block case
    // is wrapped in <pre> by react-markdown, so a single mono class covers both.
    return <code className={"mono" + (className ? " " + className : "")}>{children}</code>;
  },
  table({ children }: ComponentPropsWithoutRef<"table">) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
} as const;

export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeMentions]}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
}
