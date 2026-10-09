/**
 * Ruling 168: what two texts keep and what changed between them, for the run
 * console's edit diff: the lines an agent's `Edit` replaced, and inside a
 * changed line the words. Myers' O(ND) difference ("An O(ND) Difference
 * Algorithm and Its Variations", 1986) over any token list, after matching the
 * common head and tail, which is most of an edit: an agent quotes the lines
 * around its change so that the match is unique.
 *
 * A script that would cost more than `MAX_COST` steps, or search more than
 * `MAX_SPAN` tokens, is not looked for: it reads as every old token removed
 * and every new one added, which is still a true account of the change, only
 * not the shortest one.
 */

/** One step from the old text to the new: a token both keep, one the old
 *  text loses, one the new text gains. */
export type DiffStep = "same" | "del" | "add";

/** A run of a line's text that changed, as `[start, end)`. */
export type TextSpan = readonly [number, number];

const MAX_COST = 1000;
const MAX_SPAN = 6000;

/** The steps that turn `a` into `b`, in order. */
export function diffSteps(a: readonly string[], b: readonly string[]): DiffStep[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const steps: DiffStep[] = [];
  for (let i = 0; i < head; i += 1) steps.push("same");
  middle(a.slice(head, endA), b.slice(head, endB), steps);
  for (let i = endA; i < a.length; i += 1) steps.push("same");
  return steps;
}

/**
 * The forward search: the cost of the shortest script, or -1 past the caps.
 * `trace[d]` keeps diagonals -d-1..d+1 as they stood before step d, which is
 * all the walk back reads (diagonal k at index k + d + 1).
 */
function search(a: readonly string[], b: readonly string[], trace: Int32Array[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n + m > MAX_SPAN) return -1;
  const limit = Math.min(n + m, MAX_COST);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return -1;
}

/** The script between two lists that share no head or tail, onto `out`. */
function middle(a: readonly string[], b: readonly string[], out: DiffStep[]): void {
  const trace: Int32Array[] = [];
  const cost = search(a, b, trace);
  if (cost < 0) {
    for (let i = 0; i < a.length; i += 1) out.push("del");
    for (let j = 0; j < b.length; j += 1) out.push("add");
    return;
  }
  const back: DiffStep[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = cost; d > 0; d -= 1) {
    const at = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at[k + d]! < at[k + d + 2]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = at[prevK + d + 1]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      back.push("same");
      x -= 1;
      y -= 1;
    }
    back.push(down ? "add" : "del");
    x = prevX;
    y = prevY;
  }
  for (; x > 0; x -= 1) back.push("same");
  for (let i = back.length - 1; i >= 0; i -= 1) out.push(back[i]!);
}

/** Words, runs of space, and each other character on its own. */
const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Past this many tokens a line is not compared word by word. */
const MAX_TOKENS = 400;

/** Below this share of a line's characters kept, marking its words says
 *  nothing the changed line's own tint does not. */
const MIN_KEPT = 0.5;

function solid(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** Adds `[start, end)` to `spans`, joined to the last span when only space
 *  lies between them, so a changed phrase reads as one mark. */
function mark(spans: [number, number][], text: string, start: number, end: number): void {
  const last = spans[spans.length - 1];
  if (last && text.slice(last[1], start).trim() === "") last[1] = end;
  else spans.push([start, end]);
}

/**
 * The words that changed between a removed line and the added line paired
 * with it, as spans of each. Null when the lines share too little for a word
 * mark to help (a line rewritten, not edited) or are too long to compare.
 */
export function changedSpans(
  before: string,
  after: string,
): { before: TextSpan[]; after: TextSpan[] } | null {
  const a = before.match(TOKEN_RE) ?? [];
  const b = after.match(TOKEN_RE) ?? [];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  const spansA: [number, number][] = [];
  const spansB: [number, number][] = [];
  let i = 0;
  let j = 0;
  let atA = 0;
  let atB = 0;
  let kept = 0;
  for (const step of diffSteps(a, b)) {
    if (step === "same") {
      kept += solid(a[i]!);
      atA += a[i++]!.length;
      atB += b[j++]!.length;
    } else if (step === "del") {
      mark(spansA, before, atA, atA + a[i]!.length);
      atA += a[i++]!.length;
    } else {
      mark(spansB, after, atB, atB + b[j]!.length);
      atB += b[j++]!.length;
    }
  }
  if (kept < MIN_KEPT * Math.max(solid(before), solid(after))) return null;
  return { before: spansA, after: spansB };
}
