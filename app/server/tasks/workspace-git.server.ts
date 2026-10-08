import { execFile, execFileSync, type ExecFileOptions } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readTaskFile, type TaskFileRef } from "~/server/files/task-writer.server";
import {
  agentGitLaunchFor,
  launchEnv,
  launchesAgents,
  resolveExecutable,
  type AgentLaunch,
} from "~/server/runtimes/agent-isolation.server";
import { serverGitEnv } from "./git-clone-auth.server";

/**
 * Pass 40 review, R-seams-1: **the server never executes git with an
 * agent-writable repository as its working repository under its own uid.**
 *
 * Ruling 460 runs every agent as its person's own OS user and shares each
 * task's `workspace/` with the agent group (`node:viberr-agents` 2770), so an
 * agent can write any checkout's `.git`: a hook, `core.fsmonitor`, a filter
 * driver, a credential helper, `url.<x>.insteadOf`. The server then ran its own
 * git there as `node`, with `process.env` (the secret-encryption key, the
 * session secret) and, on a push, the project's PAT — so an agent could have
 * the server execute its code or send the PAT to a host of its choosing, and
 * nothing of ruling 460 held. The rule has two halves:
 *
 *  - **Local operations inside a workspace run as the person the work bills**
 *    (the task's owner, ruling 127), through the launcher exactly like their
 *    runs, with no credential in the environment: {@link taskWorkspaceGit}.
 *    What an agent planted then runs, if at all, as that person, which is
 *    authority their agent already had. With no launcher (the host dev server,
 *    the test harness) the same git runs as the server, as before.
 *  - **Anything that needs the PAT runs as the server in a repository the
 *    server owns** (`withServerStage` in `repo-mirror.server.ts`): the
 *    delivered branch is fetched OUT of the workspace over git's transport
 *    with `git-upload-pack` launched as the person ({@link workspaceUploadPack}),
 *    so the server's side only ever parses a pack; the push, `ls-remote` and
 *    the fetches from GitHub run in the stage; and a workspace reads GitHub's
 *    refs by fetching from the stage (or the mirror) as the person.
 *
 * Every git the server spawns, as itself or as the person, also carries
 * `core.hooksPath=/dev/null` and `core.fsmonitor=false` at command-line
 * precedence and an environment built from `filteredSpawnEnv()`
 * (`serverGitEnv`), never `process.env`. The overrides ride the child's
 * environment only, so an agent's own git keeps its hooks.
 */

const execFileAsync = promisify(execFile);

/** One external command's outcome. Never thrown: a failure is a value. */
export interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The child was KILLED (timeout), not merely unsuccessful. */
  timedOut?: boolean;
}

/** An injectable command runner (tests pass a fake). */
export interface Exec {
  (
    file: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
  ): Promise<ExecOutcome>;
}

/**
 * What a rejected `execFile` promise carries. Node hangs these fields on the
 * error object, so each is decoded on its own: a rejection whose `stderr` came
 * back as a Buffer must still yield the kill signal, which is the only thing
 * that separates a timeout from an ordinary non-zero exit.
 */
const execFileRejection = z
  .object({
    stdout: z.string().catch(""),
    stderr: z.string().catch(""),
    killed: z.boolean().catch(false),
    signal: z.string().nullable().catch(null),
  })
  .catch(() => ({ stdout: "", stderr: "", killed: false, signal: null }));

/** `execFile` as an {@link ExecOutcome}: never throws. */
async function execOutcome(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<ExecOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const rejection = execFileRejection.parse(error);
    const outcome: ExecOutcome = {
      ok: false,
      stdout: rejection.stdout,
      stderr: rejection.stderr,
    };
    // A timeout is a KILL, not a non-zero exit, and saying "returned non-zero"
    // about a process that never returned sends the reader looking for a git
    // error that was never printed.
    if (rejection.killed || rejection.signal !== null) outcome.timedOut = true;
    return outcome;
  }
}

/**
 * The server's own git, for a repository the SERVER owns (the project mirror,
 * a stage): `opts.env` when the caller built one on `serverGitEnv()` or
 * `createGitHubAskpassEnv` (a credentialed read or push), else
 * `serverGitEnv()`. Never `process.env`.
 */
export const serverExec: Exec = (file, args, opts) =>
  execOutcome(file, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    env: opts.env ?? serverGitEnv(),
  });

/** A git for one task's workspace: as its person when this server launches
 *  agents, as the server's own user when it does not. */
export interface WorkspaceGit {
  /** Who the git runs as; null = the server's own user (isolation `off`). */
  readonly launch: AgentLaunch | null;
  /** `git <args>`, rejecting exactly as `execFile` does (so `gitErrorText`,
   *  `cloneFailureLogDetails` and the redaction read it unchanged). */
  run(
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }>;
  /** The same git as an {@link Exec} (never throws). `opts.env` is IGNORED:
   *  a workspace git never carries a credential, whatever a caller hands it. */
  readonly exec: Exec;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The git binary the launcher execs (it takes absolute paths only). */
function gitBinary(env: NodeJS.ProcessEnv): string {
  return resolveExecutable("git", env.PATH ?? process.env.PATH ?? "");
}

/** A program to spawn and the environment to spawn it with. */
export interface GitSpawn {
  file: string;
  env: NodeJS.ProcessEnv;
}

/** What is spawned for one workspace git: the launcher with the git binary and
 *  the person's uid, or git itself. The environment is `serverGitEnv()` — the
 *  person's own `$HOME` when launched — and never carries a credential. */
function workspaceSpawn(launch: AgentLaunch | null): GitSpawn {
  const env: NodeJS.ProcessEnv = serverGitEnv();
  if (!launch) return { file: "git", env };
  if (launch.home) env.HOME = launch.home;
  return { file: launch.launcher, env: launchEnv(launch, gitBinary(env), env) };
}

/** A {@link WorkspaceGit} that runs as `launch` (null: the server's user). */
export function workspaceGitAs(launch: AgentLaunch | null): WorkspaceGit {
  const options = (opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number }) => {
    const spawned = workspaceSpawn(launch);
    const out: ExecFileOptions = {
      env: spawned.env,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    };
    if (opts.cwd) out.cwd = opts.cwd;
    return { file: spawned.file, out };
  };
  return {
    launch,
    async run(args, opts = {}) {
      const { file, out } = options(opts);
      const { stdout, stderr } = await execFileAsync(file, args, out);
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    },
    exec: (file, args, opts) => {
      if (file !== "git") {
        return Promise.resolve({
          ok: false,
          stdout: "",
          stderr: `a workspace runs git only, not ${file}`,
        });
      }
      const { file: spawned, out } = options({ cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return execOutcome(spawned, args, out);
    },
  };
}

/**
 * The workspace git of a caller that has no task to name its person: the
 * server's own user when this server launches no agents (as before), and
 * null when it does — the caller then skips the git step rather than run it
 * as the server.
 */
export function workspaceGitWhenIsolationOff(): WorkspaceGit | null {
  return launchesAgents() ? null : workspaceGitAs(null);
}

/** Where a task's workspace git comes from. */
export interface TaskWorkspaceRef {
  projectSlug: string;
  /** Absent only for a caller with no task (a test); with isolation on that
   *  is refused, never run as the server. */
  taskKey?: string | null | undefined;
  dataRoot?: string | undefined;
}

function noPerson(what: string): AppError {
  return new AppError({
    code: ERROR_CODES.RUN_UNAVAILABLE,
    status: 409,
    userMessage:
      `The task's workspace could not be worked in as its person's own user (ruling 460, pass 40 review): ${what}. ` +
      "Nothing ran; a workspace's git, and the removal of a tree in it (ruling 485), never falls back to the server's own user.",
  });
}

/**
 * Who works in a task's workspace: the task's owner (ruling 127: the person the
 * task's runs bill) through the launcher when this server launches agents, and
 * null — the server's own user — when it does not. Its git runs as them
 * ({@link taskWorkspaceGit}), and so does the removal of a tree in it (ruling
 * 485, `removeAgentTree`). Throws a `run_unavailable` AppError when isolation
 * is on and there is nobody to run as (no task, no owner) or the person's home
 * cannot be prepared.
 */
export function taskWorkspaceLaunch(db: DatabaseSync, ref: TaskWorkspaceRef): AgentLaunch | null {
  if (!launchesAgents()) return null;
  if (!ref.taskKey) throw noPerson("no task names the person");
  const taskFile: TaskFileRef = { projectSlug: ref.projectSlug, taskKey: ref.taskKey };
  if (ref.dataRoot) taskFile.dataRoot = ref.dataRoot;
  const file = readTaskFile(taskFile);
  const owner = file?.parsed.frontmatter.ownerUserId ?? null;
  if (!owner) throw noPerson(`${ref.taskKey} has no owner`);
  return agentGitLaunchFor(db, owner, ref.dataRoot);
}

/**
 * The git for a task's workspace: as the task's owner when this server
 * launches agents, else as the server's own user ({@link taskWorkspaceLaunch}).
 * Throws a `run_unavailable` AppError when isolation is on and there is nobody
 * to run as or the person's home cannot be prepared — a caller degrades on it
 * the way it degrades on a git failure.
 */
export function taskWorkspaceGit(db: DatabaseSync, ref: TaskWorkspaceRef): WorkspaceGit {
  return workspaceGitAs(taskWorkspaceLaunch(db, ref));
}

/** `git-upload-pack`'s absolute path: on `PATH`, else in git's exec path. */
function uploadPackBinary(env: NodeJS.ProcessEnv): string {
  try {
    return resolveExecutable("git-upload-pack", env.PATH ?? process.env.PATH ?? "");
  } catch {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8", env }).trim();
    return path.join(execPath, "git-upload-pack");
  }
}

/**
 * The server's fetch OUT of a workspace (into a repository it owns): extra
 * `git fetch` arguments and the environment. With a launch, git's transport
 * runs `git-upload-pack` through the launcher as the person: git spawns the
 * `--upload-pack` program with the workspace path as its one argument, the
 * launcher execs `VIBERR_LAUNCH_EXEC` as `VIBERR_LAUNCH_UID` with that argument
 * and removes both variables first. So the workspace's repository — its
 * config, its alternates, a `.git` that is really a gitfile — is read only by
 * the person, and the server's side parses a pack stream, which git does for
 * any remote. The environment is `serverGitEnv()` (never a credential); `$HOME`
 * stays the server's, since the server's own git reads `$HOME/.gitconfig`.
 */
export interface UploadPackFetch {
  /** Extra `git fetch` arguments (`--upload-pack=<launcher>` when launched). */
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function workspaceUploadPack(launch: AgentLaunch | null): UploadPackFetch {
  const env: NodeJS.ProcessEnv = serverGitEnv();
  if (!launch) return { args: [], env };
  return {
    args: [`--upload-pack=${launch.launcher}`],
    env: launchEnv(launch, uploadPackBinary(env), env),
  };
}
