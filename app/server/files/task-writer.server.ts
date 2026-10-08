import { existsSync, readFileSync } from "node:fs";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type {
  ParsedTaskFile,
  TaskFileEvent,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { freshestContent, writeAndRemember } from "./write-cache.server";
import { withFileLock } from "./file-mutex.server";
import { taskFilePath } from "./file-store-root.server";
import { parseStoreFile } from "./parse-memo.server";
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

/** Reads + tolerantly parses a task file. Returns null when absent, and for a
 *  key that is not one folder under the project's tasks (ruling 696): a read
 *  finds no task there, as it finds none under a key nobody has used. */
export function readTaskFile(ref: TaskFileRef): TaskFileReadResult | null {
  let absPath: string;
  try {
    absPath = resolveTaskFilePath(ref);
  } catch (error) {
    if (isAppError(error) && error.code === ERROR_CODES.NOT_FOUND) return null;
    throw error;
  }
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, "utf8");
  const { parsed, diagnostics } = parseStoreFile(
    "task-file",
    absPath,
    ref.taskKey,
    content,
    (c) => parseTaskFileContent(c, { fallbackKey: ref.taskKey }),
  );
  return { parsed, diagnostics, content, absPath };
}

/** The content a locked read-modify-write acts on, with the diagnostics of
 *  whichever content won — the write guard below judges THAT content. */
interface FreshTaskFile {
  parsed: ParsedTaskFile;
  diagnostics: FileDiagnostic[];
}

/** The freshest content for a locked read: disk, unless it is provably a
 *  stale cache of our own earlier write (write-cache.server — the VirtioFS
 *  read-your-own-writes repair, shared by every canonical file writer). */
function repairStaleRead(
  absPath: string,
  current: TaskFileReadResult,
  ref: TaskFileRef,
): FreshTaskFile {
  const content = freshestContent(absPath, current.content, {
    kind: "task-file",
    id: ref.taskKey,
  });
  if (content === current.content) {
    return { parsed: current.parsed, diagnostics: current.diagnostics };
  }
  const reparsed = parseTaskFileContent(content, { fallbackKey: ref.taskKey });
  return { parsed: reparsed.parsed, diagnostics: reparsed.diagnostics };
}

/**
 * Refuse to write over a file the parser could only read with FALLBACK
 * DEFAULTS (gap 22).
 *
 * Tolerant parsing is right for READING — a broken file must never crash the
 * app or drop a task. It is catastrophic for WRITING: every mutation here is a
 * read-modify-write, so appending one comment to a task whose frontmatter YAML
 * is unparseable serialized the DEFAULTS over it — owner, stage, engagements,
 * PR link, all gone — and an unterminated `---` fence parses with an empty
 * body, so the same write erased the goal and the entire timeline too. A
 * truncated editor write is precisely the case FR10's hand-editable store must
 * survive, and it was the case that destroyed the file.
 *
 * `hardStop` is exactly the right line: it is set only when the file's own
 * fields could not be read at all (no frontmatter, unterminated fence,
 * unparseable YAML, frontmatter that is not a map). Everything the parser
 * genuinely round-trips — unknown fields, unknown sections, skipped timeline
 * entries — is not hardStop and still writes.
 */
export function taskFileWriteBlockers(
  diagnostics: FileDiagnostic[],
): FileDiagnostic[] {
  return diagnostics.filter((d) => d.hardStop === true);
}

function assertTaskFileTrusted(
  ref: TaskFileRef,
  absPath: string,
  diagnostics: FileDiagnostic[],
): void {
  const blockers = taskFileWriteBlockers(diagnostics);
  if (blockers.length === 0) return;
  const why = blockers.map((d) => d.message).join(" ");
  throw new AppError({
    code: ERROR_CODES.FILE_NOT_TRUSTED,
    status: 409,
    message: `refusing to write ${absPath}: ${why}`,
    userMessage: `${ref.taskKey}'s file can't be read as a task file, so saving would replace what is in it. ${why} Fix the file, or put back the last good copy of it; \`npm run store:check\` names the line.`,
  });
}

/**
 * Locked read-modify-write cycle. `mutate` edits the parsed file in place
 * (or returns a replacement); `updatedAt` is bumped automatically, except for
 * a write that changes no fact of the task (`stamp: false`, ruling 639: a
 * restoration of words an earlier write cut).
 * Returns the parsed file as written.
 */
export async function updateTaskFile(
  ref: TaskFileRef,
  mutate: (parsed: ParsedTaskFile) => ParsedTaskFile | void,
  options: { stamp?: boolean } = {},
): Promise<ParsedTaskFile> {
  const absPath = resolveTaskFilePath(ref);
  return withFileLock(absPath, () => {
    const current = readTaskFile(ref);
    if (!current) {
      throw AppError.notFound(
        `Task file not found: ${ref.projectSlug}/${ref.taskKey}`,
      );
    }
    const fresh = repairStaleRead(absPath, current, ref);
    assertTaskFileTrusted(ref, absPath, fresh.diagnostics);
    const base = fresh.parsed;
    const next = mutate(base) ?? base;
    if (options.stamp !== false) next.frontmatter.updatedAt = new Date().toISOString();
    const serialized = serializeTaskFile(next);
    writeAndRemember(absPath, serialized);
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
    writeAndRemember(absPath, serialized);
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
