import { describe, expect, it } from "vitest";
import {
  BACKEND_MENTION_HANDLES,
  CONTROLLER_MENTION_HANDLE,
  findMentionSpans,
  isRoleMentionHandle,
  RESERVED_MENTION_HANDLES,
} from "./mention-spans";

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

describe("the reserved handles (one home)", () => {
  it("pins the base and every difference the derived lists name", () => {
    // The base: the known names here and agent-reply's resolver, in this order.
    expect(RESERVED_MENTION_HANDLES).toEqual(["operator", "agent", "claude", "codex"]);
    // mention-suggestions: the role handles it labels, in this order…
    expect(RESERVED_MENTION_HANDLES.filter(isRoleMentionHandle)).toEqual([
      "operator",
      "agent",
    ]);
    // …then the backend handles it offers per project (B-AG2), in this order.
    expect(BACKEND_MENTION_HANDLES).toEqual(["claude", "codex"]);
    // mention-notify: the base plus the controller's handle (ruling 99), which
    // is not reserved on a task.
    expect(CONTROLLER_MENTION_HANDLE).toBe("controller");
    expect(RESERVED_MENTION_HANDLES).not.toContain(CONTROLLER_MENTION_HANDLE);
  });

  it("treats every reserved handle as known, and the controller's as a plain token", () => {
    const known = (text: string) => findMentionSpans(text, []).map((s) => s.known);
    expect(known("@operator @agent @claude @codex")).toEqual([true, true, true, true]);
    expect(known("@controller")).toEqual([false]);
  });
});
