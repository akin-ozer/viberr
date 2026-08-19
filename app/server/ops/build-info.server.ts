import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Build identity for the RUNNING process (gap 18).
 *
 * Nothing in this app could name the build it was serving: `package.json` has
 * no `version`, the image bakes no tag, and `latestMigration` — the only thing
 * that looked like identity in the boot log — is the constant `0001_baseline.sql`
 * for every build ever made. Every upgrade/rollback instruction in
 * docs/operations/deployment.md ("redeploy the previous image") assumes the
 * operator can tell two builds apart at runtime; none of them was verifiable.
 *
 * The rule this module follows is the one the codebase already applies to the
 * Codex SDK (`codex-runtime.server.ts`: a version claim in prose is
 * unfalsifiable): identity comes from something REAL or it is reported as
 * absent. Nothing is guessed, and there is no "unknown"/"1.0.0" placeholder —
 * an unidentified build reports `null`, which is a true statement an operator
 * can act on ("this image was built without a version stamp").
 *
 * Sources, in precedence order:
 *  1. Env baked at image-build time — `VIBERR_BUILD_VERSION`, `VIBERR_BUILD_SHA`,
 *     `VIBERR_BUILD_TIME` (Dockerfile ARG → ENV; see the patch note in the
 *     pass report). This is the only source a container can have.
 *  2. `package.json` `version`, read once from the working directory (the
 *     Dockerfile copies package.json into /app, so this works in the image too).
 *  3. The checkout's `.git` — HEAD, its ref file, then packed-refs. FILE READS
 *     ONLY: no `git` subprocess, no network, and never at request time.
 *
 * Resolved ONCE per process and cached: the health endpoint is unauthenticated,
 * so it must not do filesystem work per request.
 */

/** A type alias, not an interface, so the boot integrity line can carry it as a
 *  structured log field (only a type alias gets the implicit index signature). */
export type BuildInfo = {
  /** Semver, from `VIBERR_BUILD_VERSION` or package.json; null when neither declares one. */
  version: string | null;
  /** Short (12-char) commit sha; null when the build baked none and there is no checkout. */
  revision: string | null;
  /** Where `revision` actually came from — never inferred. */
  revisionSource: "env" | "git" | null;
  /** ISO timestamp baked at image build (`VIBERR_BUILD_TIME`); null when unset. */
  builtAt: string | null;
};

const SHORT_SHA_LENGTH = 12;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The ONE field this module reads out of a package.json. `.min(1)` after the
 *  trim is the "a blank stamp is not a version" rule the rest of the module
 *  applies to every source; `.catch` keeps a non-string `version` from being an
 *  identity claim rather than making it an error. */
const packageManifestSchema = z.object({
  version: z.string().trim().min(1).optional().catch(undefined),
});

/** package.json `version`, or null when the file is missing/unparseable/versionless. */
function packageVersion(root: string): string | null {
  const raw = readTextFile(path.join(root, "package.json"));
  if (!raw) return null;
  try {
    return packageManifestSchema.parse(JSON.parse(raw)).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The checked-out commit, read straight out of `.git` (no subprocess).
 * Handles the three shapes HEAD can take: a detached sha, a ref with a loose
 * ref file, and a ref that only exists in `packed-refs` (a fresh clone).
 */
function gitRevision(root: string): string | null {
  const head = readTextFile(path.join(root, ".git", "HEAD"))?.trim();
  if (!head) return null;
  if (SHA_RE.test(head)) return head;
  const match = /^ref:\s*(\S+)$/.exec(head);
  if (!match) return null;
  const ref = match[1]!;
  const loose = readTextFile(path.join(root, ".git", ref))?.trim();
  if (loose && SHA_RE.test(loose)) return loose;
  const packed = readTextFile(path.join(root, ".git", "packed-refs"));
  if (!packed) return null;
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA_RE.test(sha)) return sha;
  }
  return null;
}

function shorten(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH).toLowerCase();
}

/** Resolve build identity from an explicit root + env (pure — the test drives this). */
export function resolveBuildInfo(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  const envVersion = env.VIBERR_BUILD_VERSION?.trim();
  const envSha = env.VIBERR_BUILD_SHA?.trim();
  const builtAt = env.VIBERR_BUILD_TIME?.trim();

  const version = envVersion || packageVersion(root);
  const gitSha = envSha ? null : gitRevision(root);
  const revision = envSha ? shorten(envSha) : gitSha ? shorten(gitSha) : null;

  return {
    version: version || null,
    revision,
    revisionSource: revision ? (envSha ? "env" : "git") : null,
    builtAt: builtAt || null,
  };
}

let cached: BuildInfo | null = null;

/** Process-wide build identity, resolved on first call and cached. */
export function getBuildInfo(): BuildInfo {
  cached ??= resolveBuildInfo(process.cwd());
  return cached;
}

/** Test-only: drop the cached resolution. */
export function resetBuildInfoCacheForTests(): void {
  cached = null;
}
