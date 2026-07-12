import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import { createGithubClient } from "~/server/github/github-client.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import { getDefaultConnectionToken } from "./connections.server";

/**
 * StoreBrowser server layer (kb-browser spec §5): every operation is a
 * REAL filesystem mutation under the resolved store folder
 * (${DATA_ROOT}/kb/<dir>/ or /skills/<name>/) followed by a re-scan — the
 * def-note's "this is the real folder on disk" is literally true.
 *
 * Safety (server-enforced, never trusts the client): path segments are
 * sanitized (no `..`, no absolute paths, backslashes → "-"), dot-prefixed
 * segments are skipped (`.DS_Store`, `.git/…`), a file can never clobber a
 * directory, and every resolved path is verified to stay under the root.
 *
 * GitHub import is a real snapshot fetch (git trees API) through the org's
 * DEFAULT connection when it has a validated token — otherwise the typed
 * "no connection" state (spec §8.7 resolved: default connection, no public
 * unauthenticated fallback).
 */

export interface StoreTarget {
  kind: "kb" | "skill";
  /** Resource row id. */
  id: string;
  /** Display name (toast copy). */
  name: string;
  /** Absolute folder on disk. */
  rootAbs: string;
  /** Display root, e.g. "store://kb/api-contracts" (no trailing slash). */
  rootUri: string;
}

// ------------------------------------------------------------------ scan

/** Scans a store folder → StoreNode[] (dirs first, alphabetical, dotfiles
 * skipped). Missing folder → empty tree. */
export function scanStoreTree(absDir: string): StoreNode[] {
  if (!existsSync(absDir)) return [];
  const entries = readdirSync(absDir, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith("."),
  );
  const dirs = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
  const nodes: StoreNode[] = [];
  for (const d of dirs) {
    nodes.push({
      type: "dir",
      name: d.name,
      children: scanStoreTree(path.join(absDir, d.name)),
    });
  }
  for (const f of files) {
    const st = statSync(path.join(absDir, f.name));
    nodes.push({
      type: "file",
      name: f.name,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  return nodes;
}

// ------------------------------------------------------------- sanitizing

/** One path segment: trimmed, backslashes → "-", no traversal. Returns
 * null for segments that must be dropped entirely (empty / dot-prefixed). */
function cleanSegment(segment: string): string | null {
  const s = segment.trim().replace(/\\/g, "-");
  if (!s || s === "." || s === "..") return null;
  if (s.startsWith(".")) return null; // dotfile skip, server-enforced
  return s.slice(0, 200);
}

/** Sanitizes a directory path (array of segments). Throws on traversal. */
export function sanitizeDirPath(segments: string[]): string[] {
  const out: string[] = [];
  for (const raw of segments) {
    if (raw.includes("..")) {
      throw AppError.validation("Invalid folder path.");
    }
    const s = cleanSegment(raw);
    if (s) out.push(s);
  }
  return out;
}

/** Sanitizes an uploaded file's relative path → segments, or null when the
 * file must be skipped (dotfile anywhere in the path). */
function cleanRelPath(relPath: string): string[] | null {
  const rawParts = relPath.split("/").filter(Boolean);
  if (rawParts.length === 0) return null;
  const parts: string[] = [];
  for (const raw of rawParts) {
    if (raw.includes("..")) return null;
    const s = cleanSegment(raw);
    if (!s) return null; // dot segment → whole file skipped
    parts.push(s);
  }
  return parts;
}

function assertInsideRoot(rootAbs: string, absPath: string): void {
  const rel = path.relative(rootAbs, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw AppError.validation("Invalid store path.");
  }
}

/**
 * Bumps the owning resource's freshness column (kb.last_indexed_at /
 * skill.updated_at) — the consumer-side "just now" of the mock.
 *
 * E6: a DISK-ONLY resource carries a synthetic `disk:<name>` id with no
 * metadata row, so the plain UPDATE used to match zero rows and freshness
 * never advanced. A store mutation now ADOPTS such a resource into a real
 * metadata row first (same as editing/re-indexing it would), then touches.
 */
function touchResource(db: Database.Database, target: StoreTarget): void {
  const now = new Date().toISOString();
  if (target.kind === "kb") {
    const dir = path.basename(target.rootAbs);
    const updated = db
      .prepare(
        `UPDATE org_knowledge_bases SET last_indexed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, target.id);
    if (updated.changes === 0) {
      // Adopt-on-touch. Key on dir (UNIQUE): a row may already exist under a
      // different id than the synthetic one the target carries.
      const adopted = db
        .prepare(
          `UPDATE org_knowledge_bases SET last_indexed_at = ?, updated_at = ?
           WHERE dir = ?`,
        )
        .run(now, now, dir);
      if (adopted.changes === 0) {
        db.prepare(
          `INSERT INTO org_knowledge_bases
             (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
           VALUES (?, ?, ?, 'on change', ?, ?, ?)`,
        ).run(newId("kb"), target.name, dir, now, now, now);
        logger.info("adopted disk-only knowledge base on store mutation", {
          dir,
        });
      }
    }
  } else {
    const name = path.basename(target.rootAbs);
    const updated = db
      .prepare(`UPDATE org_skills SET updated_at = ? WHERE id = ?`)
      .run(now, target.id);
    if (updated.changes === 0) {
      const adopted = db
        .prepare(`UPDATE org_skills SET updated_at = ? WHERE name = ?`)
        .run(now, name);
      if (adopted.changes === 0) {
        db.prepare(
          `INSERT INTO org_skills (id, name, summary, created_at, updated_at)
           VALUES (?, ?, '', ?, ?)`,
        ).run(newId("sk"), name, now, now);
        logger.info("adopted disk-only skill on store mutation", { name });
      }
    }
  }
}

// ---------------------------------------------------------------- uploads

export interface UploadFileInput {
  /** Relative path (may contain "/" for folder uploads). */
  relPath: string;
  data: Buffer;
}

export interface UploadResult {
  added: number;
  /** Top-level folder names the upload introduced (client auto-expands). */
  topLevelDirs: string[];
  /** kind=skill only: a root-level SKILL.md landed (capture toast). */
  capturedSkillMd: boolean;
}

/**
 * Writes uploaded files under `dirPath` (structure-preserving). Pre-checks
 * every path first — a conflict writes NOTHING. Same-name files are
 * replaced (mock merge semantics); a file never clobbers a directory.
 */
export function writeStoreFiles(
  db: Database.Database,
  target: StoreTarget,
  dirPath: string[],
  files: UploadFileInput[],
  actor: AuditActor,
): UploadResult {
  const base = sanitizeDirPath(dirPath);
  const cleaned = files
    .map((f) => ({ parts: cleanRelPath(f.relPath), data: f.data }))
    .filter((f): f is { parts: string[]; data: Buffer } => f.parts !== null);

  // Pre-flight: refuse type collisions before any write.
  for (const file of cleaned) {
    const abs = path.join(target.rootAbs, ...base, ...file.parts);
    assertInsideRoot(target.rootAbs, abs);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw AppError.validation(
        `A folder named “${file.parts[file.parts.length - 1]}” already exists there — rename the file first.`,
      );
    }
    // Every intermediate segment must not be an existing FILE.
    let cursor = path.join(target.rootAbs, ...base);
    for (const seg of file.parts.slice(0, -1)) {
      cursor = path.join(cursor, seg);
      if (existsSync(cursor) && statSync(cursor).isFile()) {
        throw AppError.validation(
          `A file named “${seg}” already exists here`,
        );
      }
    }
  }

  const topLevelDirs = new Set<string>();
  let capturedSkillMd = false;
  for (const file of cleaned) {
    const abs = path.join(target.rootAbs, ...base, ...file.parts);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, file.data);
    if (file.parts.length > 1) topLevelDirs.add(file.parts[0]!);
    if (
      target.kind === "skill" &&
      base.length === 0 &&
      file.parts.length === 1 &&
      file.parts[0] === "SKILL.md"
    ) {
      capturedSkillMd = true;
    }
  }

  if (cleaned.length > 0) {
    touchResource(db, target);
    recordAudit(db, {
      action: "org.store.files_added",
      actor,
      subjectKind: `org_${target.kind}`,
      subjectId: target.id,
      details: { path: base.join("/"), count: cleaned.length },
    });
  }
  return {
    added: cleaned.length,
    topLevelDirs: [...topLevelDirs],
    capturedSkillMd,
  };
}

// ----------------------------------------------------------------- mkdir

export interface MkdirResult {
  /** Created (or reused) chain, relative to the store root. */
  createdPath: string[];
}

/** mkdir -p semantics; "a/b/c" creates the chain; a FILE occupying a
 * segment refuses with the mock's exact message. */
export function createStoreFolder(
  db: Database.Database,
  target: StoreTarget,
  dirPath: string[],
  name: string,
  actor: AuditActor,
): MkdirResult {
  const base = sanitizeDirPath(dirPath);
  const segs = name
    .split("/")
    .flatMap((s) => {
      const cleaned = s.trim().replace(/\\/g, "-");
      return cleaned ? [cleaned] : [];
    })
    .map((s) => {
      if (s.includes("..")) throw AppError.validation("Invalid folder name.");
      return s.slice(0, 200);
    });
  if (segs.length === 0) return { createdPath: base };

  let cursor = path.join(target.rootAbs, ...base);
  assertInsideRoot(target.rootAbs, cursor);
  for (const seg of segs) {
    cursor = path.join(cursor, seg);
    assertInsideRoot(target.rootAbs, cursor);
    if (existsSync(cursor) && statSync(cursor).isFile()) {
      throw AppError.validation(`A file named “${seg}” already exists here`);
    }
  }
  mkdirSync(path.join(target.rootAbs, ...base, ...segs), { recursive: true });
  touchResource(db, target);
  recordAudit(db, {
    action: "org.store.folder_created",
    actor,
    subjectKind: `org_${target.kind}`,
    subjectId: target.id,
    details: { path: [...base, ...segs].join("/") },
  });
  return { createdPath: [...base, ...segs] };
}

// ---------------------------------------------------------------- delete

export interface DeleteNodeResult {
  name: string;
  wasDir: boolean;
  filesRemoved: number;
}

/** Deletes a file or folder (recursive) at the store-relative path. */
export function deleteStoreNode(
  db: Database.Database,
  target: StoreTarget,
  nodePath: string[],
  actor: AuditActor,
): DeleteNodeResult {
  const parts = sanitizeDirPath(nodePath);
  if (parts.length === 0) {
    throw AppError.validation("Cannot delete the store root.");
  }
  const abs = path.join(target.rootAbs, ...parts);
  assertInsideRoot(target.rootAbs, abs);
  if (!existsSync(abs)) {
    throw AppError.notFound("That file or folder no longer exists.");
  }
  const wasDir = statSync(abs).isDirectory();
  const filesRemoved = wasDir ? countKbFiles(scanStoreTree(abs)) : 1;
  rmSync(abs, { recursive: true, force: true });
  touchResource(db, target);
  recordAudit(db, {
    action: wasDir ? "org.store.folder_deleted" : "org.store.file_deleted",
    actor,
    subjectKind: `org_${target.kind}`,
    subjectId: target.id,
    details: { path: parts.join("/"), filesRemoved },
  });
  return { name: parts[parts.length - 1]!, wasDir, filesRemoved };
}

// ---------------------------------------------------------- GitHub import

/** Mock URL contract (§4.3) + a branch capture for real fetching. */
export const GITHUB_IMPORT_URL_RE =
  /github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([\w.-]+)\/?(.*))?/;

export const GITHUB_IMPORT_URL_ERROR =
  "Paste a GitHub link — a repo, or a folder like github.com/owner/repo/tree/main/docs.";

const IMPORT_MAX_FILES = 100;
const IMPORT_MAX_BLOB_BYTES = 1024 * 1024;

export type GithubImportResult =
  | {
      status: "imported";
      folder: string;
      fileCount: number;
      /** Blobs that were selected but could not be fetched/written (E5) —
       * a partial import is reported honestly instead of as a clean run. */
      skipped: number;
      source: string;
      truncated: boolean;
      toast: string;
    }
  | { status: "invalid_url"; message: string }
  | { status: "no_connection"; message: string }
  | { status: "failed"; message: string };

interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export async function importGithubSnapshot(
  db: Database.Database,
  target: StoreTarget,
  url: string,
  actor: AuditActor,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GithubImportResult> {
  const m = url.trim().match(GITHUB_IMPORT_URL_RE);
  if (!m) return { status: "invalid_url", message: GITHUB_IMPORT_URL_ERROR };
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/, "");
  let branch = m[3] ?? null;
  const subPath = (m[4] ?? "").replace(/\/+$/, "");

  // Real import needs a connection with a validated token (the DEFAULT
  // one) — otherwise the honest "needs a connection" state.
  const tokenInfo = getDefaultConnectionToken(db);
  if (!tokenInfo) {
    return {
      status: "no_connection",
      message:
        "No GitHub connection with a validated token — add one under GitHub connections first.",
    };
  }
  const client = createGithubClient({
    token: tokenInfo.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  if (!branch) {
    const info = await client.request<{ default_branch?: string }>(
      "GET",
      `/repos/${owner}/${repo}`,
    );
    if (!info.ok) {
      return {
        status: "failed",
        message:
          info.kind === "http" && info.status === 404
            ? `The connection can't see ${owner}/${repo} — repository not found.`
            : `GitHub is unreachable — nothing was imported.`,
      };
    }
    branch = info.data.default_branch ?? "main";
  }

  const treeRes = await client.request<{
    tree?: GitTreeEntry[];
    truncated?: boolean;
  }>("GET", `/repos/${owner}/${repo}/git/trees/${branch}`, {
    searchParams: { recursive: "1" },
  });
  if (!treeRes.ok) {
    return {
      status: "failed",
      message:
        treeRes.kind === "http" && treeRes.status === 404
          ? `Branch or path not found on ${owner}/${repo}.`
          : `GitHub refused the tree listing — nothing was imported.`,
    };
  }

  const prefix = subPath ? `${subPath}/` : "";
  const blobs = (treeRes.data.tree ?? []).filter((e) => {
    if (e.type !== "blob") return false;
    if (subPath && !(e.path === subPath || e.path.startsWith(prefix)))
      return false;
    const rel = subPath ? e.path.slice(prefix.length) || e.path : e.path;
    if (rel.split("/").some((seg) => seg.startsWith("."))) return false;
    if ((e.size ?? 0) > IMPORT_MAX_BLOB_BYTES) return false;
    return true;
  });
  if (blobs.length === 0) {
    return {
      status: "failed",
      message: "No importable files found at that path.",
    };
  }
  const truncated =
    Boolean(treeRes.data.truncated) || blobs.length > IMPORT_MAX_FILES;
  const selected = blobs.slice(0, IMPORT_MAX_FILES);

  // Collision-suffixed root folder named after the last path segment (or
  // the repo) — mock semantics, real directory.
  const baseName =
    (subPath ? subPath.split("/").filter(Boolean).pop() : repo) || repo;
  let folder = baseName;
  let i = 2;
  while (existsSync(path.join(target.rootAbs, folder))) {
    folder = `${baseName}-${i++}`;
  }

  const writeResults = await Promise.all(
    selected.map(async (blob) => {
      const rel = subPath ? blob.path.slice(prefix.length) : blob.path;
      const parts = cleanRelPath(rel);
      if (!parts) return 0;
      const blobRes = await client.request<{
        content?: string;
        encoding?: string;
      }>("GET", `/repos/${owner}/${repo}/git/blobs/${blob.sha}`);
      if (!blobRes.ok) return 0;
      const content = blobRes.data.content ?? "";
      const data =
        blobRes.data.encoding === "base64"
          ? Buffer.from(content.replace(/\n/g, ""), "base64")
          : Buffer.from(content, "utf8");
      const abs = path.join(target.rootAbs, folder, ...parts);
      assertInsideRoot(target.rootAbs, abs);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      return 1;
    }),
  );
  const written = writeResults.reduce((sum: number, n) => sum + n, 0);
  if (written === 0) {
    return {
      status: "failed",
      message: "GitHub refused the file contents — nothing was imported.",
    };
  }
  // E5: per-blob failures (refused blob fetch, unwritable path) used to sum
  // silently into the success toast — count and surface them instead.
  const skipped = selected.length - written;

  touchResource(db, target);
  const source = `${owner}/${repo}${subPath ? `/${subPath}` : ""}`;
  recordAudit(db, {
    action: "org.store.github_import",
    actor,
    subjectKind: `org_${target.kind}`,
    subjectId: target.id,
    details: { source, branch, folder, fileCount: written, skipped, truncated },
  });
  const suffix = [
    ...(truncated ? [" (truncated)"] : []),
    ...(skipped > 0
      ? [` — ${skipped} file${skipped === 1 ? "" : "s"} skipped (fetch failed)`]
      : []),
  ].join("");
  return {
    status: "imported",
    folder,
    fileCount: written,
    skipped,
    source,
    truncated,
    toast: `${written} file${written === 1 ? "" : "s"} imported from ${source} — snapshot, not a live sync${suffix}`,
  };
}
