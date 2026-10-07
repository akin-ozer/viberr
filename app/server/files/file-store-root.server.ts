import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.server";
import { AppError } from "../errors/app-error.server";

/**
 * Data-root bootstrap + path helpers for the file-native store.
 *
 * Layout under ${VIBERR_DATA_ROOT}:
 *   projects/<slug>/project.md
 *   projects/<slug>/tasks/<KEY>/task.md
 *   projects/<slug>/tasks/<KEY>/attachments/   (R19-19 — files an agent's
 *                                          browser produces: screenshots, PDFs;
 *                                          served member-only, cited as evidence)
 *   agents/profiles/<id>.md               (org-level agent profile templates)
 *   runtimes/                             (NDJSON run logs — Phase 8)
 *   runtimes/users/<userId>/claude-home   (ruling 127 — that person's own
 *   runtimes/users/<userId>/codex-home     vendor sign-in + provider sessions)
 *   kb/<dir>/                             (knowledge-base folders — Phase 9B;
 *                                          UI renders them as store://kb/<dir>/)
 *   skills/<name>/SKILL.md                (skill folders — Phase 9B;
 *                                          store://skills/<name>/)
 *   state/projection.sqlite               (SQLite — managed by db/)
 *
 * UI copy renders REAL store-relative paths (orchestrator ruling 3):
 * `projects/viberr-core/tasks/VIB-142/task.md`, never the mock's `.viberr/…`.
 */

export const DATA_ROOT_SUBDIRS = [
  "projects",
  "agents",
  "agents/profiles",
  "runtimes",
  // Ruling 127: the per-person runtime homes. The deployment-wide
  // `runtimes/claude-home` / `runtimes/codex-home` are gone — a credential in a
  // shared home is a credential every run bills to whoever owns it. Each
  // person's `runtimes/users/<userId>/{claude-home,codex-home}` is created
  // 0o700 on demand by `ensureUserBackendHome` (user-homes.server.ts); the
  // parent is created here so the documented tree (and the backup, retention
  // and runbook entries that name it) is true on a fresh root.
  "runtimes/users",
  "kb",
  "skills",
  // Ruling 102: the purge's durable export of expiring audit rows (A00-6,
  // pass 32 — created here so every root shows the folder the runbook, the
  // backup and file-formats.md all name, not only roots that already purged).
  "audit-exports",
  "state",
] as const;

/** Absolute, resolved data root. Pass an explicit root in tests/scripts. */
export function getDataRoot(dataRoot?: string): string {
  return path.resolve(dataRoot ?? getEnv().VIBERR_DATA_ROOT);
}

/** Ensures every expected data-root subdirectory exists. Called at boot. */
export function ensureDataRootDirs(dataRoot?: string): string {
  const root = getDataRoot(dataRoot);
  for (const dir of DATA_ROOT_SUBDIRS) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

export function projectsDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "projects");
}

export function projectDir(slug: string, dataRoot?: string): string {
  return path.join(projectsDir(dataRoot), slug);
}

export function projectFilePath(slug: string, dataRoot?: string): string {
  return path.join(projectDir(slug, dataRoot), "project.md");
}

/**
 * One task's folder. Ruling 695: the key is one folder under the project's
 * tasks, or it names no task.
 *
 * A key arrives from a URL and from an agent's tool call as well as from the
 * board, and this used to `path.join` it unchecked. React Router decodes
 * `%2F` inside a path param, so `/projects/a/tasks/..%2F..%2Fb%2Ftasks%2FB-1`
 * passed project a's membership check and named project b's task: a member of
 * one project was served another's attachments, and the task page's actions
 * (a comment, an upload, a goal edit, a removal, an archive) wrote that
 * task's file. Every path of a task is built from this one, so the refusal
 * is here, and it is the answer an unknown key gets.
 */
export function taskDir(slug: string, key: string, dataRoot?: string): string {
  const tasks = path.join(projectDir(slug, dataRoot), "tasks");
  try {
    return resolveStoreSegment(tasks, key);
  } catch {
    throw AppError.notFound(`No task ${key} in projects/${slug}.`);
  }
}

export function taskFilePath(
  slug: string,
  key: string,
  dataRoot?: string,
): string {
  return path.join(taskDir(slug, key, dataRoot), "task.md");
}

/**
 * R19-19: one task's attachments — files an agent's browser produced
 * (screenshots, PDFs, downloads). Written by the browser MCP server via
 * `--output-dir`, listed on the task page, served member-only by the
 * attachment route. Lives inside the task dir so archive/delete flows that
 * move the task move its attachments with it, with no retention machinery.
 */
export function taskAttachmentsDir(
  slug: string,
  key: string,
  dataRoot?: string,
): string {
  return path.join(taskDir(slug, key, dataRoot), "attachments");
}

/** Ruling 503: a project's epic files live beside its tasks. */
export function epicsDir(slug: string, dataRoot?: string): string {
  return path.join(projectDir(slug, dataRoot), "epics");
}

/** One epic file. The id arrives from routes and tool calls, so it passes the
 *  same traversal guard every other store segment does. */
export function epicFilePath(
  slug: string,
  epicId: string,
  dataRoot?: string,
): string {
  return `${resolveStoreSegment(epicsDir(slug, dataRoot), epicId)}.md`;
}

/**
 * Ruling 503: where the chained-goal files of ruling 99 lived. Nothing reads
 * or writes a goal any more; the boot conversion (`goal-epic-migration`)
 * turns each one into an epic and files the original under `converted/`.
 */
export function retiredGoalsDir(slug: string, dataRoot?: string): string {
  return path.join(projectDir(slug, dataRoot), "goals");
}

export function agentProfilesDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "agents", "profiles");
}

/** `agents/definitions/` — the shipped doctrine files (operator, controller).
 *  C01-A11 (pass 32): built here like every other store path, not by walking
 *  `..` out of the profiles dir. */
function agentDefinitionsDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "agents", "definitions");
}

/** One doctrine file, with the same traversal guard as a profile id. */
export function agentDefinitionFilePath(id: string, dataRoot?: string): string {
  return `${resolveStoreSegment(agentDefinitionsDir(dataRoot), id)}.md`;
}

/**
 * One agent-profile template file. P13-AP-11: the profile id arrives from form
 * fields (`profileId`) and from `readdir`, and this used to `path.join` it
 * unchecked while the sibling skill/KB helpers refuse traversal — a crafted
 * `../../projects/x/project` id could read or WRITE outside the store. The id
 * is a plain file-name segment, so it goes through the same guard.
 */
export function agentProfileFilePath(
  profileId: string,
  dataRoot?: string,
): string {
  const dir = agentProfilesDir(dataRoot);
  return `${resolveStoreSegment(dir, profileId)}.md`;
}

/**
 * Resolve a single store-directory segment beneath `root`, rejecting any
 * traversal (F10-18). A skill/KB name comes from a profile's resource array,
 * which a hand-edited canonical file or crafted admin action could set to
 * `../../projects/x/secret`; `path.join` would happily normalize the `..` and
 * escape the store root, and the resolved content is injected as TRUSTED
 * persona material — crossing a prompt trust boundary. So the segment must be a
 * plain directory name: no separators, no dot-segments, no absolute path, no
 * NUL. Mirrors `diskNameFromId` (org/resources.server.ts). Throws on violation;
 * the injection readers catch it and degrade to "inject nothing" while logging
 * the denial, so a bad reference is explicitly DENIED, never silently escaped.
 */
export function resolveStoreSegment(root: string, name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.isAbsolute(name)
  ) {
    throw new Error(`Unsafe store resource name: ${JSON.stringify(name)}`);
  }
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, name);
  // Defense in depth: the resolved child must stay beneath the root.
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new Error(`Store resource escapes its root: ${JSON.stringify(name)}`);
  }
  return resolved;
}

/**
 * Ruling 675: the name a file is stored under, whatever form it arrived in.
 *
 * A browser on macOS sends a file's name decomposed ("İ" as "I" and a
 * combining dot above it), a Linux directory holds names byte for byte, and a
 * model types the composed form. So an upload is stored composed (NFC), the
 * form every reader types.
 */
export function storedFileName(name: string): string {
  return name.normalize("NFC");
}

/**
 * Ruling 675: {@link resolveStoreSegment} for a name somebody typed, which
 * finds the file whichever Unicode form it was stored in.
 *
 * Live on AWSC-117 the task's own input, a PDF uploaded from a Mac, was
 * stored decomposed. The operator, the Inventory Analyst and the Estimate
 * Judge each asked for it by the name the listing showed and were answered
 * "AWSC-117 has no attachment X. It holds: X.", with two names no reader can
 * tell apart. The folder's own listing decides, so the answer is the same on
 * a disk that folds the two forms together and on one that does not: an entry
 * of exactly that name wins; otherwise the one entry that composes to the same
 * name is the file meant. No such entry, or more than one, leaves the name as
 * it was typed, and the caller finds nothing there.
 */
export function resolveStoredSegment(root: string, name: string): string {
  const exact = resolveStoreSegment(root, name);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return exact;
  }
  const stored = storedNameAmong(entries, name);
  return stored === null ? exact : resolveStoreSegment(root, stored);
}

/**
 * Ruling 675: the one of `entries` a written name means, by the rule
 * {@link resolveStoredSegment} states: the entry of exactly that name, else
 * the single entry that composes to the same name. Null when none does, or
 * when two do and the name is neither of them.
 *
 * Every place that matches a name somebody wrote down (a typed file name, a
 * claim on a task's timeline, a hold) against names a folder holds asks this,
 * so a folder that holds both forms as two files keeps them apart: a name
 * means the entry spelled exactly so before it means its twin.
 */
export function storedNameAmong(entries: readonly string[], name: string): string | null {
  if (entries.includes(name)) return name;
  const wanted = storedFileName(name);
  const same = entries.filter((entry) => storedFileName(entry) === wanted);
  return same.length === 1 ? same[0]! : null;
}

/** Knowledge-base store root: ${DATA_ROOT}/kb (store://kb/…). Phase 9B. */
export function kbRootDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "kb");
}

/** One knowledge base's folder: ${DATA_ROOT}/kb/<dir> (traversal-contained). */
export function kbDirPath(dir: string, dataRoot?: string): string {
  return resolveStoreSegment(kbRootDir(dataRoot), dir);
}

/** Skill store root: ${DATA_ROOT}/skills (store://skills/…). Phase 9B. */
export function skillsRootDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "skills");
}

/** One skill's folder: ${DATA_ROOT}/skills/<name> (traversal-contained). */
export function skillDirPath(name: string, dataRoot?: string): string {
  return resolveStoreSegment(skillsRootDir(dataRoot), name);
}

/**
 * Store-relative display path (always forward slashes), e.g.
 * `projects/viberr-core/tasks/VIB-142/task.md` — what the UI shows wherever
 * the mock showed `.viberr/...` (ruling 3).
 */
export function storeRelativePath(absPath: string, dataRoot?: string): string {
  const rel = path.relative(getDataRoot(dataRoot), path.resolve(absPath));
  return rel.split(path.sep).join("/");
}
