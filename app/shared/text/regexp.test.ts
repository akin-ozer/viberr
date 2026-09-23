import { describe, expect, it } from "vitest";
import { escapeRegExp } from "./regexp";

describe("escapeRegExp", () => {
  it("backslash-escapes every metacharacter", () => {
    expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
  });

  it("leaves everything else as it was", () => {
    expect(escapeRegExp("mcp-server/github_2 é")).toBe("mcp-server/github_2 é");
    expect(escapeRegExp("")).toBe("");
  });

  it("matches the value literally inside a larger pattern", () => {
    const value = "a.b*(c)[d]{1}|e?^$\\";
    expect(new RegExp(`^${escapeRegExp(value)}$`).test(value)).toBe(true);
    expect(new RegExp(`^${escapeRegExp("a.b")}$`).test("axb")).toBe(false);
  });
});
