import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { getEnv } from "~/server/config/env.server";
import {
  gitErrorText,
  redactGitOutput,
} from "~/server/secrets/git-output-redact.server";

const ASKPASS_USERNAME_ENV = "VIBERR_GIT_ASKPASS_USERNAME";
const ASKPASS_PASSWORD_ENV = "VIBERR_GIT_ASKPASS_PASSWORD";

// Git invokes this program once for the username prompt and once for the
// password prompt. The credential is supplied through the clone process's
// short-lived environment; it is never written into this file.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$${ASKPASS_USERNAME_ENV}" ;;
  *) printf '%s\\n' "$${ASKPASS_PASSWORD_ENV}" ;;
esac
`;

export interface GitHubClonePlan {
  /** Safe to log: contains only the credential-free GitHub URL. */
  args: string[];
  /** Pass only to the clone child process. May contain the token until dispose. */
  env: NodeJS.ProcessEnv;
  /** Erases the in-memory token reference and removes the askpass program. */
  dispose(): void;
}

export interface GitHubAskpassEnv {
  /** Pass only to the git child process. Carries the token until dispose. */
  env: NodeJS.ProcessEnv;
  /** Erases the in-memory token reference and removes the askpass program. */
  dispose(): void;
}

/**
 * Build a short-lived environment that authenticates ANY git invocation against
 * github.com through the supported `GIT_ASKPASS` mechanism (shared by the clone
 * plan and the server-side workspace push). The PAT is supplied only through
 * the child process environment — never in argv, the remote URL, or a persisted
 * config entry — and ambient credential helpers are reset so nothing leaks to a
 * host credential store. Always `dispose()` after the git process exits.
 */
export function createGitHubAskpassEnv(input: {
  /** Absent ⇒ the invocation runs ANONYMOUSLY: the same prompt-suppressed,
   *  helper-free environment with no askpass program at all (a public-repo
   *  fetch must not carry an empty credential). */
  token?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): GitHubAskpassEnv {
  const env: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;

  let askpassDir: string | null = null;
  if (input.token) {
    askpassDir = mkdtempSync(path.join(tmpdir(), "viberr-git-askpass-"));
    const askpassPath = path.join(askpassDir, "askpass.sh");
    writeFileSync(askpassPath, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
    chmodSync(askpassPath, 0o700);
    env.GIT_ASKPASS = askpassPath;
    env[ASKPASS_USERNAME_ENV] = "x-access-token";
    env[ASKPASS_PASSWORD_ENV] = input.token;
  }

  let disposed = false;
  return {
    env,
    dispose() {
      if (disposed) return;
      disposed = true;
      delete env[ASKPASS_USERNAME_ENV];
      delete env[ASKPASS_PASSWORD_ENV];
      delete env.GIT_ASKPASS;
      if (askpassDir) rmSync(askpassDir, { recursive: true, force: true });
    },
  };
}

/** The credential-free URL that Git persists as `remote.origin.url`. */
export function githubRepositoryUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Point a clone's `origin` at `url`, replacing EVERY stored value.
 *
 * `--replace-all` is the whole point: a repo can hold several `remote.origin.url`
 * entries, and leaving one behind leaves whatever it carried behind with it.
 */
export function setOriginUrlArgs(destination: string, url: string): string[] {
  return [
    "-C",
    destination,
    "config",
    "--local",
    "--replace-all",
    "remote.origin.url",
    url,
  ];
}

/**
 * Rewrite every stored origin URL to the credential-free GitHub URL. This is
 * used when reusing clones created by older Viberr versions that embedded the
 * project PAT in `remote.origin.url`, and when a workspace cut from the project
 * mirror cache has to stop pointing at that local path (`repo-mirror.server`).
 */
export function githubRemoteSanitizationArgs(
  repo: string,
  destination: string,
): string[] {
  return setOriginUrlArgs(destination, githubRepositoryUrl(repo));
}

/**
 * Build a GitHub clone invocation that authenticates through Git's supported
 * `GIT_ASKPASS` mechanism. The PAT is absent from argv and the remote URL, so
 * `git clone` persists only `https://github.com/<owner>/<repo>.git` in
 * `.git/config`. Ambient credential helpers are reset for this invocation so
 * project-bound credentials cannot be written to a host credential store.
 */
export function createGitHubClonePlan(input: {
  repo: string;
  destination: string;
  token?: string;
  /** Test seam; production callers inherit the server process environment. */
  baseEnv?: NodeJS.ProcessEnv;
}): GitHubClonePlan {
  const url = githubRepositoryUrl(input.repo);
  const env: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    // An empty helper resets any lower-priority helper list for this one Git
    // process. These environment-backed config entries are never persisted.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };

  // Never reuse an ambient askpass program for a project clone.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;

  let askpassDir: string | null = null;
  if (input.token) {
    askpassDir = mkdtempSync(path.join(tmpdir(), "viberr-git-askpass-"));
    const askpassPath = path.join(askpassDir, "askpass.sh");
    writeFileSync(askpassPath, ASKPASS_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });
    // Do not rely on the host's umask to leave the helper executable.
    chmodSync(askpassPath, 0o700);
    env.GIT_ASKPASS = askpassPath;
    env[ASKPASS_USERNAME_ENV] = "x-access-token";
    env[ASKPASS_PASSWORD_ENV] = input.token;
  }

  let disposed = false;
  return {
    args: ["clone", "--depth", "1", url, input.destination],
    env,
    dispose() {
      if (disposed) return;
      disposed = true;
      delete env[ASKPASS_USERNAME_ENV];
      delete env[ASKPASS_PASSWORD_ENV];
      delete env.GIT_ASKPASS;
      if (askpassDir) rmSync(askpassDir, { recursive: true, force: true });
    },
  };
}

/**
 * How long a workspace clone may run.
 *
 * Was a hardcoded 60s, which is not a budget — it is a bet that every repo is
 * small. Viberr's own repo takes ~71s for `--depth 1` (a 55 MB working tree,
 * most of it screenshots), so the bet lost on the first real project: the clone
 * was SIGTERM'd at 60s, the run continued against an EMPTY workspace, and the
 * agent — told by its prompt to clone the repo itself, holding no token because
 * agents deliberately never receive one — reported "repository requires
 * credentials". The human then read a credential problem on a project whose
 * credential was probe-verified minutes earlier. A shallow clone is bounded by
 * repo size and link speed, neither of which this process knows, so the ceiling
 * is generous and configurable; it exists to stop a hung clone, not to rule on
 * how big a repository is allowed to be.
 */
export function cloneTimeoutMs(): number {
  // C3 (pass 31): through the validated schema, like every other tuning knob.
  // The coercion + fallback stay here (the schema keeps these as raw strings).
  // Read LAZILY like its C3 siblings (claudeIdleTimeoutMs et al.) — a
  // module-scope getEnv() call would throw at import time on an invalid env
  // (this module sits on the clone/delivery path) and would freeze the value
  // against `resetEnvCacheForTests`, making this the one knob tests could not
  // reach.
  const raw = getEnv().VIBERR_GIT_CLONE_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900_000;
}

export interface CloneFailureLogDetails {
  reason: "git_unavailable" | "clone_failed" | "clone_terminated";
  exitCode?: number;
  signal?: string;
  /**
   * Git's OWN failure text, scrubbed (`redactGitOutput`). Absent when git
   * printed nothing.
   *
   * F19-6: this is the only channel that can tell a human WHY a transient
   * `git exit 128` happened. Without it a live clone failure produced one log
   * line — `{"reason":"clone_failed","exitCode":128}` — and the operator's
   * blocked packet could recommend nothing better than "hold for infra to
   * investigate", with nothing for infra to investigate.
   */
  detail?: string;
}

/**
 * One plain sentence naming what actually went wrong, for the agent's prompt and
 * the task timeline.
 *
 * The point is NOT to be descriptive — it is to stop the failure being
 * re-narrated downstream as something it was not. An agent that finds an empty
 * workspace has no way to distinguish "the server's clone timed out" from "there
 * is no credential", and it guessed wrong in exactly the way that wastes a
 * human's time: by asking for a credential that already exists.
 */
export function cloneFailureSentence(
  details: CloneFailureLogDetails,
  opts: { hadCredential: boolean; timeoutMs?: number },
): string {
  const cred = opts.hadCredential
    ? "The project's GitHub credential WAS supplied to the clone, so this is not a missing-credential problem."
    : "No GitHub credential is attached to this project, so the clone ran anonymously.";
  switch (details.reason) {
    case "git_unavailable":
      return `git is not installed on the Viberr server, so the workspace checkout could not be created. ${cred}`;
    case "clone_terminated":
      return (
        `The workspace checkout was cancelled after ${Math.round((opts.timeoutMs ?? cloneTimeoutMs()) / 1000)}s — ` +
        `the clone ran past its time limit rather than failing. ${cred}`
      );
    default:
      return (
        `The workspace checkout failed` +
        (details.exitCode === undefined ? "" : ` (git exit ${details.exitCode})`) +
        `. ${cred}`
      );
  }
}

/** Each reading of a rejected `execFile` is decoded on its own, the way
 *  `gitErrorText` decodes its two fields: `code` is the spawn errno (a string,
 *  `ENOENT` when git is not installed) OR git's exit status (a number), never
 *  both, and neither reading should have to defend against the other's shape.
 *  `signal` carries `.min(1)` because an empty signal name is "no signal" to
 *  every reader downstream. */
const spawnErrnoSchema = z.object({ code: z.string() });
const exitStatusSchema = z.object({ code: z.number() });
const terminationSchema = z.object({ signal: z.string().min(1) });
const killedSchema = z.object({ killed: z.literal(true) });

/**
 * Classify a failed clone — and carry git's own words along, SCRUBBED.
 *
 * This used to drop `Error.message`, `stderr` and `cmd` outright because "child
 * process errors may echo command arguments or authentication diagnostics".
 * That bought less than it cost (F19-6). The PAT reaches git only through
 * `GIT_ASKPASS` — never argv, never the remote URL, never a persisted config
 * entry — so git's stderr is token-free by construction here; what the
 * suppression actually threw away was the one sentence that says whether a
 * `git exit 128` was a DNS failure, a 403, or a repository that moved.
 * `redactGitOutput` scrubs the known token value, URL userinfo and token shapes
 * on top of that, so pass the token whenever the caller holds it.
 */
export function cloneFailureLogDetails(
  cause: unknown,
  opts: { token?: string | null } = {},
): CloneFailureLogDetails {
  const errno = spawnErrnoSchema.safeParse(cause);
  const exitStatus = exitStatusSchema.safeParse(cause);
  const termination = terminationSchema.safeParse(cause);
  const killed = killedSchema.safeParse(cause).success;

  const details: CloneFailureLogDetails = {
    reason:
      errno.success && errno.data.code === "ENOENT"
        ? "git_unavailable"
        : killed || termination.success
          ? "clone_terminated"
          : "clone_failed",
  };
  if (exitStatus.success) details.exitCode = exitStatus.data.code;
  if (termination.success) details.signal = termination.data.signal;
  const detail = redactGitOutput(gitErrorText(cause), opts);
  if (detail) details.detail = detail;
  return details;
}
