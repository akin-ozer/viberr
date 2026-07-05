import { describe, expect, it } from "vitest";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import {
  detectMentionToken,
  filterMentions,
  flattenMentionables,
  insertMention,
  splitHighlight,
} from "./mention-autocomplete";

/**
 * Pure-logic unit tests for the @-mention autocomplete: token detection at the
 * caret, filter/rank, highlight splitting, and insertion. No DOM.
 */

const MENTIONABLES: Mentionables = {
  agents: [
    { handle: "dev", name: "dev", role: "developer", backend: "claude" },
    { handle: "qa", name: "qa", role: "reviewer", backend: "codex" },
  ],
  users: [
    { handle: "arda", name: "Arda Kaya", email: "arda@viberr.test" },
    { handle: "murat", name: "Murat Yilmaz", email: "murat@viberr.test" },
  ],
  reserved: [
    { handle: "operator", label: "Operator" },
    { handle: "agent", label: "Primary specialist" },
    { handle: "claude", label: "Claude specialist" },
    { handle: "codex", label: "Codex specialist" },
  ],
};

describe("detectMentionToken", () => {
  it("does not trigger on a bare @ (needs ≥1 char after it)", () => {
    expect(detectMentionToken("@", 1)).toBeNull();
    expect(detectMentionToken("hey @", 5)).toBeNull();
  });

  it("detects @de with caret at end of the token", () => {
    const t = detectMentionToken("@de", 3);
    expect(t).toEqual({ query: "de", start: 0, end: 3 });
  });

  it("detects a token after whitespace mid-line", () => {
    const t = detectMentionToken("ping @dev now", 9);
    expect(t).toEqual({ query: "dev", start: 5, end: 9 });
  });

  it("lowercases the query for case-insensitive matching", () => {
    expect(detectMentionToken("@DeV", 4)?.query).toBe("dev");
  });

  it("does not trigger when @ is glued to a preceding word (email-like)", () => {
    expect(detectMentionToken("mail me a@b", 11)).toBeNull();
  });

  it("only considers the token immediately left of the caret", () => {
    // caret inside the second token
    const t = detectMentionToken("@dev and @qa", 12);
    expect(t).toEqual({ query: "qa", start: 9, end: 12 });
    // caret right after a completed token + space → no active token
    expect(detectMentionToken("@dev ", 5)).toBeNull();
  });
});

describe("filterMentions", () => {
  const all = flattenMentionables(MENTIONABLES);

  it("orders groups agents, then reserved, then users", () => {
    const kinds = all.map((s) => s.kind);
    expect(kinds.indexOf("agent")).toBeLessThan(kinds.indexOf("reserved"));
    expect(kinds.indexOf("reserved")).toBeLessThan(kinds.indexOf("user"));
  });

  it("start-of-string match ranks above substring match", () => {
    // "de" prefixes agent "dev"; also occurs nowhere else → single hit
    const out = filterMentions(all, "de");
    expect(out[0]!.handle).toBe("dev");
  });

  it("matches on handle or display name, case-insensitively", () => {
    const out = filterMentions(all, "ARDA");
    expect(out.some((s) => s.handle === "arda")).toBe(true);
    // display-name substring "kaya"
    expect(filterMentions(all, "kaya").some((s) => s.handle === "arda")).toBe(true);
  });

  it("caps the result list", () => {
    expect(filterMentions(all, "", 3)).toHaveLength(3);
  });

  it("returns nothing for a non-matching query", () => {
    expect(filterMentions(all, "zzz")).toHaveLength(0);
  });
});

describe("splitHighlight", () => {
  it("splits the label around the matched substring", () => {
    expect(splitHighlight("dev", "de")).toEqual({ before: "", match: "de", after: "v" });
  });

  it("is case-insensitive but preserves the label's original casing", () => {
    expect(splitHighlight("Arda Kaya", "arda")).toEqual({
      before: "",
      match: "Arda",
      after: " Kaya",
    });
  });

  it("returns an empty match when the query does not occur", () => {
    expect(splitHighlight("dev", "zz")).toEqual({ before: "dev", match: "", after: "" });
  });
});

describe("insertMention", () => {
  it("replaces the active token with `@handle ` and returns the caret", () => {
    const token = detectMentionToken("hey @de", 7)!;
    const { text, caret } = insertMention("hey @de", token, "dev");
    expect(text).toBe("hey @dev ");
    expect(caret).toBe("hey @dev ".length);
  });

  it("preserves text after the token", () => {
    const token = detectMentionToken("@de done", 3)!;
    const { text } = insertMention("@de done", token, "dev");
    expect(text).toBe("@dev  done");
  });
});
