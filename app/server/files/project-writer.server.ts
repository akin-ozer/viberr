import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freshestContent, writeAndRemember } from "./write-cache.server";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type {
  ParsedProjectFile,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { withFileLock } from "./file-mutex.server";
import { projectDir, projectFilePath } from "./file-store-root.server";
import { parseStoreFile } from "./parse-memo.server";
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
  const { parsed, diagnostics } = parseStoreFile(
    "project-file",
    absPath,
    ref.projectSlug,
    content,
    (c) => parseProjectFileContent(c, { fallbackSlug: ref.projectSlug }),
  );
  return { parsed, diagnostics, content, absPath };
}

/** The content a locked read-modify-write acts on, with the diagnostics of
 *  whichever content won — the write guard below judges THAT content.
 *  (`FreshTaskFile`'s project sibling.) */
interface FreshProjectFile {
  parsed: ParsedProjectFile;
  diagnostics: FileDiagnostic[];
}

/** See write-cache.server — the shared VirtioFS read-your-own-writes repair
 *  (P11-51). For project.md a stale read would resurrect old member, agent or
 *  policy edits, or rewind the `nextTaskNumber` counter (the dir-scan in
 *  allocateTaskKey only partly covers that, and a rewind still churns keys).
 *  Carries the diagnostics of whichever content won, so the trust gate below
 *  judges the bytes that are actually about to be re-serialized. */
function repairStaleProjectRead(
  absPath: string,
  current: ProjectFileReadResult,
  ref: ProjectFileRef,
): FreshProjectFile {
  const content = freshestContent(absPath, current.content, {
    kind: "project-file",
    id: ref.projectSlug,
  });
  if (content === current.content) {
    return { parsed: current.parsed, diagnostics: current.diagnostics };
  }
  const reparsed = parseProjectFileContent(content, {
    fallbackSlug: ref.projectSlug,
  });
  return { parsed: reparsed.parsed, diagnostics: reparsed.diagnostics };
}

/**
 * Gap 22, for project.md — the guard task.md and the goal files have had and
 * this writer never got.
 *
 * Tolerant parsing is right for READING: a broken project.md must not take the
 * app down. It is catastrophic for WRITING, because every write here is a
 * read-modify-write. One unterminated `---` fence or one YAML typo parses to
 * DEFAULTS, and the next ordinary write — renaming the project, or merely
 * creating a task, which advances `nextTaskNumber` — serializes those defaults
 * over the file: members, roles, stages, the workflow, the attached repo, the
 * deployed agents, guardrails and the key counter, all gone, with the toast
 * reporting success.
 *
 * `hardStop` is the same line `taskFileWriteBlockers` draws: set only when the
 * file's own fields could not be read at all (no frontmatter, unterminated
 * fence, unparseable YAML, frontmatter that is not a map). Everything the
 * parser genuinely round-trips — unknown fields, a skipped row — still writes.
 */
function assertProjectFileTrusted(
  ref: ProjectFileRef,
  absPath: string,
  diagnostics: FileDiagnostic[],
): void {
  const blockers = diagnostics.filter((d) => d.hardStop === true);
  if (blockers.length === 0) return;
  const why = blockers.map((d) => d.message).join(" ");
  throw new AppError({
    code: ERROR_CODES.FILE_NOT_TRUSTED,
    status: 409,
    message: `refusing to write ${absPath}: ${why}`,
    userMessage: `${ref.projectSlug}'s project file can't be read as a project file, so saving would replace what is in it. ${why} Fix the file, or put back the last good copy of it; \`npm run store:check\` names the line.`,
  });
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
    const fresh = repairStaleProjectRead(absPath, current, ref);
    assertProjectFileTrusted(ref, absPath, fresh.diagnostics);
    const base = fresh.parsed;
    const next = mutate(base) ?? base;
    const serialized = serializeProjectFile(next);
    writeAndRemember(absPath, serialized);
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
    writeAndRemember(absPath, serialized);
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
  let key = "";
  // P11-51: `updateProjectFile` repairs a stale read before the counter
  // advances, so a cached pre-write read can't rewind `nextTaskNumber`.
  await updateProjectFile(ref, ({ frontmatter: fm }) => {
    const scanned = scanMaxTaskNumber(ref, fm.taskPrefix);
    const next = Math.max(fm.nextTaskNumber ?? 1, scanned + 1);
    fm.nextTaskNumber = next + 1;
    key = `${fm.taskPrefix}-${next}`;
  });
  return key;
}
