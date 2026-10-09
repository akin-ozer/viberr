import { z } from "zod";
import type { ConsoleTodo, LogLine } from "./runtime-types";

/**
 * Ruling 168: an agent's to-do list, read off the console line that states
 * it. Claude writes the whole list with each `TodoWrite` call (its `todos`,
 * each a step, a status and the step's present-tense form); Codex reports its
 * plan as a `todo_list` item, which the projection carries as `todos`. The
 * row drew Claude's as `todos (5 items)` and Codex's as an empty line.
 */
export interface TodoSnapshot {
  items: ConsoleTodo[];
  done: number;
  /** The step in progress, when the list names one. */
  current: number | null;
  /** The arguments the list shows in full (ruling 168). */
  drawn: readonly string[];
}

const todoWriteInput = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
    }),
  ),
});

function snapshot(items: ConsoleTodo[], drawn: readonly string[]): TodoSnapshot | null {
  if (items.length === 0) return null;
  const current = items.findIndex((item) => item.status === "in_progress");
  return {
    items,
    done: items.filter((item) => item.status === "completed").length,
    current: current < 0 ? null : current,
    drawn,
  };
}

/** The to-do list a line states, or null when it states none. */
export function consoleTodos(line: LogLine): TodoSnapshot | null {
  if (line.todos) return snapshot(line.todos, []);
  if (line.ev !== "tool" || line.name !== "TodoWrite" || !line.input) return null;
  const input = todoWriteInput.safeParse(line.input);
  if (!input.success) return null;
  return snapshot(
    input.data.todos
      .filter((todo) => todo.content.trim() !== "")
      .map((todo) => ({ text: todo.content, status: todo.status })),
    ["todos"],
  );
}
