import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { AppError } from "~/server/errors/app-error.server";
import { shareDirWithAgents } from "~/server/runtimes/agent-isolation.server";
import {
  ATTACHMENT_BATCH_MAX,
  ATTACHMENT_BATCH_MAX_BYTES,
  type AttachmentBatchWording,
  BINARY_EXTENSIONS,
  INLINE_TYPES,
  MAX_UPLOAD_BYTES,
  READABLE_TEXT_EXTENSIONS,
} from "~/shared/attachment-kinds";
import path from "node:path";
import { isGateLogName } from "~/shared/project-gates";
import {
  resolveStoredSegment,
  storedFileName,
  taskAttachmentsDir,
} from "./file-store-root.server";
import { resolveKeptDeliveryFile } from "./kept-deliveries.server";
import { pdfToText } from "./pdf-text.server";
import { xlsxToText } from "./xlsx-text.server";
import { pageEnd } from "~/server/runtimes/read-page-budget.server";

/**
 * R19-19 — the task attachments store (read side).
 *
 * Files land here through three writers: the browser MCP server's
 * `--output-dir` (screenshots, PDFs the agent saves), the agent evidence drop
 * since PR #179 — any run granted `attach-evidence-references` may copy files
 * in directly ("post a file on the task thread") — and, since F39-6 (pass 39),
 * a PERSON, through {@link writeTaskAttachment}. The read side is deliberately
 * dumb — the DIRECTORY is the truth, no projection table, no retention
 * machinery: attachments live inside the task dir so archive/delete flows move
 * them with the task.
 *
 * F39-6: the human writer was missing, and it cost a real answer. Viberr's own
 * controller, asked where a human-supplied artifact would genuinely help,
 * named the task and the file — "a human-supplied fixture stops the decoder
 * from being tested against a fixture it wrote for itself" — and there was no
 * way to supply it. The only route was writing into the data volume by hand.
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
 * Ruling 538: every file name a task's attachments hold, uncapped and
 * unordered (the display cap of {@link listTaskAttachments} would hide a
 * clash past its hundredth file), dot-files skipped as every reader does.
 */
export function listTaskAttachmentNames(slug: string, key: string, dataRoot?: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(taskAttachmentsDir(slug, key, dataRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
}

/**
 * C8: `listTaskAttachments` caps its return at `LIST_CAP` with nothing to
 * tell a caller the store actually holds more — a task with 140 saved files
 * rendered as if it had exactly 100, no "and N more" anywhere. This is the
 * total the panel compares against the list length. Cheap on purpose: a
 * dirent type check, no per-file `statSync`.
 */
export function countTaskAttachments(
  slug: string,
  key: string,
  dataRoot?: string,
): number {
  return listTaskAttachmentNames(slug, key, dataRoot).length;
}

/**
 * Names of the attachments written at-or-after `sinceIso`, newest first — the
 * files a just-finished run produced. The runtime is the directory's only
 * writer (the browser MCP's `--output-dir`) and run start is recorded before
 * the process spawns on the same host clock, so an mtime window bounded by the
 * run's `started_at` names exactly that run's files. A file re-saved under the
 * same name by a later run re-attributes to the later run, which is the honest
 * reading (its content is the later run's).
 *
 * Deliberately UNCAPPED (ruling-105 review): this used to ride
 * `listTaskAttachments`, whose LIST_CAP display bound silently limited the
 * window to the newest 100 files — so a run that wrote more than 100 working
 * artifacts (the exact drowning case the prune targets) permanently orphaned
 * the overflow. The window is a completion-time fact, not a display list.
 */
export function attachmentNamesSince(
  slug: string,
  key: string,
  sinceIso: string,
  dataRoot?: string,
): string[] {
  if (Number.isNaN(Date.parse(sinceIso))) return [];
  const dir = taskAttachmentsDir(slug, key, dataRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no attachments dir yet — the common case
  }
  const inWindow: { name: string; at: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    // Ruling 482: a gate log is Viberr's own evidence, written by the gate
    // runner while any run may be in flight. Claiming it for that run would
    // name the run as its author and, for a deliverer, move `deliveredAt`.
    if (isGateLogName(name)) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      const at = st.mtime.toISOString();
      if (at >= sinceIso) inWindow.push({ name, at });
    } catch {
      // raced unlink between readdir and stat — skip
    }
  }
  inWindow.sort(
    (a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name),
  );
  return inWindow.map((entry) => entry.name);
}

/** A machine-stamped output name (`page-…Z.png`, `console-…Z.log`,
 *  `element-…Z.png`, and whatever prefix a future MCP tool invents): a short
 *  lowercase prefix plus the MCP's dashed-ISO timestamp. A human- or
 *  agent-chosen filename never has this shape — the ruling-105 review showed
 *  pinning specific prefixes just leaves the next sibling artifact drowning
 *  the panel, so the stamp itself is the classifier. */
const MCP_STAMPED_NAME_RE =
  /^[a-z][a-z0-9_]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\./;

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
 * Ruling 552: the bytes of one regular file in a task's attachments, read
 * through a descriptor opened without following a symlink. The folder is
 * writable by every agent in the group (ruling 460), so a name in it can be a
 * link an agent planted to a file only the server may read: following it
 * handed that file to a coordinator's reader, and a relay copied it onto
 * another task as an ordinary file every agent can read. Null for a link, a
 * folder or a missing name; `tooLarge` (its size) past `maxBytes`, before
 * anything is read.
 */
export function readAttachmentBytes(
  abs: string,
  maxBytes: number,
): { bytes: Buffer } | { tooLarge: number } | null {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return { tooLarge: st.size };
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** Ruling 552: the most of a text attachment read at all (then paged, 551). */
const TEXT_READ_MAX_BYTES = 16 * 1024 * 1024;
/** Ruling 552: the most of a workbook read (uploads stop at 10 MB; an agent's
 *  own export can be larger). */
const XLSX_READ_MAX_BYTES = 25 * 1024 * 1024;

/** Ruling 549: the most of one saved file read for its citations. */
const SAVED_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Ruling 549: the text of the files a run saved for people, where a run whose
 * delivery is files (ruling 531) cites its evidence. On AWSC-1 the findings
 * file named eleven browser snapshots and the report named none, so the prune
 * deleted all eleven and the reviewer rejected the findings for citing files
 * that were not there. Text files only (not the working artifacts
 * themselves), each up to {@link SAVED_TEXT_MAX_BYTES}; an unreadable one adds
 * nothing.
 */
export function savedFilesText(
  slug: string,
  key: string,
  names: readonly string[],
  dataRoot?: string,
): string {
  const parts: string[] = [];
  for (const name of names) {
    if (isBrowserWorkingArtifact(name)) continue;
    if (!READABLE_TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    let abs: string;
    try {
      abs = resolveTaskAttachment(slug, key, name, dataRoot);
    } catch {
      continue;
    }
    // Ruling 552: never through a link. Gone, a link or too large: it cites nothing.
    const read = readAttachmentBytes(abs, SAVED_TEXT_MAX_BYTES);
    if (read && "bytes" in read) parts.push(read.bytes.toString("utf8"));
  }
  return parts.join("\n");
}

/**
 * Delete the working artifacts a finished run left behind, KEEPING any whose
 * exact filename the run cited (`citedIn` — reply text, evidence rows, the
 * timeline since the run started, and the files it saved, ruling 549). The persona's contract is "cite the exact
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
    } catch (err) {
      // Already gone counts as pruned — the producing event must never claim
      // a file the directory does not hold (the exact honesty rule this
      // function exists for). Any OTHER failure keeps the file listed,
      // because it is still on disk.
      // SAFETY: node's fs errors carry `code: string`; reading it off an
      // unknown non-Error value yields undefined, which simply keeps the file.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") pruned.push(name);
      else kept.push(name);
    }
  }
  return { kept, pruned };
}

/** What a stray store-layout folder in a workspace holds (ruling 159). */
export interface StrayAttachmentsFolder {
  /** The absolute path of the folder inside the workspace checkout. */
  dir: string;
  /** The store-relative form the older prompt named, for the sentence. */
  rel: string;
  /** The plain files the agent put there, newest first by name order. */
  files: string[];
}

/**
 * Ruling 159 (pass 35, F35-10): an older prompt named the attachments folder
 * by its STORE-relative path (`projects/<slug>/tasks/<key>/attachments`) and
 * called it reachable from the working directory; an agent whose cwd is the
 * repository checkout created exactly that tree inside the clone, and the
 * file never reached the task page. The completion pipeline scans the run's
 * workspace candidates for that folder so a person learns why the attachment
 * is missing. The first candidate that holds the folder wins; a missing or
 * unreadable candidate is simply not it.
 */
export function findStrayAttachmentsFolder(
  candidates: readonly string[],
  slug: string,
  key: string,
): StrayAttachmentsFolder | null {
  const rel = `projects/${slug}/tasks/${key}/attachments`;
  for (const candidate of candidates) {
    const dir = path.join(candidate, "projects", slug, "tasks", key, "attachments");
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue; // not there, or unreadable: not this candidate
    }
    const files = names
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
    return { dir, rel, files };
  }
  return null;
}

/** Absolute path of one attachment, traversal-contained. Throws on an unsafe
 *  name (the route maps that to 404). Ruling 675: a name typed in another
 *  Unicode form than the file was stored in finds that file. */
export function resolveTaskAttachment(
  slug: string,
  key: string,
  name: string,
  dataRoot?: string,
): string {
  return resolveStoredSegment(taskAttachmentsDir(slug, key, dataRoot), name);
}

/** True when the task's attachments store holds a file by this name. An
 *  unsafe name (the resolver throws) and a missing one both read false. */
export function taskAttachmentExists(
  slug: string,
  key: string,
  name: string,
  dataRoot?: string,
): boolean {
  try {
    return statSync(resolveTaskAttachment(slug, key, name, dataRoot)).isFile();
  } catch {
    return false;
  }
}

/** Extension → inline content type (`INLINE_TYPES`). Anything absent there is
 *  served as a download (`application/octet-stream`), never rendered on the
 *  app origin. */
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

// ------------------------------------------------------- the human writer

export { MAX_UPLOAD_BYTES, READABLE_TEXT_EXTENSIONS } from "~/shared/attachment-kinds";

export interface WrittenAttachment {
  name: string;
  bytes: number;
  /** True when a file of that name was already there. */
  replaced: boolean;
}

/**
 * Ruling 675: the `content-disposition` of a served file, whatever its name
 * holds. A header value is Latin-1, so a name with a letter outside it made
 * `new Response` throw: the task's own input on AWSC-117, a PDF named in
 * Turkish, answered 500 to the person who attached it. The quoted name is the
 * ASCII fallback and `filename*` carries the real one (RFC 6266).
 */
export function attachmentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The refusals every person's upload meets, before anything is written: an
 * empty or dot-prefixed name the store scanner would then hide, a name that
 * is not one path segment, and anything over {@link MAX_UPLOAD_BYTES}. Ruling
 * 574: any kind is stored; the serving route decides what renders inline. Returns the name as it will be stored: trimmed,
 * and composed (ruling 675), so the name a Mac sends decomposed is stored the
 * way every reader types it. Ruling 533:
 * a task filed with its input checks every file here before its key is
 * allocated, so a refused file costs no key.
 */
export function checkAttachmentUpload(name: string, byteLength: number): string {
  const cleaned = storedFileName(name.trim());
  if (!cleaned) {
    throw AppError.validation("Give the file a name.");
  }
  if (cleaned.startsWith(".")) {
    // Same rule as every other write into the store: the scanner skips
    // dot-files, so this one would be written, reported as saved, and then be
    // invisible to the panel and to every agent run.
    throw AppError.validation(
      `A file name cannot start with a dot: “${cleaned}” would be hidden from this task and from every agent run.`,
    );
  }
  // Ruling 533: every name the store's resolver refuses is refused here, by a
  // sentence, before anything is written or a task key is taken for it.
  if (/[\\/\0]/.test(cleaned)) {
    throw AppError.validation(
      `A file name cannot hold “/”, “\\” or a null character: “${cleaned.replaceAll("\0", "")}” is not one name.`,
    );
  }
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw AppError.validation(
      `“${cleaned}” is ${Math.round(byteLength / 1024 / 1024)} MB; an attachment may be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  return cleaned;
}

/**
 * Rulings 533 and 573: every file a batch carries is checked before anything
 * is written, by the rules one upload meets, and the batch by its own: at most
 * {@link ATTACHMENT_BATCH_MAX} files and {@link ATTACHMENT_BATCH_MAX_BYTES},
 * and no two names one case apart. One refused file refuses the batch.
 * Returns the names they will be stored under.
 */
export function checkAttachmentBatch(
  files: readonly { name: string; data: Uint8Array }[],
  wording: AttachmentBatchWording,
): string[] {
  const holds = wording.holds.charAt(0).toLowerCase() + wording.holds.slice(1);
  if (files.length > ATTACHMENT_BATCH_MAX) {
    throw AppError.validation(
      `${wording.holds} up to ${ATTACHMENT_BATCH_MAX} files; this one has ${files.length}. ${wording.rest}`,
    );
  }
  const total = files.reduce((sum, f) => sum + f.data.byteLength, 0);
  if (total > ATTACHMENT_BATCH_MAX_BYTES) {
    throw AppError.validation(
      `These files come to ${Math.round(total / 1024 / 1024)} MB; ${holds} up to ${ATTACHMENT_BATCH_MAX_BYTES / 1024 / 1024} MB. ${wording.rest}`,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = checkAttachmentUpload(file.name, file.data.byteLength);
    // Case-folded: two names one case apart are one file on a case-insensitive
    // disk, and the second write would silently replace the first.
    if (seen.has(name.toLowerCase())) {
      throw AppError.validation(`Two of these files are named “${name}”. Rename one of them.`);
    }
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/**
 * Ruling 558: the names a writer is putting on a task for someone other than a
 * run (a person's upload, a relay, a take), from before the file lands until
 * the timeline entry that claims it is written.
 *
 * A completion credits its run with every file saved in the run's window
 * except those a person's note or a relay's comment claims (rulings 533 and
 * 538). Those writers put the file down first and the claim second, so a
 * completion that listed the file between the two read a timeline with no
 * claim on it and took the file as the run's own: for a deliverer, its
 * delivery. Holding the name here closes that gap without reordering the
 * writers. A completion reads this after it lists the run's files and before
 * it reads the timeline, so a file it saw is either still held here or
 * already claimed there. In memory, because one process writes a data root.
 */
const claimsInFlight = new Map<string, Map<string, number>>();

/** Puts one file on the task inside {@link withAttachmentClaims}: the store's
 *  own write, with {@link writeTaskAttachment}'s refusals. `refuseReplace` is
 *  the sentence that refuses overwriting a file already there, or null to
 *  allow it. The caller knows whose file it is; the store does not. */
export type PutAttachment = (name: string, data: Uint8Array, refuseReplace?: string | null) => WrittenAttachment;

/**
 * Hold `names` on the task while `write` puts the files down with `put` and
 * writes the entry that claims them. A file lands with its claim or not at
 * all: if `write` fails, every file it put is taken back before the names are
 * released (a new one removed, a replaced one put back), because a file left
 * on the task without its claim is the next completion's to take.
 */
export async function withAttachmentClaims<T>(
  slug: string,
  key: string,
  names: readonly string[],
  write: (put: PutAttachment) => Promise<T>,
  dataRoot?: string,
): Promise<T> {
  const task = `${slug}/${key}`;
  const held = claimsInFlight.get(task) ?? new Map<string, number>();
  if (names.length > 0) claimsInFlight.set(task, held);
  for (const name of names) held.set(name, (held.get(name) ?? 0) + 1);
  const landed: LandedAttachment[] = [];
  const put: PutAttachment = (name, data, refuseReplace = null) => {
    const file = landTaskAttachment(slug, key, name, data, dataRoot, refuseReplace);
    landed.push(file);
    return file.written;
  };
  try {
    const result = await write(put);
    for (const file of landed) file.keep();
    return result;
  } catch (error) {
    for (const file of landed.reverse()) file.takeBack();
    throw error;
  } finally {
    for (const name of names) {
      const count = (held.get(name) ?? 1) - 1;
      if (count > 0) held.set(name, count);
      else held.delete(name);
    }
    // Only this writer's own entry: another may have replaced it meanwhile.
    if (held.size === 0 && claimsInFlight.get(task) === held) claimsInFlight.delete(task);
  }
}

/** The names held on a task right now, copied. */
export function attachmentClaimsInFlight(slug: string, key: string): Set<string> {
  return new Set(claimsInFlight.get(`${slug}/${key}`)?.keys() ?? []);
}

/** A file just put on a task, and the two ways to finish it. */
interface LandedAttachment {
  written: WrittenAttachment;
  /** Remove it, or put back the file it replaced. */
  takeBack: () => void;
  /** Let go of the replaced file kept for `takeBack`. */
  keep: () => void;
}

/**
 * Write one human-supplied attachment onto a task. Refuses — by throwing
 * {@link AppError.validation} with a sentence naming the reason — everything
 * {@link checkAttachmentUpload} refuses, and a traversing or
 * separator-bearing name. The caller does the authorization and the audit.
 */
export function writeTaskAttachment(
  slug: string,
  key: string,
  name: string,
  data: Uint8Array,
  dataRoot?: string,
): WrittenAttachment {
  const file = landTaskAttachment(slug, key, name, data, dataRoot, null);
  file.keep();
  return file.written;
}

function landTaskAttachment(
  slug: string,
  key: string,
  name: string,
  data: Uint8Array,
  dataRoot: string | undefined,
  refuseReplace: string | null,
): LandedAttachment {
  const checked = checkAttachmentUpload(name, data.byteLength);
  const dir = taskAttachmentsDir(slug, key, dataRoot);
  // The SAME traversal-refusing resolver the serving route uses, so a name
  // this accepts is a name that route can serve and vice versa. Ruling 675: a
  // file already here under the same name in another Unicode form is the file
  // this replaces, never a second one no reader could tell from it.
  const abs = resolveStoredSegment(dir, checked);
  const cleaned = path.basename(abs);
  const replaced = existsSync(abs);
  if (replaced && refuseReplace) throw AppError.validation(refuseReplace);
  // Ruling 460: the same directory agents drop evidence into, as their users.
  shareDirWithAgents(dir);
  // Ruling 552: made whole under a fresh name, then renamed over the entry. A
  // rename replaces the name itself, so a link an agent planted there is
  // replaced, never written through to the file it points at.
  const staging = path.join(dir, `.viberr-write-${randomBytes(6).toString("hex")}`);
  const fd = openSync(
    staging,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o664,
  );
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  // Ruling 558: the file it replaces is set aside, by a rename that moves the
  // entry and never follows it, so a claim that fails can put it back.
  const previous = replaced ? path.join(dir, `.viberr-prev-${randomBytes(6).toString("hex")}`) : null;
  try {
    if (previous) renameSync(abs, previous);
    renameSync(staging, abs);
  } catch (error) {
    quietly(() => unlinkSync(staging));
    if (previous && !existsSync(abs)) quietly(() => renameSync(previous, abs));
    throw error;
  }
  return {
    written: { name: cleaned, bytes: data.byteLength, replaced },
    takeBack: () => quietly(() => (previous ? renameSync(previous, abs) : unlinkSync(abs))),
    keep: () => {
      if (previous) quietly(() => unlinkSync(previous));
    },
  };
}

/** A clean-up step whose target may already be gone. */
function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Already gone.
  }
}

/**
 * Ruling 293 (pass 37, F37-128): the evidence a reviewer was ASKED to attach,
 * read as text.
 *
 * A task's attachments are where the proof lives. On this board the SHOP-37
 * deliverer put its mutation proof in one (`mutation-proof-…txt`: the mutant
 * diff and both vitest runs, raw); the SHOP-42 reviewer put "full before/after
 * captures and audit table" in `shop-42-review-evidence.md`; the SHOP-28
 * architect wrote two follow-up task specs into one, "including the literal
 * code to land". Every project convention on this instance tells agents to
 * attach their evidence rather than assert it.
 *
 * And the actor a PERSON asks "did it actually prove that?" could read the
 * sentence claiming the proof and never the proof. The distinction between an
 * inherited claim and a verified one is the one this whole pass turns on — the
 * controller made the point itself, about itself, on a run it had sampled:
 * "the citation is inherited, not verified".
 *
 * Text only, and by name. A PNG is not something a reader can take in through
 * this channel, and saying so is better than handing back bytes it will
 * describe as if it had looked.
 */
export interface TaskAttachmentRead {
  name: string;
  bytes: number;
  /** Reported, never hidden: a clipped file that reads as complete is how a
   *  model states half an evidence log as the whole of it. */
  truncated: boolean;
  text: string;
  /** Ruling 551: where this page starts, when it is not the first. */
  offset?: number;
  /** Ruling 551: the offset the next page starts at, on a truncated read. */
  nextOffset?: number;
  /** Ruling 676: what this text leaves out of the file, when it embeds
   *  files a reader takes nothing from. Offsets count the text as returned. */
  leftOut?: string;
}

/** Ruling 676: a text with its embedded files left out, and the sentence that
 *  says so; `leftOut` is null when it embedded none. */
interface EmbeddedFilesLeftOut {
  text: string;
  leftOut: string | null;
}

/** Ruling 676: an embedded file shorter than this stays in the text: a
 *  favicon or a one-pixel spacer costs a reader nothing. */
const EMBEDDED_FILE_MIN_CHARS = 256;

/**
 * A `data:` URI carrying a file in base64: its head, then the payload. The
 * payload is a counted run and then a starred one: a single `{256,}` run
 * overflows the engine's stack on a payload past about 5.5 million
 * characters, one embedded 4 MB picture, and the file then reads as an error
 * at every offset.
 */
const EMBEDDED_FILE_RE = new RegExp(
  `(data:[\\w.+-]*(?:\\/[\\w.+-]+)?(?:;[\\w.+-]+=[\\w.+-]*)*;base64,)([A-Za-z0-9+/]{${EMBEDDED_FILE_MIN_CHARS}}[A-Za-z0-9+/]*={0,2})`,
  "g",
);

/**
 * Ruling 676: a text file as a reader takes it, with the files embedded in it
 * named instead of spelled out.
 *
 * A self-contained HTML page carries its images as `data:` URIs. Live on
 * AWSC-117 the controller, asked to make the report that task delivered the
 * board's template, opened the report's 606 KB source twice: both times its
 * first page was 32,000 characters of a PNG in base64, and the styles and
 * structure it opened the file for lay eighteen pages further on. Base64
 * tells a reader nothing, so each embedded file is replaced where it stands
 * by its length, and the read says how many were left out. The file is
 * untouched: a run's shell still reads its bytes.
 */
export function withoutEmbeddedFiles(text: string): EmbeddedFilesLeftOut {
  let files = 0;
  let chars = 0;
  const kept = text.replace(EMBEDDED_FILE_RE, (_whole, head: string, payload: string) => {
    files += 1;
    chars += payload.length;
    return `${head}[${payload.length.toLocaleString("en-US")} base64 characters left out]`;
  });
  if (files === 0) return { text, leftOut: null };
  return {
    text: kept,
    leftOut:
      `${files === 1 ? "1 embedded file is" : `${files.toLocaleString("en-US")} embedded files are`} left out of this text ` +
      `(${chars.toLocaleString("en-US")} base64 characters in all), each marked where it stands. ` +
      "Offsets count the text as it is returned here; the file on disk is whole.",
  };
}

/**
 * Ruling 551: one page of an attachment's text, from `offset`, and where the
 * next one starts. A read used to stop at the page and offer no way on: the
 * controller asked to copy the table at the end of a 55 KB result could read
 * 11 of its 25 rows, and said so.
 */
function textPage(
  whole: string,
  cutShort: boolean,
  offset: number,
): Pick<TaskAttachmentRead, "text" | "truncated" | "offset" | "nextOffset"> {
  // Ruling 624: a page is at most `READ_PAGE_BYTES` of UTF-8, the most a Codex
  // run's code-mode tool output carries whole (it was 40,000 characters).
  const end = pageEnd(whole, offset);
  const page: Pick<TaskAttachmentRead, "text" | "truncated" | "offset" | "nextOffset"> = {
    text: whole.slice(offset, end),
    // A whole that was itself cut short says so on its last page, with no
    // page after it to offer.
    truncated: cutShort || whole.length > end,
  };
  if (offset > 0) page.offset = offset;
  if (whole.length > end) page.nextOffset = end;
  return page;
}

/** Ruling 551: the most of a rendered file's text (a workbook's sheets, ruling
 *  533; a PDF's pages, ruling 629) a reader can page through. The whole of it
 *  is rendered and sliced like any text, because the renderer stops at whole
 *  lines and a page cut at its budget would skip the rest of the line it
 *  stopped before. */
const RENDERED_TEXT_MAX_CHARS = 16_000_000;

/**
 * Ruling 533: the pictures a reader is handed as the picture itself. A person
 * on a board that delivers results often hands over a screenshot (a portal's
 * VM list, a spreadsheet they could not export), and a coordinator that could
 * only read text triaged that task from the file's name. The ceiling is the
 * model API's own per-image limit: 5 MB once base64-encoded.
 */
const IMAGE_READ_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const IMAGE_READ_MAX_BYTES = 3_750_000;
/** The model API refuses a picture wider or taller than this, and refuses the
 *  whole request with it, so a larger one is named instead of sent. */
const IMAGE_READ_MAX_SIDE = 8000;

/**
 * The image's format and size, read from its own header, or null when the
 * bytes are not the picture the name claims. A file named `.png` that is not
 * one would fail the reader's whole turn at the model API.
 */
export function imageHeader(buf: Buffer): { mimeType: string; width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("latin1", 12, 16) === "IHDR") {
    return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") {
    return { mimeType: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") {
      return { mimeType: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { mimeType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") {
      return { mimeType: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the JPEG's segments to the frame header, which carries the size.
    let at = 2;
    while (at + 9 < buf.length && buf[at] === 0xff) {
      const marker = buf[at + 1]!;
      const length = buf.readUInt16BE(at + 2);
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return { mimeType: "image/jpeg", width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
      at += 2 + length;
    }
    return null;
  }
  return null;
}

export interface TaskAttachmentImage {
  name: string;
  bytes: number;
  mimeType: string;
  /** The file, base64-encoded. */
  data: string;
}

/** The sentence an image read opens with, before the picture itself. */
export function attachmentImageHeader(taskKey: string, image: TaskAttachmentImage): string {
  const kb = Math.max(1, Math.round(image.bytes / 1024));
  return `\`${image.name}\` (${kb} KB, ${image.mimeType}), attached to ${taskKey}. The image follows.`;
}

/** A sentence saying what a file is and why this channel does not carry it. */
interface UnreadableFile {
  unreadable: string;
}

/** What a reader gets for one file: its text (a page of it), the picture
 *  itself, or a sentence saying what the file is and why this channel does
 *  not carry it. */
export type AttachmentContent =
  | ({ kind: "text" } & TaskAttachmentRead)
  | ({ kind: "image" } & TaskAttachmentImage)
  | UnreadableFile;

/** The bytes a reader of `ext` takes at most. */
function readCap(ext: string): number {
  return IMAGE_READ_TYPES.has(ext) ? IMAGE_READ_MAX_BYTES : ext === ".xlsx" ? XLSX_READ_MAX_BYTES : TEXT_READ_MAX_BYTES;
}

/** How much of a file's head the text test reads: git's own window. */
const BINARY_SNIFF_BYTES = 8_000;

/** Ruling 574: a file whose bytes are not text, named with what a reader
 *  takes instead of guessed at from its name. */
function binaryFile(name: string, ext: string, bytes: number, where: string): UnreadableFile {
  return {
    unreadable:
      `\`${name}\` is a binary ${ext || "typeless"} file (${bytes.toLocaleString("en-US")} bytes): its bytes are not text. ` +
      `This reads text files of any name, PDFs (as their text), spreadsheets (.xlsx) and images ` +
      `(${[...IMAGE_READ_TYPES.keys()].join(", ")}). Open it ${where} rather than describing it from its name.`,
  };
}

/** A file over its reader's cap, named rather than read. */
function tooLargeToRead(name: string, ext: string, bytes: number, where: string): AttachmentContent {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const image = IMAGE_READ_TYPES.has(ext);
  const cap = readCap(ext);
  return {
    unreadable:
      `\`${name}\` is ${mb(bytes)} MB; this reads ${image ? "images" : "files like it"} up to ` +
      `${image ? (cap / 1024 / 1024).toFixed(2) : mb(cap)} MB. Open it ${where} rather than describing it from its name.`,
  };
}

/**
 * Ruling 573: one file for a reader, from bytes already in hand: text as
 * text, a spreadsheet as its sheets in CSV (ruling 533), an image as the image
 * after its own header is checked, and (ruling 574) any other file as text
 * unless its bytes are binary. The task's reader and the controller's
 * reader of a message's files share it; `where` says where a person opens the
 * file instead ("on the task page", "in the conversation").
 */
export function readAttachmentContent(name: string, bytes: Buffer, offset: number, where: string): AttachmentContent {
  const ext = path.extname(name).toLowerCase();
  if (bytes.length > readCap(ext)) return tooLargeToRead(name, ext, bytes.length, where);
  return decodeAttachment(name, ext, bytes, offset, where);
}

/** The picture, the workbook or the text, once the bytes are within the cap. */
function decodeAttachment(name: string, ext: string, bytes: Buffer, offset: number, where: string): AttachmentContent {
  const mimeType = IMAGE_READ_TYPES.get(ext);
  if (mimeType) {
    const header = imageHeader(bytes);
    if (!header || header.mimeType !== mimeType) {
      return {
        unreadable: `\`${name}\` is named as a ${ext} image, but its bytes are not one. Open it ${where} rather than describing it from its name.`,
      };
    }
    if (header.width > IMAGE_READ_MAX_SIDE || header.height > IMAGE_READ_MAX_SIDE) {
      return {
        unreadable:
          `\`${name}\` is ${header.width}×${header.height} pixels; this reads images up to ${IMAGE_READ_MAX_SIDE} on a side. ` +
          `Open it ${where} rather than describing it from its name.`,
      };
    }
    return { kind: "image", name, bytes: bytes.length, mimeType, data: bytes.toString("base64") };
  }
  const whole = wholeText(name, ext, bytes, where);
  if ("unreadable" in whole) return whole;
  if (offset > 0 && offset >= whole.text.length) return pastTheEnd(name, whole.text.length, offset);
  const read: AttachmentContent = { kind: "text", name, bytes: bytes.length, ...textPage(whole.text, whole.truncated, offset) };
  if (whole.leftOut) read.leftOut = whole.leftOut;
  return read;
}

/** A file's whole text as a reader takes it, before it is cut into pages. */
interface WholeText {
  text: string;
  /** Whether the renderer stopped before the file's end. */
  truncated: boolean;
  /** Ruling 676: what was left out of it, when anything was. */
  leftOut: string | null;
}

/** The whole text of a file that is not a picture: a workbook as its sheets
 *  in CSV, a PDF as its text layer, any other file as its own text unless its
 *  bytes are binary. */
function wholeText(name: string, ext: string, bytes: Buffer, where: string): WholeText | UnreadableFile {
  if (ext === ".xlsx") {
    const text = xlsxToText(bytes, RENDERED_TEXT_MAX_CHARS);
    if ("unreadable" in text) {
      return { unreadable: `\`${name}\` ${text.unreadable}` };
    }
    return { text: text.text, truncated: text.truncated, leftOut: null };
  }
  // Ruling 629: a PDF reads as its text, through the poppler ruling 566 put in
  // the image, paged like any text.
  if (ext === ".pdf") {
    const text = pdfToText(bytes, RENDERED_TEXT_MAX_CHARS);
    if ("unreadable" in text) {
      return { unreadable: `\`${name}\` ${text.unreadable} Open it ${where} rather than describing it from its name.` };
    }
    return { text: text.text, truncated: text.truncated, leftOut: null };
  }
  // Ruling 574: any other name reads as text unless it names a binary kind
  // or its bytes say otherwise: a NUL in its head (git's own `-text` test,
  // ruling 363's) marks a binary.
  if (
    !READABLE_TEXT_EXTENSIONS.has(ext) &&
    (BINARY_EXTENSIONS.has(ext.slice(1)) || bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))
  ) {
    return binaryFile(name, ext, bytes.length, where);
  }
  const { text, leftOut } = withoutEmbeddedFiles(bytes.toString("utf8"));
  return { text, truncated: false, leftOut };
}

/**
 * Ruling 682: the whole text of a file as a reader takes it, for a check that
 * must see all of it and not a page. Null for a file no reader takes as text:
 * a picture, a binary kind, a PDF with no text layer, one over its reader's
 * cap.
 */
export function attachmentWholeText(name: string, bytes: Buffer): string | null {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_READ_TYPES.has(ext) || bytes.length > readCap(ext)) return null;
  const whole = wholeText(name, ext, bytes, "elsewhere");
  return "unreadable" in whole ? null : whole.text;
}

/**
 * One attachment for a reader, or `null` when this task has no such file:
 * text as text, a spreadsheet as its sheets in CSV (ruling 533), an image as
 * the image. Throws nothing for anything else: the caller is told what the
 * file IS and that this channel does not carry it.
 */
export function readTaskAttachment(
  slug: string,
  key: string,
  name: string,
  dataRoot?: string,
  offset = 0,
  /** Ruling 597: a `deliveredAt` stamp, to read the file as that delivery
   *  held it rather than as the attachments folder holds it now. */
  delivery?: string,
): AttachmentContent | null {
  const wanted = name.trim();
  if (!wanted) return null;
  let abs: string;
  if (delivery) {
    const kept = resolveKeptDeliveryFile(slug, key, delivery, wanted, dataRoot);
    if (!kept) return null;
    abs = kept;
  } else {
    try {
      // `resolveStoreSegment` is the containment check every store path uses —
      // a name with a separator or a `..` never leaves the task's own folder.
      abs = resolveTaskAttachment(slug, key, wanted, dataRoot);
    } catch {
      return null;
    }
  }
  const where = delivery ? "on the task page, which shows its current version," : "on the task page";
  const ext = path.extname(wanted).toLowerCase();
  const read = readAttachmentBytes(abs, readCap(ext));
  if (!read) return null;
  if ("tooLarge" in read) return tooLargeToRead(wanted, ext, read.tooLarge, where);
  return decodeAttachment(wanted, ext, read.bytes, offset, where);
}

function pastTheEnd(name: string, chars: number, offset: number) {
  return {
    unreadable: `\`${name}\` reads as ${chars.toLocaleString("en-US")} characters; offset ${offset.toLocaleString("en-US")} is past its end.`,
  };
}
