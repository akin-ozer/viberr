import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type {
  ParsedProjectFile,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { logger } from "~/server/logging/logger.server";
import { writeFileAtomic } from "./atomic-file.server";
import { withFileLock } from "./file-mutex.server";
import { projectDir, projectFilePath } from "./file-store-root.server";
import {
  parseProjectFileContent,
  serializeProjectFile,
} from "./project-file.server";

/**
 * project.md writer module: frontmatter-preserving atomic writes + the
 * atomic per-project task-key counter (createTask allocation).
 */

export interface ProjectFileRef {
  dataRoot?: string;
  projectSlug: string;
}

export function resolveProjectFilePath(ref: ProjectFileRef): string {
  return projectFilePath(ref.projectSlug, ref.dataRoot);
}

export interface ProjectFileReadResult {
  parsed: ParsedProjectFile;
  diagnostics: FileDiagnostic[];
  content: string;
  absPath: string;
}

export function readProjectFile(
  ref: ProjectFileRef,
): ProjectFileReadResult | null {
  const absPath = resolveProjectFilePath(ref);
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, "utf8");
  const { parsed, diagnostics } = parseProjectFileContent(content, {
    fallbackSlug: ref.projectSlug,
  });
  return { parsed, diagnostics, content, absPath };
}

/**
 * Read-your-own-writes repair for cached bind mounts (P11-51) — the same
 * VirtioFS stale-read hazard the task writer already guards against, applied to
 * project.md. On Docker Desktop a read milliseconds after this process's own
 * atomic rename can return the PREVIOUS content; for project.md that risks
 * resurrecting stale member/agent/policy edits or, worst case, rewinding the
 * `nextTaskNumber` counter (partially mitigated by the dir-scan in
 * allocateTaskKey, but a rewind would still churn keys). Remember what THIS
 * process last wrote per path; when a locked read disagrees and the file's
 * mtime has not advanced past our write (no EXTERNAL writer since), trust our
 * own write. An external edit bumps mtime and wins as before.
 */
const lastWritten = new Map<string, { content: string; wroteAtMs: number }>();
const LAST_WRITTEN_MAX_ENTRIES = 500;

function rememberProjectWrite(absPath: string, content: string): void {
  if (lastWritten.size >= LAST_WRITTEN_MAX_ENTRIES && !lastWritten.has(absPath)) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.delete(absPath);
  lastWritten.set(absPath, { content, wroteAtMs: Date.now() });
}

function repairStaleProjectRead(
  absPath: string,
  current: ProjectFileReadResult,
  ref: ProjectFileRef,
): ParsedProjectFile {
  const remembered = lastWritten.get(absPath);
  if (!remembered || current.content === remembered.content) {
    return current.parsed;
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    return current.parsed;
  }
  if (mtimeMs > remembered.wroteAtMs + 100) return current.parsed;
  logger.warn("stale project-file read repaired from the in-process write cache", {
    projectSlug: ref.projectSlug,
    absPath,
  });
  return parseProjectFileContent(remembered.content, {
    fallbackSlug: ref.projectSlug,
  }).parsed;
}

export async function updateProjectFile(
  ref: ProjectFileRef,
  mutate: (parsed: ParsedProjectFile) => ParsedProjectFile | void,
): Promise<ParsedProjectFile> {
  const absPath = resolveProjectFilePath(ref);
  return withFileLock(absPath, () => {
    const current = readProjectFile(ref);
    if (!current) {
      throw AppError.notFound(`Project not found: ${ref.projectSlug}`);
    }
    const base = repairStaleProjectRead(absPath, current, ref);
    const next = mutate(base) ?? base;
    const serialized = serializeProjectFile(next);
    writeFileAtomic(absPath, serialized);
    rememberProjectWrite(absPath, serialized);
    return next;
  });
}

/** Creates a brand-new project file. Fails (conflict) when it exists. */
export async function createProjectFile(
  ref: ProjectFileRef,
  input: { frontmatter: ProjectFrontmatter; description: string },
): Promise<ParsedProjectFile> {
  const absPath = resolveProjectFilePath(ref);
  return withFileLock(absPath, () => {
    if (existsSync(absPath)) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        message: `Project file already exists: ${absPath}`,
        userMessage: `Project ${ref.projectSlug} already exists.`,
      });
    }
    const parsed: ParsedProjectFile = {
      frontmatter: input.frontmatter,
      unknownFrontmatter: {},
      description: input.description,
    };
    const serialized = serializeProjectFile(parsed);
    writeFileAtomic(absPath, serialized);
    rememberProjectWrite(absPath, serialized);
    return parsed;
  });
}

/** Highest numeric suffix among existing `<PREFIX>-<n>` task directories. */
function scanMaxTaskNumber(ref: ProjectFileRef, prefix: string): number {
  const tasksDir = `${projectDir(ref.projectSlug, ref.dataRoot)}/tasks`;
  if (!existsSync(tasksDir)) return 0;
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = re.exec(entry.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Atomically allocates the next task key (`VIB-169`, …) from the
 * per-project counter in project.md. Falls back to a max-scan of existing
 * task directories when the counter is missing or stale, then persists the
 * bumped counter — concurrent calls can never mint the same key.
 */
export async function allocateTaskKey(ref: ProjectFileRef): Promise<string> {
  const absPath = resolveProjectFilePath(ref);
  return withFileLock(absPath, () => {
    const current = readProjectFile(ref);
    if (!current) {
      throw AppError.notFound(`Project not found: ${ref.projectSlug}`);
    }
    // P11-51: repair a stale read before advancing the counter, so a cached
    // pre-write read can't rewind `nextTaskNumber`.
    const parsed = repairStaleProjectRead(absPath, current, ref);
    const fm = parsed.frontmatter;
    const scanned = scanMaxTaskNumber(ref, fm.taskPrefix);
    const next = Math.max(fm.nextTaskNumber ?? 1, scanned + 1);
    fm.nextTaskNumber = next + 1;
    const serialized = serializeProjectFile(parsed);
    writeFileAtomic(absPath, serialized);
    rememberProjectWrite(absPath, serialized);
    return `${fm.taskPrefix}-${next}`;
  });
}
