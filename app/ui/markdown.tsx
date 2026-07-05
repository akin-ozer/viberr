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
 * @mention handling: mentions inside a comment are left as PLAIN TEXT (the
 * markdown AST has no mention concept, and a rehype pass to re-chip them is not
 * worth the surface here). The single-line typed events keep `RichText`, which
 * still renders the `@mention` chip. Documented in fix-agent-logs-ui.md.
 */

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
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}
