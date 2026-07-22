import type { DatabaseSync } from "node:sqlite";
import { getMcpCredential, listMcpServers } from "~/server/org/resources.server";

/**
 * Resolve a specialist profile's declared MCP names to portable runtime
 * `mcpServers` configs from the org MCP registry (item-1 / FR9). The MCP leg was
 * decorative — a profile's `resources.mcps` reached no run. This turns each
 * declared name into a real server config. The Claude adapter accepts this
 * shape directly; the Codex adapter translates it to `mcp_servers` config:
 *   - HTTP  → `{ type: "http", url: <target>, headers?: { Authorization } }`
 *   - stdio → `{ command, args, env?: { MCP_CREDENTIAL } }`
 *
 * `viberr` is skipped (it is the OPERATOR's in-process governance server, built
 * separately and never offered to specialists). Unknown names are skipped.
 * Returns `{}` when nothing resolves, so callers can spread it unconditionally.
 *
 * CREDENTIALS (F7-MCP1, ruling 8): a server's credential is stored SEALED in the
 * org registry (secret-box). When present it is decrypted only here, at
 * run-spawn time, and attached — as an `Authorization: Bearer <token>` header
 * for HTTP, or the `MCP_CREDENTIAL` env var for stdio. The plaintext never
 * touches task files, timelines, logs, or any client surface. Servers with no
 * credential connect unauthenticated (e.g. a local stdio tool).
 *
 * BACKEND SCOPE: the credential is honored on CLAUDE runs (the Agent SDK accepts
 * `headers`/`env` on an mcpServer directly). On CODEX it is intentionally
 * dropped — the codex SDK serializes MCP config into `--config` argv, so a
 * literal secret there would be `ps`-visible (the standing codex-argv exposure
 * the owner scoped out of security work). See `codexMcpServers` in
 * codex-runtime.server.ts. A credentialed org MCP therefore authenticates on
 * Claude-backed specialists only; on Codex it connects unauthenticated.
 */
export function resolveSpecialistMcpServers(
  db: DatabaseSync,
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
    const token = getMcpCredential(db, name);
    if (row.transport === "stdio") {
      const parts = row.target.trim().split(/\s+/);
      const command = parts[0];
      if (!command) continue;
      servers[name] = {
        command,
        args: parts.slice(1),
        ...(token ? { env: { MCP_CREDENTIAL: token } } : {}),
      };
    } else {
      servers[name] = {
        type: "http",
        url: row.target,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      };
    }
  }
  return servers;
}
