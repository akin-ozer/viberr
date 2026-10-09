import { describe, expect, it } from "vitest";
import { pageEnd } from "~/server/runtimes/read-page-budget.server";
import { FIND_HITS_MAX, findInText, findWords } from "./find-in-text.server";

/**
 * Ruling 706: the search behind `read_task_source`'s `find`. The cases are
 * the shapes a kept record takes: one entry to a line (this repository's
 * newer rulings), an entry wrapped over indented lines (its older ones), and
 * a file that is one line from end to end.
 */

const find = (whole: string, phrase: string, from?: number, hangingIndent?: boolean) =>
  findInText(whole, findWords(phrase), from, hangingIndent);

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
    // The head of the entry, cut between words within 200 characters, then
    // the stretch around the words. Canary: drop the head and the excerpt no
    // longer says which entry it is in.
    const [head, around] = hit!.text.split(" … ");
    expect(head!.startsWith("536. **The completion compaction adds only its own cost** (2026-09-28) The run finalizes first")).toBe(true);
    expect(head!.length).toBeGreaterThan(170);
    expect(head!.length).toBeLessThanOrEqual(200);
    expect(RECORD).toContain(`${head} `);
    expect(around).toContain("with the cached part named inside the input.");
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

  it("an indented line continues the entry above it: the excerpt opens with that entry's head and the read starts there", () => {
    // Half the rulings of this repository's decisions file are written this
    // way: the number and the date on the first lines, the rest under a
    // hanging indent, a blank line between entries.
    const body = (words: string) => Array.from({ length: 30 }, (_, i) => `    ${words} line ${i + 2} of the entry, wrapped at a hundred columns or so.`).join("\n");
    const older =
      `295. **Saving the same words is a noop (owner,\n    2026-09-15).** It says so.\n${body("earlier")}\n\n` +
      `296. **An argument Viberr does not know is a refusal, not a silent drop (owner,\n    2026-09-16, pass 37).** The SDK builds a plain object.\n${body("the call is refused")}\n\n` +
      `297. **A server tells the model what it holds (owner, 2026-09-16).**\n${body("later")}\n`;
    const deep = older.indexOf("the call is refused line 21");
    const [hit] = find(older, "the call is refused line 21").hits;
    // Canary: lend no head to a wrapped entry, and the excerpt is three lines
    // of an entry with no number and no date; answer the line's own start and
    // a read from there opens below both.
    expect(hit!.text.startsWith("296. **An argument Viberr does not know is a refusal, not a silent drop (owner,\n2026-09-16, pass 37).** The SDK builds a plain object.")).toBe(true);
    expect(hit!.text).toContain(" … ");
    expect(hit!.text).toContain("the call is refused line 21 of the entry");
    // Nothing of the entries on either side. Canary: let the excerpt run
    // past the block's ends, and words on an entry's last line are shown
    // with the number and title of the next entry after them.
    expect(hit!.text).not.toContain("295.");
    const [last] = find(older, "the call is refused line 31").hits;
    expect(last!.text.endsWith("the call is refused line 31 of the entry, wrapped at a hundred columns or so.")).toBe(true);
    expect(last!.text).not.toContain("297.");
    const [first] = find(older, "An argument Viberr").hits;
    expect(first!.text.startsWith("296. **An argument Viberr does not know")).toBe(true);
    expect(first!.text).not.toContain("earlier");
    expect(hit!.offset).toBe(older.indexOf("296. "));
    expect(hit!.line).toBe(older.slice(0, deep).split("\n").length);
    // Words on the entry's own first lines are shown from its start, once.
    const [top] = find(older, "The SDK builds").hits;
    expect(top!.text.startsWith("296. **An argument Viberr does not know")).toBe(true);
    expect(top!.text).not.toContain(" … ");
    expect(top!.offset).toBe(older.indexOf("296. "));
    // An entry longer than a page up to the words: the read starts at the
    // words' own line. Canary: answer the entry's start whatever lies between.
    const long = `9. **A long entry (2026-01-01).**\n${Array.from({ length: 700 }, (_, i) => `    filler line ${i} of the long entry, wrapped.`).join("\n")}\n    the needle is here\n`;
    const [far] = find(long, "the needle is here").hits;
    expect(far!.offset).toBe(long.indexOf("    the needle is here"));
    expect(far!.text.startsWith("9. **A long entry (2026-01-01).**")).toBe(true);
    // A blank line inside an entry is not its head: a second paragraph under
    // the same hanging indent still belongs to the line above the first.
    // Canary: stop the walk up at the first line that does not open with a
    // space, blank ones included.
    const twoParagraphs = `5. **An entry of two paragraphs (2026-01-01).** Its first runs on\n    under a hanging indent.\n\n    Its second paragraph holds the needle.\n\n6. **The next entry.**\n`;
    const [second] = find(twoParagraphs, "holds the needle").hits;
    expect(second!.offset).toBe(0);
    expect(second!.text).toBe("5. **An entry of two paragraphs (2026-01-01).** Its first runs on\nunder a hanging indent.\nIts second paragraph holds the needle.");
    // The head is looked for 200,000 characters up and no further: no entry
    // is that long, and a file indented from end to end would cost each
    // place a walk to its top. Canary: walk up without a bound, or to
    // 100,000.
    const under = (lines: number) =>
      `0. **The only unindented line.**\n${`    ${"x".repeat(45)}\n`.repeat(lines)}    the needle is here\n`;
    const [reached] = find(under(4_000), "the needle is here").hits;
    expect(reached!.text.startsWith("0. **The only unindented line.**\nxxxx")).toBe(true);
    expect(reached!.text).toContain(" … ");
    const [lost] = find(under(4_001), "the needle is here").hits;
    expect(lost!.text).not.toContain("The only unindented line");
    expect(lost!.offset).toBe(under(4_001).indexOf("    the needle is here"));
    // Paragraphs wrapped with no indent are no block: the last line of one
    // is shown with the lines above it. Canary: take a blank line under the
    // words for an indented line, and the excerpt is cut to its own line.
    const paragraphs = "one line of the first paragraph\nand its second line\nand its last line here\n\nthe second paragraph\n";
    const [tail] = find(paragraphs, "last line here").hits;
    expect(tail!.text).toBe("one line of the first paragraph\nand its second line\nand its last line here\nthe second paragraph");
    // A line that is not indented starts its own entry: nothing is lent from
    // the entry above. Canary: walk up from every short line.
    const flat = "- 2.4.0: the cache is on by default\n".repeat(40) + "- 2.3.0: the cache can be turned off\n";
    const [own] = find(flat, "turned off").hits;
    expect(own!.offset).toBe(flat.indexOf("- 2.3.0"));
    expect(own!.text).not.toContain(" … ");
  });

  it("returns for a text that opens with a line break and is indented under it", () => {
    // The shape of a test runner's output saved to a file: a blank first
    // line, then every line indented. Walking up from index 1 for the line
    // above, `lastIndexOf` was asked for a break "at or before -1", looked at
    // index 0, found the one the text opens with and answered index 1 again.
    // Canary: take the line above as `lastIndexOf("\n", at - 2) + 1` at
    // every index, and this call never comes back: a search of such a source
    // held the one server process for good.
    const run = "\n RUN  v5.0.3 /repo\n\n Test Files  548 passed (548)\n      Tests  9750 passed | 2 skipped (9752)\n";
    const found = find(run, "passed");
    expect(found.found).toBe(2);
    expect(found.hits[0]!.line).toBe(4);
    expect(found.hits[0]!.offset).toBe(run.indexOf(" Test Files"));
    expect(find("\n  needle here\n", "needle").hits).toEqual([{ line: 2, offset: 1, text: "needle here" }]);
    expect(find("\n\n\n    indented needle\n", "needle").hits[0]!.line).toBe(4);
    expect(find("  needle on an indented first line\n", "needle").hits[0]!.offset).toBe(0);
  });

  it("a phrase that wraps inside an indented entry is shown with what follows it, and with nothing of the entries beside it", () => {
    const entries =
      "505. **The entry before (2026-09-25).** It ends here, and on, and on.\n\n" +
      "506. **A cached prefix no longer moves between sessions (2026-09-26).** Its tokens are added to the\n" +
      "    run's totals. How much of it is cached is not said, and the next sentences go on for a while\n" +
      "    under the same hanging indent, to the entry's last line.\n\n" +
      "507. **The entry after (2026-09-26).** It begins here.\n";
    // Canary: take the middle of the line the phrase ends on for the end of
    // a line, and the excerpt stops at the phrase's last word.
    const [wrapped] = find(entries, "added to the run's totals").hits;
    expect(wrapped!.line).toBe(3);
    expect(wrapped!.text).toBe(
      "506. **A cached prefix no longer moves between sessions (2026-09-26).** Its tokens are added to the\n" +
        "run's totals. How much of it is cached is not said, and the next sentences go on for a while\n" +
        "under the same hanging indent, to the entry's last line.",
    );
    // A phrase that starts on an entry's first line and ends on its last,
    // indented one: the block is looked for under the line the phrase starts
    // on. Canary: look under the line it ends on, where the next entry
    // begins, and the excerpt opens with the entry above and closes with the
    // entry below.
    const twoLines =
      "11. **The entry above (2026-01-01).** Its last words.\n" +
      "12. **A two-line entry (2026-01-02).** Its tokens are added to the\n    run's totals, and that is all of it.\n" +
      "13. **The entry below (2026-01-03).** Its first words.\n";
    const [span] = find(twoLines, "added to the run's totals").hits;
    expect(span!.text).toBe("12. **A two-line entry (2026-01-02).** Its tokens are added to the\nrun's totals, and that is all of it.");
    // A phrase that runs from an entry's last line into the next entry's
    // first: the excerpt reaches to where that line ends. Canary: take the
    // place the phrase ends for the end of its line, and the excerpt stops
    // at the phrase's last word with a mark of a cut.
    const over = "21. **An entry (2026-01-01).** It runs on\n    under an indent, to its end\n22. **The next entry (2026-01-02).** begins here and goes on a little.\n";
    const [spill] = find(over, "to its end 22. **The next entry").hits;
    expect(spill!.text).toBe("21. **An entry (2026-01-01).** It runs on\nunder an indent, to its end\n22. **The next entry (2026-01-02).** begins here and goes on a little.");
    // Words on an entry's first line whose line is longer than the excerpt
    // reaches: the line under it is still looked at, so the block is seen.
    // Canary: look below only as far as the excerpt reaches, and the excerpt
    // opens with the last words of the entry above.
    const head = `2. **The second entry turns the needle (2026-02-01).** ${"Its first line runs long. ".repeat(11)}`.trim();
    expect(head.length).toBeGreaterThan(300);
    expect(head.length).toBeLessThan(400);
    const two = `1. **The first entry.** Its last lines say the cache is off by default,\nand that nothing else changed.\n${head}\n    and it runs on under a hanging indent.\n`;
    const [onHead] = find(two, "second entry turns").hits;
    expect(onHead!.text.startsWith("2. **The second entry turns the needle")).toBe(true);
    expect(onHead!.text).not.toContain("nothing else changed");
  });

  it("reads a place from its own line when its entry starts more than a page above it", () => {
    // The middle of the three: the entry's start is too far for one page,
    // the words' own line is not. Canary: go straight from the entry's start
    // to 2,000 characters before the words.
    const deep =
      `7. **A long entry (2026-01-01).**\n${"    forty characters of an indented line..\n".repeat(900)}` +
      `    ${"word ".repeat(600)}the needle\n`;
    const [hit] = find(deep, "the needle").hits;
    const line = deep.lastIndexOf("\n", deep.indexOf("the needle")) + 1;
    expect(deep.indexOf("the needle") - line).toBeGreaterThan(2_500);
    expect(hit!.offset).toBe(line);
    expect(hit!.text.startsWith("7. **A long entry (2026-01-01).**\nforty characters")).toBe(true);
    expect(hit!.text).toContain(" … ");
  });

  it("holds its three measures: 400 characters for a line of its own, 200 for an entry shown from its start", () => {
    // A line of exactly 400 characters is a wrapped one, and its excerpt
    // takes the line under it; one more character and it is an entry of its
    // own. Canary: move the measure to 300 or to 450.
    const line = (length: number) => `${"ab ".repeat(60)}needle ${"cd ".repeat(200)}`.slice(0, length);
    const [wrapped] = find(`${line(400)}\nthe line under it\n`, "needle").hits;
    expect(wrapped!.text).toContain("\nthe line");
    const [own] = find(`${line(401)}\nthe line under it\n`, "needle").hits;
    expect(own!.text).not.toContain("the line");
    // An entry that starts within 200 characters of the excerpt is shown from
    // its start, once; one character further and its head is lent instead.
    // Canary: move the measure to 100, or to 300.
    const entry = (words: number) => `E. ${"ab ".repeat(words)}needle ${"cd ".repeat(200)}`;
    const [near] = find(entry(118), "needle").hits;
    expect(near!.text.startsWith("E. ab ab")).toBe(true);
    expect(near!.text).not.toContain(" … ");
    const [far] = find(entry(119), "needle").hits;
    expect(far!.text.startsWith("E. ab ab")).toBe(true);
    expect(far!.text).toContain(" … ");
  });

  it("takes no indented line to continue another in a file of data, where an indent is nesting", () => {
    // What `curl` of an API's releases saves. The nearest unindented line
    // above any value is the list's opening bracket, and a head lent from
    // there names the first release for every place.
    const release = (tag: string, body: string) =>
      `  {\n    "tag_name": "${tag}",\n    "published_at": "2026-01-01T10:00:00Z",\n    "body": "${body} More of the notes."\n  }`;
    const json = `[\n${[...Array.from({ length: 12 }, (_, i) => release(`v3.${12 - i}.0`, "Nothing about it.")), release("v2.9.0", "The cache is on by default.")].join(",\n")}\n]\n`;
    const body = json.indexOf('    "body": "The cache is on');
    // Canary: lend heads in a JSON file as in prose.
    const [data] = find(json, "cache is on", 0, false).hits;
    expect(data!.offset).toBe(body);
    expect(data!.text).toContain('"tag_name": "v2.9.0"');
    expect(data!.text).not.toContain("v3.12.0");
    // As prose, the same place is headed by the top of the file and read
    // from there.
    const [prose] = find(json, "cache is on").hits;
    expect(prose!.text.startsWith("[\n{\n\"tag_name\": \"v3.12.0\"")).toBe(true);
    expect(prose!.offset).toBe(0);
  });

  it("a phrase that runs off the end of a long line is shown whole, and a line under 400 characters is a wrapped one", () => {
    // Canary: keep the excerpt inside the line the words start on, and a
    // phrase that wraps onto the next line is cut before its last word.
    const longLine = `41. **An entry** ${"early ".repeat(120)}the last words of it`;
    const wrapped = `${longLine}\nrun on to the next line, which is short.\n`;
    const [across] = find(wrapped, "the last words of it run on").hits;
    expect(across!.line).toBe(1);
    expect(across!.text).toContain("the last words of it\nrun on to the next line, which is short.");
    // A line of 300 characters is a wrapped paragraph's: its excerpt carries
    // the lines around the words. Canary: take any line over 100 characters
    // for an entry of its own.
    const para = [`first ${"alpha ".repeat(49)}`, `second ${"beta ".repeat(58)}`, `third ${"gamma ".repeat(49)}`].map((l) => l.trim());
    expect(para.map((l) => l.length > 250 && l.length < 400)).toEqual([true, true, true]);
    const [mid] = find(para.join("\n"), "second beta").hits;
    expect(mid!.line).toBe(2);
    expect(mid!.text).toContain("alpha\nsecond beta");
  });

  it("marks no cut where a line ends, whatever ends it, and never answers an offset inside a surrogate pair", () => {
    // Canary: know only `\n`, and a line of a Windows file shown to its end
    // is marked as cut.
    const windows = `${"a ".repeat(50)}needle ${"b ".repeat(120).trim()}\r\nnext line\r\n`;
    const [crlf] = find(windows, "needle").hits;
    expect(crlf!.text.endsWith(" b")).toBe(true);
    // A line of emoji longer than a page: the read starts 2,000 characters
    // before the words, which here is the second half of a pair. Canary:
    // answer that index as it is.
    const pairs = `x${"😀".repeat(20_000)}yneedle`;
    const [emoji] = find(pairs, "needle").hits;
    expect(emoji!.offset).toBe(pairs.indexOf("needle") - 2_001);
    expect(pairs.slice(emoji!.offset).isWellFormed()).toBe(true);
    expect(pairs.slice(emoji!.offset, pageEnd(pairs, emoji!.offset))).toContain("needle");
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

  it("keeps the places it lists inside 24,000 bytes whatever the text's bytes", () => {
    // Three-byte characters: an excerpt of them weighs about 775 bytes, so
    // thirty fit, and forty would be 31,000: a whole page (ruling 624) before
    // the answer's own fields are added.
    const wide = Array.from({ length: 60 }, (_, i) => `${i + 1}. 記録 ${"東京都".repeat(200)}`).join("\n");
    const weigh = (hit: { line: number; offset: number; text: string }) => Buffer.byteLength(JSON.stringify(hit, null, 1));
    const listed = find(wide, "記録");
    const bytes = listed.hits.reduce((sum, hit) => sum + weigh(hit), 0);
    // Canary: cap the list by count alone, or raise the cap to 30,000.
    expect(listed.hits.length).toBeLessThan(FIND_HITS_MAX);
    expect(bytes).toBeLessThanOrEqual(24_000);
    expect(listed.nextOffset).toBe(wide.indexOf("記録", wide.indexOf(`\n${listed.hits.length + 1}. `)));
    // The place it stopped before is the one that would have passed the cap.
    const [next] = find(wide, "記録", listed.nextOffset).hits;
    expect(next!.line).toBe(listed.hits.length + 1);
    expect(bytes + weigh(next!)).toBeGreaterThan(24_000);
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

  it("counts every place, however common the words, and answers nothing for no words", () => {
    // Canary: stop the count at some cap and a reader is told a word stands
    // in 10,000 places of a text that holds it 12,000 times.
    const common = "a ".repeat(12_000);
    const counted = find(common, "a");
    expect(counted.found).toBe(12_000);
    expect(counted.hits.length).toBeGreaterThan(0);
    expect(counted.hits.length).toBeLessThanOrEqual(FIND_HITS_MAX);
    // No words is an empty pattern, which matches at every index and never
    // moves. Canary: drop the early return and this call does not come back.
    expect(findInText("abc", [])).toEqual({ words: [], found: 0, hits: [] });
    expect(findInText("", ["abc"])).toEqual({ words: ["abc"], found: 0, hits: [] });
  });
});
