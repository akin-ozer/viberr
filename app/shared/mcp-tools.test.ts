import { describe, expect, it } from "vitest";
import { claudeMcpToolName, looksLikeWriteTool, MCP_TOOL_NAME_RE } from "./mcp-tools";

describe("the write-tool suggestion (ruling 176)", () => {
  it("matches a write verb as a WORD, in snake, kebab, dotted and camel case", () => {
    for (const name of [
      "create_pull_request",
      "merge-pull-request",
      "repo.push",
      "createOrUpdateFile",
      "delete_file",
      "write_file",
      "remove_label",
      "update_issue",
    ]) {
      expect(looksLikeWriteTool(name), name).toBe(true);
    }
  });

  it("leaves names that only CONTAIN a verb's letters, and plain reads", () => {
    for (const name of ["get_issue", "list_commits", "pushed_at", "search_updates", "recreate"]) {
      expect(looksLikeWriteTool(name), name).toBe(false);
    }
  });
});

describe("MCP tool names (ruling 176)", () => {
  it("accepts the MCP spec's alphabet and refuses anything a deny rule could not match", () => {
    expect(MCP_TOOL_NAME_RE.test("create_pull_request")).toBe(true);
    expect(MCP_TOOL_NAME_RE.test("repo.merge-v2")).toBe(true);
    expect(MCP_TOOL_NAME_RE.test("create pull request")).toBe(false);
    expect(MCP_TOOL_NAME_RE.test("")).toBe(false);
    expect(MCP_TOOL_NAME_RE.test("x".repeat(129))).toBe(false);
  });

  it("builds the name the Claude CLI gives a tool, normalizing like the CLI", () => {
    expect(claudeMcpToolName("github", "create_pull_request")).toBe(
      "mcp__github__create_pull_request",
    );
    expect(claudeMcpToolName("everything-http", "repo.merge")).toBe(
      "mcp__everything-http__repo_merge",
    );
  });
});
