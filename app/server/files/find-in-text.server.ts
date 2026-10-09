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

/**
 * The longest phrase a search takes, in words and in characters: a passage
 * longer than this is read, not sought.
 *
 * The word limit is what bounds a search's time, which grows with the words
 * times the text. Measured on Node 26 on texts built to be slow for it, 10 MB
 * of one letter and one to fifty spaces repeated, one scan by a phrase that
 * fails on its last word took at most 19 ms for 2 words, 234 ms for 12 and
 * 2.4 s for 100 (which 200 characters allow). One scan of 10 MB of prose by
 * a 20-word phrase took 6 ms. The server is one process and a search holds
 * it, so the limit is twelve.
 */
export const FIND_MAX_WORDS = 12;
export const FIND_MAX_CHARS = 200;

/** How much of the text an excerpt shows before the words and after them. */
const HIT_BEFORE = 160;
const HIT_AFTER = 240;
/** How much of the head of its entry an excerpt opens with when the words
 *  stand further in: in a record of dated entries, the entry's number, its
 *  title and, for most, its date. */
const HIT_ENTRY_HEAD = 200;
/** How far above an indented line its entry's head is looked for, in
 *  characters: no entry is this long, and a file indented from end to end
 *  costs each place a bounded walk. */
const ENTRY_HEAD_REACH = 200_000;
/** The most places one answer lists, and the UTF-8 bytes they may take
 *  together: well inside a page (ruling 624), with room for the answer's own
 *  fields. No one place comes near the second figure. */
export const FIND_HITS_MAX = 40;
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
  /** Where to read them from: the start of their entry (the line an indented
   *  one continues) when a page read from there reaches them, else the start
   *  of their own line, else a little before the words. */
  offset: number;
  /** The words where they stand, with what surrounds them and, when they
   *  stand far into an entry, the head of that entry before them. */
  text: string;
}

export interface TextFind {
  /** The words as they were sought: split on white space. */
  words: string[];
  /** How many places in the whole text hold them. */
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

/** Whether `at` is where a line starts, or ends (before its `\n` or its
 *  `\r\n`). */
function atLineBreak(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length || text.charAt(at - 1) === "\n") return true;
  const next = text.charAt(at);
  return next === "\n" || (next === "\r" && text.charAt(at + 1) === "\n");
}

/**
 * Where the entry a line belongs to starts. A line that opens with white
 * space continues the nearest line above it that does not: the hanging indent
 * of a numbered entry, a list item or a quoted block wrapped over several
 * lines. Half the rulings of this repository's own decisions file are written
 * that way, with the number and the date on the first line or two and the
 * rest indented under them. Any other line starts its own entry.
 */
function entryStartOf(text: string, lineStart: number): number {
  if (!isSpace(text, lineStart)) return lineStart;
  let at = lineStart;
  while (at > 0 && lineStart - at <= ENTRY_HEAD_REACH) {
    // The start of the line above. From index 1 that is index 0: asked for a
    // line break "at or before -1", `lastIndexOf` looks at index 0, finds the
    // one a text opens with, and the walk would stand still for ever.
    at = at < 2 ? 0 : text.lastIndexOf("\n", at - 2) + 1;
    if (startsAnEntry(text, at)) return at;
  }
  return lineStart;
}

/** Whether the line at `at` starts an entry: it is not empty and does not
 *  open with white space. */
function startsAnEntry(text: string, at: number): boolean {
  return at < text.length && !isSpace(text, at);
}

/**
 * Where an entry runs on to below the line its words start on, when the
 * lines under that one are indented: the end of the last line before the
 * next one that starts an entry, looked for as far as `reach`. `lineEnd` is
 * where that line ends, and the line under it is looked at wherever `reach`
 * lies. Null when the next line that is not blank starts an entry itself, or
 * there is none.
 */
function entryRunsTo(text: string, lineEnd: number, reach: number): number | null {
  let last: number | null = null;
  let lineBreak = lineEnd;
  const until = Math.max(reach, lineEnd);
  while (lineBreak < text.length && lineBreak <= until) {
    const nextStart = lineBreak + 1;
    const nextBreak = text.indexOf("\n", nextStart);
    const nextEnd = nextBreak === -1 ? text.length : nextBreak;
    if (text.slice(nextStart, nextEnd).trim() !== "") {
      if (startsAnEntry(text, nextStart)) return last;
      last = nextEnd;
    }
    lineBreak = nextEnd;
  }
  // Still indented where the excerpt would end: the block runs past it.
  return last === null ? null : Math.max(last, reach);
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
 * either case, as the engine pairs them one to one (a Turkish dotted or
 * dotless i matches only itself); between two words any run of white space
 * matches, so a phrase a record wraps over two lines is found. Nothing else
 * is loosened: no pattern syntax, no stemming.
 *
 * `hangingIndent` says whether an indented line continues the line above it,
 * which is how prose is wrapped. In data and markup an indent is nesting: the
 * nearest unindented line above a value in a printed JSON list is the list's
 * opening bracket, and a head lent from there would name the first item for
 * every place. The caller that knows the file's kind says which it is.
 */
export function findInText(whole: string, words: readonly string[], from = 0, hangingIndent = true): TextFind {
  const hits: TextHit[] = [];
  const find: TextFind = { words: [...words], found: 0, hits };
  // No words would be an empty pattern, which matches everywhere and moves
  // nowhere.
  if (words.length === 0) return find;
  // Literal words joined by `\s+`. A run of white space of any length does
  // not overflow the engine's stack, as the counted run of ruling 676 did:
  // measured on a 16,000,000-character run of spaces.
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");

  while (pattern.exec(whole)) find.found += 1;
  if (find.found === 0) return find;

  // Matches come in order, so the line count only ever moves forward.
  let line = 1;
  let lineStart = 0;
  let newline = whole.indexOf("\n");
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
    // Where the words stand in an indented block, the excerpt stays inside
    // that too: the lines before its head and after its last line are
    // another entry's.
    const entryStart = hangingIndent ? entryStartOf(whole, lineStart) : lineStart;
    // A phrase may end on a later line than it starts on: the excerpt reaches
    // at least to where that line ends.
    const lastBreak = end <= lineEnd ? lineEnd : whole.indexOf("\n", end);
    const wordsLineEnd = lastBreak === -1 ? whole.length : lastBreak;
    const runsTo = ownLine || !hangingIndent ? null : entryRunsTo(whole, lineEnd, end + HIT_AFTER);
    const inBlock = entryStart < lineStart || runsTo !== null;
    const floor = ownLine ? lineStart : inBlock ? entryStart : 0;
    const ceiling = ownLine ? lineEnd : inBlock ? Math.max(runsTo ?? 0, wordsLineEnd) : whole.length;
    let windowStart = wordStart(whole, Math.max(floor, start - HIT_BEFORE), start);
    const windowEnd = wordEnd(whole, Math.min(ceiling, end + HIT_AFTER), end);
    // An entry that starts a little before the excerpt is shown from its
    // start; one that starts far before it lends the excerpt its head, so a
    // reader sees which entry the words are in. `…` marks a line cut short.
    let lead = "";
    if (entryStart < windowStart && windowStart - entryStart <= HIT_ENTRY_HEAD) windowStart = entryStart;
    else if (entryStart < windowStart) {
      lead = `${shown(whole.slice(entryStart, wordEnd(whole, entryStart + HIT_ENTRY_HEAD, entryStart)))} … `;
    } else if (!atLineBreak(whole, windowStart)) lead = "…";
    const text =
      lead + shown(whole.slice(windowStart, windowEnd)) + (atLineBreak(whole, windowEnd) ? "" : "…");
    // The furthest back of the entry's start and the line's start from which
    // one page still reaches the words.
    const readFrom = [entryStart, lineStart].find((at) => end <= pageEnd(whole, at));
    const hit: TextHit = {
      line,
      offset: readFrom ?? wholeChar(whole, Math.max(lineStart, start - READ_LEAD)),
      text,
    };
    const size = Buffer.byteLength(JSON.stringify(hit, null, 1));
    if (hits.length >= FIND_HITS_MAX || bytes + size > HITS_MAX_BYTES) {
      find.nextOffset = start;
      break;
    }
    hits.push(hit);
    bytes += size;
    shownTo = windowEnd;
  }
  return find;
}
