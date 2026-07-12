import type Database from "better-sqlite3";
import { parseCommandLine } from "~/server/mcp/command-line.server";
import {
  listMcpServers,
  resolveMcpAuth,
  type McpView,
} from "~/server/org/resources.server";
import { AppError } from "~/server/errors/app-error.server";

export type McpBackend = "claude" | "codex";

/** Provider compatibility used by the settings UI and routing context. */
export function mcpBackendSupport(mcp: Pick<McpView, "transport" | "auth">): {
  claude: true;
  codex: boolean;
  reason: string | null;
} {
  const codex = mcp.transport === "stdio" || Object.keys(mcp.auth).length === 0;
  return {
    claude: true,
    codex,
    reason: codex
      ? null
      : "Codex cannot express arbitrary Streamable HTTP header mappings; route this profile to Claude.",
  };
}

/**
 * Resolves only the MCPs explicitly declared by the specialist profile. Secret
 * refs are opened here—immediately before a run spec is spawned—and never
 * returned from a loader or persisted into run state/logs.
 *
 * Claude receives HTTP headers and stdio env maps directly. Codex supports
 * stdio env, but its CLI exposes only a bearer-token setting for HTTP rather
 * than Viberr's explicit arbitrary-header map. A Codex route therefore fails
 * clearly instead of silently attempting an unauthenticated connection.
 */
export function resolveSpecialistMcpServers(
  db: Database.Database,
  mcpNames: readonly string[],
  backend?: McpBackend,
): Record<string, unknown> {
  if (mcpNames.length === 0) return {};
  const registry = listMcpServers(db);
  const byName = new Map(registry.map((m) => [m.name, m]));

  const servers: Record<string, unknown> = {};
  for (const name of mcpNames) {
    if (name === "viberr") continue;
    const row = byName.get(name);
    if (!row || !row.target) continue;
    const support = mcpBackendSupport(row);
    if (backend === "codex" && !support.codex) {
      throw AppError.validation(`${row.name}: ${support.reason}`);
    }
    const auth = resolveMcpAuth(db, row.auth);
    if (row.transport === "stdio") {
      const parts = parseCommandLine(row.target);
      const command = parts?.[0];
      if (!command) {
        throw AppError.validation(`${row.name} has an invalid stdio command.`);
      }
      servers[name] = {
        command,
        args: parts.slice(1),
        ...(Object.keys(auth).length ? { env: auth } : {}),
      };
    } else {
      servers[name] = {
        type: "http",
        url: row.target,
        ...(Object.keys(auth).length ? { headers: auth } : {}),
      };
    }
  }
  return servers;
}
