import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import {
  getMcpCredential,
  listMcpServers,
  splitMcpCommand,
} from "~/server/org/resources.server";

/**
 * Resolve a specialist profile's declared MCP names to portable runtime
 * `mcpServers` configs from the org MCP registry (item-1 / FR9). The MCP leg was
 * decorative — a profile's `resources.mcps` reached no run. This turns each
 * declared name into a real server config. The Claude adapter accepts this
 * shape directly; the Codex adapter translates it to `mcp_servers` config:
 *   - HTTP  → `{ type: "http", url: <target>, headers?: { Authorization } }`
 *   - stdio → `{ command, args, env?: { MCP_CREDENTIAL } }`
 *
 * `viberr` and `viberr_agent` are skipped (Viberr's own in-process governance
 * and collaboration servers, built separately and never resolved from the org
 * registry). Unknown names are skipped. Returns `{}` when nothing resolves, so
 * callers can spread it unconditionally — use
 * {@link resolveSpecialistMcpServersDetailed} when the caller can record what
 * failed to resolve.
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
  return resolveSpecialistMcpServersDetailed(db, mcpNames).servers;
}

/** Viberr's own in-process servers. They are built by the toolkit builders, are
 *  refused as registry names at save (P13-KM-12), and must never be resolved
 *  from the registry even if a hand-edited row carries one — on Claude a row
 *  would shadow the real toolkit, on Codex it would not, so the two backends
 *  would disagree about what the agent can do (P14-KM-15). */
const RESERVED_MCP_NAMES = new Set(["viberr", "viberr_agent", "viberr-agent"]);

/** A declared MCP grant that reached no run. */
export interface UnresolvedMcpGrant {
  name: string;
  /** Why it produced no server, in words a human can act on. */
  reason: string;
}

export interface SpecialistMcpResolution {
  /** Portable `mcpServers` configs, keyed by server name. */
  servers: Record<string, unknown>;
  /**
   * Grants that produced NOTHING (P14-LV-09). A warn in the server log was the
   * only trace, so an orphaned grant — the standing consequence of an MCP
   * rename before P14-KM-01 — was advertised in the run's persona while
   * exposing zero tools, and no human surface said so. Callers record these
   * against the run.
   */
  unresolved: UnresolvedMcpGrant[];
}

export function resolveSpecialistMcpServersDetailed(
  db: DatabaseSync,
  mcpNames: readonly string[],
): SpecialistMcpResolution {
  const servers: Record<string, unknown> = {};
  const unresolved: UnresolvedMcpGrant[] = [];
  if (mcpNames.length === 0) return { servers, unresolved };
  let registry: { name: string; transport: "HTTP" | "stdio"; target: string }[];
  try {
    registry = listMcpServers(db);
  } catch {
    return { servers, unresolved };
  }
  const byName = new Map(registry.map((m) => [m.name, m]));

  const drop = (name: string, reason: string) => {
    // P13-KM-11: a declared MCP that resolves to nothing used to be dropped in
    // silence, so a run went out without a tool surface its profile promised and
    // nothing anywhere said so. Same honesty rule as skills/KBs.
    logger.warn("declared MCP server did not resolve — run proceeds WITHOUT it", {
      mcp: name,
      reason,
    });
    unresolved.push({ name, reason });
  };

  for (const name of mcpNames) {
    if (RESERVED_MCP_NAMES.has(name)) continue; // built in-process, not a grant
    const row = byName.get(name);
    if (!row || !row.target) {
      drop(name, "no MCP server by that name in the org registry");
      continue;
    }
    const token = getMcpCredential(db, name);
    if (row.transport === "stdio") {
      const parts = splitMcpCommand(row.target);
      const command = parts[0];
      if (!command) {
        drop(name, "the registered stdio command is empty");
        continue;
      }
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
  return { servers, unresolved };
}
