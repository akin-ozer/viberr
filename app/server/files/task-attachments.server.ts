import { readdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import path from "node:path";
import {
  resolveStoreSegment,
  taskAttachmentsDir,
} from "./file-store-root.server";

/**
 * R19-19 — the task attachments store (read side).
 *
 * Files land here through two writers: the browser MCP server's `--output-dir`
 * (screenshots, PDFs the agent saves) and, since PR #179, the agent evidence
 * drop — any run granted `attach-evidence-references` may copy files in
 * directly ("post a file on the task thread"). The read side is
 * deliberately dumb — the DIRECTORY is the truth, no projection table, no
 * upload path, no retention machinery: attachments live inside the task dir so
 * archive/delete flows move them with the task.
 *
 * Serving rules (the route consumes these):
 *  - names resolve through `resolveStoreSegment` — traversal throws, and the
 *    route turns that into a 404 rather than an oracle;
 *  - only a WHITELIST of extensions renders inline. HTML/SVG/JS are never
 *    inline — a stored page served on the app origin would be stored XSS with
 *    the viewer's session attached — they download as octet-stream instead.
 */

export interface TaskAttachmentEntry {
  name: string;
  size: number;
  /** ISO mtime — "when the file was saved", newest first. */
  modifiedAt: string;
}

/** Display bound: the panel is evidence, not a file manager. */
const LIST_CAP = 100;

export function listTaskAttachments(
  slug: string,
  key: string,
  dataRoot?: string,
): TaskAttachmentEntry[] {
  const dir = taskAttachmentsDir(slug, key, dataRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no attachments dir yet — the common case
  }
  const entries: TaskAttachmentEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      entries.push({ name, size: st.size, modifiedAt: st.mtime.toISOString() });
    } catch {
      // raced unlink between readdir and stat — skip
    }
  }
  entries.sort(
    (a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name),
  );
  return entries.slice(0, LIST_CAP);
}

/**
 * C8: `listTaskAttachments` caps its return at `LIST_CAP` with nothing to
 * tell a caller the store actually holds more — a task with 140 saved files
 * rendered as if it had exactly 100, no "and N more" anywhere. The honest fix
 * is a total the panel can compare against the list length, but the route
 * loader (`project.task.tsx`) that feeds the panel is out of this change's
 * scope, so this stays a SIBLING export rather than a shape change to
 * `listTaskAttachments` (which would have forced every existing caller,
 * including that loader, to update in lockstep). Cheap on purpose: a dirent
 * type check, no per-file `statSync`.
 */
export function countTaskAttachments(
  slug: string,
  key: string,
  dataRoot?: string,
): number {
  const dir = taskAttachmentsDir(slug, key, dataRoot);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // no attachments dir yet — the common case
  }
  return entries.filter((e) => !e.name.startsWith(".") && e.isFile()).length;
}

/**
 * Names of the attachments written at-or-after `sinceIso`, newest first — the
 * files a just-finished run produced. The runtime is the directory's only
 * writer (the browser MCP's `--output-dir`) and run start is recorded before
 * the process spawns on the same host clock, so an mtime window bounded by the
 * run's `started_at` names exactly that run's files. A file re-saved under the
 * same name by a later run re-attributes to the later run, which is the honest
 * reading (its content is the later run's).
 */
export function attachmentNamesSince(
  slug: string,
  key: string,
  sinceIso: string,
  dataRoot?: string,
): string[] {
  if (Number.isNaN(Date.parse(sinceIso))) return [];
  return listTaskAttachments(slug, key, dataRoot)
    .filter((entry) => entry.modifiedAt >= sinceIso)
    .map((entry) => entry.name);
}

/** The browser MCP's machine-stamped output names (`page-…Z.png`,
 *  `console-…Z.log`, `element-…Z.png`). A human- or agent-chosen filename
 *  never has this shape. */
const MCP_STAMPED_NAME_RE =
  /^(?:page|console|element)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\./;

/** Visual evidence — the point of the store. Always kept, never a working
 *  artifact regardless of how the file was named. */
const VISUAL_EVIDENCE_RE = /\.(?:png|jpe?g|webp|gif|pdf)$/i;

/**
 * Owner ask 2026-08-31 (ruling 105): `--output-dir` IS the attachments store,
 * so the browser MCP's own WORKING artifacts — the `page-*.yml` aria snapshots
 * and `console-*.log` dumps its tool calls write next to the screenshots —
 * were posted to humans as if the agent chose to share them, drowning the
 * panel (VIB-1 held ~20 of them around 2 deliberate screenshots). They are
 * tool transport for the agent's own reading, not deliverables.
 *
 * A working artifact is a machine-stamped name that is NOT visual evidence.
 * Deliberately named files (`review-col-head-contrast.png`, `notes.txt`) never
 * match the stamp; screenshots/PDFs never match the extension test.
 */
export function isBrowserWorkingArtifact(name: string): boolean {
  return MCP_STAMPED_NAME_RE.test(name) && !VISUAL_EVIDENCE_RE.test(name);
}

/**
 * Delete the working artifacts a finished run left behind, KEEPING any whose
 * exact filename the run cited (`citedIn` — reply text, evidence rows, and the
 * timeline since the run started). The persona's contract is "cite the exact
 * filename", so a citation is the agent saying "this file is for the humans".
 * Returns the names that survive (the list the producing event should claim)
 * and the names deleted. A file that cannot be deleted stays listed — the
 * panel must never name-check files the directory still holds.
 */
export function pruneBrowserWorkingArtifacts(
  slug: string,
  key: string,
  names: readonly string[],
  citedIn: string,
  dataRoot?: string,
) {
  const kept: string[] = [];
  const pruned: string[] = [];
  for (const name of names) {
    if (!isBrowserWorkingArtifact(name) || citedIn.includes(name)) {
      kept.push(name);
      continue;
    }
    try {
      unlinkSync(resolveTaskAttachment(slug, key, name, dataRoot));
      pruned.push(name);
    } catch {
      kept.push(name); // still on disk (or raced) — keep it honest and listed
    }
  }
  return { kept, pruned };
}

/** Absolute path of one attachment, traversal-contained. Throws on an unsafe
 *  name (the route maps that to 404). */
export function resolveTaskAttachment(
  slug: string,
  key: string,
  name: string,
  dataRoot?: string,
): string {
  return resolveStoreSegment(taskAttachmentsDir(slug, key, dataRoot), name);
}

/** Extension → inline content type. Anything absent here is served as a
 *  download (`application/octet-stream`), never rendered on the app origin. */
const INLINE_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"],
  [".json", "application/json"],
  // Ruling 105: yaml/csv join the inert-text set so the in-app read-only
  // viewer can fetch them. Plain text on purpose — never a renderable type.
  [".yml", "text/plain; charset=utf-8"],
  [".yaml", "text/plain; charset=utf-8"],
  [".csv", "text/plain; charset=utf-8"],
]);

export function attachmentContentType(name: string): {
  type: string;
  inline: boolean;
} {
  const ext = path.extname(name).toLowerCase();
  const type = INLINE_TYPES.get(ext);
  return type
    ? { type, inline: true }
    : { type: "application/octet-stream", inline: false };
}
