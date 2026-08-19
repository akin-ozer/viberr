import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { findMentionSpans } from "./mention-spans";

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

/**
 * The hast node kinds this pass walks. Declared here rather than imported from
 * `hast`: that module is types-only and reaches us solely through react-markdown's
 * hoisted tree, which the C6 hermeticity guard rejects as an undeclared import.
 * Modelling every kind as a discriminated member is what keeps the walk
 * assertion-free — `child.type` narrows on its own.
 */
interface MentionChipProperties {
  className: string[];
}
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties?: MentionChipProperties;
  children: HastNode[];
}
/** The kinds this pass never descends into or rewrites. (Union ordered with
 *  `doctype` first so this declaration is not mistaken for a timeline-event
 *  construction by the NEW-4 comment-writer scan in mention-notify.server.test.ts.) */
interface HastLeaf {
  type: "doctype" | "comment";
}
type HastNode = HastText | HastElement | HastLeaf;
interface HastRoot {
  type: "root";
  children: HastNode[];
}

/**
 * Split a text value into text nodes + `.mention` span elements, using the
 * shared span-finder so a KNOWN multi-word name ("@Arda Kaya") chips as one
 * span (falling back to the `@word` token). Returns null when the value has no
 * mention at all — the caller then leaves the node as-is. (A returned array of
 * length 1 is legitimate: a text node that is ENTIRELY a mention chips to a
 * single span.)
 */
function chipMentions(value: string, names: string[]): HastNode[] | null {
  // Only KNOWN handles chip. An unknown `@handle` routes to nobody, so chipping
  // it told the author their tag had landed when it hadn't (P13-LV-12).
  const spans = findMentionSpans(value, names).filter((s) => s.known);
  if (spans.length === 0) return null;
  const out: HastNode[] = [];
  let last = 0;
  for (const { start, end } of spans) {
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    // P16-UI-20: colour + background is the chip's ONLY distinction from the
    // prose around it, so "@Selin" read identically to the word "Selin". A
    // visually-hidden word in front carries it to AT. It is a SIBLING of the
    // chip, not a child: `.mention`'s text content stays exactly the span the
    // shared matcher produced. `.mention-vh` is `user-select: none`, so copying
    // a comment still yields the author's text.
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["mention-vh"] },
      children: [{ type: "text", value: "mention " }],
    });
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["mention"] },
      children: [{ type: "text", value: value.slice(start, end) }],
    });
    last = end;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** rehype plugin factory: re-chip @mentions in text nodes (skipping code/pre),
 *  matching known `names` as whole units. */
function rehypeMentions(names: string[] = []) {
  return function transform(tree: HastRoot) {
    walk(tree.children);
  };
  function walk(children: HastNode[]) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "element") {
        // Leave code samples literal — a `@foo` in code is not a mention.
        if (child.tagName === "code" || child.tagName === "pre") continue;
        walk(child.children);
      } else if (child.type === "text") {
        if (child.value.indexOf("@") === -1) continue;
        const parts = chipMentions(child.value, names);
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

export function Markdown({
  text,
  mentionNames,
}: {
  text: string;
  /** Known mentionable names, so a multi-word "@Arda Kaya" chips as one span. */
  mentionNames?: string[];
}): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeMentions, mentionNames ?? []]]}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
}
