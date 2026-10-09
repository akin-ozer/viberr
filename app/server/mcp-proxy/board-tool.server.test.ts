import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { boardArgsRefusal, BOARD_TOOLS } from "./board-tool.server";

/**
 * Ruling 216: what the Codex board server answers to arguments that are not a
 * tool's. It names each argument by what it takes, because a reader takes
 * `offset`: a run told a number is text sends `"32000"` and is refused again.
 */
describe("ruling 216: a board tool's refusal names each argument by what it takes", () => {
  const sentence = (tool: Tool) => {
    const refusal = boardArgsRefusal(tool);
    expect(refusal.isError).toBe(true);
    const [block] = refusal.content;
    return block?.type === "text" ? block.text : "";
  };

  it("reads the sentence off the schema the tool publishes", () => {
    // Canary: call every argument text, or say a whole number starts at 0
    // when the schema gives it no floor.
    const mixed: Tool = {
      name: "read_x",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          from: { type: "integer", minimum: 3 },
          line: { type: "integer" },
          scale: { type: "number" },
          taskKey: { type: "string" },
        },
        required: ["name", "from"],
      },
    };
    expect(sentence(mixed)).toBe(
      "read_x takes `name` and `taskKey` as text, `from` as a whole number from 3, `line` as a whole number and `scale` as a number; " +
        "`name` and `from` are required. Nothing was read.",
    );
    // A tool that refuses what it does not declare says so, and one that
    // does not is not said to. Canary: say "and nothing else" of every tool.
    const strict: Tool = { name: "read_y", inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } };
    expect(sentence(strict)).toBe("read_y takes `id` as text, and nothing else. Nothing was read.");
    const numbersOnly: Tool = { name: "read_z", inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 } } } };
    expect(sentence(numbersOnly)).toBe("read_z takes `offset` as a whole number from 0. Nothing was read.");
  });

  it("every reader this server lists says it takes nothing else", () => {
    // The sentence and the parser can drift apart only through the published
    // schema: the gateway's own test holds each parser to it. Canary: publish
    // a reader without `additionalProperties: false`.
    expect(BOARD_TOOLS.map((tool) => [tool.name, tool.inputSchema.additionalProperties])).toEqual([
      ["read_board", false],
      ["read_timeline_entry", false],
      ["read_task_attachment", false],
      ["read_task_source", false],
    ]);
    for (const tool of BOARD_TOOLS) expect(sentence(tool)).toContain(", and nothing else");
  });
});
