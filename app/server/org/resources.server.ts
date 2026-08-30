import { spawn, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { StoreNode } from "~/features/kb-browser/tree";
import { countKbFiles } from "~/features/kb-browser/tree";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { startMcpWarmup } from "./mcp-warmup.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
import { logger } from "~/server/logging/logger.server";
import {
  isSecretBox,
  openSecretRotating,
  sealSecret,
} from "~/server/secrets/secret-box.server";
import {
  kbDirPath,
  kbRootDir,
  skillDirPath,
  skillsRootDir,
} from "~/server/files/file-store-root.server";
import { isInjectableKbDoc } from "~/server/files/kb-injection.server";
import { resolveContainedSkillFile } from "~/server/files/skill-body.server";
import { newId } from "~/shared/ids/new-id.server";
import { slugify } from "~/shared/ids/slugify";
import { scanStoreTree, type StoreTarget } from "./store-files.server";
import { updateResourceReferences } from "./resource-references.server";

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
 * MCP health is HONEST: HTTP targets get a real reachability probe (any HTTP
 * response = up); stdio targets get a real, best-effort tool-count discovery
 * (a minimal JSON-RPC initialize + tools/list over the spawned command's
 * stdio, short timeout). Tool counts are never fabricated — discovery success
 * stores the real count + up=1, failure leaves up=0 / count null.
 */

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

/**
 * Immediate sub-directory names of a store root ([] when absent).
 *
 * C5/pass-16: this used `statSync`, which DEREFERENCES — so `kb/notes` pointing
 * at `/etc` was listed as a first-class knowledge base, browsable in the store
 * browser, counted in its doc count, and (before the matching guard in
 * `readKbBodyDetailed`) injected into runs as trusted agent context. Every
 * other store path refuses to follow a link out of the store (P14-RV-02);
 * `lstatSync` does not dereference, so a linked entry is simply not a resource.
 */
function subDirNames(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [entry.name] : [],
    );
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
  for (const name of diskNames.toSorted()) {
    if (!seen.has(name)) {
      order.push(name);
      seen.add(name);
    }
  }
  return order;
}

// ------------------------------------------------------- knowledge bases

// R-D (P11-60): "on change" is REAL — the file watcher re-indexes a KB when its
// store files change, the same mechanism the rest of the store uses. The old
// "nightly" mode was decorative (nothing ever scheduled it) and is removed; a KB
// is either watcher-driven ("on change", the default) or pinned to explicit
// re-scans only ("manual").
//
// P13-KM-15 — what this mode does NOT do: it controls the DOC-COUNT/freshness
// metadata only. Agents always read the live folder at run time (readKbBody
// walks the real directory), so "manual" never pins the CONTENT a run sees. The
// KB modal's copy says exactly this so the toggle can't be mistaken for a
// content freeze.
export const KB_REFRESH_MODES = ["on change", "manual"] as const;
export type KbRefreshMode = (typeof KB_REFRESH_MODES)[number];
export const DEFAULT_KB_REFRESH: KbRefreshMode = "on change";

export interface KbView {
  id: string;
  name: string;
  dir: string;
  refresh: KbRefreshMode;
  lastIndexedAt: string | null;
  tree: StoreNode[];
  fileCount: number;
  /**
   * Files a run would actually read (P14-KM-13). `fileCount` is every file in
   * the folder, which is the honest number for "delete removes N files" but a
   * lie when read as "N docs the agent has" — a KB of PDFs counted healthy and
   * injected nothing. Both numbers ship so the row can say which is which.
   */
  injectableCount: number;
  /**
   * F18-4: whether the KB's store folder exists on disk. A folder that was
   * wiped/renamed under the row reads as `0 docs` — identical to a healthy empty
   * KB — while a granted agent silently gets nothing. `false` lets the row say
   * "folder missing" instead of pretending it is a normal empty KB.
   */
  folderExists: boolean;
  /** "store://kb/<dir>" (no trailing slash — mock root prop contract). */
  uri: string;
}

type KbRow = {
  id: string;
  name: string;
  dir: string;
  refresh: string;
  last_indexed_at: string | null;
};

/** Is a stored `refresh` column one of the two modes the product offers? */
function isKbRefreshMode(value: string): value is KbRefreshMode {
  return KB_REFRESH_MODES.some((mode) => mode === value);
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
    refresh: row && isKbRefreshMode(row.refresh) ? row.refresh : "on change",
    lastIndexedAt: row ? row.last_indexed_at : null,
    tree,
    fileCount: countKbFiles(tree),
    injectableCount: countInjectableDocs(tree),
    folderExists: existsSync(kbDirPath(dir, ctx.dataRoot)),
    uri: `store://kb/${dir}`,
  };
}

/** Recursive count of the files `readKbBody` would inject (P14-KM-13). */
function countInjectableDocs(nodes: StoreNode[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum +
      (node.type === "dir"
        ? countInjectableDocs(node.children)
        : isInjectableKbDoc(node.name)
          ? 1
          : 0),
    0,
  );
}

const KB_SQL = `SELECT id, name, dir, refresh, last_indexed_at
                FROM org_knowledge_bases`;

export function listKnowledgeBases(
  db: DatabaseSync,
  ctx: OrgSeedContext = {},
): KbView[] {
  // SAFETY: `KB_SQL` selects exactly the five `org_knowledge_bases` columns
  // `KbRow` declares, and the baseline DDL makes every one but
  // `last_indexed_at` NOT NULL TEXT (0001_baseline.sql).
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
  db: DatabaseSync,
  id: string,
  ctx: OrgSeedContext = {},
): KbView | null {
  // SAFETY: same `KB_SQL` column guarantee as `listKnowledgeBases`.
  const row = db.prepare(`${KB_SQL} WHERE id = ?`).get(id) as KbRow | undefined;
  if (row) return buildKb(row.dir, row, ctx);
  const dir = diskNameFromId(id);
  if (dir && existsSync(kbDirPath(dir, ctx.dataRoot))) {
    return buildKb(dir, null, ctx);
  }
  return null;
}

/** Audit payload for a KB create (see `adopted` at the write below). */
type KbCreateAudit = {
  name: string;
  dir: string;
  refresh: KbRefreshMode;
  adopted?: boolean;
};

export async function saveKnowledgeBase(
  db: DatabaseSync,
  input: { id?: string | null; name: string; refresh: string },
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): Promise<{ kb: KbView; toast: string }> {
  const name = input.name.trim();
  const dir = slugify(name);
  if (name.length < 2 || !dir) {
    throw AppError.validation("Give the knowledge base a name.");
  }
  const refresh = isKbRefreshMode(input.refresh) ? input.refresh : "on change";
  const now = new Date().toISOString();

  // Resolve the edit subject: a metadata row (by id) OR a disk-only folder
  // (synthetic id). A brand-new create has neither.
  // SAFETY: same `KB_SQL` column guarantee as `listKnowledgeBases`.
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

  // C4 — the folder move and the row write are ONE synchronous block, and the
  // reference rewrite comes AFTER.
  //
  // The old order was `renameSync` → `await updateResourceReferences(…)` →
  // `UPDATE … SET dir`. That await walks EVERY agent template and EVERY
  // project.md, so its duration scales with the installation; the KB watcher
  // debounces for only KB_WATCH_DEBOUNCE_MS (250 ms). Whenever the walk ran
  // long, the watcher saw `addDir` on the NEW folder while the row still said
  // the OLD dir, found no row, and adopted the folder as a brand-new KB
  // (`reindexKnowledgeBaseByDir`) — after which this function's pending write
  // collided with the `dir` UNIQUE constraint and the rename failed with a
  // constraint error on a folder that had already moved.
  //
  // node:sqlite is synchronous and there is no `await` between the rename and
  // the row write below, so the event loop cannot run the watcher's debounce
  // timer in that window at all: the watcher can only ever observe a state
  // where disk and row already agree.
  const renamedFrom = oldDir && dir !== oldDir ? oldDir : null;
  if (renamedFrom) {
    // Rename ⇒ real folder move (spec §7.3); collision refused.
    const clash = db
      .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ? AND id != ?`)
      .get(dir, existing?.id ?? "");
    const oldAbs = kbDirPath(renamedFrom, ctx.dataRoot);
    const newAbs = kbDirPath(dir, ctx.dataRoot);
    if (clash || existsSync(newAbs)) {
      throw AppError.conflict(`A knowledge-base folder ${dir}/ already exists.`);
    }
    if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
    else mkdirSync(newAbs, { recursive: true });
  } else {
    mkdirSync(kbDirPath(dir, ctx.dataRoot), { recursive: true });
  }

  // P13-KM-07: a rename used to move the folder and leave every agent grant
  // pointing at the old dir — silently, on both the template and deployment
  // side. Rewrite the references with the move (after the row write, see C4).
  const rewriteReferences = async () => {
    if (renamedFrom) {
      await updateResourceReferences("kb", renamedFrom, dir, ctx.dataRoot);
    }
  };

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
    await rewriteReferences();
    return {
      kb: getKnowledgeBase(db, existing.id, ctx)!,
      toast: `${name} updated`,
    };
  }

  // Create, or adopt a disk-only folder into a fresh metadata row.
  const clash = db
    .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ?`)
    .get(dir);
  if (clash) throw AppError.conflict(`A knowledge-base folder ${dir}/ already exists.`);
  const id = newId("kb");
  db.prepare(
    `INSERT INTO org_knowledge_bases
       (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, dir, refresh, now, now, now);
  // `adopted` is present only when this create took over a folder that was
  // already on disk — a plain create carries no such key at all.
  const details: KbCreateAudit = { name, dir, refresh };
  if (oldDir) details.adopted = true;
  recordAudit(db, {
    action: oldDir ? "org.kb.updated" : "org.kb.created",
    actor,
    subjectKind: "org_kb",
    subjectId: id,
    details,
  });
  await rewriteReferences();
  return {
    kb: getKnowledgeBase(db, id, ctx)!,
    toast: oldDir
      ? `${name} updated`
      : `${name} created. Folder ready at store://kb/${dir}/`,
  };
}

export async function deleteKnowledgeBase(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): Promise<{ toast: string }> {
  const kb = getKnowledgeBase(db, id, ctx);
  if (!kb) throw AppError.notFound("No such knowledge base.");
  rmSync(kbDirPath(kb.dir, ctx.dataRoot), { recursive: true, force: true });
  // P13-KM-07: drop the now-dangling grants instead of leaving every profile
  // pointing at a folder that no longer exists.
  await updateResourceReferences("kb", kb.dir, null, ctx.dataRoot);
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
  return { toast: `${kb.name} deleted. Agents lose it on next context load` };
}

/** What a re-index reports back: the docs a run can read, plus the toast. */
interface KbReindexResult {
  docCount: number;
  toast: string;
}

/** Honest re-index: re-scan the folder, refresh counts + the timestamp. A
 * disk-only folder is adopted into a metadata row so the timestamp sticks. */
export function reindexKnowledgeBase(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): KbReindexResult {
  const kb = getKnowledgeBase(db, id, ctx);
  if (!kb) throw AppError.notFound("No such knowledge base.");
  const now = new Date().toISOString();
  // SAFETY: `id` is the TEXT PRIMARY KEY of `org_knowledge_bases`
  // (0001_baseline.sql), so the one selected column is a string when a row
  // matches at all.
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
    details: { docCount: kb.injectableCount, files: kb.fileCount },
  });
  // P14-KM-13: "N docs" used to be every file in the folder, so re-scanning a
  // KB of PDFs cheerfully reported docs no run can read. Count what injects, and
  // name the rest rather than folding it in.
  const skipped = kb.fileCount - kb.injectableCount;
  return {
    docCount: kb.injectableCount,
    toast:
      `${kb.name} re-scanned: ${kb.injectableCount} doc${kb.injectableCount === 1 ? "" : "s"} agents can read` +
      (skipped > 0
        ? ` · ${skipped} non-text file${skipped === 1 ? "" : "s"} skipped`
        : ""),
  };
}

/**
 * Watcher-driven re-index (R-D): a KB's store files changed on disk, so re-scan
 * that KB by its `dir`. Only KBs in "on change" mode are auto-re-indexed — a KB
 * pinned to "manual" is left for the explicit re-scan button. Returns the new
 * doc count, or null when the dir has no metadata row, no longer exists, or is
 * pinned manual. Best-effort: never throws (the caller is a file-watch handler).
 */
export function reindexKnowledgeBaseByDir(
  db: DatabaseSync,
  dir: string,
  ctx: OrgSeedContext = {},
): { name: string; docCount: number } | null {
  // SAFETY: `id`, `name` and `refresh` are all NOT NULL TEXT on
  // `org_knowledge_bases` (0001_baseline.sql).
  let row = db
    .prepare(`SELECT id, name, refresh FROM org_knowledge_bases WHERE dir = ?`)
    .get(dir) as { id: string; name: string; refresh: string } | undefined;
  // P13-KM-16: a DISK-ONLY KB (a folder created outside Viberr, which the
  // listings show as a first-class KB) had no row, so the watcher bailed and
  // its freshness never advanced — "re-scanned never" forever, while the same
  // folder re-indexed fine the moment anyone edited it in the UI. Adopt it, the
  // same adopt-on-touch rule the store mutations already use.
  if (!row && existsSync(kbDirPath(dir, ctx.dataRoot))) {
    const now = new Date().toISOString();
    const id = newId("kb");
    db.prepare(
      `INSERT INTO org_knowledge_bases
         (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'on change', ?, ?, ?)`,
    ).run(id, dir, dir, now, now, now);
    logger.info("adopted disk-only knowledge base on watcher re-index", { dir });
    row = { id, name: dir, refresh: "on change" };
  }
  if (!row) return null;
  if (row.refresh === "manual") return null;
  const abs = kbDirPath(dir, ctx.dataRoot);
  if (!existsSync(abs)) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE org_knowledge_bases SET last_indexed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, row.id);
  const tree = scanStoreTree(abs);
  // P14-KM-13: the watcher's log line reports the same number the row does —
  // docs a run can actually read, not every file that landed in the folder.
  return { name: row.name, docCount: countInjectableDocs(tree) };
}

// ------------------------------------------------------------ MCP servers

export interface McpView {
  id: string;
  name: string;
  transport: "HTTP" | "stdio";
  target: string;
  /** Whether an encrypted credential is configured for this server. The sealed
   *  secret NEVER leaves the server (F7-MCP1) — only this boolean is exposed so
   *  the UI can show "auth configured" without the value; injection reads the
   *  sealed value via `getMcpCredentialState`. */
  hasCred: boolean;
  /**
   * A9: `hasCred` alone could not tell "authenticated" from "configured but
   * BROKEN". A credential that no longer decrypts used to make every run
   * connect anonymously with nothing but a log line to show for it, while this
   * row still read "auth configured". `true` here means the stored credential
   * cannot be opened and the server will NOT be mounted on a run.
   *
   * Optional so hand-built fixtures elsewhere stay valid; every real row from
   * `mapMcp` sets it explicitly.
   */
  credUnreadable?: boolean;
  tools: number | null;
  /** true up · false down · null never probed / not probeable (stdio). */
  up: boolean | null;
  lastCheckedAt: string | null;
  /**
   * R19-17: why the last probe failed, in the command's own words (already
   * scrubbed of the credential the child was spawned with). NULL when the
   * server is up or was never probed — the reason used to live only in a toast,
   * so the moment it faded a red dot was the whole story and the admin had to
   * re-run the test to find out why again.
   */
  lastError: string | null;
  /**
   * R19-18: when set, a first-run install is running in the BACKGROUND for this
   * server. The row reads "installing" rather than unreachable, and the
   * settings page re-checks until the warm-up writes a real verdict.
   */
  warmingSince: string | null;
  /**
   * R20-4 (N20-2): when this server first answered a probe successfully (ISO),
   * or NULL if it never has here. A NULL turns a timeout on an npx/uvx-style
   * command into a plausible first-run INSTALL rather than a broken server.
   *
   * Optional so hand-built fixtures elsewhere stay valid; every real row from
   * `mapMcp` sets it explicitly.
   */
  firstSuccessAt?: string | null;
  /**
   * R20-4 (N20-2): how many times the HEURISTIC (the command looks like an
   * installer but printed nothing install-y, and the row has never succeeded)
   * armed a background warm-up. Capped at 1, so a command that times out on
   * EVERY probe still settles to `unreachable` instead of re-downloading
   * forever. Optional for the same fixture reason as `firstSuccessAt`.
   */
  heuristicWarmups?: number;
}

type McpRow = {
  id: string;
  name: string;
  transport: string;
  target: string;
  cred_ref: string | null;
  tools_count: number | null;
  up: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  warming_since: string | null;
  first_success_at: string | null;
  heuristic_warmups: number | null;
};

function mapMcp(row: McpRow): McpView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "stdio" ? "stdio" : "HTTP",
    target: row.target,
    hasCred: !!row.cred_ref,
    // A cheap format check only — a full decrypt attempt per listed row would
    // put key work on every settings render. A legacy plaintext ref is caught
    // here; a wrong-key box is caught by the resolver/probe, which report it
    // through the same `credUnreadable` vocabulary.
    credUnreadable: !!row.cred_ref && !isSecretBox(row.cred_ref),
    tools: row.tools_count,
    up: row.up === null ? null : row.up === 1,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    warmingSince: row.warming_since,
    firstSuccessAt: row.first_success_at,
    heuristicWarmups: row.heuristic_warmups ?? 0,
  };
}

/**
 * What a row's `cred_ref` column actually yields (A9).
 *
 * `none`       — no credential configured; connecting unauthenticated is correct.
 * `ok`         — decrypted; use `token`.
 * `unreadable` — a credential IS configured and cannot be opened: a legacy
 *                plaintext ref, or a box no current/retired key opens.
 */
export type McpCredentialState =
  | { state: "none" }
  | { state: "ok"; token: string }
  | { state: "unreadable"; reason: string };

/**
 * Server-only accessor for an MCP server's DECRYPTED credential (F7-MCP1). Used
 * by the run-spawn injection path (specialist-mcp) and the health probes —
 * never a loader or a client-facing surface.
 *
 * A9: the failure mode used to be a `logger.warn` and `null`, i.e. **silently
 * unauthenticated**. Every authenticated server downgraded to anonymous on a
 * key mismatch, the run's prompt still advertised its tools, and the only trace
 * was a server log line. A configured-but-unopenable credential is now a typed
 * state the callers must handle: the resolver refuses to mount the server and
 * tells the RUN why, and the settings row says so too. Rotation itself is now
 * implemented (`openSecretRotating` + lazy re-seal), so the common cause of
 * this state — an operator changing VIBERR_SECRET_ENCRYPTION_KEY — is handled
 * rather than merely reported.
 */
export function getMcpCredentialState(
  db: DatabaseSync,
  name: string,
): McpCredentialState {
  // SAFETY: `id` is the TEXT PRIMARY KEY and `cred_ref` a nullable TEXT column
  // of `org_mcp_servers` (0001_baseline.sql).
  const row = db
    .prepare(`SELECT id, cred_ref FROM org_mcp_servers WHERE name = ?`)
    .get(name) as { id: string; cred_ref: string | null } | undefined;
  if (!row?.cred_ref) return { state: "none" };
  return openMcpCredential(db, row.id, name, row.cred_ref);
}

/** Shared open + lazy re-seal for one row's sealed credential. */
function openMcpCredential(
  db: DatabaseSync,
  id: string,
  name: string,
  credRef: string,
): McpCredentialState {
  if (!isSecretBox(credRef)) {
    logger.error(
      "mcp credential is in a legacy/unreadable format — the server will NOT be mounted",
      { mcp: name },
    );
    return {
      state: "unreadable",
      reason:
        "its stored credential is not in the current sealed format. Re-enter it in Settings → MCP servers",
    };
  }
  try {
    const opened = openSecretRotating(credRef);
    if (opened.staleKey) {
      // Lazy rotation: the box opened under a RETIRED key, so rewrite it under
      // the current one. This is what makes a key rotation converge with no
      // migration — and what stops the next read from degrading to no-auth.
      try {
        db.prepare(`UPDATE org_mcp_servers SET cred_ref = ? WHERE id = ?`).run(
          sealSecret(opened.plaintext),
          id,
        );
        logger.info("re-sealed an MCP credential under the current encryption key", {
          mcp: name,
        });
      } catch (error) {
        logger.warn("could not re-seal an MCP credential — read still succeeded", {
          mcp: name,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return { state: "ok", token: opened.plaintext };
  } catch (error) {
    logger.error(
      "mcp credential failed to decrypt under every configured key — the server will NOT be mounted",
      {
        mcp: name,
        err: error instanceof Error ? error : new Error(String(error)),
      },
    );
    return {
      state: "unreadable",
      reason:
        "its stored credential cannot be decrypted because the secret-encryption key changed. Set VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS to the old key, or re-enter the credential in Settings → MCP servers",
    };
  }
}

/**
 * What opening a row's sealed credential yielded for a probe: the plaintext
 * when it opened, and whether a credential IS configured but unopenable — which
 * the toast names, because a run refuses to mount such a server at all.
 */
interface ProbeCredential {
  token: string | null;
  unreadable: boolean;
}

/** Open a sealed credential for a PROBE. Unlike a run, a probe MAY continue
 *  unauthenticated — but it reports which it did, so a green/red dot is never
 *  measured against a different credential than the run would use. */
function safeOpenSecret(
  db: DatabaseSync,
  id: string,
  name: string,
  sealed: string,
): ProbeCredential {
  const state = openMcpCredential(db, id, name, sealed);
  if (state.state === "ok") return { token: state.token, unreadable: false };
  return { token: null, unreadable: state.state === "unreadable" };
}

/** The same open for a row that does not exist yet (a CREATE): there is nothing
 *  to lazily re-seal into, so this is a plain read with the same reporting. */
function openedForNewRow(sealed: string, name: string): ProbeCredential {
  if (!isSecretBox(sealed)) return { token: null, unreadable: true };
  try {
    return { token: openSecretRotating(sealed).plaintext, unreadable: false };
  } catch (error) {
    logger.error("mcp credential failed to decrypt on save — probing no-auth", {
      mcp: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { token: null, unreadable: true };
  }
}

const MCP_SQL = `SELECT id, name, transport, target, cred_ref, tools_count,
                        up, last_checked_at, last_error, warming_since,
                        first_success_at, heuristic_warmups
                 FROM org_mcp_servers`;

export function listMcpServers(db: DatabaseSync): McpView[] {
  // SAFETY: `MCP_SQL` selects exactly the twelve `org_mcp_servers` columns
  // `McpRow` declares; the baseline DDL types each one as the column this row
  // reads (0001_baseline.sql), NOT NULL on id/name/transport/target.
  const rows = db
    .prepare(`${MCP_SQL} ORDER BY created_at ASC, id ASC`)
    .all() as McpRow[];
  return rows.map(mapMcp);
}

export function getMcpServer(
  db: DatabaseSync,
  id: string,
): McpView | null {
  // SAFETY: same `MCP_SQL` column guarantee as `listMcpServers`.
  const row = db.prepare(`${MCP_SQL} WHERE id = ?`).get(id) as
    | McpRow
    | undefined;
  return row ? mapMcp(row) : null;
}

export type McpProbeOutcome =
  | { kind: "up"; latencyMs: number }
  | { kind: "down"; reason: string }
  | { kind: "skipped" };

/**
 * Minimal child-process surface the stdio discovery needs — real
 * `child_process.spawn` satisfies it; tests inject a fake. Kept tiny on
 * purpose (no dependency on the full ChildProcess type).
 */
export interface McpChild {
  stdin:
    | {
        write(data: string): void;
        end(): void;
        /** F20-8: a write to a child that already exited surfaces here as an
         *  ASYNC 'error' (EPIPE); an unhandled one is a fatal uncaughtException.
         *  Node emits an `Error` on a stream's 'error' — the probe folds every
         *  one into the same `down` outcome without reading it. */
        on?(event: "error", cb: (err: Error) => void): void;
      }
    | null;
  stdout: { on(event: "data", cb: McpStreamListener): void } | null;
  /** The failed command's OWN explanation — see `discoverStdioMcpTools`. */
  stderr: { on(event: "data", cb: McpStreamListener): void } | null;
  /** F20-22: the 'exit' handler reads `(code, signal)`; 'error' passes an Error. */
  on(event: "error" | "exit", cb: McpChildEndListener): void;
  kill(signal?: NodeJS.Signals): void;
  /** F20-2: the child's OS pid, present on a real spawn — used to signal the
   *  whole process GROUP so grandchildren (npx→node→chromium) are not orphaned
   *  to pid 1. Absent on the test fakes (which model no grandchildren). */
  pid?: number | null;
}

/** A stdio chunk as Node delivers it: a Buffer, or a string on an encoded stream. */
type McpStreamListener = (chunk: string | Uint8Array) => void;

/**
 * One listener for both terminal events, because the probe answers them the
 * same way: 'error' hands it the spawn failure, 'exit' the `(code, signal)`
 * Node reports for a child that started and then stopped.
 */
type McpChildEndListener = (
  codeOrError?: Error | number | null,
  signal?: NodeJS.Signals | null,
) => void;

export type McpSpawn = (
  command: string,
  args: string[],
  token?: string | null,
) => McpChild;

export interface McpProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** R19-18: budget for a BACKGROUND install started off this probe (tests
   *  shorten it; production uses `WARMUP_CAP_MS`). */
  capMs?: number;
  /** Injected spawn for stdio tool-count discovery (tests supply a fake). */
  spawnImpl?: McpSpawn;
}

const defaultSpawn: McpSpawn = (command, args, token) => {
  const options: SpawnOptions = {
    // stderr was "ignore" — discarded by the OS, so the one thing that
    // explains a failure never reached us. See `discoverStdioMcpTools`.
    stdio: ["pipe", "pipe", "pipe"],
    // F20-2: lead a new process GROUP so the timeout teardown can signal the
    // whole tree (`npx` → node → chromium helpers), not just the direct child.
    // Node-as-pid-1 has no init to reap the orphans a bare `child.kill()` left,
    // so a boot accumulated defunct chromium/crashpad zombies under pid 1.
    detached: true,
  };
  // The credential reaches the child through its env (P13-KM-05); without one
  // the child inherits this process's env untouched, so `env` stays absent.
  if (token) options.env = { ...process.env, MCP_CREDENTIAL: token };
  return spawn(command, args, options);
};

/**
 * F20-2: tear down a spawned MCP child and everything it forked.
 *
 * A stdio MCP command is usually a package-manager runner (`npx`/`uvx`) that
 * forks a node/python grandchild, and the browser MCP forks chromium helpers
 * under that. `child.kill()` signals ONLY the direct child, orphaning the tree
 * to pid 1 where node-as-init never reaps it. Spawned `detached: true`, the
 * child leads its own group, so `process.kill(-pid, …)` reaches every member.
 * Falls back to `child.kill()` when there is no pid (the test fakes) or the
 * group is already gone.
 */
function killProcessTree(child: McpChild): void {
  const pid = child.pid ?? null;
  if (pid !== null) {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      /* group already gone, or no such group — fall through to the direct kill */
    }
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/** The `down` half of a discovery, named so a caller can build one field by
 *  field instead of spreading conditionals into it. */
interface StdioDiscoveryFailure {
  kind: "down";
  reason: string;
  /** R19-18: the command was mid first-run install when the probe gave up —
   *  a candidate for a background warm-up, not a failure to report. */
  installing?: boolean;
  /** R20-4 (N20-2): the TIMEOUT fired on a command that fetches on first use
   *  (`npx`/`bunx`/…), but the command printed nothing install-y. Only the
   *  CALLER can decide whether this is really a first run (it holds the row),
   *  so the probe reports it and stays DB-free. */
  firstRunInstaller?: boolean;
}

export type StdioDiscovery =
  | { kind: "up"; latencyMs: number; tools: number }
  | StdioDiscoveryFailure;

/**
 * Split a stdio MCP command line into argv, keeping quoted segments whole.
 *
 * P13-KM-17 made the RUN side quote-aware and left the probe splitting on
 * whitespace, so a command with a quoted path or a JSON argument connected
 * perfectly inside a run while Settings reported it "unreachable" — the exact
 * health-vs-runtime divergence P13-KM-05 fixed for credentials (P14-KM-04).
 * One parser, used by discovery here and by `resolveSpecialistMcpServers`.
 */
export function splitMcpCommand(target: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(target.trim())) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out.filter(Boolean);
}

/**
 * R20-4 (N20-2): a package-manager runner that FETCHES on first use.
 *
 * `uvx` announces itself on stderr and is already caught by `INSTALLING_RE`;
 * `npx`/`bunx`/the `dlx` family are SILENT while the registry resolves, which
 * is exactly the N20-2 gap — a cold probe timed out with no warm-up. Matched on
 * argv, never the raw string, so `my-server --npx-mode` is not a false positive.
 * Exported for its test.
 */
export function isFirstRunInstallerCommand(argv: string[]): boolean {
  const bin = (argv[0] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const next = (argv[1] ?? "").toLowerCase();
  if (["npx", "bunx", "uvx", "pipx"].includes(bin)) return true;
  if (["pnpm", "yarn", "bun"].includes(bin) && (next === "dlx" || next === "x")) return true;
  if (bin === "uv" && next === "tool") return true;
  return false;
}

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
  options: { spawnImpl?: McpSpawn; timeoutMs?: number; token?: string | null } = {},
): Promise<StdioDiscovery> {
  const parts = splitMcpCommand(command);
  if (parts.length === 0) return { kind: "down", reason: "no command" };
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  /**
   * R19-17c: 5s was too short for the commands people actually register. `npx`
   * and `uvx` FETCH on first use, and the probe would kill them before either
   * had printed a word — so the row said a bare "timed out" about a command
   * that was busy downloading. 20s is long enough that a first-run install has
   * announced itself on stderr (which the reason then carries), and short
   * enough to sit inside the save request that waits for it.
   */
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();

  return new Promise<StdioDiscovery>((resolve) => {
    let child: McpChild;
    try {
      // P13-KM-05: a credentialed stdio server is spawned WITH its credential,
      // exactly as `resolveSpecialistMcpServers` does at run time. Probing
      // without it reported "unreachable" in Settings for servers that work
      // perfectly inside a run.
      child = spawnImpl(parts[0]!, parts.slice(1), options.token ?? null);
    } catch (err) {
      resolve({
        kind: "down",
        reason:
          err instanceof Error && err.message
            ? `command not found (${err.message})`
            : "command not found",
      });
      return;
    }

    let settled = false;
    let buffer = "";
    /**
     * What the command itself said. The probe used to answer a failure with
     * five fixed words — "command not found", "failed to start", "exited before
     * responding" — while the process had ALREADY explained itself on stderr and
     * the spawn threw that channel away (`stdio: [...,"ignore"]`). Live, a
     * `uvx` MCP server that crashed on an upstream import error reported
     * "exited before responding", and the ImportError naming the exact symbol
     * was unrecoverable from the app at all.
     *
     * Same shape as ruling 69 for git's stderr, and the same scrubber: the
     * child is spawned WITH `MCP_CREDENTIAL` in its env (P13-KM-05), so a
     * server that dumps its environment while dying would otherwise print the
     * credential into a toast. `redactGitOutput` removes it BY VALUE — it is
     * the shared child-process scrubber, named for the caller it was written
     * for — and clamps to the TAIL, which is where a traceback's actual error
     * sits.
     */
    let stderr = "";
    const STDERR_CAP = 8000;
    const withDetail = (base: string, extra?: string): string => {
      const detail = redactGitOutput([extra, stderr].filter(Boolean).join("\n"), {
        token: options.token ?? null,
      });
      return detail ? `${base}: ${detail}` : base;
    };
    const finish = (result: StdioDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // F20-2: signal the whole process group, not just the direct child.
      killProcessTree(child);
      resolve(result);
    };
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += String(chunk);
    });

    /**
     * Package managers announce a first-run fetch before the server can
     * possibly speak. Telling those two states apart is the difference between
     * "this is broken" and "this is still downloading" — and only the second
     * has a useful next step.
     */
    const INSTALLING_RE =
      /\b(downloading|building|installing|resolving|fetching|added \d+ packages)\b/i;
    const timer = setTimeout(() => {
      const installing = INSTALLING_RE.test(stderr);
      // R20-4 (N20-2): the command said nothing install-y, but it IS an
      // npx/bunx-style runner that fetches on first use — a plausible first-run
      // download rather than a broken server. Report the shape; only the caller
      // (which holds the row) decides whether to warm it.
      const firstRunInstaller = !installing && isFirstRunInstallerCommand(parts);
      const timedOut: StdioDiscoveryFailure = {
        kind: "down",
        reason: withDetail(
          installing
            ? `still installing after ${Math.round(timeoutMs / 1000)}s. The first run of this command fetches its dependencies`
            : firstRunInstaller
              ? `no response in ${Math.round(timeoutMs / 1000)}s. \`${parts[0]}\` fetches its package on first use, so this is probably still downloading`
              : `timed out after ${Math.round(timeoutMs / 1000)}s`,
        ),
      };
      // Both flags are claims about THIS timeout, so each key is present only
      // when the probe actually saw the evidence for it.
      if (installing) timedOut.installing = true;
      if (firstRunInstaller) timedOut.firstRunInstaller = true;
      finish(timedOut);
    }, timeoutMs);

    const send = (msg: McpHandshakeRequest) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* stdin closed — the exit/error handler resolves */
      }
    };

    // F20-8 (EPIPE): a write to a child that has ALREADY exited surfaces as an
    // async 'error' on the stdin stream — the synchronous try/catch in `send()`
    // cannot see it, so an unhandled EPIPE was a fatal uncaughtException that
    // took the whole server down (live: 5/40 fast-exit iterations). Fold a
    // broken pipe into the same `down` outcome the `exit` handler produces.
    child.stdin?.on?.("error", () =>
      finish({ kind: "down", reason: withDetail("exited before responding") }),
    );

    // The spawn error itself is the most precise thing there is for a missing
    // binary — `spawn uvx ENOENT` names the command that is not installed,
    // where "failed to start" left the reader guessing.
    child.on("error", (err) =>
      finish({
        kind: "down",
        reason: withDetail(
          "failed to start",
          err instanceof Error ? err.message : undefined,
        ),
      }),
    );
    child.on("exit", (code, signal) => {
      // F20-22: fold the exit status into the reason — the bare "exited before
      // responding" dropped the `(code, signal)` Node already hands us. A signal
      // means the kernel killed it (OOM/segfault); a non-zero code is the
      // command's own verdict. Same R19-17 spirit as the stderr work: free
      // information already in hand.
      const codeNum = code instanceof Error ? null : (code ?? null);
      const sig = signal ?? null;
      const base = sig
        ? `killed by ${sig}`
        : codeNum !== null && codeNum !== 0
          ? `exited before responding (exit code ${codeNum})`
          : "exited before responding";
      finish({ kind: "down", reason: withDetail(base) });
    });

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

    child.stdout?.on("data", (chunk) => {
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
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: MCP_CLIENT_CAPABILITIES,
        clientInfo: MCP_CLIENT_INFO,
      },
    });
  });
}

/**
 * The MCP client capabilities the discovery handshake declares (P13-LV-19).
 *
 * The old handshake advertised `capabilities: {}`, and a server that gates
 * tools on client capabilities then hid them: Viberr's Settings row said
 * "13 tools discovered" for the Everything server while both live runs
 * enumerated **15** from the same command. The number shown has to be the
 * number a run gets, so the probe declares the same capability set the SDK
 * clients do.
 */
const MCP_CLIENT_CAPABILITIES = {
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
};

const MCP_PROTOCOL_VERSION = "2025-06-18";

const MCP_CLIENT_INFO = { name: "viberr", version: "1.0.0" };

/**
 * Every JSON-RPC request the discovery handshake sends — its whole vocabulary,
 * shared by the stdio and HTTP paths. Not a general RPC client: anything else
 * would be a message no MCP server here is asked for.
 */
type McpHandshakeRequest =
  | {
      jsonrpc: "2.0";
      id: number;
      method: "initialize";
      params: {
        protocolVersion: string;
        capabilities: typeof MCP_CLIENT_CAPABILITIES;
        clientInfo: typeof MCP_CLIENT_INFO;
      };
    }
  | { jsonrpc: "2.0"; method: "notifications/initialized" }
  | { jsonrpc: "2.0"; id: number; method: "tools/list"; params: Record<string, never> };

/** The `tools/list` result envelope, read only for how many tools it listed. */
const mcpToolListSchema = z.object({ tools: z.array(z.unknown()) });

/**
 * One JSON-RPC message off an MCP endpoint, decoded at the wire into the only
 * two facts the handshake asks of it: whether it carried a `result` at all (an
 * `initialize` answered with an `error` — or with no result member — is not an
 * MCP server), and how many tools that result listed.
 *
 * Tolerant per FIELD, like the hand decode it replaces: a `result` that is not
 * a tool listing decodes to `tools: null` ("answered, but not with a tool
 * list") instead of failing the whole message.
 */
const mcpMessageSchema = z
  .object({ result: z.unknown().optional() })
  .transform((message) => ({
    // JSON never yields `undefined`, so this is exactly "the body has a
    // `result` member".
    answered: message.result !== undefined,
    tools: mcpToolListSchema.safeParse(message.result).data?.tools.length ?? null,
  }));

type McpMessage = z.infer<typeof mcpMessageSchema>;

/** The JSON-RPC message in one body/SSE frame, or null when it is not one. */
function parseMcpMessage(text: string): McpMessage | null {
  try {
    const parsed = mcpMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Reachability probe for an HTTP target. Kept for the "is anything listening"
 * question; the real health signal is {@link discoverHttpMcpTools}, which
 * proves the endpoint speaks MCP. stdio targets are spawned per run → skipped.
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


/**
 * Every name Viberr's own in-process tooling owns: `viberr` is the operator's
 * governance server, `viberr_agent` the specialist toolkit (and `viberr-agent`
 * the hyphen spelling a Codex run would see), `viberr_browser` the R19-19
 * browser server (`viberr-browser` likewise). `saveMcpServer` refuses them all,
 * but a row created before that guard — or written straight into the DB — is
 * still on disk, and the catalog only skipped the first. It would then be
 * offered in the picker while every resolver skipped it: a grant that resolves
 * to nothing, which is the silent-resource class this pass exists to close.
 * One predicate so the writer and the picker can never disagree again.
 */
export function isReservedMcpName(name: string): boolean {
  return (
    name === "viberr" ||
    name === "viberr_agent" ||
    name === "viberr-agent" ||
    name === "viberr_browser" ||
    name === "viberr-browser" ||
    // Ruling 99: the controller's in-process toolkit.
    name === "viberr_controller" ||
    name === "viberr-controller"
  );
}

/**
 * Real tool discovery over Streamable HTTP (P13-LV-10).
 *
 * The old HTTP health check treated ANY HTTP response as "reachable": pointing
 * a server at a URL that answers 400 to a GET — or at any live website —
 * produced a green dot and the word "reachable", and no tool count was ever
 * discovered, so an HTTP MCP could never show what it actually offers. This
 * runs the same JSON-RPC handshake the stdio path does: `initialize` →
 * `notifications/initialized` → `tools/list`, carrying the session id the
 * server hands back, and accepting either a JSON or an SSE-framed body.
 *
 * A credentialed server is probed WITH its credential (P13-KM-05), so a server
 * that works in a run doesn't report "unreachable" in Settings.
 */
export async function discoverHttpMcpTools(
  target: string,
  options: McpProbeOptions & { token?: string | null } = {},
): Promise<StdioDiscovery> {
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
  const timeoutMs = options.timeoutMs ?? 5000;
  const started = Date.now();
  let sessionId: string | null = null;

  const rpc = async (body: McpHandshakeRequest): Promise<Response> => {
    const headers = new Map([
      ["content-type", "application/json"],
      ["accept", "application/json, text/event-stream"],
      ["mcp-protocol-version", MCP_PROTOCOL_VERSION],
    ]);
    // Both are conditional: the session id only exists after `initialize`
    // answers with one, and an uncredentialed server is asked anonymously.
    if (sessionId) headers.set("mcp-session-id", sessionId);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    return fetchImpl(url.toString(), {
      method: "POST",
      headers: Object.fromEntries(headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  /** Body → the first JSON-RPC message, whether raw JSON or SSE-framed. */
  const readMessage = async (res: Response): Promise<McpMessage | null> => {
    const text = await res.text();
    if (!text.trim()) return null;
    const direct = parseMcpMessage(text);
    if (direct) return direct;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const parsed = parseMcpMessage(line.slice(5).trim());
      if (parsed) return parsed;
    }
    return null;
  };

  try {
    const initRes = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: MCP_CLIENT_CAPABILITIES,
        clientInfo: MCP_CLIENT_INFO,
      },
    });
    if (!initRes.ok) {
      return {
        kind: "down",
        reason:
          initRes.status === 401 || initRes.status === 403
            ? "authentication rejected"
            : `endpoint answered ${initRes.status} (not an MCP endpoint?)`,
      };
    }
    sessionId = initRes.headers.get("mcp-session-id");
    const initMsg = await readMessage(initRes);
    if (!initMsg?.answered) {
      return { kind: "down", reason: "responded, but not with MCP initialize" };
    }

    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listRes = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    if (!listRes.ok) {
      return { kind: "down", reason: `tools/list answered ${listRes.status}` };
    }
    const listMsg = await readMessage(listRes);
    const tools = listMsg?.tools ?? null;
    if (tools === null) {
      return { kind: "down", reason: "no tools in response" };
    }
    return { kind: "up", latencyMs: Date.now() - started, tools };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "connection timed out"
        : "connection refused";
    return { kind: "down", reason };
  }
}

export async function saveMcpServer(
  db: DatabaseSync,
  input: {
    id?: string | null;
    name: string;
    transport: string;
    target: string;
    cred: string;
    /** Explicit "remove the stored credential" intent (P13-KM-06). A blank
     *  `cred` still means "keep what is stored" — the UI never round-trips the
     *  sealed secret, so blank cannot mean "clear". */
    clearCred?: boolean;
  },
  actor: AuditActor,
  options: McpProbeOptions = {},
  ctx: OrgSeedContext = {},
): Promise<{ mcp: McpView; toast: string }> {
  const name = slugify(input.name);
  const target = input.target.trim();
  const transport = input.transport === "stdio" ? "stdio" : "HTTP";
  // F7-MCP1: the credential is SEALED at rest (AES-256-GCM secret-box) and never
  // stored or returned in plaintext. On EDIT a blank field keeps the existing
  // sealed value (the UI never round-trips the secret back), so a plain re-save
  // doesn't wipe the credential. A non-empty field replaces it.
  const rawCred = input.cred.trim();
  let cred: string | null;
  if (input.clearCred) {
    // P13-KM-06: a credential could never be REMOVED — blank meant "keep", so a
    // server repointed at a different target kept sending the old token forever
    // and the only way out was deleting and recreating the server.
    cred = null;
  } else if (rawCred) {
    // F20-7: refuse a credential under 8 characters at save. A short secret is
    // almost always a typo or a placeholder, and keeping it out of the row
    // entirely is the belt to the by-value-scrub brace (git-output-redact now
    // scrubs at ANY length) — the plaintext leak into `last_error` was live at
    // 5 chars. A sealed box (never round-tripped by the UI, but handled here) is
    // long by construction, so the floor only applies to fresh plaintext.
    if (!isSecretBox(rawCred) && rawCred.length < 8) {
      throw AppError.validation(
        "That credential is too short. Enter at least 8 characters, or leave it blank for no auth.",
      );
    }
    cred = isSecretBox(rawCred) ? rawCred : sealSecret(rawCred);
  } else if (input.id) {
    // SAFETY: `cred_ref` is a nullable TEXT column of `org_mcp_servers`
    // (0001_baseline.sql).
    const existing = db
      .prepare(`SELECT cred_ref FROM org_mcp_servers WHERE id = ?`)
      .get(input.id) as { cred_ref: string | null } | undefined;
    cred = existing?.cred_ref ?? null;
  } else {
    cred = null;
  }
  if (name.length < 2) throw AppError.validation("Give the server a name.");
  // P13-KM-12: `viberr` is the OPERATOR's in-process governance server and
  // `viberr_agent` is the specialist toolkit. A row under either name is
  // unusable — the resolvers skip the reserved name — and shadows differently
  // per backend, so refuse it at save instead of accepting a dead server.
  if (isReservedMcpName(name)) {
    throw AppError.validation(
      `"${name}" is reserved for Viberr's built-in agent tools. Pick another name.`,
    );
  }
  if (target.length < 4) {
    throw AppError.validation(
      transport === "stdio" ? "Enter the command." : "Enter the endpoint.",
    );
  }

  // SAFETY: `id` is the TEXT PRIMARY KEY of `org_mcp_servers`
  // (0001_baseline.sql), so a matching row hands back a string.
  const clash = db
    .prepare(`SELECT id FROM org_mcp_servers WHERE name = ? AND id != ?`)
    .get(name, input.id ?? "") as { id: string } | undefined;
  if (clash) throw AppError.conflict(`An MCP server named ${name} already exists.`);

  const now = new Date().toISOString();

  // BOTH transports now run the real MCP handshake and store a real tool count
  // (P13-LV-10): an HTTP endpoint used to be "reachable" on any HTTP response —
  // including a 400 — and never reported tools at all. The probe carries the
  // server's credential so a credentialed server isn't reported down (P13-KM-05).
  //
  // A9: a credential that cannot be OPENED is named in the toast. It used to
  // probe anonymously and blame the endpoint ("didn't answer as an MCP
  // server"), sending the operator to debug a server that was fine.
  const credOpened =
    cred && input.id
      ? safeOpenSecret(db, input.id, name, cred)
      : cred
        ? openedForNewRow(cred, name)
        : { token: null, unreadable: false };
  const plainCred = credOpened.token;
  const disc =
    transport === "stdio"
      ? await discoverStdioMcpTools(target, { ...options, token: plainCred })
      : await discoverHttpMcpTools(target, { ...options, token: plainCred });
  const checkedAt: string | null = now;
  const up = disc.kind === "up" ? 1 : 0;
  const tools = disc.kind === "up" ? disc.tools : null;
  // R19-17: a failure keeps its reason on the row; a success CLEARS it, so a
  // stale explanation can never sit under a green dot.
  const lastError = disc.kind === "up" ? null : disc.reason;
  // R19-18: a command that was still fetching gets a background install rather
  // than a red dot. Started AFTER the row is written, below, so the warm-up's
  // own `warming_since` write cannot be overwritten by this save.
  //
  // R20-4 (N20-2): the EVIDENCE path (`installing === true`) is always warmable.
  // The HEURISTIC path — the command printed nothing install-y, but it is an
  // npx/bunx-style runner and this row has never succeeded here — is warmable
  // too, but capped at ONE heuristic warm-up per row (the counter is bumped by
  // `startMcpWarmup({ heuristic })`), so a command that never works still
  // settles to `unreachable` instead of re-downloading forever.
  const priorRow = input.id ? getMcpServer(db, input.id) : null;
  const firstEver = !priorRow || priorRow.firstSuccessAt == null;
  const heuristicWarmable =
    disc.kind === "down" &&
    disc.installing !== true &&
    disc.firstRunInstaller === true &&
    firstEver &&
    (priorRow?.heuristicWarmups ?? 0) < 1;
  const warmable =
    disc.kind === "down" && (disc.installing === true || heuristicWarmable);
  const spawnNote = transport === "stdio" ? " · spawned per run" : "";
  const credNote = credOpened.unreadable
    ? " · its stored credential could not be read, so this check ran UNAUTHENTICATED and runs will not mount it"
    : "";
  const toast =
    (disc.kind === "up"
      ? `${name} saved: ${disc.tools} tool${disc.tools === 1 ? "" : "s"} discovered${spawnNote}`
      : transport === "stdio"
        // R19-17: the wrapper used to add "command didn't respond" in front of
        // a reason that now says what actually happened, giving
        // "didn't respond (exited before responding — …)". The reason speaks
        // for itself; the prefix only has to say the server was saved anyway.
        ? warmable
          ? `${name} saved. It is installing in the background; this page updates when it finishes`
          : `${name} saved, but it did not answer: ${disc.reason}`
        : `${name} saved, but the endpoint didn't answer as an MCP server (${disc.reason})`) +
    credNote;

  let id = input.id ?? null;
  if (id) {
    const existing = getMcpServer(db, id);
    if (!existing) throw AppError.notFound("No such MCP server.");
    // Both transports now carry a REAL discovered count (null when the probe
    // failed), so there is one write path and no stale count can survive an edit.
    db.prepare(
      `UPDATE org_mcp_servers
       SET name = ?, transport = ?, target = ?, cred_ref = ?,
           tools_count = ?, up = ?, last_checked_at = ?, last_error = ?,
           first_success_at = COALESCE(first_success_at, ?),
           updated_at = ?
       WHERE id = ?`,
      // R20-4: stamp the first-ever success idempotently — COALESCE keeps an
      // earlier stamp, and a `down` write passes NULL (a no-op).
    ).run(
      name, transport, target, cred, tools, up, checkedAt, lastError,
      up === 1 ? now : null, now, id,
    );
    // P14-KM-01: an MCP grant is a NAME reference, and this was the one rename
    // leg that never rewrote it — KB and skill renames did, every delete dropped
    // its grants, but renaming a server left each profile pointing at a name the
    // registry no longer held. Live-proven: `vm-memory` → `vm-graph-memory` left
    // both scout profiles orphaned, and the next run advertised the server in
    // its prompt while exposing zero tools (LV-09).
    if (existing.name !== name) {
      await updateResourceReferences("mcps", existing.name, name, ctx.dataRoot);
    }
    recordAudit(db, {
      action: "org.mcp.updated",
      actor,
      subjectKind: "org_mcp",
      subjectId: id,
      details: { name, transport, renamed: existing.name !== name },
    });
  } else {
    id = newId("mcp");
    db.prepare(
      `INSERT INTO org_mcp_servers
         (id, name, transport, target, cred_ref, tools_count, up,
          last_checked_at, last_error, first_success_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // R20-4: a brand-new row records its first success immediately when the
      // save probe already answered up; otherwise NULL (never worked here yet).
    ).run(
      id, name, transport, target, cred, tools, up, checkedAt, lastError,
      up === 1 ? now : null, now, now,
    );
    recordAudit(db, {
      action: "org.mcp.added",
      actor,
      subjectKind: "org_mcp",
      subjectId: id,
      details: { name, transport },
    });
  }

  if (warmable && transport === "stdio") {
    startMcpWarmup(
      db,
      { id, name, target, token: plainCred },
      // R20-4: only the HEURISTIC arm bumps the capped counter; the evidence
      // arm (`installing === true`) is not a guess and is never capped.
      { ...options, heuristic: heuristicWarmable },
    );
  }
  return { mcp: getMcpServer(db, id)!, toast };
}

export async function testMcpServer(
  db: DatabaseSync,
  id: string,
  options: McpProbeOptions = {},
): Promise<{ mcp: McpView; toast: string }> {
  const existing = getMcpServer(db, id);
  if (!existing) throw AppError.notFound("No such MCP server.");
  const now = new Date().toISOString();

  // BOTH transports run the real MCP handshake (P13-LV-10) with the server's
  // credential when it has one (P13-KM-05), so "healthy" means "answered as an
  // MCP server", not "something replied to a GET".
  // SAFETY: `cred_ref` is a nullable TEXT column of `org_mcp_servers`
  // (0001_baseline.sql).
  const sealed = db
    .prepare(`SELECT cred_ref FROM org_mcp_servers WHERE id = ?`)
    .get(id) as { cred_ref: string | null } | undefined;
  // A9: an unopenable credential is REPORTED, not silently dropped — this probe
  // must never render a green dot earned without the auth a run would use, nor
  // a red one blamed on the endpoint.
  const opened = sealed?.cred_ref
    ? safeOpenSecret(db, id, existing.name, sealed.cred_ref)
    : { token: null, unreadable: false };
  const token = opened.token;
  const credNote = opened.unreadable
    ? " · WARNING: its stored credential could not be read, so this check ran UNAUTHENTICATED and runs will not mount it"
    : "";
  const disc =
    existing.transport === "stdio"
      ? await discoverStdioMcpTools(existing.target, { ...options, token })
      : await discoverHttpMcpTools(existing.target, { ...options, token });

  if (disc.kind === "up") {
    db.prepare(
      `UPDATE org_mcp_servers
       SET up = 1, tools_count = ?, last_checked_at = ?, last_error = NULL,
           first_success_at = COALESCE(first_success_at, ?), updated_at = ?
       WHERE id = ?`,
      // R20-4: a passing retest is a first-ever success too — stamp it so a
      // later cold probe of a working server is never mistaken for a first run.
    ).run(disc.tools, now, now, now, id);
    const fresh = getMcpServer(db, id)!;
    return {
      mcp: fresh,
      toast: `${fresh.name} healthy: ${disc.tools} tool${disc.tools === 1 ? "" : "s"} · ${disc.latencyMs}ms${credNote}`,
    };
  }
  db.prepare(
    `UPDATE org_mcp_servers
     SET up = 0, tools_count = NULL, last_checked_at = ?, last_error = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, disc.reason, now, id);
  // R19-18: retesting a command that is mid first-run install hands it to the
  // background runner instead of failing it again — retesting used to restart
  // the same download and kill it at the same point, forever.
  //
  // R20-4 (N20-2): the same heuristic arm as `saveMcpServer` — a silent
  // npx/bunx-style command that has never worked here gets ONE capped warm-up,
  // read off the row we loaded before the `down` write (which touches neither
  // `firstSuccessAt` nor `heuristicWarmups`).
  const firstEver = existing.firstSuccessAt == null;
  const heuristicWarmable =
    disc.kind === "down" &&
    disc.installing !== true &&
    disc.firstRunInstaller === true &&
    firstEver &&
    (existing.heuristicWarmups ?? 0) < 1;
  if (
    existing.transport === "stdio" &&
    disc.kind === "down" &&
    (disc.installing === true || heuristicWarmable)
  ) {
    startMcpWarmup(
      db,
      { id, name: existing.name, target: existing.target, token },
      { ...options, heuristic: heuristicWarmable },
    );
    const warming = getMcpServer(db, id)!;
    return {
      mcp: warming,
      toast: `${warming.name} is installing in the background; this page updates when it finishes${credNote}`,
    };
  }
  const fresh = getMcpServer(db, id)!;
  return {
    mcp: fresh,
    toast: `${fresh.name} unreachable: ${disc.reason}${credNote}`,
  };
}

export async function deleteMcpServer(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): Promise<{ toast: string }> {
  const existing = getMcpServer(db, id);
  if (!existing) throw AppError.notFound("No such MCP server.");
  db.prepare(`DELETE FROM org_mcp_servers WHERE id = ?`).run(id);
  // P13-KM-07: an MCP grant is a name reference like a KB/skill one.
  await updateResourceReferences("mcps", existing.name, null, ctx.dataRoot);
  recordAudit(db, {
    action: "org.mcp.removed",
    actor,
    subjectKind: "org_mcp",
    subjectId: id,
    details: { name: existing.name },
  });
  return { toast: `${existing.name} removed` };
}

/**
 * F20-10: flip a registry row to unreachable from a RUN that could not mount it.
 *
 * MCP health used to be learned ONLY from an explicit Add/Retest — so a server
 * that dies at run-spawn (a half-installed npx tree, a crashed binary)
 * contributed zero tools to the run while its row kept reading "up · N tools"
 * from a probe hours old, and no surface said otherwise. This lets the run-mount
 * path (`verifyStdioMcpMountsForRun`) record what it actually saw, in the same
 * shape a failed `testMcpServer` writes, keyed by NAME (a run holds the grant
 * name, not the row id). A no-op on an unknown name. `first_success_at` /
 * `heuristic_warmups` are deliberately untouched — a mount failure is not a save.
 */
export function markMcpServerUnreachableFromRun(
  db: DatabaseSync,
  name: string,
  reason: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE org_mcp_servers
       SET up = 0, tools_count = NULL, last_checked_at = ?, last_error = ?,
           updated_at = ?
     WHERE name = ?`,
  ).run(now, reason, now, name);
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

type SkillRow = {
  id: string;
  name: string;
  summary: string;
  updated_at: string;
};

/**
 * The editor reads the SAME contained path the injector does.
 *
 * A5-followup/pass-16: this reader used to build the path itself and
 * `readFileSync` it, which dereferences. So a symlinked `SKILL.md` (or skill
 * FOLDER) rendered the link TARGET's content in the org-settings editor as if it
 * were the skill — text no run would ever see, because `readSkillBodyDetailed`
 * refuses links. Two answers to "what is this skill?" is the silent-resource
 * failure this pass exists to close, and here it also pointed the editor's own
 * `writeFileSync` at a file outside the store (see `assertSkillBodyWritable`).
 */
function readSkillBody(name: string, ctx: OrgSeedContext): string {
  let resolved: ReturnType<typeof resolveContainedSkillFile>;
  try {
    resolved = resolveContainedSkillFile(name, ctx.dataRoot);
  } catch {
    return ""; // traversal-shaped name — `skillDirPath` refused it
  }
  if ("reason" in resolved) return "";
  try {
    const raw = readFileSync(resolved.file);
    return raw.subarray(0, SKILL_BODY_MAX_BYTES).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Refuse to SAVE over a `SKILL.md` that leaves the store.
 *
 * `writeFileSync` follows a symlink, so an uncontained SKILL.md turned the
 * skill editor into a write-anywhere primitive: save once and the link's target
 * — any file the server process can write — is replaced with the editor's
 * textarea. The read half above already blanks the body for these skills, which
 * would make an unguarded save even worse: it would blank the target. Same rule
 * as the injector, stated to the human instead of logged.
 */
function assertSkillBodyWritable(name: string, ctx: OrgSeedContext): void {
  const dir = skillDirPath(name, ctx.dataRoot);
  const uncontained = () =>
    AppError.validation(
      `SKILL.md for ${name} is a symlink (or sits under one), so it points outside the skills store. Viberr never reads or writes through a link out of the store. Replace it with a real file to edit it here.`,
    );
  const dirStat = lstatOr(dir);
  if (dirStat?.isSymbolicLink()) throw uncontained();
  // `lstat`, not `existsSync`: a link to a target that does not exist yet is
  // still a link, and the write would CREATE the target outside the store.
  if (!lstatOr(path.join(dir, "SKILL.md"))) return;
  if ("reason" in resolveContainedSkillFile(name, ctx.dataRoot)) throw uncontained();
}

function lstatOr(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
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
 * `description:` when present, else a plain placeholder. Handles both the
 * inline form (`description: one line`) and a YAML block scalar
 * (`description: |` / `>` — common in imported skills), whose summary is the
 * first non-empty indented line; the old inline-only regex rendered a literal
 * `|` as the card summary. */
function deriveSkillSummary(name: string, ctx: OrgSeedContext): string {
  const body = readSkillBody(name, ctx);
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const desc = fm[1]!.match(/^description:[ \t]*(.*)$/m);
    if (desc) {
      const inline = desc[1]!.trim().replace(/^["']|["']$/g, "");
      if (inline && !/^[|>][+-]?$/.test(inline)) return inline;
      const after = fm[1]!.slice(fm[1]!.indexOf(desc[0]!) + desc[0]!.length);
      const firstLine = after
        .split(/\r?\n/)
        .find((l) => /^[ \t]+\S/.test(l));
      if (firstLine) return firstLine.trim();
    }
  }
  return "On-disk skill. Add a summary to describe it";
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
  db: DatabaseSync,
  ctx: OrgSeedContext = {},
): SkillView[] {
  // SAFETY: `SKILL_SQL` selects exactly the four `org_skills` columns
  // `SkillRow` declares, every one NOT NULL TEXT (0001_baseline.sql).
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
  db: DatabaseSync,
  id: string,
  ctx: OrgSeedContext = {},
): SkillView | null {
  // SAFETY: same `SKILL_SQL` column guarantee as `listSkills`.
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

/** Audit payload for a skill create (see the write below for both flags). */
type SkillCreateAudit = {
  name: string;
  adopted?: boolean;
  filesMode?: boolean;
};

export async function saveSkill(
  db: DatabaseSync,
  input: {
    id?: string | null;
    name: string;
    summary: string;
    body: string;
    /** Explicit "blank the SKILL.md" intent. Without it, an EMPTY submitted
     * body on an EXISTING skill keeps the on-disk content (E4: the modal
     * round-trips a possibly-truncated read — empty must never blank). */
    clearBody?: boolean;
    /** "files" (NEW creates only): the unified New-skill flow — register the
     * skill by name alone and hand off to the store browser for content
     * (upload / GitHub import / New document). No SKILL.md is written and the
     * summary may be empty; both arrive with the files. */
    contentMode?: "write" | "files";
  },
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): Promise<{ skill: SkillView; toast: string }> {
  const name = slugify(input.name);
  const summary = input.summary.trim();
  const filesMode = input.contentMode === "files" && !input.id;
  if (name.length < 2) throw AppError.validation("Give the skill a name.");
  if (!filesMode && summary.length < 4)
    throw AppError.validation("Add a one-line summary.");
  const now = new Date().toISOString();

  // Resolve the edit subject: a metadata row (by id) OR a disk-only folder
  // (synthetic id). A brand-new create has neither.
  // SAFETY: same `SKILL_SQL` column guarantee as `listSkills`.
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
    throw AppError.conflict(`A skill folder ${name}/ already exists.`);
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
      `SKILL.md for ${oldName} is larger than the 256 KB editor limit, so the editor only loaded a truncated copy. Saving would overwrite the full file with that truncated text. Edit SKILL.md on disk (or re-upload it) instead.`,
    );
  }

  // A5-followup: a save must never write THROUGH a link out of the store. This
  // runs BEFORE the rename below, which would otherwise move the linked folder
  // first and report the refusal against a path that no longer exists.
  if (oldName && !keepExistingBody && !filesMode) {
    assertSkillBodyWritable(oldName, ctx);
  }

  if (oldName && name !== oldName) {
    const clash = db
      .prepare(`SELECT id FROM org_skills WHERE name = ? AND id != ?`)
      .get(name, existing?.id ?? "");
    const oldAbs = skillDirPath(oldName, ctx.dataRoot);
    const newAbs = skillDirPath(name, ctx.dataRoot);
    if (clash || existsSync(newAbs)) {
      throw AppError.conflict(`A skill folder ${name}/ already exists.`);
    }
    if (existsSync(oldAbs)) renameSync(oldAbs, newAbs);
    // P13-KM-07: keep every grant pointing at the renamed skill.
    await updateResourceReferences("skills", oldName, name, ctx.dataRoot);
  }

  const dir = skillDirPath(name, ctx.dataRoot);
  mkdirSync(dir, { recursive: true });
  // files-mode create: the folder is the deliverable — SKILL.md arrives via
  // the store browser (upload / GitHub import / New document), so writing an
  // empty one here would only trigger the overwrite-confirm on that upload.
  if (!keepExistingBody && !filesMode) {
    writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  const updatedToast = keepExistingBody
    ? `Skill ${name} updated. Existing SKILL.md kept`
    : `Skill ${name} updated. SKILL.md rewritten`;

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
  if (clash) throw AppError.conflict(`A skill folder ${name}/ already exists.`);
  const id = newId("sk");
  db.prepare(
    `INSERT INTO org_skills (id, name, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, summary, now, now);
  // Each key is present only when it is true of THIS create: `adopted` when it
  // took over a folder already on disk, `filesMode` when no SKILL.md was written.
  const details: SkillCreateAudit = { name };
  if (oldName) details.adopted = true;
  if (filesMode) details.filesMode = true;
  recordAudit(db, {
    action: oldName ? "org.skill.updated" : "org.skill.created",
    actor,
    subjectKind: "org_skill",
    subjectId: id,
    details,
  });
  return {
    skill: getSkill(db, id, ctx)!,
    toast: oldName
      ? updatedToast
      : filesMode
        ? `Skill ${name} created. Add SKILL.md and supporting files`
        : `Skill ${name} created. SKILL.md written`,
  };
}

export async function deleteSkill(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
  ctx: OrgSeedContext = {},
): Promise<{ toast: string }> {
  const skill = getSkill(db, id, ctx);
  if (!skill) throw AppError.notFound("No such skill.");
  rmSync(skillDirPath(skill.name, ctx.dataRoot), {
    recursive: true,
    force: true,
  });
  // P13-KM-07: drop the dangling grants with the folder.
  await updateResourceReferences("skills", skill.name, null, ctx.dataRoot);
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
  db: DatabaseSync,
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
