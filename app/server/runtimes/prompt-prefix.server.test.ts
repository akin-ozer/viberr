import { describe, expect, it } from "vitest";
import {
  claudeSystemPromptBlocks,
  dynamicPromptText,
  isPromptPrefix,
  joinedPrompt,
  sortedBy,
  sortedNames,
  sortedRecord,
  staticPromptText,
} from "./prompt-prefix.server";

describe("ruling 370: prompt prefix ordering", () => {
  it("Claude gets static, the SDK's boundary, then dynamic", () => {
    // The marker is the SDK's own, never a look-alike.
    expect(claudeSystemPromptBlocks({ static: ["a", "b"], dynamic: ["c"] })).toEqual([
      "a",
      "b",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "c",
    ]);
  });

  it("an empty dynamic block carries no boundary", () => {
    expect(claudeSystemPromptBlocks({ static: ["a"], dynamic: [] })).toEqual(["a"]);
  });

  it("Codex gets the same text, in the same order, joined", () => {
    expect(joinedPrompt({ static: ["a", "b"], dynamic: ["c"] })).toBe("abc");
    expect(joinedPrompt("plain")).toBe("plain");
    expect(staticPromptText({ static: ["a", "b"], dynamic: ["c"] })).toBe("ab");
    expect(dynamicPromptText({ static: ["a", "b"], dynamic: ["c"] })).toBe("c");
  });

  it("tells a split from a plain string", () => {
    expect(isPromptPrefix({ static: [], dynamic: [] })).toBe(true);
    expect(isPromptPrefix("x")).toBe(false);
    expect(isPromptPrefix(undefined)).toBe(false);
  });

  it("sorts names by code point, deduplicated, whatever the input order", () => {
    expect(sortedNames(["b", "a", "b", "B"])).toEqual(["B", "a", "b"]);
    expect(sortedNames(["viberr:z", "viberr:a"])).toEqual(["viberr:a", "viberr:z"]);
    expect(sortedNames([])).toEqual([]);
  });

  it("sorts records by a key and maps by their keys", () => {
    expect(sortedBy([{ n: "b" }, { n: "a" }], (x) => x.n)).toEqual([{ n: "a" }, { n: "b" }]);
    expect(Object.keys(sortedRecord({ z: 1, a: 2, m: 3 }))).toEqual(["a", "m", "z"]);
    // Sorting is a copy: the input is untouched.
    const input = ["b", "a"];
    sortedNames(input);
    expect(input).toEqual(["b", "a"]);
  });
});
