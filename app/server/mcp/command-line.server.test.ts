import { describe, expect, it } from "vitest";
import { parseCommandLine } from "./command-line.server";

describe("parseCommandLine", () => {
  it("preserves quoted arguments without running a shell", () => {
    expect(
      parseCommandLine(`node "server path/main.js" --label 'billing api' --empty ""`),
    ).toEqual([
      "node",
      "server path/main.js",
      "--label",
      "billing api",
      "--empty",
      "",
    ]);
  });

  it("supports escaped whitespace and rejects malformed input", () => {
    expect(parseCommandLine("node server\\ path.js")).toEqual([
      "node",
      "server path.js",
    ]);
    expect(parseCommandLine(`node "unterminated`)).toBeNull();
    expect(parseCommandLine("node trailing\\")).toBeNull();
    expect(parseCommandLine("   ")).toEqual([]);
  });
});
