import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

export interface GitHubAuthPlan {
  /** Pass only to the one server-owned git child that needs authentication. */
  env: NodeJS.ProcessEnv;
  /** Erases the token reference and removes the temporary askpass program. */
  dispose(): void;
}

/** The credential-free URL that Git persists as `remote.origin.url`. */
export function githubRepositoryUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Rewrite every stored origin URL to the credential-free GitHub URL. This is
 * used when reusing clones created by older Viberr versions that embedded the
 * project PAT in `remote.origin.url`.
 */
export function githubRemoteSanitizationArgs(
  repo: string,
  destination: string,
): string[] {
  return [
    "-C",
    destination,
    "config",
    "--local",
    "--replace-all",
    "remote.origin.url",
    githubRepositoryUrl(repo),
  ];
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
  const auth = createGitHubAuthPlan({
    ...(input.token ? { token: input.token } : {}),
    ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
  });
  return {
    args: ["clone", "--depth", "1", url, input.destination],
    env: auth.env,
    dispose: auth.dispose,
  };
}

/**
 * One-command Git authentication plan shared by clone and server-owned push.
 * The token exists only in the child environment; argv, remote URLs, helper
 * files, logs, prompts and task records remain credential-free.
 */
export function createGitHubAuthPlan(input: {
  token?: string;
  /** Test seam; production callers inherit the server process environment. */
  baseEnv?: NodeJS.ProcessEnv;
}): GitHubAuthPlan {
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

export interface CloneFailureLogDetails {
  reason: "git_unavailable" | "clone_failed" | "clone_terminated";
  exitCode?: number;
  signal?: string;
}

/**
 * Return an intentionally small, credential-safe description for logs.
 * `Error.message`, `stderr`, and `cmd` are deliberately ignored because child
 * process errors may echo command arguments or authentication diagnostics.
 */
export function cloneFailureLogDetails(error: unknown): CloneFailureLogDetails {
  const value =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; signal?: unknown; killed?: unknown })
      : {};
  const code = value.code;
  const signal = typeof value.signal === "string" ? value.signal : undefined;
  const reason =
    code === "ENOENT"
      ? "git_unavailable"
      : value.killed === true || signal
        ? "clone_terminated"
        : "clone_failed";

  return {
    reason,
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(signal ? { signal } : {}),
  };
}
