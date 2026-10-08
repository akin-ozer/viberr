/**
 * Ruling 690: a task keeps the sources its result rests on.
 *
 * A result states facts from outside: a price, a quote, a date, what a page,
 * a file or a command said. What the run read to state them was nowhere. A
 * fetch tool answers its own summary of a page, the page itself changes, and
 * the run's log goes at thirty days, so a reviewer checked a claim against
 * the page as it read on the day of the review, or against nothing.
 *
 * So a source is kept beside the task's files, in a folder of its own:
 *
 *   projects/<slug>/tasks/<KEY>/sources/
 *     index.jsonl   one JSON object per line, appended only
 *     S1.html       the bytes of source S1 exactly as they were handed over
 *     S2            (the id, then the handed file's extension when it has one)
 *
 * The folder is the server's own. It is not one of the directories a run
 * writes (`TASK_SHARED_DIRS`) and is never shared with the agent group, so
 * where agents run as their own users (ruling 460) an agent reads a kept
 * source and cannot change it. This module is the only writer: it never opens
 * an existing bytes file for writing, and the index only grows.
 *
 * What a run means to keep it first saves in the task's attachments folder,
 * the one task folder it writes, under a name that starts with
 * `SOURCE_STAGING_PREFIX`. A name that starts with a dot is listed by no
 * reader of that folder, so a staged file is never a completing run's file
 * and never part of a delivery, whichever run completes while it waits.
 *
 * File operations only. The action that decides whether a file may be kept,
 * and audits it, is `tasks/task-sources.server.ts`.
 */
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { MAX_UPLOAD_BYTES } from "~/shared/attachment-kinds";
import { sha256Hex } from "./content-hash.server";
import { projectDir, resolveStoreSegment, storedFileName, taskDir } from "./file-store-root.server";
import {
  readAttachmentBytes,
  readAttachmentContent,
  type AttachmentContent,
} from "./task-attachments.server";

/** The most one source holds: what a person's upload may (10 MB). */
export const SOURCE_MAX_BYTES = MAX_UPLOAD_BYTES;
/** The most sources one task keeps. */
const SOURCES_PER_TASK_MAX = 200;
/** The most bytes one task's sources come to together. */
const SOURCES_TASK_MAX_BYTES = 100 * 1024 * 1024;
/** A source's title is one line a reader names it by. */
export const SOURCE_TITLE_MAX = 200;
/** Where it came from: a URL, a command, or `owner/repo@<commit>:path`. */
export const SOURCE_FROM_MAX = 2000;

/**
 * How a file staged for a keep is named in the task's attachments folder:
 * this prefix, then the name the source is kept under. The dot is what the
 * rule rests on: every lister of that folder skips a dot-name (the run's
 * window of ruling 593, the delivery's files of ruling 610, the panel), and
 * no upload, relay or take can land one. The rest keeps the name apart from
 * the store's own working files there (`.viberr-write-`, `.viberr-prev-`),
 * which hold somebody else's bytes.
 */
export const SOURCE_STAGING_PREFIX = ".source-";

/** The name a staged file is kept under, or null for a name that is not a
 *  staged source's. */
export function stagedSourceName(file: string): string | null {
  return file.startsWith(SOURCE_STAGING_PREFIX) && file.length > SOURCE_STAGING_PREFIX.length
    ? file.slice(SOURCE_STAGING_PREFIX.length)
    : null;
}

const INDEX_FILE = "index.jsonl";
/** A source's id: `S` and its number, counted from 1 on each task. */
const SOURCE_ID_RE = /^S([1-9]\d{0,5})$/;
/** A bytes file in the folder: the id, then the extension it was given. */
const SOURCE_FILE_RE = /^S([1-9]\d{0,5})(?:\.[a-z0-9]{1,10})?$/;
/** The extension a stored name keeps from the handed file's. */
const KEPT_EXTENSION_RE = /^\.[a-z0-9]{1,10}$/;

/** The agent that kept a source, as its record names it. */
export interface SourceKeeper {
  backend: string;
  profileId: string;
  roleHint: string | null;
}

/** One kept source: its record in the index. */
export interface TaskSource {
  /** `S1`, `S2` and so on: stable, and never given to another source. */
  id: string;
  /** The bytes file in the folder: the id and the handed file's extension. */
  file: string;
  /** The name the agent saved the file under, which decides how it reads. */
  name: string;
  title: string;
  /** Where the bytes came from, as the agent that kept them stated it. */
  from: string;
  keptAt: string;
  by: SourceKeeper;
  runId: string | null;
  bytes: number;
  sha256: string;
}

/** The sources a task held when one of its deliveries was stamped. */
export interface DeliverySources {
  deliveredAt: string;
  sources: string[];
}

/** A task's index, read: its sources by id, and its deliveries as written. */
export interface TaskSourcesRead {
  sources: TaskSource[];
  deliveries: DeliverySources[];
}

const sourceLineSchema = z.object({
  kind: z.literal("source"),
  id: z.string().regex(SOURCE_ID_RE),
  file: z.string().regex(SOURCE_FILE_RE),
  name: z.string(),
  title: z.string(),
  from: z.string(),
  keptAt: z.string(),
  by: z.object({ backend: z.string(), profileId: z.string(), roleHint: z.string().nullable() }),
  runId: z.string().nullable(),
  bytes: z.number().int().min(0),
  sha256: z.string(),
});

const deliveryLineSchema = z.object({
  kind: z.literal("delivery"),
  deliveredAt: z.string(),
  sources: z.array(z.string()),
});

const indexLineSchema = z.discriminatedUnion("kind", [sourceLineSchema, deliveryLineSchema]);

function taskSourcesDir(slug: string, key: string, dataRoot?: string): string {
  return path.join(taskDir(slug, key, dataRoot), "sources");
}

/** A source id's number, for ordering: S2 before S10. */
function idNumber(id: string): number {
  return Number(SOURCE_ID_RE.exec(id)?.[1] ?? 0);
}

/** The index as it stands on disk, or "" when the task keeps nothing. */
function readIndexText(dir: string): string {
  const index = path.join(dir, INDEX_FILE);
  // Checked first: the task page's loader calls this on every task, and a
  // task that keeps no sources must cost it no store read (ruling 457).
  if (!existsSync(index)) return "";
  try {
    return readFileSync(index, "utf8");
  } catch {
    return "";
  }
}

/** Each line on its own: a torn or foreign line is skipped, and the lines
 *  around it still read. */
function parseIndex(text: string): TaskSourcesRead {
  const sources: TaskSource[] = [];
  const deliveries: DeliverySources[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = indexLineSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      if (parsed.data.kind === "source") {
        const { kind: _source, ...source } = parsed.data;
        // An id is given once. A second line under it is not this module's
        // write, and the first one stands.
        if (!sources.some((s) => s.id === source.id)) sources.push(source);
      } else {
        deliveries.push({ deliveredAt: parsed.data.deliveredAt, sources: parsed.data.sources });
      }
    } catch {
      // Not JSON: a line cut short by a crash.
    }
  }
  sources.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  return { sources, deliveries };
}

/**
 * A task's kept sources, in id order, and what each kept delivery rested on.
 * One read of the index whatever the count; a task that keeps none answers
 * empty lists without reading anything.
 */
export function readTaskSources(slug: string, key: string, dataRoot?: string): TaskSourcesRead {
  return parseIndex(readIndexText(taskSourcesDir(slug, key, dataRoot)));
}

/** One more line on the index. A line a crash cut short has no newline after
 *  it, so the next one starts its own line and is not read as its tail. */
function appendIndexLine(dir: string, before: string, record: z.infer<typeof indexLineSchema>): void {
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  appendFileSync(path.join(dir, INDEX_FILE), `${lead}${JSON.stringify(record)}\n`, { mode: 0o644 });
}

/** What a keep hands the store. */
export interface SourceToKeep {
  /** The file's name as the agent saved it. */
  name: string;
  data: Buffer;
  title: string;
  from: string;
  by: SourceKeeper;
  runId: string | null;
}

/** A keep's answer: the new source; the one that already holds these bytes;
 *  or the one that held them until its bytes were taken out of the store. */
export type SourceWriteResult = { kept: TaskSource } | { already: TaskSource } | { removed: TaskSource };

const MB = 1024 * 1024;

/**
 * Keep one source. Synchronous from the index read to the append: one process
 * writes a data root, so nothing else can take the id in between.
 *
 * Bytes a task already keeps answer with that source and write nothing. Bytes
 * whose record stands while its bytes file is gone answer `removed`: a person
 * took that source out of the store (docs/operations/runbook.md), and the
 * same bytes are not kept again under a new id. A new source takes the number
 * after the highest one the index or the folder has seen, so a bytes file a
 * crash left without its record is stepped over and never replaced. The bytes
 * are written to a name that must not exist, then the record is appended; if
 * the append fails the bytes go, and nothing is kept. Throws
 * `AppError.validation`, with the sentence an agent reads, when the task
 * already keeps as many sources as it may or has no room left for these bytes.
 */
export function writeTaskSource(
  slug: string,
  key: string,
  input: SourceToKeep,
  dataRoot?: string,
): SourceWriteResult {
  const dir = taskSourcesDir(slug, key, dataRoot);
  const before = readIndexText(dir);
  const { sources } = parseIndex(before);
  const sha256 = sha256Hex(input.data);
  const already = sources.find((s) => s.sha256 === sha256);
  if (already) return existsSync(path.join(dir, already.file)) ? { already } : { removed: already };
  if (sources.length >= SOURCES_PER_TASK_MAX) {
    throw AppError.validation(
      `${key} keeps ${SOURCES_PER_TASK_MAX} sources, the most a task holds. Cite one already kept (\`read_task_source\` lists them), ` +
        `or say in your result which claim has no kept source.`,
    );
  }
  const keptBytes = sources.reduce((sum, s) => sum + s.bytes, 0);
  if (keptBytes + input.data.length > SOURCES_TASK_MAX_BYTES) {
    // What is left is rounded down and the file up, so the two figures never
    // read as if the file fitted.
    const left = Math.floor((Math.max(0, SOURCES_TASK_MAX_BYTES - keptBytes) / MB) * 10) / 10;
    const size = Math.ceil((input.data.length / MB) * 10) / 10;
    throw AppError.validation(
      `${key} keeps ${(keptBytes / MB).toFixed(1)} MB of sources and a task may keep ${SOURCES_TASK_MAX_BYTES / MB} MB, ` +
        `so ${left.toFixed(1)} MB is left and this file is ${size.toFixed(1)} MB. ` +
        `Save the part your claim rests on as its own file and keep that, or cite a source already kept (\`read_task_source\` lists them).`,
    );
  }
  // Ruling 460: a plain directory of the server's, never handed to the agent
  // group, so an agent reads what is kept here and cannot write it.
  mkdirSync(dir, { recursive: true });
  let highest = 0;
  for (const source of sources) highest = Math.max(highest, idNumber(source.id));
  for (const entry of readdirSync(dir)) {
    const standing = SOURCE_FILE_RE.exec(entry);
    if (standing) highest = Math.max(highest, Number(standing[1]));
  }
  const id = `S${highest + 1}`;
  const name = storedFileName(input.name);
  const ext = path.extname(name).toLowerCase();
  const file = KEPT_EXTENSION_RE.test(ext) ? `${id}${ext}` : id;
  const abs = path.join(dir, file);
  const kept: TaskSource = {
    id,
    file,
    name,
    title: input.title,
    from: input.from,
    keptAt: new Date().toISOString(),
    by: input.by,
    runId: input.runId,
    bytes: input.data.length,
    sha256,
  };
  // Created, never opened: a name that already stands fails the open.
  const fd = openSync(
    abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    try {
      writeFileSync(fd, input.data);
    } finally {
      closeSync(fd);
    }
    appendIndexLine(dir, before, { kind: "source", ...kept });
  } catch (error) {
    // No record, so no source: the bytes do not stay behind as one.
    try {
      unlinkSync(abs);
    } catch {
      // Already gone.
    }
    throw error;
  }
  return { kept };
}

/**
 * Record, on the index, the sources a task holds as one of its deliveries is
 * stamped. A task that keeps none gets no line and no folder; a delivery
 * already recorded keeps the line it has. Returns the ids on the line.
 */
export function recordDeliverySources(
  slug: string,
  key: string,
  deliveredAt: string,
  dataRoot?: string,
): string[] {
  const dir = taskSourcesDir(slug, key, dataRoot);
  const before = readIndexText(dir);
  const { sources, deliveries } = parseIndex(before);
  if (sources.length === 0) return [];
  const recorded = deliveries.find((d) => d.deliveredAt === deliveredAt);
  if (recorded) return recorded.sources;
  const ids = sources.map((s) => s.id);
  appendIndexLine(dir, before, { kind: "delivery", deliveredAt, sources: ids });
  return ids;
}

/** A kept source and where its bytes are. */
export interface ResolvedTaskSource {
  source: TaskSource;
  abs: string;
}

/** One source by its id, or null for an id the task does not keep. */
export function resolveTaskSource(
  slug: string,
  key: string,
  id: string,
  dataRoot?: string,
): ResolvedTaskSource | null {
  const wanted = id.trim();
  if (!SOURCE_ID_RE.test(wanted)) return null;
  try {
    // The key arrives from a URL as well as from the board: it is one folder
    // under the project's tasks, or it names nothing.
    resolveStoreSegment(path.join(projectDir(slug, dataRoot), "tasks"), key);
    const source = readTaskSources(slug, key, dataRoot).sources.find((s) => s.id === wanted);
    if (!source) return null;
    // The record names the bytes file; it is still held to one name in the folder.
    return { source, abs: resolveStoreSegment(taskSourcesDir(slug, key, dataRoot), source.file) };
  } catch {
    return null;
  }
}

/** A kept source as a reader takes it. */
export interface TaskSourceRead {
  source: TaskSource;
  content: AttachmentContent;
}

/**
 * One source for a reader, read as a task file is (`readAttachmentContent`):
 * text in pages, a PDF as its text, a spreadsheet as CSV, an image as the
 * picture, and an HTML page as its source text with embedded files left out
 * (ruling 676). Null for an id the task does not keep.
 */
export function readTaskSource(
  slug: string,
  key: string,
  id: string,
  dataRoot?: string,
  offset = 0,
): TaskSourceRead | null {
  const resolved = resolveTaskSource(slug, key, id, dataRoot);
  if (!resolved) return null;
  const { source, abs } = resolved;
  const read = readAttachmentBytes(abs, SOURCE_MAX_BYTES);
  if (!read || "tooLarge" in read) {
    return {
      source,
      content: {
        unreadable: `${source.id} (\`${source.name}\`) is on ${key}'s list of sources, but its bytes are not in the store as they were kept.`,
      },
    };
  }
  return {
    source,
    content: readAttachmentContent(source.name, read.bytes, offset, "under Sources on the task page"),
  };
}

/** How much of where a source came from a row on the task page carries. */
const SOURCE_FROM_SHOWN = 200;

/** Where a source came from, cut for a row on the task page. A reader's
 *  listing and the record itself keep it whole. */
export function sourceFromShown(from: string): string {
  return from.length > SOURCE_FROM_SHOWN ? `${from.slice(0, SOURCE_FROM_SHOWN - 1)}…` : from;
}

/**
 * Ruling 690: the ids of the sources a files delivery rested on. The line
 * written when it was stamped decides. A delivery with no line (the task kept
 * nothing then, so none was written, or the write failed) rested on what was
 * kept at or before its stamp.
 */
export function deliverySourceIds(read: TaskSourcesRead, deliveredAt: string): string[] {
  const recorded = read.deliveries.find((d) => d.deliveredAt === deliveredAt);
  if (recorded) return recorded.sources;
  const stamp = Date.parse(deliveredAt);
  return read.sources.filter((s) => Date.parse(s.keptAt) <= stamp).map((s) => s.id);
}

/**
 * A task's sources as text: what each delivery rested on, then one block a
 * source with its id, the name it was saved under, its size and its SHA-256,
 * its title, where it came from, and when, by which agent and in which run it
 * was kept. `delivered` is the stamps of the task's kept deliveries (ruling
 * 597), so one stamped while the task kept nothing is named too, as resting
 * on no kept source, and a reader is not left to wonder which delivery a
 * source kept later belongs under.
 */
export function sourcesListing(read: TaskSourcesRead, delivered: readonly string[] = []): string {
  const stamps = [...new Set([...read.deliveries.map((d) => d.deliveredAt), ...delivered])].sort();
  const deliveries = stamps.map((stamp) => {
    const ids = deliverySourceIds(read, stamp);
    return ids.length > 0
      ? `Delivery ${stamp} rested on: ${ids.join(", ")}`
      : `Delivery ${stamp} rested on no kept source`;
  });
  // What was kept after the newest delivery is under no line above. A reader
  // checking a claim has to see it, and whose it is: one the task's deliverer
  // kept (asked for the source of a claim, it keeps one and changes no file)
  // counts as what the result rests on (`sourcesRestedOn`).
  const newest = stamps.at(-1);
  if (newest) {
    const under = new Set(deliverySourceIds(read, newest));
    const later = read.sources.filter((s) => !under.has(s.id) && Date.parse(s.keptAt) > Date.parse(newest));
    if (later.length > 0) {
      deliveries.push(
        `Kept after it: ${later.map((s) => `${s.id} by agent:${s.by.profileId}`).join(", ")}. ` +
          `One the task's deliverer kept counts as what its result rests on; one a reviewer kept while checking does not.`,
      );
    }
  }
  const sources = read.sources.map(
    (s) =>
      `${s.id} · ${s.name} · ${s.bytes.toLocaleString("en-US")} bytes · sha256 ${s.sha256}\n` +
      `title: ${s.title}\n` +
      `from: ${s.from}\n` +
      `kept: ${s.keptAt} by agent:${s.by.profileId}${s.runId ? ` (run ${s.runId})` : ""}`,
  );
  const blocks: string[] = [];
  if (deliveries.length > 0) blocks.push(deliveries.join("\n"));
  blocks.push(...sources);
  return blocks.join("\n\n");
}
