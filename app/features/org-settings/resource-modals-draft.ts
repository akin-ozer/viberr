import { useState } from "react";
import type { McpView } from "~/server/org/resources.server";
import { looksLikeWriteTool, MCP_TOOL_NAME_RE } from "~/shared/mcp-tools";

/**
 * The MCP-server editor's write-tool draft (ruling 695(e), the split of
 * `resource-modals.tsx`): the marks and the names typed in. McpModal calls it
 * where its state always registered, after the connection's own fields. No
 * component lives here, so the module is not a Fast Refresh boundary.
 */

/**
 * Ruling 176: the write-tool marks. The editor proposes and the admin
 * decides: a server nobody has reviewed opens with the discovery suggestion
 * selected; a reviewed one opens with exactly what was saved.
 */
export function useMcpWriteTools(initial: McpView | null) {
  const discovered = initial?.discoveredTools ?? [];
  const reviewed = initial?.writeToolsReviewed ?? false;
  const [marked, setMarked] = useState<string[]>(() =>
    reviewed ? (initial?.writeTools ?? []) : discovered.filter(looksLikeWriteTool),
  );
  const [typed, setTyped] = useState<string[]>([]);
  const [draftTool, setDraftTool] = useState("");
  const toolChoices = [
    ...new Set([...discovered, ...(initial?.writeTools ?? []), ...typed]),
  ];
  const suggested = !reviewed && marked.length > 0;
  const draftValid = MCP_TOOL_NAME_RE.test(draftTool.trim());
  const addDraftTool = () => {
    const tool = draftTool.trim();
    if (!MCP_TOOL_NAME_RE.test(tool)) return;
    if (!toolChoices.includes(tool)) setTyped((list) => [...list, tool]);
    if (!marked.includes(tool)) setMarked((list) => [...list, tool]);
    setDraftTool("");
  };
  return {
    reviewed,
    marked,
    setMarked,
    toolChoices,
    suggested,
    draftTool,
    setDraftTool,
    draftValid,
    addDraftTool,
  };
}

export type McpWriteTools = ReturnType<typeof useMcpWriteTools>;
