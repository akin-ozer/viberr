/**
 * Ruling 467: what a persona edit changed, in one line a person or the
 * controller can check without diffing two documents by eye.
 *
 * A persona is the run's whole system prompt, so a reply that only said
 * "persona updated" would ask the reader to trust that the right lines moved.
 * This names the length before and after and the first and last changed
 * lines, old and new. A quoted line longer than `QUOTE_MAX` is cut with "…"
 * and the sentence says so: the persona itself is always written whole, and
 * the reply never shortens anything without saying it did.
 */

const QUOTE_MAX = 120;

function quote(line: string | undefined, clipped: { any: boolean }): string {
  if (line === undefined) return "(none)";
  const flat = line.trim();
  if (!flat) return "(blank line)";
  if (flat.length <= QUOTE_MAX) return `"${flat}"`;
  clipped.any = true;
  return `"${flat.slice(0, QUOTE_MAX)}…"`;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * Null when the two texts are identical; otherwise
 * `5,120 → 5,342 characters; lines 12–40 of 88 changed: first "…" → "…"; last "…" → "…"`.
 * Lines are compared from both ends, so a paragraph inserted in the middle
 * reads as one changed range rather than every line after it.
 */
export function describePersonaChange(before: string, after: string): string | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const oldLast = a.length - 1 - tail;
  const newLast = b.length - 1 - tail;
  const clipped = { any: false };
  const range =
    newLast > head
      ? `lines ${count(head + 1)}–${count(newLast + 1)} of ${count(b.length)} changed`
      : newLast === head
        ? `line ${count(head + 1)} of ${count(b.length)} changed`
        : `${count(oldLast - head + 1)} line${oldLast === head ? "" : "s"} removed after line ${count(head)}`;
  const first = `first ${quote(head > oldLast ? undefined : a[head], clipped)} → ${quote(head > newLast ? undefined : b[head], clipped)}`;
  const spansMore = oldLast > head || newLast > head;
  const last = spansMore
    ? `; last ${quote(oldLast >= head ? a[oldLast] : undefined, clipped)} → ${quote(newLast >= head ? b[newLast] : undefined, clipped)}`
    : "";
  const note = clipped.any
    ? ` (quoted lines over ${QUOTE_MAX} characters are cut with …; the whole persona was written)`
    : "";
  return `${count(before.length)} → ${count(after.length)} characters; ${range}: ${first}${last}${note}`;
}
