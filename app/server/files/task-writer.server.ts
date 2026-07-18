import { existsSync, readFileSync, statSync } from "node:fs";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type {
  ParsedTaskFile,
  TaskFileEvent,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { writeFileAtomic } from "./atomic-file.server";
import { withFileLock } from "./file-mutex.server";
import { taskFilePath } from "./file-store-root.server";
import {
  parseTaskFileContent,
  serializeTaskFile,
} from "./task-file.server";

/**
 * task.md writer module: frontmatter-preserving atomic writes (temp file +
 * rename), event append (newest-first prepend), packet set/clear, task
 * create. Every mutation runs under a per-file in-process mutex so
 * concurrent actions never interleave read-modify-write cycles.
 *
 * Unknown frontmatter fields and unknown `## Sections` survive every write.
 */

export interface TaskFileRef {
  dataRoot?: string;
  projectSlug: string;
  taskKey: string;
}

export function resolveTaskFilePath(ref: TaskFileRef): string {
  return taskFilePath(ref.projectSlug, ref.taskKey, ref.dataRoot);
}

export interface TaskFileReadResult {
  parsed: ParsedTaskFile;
  diagnostics: FileDiagnostic[];
  content: string;
  absPath: string;
}

/** Reads + tolerantly parses a task file. Returns null when absent. */
export function readTaskFile(ref: TaskFileRef): TaskFileReadResult | null {
  const absPath = resolveTaskFilePath(ref);
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, "utf8");
  const { parsed, diagnostics } = parseTaskFileContent(content, {
    fallbackKey: ref.taskKey,
  });
  return { parsed, diagnostics, content, absPath };
}

/**
 * Read-your-own-writes repair for cached bind mounts. On Docker Desktop
 * (VirtioFS), a read milliseconds after this process's own atomic rename can
 * return the PREVIOUS file content — observed live (VIB-1, 2026-07-17): the
 * reviewer's reply comment landed on disk, the next locked read-modify-write
 * (the verdict, 2 ms later) read the stale pre-comment content, and its write
 * erased the comment permanently. Remember the last content THIS process
 * wrote per path; when a locked read disagrees and the file's mtime has not
 * advanced past our write (i.e. no EXTERNAL writer touched it since), trust
 * our own write. An external edit (human editing task.md, another process)
 * bumps mtime past the recorded write time and wins as before.
 */
const lastWritten = new Map<string, { content: string; wroteAtMs: number }>();
const LAST_WRITTEN_MAX_ENTRIES = 500;

function rememberWrite(absPath: string, content: string): void {
  if (lastWritten.size >= LAST_WRITTEN_MAX_ENTRIES && !lastWritten.has(absPath)) {
    // Crude bound: drop the oldest entry (Map preserves insertion order).
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.delete(absPath); // re-insert at the tail (freshest last)
  lastWritten.set(absPath, { content, wroteAtMs: Date.now() });
}

/**
 * Read-your-own-writes slack. VirtioFS can serve a stale read (or a stale
 * content cache under a freshly-advanced mtime) for a surprisingly long window
 * after our own rename — 100 ms was too tight and let concurrent completions
 * (a reviewer verdict landing while the operator reacts) read a pre-write file
 * and erase each other's timeline entries. Only THIS process writes task.md
 * (the app is the single writer; humans edit through the UI), and the chokidar
 * watcher re-projects any genuine external edit on its own, so a generous
 * window that trusts our own recent write is safe.
 */
const STALE_READ_SLACK_MS = 4000;

/**
 * The freshest content for a path: the disk read, unless it is provably a stale
 * cache of our own recent write (content disagrees with what we last wrote AND
 * the file's mtime has not advanced past our write by the slack — i.e. no
 * external writer touched it since). Centralized so BOTH the locked
 * read-modify-write AND the projector read coherently — the projector used to
 * read raw and could publish a timeline missing a just-written comment.
 */
export function coherentTaskContent(absPath: string, diskContent: string): string {
  const remembered = lastWritten.get(absPath);
  if (!remembered || diskContent === remembered.content) return diskContent;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    return diskContent;
  }
  if (mtimeMs > remembered.wroteAtMs + STALE_READ_SLACK_MS) return diskContent;
  logger.warn("stale task-file read served from the in-process write cache", { absPath });
  return remembered.content;
}

/** Coherent disk read of a task file (null when absent) — for readers outside
 *  updateTaskFile (the projector). */
export function readCoherentTaskContent(absPath: string): string | null {
  let disk: string;
  try {
    disk = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  return coherentTaskContent(absPath, disk);
}

function repairStaleRead(
  absPath: string,
  current: TaskFileReadResult,
  ref: TaskFileRef,
): ParsedTaskFile {
  const coherent = coherentTaskContent(absPath, current.content);
  if (coherent === current.content) return current.parsed;
  return parseTaskFileContent(coherent, { fallbackKey: ref.taskKey }).parsed;
}

/**
 * Locked read-modify-write cycle. `mutate` edits the parsed file in place
 * (or returns a replacement); `updatedAt` is bumped automatically.
 * Returns the parsed file as written.
 */
export async function updateTaskFile(
  ref: TaskFileRef,
  mutate: (parsed: ParsedTaskFile) => ParsedTaskFile | void,
): Promise<ParsedTaskFile> {
  const absPath = resolveTaskFilePath(ref);
  return withFileLock(absPath, () => {
    const current = readTaskFile(ref);
    if (!current) {
      throw AppError.notFound(
        `Task file not found: ${ref.projectSlug}/${ref.taskKey}`,
      );
    }
    const base = repairStaleRead(absPath, current, ref);
    const next = mutate(base) ?? base;
    next.frontmatter.updatedAt = new Date().toISOString();
    const serialized = serializeTaskFile(next);
    writeFileAtomic(absPath, serialized);
    rememberWrite(absPath, serialized);
    return next;
  });
}

/** Creates a brand-new task file. Fails (conflict) when it already exists. */
export async function createTaskFile(
  ref: TaskFileRef,
  input: {
    frontmatter: TaskFrontmatter;
    goal: string;
    packet?: TaskPacket | null;
    timeline?: TaskFileEvent[];
  },
): Promise<ParsedTaskFile> {
  const absPath = resolveTaskFilePath(ref);
  return withFileLock(absPath, () => {
    if (existsSync(absPath)) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        message: `Task file already exists: ${absPath}`,
        userMessage: `Task ${ref.taskKey} already exists.`,
        kind: "user",
      });
    }
    const parsed: ParsedTaskFile = {
      frontmatter: input.frontmatter,
      unknownFrontmatter: {},
      goal: input.goal,
      packet: input.packet ?? null,
      timeline: input.timeline ?? [],
      extraSections: [],
    };
    const serialized = serializeTaskFile(parsed);
    writeFileAtomic(absPath, serialized);
    rememberWrite(absPath, serialized);
    return parsed;
  });
}

/** Prepends a typed event (timeline is newest-first). */
export async function appendTimelineEvent(
  ref: TaskFileRef,
  event: TaskFileEvent,
  patch?: Partial<TaskFrontmatter>,
): Promise<ParsedTaskFile> {
  return updateTaskFile(ref, (parsed) => {
    parsed.timeline.unshift(event);
    if (patch) Object.assign(parsed.frontmatter, patch);
  });
}

/** Frontmatter-only patch (ownership, stage, readiness...). */
export async function patchTaskFrontmatter(
  ref: TaskFileRef,
  patch: Partial<TaskFrontmatter>,
): Promise<ParsedTaskFile> {
  return updateTaskFile(ref, (parsed) => {
    Object.assign(parsed.frontmatter, patch);
  });
}
