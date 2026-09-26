import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { createContext, memo, useContext, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import { PROPOSAL_ID_IN_TEXT_RE, TASK_KEY_IN_TEXT_RE, type TaskLinks } from "~/shared/task-key-links";

/** What a text can link through its {@link TaskLinks}: task keys, and the
 *  proposal ids a page showing them resolved to their entries. */
const LINKABLE_IN_TEXT_RE = new RegExp(`${TASK_KEY_IN_TEXT_RE.source}|${PROPOSAL_ID_IN_TEXT_RE.source}`, "g");
import { Icon } from "./icon";

/**
 * Set while rendering a link's content so the `img` override can skip its
 * lightbox <button> for an image WRAPPED IN A LINK (`[![alt](x)](url)`) —
 * a <button> inside an <a> is a nested-interactive a11y violation. react-markdown
 * applies the `img` override at RENDER time, inside the `a` override's subtree,
 * so this context reaches it (detecting the rendered button from `a`'s children
 * cannot: at that point the child is still a bare <img>).
 */
const MarkdownInsideLink = createContext(false);
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
  /** Set on a task link (U39-29). */
  href?: string;
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
 * U39-29: split a text value into text nodes and links for the task keys the
 * page resolved (`links`, key to path). Null when it names none of them.
 */
function linkTaskKeys(value: string, links: TaskLinks): HastNode[] | null {
  const out: HastNode[] = [];
  let last = 0;
  for (const match of value.matchAll(LINKABLE_IN_TEXT_RE)) {
    const key = match[0];
    const href = Object.hasOwn(links, key) ? links[key] : undefined;
    if (!href) continue;
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    out.push({
      type: "element",
      tagName: "a",
      properties: { className: [/^k[pc]-/.test(key) ? "kp-ref" : "task-ref"], href },
      children: [{ type: "text", value: key }],
    });
    last = match.index + key.length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** rehype plugin factory: link the resolved task keys in text nodes, leaving
 *  code, preformatted blocks and existing links alone. */
function rehypeTaskLinks(links: TaskLinks = {}) {
  return function transform(tree: HastRoot) {
    walk(tree.children);
  };
  function walk(children: HastNode[]) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "element") {
        if (child.tagName === "code" || child.tagName === "pre" || child.tagName === "a") continue;
        walk(child.children);
      } else if (child.type === "text") {
        const parts = linkTaskKeys(child.value, links);
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
  // F32-5 (pass 32): a malformed percent-escape in a hand-written link
  // ("%zz") threw here mid-render and dropped the WHOLE task page to the error
  // boundary. An undecodable name is simply not an attachment reference.
  const name = safeDecodeName(segments[segments.length - 1] ?? "");
  if (!name || !attachments.has(name)) return href;
  const dir = segments[segments.length - 2];
  const citesTaskAttachment = segments.length === 1 || dir === "attachments";
  return citesTaskAttachment ? `${base}/${encodeURIComponent(name)}` : href;
}

/** A percent-escape an author wrote by hand can be malformed ("%zz"), and
 *  `decodeURIComponent` THROWS on it — mid-render. Null, not a crash. */
function safeDecodeName(rest: string): string | null {
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** Click-handler factory for an attachment (the task page passes the lightbox
 *  factory — attachment-lightbox.tsx — whose shape this is). Every kind opens
 *  the card (ruling 105 + addendum): images the lightbox, viewable text files
 *  the read-only viewer, anything else a no-preview note with Download. */
type AttachmentOpenFactory = (att: {
  name: string;
  url: string;
}) => (e: ReactMouseEvent<HTMLElement>) => void;

/** The `img` override, as a real component so it can read the inside-link
 *  context. A task attachment opens the in-app lightbox on click (owner request
 *  2026-08-21) — recognized by serving-route prefix, so it also catches a body
 *  that wrote the route URL directly. Other images (rare; external URLs render
 *  as whatever the browser loads) stay plain, AND so does an attachment WRAPPED
 *  IN A LINK: the lightbox <button> would nest in the <a> (nested-interactive),
 *  so there the image stays plain and the link owns the click. */
function MarkdownImg({
  src,
  alt,
  attachments,
  base,
  onAttachmentOpen,
}: {
  src?: string;
  alt?: string;
  attachments: ReadonlySet<string> | undefined;
  base: string | undefined;
  onAttachmentOpen?: AttachmentOpenFactory;
}) {
  const insideLink = useContext(MarkdownInsideLink);
  const [failed, setFailed] = useState(false);
  const url = repairAttachmentHref(src, attachments, base);
  const isTaskAttachment =
    onAttachmentOpen && url && base && url.startsWith(base + "/");
  // A task attachment can fail to serve — rotated/removed off disk (404), over
  // the route's 50 MB inline cap (413), or an unsupported type — so it degrades
  // to the same labeled placeholder the timeline/panel tiles use instead of a
  // broken-image glyph. An external image stays as the browser renders it (the
  // author's own link, out of scope).
  if (isTaskAttachment && failed) {
    // F32-5: the label falls back to the raw tail when the escape is malformed.
    const name = safeDecodeName(url.slice(base.length + 1)) ?? url.slice(base.length + 1);
    return (
      <span
        className="attach-broken md-img-broken"
        role="img"
        aria-label={`${alt || name} (preview unavailable)`}
      >
        <Icon name="file" />
        <span className="attach-broken-note">preview unavailable</span>
      </span>
    );
  }
  const image = (
    <img
      src={url}
      alt={alt ?? ""}
      loading="lazy"
      {...(isTaskAttachment ? { onError: () => setFailed(true) } : {})}
    />
  );
  if (!isTaskAttachment || insideLink) return image;
  const name = safeDecodeName(url.slice(base.length + 1)) ?? url.slice(base.length + 1);
  return (
    <button
      type="button"
      className="md-img-btn"
      aria-label={`Open attachment ${name}`}
      onClick={onAttachmentOpen({ name, url })}
    >
      {image}
    </button>
  );
}

function componentsFor(
  attachments: ReadonlySet<string> | undefined,
  base: string | undefined,
  onAttachmentOpen?: AttachmentOpenFactory,
) {
  return {
    a({ children, href, className }: ComponentPropsWithoutRef<"a">) {
      // U39-29: a task the text names is a page of this app, so it opens here
      // with client navigation. A new tab per task would also hold two more
      // live-event streams against the browser's six-per-origin limit.
      if (className === "task-ref" && href) {
        return (
          <Link to={href} className="task-ref">
            {children}
          </Link>
        );
      }
      // A proposal or correction id jumps to its entry on this page (the
      // Controller page's Knowledge base panel), so it is a plain in-page
      // anchor, never a new tab.
      if (className === "kp-ref" && href) {
        return (
          <a href={href} className="kp-ref">
            {children}
          </a>
        );
      }
      // Mark the subtree so a nested attachment image renders WITHOUT its
      // lightbox <button> (a <button> inside this <a> is nested-interactive).
      // The link is the interactive element.
      const repaired = repairAttachmentHref(href, attachments, base);
      // Ruling 105 (+ addendum): a link to a task attachment opens the in-app
      // card on a plain click, whatever the kind. Only a CLEAN single-segment
      // suffix of the base is intercepted — an author-written URL carrying a
      // query, fragment, nested path, or malformed percent-escape would derive
      // a wrong (or throwing) attachment name, so those keep the plain anchor.
      // Modified clicks always keep the browser's own behavior;
      // non-attachment links are never intercepted.
      const rest =
        repaired && base && repaired.startsWith(base + "/")
          ? repaired.slice(base.length + 1)
          : "";
      const attachmentName =
        rest && !/[/?#]/.test(rest) ? safeDecodeName(rest) : null;
      return (
        <a
          href={repaired}
          target="_blank"
          rel="noopener noreferrer"
          {...(onAttachmentOpen && attachmentName && repaired
            ? {
                onClick: onAttachmentOpen({
                  name: attachmentName,
                  url: repaired,
                }),
              }
            : {})}
        >
          <MarkdownInsideLink.Provider value={true}>
            {children}
          </MarkdownInsideLink.Provider>
        </a>
      );
    },
    img({ src, alt }: ComponentPropsWithoutRef<"img">) {
      // Delegate to a real (PascalCase) component so the `useContext` hook that
      // detects the enclosing-link case lives where hooks belong.
      return (
        <MarkdownImg
          src={src}
          alt={alt}
          attachments={attachments}
          base={base}
          onAttachmentOpen={onAttachmentOpen}
        />
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

/** The mdast node kinds the heading pass reads (declared here for the same
 *  reason the hast kinds above are: `mdast` reaches us only through
 *  react-markdown's own dependencies). */
interface MdastNode {
  type: string;
  depth?: number;
  children?: MdastNode[];
}

/**
 * Ruling 478(f) (F40-35): remark plugin factory for text that sits UNDER one of
 * the page's own headings. An agent writes `#` and `##` for the sections of its
 * report, and rendered as h1/h2 they joined the task page's outline beside
 * Timeline, Agent logs and Details (twelve such h2s on WEB-4), and a packet
 * body's steps became siblings of the question they belong to.
 *
 * The text's own top level renders at `base` and deeper levels follow, capped
 * at h6: relative to the top level the author used, not to `#`, because agents
 * open their sections with `##` as often as with `#`, and a fixed shift made
 * those skip a level (an h2 title, then h4). `base` 1 leaves the text as written.
 */
function remarkHeadingBase(base = 1) {
  return function transform(tree: MdastNode) {
    if (base <= 1) return;
    const headings: MdastNode[] = [];
    const collect = (node: MdastNode) => {
      if (node.type === "heading") headings.push(node);
      for (const child of node.children ?? []) collect(child);
    };
    collect(tree);
    if (headings.length === 0) return;
    const top = Math.min(...headings.map((h) => h.depth ?? 1));
    for (const h of headings) h.depth = Math.min(6, base + (h.depth ?? 1) - top);
  };
}

interface MarkdownProps {
  text: string;
  /** Known mentionable names, so a multi-word "@Arda Kaya" chips as one span. */
  mentionNames?: string[];
  /** U39-29: the task keys this text may name, resolved by the page's loader
   *  to the paths the viewer can open. Absent ⇒ keys stay text. */
  taskLinks?: TaskLinks;
  /** The surrounding task's REAL attachment filenames — enables rewriting
   *  agent-written workspace-relative attachment links to the serving route.
   *  Absent (every non-task surface) ⇒ links render exactly as written. */
  attachmentNames?: ReadonlySet<string>;
  /** The task's attachment route base (`…/tasks/<KEY>/attachments`). */
  attachmentsBase?: string;
  /** Opens an embedded attachment image in the task page's lightbox — pass
   *  `useAttachmentLightbox()`'s factory. Absent ⇒ embeds are plain images. */
  onAttachmentOpen?: AttachmentOpenFactory;
  /** Ruling 478(f): the level the text's top heading renders at, for text
   *  that sits under one of the page's own headings (a timeline entry under
   *  Timeline's h2, a packet body under the packet's h2); deeper headings
   *  follow. Absent ⇒ 1, as written. */
  headingBase?: number;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, i) => item === b[i]);
}

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function sameLinks(a: TaskLinks | undefined, b: TaskLinks | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function linkOf(links: TaskLinks | undefined, key: string): string | undefined {
  return links && Object.hasOwn(links, key) ? links[key] : undefined;
}

/**
 * Ruling 457 (CTL-7): the links THIS text can render. A transcript hands every
 * message one conversation-wide map, so a reply that names a new key changed
 * the map under all thirty messages above it and re-parsed each one. Only a key
 * the text names can change its output, so the maps are compared on those.
 */
function sameLinksForText(
  text: string,
  a: TaskLinks | undefined,
  b: TaskLinks | undefined,
): boolean {
  if (sameLinks(a, b)) return true;
  for (const [key] of text.matchAll(LINKABLE_IN_TEXT_RE)) {
    if (linkOf(a, key) !== linkOf(b, key)) return false;
  }
  return true;
}

/**
 * Equal by CONTENT, not identity. A live page re-renders on every revalidation
 * and every console append, and a revalidation hands it brand-new loader
 * objects carrying the same text — so an identity check would still re-parse
 * every comment. A task page with a running agent re-renders its whole timeline
 * per console line (the tail lives in the page), each comment through the full
 * remark/rehype pipeline; on AX-31's timeline this memo took a page re-render
 * from ~26 ms to ~16 ms (jsdom, React dev build, 2026-09-23).
 */
export function sameMarkdownProps(a: MarkdownProps, b: MarkdownProps): boolean {
  return (
    a.text === b.text &&
    a.attachmentsBase === b.attachmentsBase &&
    a.onAttachmentOpen === b.onAttachmentOpen &&
    a.headingBase === b.headingBase &&
    sameList(a.mentionNames, b.mentionNames) &&
    sameSet(a.attachmentNames, b.attachmentNames) &&
    sameLinksForText(a.text, a.taskLinks, b.taskLinks)
  );
}

export const Markdown = memo(function Markdown({
  text,
  mentionNames,
  attachmentNames,
  attachmentsBase,
  onAttachmentOpen,
  taskLinks,
  headingBase = 1,
}: MarkdownProps): ReactNode {
  // Stable component TYPES: `componentsFor` returns fresh functions, and React
  // unmounts and remounts every element rendered through a new type — every
  // link, image and code block of the comment. Keyed on the names' CONTENT: the
  // timeline hands over a new Set on every page render, so an identity key
  // would rebuild them whenever anything else in the comment changed. The names
  // are directory entries, which cannot contain "/", so the join is exact.
  const attachmentKey =
    attachmentNames && attachmentNames.size > 0 && attachmentsBase
      ? [...attachmentNames].join("/")
      : "";
  const components = useMemo(
    () =>
      attachmentKey && attachmentsBase
        ? componentsFor(new Set(attachmentKey.split("/")), attachmentsBase, onAttachmentOpen)
        : DEFAULT_COMPONENTS,
    [attachmentKey, attachmentsBase, onAttachmentOpen],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkHeadingBase, headingBase]]}
      rehypePlugins={[
        [rehypeMentions, mentionNames ?? []],
        [rehypeTaskLinks, taskLinks ?? {}],
      ]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}, sameMarkdownProps);
