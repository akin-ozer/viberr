import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { StoreNode } from "~/features/kb-browser/tree";
import { countKbFiles } from "~/features/kb-browser/tree";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  kbDirPath,
  kbRootDir,
  skillDirPath,
  skillsRootDir,
} from "~/server/files/file-store-root.server";
import { newId } from "~/shared/ids/new-id.server";
import { slugify } from "~/shared/ids/slugify";
import { parseCommandLine } from "~/server/mcp/command-line.server";
import {
  isOrgSecretRef,
  resolveOrgSecretRef,
} from "~/server/secrets/org-secret-store.server";
import { scanStoreTree, type StoreTarget } from "./store-files.server";
import {
  findAgentResourceUsages,
  listAgentResourceUsages,
  resourceUsageLabels,
  type AgentResourceKind,
} from "./resource-dependencies.server";

/**
 * Org agent resources: knowledge bases, MCP servers, skills (org-settings
 * spec §3.4–3.6, §4.3–4.4). KB and skill CONTENT is file-native — real
 * folders under ${DATA_ROOT}/kb/<dir>/ and /skills/<name>/, scanned from
 * disk on every read (files added outside Viberr appear on the next load,
 * exactly as the def-note promises). SQLite carries only metadata
 * (cadence, summary, freshness timestamps). A rename recomputes the slug
 * and MOVES the folder (spec §7.3); collisions are refused.
 *
 * DISK IS TRUTH (finding #7): the listings scan the real kb/ and skills/
 * folders and layer the metadata row on top when one exists — so folders
 * created outside org settings (e.g. the shipped *-expertise skills) show up
 * exactly like managed ones. A folder with no row renders with default
 * metadata under a synthetic `disk:<name>` id; editing/re-indexing it adopts
 * it into a real row, and delete removes both the folder and any row.
 *
 * MCP health is HONEST: both HTTP and stdio targets must complete a real
 * JSON-RPC initialize + tools/list handshake. Auth references are resolved
 * only for that execution boundary and plaintext never enters a row, loader,
 * audit record, toast, or error.
 */

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
}

/** D9: never strand a profile/deployment by mutating a referenced resource. */
function assertResourceUnused(
  db: Database.Database,
  kind: AgentResourceKind,
  aliases: readonly string[],
  resourceLabel: string,
  operation: "rename" | "delete",
  ctx: OrgSeedContext = {},
): void {
  const usedBy = findAgentResourceUsages(
    listAgentResourceUsages(db, ctx),
    kind,
    aliases,
  );
  if (usedBy.length === 0) return;
  const labels = resourceUsageLabels(usedBy);
  throw conflict(
    `Can't ${operation} ${resourceLabel} while it is used by: ${labels.join(", ")}. Detach or edit those profiles first.`,
  );
}

export interface OrgSeedContext {
  dataRoot?: string;
}

/**
 * Synthetic id for a resource that exists on disk but has no metadata row
 * yet — encodes the folder name so the getters/mutations can resolve it
 * without a DB row. Real ids are `kb_…`/`sk_…` (newId), so no collision.
 */
const DISK_ID_PREFIX = "disk:";

function diskId(name: string): string {
  return `${DISK_ID_PREFIX}${name}`;
}

function diskNameFromId(id: string): string | null {
  if (!id.startsWith(DISK_ID_PREFIX)) return null;
  const name = id.slice(DISK_ID_PREFIX.length);
  // A disk id resolves straight into a store path (delete / rename / reindex),
  // so the encoded name MUST be a single plain directory segment — never a
  // traversal. Reject anything with a separator, a dot-segment, or emptiness
  // rather than let a crafted `disk:../../etc` id escape the store root.
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    return null;
  }
  return name;
}

/** Immediate sub-directory names of a store root ([] when absent). */
function subDirNames(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((entry) => {
      try {
        return statSync(path.join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Union of metadata-row keys (in row order) with the on-disk folder names
 * (the extras appended alphabetically). Disk is truth, but a seeded row whose
 * folder was removed externally still shows so its metadata isn't silently
 * lost.
 */
function unionDiskAndRows(rowKeys: string[], diskNames: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const key of rowKeys) {
    if (!seen.has(key)) {
      order.push(key);
      seen.add(key);
    }
  }
  for (const name of [...diskNames].sort()) {
    if (!seen.has(name)) {
      order.push(name);
      seen.add(name);
    }
  }
  return order;
}

// ------------------------------------------------------- knowledge bases

export const KB_REFRESH_MODES = ["manual", "on change", "nightly"] as const;
export type KbRefreshMode = (typeof KB_REFRESH_MODES)[number];

export interface KbView {
  id: string;
  name: string;
  dir: string;
  refresh: KbRefreshMode;
  lastIndexedAt: string | null;
  tree: StoreNode[];
  fileCount: number;
  /** "store://kb/<dir>" (no trailing slash — mock root prop contract). */
  uri: string;
}

interface KbRow {
  id: string;
  name: string;
  dir: string;
  refresh: string;
  last_indexed_at: string | null;
}

/** Builds a KB view from a disk folder, layering a metadata row when given. */
function buildKb(
  dir: string,
  row: KbRow | null,
  ctx: OrgSeedContext,
): KbView {
  const tree = scanStoreTree(kbDirPath(dir, ctx.dataRoot));
  return {
    id: row ? row.id : diskId(dir),
    name: row ? row.name : dir,
    dir,
    refresh:
      row && (KB_REFRESH_MODES as readonly string[]).includes(row.refresh)
        ? (row.refresh as KbRefreshMode)
        : "on change",
    lastIndexedAt: row ? row.last_indexed_at : null,
    tree,
    fileCount: countKbFiles(tree),
    uri: `store://kb/${dir}`,
  };
}

const KB_SQL = `SELECT id, name, dir, refresh, last_indexed_at
                FROM org_knowledge_bases`;

export function listKnowledgeBases(
  db: Database.Database,
  ctx: OrgSeedContext = {},
): KbView[] {
  const rows = db
    .prepare(`${KB_SQL} ORDER BY created_at ASC, id ASC`)
    .all() as KbRow[];
  const rowByDir = new Map(rows.map((r) => [r.dir, r]));
  const dirs = unionDiskAndRows(
    rows.map((r) => r.dir),
    subDirNames(kbRootDir(ctx.dataRoot)),
  );
  return dirs.map((dir) => buildKb(dir, rowByDir.get(dir) ?? null, ctx));
}

export function getKnowledgeBase(
  db: Database.Database,
  id: string,
  ctx: OrgSeedContext = {},
): KbView | null {
  const row = db.prepare(`${KB_SQL} WHERE id = ?`).get(id) as KbRow | undefined;
  if (row) return buildKb(row.dir, row, ctx);
  const dir = diskNameFromId(id);
  if (dir && existsSync(kbDirPath(dir, ctx.dataRoot))) {
    return buildKb(dir, null, ctx);
  }
  return null;
}

export function saveKnowledgeBase(
  db: Database.Database,
  input: { id?: string | null; name: string; refresh: string },
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { kb: KbView; toast: string } {
  const name = input.name.trim();
  const dir = slugify(name);
  if (name.length < 2 || !dir) {
    throw AppError.validation("Give the knowledge base a name.");
  }
  const refresh = (KB_REFRESH_MODES as readonly string[]).includes(
    input.refresh,
  )
    ? input.refresh
    : "on change";
  const now = new Date().toISOString();

  // Resolve the edit subject: a metadata row (by id) OR a disk-only folder
  // (synthetic id). A brand-new create has neither.
  const existing = input.id
    ? (db.prepare(`${KB_SQL} WHERE id = ?`).get(input.id) as KbRow | undefined)
    : undefined;
  const oldDir = existing
    ? existing.dir
    : input.id
      ? diskNameFromId(input.id)
      : null;
  if (input.id && !existing && !oldDir) {
    throw AppError.notFound("No such knowledge base.");
  }

  if (oldDir && dir !== oldDir) {
    assertResourceUnused(
      db,
      "kb",
      [input.id ?? "", oldDir, existing?.name ?? ""],
      `knowledge base ${existing?.name ?? oldDir}`,
      "rename",
      ctx,
    );
    // Rename ⇒ real folder move (spec §7.3); collision refused.
    const clash = db
      .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ? AND id != ?`)
      .get(dir, existing?.id ?? "");
    const oldAbs = kbDirPath(oldDir, ctx.dataRoot);
    const newAbs = kbDirPath(dir, ctx.dataRoot);
    if (clash || existsSync(newAbs)) {
      throw conflict(`A knowledge-base folder ${dir}/ already exists.`);
    }
    if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
    else mkdirSync(newAbs, { recursive: true });
  } else {
    mkdirSync(kbDirPath(dir, ctx.dataRoot), { recursive: true });
  }

  if (existing) {
    db.prepare(
      `UPDATE org_knowledge_bases
       SET name = ?, dir = ?, refresh = ?, updated_at = ? WHERE id = ?`,
    ).run(name, dir, refresh, now, existing.id);
    recordAudit(db, {
      action: "org.kb.updated",
      actor,
      subjectKind: "org_kb",
      subjectId: existing.id,
      details: { name, dir, refresh, renamed: dir !== oldDir },
    });
    return {
      kb: getKnowledgeBase(db, existing.id, ctx)!,
      toast: `${name} updated`,
    };
  }

  // Create, or adopt a disk-only folder into a fresh metadata row.
  const clash = db
    .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ?`)
    .get(dir);
  if (clash) throw conflict(`A knowledge-base folder ${dir}/ already exists.`);
  const id = newId("kb");
  db.prepare(
    `INSERT INTO org_knowledge_bases
       (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, dir, refresh, now, now, now);
  recordAudit(db, {
    action: oldDir ? "org.kb.updated" : "org.kb.created",
    actor,
    subjectKind: "org_kb",
    subjectId: id,
    details: { name, dir, refresh, ...(oldDir ? { adopted: true } : {}) },
  });
  return {
    kb: getKnowledgeBase(db, id, ctx)!,
    toast: oldDir
      ? `${name} updated`
      : `${name} created — folder ready at store://kb/${dir}/`,
  };
}

export function deleteKnowledgeBase(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { toast: string } {
  const kb = getKnowledgeBase(db, id, ctx);
  if (!kb) throw AppError.notFound("No such knowledge base.");
  assertResourceUnused(
    db,
    "kb",
    [kb.id, kb.dir, kb.name],
    `knowledge base ${kb.name}`,
    "delete",
    ctx,
  );
  rmSync(kbDirPath(kb.dir, ctx.dataRoot), { recursive: true, force: true });
  // Key on the folder (dir is UNIQUE) so a disk-only synthetic id also clears
  // any metadata row that happens to exist.
  db.prepare(`DELETE FROM org_knowledge_bases WHERE dir = ?`).run(kb.dir);
  recordAudit(db, {
    action: "org.kb.deleted",
    actor,
    subjectKind: "org_kb",
    subjectId: kb.id,
    details: { name: kb.name, dir: kb.dir, files: kb.fileCount },
  });
  return { toast: `${kb.name} deleted — agents lose it on next context load` };
}

/** Honest re-index: re-scan the folder, refresh counts + the timestamp. A
 * disk-only folder is adopted into a metadata row so the timestamp sticks. */
export function reindexKnowledgeBase(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { docCount: number; toast: string } {
  const kb = getKnowledgeBase(db, id, ctx);
  if (!kb) throw AppError.notFound("No such knowledge base.");
  const now = new Date().toISOString();
  const existing = db
    .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ?`)
    .get(kb.dir) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE org_knowledge_bases SET last_indexed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO org_knowledge_bases
         (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("kb"), kb.name, kb.dir, kb.refresh, now, now, now);
  }
  recordAudit(db, {
    action: "org.kb.reindexed",
    actor,
    subjectKind: "org_kb",
    subjectId: existing?.id ?? kb.dir,
    details: { docCount: kb.fileCount },
  });
  return {
    docCount: kb.fileCount,
    toast: `${kb.name} re-scanned — ${kb.fileCount} docs`,
  };
}

// ------------------------------------------------------------ MCP servers

export interface McpView {
  id: string;
  name: string;
  transport: "HTTP" | "stdio";
  target: string;
  /** HTTP header name / stdio env var name -> secret reference. */
  auth: Record<string, string>;
  tools: number | null;
  /** true up · false down · null never probed. */
  up: boolean | null;
  lastCheckedAt: string | null;
  /** Codex cannot express arbitrary HTTP headers; Claude can. */
  codexSupported: boolean;
}

interface McpRow {
  id: string;
  name: string;
  transport: string;
  target: string;
  auth_json: string;
  tools_count: number | null;
  up: number | null;
  last_checked_at: string | null;
}

function parseAuthJson(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function mapMcp(row: McpRow): McpView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "stdio" ? "stdio" : "HTTP",
    target: row.target,
    auth: parseAuthJson(row.auth_json),
    tools: row.tools_count,
    up: row.up === null ? null : row.up === 1,
    lastCheckedAt: row.last_checked_at,
    codexSupported:
      row.transport === "stdio" || Object.keys(parseAuthJson(row.auth_json)).length === 0,
  };
}

const MCP_SQL = `SELECT id, name, transport, target, auth_json, tools_count,
                        up, last_checked_at FROM org_mcp_servers`;

export function listMcpServers(db: Database.Database): McpView[] {
  const rows = db
    .prepare(`${MCP_SQL} ORDER BY created_at ASC, id ASC`)
    .all() as McpRow[];
  return rows.map(mapMcp);
}

export function getMcpServer(
  db: Database.Database,
  id: string,
): McpView | null {
  const row = db.prepare(`${MCP_SQL} WHERE id = ?`).get(id) as
    | McpRow
    | undefined;
  return row ? mapMcp(row) : null;
}

export type McpProbeOutcome =
  | { kind: "up"; latencyMs: number; tools: number }
  | { kind: "down"; reason: string }
  | { kind: "skipped" };
type HttpDiscovery = Exclude<McpProbeOutcome, { kind: "skipped" }>;

/**
 * Minimal child-process surface the stdio discovery needs — real
 * `child_process.spawn` satisfies it; tests inject a fake. Kept tiny on
 * purpose (no dependency on the full ChildProcess type).
 */
export interface McpChild {
  stdin: { write(data: string): void; end(): void } | null;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  on(event: "error" | "exit", cb: (arg?: unknown) => void): void;
  kill(signal?: string): void;
}

export type McpSpawn = (
  command: string,
  args: string[],
  options?: { env?: Record<string, string> },
) => McpChild;

export interface McpProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injected spawn for stdio tool-count discovery (tests supply a fake). */
  spawnImpl?: McpSpawn;
  /** File-native agent/project store used by mutation dependency guards. */
  dataRoot?: string;
}

const defaultSpawn: McpSpawn = (command, args, options) =>
  spawn(command, args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: options?.env,
  }) as unknown as McpChild;

export type StdioDiscovery =
  | { kind: "up"; latencyMs: number; tools: number }
  | { kind: "down"; reason: string };

/**
 * Best-effort stdio MCP tool-count discovery: spawn the command and run a
 * minimal JSON-RPC `initialize` → `notifications/initialized` → `tools/list`
 * handshake over newline-delimited stdio, returning the tool count. Never
 * throws and never hangs — a hard timeout kills the child. This is the honest
 * replacement for seed-only counts (finding #11): a real number on success,
 * `down` (→ up=0, count null) otherwise.
 */
export async function discoverStdioMcpTools(
  command: string,
  options: {
    spawnImpl?: McpSpawn;
    timeoutMs?: number;
    env?: Record<string, string>;
  } = {},
): Promise<StdioDiscovery> {
  const parts = parseCommandLine(command);
  if (!parts) return { kind: "down", reason: "invalid command quoting" };
  if (parts.length === 0) return { kind: "down", reason: "no command" };
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 5000;
  const started = Date.now();

  return new Promise<StdioDiscovery>((resolve) => {
    let child: McpChild;
    try {
      child = spawnImpl(parts[0]!, parts.slice(1), {
        env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
      });
    } catch {
      resolve({ kind: "down", reason: "command not found" });
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (result: StdioDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ kind: "down", reason: "timed out" }),
      timeoutMs,
    );

    const send = (msg: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* stdin closed — the exit/error handler resolves */
      }
    };

    child.on("error", () => finish({ kind: "down", reason: "failed to start" }));
    child.on("exit", () =>
      finish({ kind: "down", reason: "exited before responding" }),
    );

    const handle = (msg: {
      id?: unknown;
      result?: { tools?: unknown };
      error?: unknown;
    }) => {
      if (msg.id === 1 && msg.result) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (msg.id === 1 && msg.error) {
        finish({ kind: "down", reason: "initialize rejected" });
      } else if (msg.id === 2) {
        const tools = msg.result?.tools;
        if (Array.isArray(tools)) {
          finish({ kind: "up", latencyMs: Date.now() - started, tools: tools.length });
        } else {
          finish({ kind: "down", reason: "no tools in response" });
        }
      }
    };

    child.stdout?.on("data", (chunk: unknown) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* partial/garbage line — keep reading */
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "viberr", version: "0" },
      },
    });
  });
}

const MCP_PROTOCOL_VERSION = "2025-11-25";

type RpcMessage = {
  id?: unknown;
  result?: { tools?: unknown; protocolVersion?: unknown };
  error?: unknown;
};

async function responseMessage(response: Response): Promise<RpcMessage | null> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const candidates = contentType.includes("text/event-stream")
    ? text
        .split(/\r?\n\r?\n/)
        .flatMap((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim()),
        )
    : [text.trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as RpcMessage;
      }
    } catch {
      // Try the next SSE event. No raw response content enters the result.
    }
  }
  return null;
}

/**
 * Real Streamable HTTP MCP discovery: initialize, initialized notification,
 * then tools/list. A web page, 401, 404 or arbitrary JSON is down—not healthy.
 */
export async function discoverHttpMcpTools(
  target: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpDiscovery> {
  let url: URL;
  try {
    url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { kind: "down", reason: "endpoint is not an http(s) URL" };
    }
  } catch {
    return { kind: "down", reason: "endpoint is not a valid URL" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const request = async (
    payload: unknown,
    sessionId?: string | null,
    protocolVersion?: string | null,
  ): Promise<Response> =>
    fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(options.headers ?? {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });

  try {
    const initialized = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "viberr", version: "1" },
      },
    });
    if (!initialized.ok) {
      return { kind: "down", reason: `initialize returned HTTP ${initialized.status}` };
    }
    const initMessage = await responseMessage(initialized);
    if (!initMessage?.result || initMessage.error) {
      return { kind: "down", reason: "initialize rejected" };
    }
    const sessionId = initialized.headers.get("mcp-session-id");
    const protocolVersion =
      typeof initMessage.result.protocolVersion === "string"
        ? initMessage.result.protocolVersion
        : MCP_PROTOCOL_VERSION;
    const notice = await request(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
      protocolVersion,
    );
    // Notifications commonly return 202/204 and no JSON body.
    if (!notice.ok) {
      return { kind: "down", reason: `initialized notification returned HTTP ${notice.status}` };
    }
    await notice.body?.cancel().catch(() => {});
    const listed = await request(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
      protocolVersion,
    );
    if (!listed.ok) {
      return { kind: "down", reason: `tools/list returned HTTP ${listed.status}` };
    }
    const listMessage = await responseMessage(listed);
    const tools = listMessage?.result?.tools;
    if (!Array.isArray(tools) || listMessage?.error) {
      return { kind: "down", reason: "tools/list returned no tools array" };
    }
    return {
      kind: "up",
      latencyMs: Date.now() - started,
      tools: tools.length,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      kind: "down",
      reason: name === "TimeoutError" ? "connection timed out" : "connection failed",
    };
  }
}

/** Backward-named public probe now performs a full MCP handshake for HTTP. */
export async function probeMcpTarget(
  transport: "HTTP" | "stdio",
  target: string,
  options: McpProbeOptions = {},
): Promise<McpProbeOutcome> {
  if (transport !== "HTTP") return { kind: "skipped" };
  return discoverHttpMcpTools(target, options);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_HTTP_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "host",
  "mcp-session-id",
]);

function validateMcpAuth(
  db: Database.Database,
  transport: "HTTP" | "stdio",
  raw: Record<string, string>,
): Record<string, string> {
  const auth: Record<string, string> = {};
  for (const [rawKey, rawRef] of Object.entries(raw)) {
    const key = rawKey.trim();
    const ref = rawRef.trim();
    const validName =
      transport === "HTTP"
        ? HEADER_NAME.test(key) && !RESERVED_HTTP_HEADERS.has(key.toLowerCase())
        : ENV_NAME.test(key);
    if (!validName) {
      throw AppError.validation(
        transport === "HTTP"
          ? `Invalid or reserved MCP HTTP header name: ${key || "(empty)"}.`
          : `Invalid MCP environment variable name: ${key || "(empty)"}.`,
      );
    }
    if (!isOrgSecretRef(ref)) {
      throw AppError.validation(
        `MCP authentication values must use secret://org/<name> references.`,
      );
    }
    // Validate existence/decryptability now, but never retain or return value.
    void resolveOrgSecretRef(db, ref);
    auth[key] = ref;
  }
  return auth;
}

/** Resolve auth only for an explicit connection test or specialist spawn. */
export function resolveMcpAuth(
  db: Database.Database,
  auth: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(auth).map(([name, ref]) => [name, resolveOrgSecretRef(db, ref)]),
  );
}

export async function saveMcpServer(
  db: Database.Database,
  input: {
    id?: string | null;
    name: string;
    transport: string;
    target: string;
    auth: Record<string, string>;
  },
  actor: AuditActor,
  options: McpProbeOptions = {},
): Promise<{ mcp: McpView; toast: string }> {
  const name = slugify(input.name);
  const target = input.target.trim();
  const transport = input.transport === "stdio" ? "stdio" : "HTTP";
  const auth = validateMcpAuth(db, transport, input.auth);
  const resolvedAuth = resolveMcpAuth(db, auth);
  if (name.length < 2) throw AppError.validation("Give the server a name.");
  if (target.length < 4) {
    throw AppError.validation(
      transport === "stdio" ? "Enter the command." : "Enter the endpoint.",
    );
  }

  const existing = input.id ? getMcpServer(db, input.id) : null;
  if (input.id && !existing) throw AppError.notFound("No such MCP server.");
  if (existing && existing.name !== name) {
    assertResourceUnused(
      db,
      "mcp",
      [existing.id, existing.name],
      `MCP server ${existing.name}`,
      "rename",
      options,
    );
  }

  const clash = db
    .prepare(`SELECT id FROM org_mcp_servers WHERE name = ? AND id != ?`)
    .get(name, input.id ?? "") as { id: string } | undefined;
  if (clash) throw conflict(`An MCP server named ${name} already exists.`);

  const now = new Date().toISOString();

  // stdio → real tool-count discovery (spawn + handshake); HTTP → reachability
  // probe only (tool counts over HTTP are never fabricated).
  let up: number | null;
  let checkedAt: string | null;
  let tools: number | null; // value to store; HTTP keeps the existing column
  let toast: string;
  if (transport === "stdio") {
    const disc = await discoverStdioMcpTools(target, {
      ...options,
      env: resolvedAuth,
    });
    checkedAt = now;
    if (disc.kind === "up") {
      up = 1;
      tools = disc.tools;
      toast = `${name} saved — ${disc.tools} tool${disc.tools === 1 ? "" : "s"} discovered · spawned per run`;
    } else {
      up = 0;
      tools = null;
      toast = `${name} saved — command didn't respond (${disc.reason}); check it`;
    }
  } else {
    const probe = await discoverHttpMcpTools(target, {
      ...options,
      headers: resolvedAuth,
    });
    up = probe.kind === "up" ? 1 : 0;
    checkedAt = now;
    tools = probe.kind === "up" ? probe.tools : null;
    toast =
      probe.kind === "up"
        ? `${name} saved — ${probe.tools} tool${probe.tools === 1 ? "" : "s"} discovered · ${probe.latencyMs}ms`
        : `${name} saved — handshake failed (${probe.reason}); check it`;
  }

  // The probe above yields to the event loop. Re-check immediately before the
  // row mutation so a project/profile that began referencing the old name
  // during that handshake cannot be stranded by the rename.
  if (existing && existing.name !== name) {
    assertResourceUnused(
      db,
      "mcp",
      [existing.id, existing.name],
      `MCP server ${existing.name}`,
      "rename",
      options,
    );
  }

  let id = input.id ?? null;
  if (id) {
    db.prepare(
      `UPDATE org_mcp_servers
       SET name = ?, transport = ?, target = ?, auth_json = ?,
           tools_count = ?, up = ?, last_checked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      transport,
      target,
      JSON.stringify(auth),
      tools,
      up,
      checkedAt,
      now,
      id,
    );
    recordAudit(db, {
      action: "org.mcp.updated",
      actor,
      subjectKind: "org_mcp",
      subjectId: id,
      details: { name, transport },
    });
  } else {
    id = newId("mcp");
    db.prepare(
      `INSERT INTO org_mcp_servers
         (id, name, transport, target, auth_json, tools_count, up,
          last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      transport,
      target,
      JSON.stringify(auth),
      tools,
      up,
      checkedAt,
      now,
      now,
    );
    recordAudit(db, {
      action: "org.mcp.added",
      actor,
      subjectKind: "org_mcp",
      subjectId: id,
      details: { name, transport },
    });
  }

  return { mcp: getMcpServer(db, id)!, toast };
}

export async function testMcpServer(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  options: McpProbeOptions = {},
): Promise<{ mcp: McpView; toast: string }> {
  const existing = getMcpServer(db, id);
  if (!existing) throw AppError.notFound("No such MCP server.");
  const now = new Date().toISOString();
  const resolvedAuth = resolveMcpAuth(db, existing.auth);

  // Both transports perform initialize + tools/list with resolved auth.
  if (existing.transport === "stdio") {
    const disc = await discoverStdioMcpTools(existing.target, {
      ...options,
      env: resolvedAuth,
    });
    if (disc.kind === "up") {
      db.prepare(
        `UPDATE org_mcp_servers
         SET up = 1, tools_count = ?, last_checked_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(disc.tools, now, now, id);
      const fresh = getMcpServer(db, id)!;
      return {
        mcp: fresh,
        toast: `${fresh.name} healthy — ${disc.tools} tool${disc.tools === 1 ? "" : "s"} · ${disc.latencyMs}ms`,
      };
    }
    db.prepare(
      `UPDATE org_mcp_servers
       SET up = 0, tools_count = NULL, last_checked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, id);
    const fresh = getMcpServer(db, id)!;
    return { mcp: fresh, toast: `${fresh.name} unreachable — ${disc.reason}` };
  }

  const probe = await discoverHttpMcpTools(existing.target, {
    ...options,
    headers: resolvedAuth,
  });
  db.prepare(
    `UPDATE org_mcp_servers
     SET up = ?, tools_count = ?, last_checked_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    probe.kind === "up" ? 1 : 0,
    probe.kind === "up" ? probe.tools : null,
    now,
    now,
    id,
  );
  const fresh = getMcpServer(db, id)!;
  const toast =
    probe.kind === "up"
      ? `${fresh.name} healthy — ${probe.tools} tool${probe.tools === 1 ? "" : "s"} · ${probe.latencyMs}ms`
      : probe.kind === "down"
        ? `${fresh.name} unreachable — ${probe.reason}`
        : `${fresh.name} — probe skipped`;
  return { mcp: fresh, toast };
}

export function deleteMcpServer(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { toast: string } {
  const existing = getMcpServer(db, id);
  if (!existing) throw AppError.notFound("No such MCP server.");
  assertResourceUnused(
    db,
    "mcp",
    [existing.id, existing.name],
    `MCP server ${existing.name}`,
    "delete",
    ctx,
  );
  db.prepare(`DELETE FROM org_mcp_servers WHERE id = ?`).run(id);
  recordAudit(db, {
    action: "org.mcp.removed",
    actor,
    subjectKind: "org_mcp",
    subjectId: id,
    details: { name: existing.name },
  });
  return { toast: `${existing.name} removed` };
}

// ---------------------------------------------------------------- skills

const SKILL_BODY_MAX_BYTES = 256 * 1024;

export interface SkillView {
  id: string;
  name: string;
  summary: string;
  updatedAt: string | null;
  /** Live SKILL.md content from disk ("" when absent). */
  body: string;
  tree: StoreNode[];
  fileCount: number;
  uri: string;
}

interface SkillRow {
  id: string;
  name: string;
  summary: string;
  updated_at: string;
}

function readSkillBody(name: string, ctx: OrgSeedContext): string {
  const abs = path.join(skillDirPath(name, ctx.dataRoot), "SKILL.md");
  if (!existsSync(abs)) return "";
  try {
    const raw = readFileSync(abs);
    return raw.subarray(0, SKILL_BODY_MAX_BYTES).toString("utf8");
  } catch {
    return "";
  }
}

/** True when the on-disk SKILL.md exceeds the editor read cap — the body the
 * UI round-trips is a TRUNCATED copy, so writing it back would destroy the
 * tail of the file (E4). */
function skillBodyTruncatedOnDisk(name: string, ctx: OrgSeedContext): boolean {
  const abs = path.join(skillDirPath(name, ctx.dataRoot), "SKILL.md");
  try {
    return existsSync(abs) && statSync(abs).size > SKILL_BODY_MAX_BYTES;
  } catch {
    return false;
  }
}

/** A sensible summary for a disk-only skill: the SKILL.md frontmatter
 * `description:` when present, else a plain placeholder. */
function deriveSkillSummary(name: string, ctx: OrgSeedContext): string {
  const body = readSkillBody(name, ctx);
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const desc = fm[1]!.match(/^description:\s*(.+)$/m);
    if (desc) return desc[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return "On-disk skill — add a summary to describe it";
}

/** Builds a skill view from a disk folder, layering a metadata row when
 * given (disk-only folders get a synthetic id + derived summary). */
function buildSkill(
  name: string,
  row: SkillRow | null,
  ctx: OrgSeedContext,
): SkillView {
  const tree = scanStoreTree(skillDirPath(name, ctx.dataRoot));
  return {
    id: row ? row.id : diskId(name),
    name,
    // Empty row summary (e.g. a row adopted by touchResource on upload)
    // falls back to the derived one, same as a disk-only folder.
    summary: row?.summary ? row.summary : deriveSkillSummary(name, ctx),
    updatedAt: row ? row.updated_at : null,
    body: readSkillBody(name, ctx),
    tree,
    fileCount: countKbFiles(tree),
    uri: `store://skills/${name}`,
  };
}

const SKILL_SQL = `SELECT id, name, summary, updated_at FROM org_skills`;

export function listSkills(
  db: Database.Database,
  ctx: OrgSeedContext = {},
): SkillView[] {
  const rows = db
    .prepare(`${SKILL_SQL} ORDER BY created_at ASC, id ASC`)
    .all() as SkillRow[];
  const rowByName = new Map(rows.map((r) => [r.name, r]));
  const names = unionDiskAndRows(
    rows.map((r) => r.name),
    subDirNames(skillsRootDir(ctx.dataRoot)),
  );
  return names.map((name) => buildSkill(name, rowByName.get(name) ?? null, ctx));
}

export function getSkill(
  db: Database.Database,
  id: string,
  ctx: OrgSeedContext = {},
): SkillView | null {
  const row = db.prepare(`${SKILL_SQL} WHERE id = ?`).get(id) as
    | SkillRow
    | undefined;
  if (row) return buildSkill(row.name, row, ctx);
  const name = diskNameFromId(id);
  if (name && existsSync(skillDirPath(name, ctx.dataRoot))) {
    return buildSkill(name, null, ctx);
  }
  return null;
}

export function saveSkill(
  db: Database.Database,
  input: {
    id?: string | null;
    name: string;
    summary: string;
    body: string;
    /** Explicit "blank the SKILL.md" intent. Without it, an EMPTY submitted
     * body on an EXISTING skill keeps the on-disk content (E4: the modal
     * round-trips a possibly-truncated read — empty must never blank). */
    clearBody?: boolean;
  },
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { skill: SkillView; toast: string } {
  const name = slugify(input.name);
  const summary = input.summary.trim();
  if (name.length < 2) throw AppError.validation("Give the skill a name.");
  if (summary.length < 4) throw AppError.validation("Add a one-line summary.");
  const now = new Date().toISOString();

  // Resolve the edit subject: a metadata row (by id) OR a disk-only folder
  // (synthetic id). A brand-new create has neither.
  const existing = input.id
    ? (db.prepare(`${SKILL_SQL} WHERE id = ?`).get(input.id) as
        | SkillRow
        | undefined)
    : undefined;
  const oldName = existing
    ? existing.name
    : input.id
      ? diskNameFromId(input.id)
      : null;
  if (input.id && !existing && !oldName) {
    throw AppError.notFound("No such skill.");
  }

  // A brand-new create must not clobber an existing on-disk folder (writing
  // SKILL.md would blank it) — editing a disk-only skill goes through oldName.
  if (!input.id && existsSync(skillDirPath(name, ctx.dataRoot))) {
    throw conflict(`A skill folder ${name}/ already exists.`);
  }

  // E4 write policy for EXISTING skills, decided BEFORE the folder moves:
  // - empty body without the explicit clear flag → keep the on-disk SKILL.md;
  // - non-empty body while the on-disk file exceeds the editor read cap →
  //   the submitted text is a truncated round-trip; refuse instead of
  //   silently destroying the tail of the file.
  const body = input.body ?? "";
  const keepExistingBody = Boolean(oldName) && body === "" && !input.clearBody;
  if (
    oldName &&
    !keepExistingBody &&
    body !== "" &&
    skillBodyTruncatedOnDisk(oldName, ctx)
  ) {
    throw AppError.validation(
      `SKILL.md for ${oldName} is larger than the 256 KB editor limit, so the editor only loaded a truncated copy. Saving would overwrite the full file with that truncated text — edit SKILL.md on disk (or re-upload it) instead.`,
    );
  }

  if (oldName && name !== oldName) {
    assertResourceUnused(
      db,
      "skill",
      [input.id ?? "", oldName],
      `skill ${oldName}`,
      "rename",
      ctx,
    );
    const clash = db
      .prepare(`SELECT id FROM org_skills WHERE name = ? AND id != ?`)
      .get(name, existing?.id ?? "");
    const oldAbs = skillDirPath(oldName, ctx.dataRoot);
    const newAbs = skillDirPath(name, ctx.dataRoot);
    if (clash || existsSync(newAbs)) {
      throw conflict(`A skill folder ${name}/ already exists.`);
    }
    if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
  }

  const dir = skillDirPath(name, ctx.dataRoot);
  mkdirSync(dir, { recursive: true });
  if (!keepExistingBody) {
    writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  const updatedToast = keepExistingBody
    ? `Skill ${name} updated — existing SKILL.md kept`
    : `Skill ${name} updated — SKILL.md rewritten`;

  if (existing) {
    db.prepare(
      `UPDATE org_skills SET name = ?, summary = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, summary, now, existing.id);
    recordAudit(db, {
      action: "org.skill.updated",
      actor,
      subjectKind: "org_skill",
      subjectId: existing.id,
      details: { name, renamed: name !== oldName, bodyKept: keepExistingBody },
    });
    return {
      skill: getSkill(db, existing.id, ctx)!,
      toast: updatedToast,
    };
  }

  // Create, or adopt a disk-only folder into a fresh metadata row.
  const clash = db.prepare(`SELECT id FROM org_skills WHERE name = ?`).get(name);
  if (clash) throw conflict(`A skill folder ${name}/ already exists.`);
  const id = newId("sk");
  db.prepare(
    `INSERT INTO org_skills (id, name, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, summary, now, now);
  recordAudit(db, {
    action: oldName ? "org.skill.updated" : "org.skill.created",
    actor,
    subjectKind: "org_skill",
    subjectId: id,
    details: { name, ...(oldName ? { adopted: true } : {}) },
  });
  return {
    skill: getSkill(db, id, ctx)!,
    toast: oldName ? updatedToast : `Skill ${name} created — SKILL.md written`,
  };
}

export function deleteSkill(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { toast: string } {
  const skill = getSkill(db, id, ctx);
  if (!skill) throw AppError.notFound("No such skill.");
  assertResourceUnused(
    db,
    "skill",
    [skill.id, skill.name],
    `skill ${skill.name}`,
    "delete",
    ctx,
  );
  rmSync(skillDirPath(skill.name, ctx.dataRoot), {
    recursive: true,
    force: true,
  });
  // Key on the folder (name is UNIQUE) so a disk-only synthetic id also clears
  // any metadata row that happens to exist.
  db.prepare(`DELETE FROM org_skills WHERE name = ?`).run(skill.name);
  recordAudit(db, {
    action: "org.skill.deleted",
    actor,
    subjectKind: "org_skill",
    subjectId: skill.id,
    details: { name: skill.name },
  });
  return { toast: `Skill ${skill.name} deleted` };
}

// ------------------------------------------------------- store targets

/** Resolves a StoreBrowser target (kb dir / skill folder) for the file
 * actions. Ensures the folder exists (uploads into a fresh KB work). */
export function resolveStoreTarget(
  db: Database.Database,
  kind: string,
  id: string,
  ctx: OrgSeedContext = {},
): StoreTarget | null {
  if (kind === "kb") {
    const kb = getKnowledgeBase(db, id, ctx);
    if (!kb) return null;
    const rootAbs = kbDirPath(kb.dir, ctx.dataRoot);
    mkdirSync(rootAbs, { recursive: true });
    return { kind: "kb", id: kb.id, name: kb.name, rootAbs, rootUri: kb.uri };
  }
  if (kind === "skill") {
    const skill = getSkill(db, id, ctx);
    if (!skill) return null;
    const rootAbs = skillDirPath(skill.name, ctx.dataRoot);
    mkdirSync(rootAbs, { recursive: true });
    return {
      kind: "skill",
      id: skill.id,
      name: skill.name,
      rootAbs,
      rootUri: skill.uri,
    };
  }
  return null;
}

/** Ensures the kb/skills store roots exist (seed + boot safety). */
export function ensureOrgStoreDirs(ctx: OrgSeedContext = {}): void {
  mkdirSync(kbRootDir(ctx.dataRoot), { recursive: true });
  mkdirSync(skillsRootDir(ctx.dataRoot), { recursive: true });
}
