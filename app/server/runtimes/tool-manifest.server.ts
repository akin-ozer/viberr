import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

/** Longest a manifest line's purpose runs before it is cut at a word. */
const PURPOSE_CHARS = 150;

/**
 * The first sentence of a tool description, which is written to carry the
 * verb. Abbreviations that end in a period are common in these descriptions
 * ("e.g.", "i.e."), so a sentence ends at a period followed by a space and a
 * capital, and nothing shorter counts.
 */
function firstSentence(description: string): string {
  const match = /^(.*?[.!?])(?:\s+[A-Z(`])/s.exec(description.trim());
  const sentence = (match?.[1] ?? description.trim()).replace(/\s+/g, " ");
  if (sentence.length <= PURPOSE_CHARS) return sentence;
  const cut = sentence.slice(0, PURPOSE_CHARS);
  const atWord = cut.slice(0, cut.lastIndexOf(" "));
  return `${atWord}... (clipped; the whole description is in the tool itself)`;
}

/**
 * Ruling 297: a server tells the model what it holds, in a list built from
 * the tools it is actually mounting.
 *
 * The controller's tools are deferred behind ToolSearch, which is measured and
 * deliberate (ruling 185's successor: `alwaysLoad` on these servers tripled
 * turn 1 and quadrupled a cold turn). What nobody costed is that a deferred
 * toolkit never arrives as a LIST. The controller reported, from inside its
 * own prompt: three tools are fully present, everything else is names only in
 * a per-turn reminder, and "the list is incremental, not a manifest -- the
 * turn that shipped `list_decisions` listed four names, the turn that shipped
 * `read_timeline_entry` listed three. So the complete toolkit exists in my
 * context only as a union across eleven turns of reminders, never as one
 * list."
 *
 * The cost of that is not a wasted search. It is that the controller could
 * only answer "do I have `accept_completion`" by searching and finding
 * nothing, which is the weakest evidence there is, and it told a person it was
 * driving a board with four verbs it did not have.
 *
 * Generated, never written by hand, because the hand-written copy in the
 * controller's own prompt had ALREADY drifted: "Built-in diagnostics
 * (viberr_ops) are always attached: instance health, run logs, store
 * documents" named three capabilities, and `list_runs` shipped after that
 * sentence and was never added to it.
 */
/** The name a server tool has once the SDK mounts it, and the only name ToolSearch answers to. */
export function mountedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export function toolManifest(tools: SdkMcpToolDefinition[], serverName: string): string {
  // Each line carries the name ToolSearch and the call itself take: the SDK mounts
  // a server tool as `mcp__<server>__<name>`, and the bare registry name is not
  // a tool anywhere the model can reach. Measured before this line changed: 8 of
  // the 40 controller runs that searched began with a bare-name `select:` and
  // got "No matching deferred tools found" (14 wasted calls), because this
  // manifest told them `select:<name>` and listed the bare names.
  const lines = tools.map(
    (t) => `- ${mountedToolName(serverName, t.name)}: ${firstSentence(t.description)}`,
  );
  return [
    "",
    `# Every tool on ${serverName} (${tools.length})`,
    "",
    "Generated from this server's live registry as it mounted, so it cannot",
    "drift from what you actually hold. Arguments and the full description are",
    "one ToolSearch away (`select:` followed by the full name exactly as listed",
    "below); this list is what tells you the verb EXISTS.",
    "",
    "If a verb you want is not on this list, you do not have it. Say that",
    "plainly rather than searching and reporting the absence of a result: a",
    "search that returns nothing is not evidence, and this list is.",
    "",
    ...lines,
  ].join("\n");
}
