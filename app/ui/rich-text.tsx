import { Fragment, type ReactNode } from "react";

/**
 * THE shared rich-text micro-format renderer (orchestrator ruling 14,
 * contracts §1.4). Regex-level contract ported verbatim from the mock's
 * `RichText` (task.jsx) — NOT a markdown library:
 *
 *   **text**  → <strong>
 *   `text`    → <code class="mono">
 *   @word     → <span class="mention">      (letter start, then word chars/-)
 *
 * The mock's second variant `RichA` (activity.jsx, bold+code only) is this
 * same component with `mentions={false}`. The matching plain-text stripper
 * lives in app/features/notifications/notification-meta.ts (`plainText`).
 */

const RICH_RE = /(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][\w-]*)/g;
const RICH_RE_NO_MENTIONS = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function RichText({
  text,
  mentions = true,
}: {
  text: string;
  mentions?: boolean;
}) {
  const parts: ReactNode[] = [];
  const re = new RegExp(
    (mentions ? RICH_RE : RICH_RE_NO_MENTIONS).source,
    "g",
  );
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      parts.push(
        <code key={i++} className="mono">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(
        <span key={i++} className="mention">
          {tok}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
