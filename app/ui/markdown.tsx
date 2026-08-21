import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
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

/**
 * Repair an agent-written attachment reference to the serving route.
 *
 * Agents cite the files they saved from inside their WORKSPACE, so the link
 * that reaches the timeline is workspace-relative — the live shape was
 * `[page-….png](../../attachments/page-….png)`, which the browser resolves
 * against the task URL and 404s. The filename is real; only the path is from
 * the wrong world. When the href's last segment names a file this task
 * actually has AND the path is attachment-shaped (`attachments/<name>`, any
 * relative prefix, or the bare filename), it is rewritten to the member-only
 * serving route. Anything else — absolute URLs, other paths, names the task
 * does not have — passes through untouched: no guessing, same contract as the
 * evidence linkify (timeline.tsx `EvidenceLabel`).
 */
function repairAttachmentHref(
  href: string | undefined,
  attachments: ReadonlySet<string> | undefined,
  base: string | undefined,
): string | undefined {
  if (!href || !attachments || attachments.size === 0 || !base) return href;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return href; // absolute / protocol
  const segments = href.split("/");
  const name = decodeURIComponent(segments[segments.length - 1] ?? "");
  if (!name || !attachments.has(name)) return href;
  const dir = segments[segments.length - 2];
  const citesTaskAttachment = segments.length === 1 || dir === "attachments";
  return citesTaskAttachment ? `${base}/${encodeURIComponent(name)}` : href;
}

/** Click-handler factory for an attachment image (the task page passes the
 *  lightbox's own factory — attachment-lightbox.tsx — whose shape this is). */
type AttachmentImageClickFactory = (img: {
  name: string;
  url: string;
}) => (e: ReactMouseEvent<HTMLElement>) => void;

function componentsFor(
  attachments: ReadonlySet<string> | undefined,
  base: string | undefined,
  onAttachmentImageClick?: AttachmentImageClickFactory,
) {
  return {
    a({ children, href }: ComponentPropsWithoutRef<"a">) {
      return (
        <a
          href={repairAttachmentHref(href, attachments, base)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
    img({ src, alt }: ComponentPropsWithoutRef<"img">) {
      // `![…](attachments/x.png)` embeds the capture itself; the same repair
      // applies.
      // SAFETY: react-markdown builds `src` from the markdown AST's url
      // STRING — the Blob/MediaSource arms of the DOM prop type can never
      // reach a components override, so the value is a string (or absent).
      const raw = src as string | undefined;
      const url = repairAttachmentHref(raw, attachments, base);
      const image = <img src={url} alt={alt ?? ""} loading="lazy" />;
      // An embedded TASK attachment opens the in-app lightbox on click (owner
      // request 2026-08-21) — recognized by serving-route prefix, so it also
      // catches a body that wrote the route URL directly. Other images (rare;
      // external URLs render as whatever the browser loads) stay plain.
      const isTaskAttachment =
        onAttachmentImageClick && url && base && url.startsWith(base + "/");
      if (!isTaskAttachment) return image;
      const name = decodeURIComponent(url.slice(base.length + 1));
      return (
        <button
          type="button"
          className="md-img-btn"
          aria-label={`Open attachment ${name}`}
          onClick={onAttachmentImageClick({ name, url })}
        >
          {image}
        </button>
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
}

const DEFAULT_COMPONENTS = componentsFor(undefined, undefined);

export function Markdown({
  text,
  mentionNames,
  attachmentNames,
  attachmentsBase,
  onAttachmentImageClick,
}: {
  text: string;
  /** Known mentionable names, so a multi-word "@Arda Kaya" chips as one span. */
  mentionNames?: string[];
  /** The surrounding task's REAL attachment filenames — enables rewriting
   *  agent-written workspace-relative attachment links to the serving route.
   *  Absent (every non-task surface) ⇒ links render exactly as written. */
  attachmentNames?: ReadonlySet<string>;
  /** The task's attachment route base (`…/tasks/<KEY>/attachments`). */
  attachmentsBase?: string;
  /** Opens an embedded attachment image in the task page's lightbox — pass
   *  `useAttachmentLightbox()`'s factory. Absent ⇒ embeds are plain images. */
  onAttachmentImageClick?: AttachmentImageClickFactory;
}): ReactNode {
  const components =
    attachmentNames && attachmentNames.size > 0 && attachmentsBase
      ? componentsFor(attachmentNames, attachmentsBase, onAttachmentImageClick)
      : DEFAULT_COMPONENTS;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeMentions, mentionNames ?? []]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
