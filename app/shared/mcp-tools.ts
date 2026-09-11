/**
 * Ruling 176 (amends 39): an org MCP server's WRITE tools, as an admin marks
 * them in the MCP server editor. MCP grants stay outside the capability matrix,
 * but a marked name is denied on every run whose `execute-code-or-write-repo`
 * grant is withheld (and on every operator run, which never writes). Viberr
 * still makes no claim about a tool the admin has not marked.
 *
 * Shared by the editor (validation, the discovery suggestion) and the server
 * (the save, the run mount, the Claude deny rule).
 */

/** An MCP tool name as the MCP spec draws it: 1-128 characters, letters,
 *  digits, `_`, `-` and `.`. Checked on save so a typo cannot become a deny
 *  rule that matches nothing. */
export const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** More names than any real server exposes; a bound on what one save stores. */
export const MCP_WRITE_TOOLS_MAX = 200;

/** The discovery heuristic's verbs (ruling 176 / plan D2(c)). */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "delete",
  "merge",
  "push",
  "update",
  "write",
  "remove",
]);

/** A tool name's words, lowercased: snake_case, kebab-case, dotted and
 *  camelCase all split, so `createOrUpdateFile` and `create_or_update_file`
 *  read the same and `pushed_at` is not `push`. */
function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a discovered tool LOOKS like it writes: one of its words is a write
 * verb. Only ever a suggestion the editor pre-ticks for a server nobody has
 * reviewed yet; the admin's save is what makes a name a deny rule.
 */
export function looksLikeWriteTool(name: string): boolean {
  return toolNameWords(name).some((word) => WRITE_VERBS.has(word));
}

/** One mounted org server's marked write tools, withheld from a run. The tool
 *  names are the server's own (what Codex's `disabled_tools` takes); the Claude
 *  rule is derived with {@link claudeMcpToolName}. */
export interface McpToolDenial {
  server: string;
  tools: string[];
}

/** The part of an MCP name the Claude CLI keeps: every character outside
 *  `[A-Za-z0-9_-]` becomes `_`, in the server name and the tool name alike. */
function claudeMcpSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The name the Claude CLI gives a server's tool, which is what a
 *  `disallowedTools` entry must match: `mcp__<server>__<tool>`. */
export function claudeMcpToolName(server: string, tool: string): string {
  return `mcp__${claudeMcpSegment(server)}__${claudeMcpSegment(tool)}`;
}
