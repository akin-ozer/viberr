import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
import { scanStoreTree, type StoreTarget } from "./store-files.server";

/**
 * Org agent resources: knowledge bases, MCP servers, skills (org-settings
 * spec §3.4–3.6, §4.3–4.4). KB and skill CONTENT is file-native — real
 * folders under ${DATA_ROOT}/kb/<dir>/ and /skills/<name>/, scanned from
 * disk on every read (files added outside Viberr appear on the next load,
 * exactly as the def-note promises). SQLite carries only metadata
 * (cadence, summary, freshness timestamps). A rename recomputes the slug
 * and MOVES the folder (spec §7.3); collisions are refused.
 *
 * MCP health is HONEST: HTTP targets get a real reachability probe
 * (any HTTP response = up); stdio targets are spawned per run and can't be
 * probed — `up` stays null ("not health-checked"). Tool counts are never
 * fabricated (the mock's `tools: 8` fake is gone) — seeded rows carry demo
 * counts, real discovery is a later-phase MCP handshake.
 */

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
}

export interface OrgSeedContext {
  dataRoot?: string;
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

function mapKb(row: KbRow, ctx: OrgSeedContext): KbView {
  const tree = scanStoreTree(kbDirPath(row.dir, ctx.dataRoot));
  return {
    id: row.id,
    name: row.name,
    dir: row.dir,
    refresh: (KB_REFRESH_MODES as readonly string[]).includes(row.refresh)
      ? (row.refresh as KbRefreshMode)
      : "on change",
    lastIndexedAt: row.last_indexed_at,
    tree,
    fileCount: countKbFiles(tree),
    uri: `store://kb/${row.dir}`,
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
  return rows.map((r) => mapKb(r, ctx));
}

export function getKnowledgeBase(
  db: Database.Database,
  id: string,
  ctx: OrgSeedContext = {},
): KbView | null {
  const row = db.prepare(`${KB_SQL} WHERE id = ?`).get(id) as KbRow | undefined;
  return row ? mapKb(row, ctx) : null;
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

  if (input.id) {
    const existing = db
      .prepare(`${KB_SQL} WHERE id = ?`)
      .get(input.id) as KbRow | undefined;
    if (!existing) throw AppError.notFound("No such knowledge base.");
    if (dir !== existing.dir) {
      // Rename ⇒ real folder move (spec §7.3); collision refused.
      const clash = db
        .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ? AND id != ?`)
        .get(dir, input.id);
      const oldAbs = kbDirPath(existing.dir, ctx.dataRoot);
      const newAbs = kbDirPath(dir, ctx.dataRoot);
      if (clash || existsSync(newAbs)) {
        throw conflict(`A knowledge-base folder ${dir}/ already exists.`);
      }
      if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
      else mkdirSync(newAbs, { recursive: true });
    }
    db.prepare(
      `UPDATE org_knowledge_bases
       SET name = ?, dir = ?, refresh = ?, updated_at = ? WHERE id = ?`,
    ).run(name, dir, refresh, now, input.id);
    recordAudit(db, {
      action: "org.kb.updated",
      actor,
      subjectKind: "org_kb",
      subjectId: input.id,
      details: { name, dir, refresh, renamed: dir !== existing.dir },
    });
    return { kb: getKnowledgeBase(db, input.id, ctx)!, toast: `${name} updated` };
  }

  const clash = db
    .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ?`)
    .get(dir);
  if (clash) throw conflict(`A knowledge-base folder ${dir}/ already exists.`);
  const id = newId("kb");
  mkdirSync(kbDirPath(dir, ctx.dataRoot), { recursive: true });
  db.prepare(
    `INSERT INTO org_knowledge_bases
       (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, dir, refresh, now, now, now);
  recordAudit(db, {
    action: "org.kb.created",
    actor,
    subjectKind: "org_kb",
    subjectId: id,
    details: { name, dir, refresh },
  });
  return {
    kb: getKnowledgeBase(db, id, ctx)!,
    toast: `${name} created — folder ready at store://kb/${dir}/`,
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
  rmSync(kbDirPath(kb.dir, ctx.dataRoot), { recursive: true, force: true });
  db.prepare(`DELETE FROM org_knowledge_bases WHERE id = ?`).run(id);
  recordAudit(db, {
    action: "org.kb.deleted",
    actor,
    subjectKind: "org_kb",
    subjectId: id,
    details: { name: kb.name, dir: kb.dir, files: kb.fileCount },
  });
  return { toast: `${kb.name} deleted — agents lose it on next context load` };
}

/** Honest re-index: re-scan the folder, refresh counts + the timestamp. */
export function reindexKnowledgeBase(
  db: Database.Database,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { docCount: number; toast: string } {
  const kb = getKnowledgeBase(db, id, ctx);
  if (!kb) throw AppError.notFound("No such knowledge base.");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE org_knowledge_bases SET last_indexed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, now, id);
  recordAudit(db, {
    action: "org.kb.reindexed",
    actor,
    subjectKind: "org_kb",
    subjectId: id,
    details: { docCount: kb.fileCount },
  });
  return {
    docCount: kb.fileCount,
    toast: `${kb.name} re-indexed — ${kb.fileCount} docs`,
  };
}

// ------------------------------------------------------------ MCP servers

export interface McpView {
  id: string;
  name: string;
  transport: "HTTP" | "stdio";
  target: string;
  cred: string | null;
  tools: number | null;
  /** true up · false down · null never probed / not probeable (stdio). */
  up: boolean | null;
  lastCheckedAt: string | null;
}

interface McpRow {
  id: string;
  name: string;
  transport: string;
  target: string;
  cred_ref: string | null;
  tools_count: number | null;
  up: number | null;
  last_checked_at: string | null;
}

function mapMcp(row: McpRow): McpView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "stdio" ? "stdio" : "HTTP",
    target: row.target,
    cred: row.cred_ref,
    tools: row.tools_count,
    up: row.up === null ? null : row.up === 1,
    lastCheckedAt: row.last_checked_at,
  };
}

const MCP_SQL = `SELECT id, name, transport, target, cred_ref, tools_count,
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
  | { kind: "up"; latencyMs: number }
  | { kind: "down"; reason: string }
  | { kind: "skipped" };

export interface McpProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Honest reachability probe: HTTP targets only; ANY HTTP response counts
 * as reachable (the server exists — tool discovery is a real MCP handshake
 * we don't fake). stdio targets are spawned per run → skipped.
 */
export async function probeMcpTarget(
  transport: "HTTP" | "stdio",
  target: string,
  options: McpProbeOptions = {},
): Promise<McpProbeOutcome> {
  if (transport !== "HTTP") return { kind: "skipped" };
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
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "text/event-stream, application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2500),
    });
    // Headers arrived → the endpoint exists; don't hold an SSE body open.
    res.body?.cancel().catch(() => {});
    return { kind: "up", latencyMs: Date.now() - started };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "connection timed out"
        : "connection refused";
    return { kind: "down", reason };
  }
}

export async function saveMcpServer(
  db: Database.Database,
  input: {
    id?: string | null;
    name: string;
    transport: string;
    target: string;
    cred: string;
  },
  actor: AuditActor,
  options: McpProbeOptions = {},
): Promise<{ mcp: McpView; toast: string }> {
  const name = slugify(input.name);
  const target = input.target.trim();
  const transport = input.transport === "stdio" ? "stdio" : "HTTP";
  const cred = input.cred.trim() || null;
  if (name.length < 2) throw AppError.validation("Give the server a name.");
  if (target.length < 4) {
    throw AppError.validation(
      transport === "stdio" ? "Enter the command." : "Enter the endpoint.",
    );
  }

  const clash = db
    .prepare(`SELECT id FROM org_mcp_servers WHERE name = ? AND id != ?`)
    .get(name, input.id ?? "") as { id: string } | undefined;
  if (clash) throw conflict(`An MCP server named ${name} already exists.`);

  const probe = await probeMcpTarget(transport, target, options);
  const now = new Date().toISOString();
  const up = probe.kind === "skipped" ? null : probe.kind === "up" ? 1 : 0;
  const checkedAt = probe.kind === "skipped" ? null : now;

  let id = input.id ?? null;
  if (id) {
    const existing = getMcpServer(db, id);
    if (!existing) throw AppError.notFound("No such MCP server.");
    db.prepare(
      `UPDATE org_mcp_servers
       SET name = ?, transport = ?, target = ?, cred_ref = ?, up = ?,
           last_checked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, transport, target, cred, up, checkedAt, now, id);
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
         (id, name, transport, target, cred_ref, tools_count, up,
          last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(id, name, transport, target, cred, up, checkedAt, now, now);
    recordAudit(db, {
      action: "org.mcp.added",
      actor,
      subjectKind: "org_mcp",
      subjectId: id,
      details: { name, transport },
    });
  }

  const toast =
    transport === "stdio"
      ? `${name} saved — spawned per run, sandboxed`
      : probe.kind === "up"
        ? `${name} saved — endpoint reachable (${(probe as { latencyMs: number }).latencyMs}ms)`
        : `${name} saved — endpoint unreachable, check the target`;
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
  const probe = await probeMcpTarget(existing.transport, existing.target, options);
  if (probe.kind === "skipped") {
    return {
      mcp: existing,
      toast: `${existing.name} is stdio — spawned per run, health is checked at run time`,
    };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE org_mcp_servers SET up = ?, last_checked_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(probe.kind === "up" ? 1 : 0, now, now, id);
  const fresh = getMcpServer(db, id)!;
  const toast =
    probe.kind === "up"
      ? fresh.tools !== null
        ? `${fresh.name} healthy — ${fresh.tools} tools · ${probe.latencyMs}ms`
        : `${fresh.name} reachable — ${probe.latencyMs}ms`
      : `${fresh.name} unreachable — ${probe.reason}`;
  return { mcp: fresh, toast };
}

export function deleteMcpServer(
  db: Database.Database,
  id: string,
  actor: AuditActor,
): { toast: string } {
  const existing = getMcpServer(db, id);
  if (!existing) throw AppError.notFound("No such MCP server.");
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

function mapSkill(row: SkillRow, ctx: OrgSeedContext): SkillView {
  const tree = scanStoreTree(skillDirPath(row.name, ctx.dataRoot));
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    updatedAt: row.updated_at,
    body: readSkillBody(row.name, ctx),
    tree,
    fileCount: countKbFiles(tree),
    uri: `store://skills/${row.name}`,
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
  return rows.map((r) => mapSkill(r, ctx));
}

export function getSkill(
  db: Database.Database,
  id: string,
  ctx: OrgSeedContext = {},
): SkillView | null {
  const row = db.prepare(`${SKILL_SQL} WHERE id = ?`).get(id) as
    | SkillRow
    | undefined;
  return row ? mapSkill(row, ctx) : null;
}

export function saveSkill(
  db: Database.Database,
  input: { id?: string | null; name: string; summary: string; body: string },
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): { skill: SkillView; toast: string } {
  const name = slugify(input.name);
  const summary = input.summary.trim();
  if (name.length < 2) throw AppError.validation("Give the skill a name.");
  if (summary.length < 4) throw AppError.validation("Add a one-line summary.");
  const now = new Date().toISOString();

  if (input.id) {
    const existing = db
      .prepare(`${SKILL_SQL} WHERE id = ?`)
      .get(input.id) as SkillRow | undefined;
    if (!existing) throw AppError.notFound("No such skill.");
    if (name !== existing.name) {
      const clash = db
        .prepare(`SELECT id FROM org_skills WHERE name = ? AND id != ?`)
        .get(name, input.id);
      const oldAbs = skillDirPath(existing.name, ctx.dataRoot);
      const newAbs = skillDirPath(name, ctx.dataRoot);
      if (clash || existsSync(newAbs)) {
        throw conflict(`A skill folder ${name}/ already exists.`);
      }
      if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
    }
    const dir = skillDirPath(name, ctx.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), input.body ?? "");
    db.prepare(
      `UPDATE org_skills SET name = ?, summary = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, summary, now, input.id);
    recordAudit(db, {
      action: "org.skill.updated",
      actor,
      subjectKind: "org_skill",
      subjectId: input.id,
      details: { name, renamed: name !== existing.name },
    });
    return {
      skill: getSkill(db, input.id, ctx)!,
      toast: `Skill ${name} updated — SKILL.md rewritten`,
    };
  }

  const clash = db.prepare(`SELECT id FROM org_skills WHERE name = ?`).get(name);
  if (clash) throw conflict(`A skill folder ${name}/ already exists.`);
  const id = newId("sk");
  const dir = skillDirPath(name, ctx.dataRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), input.body ?? "");
  db.prepare(
    `INSERT INTO org_skills (id, name, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, summary, now, now);
  recordAudit(db, {
    action: "org.skill.created",
    actor,
    subjectKind: "org_skill",
    subjectId: id,
    details: { name },
  });
  return {
    skill: getSkill(db, id, ctx)!,
    toast: `Skill ${name} created — SKILL.md written`,
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
  rmSync(skillDirPath(skill.name, ctx.dataRoot), {
    recursive: true,
    force: true,
  });
  db.prepare(`DELETE FROM org_skills WHERE id = ?`).run(id);
  recordAudit(db, {
    action: "org.skill.deleted",
    actor,
    subjectKind: "org_skill",
    subjectId: id,
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
