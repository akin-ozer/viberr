import { describe, expect, it } from "vitest";
import { highlightCode, type CodeToken } from "./code-highlight";

/** One line through the reader's own pipeline: the grammar `code-highlight.ts`
 *  loads for "log", the JavaScript engine, the css-variables classes. */
async function tokensOf(line: string): Promise<CodeToken[]> {
  const lines = await highlightCode(line, "log");
  expect(lines).not.toBeNull();
  expect(lines).toHaveLength(1);
  const [tokens] = lines!;
  // Tokenizing never changes what the reader says.
  expect(tokens!.map((token) => token.text).join("")).toBe(line);
  return tokens!;
}

/** The coloured tokens of a line, text → class. */
async function coloured(line: string): Promise<[string, string][]> {
  return (await tokensOf(line)).flatMap((token): [string, string][] =>
    token.className ? [[token.text, token.className]] : [],
  );
}

/* Ruling 508: the reader's log grammar colours a number whole or not at all,
   and each level by its severity. */
describe("log grammar (ruling 508)", () => {
  it("colours Node's test durations whole and leaves the digits of a name alone (the owner's screenshot)", async () => {
    expect(
      await coloured(
        "✔ Medium: the post deleted in 2019 (W-004) and malformed items are rejected, never kept (0.390959ms)",
      ),
    ).toEqual([
      ["2019", "tk-constant"],
      ["0.390959ms", "tk-constant"],
    ]);
    expect(await coloured('✔ "Akin O\\u0308zer" normalises to "akin ozer" (0.075834ms)')).toEqual([
      ['"Akin O\\u0308zer"', "tk-string"],
      ['"akin ozer"', "tk-string"],
      ["0.075834ms", "tk-constant"],
    ]);
  });

  it("takes a number as one token: fractions, dotted addresses, units, signs and exponents", async () => {
    expect(
      await coloured("connect ECONNREFUSED 127.0.0.1:5432 after 1.5s; heap 85.5% of 1.5GB"),
    ).toEqual([
      ["127.0.0.1", "tk-constant"],
      ["5432", "tk-constant"],
      ["1.5s", "tk-constant"],
      ["85.5%", "tk-constant"],
      ["1.5GB", "tk-constant"],
    ]);
    expect(await coloured("ℹ duration_ms 85.123, exit code -1, ratio 1e-9, total 3.")).toEqual([
      ["85.123", "tk-constant"],
      ["-1", "tk-constant"],
      ["1e-9", "tk-constant"],
      ["3", "tk-constant"],
    ]);
    // Ten digits and a fraction is a time, not a hash followed by `.123`.
    expect(await coloured("ts=1727349634.123")).toEqual([["1727349634.123", "tk-constant"]]);
  });

  it("never colours part of a word: ids, identifiers and hashes keep their shape", async () => {
    expect(await coloured("SHOP-65 on x86_64 retried W-031")).toEqual([]);
    expect(await coloured("commit 5c99043 id 8dcd9184-0133-591f-8684-b80376cf3cae 0x1f")).toEqual([
      ["5c99043", "tk-constant"],
      ["8dcd9184-0133-591f-8684-b80376cf3cae", "tk-constant"],
      ["0x1f", "tk-constant"],
    ]);
    expect(await coloured("flags true false null")).toEqual([
      ["true", "tk-constant"],
      ["false", "tk-constant"],
      ["null", "tk-constant"],
    ]);
  });

  it("colours each level by severity: error red and bold, warning orange, info green, debug blue", async () => {
    const level = async (line: string) => (await coloured(line)).find(([text]) => /[A-Z]{4}/.test(text));
    expect(await level("2026-09-25 11:20:36.442 ERROR request failed")).toEqual([
      "ERROR",
      "tk-deleted tk-b",
    ]);
    expect(await level("2026-09-25 11:20:35.001 WARN retrying")).toEqual(["WARN", "tk-changed"]);
    expect(await level("2026-09-25 11:20:34.120 INFO started")).toEqual(["INFO", "tk-inserted"]);
    expect(await level("2026-09-25 11:20:36.443 DEBUG pool")).toEqual(["DEBUG", "tk-constant"]);
    expect(await level("2026-09-25 11:20:36.444 TRACE enter")).toEqual(["TRACE", "tk-comment"]);
    // The timestamps are the grammar's, unchanged: comments.
    expect(await coloured("2026-09-25 11:20:34.120")).toEqual([
      ["2026-09-25", "tk-comment"],
      ["11:20:34.120", "tk-comment"],
    ]);
  });
});
