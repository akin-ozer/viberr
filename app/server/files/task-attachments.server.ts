import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  resolveStoreSegment,
  taskAttachmentsDir,
} from "./file-store-root.server";

/**
 * R19-19 — the task attachments store (read side).
 *
 * Files land here through exactly one writer today: the browser MCP server's
 * `--output-dir` (screenshots, PDFs the agent saves). The read side is
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
  /** ISO mtime — "when the browser saved it", newest first. */
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
