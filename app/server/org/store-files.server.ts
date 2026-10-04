import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
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
  type AuditDetails,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  createGithubClient,
  type GithubClientOptions,
} from "~/server/github/github-client.server";
// C5-followup: the editor's own copy of this list is gone. What Viberr will
// author, list as editable and inject is now ONE set — three hand-maintained
// copies is how `.json`/`.yaml` came to be authorable but never injectable.
import {
  STORE_TEXT_EXTENSIONS,
  STORE_TEXT_EXTENSION_LIST,
} from "~/shared/text/store-extensions";
import { countLabel } from "~/shared/text/plural";
import { logger } from "~/server/logging/logger.server";
import { assertSkillBodyWellFormed } from "~/server/files/skill-body.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  getDefaultConnectionTokenFresh,
  type FreshnessOptions,
} from "./connections.server";

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

/**
 * Scans a store folder → StoreNode[] (dirs first, alphabetical, dotfiles
 * skipped). Missing folder → empty tree.
 *
 * CONTAINMENT (C5/pass-16). `readdirSync(…, { withFileTypes: true })` reports
 * the directory ENTRY type — it does not dereference — so a symlink is neither
 * `isDirectory()` nor `isFile()` and drops out of both lists. That already
 * matched `collectKbDocs`, but only by accident of the Dirent API: the
 * `isSymbolicLink()` filter below states the rule so a future refactor to
 * `readdirSync(dir)` + `statSync` (which DOES dereference, and which
 * `subDirNames` was doing until this pass) cannot quietly reintroduce a browser
 * that promises content no run receives — or, worse, serves a host file through
 * the in-app reader. `statSync` further down is reached only for entries the
 * Dirent already proved are real files.
 *
 * The depth cap mirrors `collectKbDocs`: symlinks cannot make a cycle here, but
 * a pathological upload should not be able to blow the stack either.
 */
const MAX_STORE_SCAN_DEPTH = 32;

export function scanStoreTree(absDir: string, depth = 0): StoreNode[] {
  if (depth > MAX_STORE_SCAN_DEPTH) return [];
  if (!existsSync(absDir)) return [];
  const entries = readdirSync(absDir, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith(".") && !e.isSymbolicLink(),
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
      children: scanStoreTree(path.join(absDir, d.name), depth + 1),
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
function sanitizeDirPath(segments: string[]): string[] {
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
  // P14-RV-02: the check above is LEXICAL — it proves the path string sits under
  // the root, not that the file does. A symlink inside the store (the store is a
  // real folder users manage outside the app, and uploads/imports/agents all
  // write there) points wherever it likes: a link named `notes.md` served an
  // arbitrary host file through the in-app reader, and a write through one would
  // have clobbered the link's target. The KB reader has refused to follow
  // symlinks since F9 (`readKbIndexDetailed`, `kb-injection.server.ts`) — every
  // store path now agrees.
  // Resolved with `realpathSync` so an intermediate symlinked DIRECTORY is
  // caught too, and only on parts that exist (creates resolve their parent).
  const existing = existsSync(absPath) ? absPath : path.dirname(absPath);
  if (!existsSync(existing)) return; // nothing on disk yet — nothing to resolve
  const realRoot = realpathSync(rootAbs);
  const realPath = realpathSync(existing);
  const realRel = path.relative(realRoot, realPath);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw AppError.validation(
      "That path leaves the store folder. Viberr does not follow links out of it.",
    );
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
function touchResource(db: DatabaseSync, target: StoreTarget): void {
  const now = new Date().toISOString();
  if (target.kind === "kb") {
    const dir = path.basename(target.rootAbs);
    // C5/pass-16: honour the `manual` refresh pin.
    //
    // `last_indexed_at` is the "re-scanned <when>" stamp, and a KB pinned to
    // `manual` means "advance it only on an explicit re-scan". The watcher path
    // (`reindexKnowledgeBaseByDir`) has always respected that; this one bumped
    // it unconditionally, so any in-app upload / doc write / delete made a
    // manual-pinned KB claim it had just been re-scanned when nobody had asked
    // for one. `updated_at` still moves — the row DID change — but only the
    // re-scan button (or watcher-driven mode) may move the index stamp.
    const pinned =
      db
        .prepare(
          `SELECT refresh FROM org_knowledge_bases WHERE id = ? OR dir = ?`,
        )
        .get(target.id, dir)?.refresh === "manual";
    const indexClause = pinned
      ? `SET updated_at = ?`
      : `SET last_indexed_at = ?, updated_at = ?`;
    const indexArgs = pinned ? [now] : [now, now];
    const updated = db
      .prepare(`UPDATE org_knowledge_bases ${indexClause} WHERE id = ?`)
      .run(...indexArgs, target.id);
    if (updated.changes === 0) {
      // Adopt-on-touch. Key on dir (UNIQUE): a row may already exist under a
      // different id than the synthetic one the target carries.
      const adopted = db
        .prepare(`UPDATE org_knowledge_bases ${indexClause} WHERE dir = ?`)
        .run(...indexArgs, dir);
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
 * Is this write THE skill's SKILL.md — the root-level file the loader reads
 * (`resolveContainedSkillFile`)? A SKILL.md nested in a sub-folder is a
 * supporting file and is not judged as the skill.
 */
function isTheSkillMd(target: StoreTarget, base: string[], parts: string[]): boolean {
  return (
    target.kind === "skill" &&
    base.length === 0 &&
    parts.length === 1 &&
    parts[0] === "SKILL.md"
  );
}

/**
 * Writes uploaded files under `dirPath` (structure-preserving). Pre-checks
 * every path first — a conflict writes NOTHING. Same-name files are
 * replaced (mock merge semantics); a file never clobbers a directory.
 */
export function writeStoreFiles(
  db: DatabaseSync,
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
    // Ruling 183 (pass 36, F36-2): the skill's SKILL.md is judged with the
    // other pre-flight checks, so a refusal writes NOTHING of the batch.
    if (isTheSkillMd(target, base, file.parts)) {
      assertSkillBodyWellFormed(file.data.toString("utf8"));
    }
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      throw AppError.validation(
        `A folder named “${file.parts[file.parts.length - 1]}” already exists there. Rename the file first.`,
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
    if (isTheSkillMd(target, base, file.parts)) capturedSkillMd = true;
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
  db: DatabaseSync,
  target: StoreTarget,
  dirPath: string[],
  name: string,
  actor: AuditActor,
): MkdirResult {
  const base = sanitizeDirPath(dirPath);
  // Through `cleanSegment`, the module's own rule, instead of a hand-rolled
  // near-copy of it: the copy did not drop DOT-PREFIXED names, so a folder
  // called ".drafts" was created on disk and then skipped by the scanner
  // (`!e.name.startsWith(".")`) forever — invisible in the browser, never
  // injected into a run, and impossible to delete in-app, while the toast said
  // it worked. Refuse by name instead of creating something unreachable.
  const segs = name.split("/").flatMap((raw) => {
    if (raw.includes("..")) throw AppError.validation("Invalid folder name.");
    if (!raw.trim()) return [];
    const s = cleanSegment(raw);
    if (!s) {
      throw AppError.validation(
        `A folder name cannot start with a dot: “${raw.trim()}” would be hidden from the browser and from every agent run.`,
      );
    }
    return [s];
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

// ------------------------------------------------------------ author a doc


export interface StoreDocResult {
  path: string[];
  /** Ruling 466: the document's size as written, in UTF-8 BYTES. It was
   *  `body.length`, UTF-16 code units: live, an 8,220-byte document was
   *  reported and audited as "8,170 bytes". */
  bytes: number;
  /** An existing document was replaced rather than created (P14-UI-59). */
  replaced: boolean;
  /** Ruling 466: the size in bytes of the document this write replaced or
   *  appended to, measured on disk before the write; null when it created one.
   *  "How many bytes a replace destroyed" (ruling 257) is this figure. */
  previousBytes: number | null;
  /** Ruling 466 (F40-13): with `append`, the bytes this call added. */
  appendedBytes?: number;
}

/** Ruling 466: a size in bytes is a UTF-8 byte count, never a string length. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Ruling 305: the version of a store document, for an optimistic write.
 *
 * Hashed from the FILE, not from `readStoreDoc`'s text, because that reader
 * caps at 256 KB and a version computed from a truncated read would say two
 * different documents were the same one.
 */
export function storeDocVersion(target: StoreTarget, nodePath: string[]): string | null {
  const parts = sanitizeDirPath(nodePath);
  if (parts.length === 0) return null;
  const abs = path.join(target.rootAbs, ...parts);
  assertInsideRoot(target.rootAbs, abs);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return sha256Hex(readFileSync(abs)).slice(0, 12);
}

/** Read one store text doc for the editor (`null` when absent). A doc the
 *  editor cannot round-trip safely is refused by TYPE rather than reported as
 *  missing (P14-KM-08 — this reader had no production caller at all until the
 *  editor could open existing files). */
export function readStoreDoc(
  target: StoreTarget,
  nodePath: string[],
  maxBytes = 256 * 1024,
): { text: string; truncated: boolean } | null {
  const parts = sanitizeDirPath(nodePath);
  if (parts.length === 0) return null;
  const abs = path.join(target.rootAbs, ...parts);
  assertInsideRoot(target.rootAbs, abs);
  // Ruling 246 (F37-75): EXISTENCE before TYPE. The other order answers a path
  // this store has never held with a complaint about its file extension, which
  // names a cause that is not the reason and invites the caller to rename the
  // thing and try again. Live, the controller asked for `make/stack.mk` — a
  // file in the git repository, which this reader has no view of at all — and
  // was told Viberr "only opens text documents"; it dutifully retried as `.md`
  // and was then told the file "no longer exists", which implies it once did.
  // Two refusals, two wrong causes, and the real limit stated by neither.
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  if (!STORE_TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
    throw AppError.validation(
      `Viberr only opens text documents (${STORE_TEXT_EXTENSION_LIST.join(", ")}).`,
    );
  }
  const size = statSync(abs).size;
  // Ruling 466: the cap is in BYTES, as its name and `truncated` say. It used
  // to slice characters, so a non-ASCII document could read back whole while
  // `truncated` (measured in bytes) said it was cut. A cut that lands inside a
  // multi-byte character drops the partial character rather than decoding it
  // as U+FFFD.
  const raw = readFileSync(abs);
  const text =
    raw.length > maxBytes
      ? raw.subarray(0, maxBytes).toString("utf8").replace(/�$/, "")
      : raw.toString("utf8");
  return { text, truncated: size > maxBytes };
}

/**
 * Create or replace one text document inside a store folder (P13-LV-06,
 * owner ruling 3; extended by P14 owner ruling R14-4).
 *
 * Knowledge bases could only be filled by upload / folder-drop / "Add from
 * GitHub", even though skills have a full in-app SKILL.md editor and the KB
 * modal's own copy says "drop docs in, or let agents append". Writing the three
 * facts your agents must know meant leaving the product. This is the same write
 * path uploads use, so the watcher re-index and doc counts behave identically.
 *
 * P14-UI-59: writing was unconditionally create-OR-overwrite and reported both
 * outcomes with the same "saved" toast, so retyping the name of an existing doc
 * destroyed it with no confirmation and no trace. Replacing an existing file now
 * needs the caller's explicit intent; the UI asks first, and the editor's
 * open-an-existing-doc path carries it.
 */
export function writeStoreDoc(
  db: DatabaseSync,
  target: StoreTarget,
  dirPath: string[],
  name: string,
  body: string,
  actor: AuditActor,
  opts: {
    overwrite?: boolean;
    /**
     * Ruling 466 (F40-13): add `body` to the END of the document, creating it
     * when absent. The bytes sent are concatenated EXACTLY: nothing is trimmed
     * and no separator is inserted, so a part boundary may fall inside a
     * table, a list or a fenced block and the result is the text the caller
     * built. The existing file is read whole from disk, never through the
     * editor's capped reader, so nothing past a cap can be lost. An append
     * destroys nothing, so it needs no `overwrite`.
     */
    append?: boolean;
    /**
     * Ruling 637: the write replaces one passage (`editKbPassage`). The audit
     * row names the passage and what replaced it, so what an edit changed is
     * on the record and not only in the editor's transcript.
     */
    edit?: { replaced: string; text: string };
  } = {},
): StoreDocResult {
  const base = sanitizeDirPath(dirPath);
  const cleaned = name.trim().replace(/[\\/]/g, "-");
  if (!cleaned || cleaned.includes("..")) {
    throw AppError.validation("Give the document a file name.");
  }
  // Same rule as every other write into the store (`cleanSegment`): a
  // dot-prefixed document is skipped by the scanner, so it would be written,
  // reported as saved, and then be invisible, un-injectable and undeletable.
  if (!cleanSegment(cleaned)) {
    throw AppError.validation(
      `A document name cannot start with a dot: “${cleaned}” would be hidden from the browser and from every agent run.`,
    );
  }
  const withExt = path.extname(cleaned) ? cleaned : `${cleaned}.md`;
  if (!STORE_TEXT_EXTENSIONS.has(path.extname(withExt).toLowerCase())) {
    throw AppError.validation(
      `Viberr only edits text documents (${STORE_TEXT_EXTENSION_LIST.join(", ")}).`,
    );
  }
  const dirAbs = path.join(target.rootAbs, ...base);
  assertInsideRoot(target.rootAbs, dirAbs);
  const abs = path.join(dirAbs, withExt.slice(0, 200));
  assertInsideRoot(target.rootAbs, abs);
  const existed = existsSync(abs);
  if (existed && statSync(abs).isDirectory()) {
    throw AppError.validation(
      `A folder named “${withExt}” already exists there. Pick another name.`,
    );
  }
  if (existed && !opts.overwrite && !opts.append) {
    throw AppError.conflict(
      `${[...base, withExt].join("/")} already exists. Open it to edit, or pick another name.`,
    );
  }
  const previous = existed ? readFileSync(abs) : null;
  const sent = Buffer.from(body, "utf8");
  const written = opts.append && previous ? Buffer.concat([previous, sent]) : sent;
  // Ruling 183: the document editor is a SKILL.md writer too.
  if (isTheSkillMd(target, base, [withExt])) assertSkillBodyWellFormed(written.toString("utf8"));
  mkdirSync(dirAbs, { recursive: true });
  writeFileSync(abs, written);
  touchResource(db, target);
  const replaced = existed && !opts.append;
  const appendedBytes = opts.append ? sent.length : undefined;
  const details: AuditDetails = {
    path: [...base, withExt].join("/"),
    // Ruling 466: UTF-8 bytes, the figure `ls -l` and the result agree on.
    bytes: written.length,
    replaced,
  };
  if (appendedBytes !== undefined) details.appended = appendedBytes;
  if (opts.edit) details.edited = { replaced: opts.edit.replaced, text: opts.edit.text };
  recordAudit(db, {
    action: "org.store.doc_written",
    actor,
    subjectKind: `org_${target.kind}`,
    subjectId: target.id,
    details,
  });
  const result: StoreDocResult = {
    path: [...base, withExt],
    bytes: written.length,
    replaced,
    previousBytes: previous ? previous.length : null,
  };
  if (appendedBytes !== undefined) result.appendedBytes = appendedBytes;
  return result;
}

// ---------------------------------------------------------------- delete

export interface DeleteNodeResult {
  name: string;
  wasDir: boolean;
  filesRemoved: number;
}

/** Deletes a file or folder (recursive) at the store-relative path. */
export function deleteStoreNode(
  db: DatabaseSync,
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
const GITHUB_IMPORT_URL_RE =
  /github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([\w.-]+)\/?(.*))?/;

const GITHUB_IMPORT_URL_ERROR =
  "Paste a GitHub link: a repo, a folder (…/tree/main/docs), or a single file (…/blob/main/SKILL.md).";

const IMPORT_MAX_FILES = 100;
const IMPORT_MAX_BLOB_BYTES = 1024 * 1024;

/** Provenance dotfile written next to an imported snapshot (P13-KM-13). */
const IMPORT_MARKER = ".viberr-import.json";

/** The marker's payload. Only `source` is ever read back, and a marker that
 *  does not carry one is treated as no provenance at all. */
const importMarkerSchema = z.object({ source: z.string() });

function importSourceOf(rootAbs: string, folder: string): string | null {
  try {
    const raw = readFileSync(path.join(rootAbs, folder, IMPORT_MARKER), "utf8");
    const marker = importMarkerSchema.safeParse(JSON.parse(raw));
    return marker.success ? marker.data.source : null;
  } catch {
    return null;
  }
}

function writeImportMarker(rootAbs: string, folder: string, source: string): void {
  try {
    writeFileSync(
      path.join(rootAbs, folder, IMPORT_MARKER),
      JSON.stringify({ source, importedAt: new Date().toISOString() }, null, 2),
    );
  } catch {
    // best effort — a missing marker only costs the next import a suffix
  }
}

export type GithubImportResult =
  | {
      status: "imported";
      /** Store-relative destination path (browsed folder + snapshot folder). */
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

/** `GET git/trees` — entries keep `path`/`sha` strict (both feed the blob
 *  fetches and the write paths); `type` and `size` carry their readers'
 *  filter/`??` tolerance. A mangled listing parses to no tree at all, which the
 *  `?? []` read reports as "no importable files". */
const gitTreeSchema = z
  .object({
    tree: z
      .array(
        z.object({
          path: z.string(),
          type: z.string().optional().catch(undefined),
          sha: z.string(),
          size: z.number().optional().catch(undefined),
        }),
      )
      .optional()
      .catch(undefined),
    truncated: z.boolean().optional().catch(undefined),
  })
  .catch({});

/** `GET git/blobs/{sha}` — both fields are read with fallbacks, so each parses
 *  to `undefined` on drift and the decode degrades exactly as before. */
const gitBlobSchema = z
  .object({
    content: z.string().optional().catch(undefined),
    encoding: z.string().optional().catch(undefined),
  })
  .catch({});

/** `GET /repos/{r}` — only the default branch is read, with a `?? "main"`. */
const repoInfoSchema = z
  .object({ default_branch: z.string().optional().catch(undefined) })
  .catch({});

export async function importGithubSnapshot(
  db: DatabaseSync,
  target: StoreTarget,
  url: string,
  actor: AuditActor,
  options: { fetchImpl?: typeof fetch; dirPath?: string[] } = {},
): Promise<GithubImportResult> {
  const m = url.trim().match(GITHUB_IMPORT_URL_RE);
  if (!m) return { status: "invalid_url", message: GITHUB_IMPORT_URL_ERROR };
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/, "");
  let branch = m[3] ?? null;
  const subPath = (m[4] ?? "").replace(/\/+$/, "");

  // A PUBLIC repository needs NO credential — GitHub serves its tree and blobs
  // unauthenticated — so the import no longer demands a connection up front.
  // It used to, which made the single most common case (import a skill from a
  // public repo) impossible on an instance that had never linked GitHub at all.
  //
  // A validated connection is still USED whenever one exists: it lifts the
  // anonymous 60/hr per-IP quota to 5000/hr and is the only way to reach a
  // private repo. Missing it is not an error — it is only the EXPLANATION
  // offered when an anonymous read is refused (see `noConnectionState` below).
  //
  // B-GH7: re-prove a stale `valid` verdict before handing the token out — the
  // other consumer (runSetCredential) already does, and this one could import
  // with a token GitHub revoked months ago.
  // Only a test hands a transport over; production must reach the real `fetch`.
  const freshness: FreshnessOptions = {};
  if (options.fetchImpl) freshness.fetchImpl = options.fetchImpl;
  const tokenInfo = await getDefaultConnectionTokenFresh(db, freshness);
  const anonymous = tokenInfo === null;
  const clientOptions: GithubClientOptions = {
    token: tokenInfo?.token ?? null,
  };
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;
  const client = createGithubClient(clientOptions);

  // The two refusals that having no credential EXPLAINS. Both are repaired by
  // adding a connection, so they surface as the no-connection state — the
  // message that names the fix — rather than a dead-end "failed".
  const noConnectionState = (message: string): GithubImportResult => ({
    status: "no_connection",
    message,
  });
  const PRIVATE_HINT =
    `${owner}/${repo} is not readable without credentials. If it is private, ` +
    `add a GitHub connection under GitHub connections first.`;
  const RATE_HINT =
    "GitHub's unauthenticated rate limit (60 requests/hour per IP) is used up. " +
    "Add a GitHub connection to import against its own quota.";
  /** 403/429 with no token is the anonymous IP quota, at any call site. */
  const rateLimited = (res: { kind: string; status?: number }): boolean =>
    anonymous &&
    res.kind === "http" &&
    (res.status === 403 || res.status === 429);

  if (!branch) {
    const info = await client.request(
      "GET",
      `/repos/${owner}/${repo}`,
      repoInfoSchema,
    );
    if (!info.ok) {
      if (rateLimited(info)) return noConnectionState(RATE_HINT);
      // Anonymous 404 on the repository itself: private or nonexistent. GitHub
      // deliberately does not distinguish them without a credential, and a
      // connection is the only thing that can — so name that, not "not found".
      if (anonymous && info.kind === "http" && info.status === 404)
        return noConnectionState(PRIVATE_HINT);
      return {
        status: "failed",
        message:
          info.kind === "http" && info.status === 404
            ? `The connection can't see ${owner}/${repo}: repository not found.`
            : `GitHub is unreachable, so nothing was imported.`,
      };
    }
    branch = info.data.default_branch ?? "main";
  }

  const treeRes = await client.request(
    "GET",
    `/repos/${owner}/${repo}/git/trees/${branch}`,
    gitTreeSchema,
    { searchParams: { recursive: "1" } },
  );
  if (!treeRes.ok) {
    if (rateLimited(treeRes)) return noConnectionState(RATE_HINT);
    // A 404 HERE is ambiguous when anonymous: a wrong branch on a public repo
    // and a private repo are indistinguishable at this endpoint. It is also
    // the FIRST call whenever the URL carried an explicit branch (a /blob/ or
    // /tree/<branch> link), so guessing would mislabel every private-repo
    // import as a bad branch. One probe of the repo endpoint settles it.
    if (anonymous && treeRes.kind === "http" && treeRes.status === 404) {
      const probe = await client.request("GET", `/repos/${owner}/${repo}`, z.unknown());
      if (!probe.ok) return noConnectionState(PRIVATE_HINT);
    }
    return {
      status: "failed",
      message:
        treeRes.kind === "http" && treeRes.status === 404
          ? `Branch or path not found on ${owner}/${repo}.`
          : `GitHub refused the tree listing, so nothing was imported.`,
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

  // P14-KM-08 (owner ruling R14-4): the import always landed at the STORE ROOT,
  // ignoring whichever folder the admin was browsing — so organising imports
  // into subfolders was impossible from the UI. It now lands under the browsed
  // path, resolved with the same sanitizer every other store write uses.
  const base = sanitizeDirPath(options.dirPath ?? []);
  const baseAbs = path.join(target.rootAbs, ...base);
  assertInsideRoot(target.rootAbs, baseAbs);

  // A /blob/ URL — a path that IS one file — imports that file straight into
  // the browsed folder under its own name. The folder flow below would (a)
  // compute an EMPTY relative path for it (`"SKILL.md".slice("SKILL.md/".length)`)
  // and import nothing behind a misleading "GitHub refused the file contents",
  // and (b) even fixed, wrap it as `SKILL.md/SKILL.md` — one level too deep
  // for anything that expects the file at the root (the skill loader).
  // Re-importing the same file refreshes it in place.
  const singleFile =
    subPath !== "" && blobs.length === 1 && blobs[0]!.path === subPath;
  if (singleFile) {
    const blob = blobs[0]!;
    const filename = subPath.split("/").filter(Boolean).pop()!;
    const blobRes = await client.request(
      "GET",
      `/repos/${owner}/${repo}/git/blobs/${blob.sha}`,
      gitBlobSchema,
    );
    if (!blobRes.ok) {
      if (rateLimited(blobRes)) return noConnectionState(RATE_HINT);
      return {
        status: "failed",
        message: "GitHub refused the file contents, so nothing was imported.",
      };
    }
    const content = blobRes.data.content ?? "";
    const data =
      blobRes.data.encoding === "base64"
        ? Buffer.from(content.replace(/\n/g, ""), "base64")
        : Buffer.from(content, "utf8");
    const abs = path.join(baseAbs, filename);
    assertInsideRoot(target.rootAbs, abs);
    const refreshedFile = existsSync(abs);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    touchResource(db, target);
    const fileSource = `${owner}/${repo}/${subPath}`;
    const destination = [...base, filename].join("/");
    recordAudit(db, {
      action: "org.store.github_import",
      actor,
      subjectKind: `org_${target.kind}`,
      subjectId: target.id,
      details: {
        source: fileSource,
        branch,
        folder: destination,
        fileCount: 1,
        skipped: 0,
        truncated: false,
      },
    });
    return {
      status: "imported",
      folder: destination,
      fileCount: 1,
      skipped: 0,
      source: fileSource,
      truncated: false,
      toast: `${filename} ${refreshedFile ? "re-imported" : "imported"} from ${fileSource} (a snapshot, not a live sync)`,
    };
  }

  // Root folder named after the last path segment (or the repo).
  //
  // P13-KM-13: this ALWAYS collision-suffixed, so re-importing the same source
  // produced `docs`, `docs-2`, `docs-3`… — every copy injected into every run,
  // with the 24k budget spent on the OLDEST copy first. A folder that this same
  // source produced is now REFRESHED in place; only a genuinely different
  // source gets a suffix. Provenance lives in a dotfile, which the scanner and
  // the injector both skip, so it never becomes agent context.
  const baseName =
    (subPath ? subPath.split("/").filter(Boolean).pop() : repo) || repo;
  const sourceKey = `${owner}/${repo}${subPath ? `/${subPath}` : ""}`;
  let folder = baseName;
  let refreshed = false;
  let i = 2;
  // F20-1: bound the collision scan. On a healthy mount this settles in a hop
  // or two; on a ghost data-root inode (a deleted VirtioFS bind-mount under a
  // running container) `existsSync` can answer `true` for EVERY candidate name,
  // and the old unbounded `while` then pegged the event loop forever with no
  // error — the whole app went down (a create-project spin was the live repro).
  // Cap the foreign-collision attempts and fail THIS import with a typed error
  // naming the folder instead of spinning. The refresh-in-place branch below
  // never counts against the cap (it breaks immediately).
  const COLLISION_CAP = 32;
  let attempts = 0;
  while (existsSync(path.join(baseAbs, folder))) {
    if (importSourceOf(baseAbs, folder) === sourceKey) {
      refreshed = true;
      // The delete used to happen HERE, before a single blob was fetched, so a
      // re-import that GitHub then refused (rate limit, revoked token, network)
      // destroyed the folder's whole contents and reported "nothing was
      // imported". The fetch now stages below and only swaps once it has
      // content, so a failed refresh leaves the existing snapshot untouched.
      break;
    }
    if (++attempts > COLLISION_CAP) {
      throw new AppError({
        code: ERROR_CODES.INTERNAL,
        status: 503,
        message: `import collision scan exceeded ${COLLISION_CAP} attempts under ${baseAbs}`,
        userMessage: `Could not find a free folder under "${baseName}" after ${COLLISION_CAP} attempts; the data root may be unreachable. Nothing was imported.`,
      });
    }
    folder = `${baseName}-${i++}`;
  }

  // Set when a blob fetch is refused by the ANONYMOUS quota — the difference
  // between "GitHub refused these files" and "you ran out of anonymous quota
  // partway through", which is repaired by a connection, not by retrying.
  let anonQuotaHit = false;
  // Staging root for this import. Dot-prefixed so the scanner and the injector
  // skip it (same reason the provenance marker is a dotfile) if anything ever
  // leaves one behind; every exit below removes it.
  const finalAbs = path.join(baseAbs, folder);
  const stageAbs = path.join(baseAbs, `.importing-${folder}`);
  assertInsideRoot(target.rootAbs, stageAbs);
  rmSync(stageAbs, { recursive: true, force: true });
  const writeResults = await Promise.all(
    selected.map(async (blob) => {
      const rel = subPath ? blob.path.slice(prefix.length) : blob.path;
      const parts = cleanRelPath(rel);
      if (!parts) return 0;
      const blobRes = await client.request(
        "GET",
        `/repos/${owner}/${repo}/git/blobs/${blob.sha}`,
        gitBlobSchema,
      );
      if (!blobRes.ok) {
        if (rateLimited(blobRes)) anonQuotaHit = true;
        return 0;
      }
      const content = blobRes.data.content ?? "";
      const data =
        blobRes.data.encoding === "base64"
          ? Buffer.from(content.replace(/\n/g, ""), "base64")
          : Buffer.from(content, "utf8");
      const abs = path.join(stageAbs, ...parts);
      assertInsideRoot(target.rootAbs, abs);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      return 1;
    }),
  );
  const written = writeResults.reduce((sum: number, n) => sum + n, 0);
  if (written === 0) {
    // Nothing arrived: drop the staging tree and leave any existing snapshot
    // exactly as it was — "nothing was imported" is now literally true.
    rmSync(stageAbs, { recursive: true, force: true });
    if (anonQuotaHit) return noConnectionState(RATE_HINT);
    return {
      status: "failed",
      message: "GitHub refused the file contents, so nothing was imported.",
    };
  }
  // Content in hand — now, and only now, replace the previous snapshot.
  rmSync(finalAbs, { recursive: true, force: true });
  renameSync(stageAbs, finalAbs);
  // E5: per-blob failures (refused blob fetch, unwritable path) used to sum
  // silently into the success toast — count and surface them instead.
  const skipped = selected.length - written;

  writeImportMarker(baseAbs, folder, sourceKey);
  touchResource(db, target);
  const source = sourceKey;
  // Store-relative destination: what the client expands, and the honest answer
  // to "where did my import go" now that it is not always the root.
  const destination = [...base, folder].join("/");
  recordAudit(db, {
    action: "org.store.github_import",
    actor,
    subjectKind: `org_${target.kind}`,
    subjectId: target.id,
    details: {
      source,
      branch,
      folder: destination,
      fileCount: written,
      skipped,
      truncated,
    },
  });
  const suffix = [
    ...(truncated ? [" (truncated)"] : []),
    ...(skipped > 0
      ? [` · ${countLabel(skipped, "file")} skipped (fetch failed)`]
      : []),
  ].join("");
  return {
    status: "imported",
    folder: destination,
    fileCount: written,
    skipped,
    source,
    truncated,
    toast: `${countLabel(written, "file")} ${refreshed ? "re-imported" : "imported"} from ${source} into ${destination}/ (a snapshot, not a live sync)${suffix}`,
  };
}
