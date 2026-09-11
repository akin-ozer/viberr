import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SpecialistMcpServerConfig } from "~/server/tasks/specialist-mcp.server";

/**
 * Which of a mounted in-process MCP server's tools the model sees up front and
 * which it must find through ToolSearch first (Option D PR 4(a)).
 *
 * `createSdkMcpServer({ alwaysLoad: true })` stamps `anthropic/alwaysLoad` onto
 * each tool's `_meta` as it registers it on the live `McpServer` it hands back
 * under `instance`. `_registeredTools` is that server's own registry and is
 * `private` in the SDK's types, so it is read by parsing the shape expected: an
 * SDK rename throws here instead of reading every tool as deferred.
 */
const registry = z
  .object({
    instance: z.object({
      _registeredTools: z.record(
        z.string(),
        z.object({
          _meta: z.object({ "anthropic/alwaysLoad": z.boolean().optional() }).optional(),
        }),
      ),
    }),
  })
  .transform((mounted) => Object.entries(mounted.instance._registeredTools));

/** A mount's tool names, split by whether the model sees them up front. */
export interface ToolLoading {
  loaded: string[];
  deferred: string[];
}

/** `server` is one entry of a run's `mcpServers`, whichever transport; only an
 *  in-process one has the registry, and anything else throws in the parse. */
export function toolLoading(
  server: McpSdkServerConfigWithInstance | SpecialistMcpServerConfig | undefined,
): ToolLoading {
  const tools = registry.parse(server);
  const loaded = tools.filter(([, t]) => t._meta?.["anthropic/alwaysLoad"] === true);
  const deferred = tools.filter(([, t]) => t._meta?.["anthropic/alwaysLoad"] !== true);
  return { loaded: loaded.map(([name]) => name), deferred: deferred.map(([name]) => name) };
}
