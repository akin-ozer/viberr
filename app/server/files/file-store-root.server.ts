import { mkdirSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.server";

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

export function taskDir(slug: string, key: string, dataRoot?: string): string {
  return path.join(projectDir(slug, dataRoot), "tasks", key);
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

/** Ruling 99: a project's chained-goal files live beside its tasks. */
export function goalsDir(slug: string, dataRoot?: string): string {
  return path.join(projectDir(slug, dataRoot), "goals");
}

/** One goal file. The id arrives from routes and tool calls, so it passes the
 *  same traversal guard every other store segment does. */
export function goalFilePath(
  slug: string,
  goalId: string,
  dataRoot?: string,
): string {
  return `${resolveStoreSegment(goalsDir(slug, dataRoot), goalId)}.md`;
}

export function agentProfilesDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "agents", "profiles");
}

/** `agents/definitions/` — the shipped doctrine files (operator, controller).
 *  C01-A11 (pass 32): built here like every other store path, not by walking
 *  `..` out of the profiles dir. */
export function agentDefinitionsDir(dataRoot?: string): string {
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
