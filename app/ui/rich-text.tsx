import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { TASK_KEY_IN_TEXT_RE, type TaskLinks } from "~/shared/task-key-links";

/**
 * THE shared rich-text micro-format renderer (orchestrator ruling 14,
 * contracts §1.4). Inline-only — NOT a markdown library:
 *
 *   **text**  → <strong>
 *   `text`    → <code class="mono">
 *
 * It is the mock's `RichA` variant (activity.jsx, bold+code only): every feed
 * that draws through it shows an @word as prose, and a comment's mentions chip
 * in the markdown renderer (`markdown.tsx`), through the `findMentionSpans`
 * the server routes with. The matching plain-text stripper lives in
 * app/features/notifications/notification-meta.ts (`plainText`).
 */

const BOLD_OR_CODE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function RichText({
  text,
  taskLinks,
}: {
  text: string;
  /** U39-31: the tasks this text may name, key to path, resolved by the
   *  page's loader. Absent ⇒ keys stay text. */
  taskLinks?: TaskLinks;
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

  const re = new RegExp(BOLD_OR_CODE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pushLinked(text.slice(last, m.index));
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
  pushLinked(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}

/**
 * U39-15: `code` inside a **bold** run. The one pass above matches the bold
 * run whole, so its backticks printed literally: the lease notice's own
 * headline, "**AX-22 now holds `internal/controller/task.go`**", read with
 * the marks in it on every notification row.
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
