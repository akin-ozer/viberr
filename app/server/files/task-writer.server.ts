import { existsSync, readFileSync } from "node:fs";
import { AppError } from "~/server/errors/app-error.server";
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
    const next = mutate(current.parsed) ?? current.parsed;
    next.frontmatter.updatedAt = new Date().toISOString();
    writeFileAtomic(absPath, serializeTaskFile(next));
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
    writeFileAtomic(absPath, serializeTaskFile(parsed));
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

/** Sets (replaces) the active decision packet. */
export async function setTaskPacket(
  ref: TaskFileRef,
  packet: TaskPacket,
  patch?: Partial<TaskFrontmatter>,
): Promise<ParsedTaskFile> {
  return updateTaskFile(ref, (parsed) => {
    parsed.packet = packet;
    if (patch) Object.assign(parsed.frontmatter, patch);
  });
}

/** Clears the active decision packet (the `## Packet` section disappears). */
export async function clearTaskPacket(
  ref: TaskFileRef,
  patch?: Partial<TaskFrontmatter>,
): Promise<ParsedTaskFile> {
  return updateTaskFile(ref, (parsed) => {
    parsed.packet = null;
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
