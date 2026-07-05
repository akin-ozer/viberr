import { describe, expect, it } from "vitest";
import { findMentionSpans } from "./mention-spans";

/** Slice each span's text out for readable assertions. */
function spans(text: string, names: string[]): string[] {
  return findMentionSpans(text, names).map((s) => text.slice(s.start, s.end));
}

describe("findMentionSpans", () => {
  it("matches a single-token @handle with no known names (fallback grammar)", () => {
    expect(spans("hi @dev and @operator", [])).toEqual(["@dev", "@operator"]);
  });

  it("matches a KNOWN multi-word name as ONE span", () => {
    expect(spans("cc @Arda Kaya please", ["Arda Kaya"])).toEqual(["@Arda Kaya"]);
  });

  it("prefers the longest known name (Arda Kaya over Arda)", () => {
    expect(spans("@Arda Kaya", ["Arda", "Arda Kaya"])).toEqual(["@Arda Kaya"]);
  });

  it("is case-insensitive but preserves the original text", () => {
    expect(spans("ping @arda kaya", ["Arda Kaya"])).toEqual(["@arda kaya"]);
  });

  it("respects word boundaries — does not match a name inside a longer word", () => {
    // "@Ardavan" must not match the name "Arda"; it falls back to the token.
    expect(spans("@Ardavan", ["Arda"])).toEqual(["@Ardavan"]);
  });

  it("only starts a mention at start-of-string or after whitespace", () => {
    expect(spans("email me@example please", ["example"])).toEqual([]);
  });

  it("stops a known-name match at trailing punctuation", () => {
    expect(spans("thanks @Arda Kaya!", ["Arda Kaya"])).toEqual(["@Arda Kaya"]);
  });

  it("handles multiple mentions in one string", () => {
    expect(spans("@Arda Kaya and @dev", ["Arda Kaya", "dev"])).toEqual([
      "@Arda Kaya",
      "@dev",
    ]);
  });
});
