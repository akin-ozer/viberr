import { pageEnd } from "~/server/runtimes/read-page-budget.server";
import { escapeRegExp } from "~/shared/text/regexp";

/**
 * Ruling 706: the places in a text that hold a word or a short phrase, for a
 * reader that would otherwise page through all of it.
 *
 * A kept source is read a page at a time (ruling 624: 32,000 bytes), and a
 * record that grows runs to megabytes: the decisions file kept on BLOG-7 is
 * 2.25 MB, seventy-one pages. No review of that post opened it. Two read the
 * fifteen entries the writer had cut out of it; a third, at `max`, fetched
 * the file from the web again and read the same lines out of its own copy.
 * The entry that contradicted the post stood sixty-two lines below the one
 * it cited. Asked to send the post back over that entry, the controller and
 * the operator found it by guessing at an offset, which they could do because
 * the request named its line. A reader that can ask where the words are
 * reads the entry and the ones after it, and stays on the bytes the task
 * kept.
 */

/** The longest phrase a search takes: a passage this long is read, not sought. */
export const FIND_MAX_CHARS = 200;
/** Where the count of places stops: words this common are not worth listing. */
export const FIND_COUNT_MAX = 10_000;

/** How much of the text an excerpt shows before the words and after them. */
const HIT_BEFORE = 160;
const HIT_AFTER = 240;
/** How much of the head of a long line an excerpt opens with: in a record of
 *  one entry a line, that is the entry's number and date. */
const HIT_LINE_HEAD = 120;
/** The most places one answer lists, and the UTF-8 bytes they may take
 *  together: well inside a page (ruling 624), with room for the answer's own
 *  fields. */
const HITS_MAX = 40;
const HITS_MAX_BYTES = 24_000;
/** How far before the words a read starts when their line is longer than a
 *  page up to them. */
const READ_LEAD = 2_000;
/** How far an excerpt's edge moves to stand between two words. */
const EDGE_SLACK = 24;

/** One place the words stand. */
export interface TextHit {
  /** The line they start on, counted from 1. */
  line: number;
  /** Where to read them from: the start of that line, or a little before the
   *  words when the line runs longer than a page up to them. */
  offset: number;
  /** The words where they stand, with what surrounds them. */
  text: string;
}

export interface TextFind {
  /** The words as they were sought: split on white space. */
  words: string[];
  /** How many places in the whole text hold them, counted to
   *  `FIND_COUNT_MAX`. */
  found: number;
  /** The places from the search's start on, in order. One that already shows
   *  in the excerpt before it is not listed again. */
  hits: TextHit[];
  /** Where the next search starts, when places follow the last one listed. */
  nextOffset?: number;
}

/** The words of a phrase: letters in either case, white space as a break. */
export function findWords(phrase: string): string[] {
  return phrase.split(/\s+/).filter((word) => word.length > 0);
}

/** `at`, or the index before it when it falls inside a surrogate pair. */
function wholeChar(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at;
  const low = text.charCodeAt(at);
  const high = text.charCodeAt(at - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? at - 1 : at;
}

function isSpace(text: string, at: number): boolean {
  return /\s/.test(text.charAt(at));
}

/** Where an excerpt cut at `at` starts: there when a word starts there, else
 *  at the next word within reach, never past `limit`. */
function wordStart(text: string, at: number, limit: number): number {
  if (at <= 0 || isSpace(text, at - 1)) return at;
  for (let i = at; i < Math.min(limit, at + EDGE_SLACK); i += 1) {
    if (isSpace(text, i)) return i + 1;
  }
  return wholeChar(text, at);
}

/** Where an excerpt cut at `at` ends: there when a word ends there, else
 *  after the last word within reach, never before `limit`. */
function wordEnd(text: string, at: number, limit: number): number {
  if (at >= text.length || isSpace(text, at)) return at;
  for (let i = at - 1; i >= Math.max(limit, at - EDGE_SLACK); i -= 1) {
    if (isSpace(text, i)) return i;
  }
  return wholeChar(text, at);
}

/** Whether `at` is where a line starts, or ends. */
function atLineBreak(text: string, at: number): boolean {
  return at <= 0 || at >= text.length || text.charAt(at - 1) === "\n" || text.charAt(at) === "\n";
}

/** A stretch of the text as an excerpt carries it: its line breaks kept, one
 *  to a break, and every other run of white space as one space. */
function shown(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

/**
 * Search `whole` for `words`, in order, from `from` on. Letters match in
 * either case; between two words any run of white space matches, so a phrase
 * a record wraps over two lines is found. Nothing else is loosened: no
 * pattern syntax, no stemming. The caller passes at least one word.
 */
export function findInText(whole: string, words: readonly string[], from = 0): TextFind {
  // Literal words joined by `\s+`: measured on Node 26 against a 9 MB run of
  // spaces and against 10 MB of prose, a scan takes a few milliseconds and
  // does not overflow the engine's stack (the counted run of ruling 676 did).
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");

  let found = 0;
  while (found < FIND_COUNT_MAX && pattern.exec(whole)) found += 1;

  // Matches come in order, so the line count only ever moves forward.
  let line = 1;
  let lineStart = 0;
  let newline = whole.indexOf("\n");
  const hits: TextHit[] = [];
  const find: TextFind = { words: [...words], found, hits };
  let bytes = 0;
  let shownTo = -1;
  pattern.lastIndex = Math.min(Math.max(0, from), whole.length);
  for (let match = pattern.exec(whole); match; match = pattern.exec(whole)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end <= shownTo) continue;
    while (newline !== -1 && newline < start) {
      line += 1;
      lineStart = newline + 1;
      newline = whole.indexOf("\n", newline + 1);
    }
    // A line longer than an excerpt is an entry of its own (one ruling, one
    // row, one release): the excerpt stays inside it. Shorter lines are a
    // wrapped paragraph, and the excerpt takes the lines around the words.
    const lineEnd = newline === -1 ? whole.length : newline;
    const ownLine = lineEnd - lineStart > HIT_BEFORE + HIT_AFTER && end <= lineEnd;
    let windowStart = wordStart(whole, Math.max(ownLine ? lineStart : 0, start - HIT_BEFORE), start);
    const windowEnd = wordEnd(whole, Math.min(ownLine ? lineEnd : whole.length, end + HIT_AFTER), end);
    // A line that starts a little before the excerpt is shown from its start;
    // one that starts far before it lends the excerpt its head. `…` marks a
    // line cut short.
    let lead = "";
    if (lineStart < windowStart && windowStart - lineStart <= HIT_LINE_HEAD) windowStart = lineStart;
    else if (lineStart < windowStart) {
      lead = `${shown(whole.slice(lineStart, wordEnd(whole, lineStart + HIT_LINE_HEAD, lineStart)))} … `;
    } else if (!atLineBreak(whole, windowStart)) lead = "…";
    const text =
      lead + shown(whole.slice(windowStart, windowEnd)) + (atLineBreak(whole, windowEnd) ? "" : "…");
    const hit: TextHit = {
      line,
      // The line's own start, when a page read from there reaches the words.
      offset: end <= pageEnd(whole, lineStart) ? lineStart : wholeChar(whole, Math.max(lineStart, start - READ_LEAD)),
      text,
    };
    const size = Buffer.byteLength(JSON.stringify(hit, null, 1));
    if (hits.length > 0 && (hits.length >= HITS_MAX || bytes + size > HITS_MAX_BYTES)) {
      find.nextOffset = start;
      break;
    }
    hits.push(hit);
    bytes += size;
    shownTo = windowEnd;
  }
  return find;
}
