import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Ruling 169: ONE home for how a run's system prompt is ORDERED so its prefix
 * caches across tasks.
 *
 * A prompt is built as two blocks. `static` holds nothing that varies per task,
 * per run or per minute — the definition, the project persona, skill bodies,
 * knowledge-base indexes, the ruling-namespace note, the resource ground truth
 * and the closing rules. `dynamic` holds the per-task tail: the workspace
 * section, MCP gating and health notes, missing-resource notices, anything
 * with a path, a task key or a run id in it. Every list inside the static
 * block is sorted by name before it is rendered (`sortedNames`), so two
 * dispatches of one profile on two tasks produce a byte-identical static
 * block, whatever order the grants were stored in.
 *
 * Claude consumes the split as a `string[]` system prompt with the SDK's
 * boundary marker between the blocks (each side gets its own cache
 * breakpoint); the specialist preset takes the static block as its `append`
 * and the dynamic block rides the first user message. Codex has no split and
 * takes the same text, in the same order, joined into `developer_instructions`.
 */
export interface PromptPrefix {
  static: string[];
  dynamic: string[];
}

/** A prompt as the run spec carries it: the split, or a plain string a caller
 *  built without one (tests; a persona-less run). */
export type RunPrompt = string | PromptPrefix;

/** The split's shape, so a caller can tell it from a plain string without a
 *  representation check. */
const promptPrefixSchema = z.object({ static: z.array(z.string()), dynamic: z.array(z.string()) });

export function isPromptPrefix(prompt: RunPrompt | undefined): prompt is PromptPrefix {
  return promptPrefixSchema.safeParse(prompt).success;
}

/** The blocks Claude's custom-prompt form takes: static, the boundary, dynamic.
 *  A prefix with an empty dynamic block carries no boundary — the marker would
 *  otherwise open a second breakpoint on nothing. */
export function claudeSystemPromptBlocks(prefix: PromptPrefix): string[] {
  return prefix.dynamic.length
    ? [...prefix.static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...prefix.dynamic]
    : [...prefix.static];
}

/** The same text joined: Codex's `developer_instructions`, and what a test
 *  reads when it asserts on the prompt as one document. */
export function joinedPrompt(prompt: RunPrompt): string {
  if (!isPromptPrefix(prompt)) return prompt;
  return [...prompt.static, ...prompt.dynamic].join("");
}

/** The static block alone, as one string (the specialist preset's append). */
export function staticPromptText(prefix: PromptPrefix): string {
  return prefix.static.join("");
}

/** The dynamic block alone, as one string (the specialist's first-turn tail). */
export function dynamicPromptText(prefix: PromptPrefix): string {
  return prefix.dynamic.join("");
}

/**
 * Names in a deterministic order: deduplicated and sorted by code point, so
 * the same grants stored in any order render the same bytes. Code-point order
 * on purpose — `localeCompare` depends on the process locale, and a prefix
 * that differs between two servers is not a shared prefix.
 */
export function sortedNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Records in a deterministic order by one string field, without dedupe. */
export function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** A record with its keys in `sortedNames` order — what a JSON serialization
 *  of an MCP-server map has to be for two runs to send the same bytes. */
export function sortedRecord<T>(record: Readonly<Record<string, T>>) {
  return Object.fromEntries(sortedNames(Object.keys(record)).map((key) => [key, record[key]!]));
}
