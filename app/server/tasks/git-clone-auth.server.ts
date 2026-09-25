import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { getEnv } from "~/server/config/env.server";
import { AppError } from "~/server/errors/app-error.server";
import { AgentTreeRemovalError } from "~/server/runtimes/agent-trees.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { errorMessage } from "~/shared/errors";
import {
  gitErrorText,
  redactGitOutput,
} from "~/server/secrets/git-output-redact.server";

/**
 * Pass 40 review (R-seams-1): what every git the server spawns carries at
 * COMMAND-LINE precedence, above any config file a repository could hold.
 *
 * The rule is that the server never runs git with an agent-writable repository
 * as its working repository under its own uid (`workspace-git.server.ts`), so
 * no repository config of an agent's should ever be read by a server git. This
 * is the defense in depth behind it: a hook (`core.hooksPath`) and the
 * file-system monitor (`core.fsmonitor`) are the two ways a repository makes
 * git EXECUTE something on commands as ordinary as `status`, `fetch` and
 * `checkout`, and both are switched off here whatever a config file says.
 * Only the git the server spawns gets them: they go in the child's environment
 * (`GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`), never in `process.env` and never in
 * `filteredSpawnEnv()`, so an agent's own git keeps its hooks.
 */
export const SERVER_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
];

/**
 * `env` with `entries` appended to its `GIT_CONFIG_COUNT` list (after any
 * entries it already carries), as a new object.
 */
export function withGitConfig(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<readonly [string, string]>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let count = Number.isInteger(existing) && existing > 0 ? existing : 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/**
 * The environment of a git the server spawns: the credential-free base every
 * child starts from (`filteredSpawnEnv`, never `process.env`, so the server's
 * secret-encryption key and session secret reach no git), no terminal prompt,
 * and {@link SERVER_GIT_CONFIG}. A credentialed git builds on the same base
 * through {@link createGitHubAskpassEnv}.
 */
export function serverGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...filteredSpawnEnv(), GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return withGitConfig(env, SERVER_GIT_CONFIG);
}

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
  /** Test seam; production callers build on `filteredSpawnEnv()` (pass 40
   *  review R-seams-1: never `process.env`, which holds the server's secrets). */
  baseEnv?: NodeJS.ProcessEnv;
}): GitHubAskpassEnv {
  const env: NodeJS.ProcessEnv = credentialedGitEnv(input.baseEnv);
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

/**
 * The base of a git that may carry a credential: no prompt, the ambient
 * credential helper list reset (an empty `credential.helper` at command-line
 * precedence clears every helper a config file names, so no helper can be
 * handed the password or store it), and {@link SERVER_GIT_CONFIG}.
 */
function credentialedGitEnv(baseEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return withGitConfig(
    { ...(baseEnv ?? filteredSpawnEnv()), GIT_TERMINAL_PROMPT: "0" },
    [["credential.helper", ""], ...SERVER_GIT_CONFIG],
  );
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
  /** Test seam; production callers build on `filteredSpawnEnv()`. */
  baseEnv?: NodeJS.ProcessEnv;
}): GitHubClonePlan {
  const url = githubRepositoryUrl(input.repo);
  // An empty helper resets any lower-priority helper list for this one Git
  // process. These environment-backed config entries are never persisted.
  const env: NodeJS.ProcessEnv = credentialedGitEnv(input.baseEnv);

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
  // C3 (pass 31): through the validated schema, like every other tuning knob;
  // ruling 458(j): the schema owns the coercion and the 15-minute default.
  // Read LAZILY like its C3 siblings (claudeIdleTimeoutMs et al.) — a
  // module-scope getEnv() call would throw at import time on an invalid env
  // (this module sits on the clone/delivery path) and would freeze the value
  // against `resetEnvCacheForTests`, making this the one knob tests could not
  // reach.
  return getEnv().VIBERR_GIT_CLONE_TIMEOUT_MS;
}

export interface CloneFailureLogDetails {
  /** `workspace_fault` (ruling 485): a LOCAL step failed — removing or
   *  replacing a tree, making a directory, cloning the delivering checkout,
   *  stripping `.claude`. Nothing about it involved GitHub. */
  reason: "git_unavailable" | "clone_failed" | "clone_terminated" | "workspace_fault";
  exitCode?: number;
  signal?: string;
  /** Ruling 485, a workspace fault only: what failed, the path and the OS
   *  error — "`…/website` could not be replaced: EACCES on `…/dev-1wnDsF`". */
  fault?: string;
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
 * What part a GitHub credential played in the attempt that failed.
 *
 * Ruling 249 (pass 37, F37-78): two values were not enough. The specialist
 * checkout has an arm that never touches the network (a supporting run is
 * cloned from the delivering checkout ON DISK), and the token is fetched only
 * in the arm after it, so a failure there reported `false` and viberr said "No
 * GitHub credential is attached to this project" about a project holding a
 * working one. That sentence exists to stop a failure being re-narrated as
 * something it was not; saying it did exactly what it was written to prevent.
 */
export type CloneCredential = "supplied" | "absent" | "not_involved";

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
  opts: { credential: CloneCredential; timeoutMs?: number },
): string {
  // Ruling 485: a local fault says what failed on the server's disk and
  // nothing else. Live on WEB-5 a replace that died on an agent's 0700
  // directory was told as "No GitHub credential is attached", and the
  // operator asked the owner to attach one; no clause about access belongs in
  // a sentence about a directory.
  if (details.reason === "workspace_fault") {
    return (
      `The workspace checkout could not be prepared on the Viberr server: ${details.fault ?? "a local step failed"}. ` +
      "The fault is in the task's workspace on the server's disk; nothing here reached GitHub."
    );
  }
  const cred =
    opts.credential === "supplied"
      ? "The project's GitHub credential WAS supplied to the clone, so this is not a missing-credential problem."
      : opts.credential === "not_involved"
        ? "This step never reached GitHub at all: the checkout is copied from a clone already on this server, so no credential was involved either way."
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
  // Ruling 485: a local step's fault is classified as what it is, never as a
  // clone (a removal's EACCES is no `clone_failed`, and a mkdir's ENOENT is
  // no missing git).
  if (cause instanceof WorkspaceFault) {
    const fault: CloneFailureLogDetails = { reason: "workspace_fault", fault: cause.fault };
    const detail = redactGitOutput(cause.detail, opts);
    if (detail) fault.detail = detail;
    return fault;
  }
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

/**
 * Ruling 485: a LOCAL step in a task's workspace failed — a tree could not be
 * removed or replaced, a directory could not be made, the delivering checkout
 * could not be cloned, `.claude` could not be stripped. It names the path and
 * the OS error. It is never a credential's doing: a checkout that fails on one
 * reports `credential: not_involved` (ruling 249), and its sentence
 * (`cloneFailureSentence`) says nothing about access at all.
 */
export class WorkspaceFault extends Error {
  /** What failed and why: "`/…/website` could not be replaced: EACCES on /…/dev-1wnDsF". */
  readonly fault: string;
  /** The failing program's own words (rm's, git's); "" when it printed none. */
  readonly detail: string;

  constructor(fault: string, detail: string) {
    super(fault);
    this.name = "WorkspaceFault";
    this.fault = fault;
    this.detail = detail;
  }
}

/** A node:fs error: its errno name and, when it has one, the path. */
const fsErrorSchema = z.object({ code: z.string(), path: z.string().optional() });

/**
 * One local step's failure as a {@link WorkspaceFault}: `what` says what failed
 * ("`/…/website` could not be replaced"), the cause supplies the OS error — a
 * removal's "EACCES on <path>", a node:fs errno and its path, git's exit and
 * its own words, a refusal's sentence. A fault passes through unchanged.
 */
export function workspaceFault(what: string, cause: unknown): WorkspaceFault {
  if (cause instanceof WorkspaceFault) return cause;
  if (cause instanceof AgentTreeRemovalError) {
    return new WorkspaceFault(`${what}: ${cause.failure}`, cause.detail);
  }
  if (cause instanceof AppError) return new WorkspaceFault(`${what}: ${cause.userMessage}`, "");
  const words = gitErrorText(cause);
  const exit = exitStatusSchema.safeParse(cause);
  if (exit.success) return new WorkspaceFault(`${what}: git exit ${exit.data.code}`, words);
  const termination = terminationSchema.safeParse(cause);
  if (termination.success || killedSchema.safeParse(cause).success) {
    return new WorkspaceFault(
      `${what}: it was stopped before it finished${termination.success ? ` (${termination.data.signal})` : ""}`,
      words,
    );
  }
  const fsError = fsErrorSchema.safeParse(cause);
  if (fsError.success) {
    const where = fsError.data.path ? ` on ${fsError.data.path}` : "";
    return new WorkspaceFault(`${what}: ${fsError.data.code}${where}`, "");
  }
  return new WorkspaceFault(`${what}: ${errorMessage(cause)}`, "");
}

/** Run one local step of preparing a checkout; its failure is a
 *  {@link WorkspaceFault} naming `what` (ruling 485). */
export async function workspaceStep<T>(what: string, step: () => Promise<T> | T): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw workspaceFault(what, error);
  }
}
