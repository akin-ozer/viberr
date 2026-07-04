import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type {
  ParsedProjectFile,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
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
    const next = mutate(current.parsed) ?? current.parsed;
    writeFileAtomic(absPath, serializeProjectFile(next));
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
        kind: "user",
      });
    }
    const parsed: ParsedProjectFile = {
      frontmatter: input.frontmatter,
      unknownFrontmatter: {},
      description: input.description,
    };
    writeFileAtomic(absPath, serializeProjectFile(parsed));
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
    const fm = current.parsed.frontmatter;
    const scanned = scanMaxTaskNumber(ref, fm.taskPrefix);
    const next = Math.max(fm.nextTaskNumber ?? 1, scanned + 1);
    fm.nextTaskNumber = next + 1;
    writeFileAtomic(absPath, serializeProjectFile(current.parsed));
    return `${fm.taskPrefix}-${next}`;
  });
}
