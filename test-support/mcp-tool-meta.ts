import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SpecialistMcpServerConfig } from "~/server/tasks/specialist-mcp.server";
import type { JsonValue } from "~/features/runtime/runtime-types";

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

/**
 * Ruling 296: every tool's schema is a whole strict Zod object now, so a test
 * can no longer read a field off `inputSchema` as though it were the raw field
 * map the SDK's own `tool()` used to keep. It reads the PUBLISHED JSON Schema
 * instead, through a real MCP client, which is the copy a model is handed and
 * the only one whose wrongness could reach anybody.
 */
export async function publishedSchemas(
  server: McpSdkServerConfigWithInstance | SpecialistMcpServerConfig | undefined,
): Promise<Map<string, JsonValue>> {
  // A run's `mcpServers` mixes in-process servers with portable HTTP/stdio
  // declarations; only the first kind has a registry to ask.
  if (!server || !("instance" in server)) {
    throw new Error("publishedSchemas needs an in-process MCP server");
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverEnd);
  const client = new Client({ name: "schema-read", version: "1" }, { capabilities: {} });
  await client.connect(clientEnd);
  const out = new Map<string, JsonValue>();
  for (const listed of (await client.listTools()).tools) {
    // SAFETY: `inputSchema` crossed the MCP wire as JSON, so it is JSON.
    out.set(listed.name, listed.inputSchema as JsonValue);
  }
  return out;
}

/**
 * Ruling 297: the instructions a server publishes, read the way a model
 * receives them — through `initialize`, not off the object we passed in.
 */
export async function publishedInstructions(
  server: McpSdkServerConfigWithInstance | SpecialistMcpServerConfig | undefined,
): Promise<string> {
  if (!server || !("instance" in server)) {
    throw new Error("publishedInstructions needs an in-process MCP server");
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverEnd);
  const client = new Client({ name: "instructions-read", version: "1" }, { capabilities: {} });
  await client.connect(clientEnd);
  return client.getInstructions() ?? "";
}
