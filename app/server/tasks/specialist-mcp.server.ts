import type { DatabaseSync } from "node:sqlite";
import { BOARD_MCP_NAME, type BoardMount } from "~/server/mcp-proxy/board-tool.server";
import { KNOWLEDGE_MCP_NAME, type KnowledgeMount } from "~/server/mcp-proxy/knowledge-tool.server";
import { logger } from "~/server/logging/logger.server";
import { mcpGatewayMountUrl } from "~/server/mcp-proxy/gateway.server";
import { MCP_GRANT_TOOL_NAME } from "~/server/mcp-proxy/grant-tool.server";
import { mcpGrantPhrase, summarizeMcpGrant, type McpOAuthView } from "~/shared/mcp-oauth";
import { RESERVED_MCP_NAMES } from "~/shared/mcp-reserved";
import type { McpToolDenial } from "~/shared/mcp-tools";
import {
  discoverStdioMcpTools,
  getMcpCredentialState,
  listMcpServers,
  markMcpServerUnreachableFromRun,
  splitMcpCommand,
  type McpSpawn,
  type StdioDiscovery,
} from "~/server/org/resources.server";
import { toError } from "~/shared/errors";
import { sortedBy } from "~/server/runtimes/prompt-prefix.server";
import { startMcpWarmup } from "~/server/org/mcp-warmup.server";

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
  /** Ruling 585: set only on the gateway's knowledge mount. The gateway keeps
   *  it (the knowledge bases it may read for the run) and hands the run the
   *  mount without it. */
  knowledge?: KnowledgeMount;
  /** Ruling 589: set only on the gateway's board mount, kept the same way. */
  board?: BoardMount;
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
    `THAT reason: do not infer one, and do not assume the grant or the ` +
    `registration is missing unless the reason says so.`
  );
}

/**
 * C1: the skill and knowledge-base grants that resolved to nothing, or to less
 * than they name, said in the run's own prompt, for the operator and the
 * specialist alike, in one wording. Ruling 253: "did NOT reach" was true of
 * every row when only a total miss could appear here. A partial now appears
 * too, so the heading and the instruction cover both.
 */
export function missingResourcesSection(
  missing: readonly { name: string; reason: string }[],
): string {
  if (missing.length === 0) return "";
  return (
    "\n\n---\n# Attached resources that did NOT fully reach this run\n\n" +
    "Your profile grants these, and what is in your context is incomplete or absent:\n" +
    missing.map((m) => `- **${m.name}**: ${m.reason}`).join("\n") +
    "\n\nDo not claim knowledge or craft you did not receive, and do not treat " +
    "the gap as your own failure; say plainly in your reply what arrived " +
    "empty or incomplete so a human can fix the configuration."
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
  /**
   * Ruling 486: the proxied servers signed in with OAuth, each with the scope
   * its sign-in was granted (null when the server did not say), so the prompt
   * tells the run what the connection may do before a write is refused.
   */
  oauthGrants: McpRunGrant[];
}

/** Ruling 486: an OAuth-signed-in server a run mounts, and its sign-in's grant. */
export interface McpRunGrant {
  name: string;
  /** The granted scope, space-joined (`McpOAuthView.scope`). */
  scope: string | null;
}

/**
 * Ruling 486: one line per OAuth-signed-in server, naming its grant. A
 * read-only grant says what a write will meet and whose act the remedy is.
 * A known grant points at the gateway's grant tool (F40-66): the line carries
 * only the summary, so an agent that needs one scope asks the tool instead of
 * a person.
 */
function grantLine(grant: McpRunGrant): string {
  const phrase = mcpGrantPhrase(grant.scope);
  if (!phrase) {
    return `- ${grant.name}: signed in with OAuth; the server did not say which scopes it granted.`;
  }
  const lookup = `Call its \`${MCP_GRANT_TOOL_NAME}\` tool to see exactly which scopes are granted`;
  if (summarizeMcpGrant(grant.scope)?.writes.length) {
    return (
      `- ${grant.name}: signed in with OAuth, granted ${phrase}. ${lookup} before you assume ` +
      "a write will be refused or accepted."
    );
  }
  return (
    `- ${grant.name}: signed in with OAuth, granted ${phrase}. The server refuses any call ` +
    "that writes, so do not attempt one; if the task needs a write, report that an org admin " +
    `must sign it in again with write scopes in Instance settings → Agent resources. ${lookup} ` +
    "before you assume a read will be refused or accepted."
  );
}

/**
 * Ruling 461: what a run is told about the servers it reaches through Viberr's
 * gateway. One renderer for the specialist, operator and controller prompts.
 * Ruling 486: an OAuth-signed-in server's grant is named with it.
 */
export function gatewayMcpSection(
  proxied: readonly string[],
  grants: readonly McpRunGrant[] = [],
): string {
  if (proxied.length === 0) return "";
  const names = [...proxied].sort().join(", ");
  // Ruling 506: the grant lines in the names' own code-point order. The
  // specialist and the controller carry this section in their static prefix,
  // and `localeCompare` follows the process locale.
  const signedIn = sortedBy(
    grants.filter((grant) => proxied.includes(grant.name)),
    (grant) => grant.name,
  );
  return (
    "\n\n---\n# MCP servers reached through Viberr's gateway\n\n" +
    `${names} ${proxied.length === 1 ? "is" : "are"} mounted through Viberr's MCP ` +
    "gateway: the credential is held by Viberr, and you never need it or see it; a 401 " +
    "from the gateway means this run has ended." +
    (signedIn.length > 0
      ? "\n\nWhat each OAuth sign-in was granted, which the server enforces:\n\n" +
        signedIn.map(grantLine).join("\n")
      : "")
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
  const oauthGrants: McpRunGrant[] = [];
  if (mcpNames.length === 0) return { servers, unresolved, toolDenials, proxied, oauthGrants };
  let registry: {
    name: string;
    transport: "HTTP" | "stdio";
    target: string;
    up: boolean | null;
    lastCheckedAt: string | null;
    writeTools: string[];
    oauth?: McpOAuthView | null;
  }[];
  try {
    registry = listMcpServers(db);
  } catch (error) {
    // C6 (pass 23): the org MCP registry read failing used to drop EVERY declared
    // grant in silence — no `unresolved` entry, no log — exactly the P13-KM-11
    // silence this module's own drop() path exists to prevent. A registry that
    // cannot be read means none of these tool surfaces mounted, so say so for each
    // one the run's persona promised, and log it once.
    logger.warn("MCP registry unreadable; all declared MCP grants dropped", {
      mcps: mcpNames.filter((n) => !RESERVED_MCP_NAMES.has(n)),
      err: toError(error),
    });
    for (const name of mcpNames) {
      if (RESERVED_MCP_NAMES.has(name)) continue;
      unresolved.push({
        name,
        reason: "the org MCP registry could not be read; it exposes no tools",
      });
    }
    return { servers, unresolved, toolDenials, proxied, oauthGrants };
  }
  const byName = new Map(registry.map((m) => [m.name, m]));

  /** Mounted, but its last probe said it was unreachable (P14-LV-09b). */
  const flagDown = (name: string, lastCheckedAt: string | null) => {
    unresolved.push({
      name,
      reason: lastCheckedAt
        ? `its last connection check failed (${lastCheckedAt}); it may expose no tools`
        : "its last connection check failed; it may expose no tools",
      mounted: true,
    });
  };

  const drop = (name: string, reason: string) => {
    // P13-KM-11: a declared MCP that resolves to nothing used to be dropped in
    // silence, so a run went out without a tool surface its profile promised and
    // nothing anywhere said so. Same honesty rule as skills/KBs.
    logger.warn("declared MCP server did not resolve; run proceeds WITHOUT it", {
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
      // Ruling 486: the run is told what the sign-in may do.
      if (credential.state === "oauth") oauthGrants.push({ name, scope: row.oauth?.scope ?? null });
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
  return { servers, unresolved, toolDenials, proxied, oauthGrants };
}

/**
 * Ruling 585: the knowledge server a Codex specialist that holds a knowledge
 * base mounts, or null.
 *
 * A Claude run's toolkit gives it `read_knowledge_doc` and
 * `correct_knowledge_doc`; a Codex run mounts no in-process tools (ruling
 * 422), so it could not read a private knowledge base (ruling 578) and had to
 * put a correction in its report for the operator to write. The mount is the
 * gateway's own URL for `viberr_knowledge`, carrying the run's knowledge bases
 * and its agent for the gateway; `startRun` binds the run's token onto it and
 * hands the run the mount without them. A Claude run mounts nothing here, and
 * a gateway that is not running mounts nothing: the run then reads open
 * knowledge bases at their folders, reports corrections, and gets a private
 * one as an unresolved grant, as before.
 */
export function resolveKnowledgeMcp(input: {
  backend: string | undefined;
  kb: readonly string[];
  dataRoot?: string | undefined;
  agent: { profileId: string; roleHint: string | null };
}): HttpMcpServerConfig | null {
  if (input.backend !== "codex" || input.kb.length === 0) return null;
  const url = mcpGatewayMountUrl(KNOWLEDGE_MCP_NAME);
  if (!url) return null;
  const knowledge: KnowledgeMount = { kb: [...input.kb], agent: input.agent };
  if (input.dataRoot) knowledge.dataRoot = input.dataRoot;
  return { type: "http", url, knowledge };
}

/**
 * Ruling 589: the board server a Codex specialist that holds a collaboration
 * grant mounts, or null.
 *
 * A Claude run with any collaboration grant has `read_board` and
 * `read_timeline_entry` in its toolkit; a Codex run had neither (ruling 422),
 * so it could not read another task's verdicts or a clipped entry of its own
 * task. The mount is the gateway's own URL for `viberr_board`, carrying the
 * run's store; the gateway already holds the run's project and task. A run
 * with no collaboration grant mounts nothing, as on Claude, and so does a
 * Claude run or a gateway that is not running.
 */
export function resolveBoardMcp(input: {
  backend: string | undefined;
  collaborates: boolean;
  dataRoot?: string | undefined;
}): HttpMcpServerConfig | null {
  if (input.backend !== "codex" || !input.collaborates) return null;
  const url = mcpGatewayMountUrl(BOARD_MCP_NAME);
  if (!url) return null;
  const board: BoardMount = {};
  if (input.dataRoot) board.dataRoot = input.dataRoot;
  return { type: "http", url, board };
}

/**
 * Ruling 695(b): how many stdio pre-flight handshakes a run start keeps in
 * flight. Each may take its full 20 s, so a run mounting four waited 80 s
 * before it began; two halves that. Three would save more only on a run
 * mounting three or more, at the price of a third concurrent first-run
 * `npx`/`uvx` install (each CPU, disk and network heavy) eating into the 20 s
 * every other handshake is given, and a healthy server that times out under
 * that contention is dropped from the run and marked down.
 */
const STDIO_PREFLIGHT_CONCURRENCY = 2;

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
 * This re-runs the real discovery handshake for each mounted stdio server, two
 * at a time (ruling 695(b), below). On a failure it (1) DROPS the server from
 * the config so the run is not told it has tools it will never get, (2) joins
 * the existing `unresolved` disclosure by name with `mounted: false` (a hard
 * mount failure, distinct from the stale `mounted: true` "probe was old" note),
 * and (3) writes the row-health back through
 * {@link markMcpServerUnreachableFromRun} so Settings stops claiming the dead
 * server is up. HTTP mounts are not spawned here and are left untouched.
 *
 * Best-effort and idempotent: a registry read failure returns the resolution
 * unchanged, and a healthy server is left exactly as it was mounted.
 *
 * Wired into every run path that mounts org MCP: the specialist runtime (the
 * fresh mount, `mcpServersFor` in `specialist-roster.server.ts`, and the resume
 * mount in `specialist-run.server.ts`), the operator (`operatorMcpResolution` in
 * `operator-prompt.server.ts`, F21-3) and the controller
 * (`controller-run.server.ts`).
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
  options: { spawnImpl?: McpSpawn; timeoutMs?: number; capMs?: number } = {},
): Promise<SpecialistMcpResolution> {
  const names = Object.keys(resolution.servers);
  if (names.length === 0) return resolution;
  let registry: { id: string; name: string; transport: "HTTP" | "stdio"; target: string }[];
  try {
    registry = listMcpServers(db);
  } catch {
    return resolution;
  }
  const byName = new Map(registry.map((m) => [m.name, m]));
  const servers = { ...resolution.servers };
  const unresolved = [...resolution.unresolved];

  // Ruling 695(b): the handshakes run STDIO_PREFLIGHT_CONCURRENCY at a time,
  // taken in mount order, and each verdict is applied in mount order as soon
  // as every earlier mount's verdict is in. The mounted set, the health rows,
  // the warn lines and `unresolved` therefore come out as the one-at-a-time
  // check left them for the same verdicts.
  //
  // One window remains where a row can end up other than the serial check
  // left it. A later mount's probe can end while an earlier mount is still
  // probing; its failure is written only once the earlier verdict is in, so
  // a Retest pressed in between is overwritten by the older failure, where
  // the serial check would only then have started that probe and seen what
  // the Retest saw. Taking the mounts in mount order and applying each verdict
  // as soon as the earlier ones are in keeps that window to the time the
  // mounts before it still take; holding every verdict for the whole batch,
  // or taking the mounts in another order, would widen it.
  //
  // Every credential is read here, in mount order, before any probe starts.
  // The resolver that built `resolution` has just read each one (and re-sealed
  // one opened under a retired key), so this read writes nothing; the one line
  // it can still log, a re-seal that failed there too, now comes before the
  // verdicts' lines instead of between them.
  const probes = names.flatMap((name) => {
    const row = byName.get(name);
    if (!row || row.transport !== "stdio") return []; // HTTP is not spawned here
    const credential = getMcpCredentialState(db, name);
    return [{ name, row, token: credential.state === "ok" ? credential.token : null }];
  });

  const applyVerdict = ({ name, row, token }: (typeof probes)[number], disc: StdioDiscovery) => {
    if (disc.kind === "up") return; // it starts — leave the mount as it was

    // The mount failed at run-spawn: drop it, disclose it for THIS run, and
    // correct the shared row so Settings stops calling it healthy.
    delete servers[name];
    markMcpServerUnreachableFromRun(db, name, disc.reason);
    // Ruling 606: the probe gave up on a visible install and killed it, and uv
    // commits to its cache only when an install completes, so every run
    // restarted the same download and lost the server (R19-18's loop, on the
    // run path; live 2026-09-30, `uvx awslabs.aws-pricing-mcp-server@latest`).
    // The install finishes in the background, as a Retest's does.
    const installing = disc.installing === true;
    if (installing) {
      startMcpWarmup(
        db,
        { id: row.id, name, target: row.target, token },
        { spawnImpl: options.spawnImpl, capMs: options.capMs },
      );
    }
    const entry = {
      name,
      reason: installing
        ? `it failed to start for this run: ${disc.reason}. It is installing in the background for a later run`
        : `it failed to start for this run: ${disc.reason}`,
      mounted: false,
    };
    const idx = unresolved.findIndex((u) => u.name === name);
    if (idx >= 0) unresolved[idx] = entry;
    else unresolved.push(entry);
    logger.warn("org MCP server failed to start at run-mount; dropped and flagged", {
      mcp: name,
      reason: disc.reason,
    });
  };

  // Verdicts by mount index; the first `applied` of them have been applied.
  const verdicts: (StdioDiscovery | undefined)[] = [];
  let applied = 0;
  // A verdict that cannot be applied (its health-row write threw) fails the
  // run start, and the check stops there as the serial loop did: nothing more
  // is applied, logged or spawned, not even a mount that was waiting for its
  // command's earlier probe. A probe already in flight in the other worker
  // still ends on its own clock and kills its child; its verdict is dropped.
  let failed = false;
  // Two mounts of ONE command (a server registered twice, say under two
  // credentials) never handshake at once: the second waits for the first, as
  // it did serially, and finds the first one's finished install instead of
  // racing it into the same npx/uvx cache.
  const lastProbeOf = new Map<string, Promise<unknown>>();
  let next = 0;
  const worker = async (): Promise<void> => {
    try {
      for (;;) {
        const index = next++;
        const probe = probes[index];
        if (probe === undefined) return;
        const { row, token } = probe;
        const discovery = (lastProbeOf.get(row.target) ?? Promise.resolve()).then(() =>
          failed
            ? undefined
            : discoverStdioMcpTools(row.target, {
                spawnImpl: options.spawnImpl,
                timeoutMs: options.timeoutMs,
                token,
              }),
        );
        lastProbeOf.set(row.target, discovery);
        verdicts[index] = await discovery;
        if (failed) return;
        for (let ready = verdicts[applied]; ready; ready = verdicts[applied]) {
          applyVerdict(probes[applied], ready);
          applied += 1;
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STDIO_PREFLIGHT_CONCURRENCY, probes.length) }, worker),
  );
  // A dropped server exposes nothing, so it has nothing left to deny.
  const toolDenials = resolution.toolDenials.filter((d) => d.server in servers);
  const proxied = resolution.proxied.filter((name) => name in servers);
  const oauthGrants = resolution.oauthGrants.filter((grant) => grant.name in servers);
  return { servers, unresolved, toolDenials, proxied, oauthGrants };
}
