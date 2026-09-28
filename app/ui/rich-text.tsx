import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { TASK_KEY_IN_TEXT_RE, type TaskLinks } from "~/shared/task-key-links";
import { findMentionSpans } from "./mention-spans";

/**
 * THE shared rich-text micro-format renderer (orchestrator ruling 14,
 * contracts §1.4). Inline-only — NOT a markdown library:
 *
 *   **text**  → <strong>
 *   `text`    → <code class="mono">
 *   @name     → <span class="mention">      (KNOWN names only, see below)
 *
 * The mock's second variant `RichA` (activity.jsx, bold+code only) is this
 * same component with `mentions={false}`. The matching plain-text stripper
 * lives in app/features/notifications/notification-meta.ts (`plainText`).
 *
 * F20 (the surviving half of P13-LV-12): this used to carry its OWN mention
 * regex, `@[A-Za-z][\w-]*`, which disagreed with the comment renderer and the
 * server's routing resolver on both ends — it chipped `@nobody`, which routes
 * nowhere, and it chipped only `@Arda` out of the known name "@Arda Kaya".
 * Mentions now go through the same `findMentionSpans` the markdown renderer and
 * the server use, filtered to `known`, so "highlighted as a mention" and
 * "actually routed" cannot drift apart again. Bold/code still own the first
 * pass, which keeps a `@foo` inside `code` (or inside a **bold** run) literal.
 */

const BOLD_OR_CODE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function RichText({
  text,
  mentions = true,
  names = [],
  taskLinks,
}: {
  text: string;
  mentions?: boolean;
  /** U39-31: the tasks this text may name, key to path, resolved by the
   *  page's loader. Absent ⇒ keys stay text. */
  taskLinks?: TaskLinks;
  /** Known mentionable names, so a multi-word "@Arda Kaya" chips as one span
   *  and an unknown `@word` stays prose. Reserved role handles (@operator …)
   *  are always known — `findMentionSpans` adds them. */
  names?: string[];
}) {
  const parts: ReactNode[] = [];
  let key = 0;

  /** U39-31: plain prose, with the resolved task keys in it as links (same
   *  tab, like the markdown renderer's). Ruling 560: drawn as the key chip the
   *  activity and notification feeds link a task with; outside `.md-body` a
   *  bare link took the browser's own blue, and its purple once visited. */
  const pushLinked = (chunk: string) => {
    if (!chunk) return;
    if (!taskLinks) {
      parts.push(chunk);
      return;
    }
    let at = 0;
    for (const match of chunk.matchAll(TASK_KEY_IN_TEXT_RE)) {
      const href = Object.hasOwn(taskLinks, match[0]) ? taskLinks[match[0]] : undefined;
      if (!href) continue;
      if (match.index > at) parts.push(chunk.slice(at, match.index));
      parts.push(
        <Link key={key++} to={href} className="task-ref keybtn">
          {match[0]}
        </Link>,
      );
      at = match.index + match[0].length;
    }
    if (at < chunk.length) parts.push(chunk.slice(at));
  };

  /** Prose between the bold/code tokens: chip the KNOWN mentions inside it. */
  const pushProse = (chunk: string) => {
    if (!chunk) return;
    if (!mentions) {
      pushLinked(chunk);
      return;
    }
    // Only KNOWN handles chip. An unknown `@handle` routes to nobody, so
    // chipping it told the author their tag had landed when it hadn't (F20).
    const spans = findMentionSpans(chunk, names).filter((s) => s.known);
    let at = 0;
    for (const { start, end } of spans) {
      if (start > at) pushLinked(chunk.slice(at, start));
      // P16-UI-20: the chip's only distinction from surrounding prose is colour
      // + background, so a screen reader read "@Selin" exactly like the word
      // "Selin". A visually-hidden word in front restores the distinction.
      // It sits BESIDE the chip, not inside it: `.mention`'s text content is
      // the literal mention span the shared matcher produced, and the renderer
      // must not change that (task-detail asserts it, and so does the server's
      // own grammar). `.mention-vh` is `user-select: none`, so copying a comment
      // still yields the author's text.
      parts.push(
        <Fragment key={key++}>
          <span className="mention-vh">mention </span>
          <span className="mention">{chunk.slice(start, end)}</span>
        </Fragment>,
      );
      at = end;
    }
    if (at < chunk.length) pushLinked(chunk.slice(at));
  };

  const re = new RegExp(BOLD_OR_CODE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pushProse(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={key++}>{codeSpans(tok.slice(2, -2))}</strong>);
    } else {
      parts.push(
        <code key={key++} className="mono">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  pushProse(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}

/**
 * U39-15: `code` inside a **bold** run. The one pass above matches the bold
 * run whole, so its backticks printed literally: the lease notice's own
 * headline, "**AX-22 now holds `internal/controller/task.go`**", read with
 * the marks in it on every notification row. Mentions inside bold stay prose,
 * as before.
 */
function codeSpans(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /`[^`]+`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <code key={m.index} className="mono">
        {m[0].slice(1, -1)}
      </code>,
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
