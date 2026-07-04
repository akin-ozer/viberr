import { mkdirSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.server";

/**
 * Data-root bootstrap + path helpers for the file-native store.
 *
 * Layout under ${VIBERR_DATA_ROOT}:
 *   projects/<slug>/project.md
 *   projects/<slug>/tasks/<KEY>/task.md   (+ attachments/ later)
 *   agents/profiles/<id>.md               (org-level agent profile templates)
 *   runtimes/                             (NDJSON run logs — Phase 8)
 *   state/projection.sqlite               (SQLite — managed by db/)
 *   cache/  auth/  logs/
 *
 * UI copy renders REAL store-relative paths (orchestrator ruling 3):
 * `projects/viberr-core/tasks/VIB-142/task.md`, never the mock's `.viberr/…`.
 */

export const DATA_ROOT_SUBDIRS = [
  "projects",
  "agents",
  "agents/profiles",
  "runtimes",
  "state",
  "cache",
  "auth",
  "logs",
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

export function agentProfilesDir(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "agents", "profiles");
}

export function agentProfileFilePath(
  profileId: string,
  dataRoot?: string,
): string {
  return path.join(agentProfilesDir(dataRoot), `${profileId}.md`);
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
