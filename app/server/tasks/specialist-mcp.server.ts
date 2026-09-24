import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import { mcpGatewayMountUrl } from "~/server/mcp-proxy/gateway.server";
import { RESERVED_MCP_NAMES } from "~/shared/mcp-reserved";
import type { McpToolDenial } from "~/shared/mcp-tools";
import {
  discoverStdioMcpTools,
  getMcpCredentialState,
  listMcpServers,
  markMcpServerUnreachableFromRun,
  splitMcpCommand,
  type McpSpawn,
} from "~/server/org/resources.server";
import { toError } from "~/shared/errors";

/**
 * Resolve a specialist profile's declared MCP names to portable runtime
 * `mcpServers` configs from the org MCP registry (item-1 / FR9). The MCP leg was
 * decorative — a profile's `resources.mcps` reached no run. This turns each
 * declared name into a real server config. The Claude adapter accepts this
 * shape directly; the Codex adapter translates it to `mcp_servers` config:
 *   - HTTP  → `{ type: "http", url: <target> }`
 *   - stdio → `{ command, args }`
 *   - a server with a stored credential, either transport →
 *     `{ type: "http", url: <Viberr's gateway>/mcp/<name> }` (ruling 461)
 *
 * `viberr` and `viberr_agent` are skipped (Viberr's own in-process governance
 * and collaboration servers, built separately and never resolved from the org
 * registry). Unknown names are skipped. Returns `{}` when nothing resolves, so
 * callers can spread it unconditionally — use
 * {@link resolveSpecialistMcpServersDetailed} when the caller can record what
 * failed to resolve.
 *
 * CREDENTIALS (F7-MCP1, ruling 461): a server's credential is stored SEALED in
 * the org registry (secret-box) and never leaves the server process. It used
 * to be decrypted here and attached to the run's own config — an
 * `Authorization: Bearer` header, or `MCP_CREDENTIAL` in a stdio server's env —
 * which the Claude SDK serializes onto the CLI's argv, readable with `ps` from
 * the agent's own shell (F40-2); Codex dropped it for that reason and connected
 * anonymously (F40-3). Now a credentialed server is mounted THROUGH Viberr's
 * loopback MCP gateway (`app/server/mcp-proxy/gateway.server.ts`): the config
 * names the gateway's URL, `startRun` adds the run's own token, and the
 * gateway attaches the credential upstream. Same config on both backends. A
 * server with no credential mounts directly, as before.
 *
 * A9: a server whose credential is CONFIGURED but unopenable (a retired
 * encryption key, a legacy plaintext ref) is NOT mounted. It used to fall
 * through to an anonymous connection — every authenticated server silently
 * downgrading on a key mismatch — while the persona still announced its tools.
 * It now joins the structured `unresolved` list with the reason, so the run
 * reads it in its own prompt instead of discovering it as a wall of 401s.
 */
export function resolveSpecialistMcpServers(
  db: DatabaseSync,
  mcpNames: readonly string[],
  options: McpResolveOptions = {},
): Record<string, SpecialistMcpServerConfig> {
  return resolveSpecialistMcpServersDetailed(db, mcpNames, options).servers;
}

/** How a run's grants shape what its org servers expose (ruling 176). */
export interface McpResolveOptions {
  /** The run withholds `execute-code-or-write-repo` (every operator run does):
   *  each server's marked write tools are denied on it. */
  withholdWriteTools?: boolean;
}

/** A stdio mount: the registered command and its parsed argv. A stdio server
 *  with a credential is never mounted this way — the server spawns it behind
 *  the gateway (ruling 461). */
export interface StdioMcpServerConfig {
  command: string;
  args: string[];
}

/** An HTTP mount. `headers` exists only on a gateway mount, set by `startRun`
 *  (`bindRunToMcpGateway`): the RUN's token, never a credential (ruling 461). */
export interface HttpMcpServerConfig {
  type: "http";
  url: string;
  headers?: { Authorization: string };
  /** Ruling 176: the Claude SDK's per-tool policy for a remote server, set to
   *  `always_deny` for each marked write tool on a run that withholds repo
   *  write. The `disallowedTools` name `startRun` adds is what binds on every
   *  transport; this is the SDK's own channel for HTTP, carried as well. */
  tools?: { name: string; permission_policy: "always_deny" }[];
}

/** The portable per-server config both adapters accept; the Codex adapter
 *  translates it to `mcp_servers`. */
export type SpecialistMcpServerConfig =
  | StdioMcpServerConfig
  | HttpMcpServerConfig;

// Viberr's own servers are built by the toolkit/browser/controller builders and
// must never be resolved from the registry even if a row carries one — on
// Claude a row would shadow the real server, on Codex it would not, so the two
// backends would disagree about what the agent can do (P14-KM-15). The list is
// `~/shared/mcp-reserved`, shared with the writer and the picker: the private
// copy that used to live here fell two rulings behind and stopped covering the
// controller's own servers (ruling 107).

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

/**
 * Ruling 310: what a run is told about a grant that did not arrive.
 *
 * Both prompts used to say the same hardcoded sentence — "no such server is in
 * the org registry" — for every unresolved grant, which is an assertion about a
 * CAUSE that neither of them checked. `verifyStdioMcpMountsForRun` had already
 * computed the real one and `UnresolvedMcpGrant.reason` already carried it "in
 * words a human can act on"; six call sites then did `.map((u) => u.name)` and
 * dropped it on the floor.
 *
 * Caught live. On SHOP-55 the Platform Architect reported that a knowledge-base
 * MCP server "is not in the org registry" — faithfully relaying what viberr told
 * it — and the operator checked and corrected the record: the server IS
 * registered and IS granted to that profile, it simply had not mounted on that
 * run. The manufactured cause sent a reader after a registration bug that did
 * not exist, while the real cause went unreported.
 *
 * One renderer, because the two prompts saying different things about the same
 * fact is how the first version drifted into stating a cause at all.
 */
export function unavailableMcpSection(grants: readonly UnresolvedMcpGrant[]): string {
  if (grants.length === 0) return "";
  const [it, they] = grants.length === 1 ? ["it is", "it"] : ["they are", "them"];
  const lines = grants.map((g) => `- ${g.name}: ${g.reason}`).join("\n");
  return (
    "\n\n---\n# Unavailable MCP servers\n\n" +
    `Your profile grants ${grants.map((g) => g.name).join(", ")}, but ${it} NOT ` +
    `mounted on this run. Why, per server, as the server reported it:\n\n` +
    `${lines}\n\n` +
    `Do not claim or attempt tools from ${they}; report the gap, and report ` +
    `THAT reason — do not infer one, and do not assume the grant or the ` +
    `registration is missing unless the reason says so.`
  );
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
  /**
   * Ruling 176: per mounted server, the marked write tools this run withholds.
   * Empty unless the caller withheld write tools AND a mounted server has
   * marks. The caller hands it to `startRun`, which denies each by name on
   * Claude and as `disabled_tools` on Codex.
   */
  toolDenials: McpToolDenial[];
  /**
   * Ruling 461: the mounted servers reached through Viberr's MCP gateway —
   * those with a stored credential. Their prompt sentence says the credential
   * is held by Viberr and a 401 from the gateway means the run ended.
   */
  proxied: string[];
}

/**
 * Ruling 461: what a run is told about the servers it reaches through Viberr's
 * gateway. One renderer for the specialist, operator and controller prompts.
 */
export function gatewayMcpSection(proxied: readonly string[]): string {
  if (proxied.length === 0) return "";
  const names = [...proxied].sort().join(", ");
  return (
    "\n\n---\n# MCP servers reached through Viberr's gateway\n\n" +
    `${names} ${proxied.length === 1 ? "is" : "are"} mounted through Viberr's MCP ` +
    "gateway: the credential is held by Viberr, and you never need it or see it; a 401 " +
    "from the gateway means this run has ended."
  );
}

export function resolveSpecialistMcpServersDetailed(
  db: DatabaseSync,
  mcpNames: readonly string[],
  options: McpResolveOptions = {},
): SpecialistMcpResolution {
  const servers: Record<string, SpecialistMcpServerConfig> = {};
  const unresolved: UnresolvedMcpGrant[] = [];
  const toolDenials: McpToolDenial[] = [];
  const proxied: string[] = [];
  if (mcpNames.length === 0) return { servers, unresolved, toolDenials, proxied };
  let registry: {
    name: string;
    transport: "HTTP" | "stdio";
    target: string;
    up: boolean | null;
    lastCheckedAt: string | null;
    writeTools: string[];
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
      err: toError(error),
    });
    for (const name of mcpNames) {
      if (RESERVED_MCP_NAMES.has(name)) continue;
      unresolved.push({
        name,
        reason: "the org MCP registry could not be read — it exposes no tools",
      });
    }
    return { servers, unresolved, toolDenials, proxied };
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
    // Built in-process, not a grant: the toolkit/browser/controller servers
    // mount by capability, so a grant naming one changes nothing in either
    // direction and is NOT reported as unresolved — reporting a server that IS
    // mounted as unavailable would be false (C02-R5, pass 32: deliberate,
    // pinned in tests).
    //
    // Ruling 310: pass 32 wrote this exclusion because it saw that the
    // persona's one hardcoded sentence — "no such server is in the org
    // registry" — would be a lie here, and it fixed the case rather than the
    // sentence. The sentence was already a lie for two other reasons this same
    // loop produces (an unreadable credential, a server that fails to start),
    // and it stayed one until an agent relayed it to a human as fact. The
    // prompt now carries whatever `drop` was told, so this exclusion stands on
    // its own merits and no longer props up a false sentence.
    if (RESERVED_MCP_NAMES.has(name)) continue;
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
    // Ruling 469: a server that asks for an OAuth sign-in it does not have
    // (or whose sign-in expired) would answer every call 401; the run is told
    // why instead.
    if (credential.state === "unreadable" || credential.state === "signed_out") {
      drop(name, credential.reason);
      continue;
    }
    // Ruling 176: the admin's marks bind only on a run that withholds repo
    // write; a server with none marked is mounted exactly as before.
    const denied = options.withholdWriteTools ? row.writeTools : [];
    const parts = row.transport === "stdio" ? splitMcpCommand(row.target) : [];
    const command = parts[0];
    if (row.transport === "stdio" && !command) {
      drop(name, "the registered stdio command is empty");
      continue;
    }
    if (credential.state === "ok" || credential.state === "oauth") {
      // Ruling 461: the credential stays in this process. The run mounts the
      // gateway's URL for the server (either transport — the gateway spawns a
      // stdio command itself) and `startRun` adds the run's own token. An
      // OAuth sign-in's tokens take the same road (ruling 469).
      const url = mcpGatewayMountUrl(name);
      if (!url) {
        drop(
          name,
          "it has a stored credential and Viberr's MCP gateway, the only way a run reaches such a server, is not running",
        );
        continue;
      }
      const gateway: HttpMcpServerConfig = { type: "http", url };
      if (denied.length) {
        gateway.tools = denied.map((tool) => ({ name: tool, permission_policy: "always_deny" }));
      }
      servers[name] = gateway;
      proxied.push(name);
    } else if (command) {
      servers[name] = { command, args: parts.slice(1) };
    } else {
      const http: HttpMcpServerConfig = { type: "http", url: row.target };
      if (denied.length) {
        http.tools = denied.map((tool) => ({ name: tool, permission_policy: "always_deny" }));
      }
      servers[name] = http;
    }
    if (denied.length) toolDenials.push({ server: name, tools: [...denied] });
    // P14-LV-09b: a REGISTERED but known-down server resolves to a config, so it
    // was mounted and announced as usable while exposing nothing. Live, a scout
    // granted `broken-mcp` reported it "named in the initial context as an
    // attached MCP server" with "no callable tools ever surfaced for it".
    if (row.up === false) flagDown(name, row.lastCheckedAt ?? null);
  }
  return { servers, unresolved, toolDenials, proxied };
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
 * Wired into every run path that mounts org MCP: the specialist runtime
 * (`specialist-run.server.ts`, both the fresh mount and the resume mount), the
 * operator (`operatorMcpResolution` in `operator-run.server.ts`, F21-3) and the
 * controller (`controller-run.server.ts`).
 *
 * Ruling 461: the pre-flight runs WITH the server's credential on every
 * backend. A credentialed stdio server is started by Viberr's gateway with
 * `MCP_CREDENTIAL` for Claude and Codex runs alike, so the Codex-only
 * credential-less pre-flight (B-4) and the re-probe that kept it from
 * corrupting the shared health row (P9) have nothing left to model.
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
    const disc = await discoverStdioMcpTools(row.target, {
      spawnImpl: options.spawnImpl,
      timeoutMs: options.timeoutMs,
      token: credential.state === "ok" ? credential.token : null,
    });
    if (disc.kind === "up") continue; // it starts — leave the mount as it was

    // The mount failed at run-spawn: drop it, disclose it for THIS run, and
    // correct the shared row so Settings stops calling it healthy.
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
  // A dropped server exposes nothing, so it has nothing left to deny.
  const toolDenials = resolution.toolDenials.filter((d) => d.server in servers);
  const proxied = resolution.proxied.filter((name) => name in servers);
  return { servers, unresolved, toolDenials, proxied };
}
