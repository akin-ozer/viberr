import type Database from "better-sqlite3";
import { listMcpServers } from "~/server/org/resources.server";

/**
 * Resolve a specialist profile's declared MCP names to Claude Agent SDK
 * `mcpServers` configs from the org MCP registry (item-1 / FR9). The MCP leg was
 * decorative — a profile's `resources.mcps` reached no run. This turns each
 * declared name into a real server config the SDK can connect to:
 *   - HTTP  → `{ type: "http", url: <target> }`
 *   - stdio → `{ command, args }` (target is the shell command line)
 *
 * `viberr` is skipped (it is the OPERATOR's in-process governance server, built
 * separately and never offered to specialists). Unknown names are skipped.
 * Returns `{}` when nothing resolves, so callers can spread it unconditionally.
 *
 * NOTE (honest scope): credentials are NOT injected here. The registry stores a
 * `secret://…` ref, not the token; wiring the real auth header requires the
 * secret store and a working external server, neither of which is exercised in
 * this environment (the seeded MCP targets are placeholders). This makes the
 * declared MCP a real, connectable server config; supplying live credentials is
 * the remaining step for a production MCP.
 */
export function resolveSpecialistMcpServers(
  db: Database.Database,
  mcpNames: readonly string[],
): Record<string, unknown> {
  if (mcpNames.length === 0) return {};
  let registry: { name: string; transport: "HTTP" | "stdio"; target: string }[];
  try {
    registry = listMcpServers(db);
  } catch {
    return {};
  }
  const byName = new Map(registry.map((m) => [m.name, m]));

  const servers: Record<string, unknown> = {};
  for (const name of mcpNames) {
    if (name === "viberr") continue; // operator's in-process server, not for specialists
    const row = byName.get(name);
    if (!row || !row.target) continue;
    if (row.transport === "stdio") {
      const parts = row.target.trim().split(/\s+/);
      const command = parts[0];
      if (!command) continue;
      servers[name] = { command, args: parts.slice(1) };
    } else {
      servers[name] = { type: "http", url: row.target };
    }
  }
  return servers;
}
