import { describe, expect, it } from "vitest";
import { pageEnd } from "~/server/runtimes/read-page-budget.server";
import { FIND_COUNT_MAX, findInText, findWords } from "./find-in-text.server";

/**
 * Ruling 706: the search behind `read_task_source`'s `find`. The cases are
 * the shapes a kept record takes: one entry to a line (this repository's
 * newer rulings), an entry wrapped over indented lines (its older ones), and
 * a file that is one line from end to end.
 */

const find = (whole: string, phrase: string, from?: number) => findInText(whole, findWords(phrase), from);

/** A record with one entry to a line, each longer than an excerpt. */
function record(entries: { head: string; body: string }[]): string {
  return entries.map((e) => `${e.head} ${e.body}`).join("\n") + "\n";
}

const FILLER = "The run finalizes first and the session is compacted after it, as the note on the task says. ";

const RECORD = record([
  {
    head: "506. **A run records what its compaction cost** (2026-09-26)",
    body: `${FILLER.repeat(6)}The compaction's tokens go into the run's totals. ${FILLER.repeat(3)}Nothing else in the record moves.`,
  },
  {
    head: "536. **The completion compaction adds only its own cost** (2026-09-28)",
    body: `${FILLER.repeat(6)}The console line states that share, with the cached part named inside the input. ${FILLER.repeat(3)}`,
  },
]);

describe("ruling 706: the places in a text that hold a phrase", () => {
  it("finds a later entry in one call: its line, the head of that line, the words where they stand, and where to read it from", () => {
    // Canary: return the offset of the words in place of their line's start,
    // and a read from there opens in the middle of the entry with its number
    // and date gone.
    const found = find(RECORD, "cached part");
    expect(found.found).toBe(1);
    expect(found.nextOffset).toBeUndefined();
    expect(found.hits).toHaveLength(1);
    const [hit] = found.hits;
    expect(hit!.line).toBe(2);
    expect(hit!.offset).toBe(RECORD.indexOf("536."));
    // The head of a long line, then the stretch around the words. Canary:
    // drop the head and the excerpt no longer says which entry it is in.
    expect(hit!.text.startsWith("536. **The completion compaction adds only its own cost** (2026-09-28) The run finalizes first and the session is … ")).toBe(true);
    expect(hit!.text).toContain("The console line states that share, with the cached part named inside the input.");
    expect(hit!.text.endsWith("…")).toBe(true);
    // A read from the place found holds the words.
    const page = RECORD.slice(hit!.offset, pageEnd(RECORD, hit!.offset));
    expect(page.startsWith("536.")).toBe(true);
    expect(page).toContain("the cached part named inside the input");
    // Words a little way into a long line: the excerpt runs from the line's
    // start, once. Canary: lend it the head as well, and the entry's first
    // words are printed twice with a mark between them.
    const entry = `41. **An entry** (2026-09-01) ${"early ".repeat(30)}needle ${"late ".repeat(200)}`;
    expect(entry.indexOf("needle")).toBeGreaterThan(160);
    const [nearHead] = find(entry, "needle").hits;
    expect(nearHead!.text.startsWith("41. **An entry** (2026-09-01) early early")).toBe(true);
    expect(nearHead!.text).not.toContain(" … ");
    expect(nearHead!.text.match(/early/g)).toHaveLength(30);
    // A line this long is an entry of its own, and its excerpt stays inside
    // it. Canary: let the excerpt run over the line's ends, and words at the
    // head of entry 536 open with the last words of 506, words at the tail of
    // 506 close with the number and title of 536.
    const [atHead] = find(RECORD, "The completion compaction").hits;
    expect(atHead!.text.startsWith("536. **The completion compaction adds only its own cost** (2026-09-28)")).toBe(true);
    const [atTail] = find(RECORD, "nothing else in the record").hits;
    expect(atTail!.line).toBe(1);
    expect(atTail!.text.endsWith("as the note on the task says. Nothing else in the record moves.")).toBe(true);
    expect(atTail!.text).not.toContain("536.");
  });

  it("matches letters in either case and a space against any run of spaces and line breaks, and loosens nothing else", () => {
    // An older ruling is wrapped at a hundred columns with a four-space
    // indent, so a phrase straddles a line break.
    const wrapped =
      "(e) The compaction's cost and tokens are added to the\n" +
      "    run's totals. How much of it is cached\n" +
      "    is not said (cost: $0.31).\n";
    // Canary: join the words with one literal space and the wrapped phrase is
    // never found.
    expect(find(wrapped, "added to the run's totals").found).toBe(1);
    expect(find(wrapped, "ADDED   TO THE\nRUN'S totals").hits[0]!.line).toBe(1);
    // The second line holds the words that start on it.
    expect(find(wrapped, "is cached is not said").hits[0]!.line).toBe(2);
    // A pattern's own characters are read as written. Canary: build the
    // pattern without escaping and `(cost: $0.31)` is a group that matches
    // nothing, while `c.ched` finds "cached".
    expect(find(wrapped, "(cost: $0.31).").found).toBe(1);
    expect(find(wrapped, "c.ched").found).toBe(0);
    expect(find(wrapped, "tokens.*totals").found).toBe(0);
    // Nothing is stemmed and no word is optional.
    expect(find(wrapped, "token is added").found).toBe(0);
    expect(find(wrapped, "nowhere in it")).toEqual({ words: ["nowhere", "in", "it"], found: 0, hits: [] });
  });

  it("shows a short line whole, with the lines around it kept apart, and marks only a line it cut", () => {
    const lines =
      "## Changelog\n" +
      "\n" +
      "- 2.4.0: the cache is on by default\n" +
      "- 2.3.1:   a fix    for the sign-in page\n" +
      "- 2.3.0: the cache can be turned on\n";
    // Canary: collapse line breaks to spaces and three entries read as one;
    // keep every space and the indent of a wrapped record fills the excerpt.
    expect(find(lines, "sign-in").hits).toEqual([
      {
        line: 4,
        offset: lines.indexOf("- 2.3.1"),
        text: "## Changelog\n- 2.4.0: the cache is on by default\n- 2.3.1: a fix for the sign-in page\n- 2.3.0: the cache can be turned on",
      },
    ]);
    // A wrapped paragraph: the excerpt starts some lines above the words, and
    // the line it starts inside is marked as cut. Canary: leave the mark out
    // and half a sentence reads as the start of one.
    const wrapped = Array.from({ length: 8 }, (_, i) => `line ${i + 1} of a paragraph that is wrapped at about seventy columns here`).join("\n");
    const [inside] = find(wrapped, "line 6").hits;
    expect(inside!.line).toBe(6);
    expect(inside!.text.startsWith("…")).toBe(true);
    expect(inside!.text.split("\n").slice(1, 4)).toEqual([
      "line 4 of a paragraph that is wrapped at about seventy columns here",
      "line 5 of a paragraph that is wrapped at about seventy columns here",
      "line 6 of a paragraph that is wrapped at about seventy columns here",
    ]);
    // Two places a short way apart show in one excerpt: both are counted and
    // one is listed. Canary: list every place and a word used forty times in
    // one paragraph fills the answer with the same paragraph.
    const both = find(lines, "the cache");
    expect(both.found).toBe(2);
    expect(both.hits).toHaveLength(1);
    expect(both.hits[0]!.line).toBe(3);
  });

  it("starts and ends an excerpt between words, never inside a surrogate pair", () => {
    // Canary: cut at the character count and the excerpt opens on half a
    // word, or on half of an emoji that then prints as a broken character.
    const body = `${"wordy ".repeat(60)}needle ${"wordy ".repeat(60)}`;
    const [hit] = find(body, "needle").hits;
    expect(hit!.text.endsWith("wordy…")).toBe(true);
    // The head of the line, the mark of what was left out, then whole words.
    const parts = hit!.text.split(/\s+/);
    expect(parts.filter((part) => part === "…")).toHaveLength(1);
    expect(parts.filter((part) => !["wordy", "needle", "…", "wordy…"].includes(part))).toEqual([]);
    // One letter either side puts both cuts on the second half of a pair.
    const pairs = `${"😀".repeat(300)}aneedleb${"😀".repeat(300)}`;
    const [emoji] = find(pairs, "needle").hits;
    expect(emoji!.text.isWellFormed()).toBe(true);
    expect(emoji!.text).toMatch(/^(😀)+ … (😀)+aneedleb(😀)+…$/u);
  });

  it("lists places from `from` on, cuts the list at its cap, and says where the next search starts", () => {
    // 100 entries, each a line long enough that no excerpt reaches the next.
    const entry = (n: number) => `${n}. the marker stands here. ${"padding ".repeat(80)}`;
    const many = Array.from({ length: 100 }, (_, i) => entry(i + 1)).join("\n");
    const first = find(many, "the marker");
    expect(first.found).toBe(100);
    expect(first.hits).toHaveLength(40);
    expect(first.hits.map((h) => h.line)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    // Canary: point `nextOffset` past the 41st place and it is never listed.
    expect(first.nextOffset).toBe(many.indexOf("the marker", many.indexOf("\n41. ")));
    const second = find(many, "the marker", first.nextOffset);
    expect(second.found).toBe(100);
    expect(second.hits[0]!.line).toBe(41);
    const third = find(many, "the marker", second.nextOffset);
    expect(third.hits.map((h) => h.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 81));
    expect(third.nextOffset).toBeUndefined();
    // A search from past the last place lists nothing and still counts them.
    expect(find(many, "the marker", many.lastIndexOf("the marker") + 1)).toEqual({
      words: ["the", "marker"],
      found: 100,
      hits: [],
    });
    // The line a place is on is counted from the top, wherever the search
    // started. Canary: count lines from `from`.
    expect(find(many, "the marker", many.indexOf("\n90. ")).hits[0]!.line).toBe(90);
  });

  it("keeps an answer inside a page whatever the text's bytes, and always lists a place", () => {
    // Three-byte characters: forty excerpts of them would be far over a page.
    const wide = Array.from({ length: 60 }, (_, i) => `${i + 1}. 記録 ${"東京都".repeat(200)}`).join("\n");
    const listed = find(wide, "記録");
    // Canary: cap the list by count alone.
    expect(listed.hits.length).toBeGreaterThan(0);
    expect(listed.hits.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(listed.hits, null, 1))).toBeLessThan(32_000);
    expect(listed.nextOffset).toBe(wide.indexOf("記録", wide.indexOf(`\n${listed.hits.length + 1}. `)));
  });

  it("reads a place from a little before it when its line is longer than a page up to there", () => {
    // A file that is one line from end to end: its start is no place to read
    // the words from. Canary: answer the line's start whatever its length.
    const oneLine = `${"x".repeat(100_000)} needle ${"y".repeat(1_000)}`;
    const [hit] = find(oneLine, "needle").hits;
    expect(hit!.line).toBe(1);
    expect(hit!.offset).toBe(oneLine.indexOf("needle") - 2_000);
    expect(oneLine.slice(hit!.offset, pageEnd(oneLine, hit!.offset))).toContain(" needle ");
  });

  it("stops counting where words are too common to list", () => {
    // Canary: count to the end, and a one-letter search of a ten-megabyte
    // source holds the server for as long as it takes.
    const common = "a ".repeat(FIND_COUNT_MAX + 500);
    const counted = find(common, "a");
    expect(counted.found).toBe(FIND_COUNT_MAX);
    expect(counted.hits.length).toBeGreaterThan(0);
  });
});
