import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { strictTool } from "./strict-tool.server";

/**
 * Ruling 296. These drive a REAL MCP client against a REAL server, because
 * the thing under test is what the SDK's validation layer does with the
 * schema, not what our cast claims. A test that called the handler directly
 * (the way the toolkit tests do) would pass no matter what, since the
 * stripping that caused this happens above the handler.
 */
async function connect(
  tools: Parameters<typeof createSdkMcpServer>[0]["tools"],
): Promise<Client> {
  const server = createSdkMcpServer({ name: "strict-probe", tools });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverEnd);
  const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
  await client.connect(clientEnd);
  return client;
}

/** The text an MCP call answered with, at the client's own result type. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const parsed = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(result);
  return parsed.content.map((c) => c.text).join("\n");
}

describe("strictTool (ruling 296)", () => {
  it("refuses an argument it does not declare, by name, before the handler exists", async () => {
    // Every call the handler actually saw. A counter the test can read beats a
    // sentinel it has to type as unknown.
    const reached: { taskKey?: string }[] = [];
    const client = await connect([
      strictTool("list_runs", "probe", { taskKey: z.string().optional() }, async (args) => {
        reached.push(args);
        return { content: [{ type: "text" as const, text: "answered" }] };
      }),
    ]);

    // The controller's live case: it asked for failed runs, `status` is not a
    // thing this tool has, and before ruling 296 it got the live listing back
    // as though that were the answer. CANARY: hand the raw shape to the SDK's
    // own `tool()` and this returns "answered".
    const wrong = await client.callTool({
      name: "list_runs",
      arguments: { taskKey: "VIB-1", status: "failed" },
    });
    expect(textOf(wrong)).toContain("status");
    expect(textOf(wrong)).not.toContain("answered");
    expect(reached, "the handler ran on a request it had not understood").toEqual([]);

    // And the same call without the invented key still works, so this is a
    // refusal and not a wall.
    const right = await client.callTool({
      name: "list_runs",
      arguments: { taskKey: "VIB-1" },
    });
    expect(textOf(right)).toBe("answered");
    expect(reached).toEqual([{ taskKey: "VIB-1" }]);
  });

  it("publishes additionalProperties:false so the model is TOLD, at every level", async () => {
    const client = await connect([
      strictTool(
        "create_goal",
        "probe",
        {
          title: z.string(),
          links: z.array(z.strictObject({ title: z.string(), goal: z.string() })),
        },
        async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      ),
    ]);
    const listed = await client.listTools();
    const schema = JSON.stringify(listed.tools[0]!.inputSchema);
    // Twice: the tool's own object and the nested link object. A refusal the
    // caller could not have predicted is a worse tool, not a safer one.
    expect(schema.match(/"additionalProperties":false/g)).toHaveLength(2);
  });

});

/**
 * Ruling 296's second half, and the half that is easy to lose: the rule holds
 * for EVERY tool surface, not for whichever one was edited the day it was
 * written. Viberr has four MCP servers today (agent, operator, controller,
 * controller-ops) and adding a fifth is a normal afternoon's work. A toolkit
 * that reaches past this wrapper for the SDK's own `tool()` would go back to
 * silently dropping arguments, with nothing failing to say so.
 */
describe("ruling 296: every tool surface is strict", () => {
  const appDir = fileURLToPath(new URL("../../", import.meta.url));

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) sources(abs, out);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(abs);
    }
    return out;
  }

  /** The VALUE names a file imports from the SDK. `type` imports are not it:
   *  a type cannot build a schema, and a comment that merely NAMES a builder
   *  is not a call (adapter.server.ts describes `createSdkMcpServer(...)` in
   *  prose and defines no tool). */
  function sdkValueImports(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const blocks = text.match(
      /import\s*\{[^}]*\}\s*from\s*"@anthropic-ai\/claude-agent-sdk"/gs,
    );
    return (blocks ?? []).flatMap((block) =>
      block
        .slice(block.indexOf("{") + 1, block.lastIndexOf("}"))
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "" && !name.startsWith("type ")),
    );
  }

  it("no source imports the SDK's own tool() except the wrapper itself", () => {
    const offenders: string[] = [];
    for (const file of sources(appDir)) {
      if (file.endsWith(path.join("runtimes", "strict-tool.server.ts"))) continue;
      if (sdkValueImports(file).includes("tool")) offenders.push(path.relative(appDir, file));
    }
    // CANARY: import { tool } from the SDK in any toolkit.
    expect(
      offenders,
      `these build MCP tools without ruling 296's strict schema: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every toolkit that builds a server routes through strictTool", () => {
    const builders = sources(appDir).filter((f) =>
      sdkValueImports(f).includes("createSdkMcpServer"),
    );
    // If this ever drops to zero the sweep above is vacuous and would pass on
    // an empty set forever.
    expect(builders.length).toBeGreaterThanOrEqual(4);
    for (const file of builders) {
      expect(
        readFileSync(file, "utf8"),
        `${path.relative(appDir, file)} builds an MCP server without strictTool`,
      ).toContain("strict-tool.server");
    }
  });
});
