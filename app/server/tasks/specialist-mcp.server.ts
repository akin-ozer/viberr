import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import {
  discoverStdioMcpTools,
  getMcpCredentialState,
  listMcpServers,
  markMcpServerUnreachableFromRun,
  splitMcpCommand,
  type McpSpawn,
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
 * A9: a server whose credential is CONFIGURED but unopenable (a retired
 * encryption key, a legacy plaintext ref) is NOT mounted. It used to fall
 * through to an anonymous connection — every authenticated server silently
 * downgrading on a key mismatch — while the persona still announced its tools.
 * It now joins the structured `unresolved` list with the reason, so the run
 * reads it in its own prompt instead of discovering it as a wall of 401s.
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
): Record<string, SpecialistMcpServerConfig> {
  return resolveSpecialistMcpServersDetailed(db, mcpNames).servers;
}

/** A stdio mount: the registered command, its parsed argv, and — Claude only,
 *  see BACKEND SCOPE above — the decrypted org credential. */
export interface StdioMcpServerConfig {
  command: string;
  args: string[];
  env?: { MCP_CREDENTIAL: string };
}

/** An HTTP mount, with the decrypted org credential as a bearer header. */
export interface HttpMcpServerConfig {
  type: "http";
  url: string;
  headers?: { Authorization: string };
}

/** The portable per-server config both adapters accept; the Codex adapter
 *  translates it to `mcp_servers` and drops the credential. */
export type SpecialistMcpServerConfig =
  | StdioMcpServerConfig
  | HttpMcpServerConfig;

/** Viberr's own servers. They are built by the toolkit/browser builders, are
 *  refused as registry names at save (P13-KM-12), and must never be resolved
 *  from the registry even if a hand-edited row carries one — on Claude a row
 *  would shadow the real toolkit, on Codex it would not, so the two backends
 *  would disagree about what the agent can do (P14-KM-15). `viberr_browser`
 *  joins for R19-19: the browser is capability-mounted, never an org row. */
const RESERVED_MCP_NAMES = new Set([
  "viberr",
  "viberr_agent",
  "viberr-agent",
  "viberr_browser",
  "viberr-browser",
]);

/** A declared MCP grant that reached no run, or that is known to be down. */
export interface UnresolvedMcpGrant {
  name: string;
  /** Why it produced no usable tools, in words a human can act on. */
  reason: string;
  /**
   * True when the server WAS mounted anyway (P14-LV-09b): the registry knows it,
   * but its last health probe failed. Mounting is still right — a probe can be
   * stale and the CLI may connect where we could not — but the run must not be
   * told it has tools that may never appear.
   */
  mounted?: boolean;
}

export interface SpecialistMcpResolution {
  /** Portable `mcpServers` configs, keyed by server name. */
  servers: Record<string, SpecialistMcpServerConfig>;
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
  const servers: Record<string, SpecialistMcpServerConfig> = {};
  const unresolved: UnresolvedMcpGrant[] = [];
  if (mcpNames.length === 0) return { servers, unresolved };
  let registry: {
    name: string;
    transport: "HTTP" | "stdio";
    target: string;
    up: boolean | null;
    lastCheckedAt: string | null;
  }[];
  try {
    registry = listMcpServers(db);
  } catch (error) {
    // C6 (pass 23): the org MCP registry read failing used to drop EVERY declared
    // grant in silence — no `unresolved` entry, no log — exactly the P13-KM-11
    // silence this module's own drop() path exists to prevent. A registry that
    // cannot be read means none of these tool surfaces mounted, so say so for each
    // one the run's persona promised, and log it once.
    logger.warn("MCP registry unreadable — all declared MCP grants dropped", {
      mcps: mcpNames.filter((n) => !RESERVED_MCP_NAMES.has(n)),
      err: error instanceof Error ? error : new Error(String(error)),
    });
    for (const name of mcpNames) {
      if (RESERVED_MCP_NAMES.has(name)) continue;
      unresolved.push({
        name,
        reason: "the org MCP registry could not be read — it exposes no tools",
      });
    }
    return { servers, unresolved };
  }
  const byName = new Map(registry.map((m) => [m.name, m]));

  /** Mounted, but its last probe said it was unreachable (P14-LV-09b). */
  const flagDown = (name: string, lastCheckedAt: string | null) => {
    unresolved.push({
      name,
      reason: lastCheckedAt
        ? `its last connection check failed (${lastCheckedAt}) — it may expose no tools`
        : "its last connection check failed — it may expose no tools",
      mounted: true,
    });
  };

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
    // A9: a configured credential that cannot be OPENED must never become a
    // silent anonymous connection. The server used to be mounted no-auth, the
    // persona still advertised its tools, and the only trace was a log warn —
    // so an agent hit 401s on every call and reported them as its own failure.
    // Refuse the mount and tell the RUN why, in the same structured shape a
    // missing server uses.
    const credential = getMcpCredentialState(db, name);
    if (credential.state === "unreadable") {
      drop(name, credential.reason);
      continue;
    }
    const token = credential.state === "ok" ? credential.token : null;
    if (row.transport === "stdio") {
      const parts = splitMcpCommand(row.target);
      const command = parts[0];
      if (!command) {
        drop(name, "the registered stdio command is empty");
        continue;
      }
      const stdio: StdioMcpServerConfig = { command, args: parts.slice(1) };
      if (token) stdio.env = { MCP_CREDENTIAL: token };
      servers[name] = stdio;
    } else {
      const http: HttpMcpServerConfig = { type: "http", url: row.target };
      if (token) http.headers = { Authorization: `Bearer ${token}` };
      servers[name] = http;
    }
    // P14-LV-09b: a REGISTERED but known-down server resolves to a config, so it
    // was mounted and announced as usable while exposing nothing. Live, a scout
    // granted `broken-mcp` reported it "named in the initial context as an
    // attached MCP server" with "no callable tools ever surfaced for it".
    if (row.up === false) flagDown(name, row.lastCheckedAt ?? null);
  }
  return { servers, unresolved };
}

/**
 * F20-10: verify the STDIO mounts actually START before a run trusts them.
 *
 * `resolveSpecialistMcpServersDetailed` mounts a stdio server whenever its row
 * exists, trusting the row's health — but MCP health was only ever learned from
 * an explicit Add/Retest, so a row reading "up · 16 tools" from a probe hours
 * old was mounted and announced as usable even when the command now dies at
 * spawn (live: a half-installed `npx` tree crashing in <1s with `Cannot find
 * module 'ajv'`, contributing zero tools while every surface said healthy).
 *
 * This re-runs the real discovery handshake for each mounted stdio server. On a
 * failure it (1) DROPS the server from the config so the run is not told it has
 * tools it will never get, (2) joins the existing `unresolved` disclosure by
 * name with `mounted: false` (a hard mount failure, distinct from the stale
 * `mounted: true` "probe was old" note), and (3) writes the row-health back
 * through {@link markMcpServerUnreachableFromRun} so Settings stops claiming the
 * dead server is up. HTTP mounts are not spawned here and are left untouched.
 *
 * Best-effort and idempotent: a registry read failure returns the resolution
 * unchanged, and a healthy server is left exactly as it was mounted.
 *
 * Wired into the specialist run path (`specialist-run.server.ts`, both the
 * fresh mount and the resume mount). The operator caller
 * (`operator-run.server.ts`) resolves org MCP the same way and should call this
 * after resolving too — see the TODO left at its mount site.
 */
export async function verifyStdioMcpMountsForRun(
  db: DatabaseSync,
  resolution: SpecialistMcpResolution,
  options: { spawnImpl?: McpSpawn; timeoutMs?: number } = {},
): Promise<SpecialistMcpResolution> {
  const names = Object.keys(resolution.servers);
  if (names.length === 0) return resolution;
  let registry: { name: string; transport: "HTTP" | "stdio"; target: string }[];
  try {
    registry = listMcpServers(db);
  } catch {
    return resolution;
  }
  const byName = new Map(registry.map((m) => [m.name, m]));
  const servers = { ...resolution.servers };
  const unresolved = [...resolution.unresolved];

  for (const name of names) {
    const row = byName.get(name);
    if (!row || row.transport !== "stdio") continue; // HTTP is not spawned here
    const credential = getMcpCredentialState(db, name);
    const token = credential.state === "ok" ? credential.token : null;
    const disc = await discoverStdioMcpTools(row.target, {
      spawnImpl: options.spawnImpl,
      timeoutMs: options.timeoutMs,
      token,
    });
    if (disc.kind === "up") continue; // it starts — leave the mount as it was

    // The mount failed at run-spawn: drop it, disclose it, and correct the row.
    delete servers[name];
    markMcpServerUnreachableFromRun(db, name, disc.reason);
    const entry = {
      name,
      reason: `it failed to start for this run — ${disc.reason}`,
      mounted: false,
    };
    const idx = unresolved.findIndex((u) => u.name === name);
    if (idx >= 0) unresolved[idx] = entry;
    else unresolved.push(entry);
    logger.warn("org MCP server failed to start at run-mount — dropped and flagged", {
      mcp: name,
      reason: disc.reason,
    });
  }
  return { servers, unresolved };
}
