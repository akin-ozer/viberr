import { existsSync, mkdirSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { AppError } from "~/server/errors/app-error.server";
import { getDataRoot } from "~/server/files/file-store-root.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Per-person runtime homes (ruling 127).
 *
 * Every agent run bills ONE person, so every vendor binary a run spawns reads
 * its credential and writes its transcripts inside THAT person's own home:
 *
 *   <dataRoot>/runtimes/users/<userId>/claude-home   → the child's CLAUDE_CONFIG_DIR
 *                                                      (transcripts under projects/)
 *   <dataRoot>/runtimes/users/<userId>/codex-home    → the child's CODEX_HOME
 *                                                      (sessions under sessions/)
 *
 * This is the ONE resolver for those paths. There must be one: the run service
 * tells the SDK where to write, `session-export` reads the transcript back, the
 * retention sweep prunes it and the sign-in driver writes the credential into
 * it. When two resolvers disagreed (the shared-home era's
 * `claude-config`/`codex-config` pair) every real run's transcript landed
 * somewhere the exporter never looked.
 *
 * The homes replace the deployment-wide `runtimes/claude-home` /
 * `runtimes/codex-home` and the host `~/.codex` mount: a credential in a shared
 * home is a credential every person's runs bill to whoever owns it, which is
 * exactly what ruling 127 forbids.
 *
 * The credential FILES here are vendor-owned — Viberr creates the directory and
 * never reads, copies or parses what the binary writes into it (Anthropic's
 * Claude Code legal page: a hosting platform may not collect or store
 * Claude.ai credentials). The only thing this module asserts about them is
 * whether they EXIST, which is what per-person availability is derived from.
 */

/** Re-exported so a consumer of the per-user homes needs one import, not two.
 *  The vocabulary itself stays owned by the runtime registry. */
export type { RealBackend };

/** The directory under `<dataRoot>/runtimes` that holds the per-person homes. */
export const USER_RUNTIMES_DIR = "users";

/** A user id may become a PATH SEGMENT here, so it is validated as one. Viberr
 *  mints ids as `u_<base64url>` (`newId`), which this matches; anything else —
 *  a hand-edited row, a traversal attempt, an empty string — is refused rather
 *  than resolved. */
const PATH_SAFE_USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertPathSafeUserId(userId: string): string {
  if (!PATH_SAFE_USER_ID_RE.test(userId)) {
    throw AppError.validation(
      "That user id cannot be used for a runtime home.",
      { userIdLength: userId.length },
    );
  }
  return userId;
}

/** `<dataRoot>/runtimes/users/<userId>` — one person's runtime root. */
export function userRuntimeRoot(userId: string, dataRoot?: string): string {
  return path.join(
    getDataRoot(dataRoot),
    "runtimes",
    USER_RUNTIMES_DIR,
    assertPathSafeUserId(userId),
  );
}

/** The home the spawned vendor binary gets for one person and one backend. */
export function userBackendHome(
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): string {
  return path.join(
    userRuntimeRoot(userId, dataRoot),
    backend === "claude" ? "claude-home" : "codex-home",
  );
}

/**
 * Materialize the home (`mkdir -p`, mode 0o700) and return it.
 *
 * 0o700 because a login credential file the vendor binary writes lands in here:
 * on a multi-user host, one person's runs must not be able to read another's
 * sign-in. `recursive` applies the mode to every directory this call creates;
 * the process umask can only narrow it further, never widen it.
 */
export function ensureUserBackendHome(
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): string {
  const home = userBackendHome(userId, backend, dataRoot);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Where `claude auth login` keeps a file-based login (macOS uses the login
 *  Keychain instead, which is why availability has a `presence` verdict). */
export function claudeLoginCredentialPath(home: string): string {
  return path.join(home, ".credentials.json");
}

/** Where `codex login` writes its credential. */
export function codexLoginCredentialPath(home: string): string {
  return path.join(home, "auth.json");
}

/**
 * Every per-person runtime root that exists on disk, for the sweeps that must
 * visit all of them (transcript retention). Returns `[]` when nothing has been
 * created yet, and skips any entry whose name is not a path-safe user id — a
 * directory nothing in this module could have produced is not one a sweep may
 * delete inside.
 */
export function listUserRuntimeRoots(
  dataRoot?: string,
): { userId: string; root: string }[] {
  const base = path.join(getDataRoot(dataRoot), "runtimes", USER_RUNTIMES_DIR);
  if (!existsSync(base)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && PATH_SAFE_USER_ID_RE.test(entry.name))
    .map((entry) => ({ userId: entry.name, root: path.join(base, entry.name) }));
}
