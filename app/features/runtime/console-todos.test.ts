import { describe, expect, it } from "vitest";
import { consoleTodos } from "./console-todos";
import type { LogLine } from "./runtime-types";

describe("ruling 168: consoleTodos reads the agent's to-do list off its line", () => {
  it("reads Claude's TodoWrite: each step, its status, the count done and the step under way", () => {
    const line: LogLine = {
      t: "10:00:00",
      ev: "tool",
      tag: "tool_use",
      name: "TodoWrite",
      text: "todos: [3 items]",
      input: {
        todos: [
          { content: "Read the runbook", status: "completed", activeForm: "Reading" },
          { content: "Correct the steps", status: "in_progress", activeForm: "Correcting" },
          { content: "Run the link check", status: "pending", activeForm: "Running" },
          { content: "  ", status: "pending", activeForm: "" },
        ],
      },
    };
    expect(consoleTodos(line)).toEqual({
      items: [
        { text: "Read the runbook", status: "completed" },
        { text: "Correct the steps", status: "in_progress" },
        { text: "Run the link check", status: "pending" },
      ],
      done: 1,
      current: 1,
      drawn: ["todos"],
    });
  });

  it("reads a status it does not know as waiting, never as done", () => {
    const line: LogLine = {
      t: "10:00:00",
      ev: "tool",
      tag: "tool_use",
      name: "TodoWrite",
      text: "",
      input: { todos: [{ content: "Ship", status: "blocked" }] },
    };
    expect(consoleTodos(line)!.items).toEqual([{ text: "Ship", status: "pending" }]);
  });

  it("reads Codex's projected steps, which name no step under way", () => {
    const line: LogLine = {
      t: "10:00:00",
      ev: "meta",
      tag: "todo_list",
      text: "1 of 2 to-dos done",
      todos: [
        { text: "Plan", status: "completed" },
        { text: "Build", status: "pending" },
      ],
    };
    expect(consoleTodos(line)).toMatchObject({ done: 1, current: null, drawn: [] });
  });

  it("states nothing for any other line, or an empty list", () => {
    expect(consoleTodos({ t: "10:00:00", ev: "tool", tag: "tool_use", name: "Bash", text: "ls", input: { command: "ls" } })).toBeNull();
    expect(consoleTodos({ t: "10:00:00", ev: "tool", tag: "tool_use", name: "TodoWrite", text: "", input: { todos: [] } })).toBeNull();
    expect(consoleTodos({ t: "10:00:00", ev: "tool", tag: "tool_use", name: "TodoWrite", text: "", input: { todos: "x" } })).toBeNull();
  });
});
