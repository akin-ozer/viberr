import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { projectDir } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { shareTreeBuiltForAgents, type AgentLaunch } from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import { REPO_SLUG_RE } from "~/shared/repo-ref";
import {
  gitErrorText,
  redactGitOutput,
} from "~/server/secrets/git-output-redact.server";
import {
  cloneTimeoutMs,
  createGitHubAskpassEnv,
  createGitHubClonePlan,
  githubRepositoryUrl,
  serverGitEnv,
  setOriginUrlArgs,
  workspaceFault,
  type GitHubAskpassEnv,
} from "./git-clone-auth.server";
import {
  runGitCloneWithProgress,
  type CloneProgress,
} from "./git-clone-progress.server";

const execFileAsync = promisify(execFile);

/**
 * A per-project git MIRROR that task workspace clones are cut from (R21-4 /
 * OBS-9).
 *
 * Live: every task cloned `akin-ozer/viberr` (113 MB) straight from GitHub, so
 * VIB-1/2/3 each paid 4-12 minutes and each held its own full copy. The repo is
 * the SAME for every task in a project — the only thing that differs is which
 * commit each workspace sits on — so the network fetch belongs to the project,
 * once, and the per-task work belongs on local disk.
 *
 * ## The design, and why this one
 *
 * The mirror is a BARE clone at `projects/<slug>/.repo-mirror/<owner>__<repo>.git`,
 * refreshed (`fetch --prune`) immediately before each workspace clone. The
 * workspace is then cloned FROM the mirror — a local clone, which git populates
 * by HARDLINKING the object store — and its `origin` is rewritten to the real
 * `https://github.com/<owner>/<repo>.git` before it is handed to anyone.
 *
 * The alternative the ruling names — `clone --reference <mirror> --dissociate`
 * from GitHub — was rejected on two counts: it still opens a network clone (so a
 * cold task still waits on github.com), and `--reference` does not combine with
 * the `--depth 1` the direct path uses. Hardlinks give the independence
 * `--dissociate` is asked for and give it for free: the workspace's object files
 * are its OWN directory entries, so reclaiming the mirror, `git gc` inside it,
 * or deleting the project cannot pull objects out from under a live run. That
 * independence matters here specifically because task workspaces are reclaimed
 * at boot on their own schedule (`workspace-retention.server`), with no
 * knowledge of this cache.
 *
 * What the rewrite preserves, deliberately:
 *   - **origin URL** — `remote.origin.url` is the credential-free GitHub URL, so
 *     the delivery push (`push-workspace.server`) and the branch update path
 *     find exactly what they found before;
 *   - **credential flow** — unchanged and, if anything, narrower: the PAT now
 *     reaches only the MIRROR's fetch (through `GIT_ASKPASS`, never argv or a
 *     persisted URL). The workspace clone itself is a local filesystem copy that
 *     needs no credential at all;
 *   - **a fresh-from-remote view** — the mirror is fetched from GitHub in the
 *     same call, so the workspace sees the refs a fresh clone would.
 *
 * The one visible difference: a workspace cut from the mirror carries FULL
 * history rather than `--depth 1`. That is a strict gain here — the history is
 * hardlinked, so it costs no disk, and it removes the shallow-repo deepen dance
 * the delivery path otherwise has to do.
 *
 * ## Failure policy
 *
 * A cache may never block a task. Every mirror step is best-effort: create,
 * refresh and the local clone each fall back to the direct GitHub clone this
 * module replaces, with one WARN naming what went wrong. Only the final clone's
 * failure propagates — the callers classify it (`cloneFailureLogDetails`) and
 * turn it into the prompt/timeline story a human can act on.
 *
 * One refinement over "any trouble ⇒ clone from GitHub" (R21-4b): a mirror that
 * EXISTS and merely failed to REFRESH is still served, with a warning that says
 * it may be stale. Discarding a working 113 MB local copy because the network
 * hiccuped, and then downloading it again over that same network, is the worst
 * available move. Corruption still self-heals: two consecutive refresh failures
 * condemn the copy, and the next clone-side caller rebuilds it from scratch.
 *
 * "EXISTS" is `mirrorIsComplete`, not a directory on disk: a mirror is built in
 * a sidecar and renamed into place, so a build killed mid-download leaves
 * nothing the cache will serve. That distinction is load-bearing — the stale
 * arm above is a deliberate choice to serve an OLD copy, and it is only ever a
 * good one when what it serves is a WHOLE one.
 */

/**
 * Where this project caches its repository, or null when `repo` is not a plain
 * `owner/name` pair (`REPO_SLUG_RE`, ruling 689(a)). `project.md` already reads
 * any other value as no repository; a caller that hands one in anyway skips
 * the cache rather than deriving a path from it.
 *
 * Lives beside `tasks/`, NOT inside a task workspace: the boot reclaim only
 * removes `<taskDir>/workspace` (`workspace-retention.server`), the projection
 * rebuild only reads `projects/<slug>/tasks/*`, and the dot prefix keeps the
 * file watcher from walking a 100 MB object store (`shouldIgnoreWatchPath`
 * ignores any dot-prefixed path segment).
 */
export function projectRepoMirrorDir(
  projectSlug: string,
  repo: string,
  dataRoot?: string,
): string | null {
  if (!REPO_SLUG_RE.test(repo)) return null;
  return path.join(
    projectDir(projectSlug, dataRoot),
    ".repo-mirror",
    `${repo.replace("/", "__")}.git`,
  );
}

/**
 * The mirror's fetch refspec — and this module's COMPLETION MARKER.
 *
 * `--bare` writes `remote.origin.url` but NO fetch refspec, so a mirror without
 * this line is one a `fetch origin` could not update anyway. It is written LAST,
 * after the bare clone returns, which is what makes its presence mean "a whole
 * mirror finished landing here". Branch heads only: GitHub also advertises
 * `refs/pull/*`, which `--mirror`'s `+refs/*:refs/*` would drag in for no
 * benefit to a workspace clone.
 */
const MIRROR_FETCH_REFSPEC = "+refs/heads/*:refs/heads/*";

/**
 * Has a COMPLETE mirror landed at `mirrorDir`?
 *
 * Not `existsSync(<dir>/HEAD)`, which is what this module used to ask. `git
 * clone --bare` creates the destination and writes `HEAD` (as
 * `ref: refs/heads/.invalid`) BEFORE it transfers a single object, and it only
 * cleans the destination up when it exits on its own. A clone killed
 * mid-transfer — a container stop, a `docker compose restart`, an interrupted
 * run — therefore left a directory that passed the old test: a `HEAD`, zero
 * refs, no refspec, and a pile of orphaned `objects/pack/tmp_pack_*`.
 *
 * Live (VIB-1, 2026-09-08): two killed clones left exactly that. Every later
 * look called the mirror warm, the refresh arm below spent its whole 120 s
 * budget on a `fetch origin` that had no refspec to work with, and the workspace
 * clone cut from it handed the delivering agent an EMPTY checkout — which it
 * committed a parentless commit into, and delivery was then refused as
 * non-fast-forward against the real branch. 510 MB of temp packs, no refs.
 *
 * The marker fails in the safe direction: a build killed between the clone and
 * the config write reads as incomplete and is rebuilt, which costs a download
 * and never serves an empty cache.
 */
function mirrorIsComplete(mirrorDir: string): boolean {
  try {
    return readFileSync(path.join(mirrorDir, "config"), "utf8").includes(
      MIRROR_FETCH_REFSPEC,
    );
  } catch {
    // No config at all — not a repository, let alone a finished mirror.
    return false;
  }
}

/**
 * Can a working tree be cut from this mirror — i.e. does its `HEAD` resolve to a
 * branch it actually holds?
 *
 * That is precisely what `git clone <mirror>` needs to check anything out. It
 * warns ("remote HEAD refers to nonexistent ref") and exits 0 otherwise, so
 * every weaker test — "the directory is there", "it has some refs" — lets an
 * EMPTY working tree through as a success. A mirror of a genuinely empty
 * upstream repository answers false here, which is correct: there is nothing to
 * cut, and `cloneWorkspaceRepo` should go and ask GitHub rather than invent a
 * checkout.
 */
function mirrorCanCheckOut(mirrorDir: string): boolean {
  let head: string;
  try {
    head = readFileSync(path.join(mirrorDir, "HEAD"), "utf8").trim();
  } catch {
    return false;
  }
  const symbolic = /^ref:\s*(refs\/\S+)$/.exec(head);
  // A detached HEAD names its own commit — there is nothing to look up.
  if (!symbolic) return /^[0-9a-f]{40,64}$/.test(head);
  const ref = symbolic[1]!;
  if (existsSync(path.join(mirrorDir, ...ref.split("/")))) return true;
  // Freshly cloned mirrors pack their refs, so the loose file above is absent.
  try {
    return readFileSync(path.join(mirrorDir, "packed-refs"), "utf8")
      .split("\n")
      .some((line) => line.endsWith(` ${ref}`));
  } catch {
    return false;
  }
}

/**
 * Ruling 670: a mirror's `HEAD` is written once, by the clone that built it,
 * and names the repository's default branch as it was then: `main` for one
 * mirrored while it was empty, the old name for one renamed on GitHub since.
 * While that ref does not exist the mirror cannot serve a clone
 * (`mirrorCanCheckOut`), and nothing repointed it, because the bootstrap used
 * to create the missing name on GitHub. It no longer does, so a `HEAD` that
 * names a missing ref follows the remote's.
 *
 * One `ls-remote`, and only in that state with branches to point at. Never
 * throws: a mirror that could not be repointed is what it was, and the caller
 * clones from GitHub.
 */
async function followRemoteHead(mirrorDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (mirrorCanCheckOut(mirrorDir)) return;
  try {
    // A mirror of a repository that has no branch yet has nothing to follow,
    // and is refreshed too often to pay a second network call each time.
    const heads = await execFileAsync(
      "git",
      ["-C", mirrorDir, "for-each-ref", "--count=1", "refs/heads"],
      { timeout: 10_000, env: serverGitEnv() },
    );
    if (!heads.stdout.trim()) return;
    const { stdout } = await execFileAsync(
      "git",
      ["-C", mirrorDir, "ls-remote", "--symref", "origin", "HEAD"],
      { timeout: MIRROR_REFRESH_TIMEOUT_MS, env },
    );
    const ref = /^ref:\s+(refs\/heads\/\S+)\s+HEAD$/m.exec(stdout)?.[1];
    if (!ref) return;
    await execFileAsync("git", ["-C", mirrorDir, "symbolic-ref", "HEAD", ref], {
      timeout: 10_000,
      env: serverGitEnv(),
    });
  } catch {
    // Left as it was.
  }
}

/**
 * D1 (pass 23, owner ruling Q3): is THIS clone the cold FIRST-task clone?
 *
 * Only the first task in a project pays the full network clone (minutes on a
 * large repo); every later task fetches from the local mirror in seconds. A
 * COMPLETE mirror (`mirrorIsComplete`) means later tasks are fetching warm; its
 * absence means this run is building one. A repo that does not resolve to a
 * mirror path (invalid owner/name) reports NOT cold — there is nothing to
 * prewarm, and the caller's clone will fail honestly on its own terms rather
 * than mislabel the wait.
 */
export function mirrorIsCold(
  projectSlug: string,
  repo: string,
  dataRoot?: string,
): boolean {
  const dir = projectRepoMirrorDir(projectSlug, repo, dataRoot);
  return dir !== null && !mirrorIsComplete(dir);
}

/** D1: the reservation step label for a workspace clone, honest about whether it
 *  is the cold first-task clone (minutes) or a warm mirror fetch (seconds). */
export function cloneStepLabel(repo: string, coldClone: boolean): string {
  return coldClone
    ? `Cloning ${repo} · first task in this project, this can take a few minutes`
    : `Cloning ${repo}`;
}

/** F27-U1: the same cold-clone step, with the live transfer percentage folded
 *  in. Only the cold first-task network clone reports progress (a warm mirror
 *  clone hardlinks in well under a frame), so this always reads as first-task
 *  setup; the fraction clamps into 0..100.
 *
 *  F28-U1: the percentage leads (right after the repo), BEFORE the "first task"
 *  context — the run strip renders this step with `text-overflow: ellipsis` in a
 *  narrow, fixed-width column, so a trailing `%` was always clipped and the
 *  progress readout this feature exists for never reached the user. Front-loading
 *  the number keeps it visible; the context suffix is what truncates instead. */
export function cloneProgressStep(repo: string, fraction: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return `Cloning ${repo} · ${pct}% · first task in this project`;
}

/**
 * One mirror operation at a time per mirror directory.
 *
 * Two runs on the same project start together routinely (the operator drive
 * clones, then the specialist it engages clones), and two `git fetch`es into one
 * bare repo race on `FETCH_HEAD` and the ref lock. Git's own locking would turn
 * that into a spurious failure — which this module would absorb as a cache miss
 * and pay a full network clone for. Serializing in-process is cheaper than
 * retrying, and one process per data root is already the rule
 * (`db/writer-lock`), so there is no second writer to coordinate with.
 */
const mirrorLocks = new Map<string, Promise<unknown>>();

function withMirrorLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = mirrorLocks.get(key) ?? Promise.resolve();
  // `then(work, work)` — the next waiter runs whatever the previous one did.
  const next = prior.then(work, work);
  // The stored tail must never reject: it is only a sequencing token, and an
  // unobserved rejection here would surface as an unhandled promise.
  mirrorLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * The refresh gets its OWN, much shorter budget (R21-4b).
 *
 * An incremental `fetch --prune` against an existing mirror moves the delta
 * since the last workspace clone — seconds, not minutes. Letting it inherit the
 * 15-minute CLONE budget meant a network that hangs rather than fails held every
 * caller for a quarter of an hour: the workspace clone that is waiting on it,
 * and the operator's default-branch read, which is a tool call inside a live
 * agent turn. Failing at two minutes costs a stale mirror; hanging costs the
 * whole turn.
 */
const MIRROR_REFRESH_TIMEOUT_MS = 120_000;

/**
 * Consecutive refresh failures before the mirror is thrown away and re-cloned
 * (R21-4b).
 *
 * One failure is the network; two in a row on a mirror whose remote is reachable
 * is the mirror itself — a half-written pack from a killed fetch, a ref lock
 * left by a process that died. Serving that forever is the failure mode a cache
 * must not have, and a rebuild is the one repair that always works. Counted per
 * mirror directory, reset by any successful fetch or rebuild.
 */
const MIRROR_REBUILD_AFTER_FAILURES = 2;

/** Consecutive `fetch` failures per mirror directory — see the constant above. */
const mirrorFetchFailures = new Map<string, number>();

/**
 * The environment EVERY mirror git operation runs with, credentialed or not.
 *
 * R21-4b: the credential-free arm used to hand git a copy of `process.env` with
 * only the prompt and helper suppressed — so a host `GIT_ASKPASS` / `SSH_ASKPASS`
 * (a developer's credential helper, a CI runner's agent) was inherited by a
 * mirror fetch, which is exactly what the credentialed arm takes care to strip.
 * `createGitHubAskpassEnv` is the ONE builder for both arms: it deletes both
 * askpass variables, suppresses the terminal prompt, resets the ambient
 * credential helper, and installs Viberr's own askpass program only when a token
 * is actually supplied. Always `dispose()`.
 */
export function mirrorGitEnv(token: string | null): GitHubAskpassEnv {
  return token ? createGitHubAskpassEnv({ token }) : createGitHubAskpassEnv({});
}

/** One WARN naming what the cache could not do. `detail` is git's own
 *  complaint, already scrubbed by the caller (`""` when git said nothing). */
function mirrorWarn(
  message: string,
  fields: Record<string, string>,
  detail: string,
): void {
  logger.warn(message, detail ? { ...fields, detail } : fields);
}

/** The project's mirror, ready to be read or cloned from. */
export interface ProjectMirror {
  /** The bare repository's directory. */
  dir: string;
  /** Whether THIS call brought it up to date with the remote. False means the
   *  mirror is being served as it stood — the refresh failed, and the caller's
   *  answer is as old as the last successful one. */
  refreshed: boolean;
}

/**
 * Create or refresh the project's mirror — or null when the cache is unusable,
 * in which case the caller clones straight from GitHub (or reads whatever local
 * ref it already has).
 *
 * Never throws.
 */
async function ensureProjectMirror(input: {
  mirrorDir: string;
  repo: string;
  remoteUrl: string;
  token: string | null;
  projectSlug: string;
  /** May this call CREATE (or rebuild) a missing mirror — a full network clone?
   *  The workspace clone pays that gladly, since it is the cost it is replacing;
   *  a read-side refresh must never turn one tool call into a 113 MB download. */
  create: boolean;
  /** F27-U1: notified with a 0..1 fraction as the (cold) network clone streams,
   *  so the caller can turn a multi-minute silent wait into a live percentage.
   *  Only fires on the CREATE/rebuild arm — a refresh moves seconds of delta. */
  onCloneProgress?: CloneProgress;
}): Promise<ProjectMirror | null> {
  const { mirrorDir, remoteUrl, token } = input;
  const fields = {
    projectSlug: input.projectSlug,
    repo: input.repo,
    mirrorDir,
  };
  // R21-4b: ONE env builder for both arms — a host askpass is never inherited.
  const auth = mirrorGitEnv(token);
  const env = auth.env;
  try {
    let rebuilding = false;
    if (mirrorIsComplete(mirrorDir)) {
      try {
        await execFileAsync("git", ["-C", mirrorDir, "fetch", "--prune", "origin"], {
          timeout: MIRROR_REFRESH_TIMEOUT_MS,
          env,
        });
        mirrorFetchFailures.delete(mirrorDir);
        await followRemoteHead(mirrorDir, env);
        return { dir: mirrorDir, refreshed: true };
      } catch (error) {
        // R21-4b: a mirror that EXISTS is worth more than the network that
        // failed. Falling back to a full GitHub clone here was the worst of both
        // — it threw away a working local copy and then paid the very download
        // the mirror exists to avoid, at the moment the network was already sick.
        const failures = (mirrorFetchFailures.get(mirrorDir) ?? 0) + 1;
        mirrorFetchFailures.set(mirrorDir, failures);
        const detail = redactGitOutput(gitErrorText(error), { token });
        rebuilding = input.create && failures >= MIRROR_REBUILD_AFTER_FAILURES;
        if (!rebuilding) {
          mirrorWarn(
            "the project's repository mirror could not be refreshed; serving a possibly stale mirror",
            fields,
            detail,
          );
          return { dir: mirrorDir, refreshed: false };
        }
        mirrorWarn(
          "the project's repository mirror failed to refresh twice; rebuilding it",
          fields,
          detail,
        );
      }
    } else if (!input.create) {
      // Nothing cached and no licence to pay for one: the caller degrades.
      return null;
    }
    // Nothing usable is cached here: either no mirror was ever finished (a
    // first build, or a previous attempt that died mid-clone) or the repeated
    // fetch failures above condemned this copy.
    //
    // Build into a SIDECAR and rename it into place, so the mirror path only
    // ever appears complete. `git clone --bare` writes `HEAD` before it
    // transfers an object and cleans up after itself only on a clean exit, so
    // building in place is what let a killed clone leave a half-built directory
    // that every later look accepted (`mirrorIsComplete`). A rename within the
    // `.repo-mirror` directory is atomic; a killed build now leaves only the
    // sidecar, which `pruneStaleMirrors` sweeps on the next successful build.
    const building = `${mirrorDir}.building`;
    rmSync(building, { recursive: true, force: true });
    mkdirSync(path.dirname(mirrorDir), { recursive: true });
    // F27-U1: `--progress` makes git emit transfer percentages to stderr even
    // without a TTY; `runGitCloneWithProgress` streams them to `onCloneProgress`
    // while keeping execFile's resolve/reject/`.stderr`/timeout contract, so the
    // failure path below (and its redaction) is unchanged.
    await runGitCloneWithProgress(
      ["clone", "--bare", "--progress", remoteUrl, building],
      // The first mirror build is a full clone, so it gets the clone budget.
      { timeout: cloneTimeoutMs(), env },
      input.onCloneProgress,
    );
    // The refspec, written LAST — see MIRROR_FETCH_REFSPEC. Without it a later
    // `fetch origin` would update nothing, and with it the sidecar is a
    // finished mirror, so this is the write the rename publishes.
    await execFileAsync(
      "git",
      [
        "-C",
        building,
        "config",
        "--local",
        "--replace-all",
        "remote.origin.fetch",
        MIRROR_FETCH_REFSPEC,
      ],
      { timeout: 10_000, env: serverGitEnv() },
    );
    rmSync(mirrorDir, { recursive: true, force: true });
    renameSync(building, mirrorDir);
    mirrorFetchFailures.delete(mirrorDir);
    logger.info(
      rebuilding
        ? "rebuilt the project's repository mirror cache"
        : "created the project's repository mirror cache",
      fields,
    );
    pruneStaleMirrors(mirrorDir);
    return { dir: mirrorDir, refreshed: true };
  } catch (error) {
    mirrorWarn(
      "the project's repository mirror is unavailable; cloning from GitHub",
      fields,
      redactGitOutput(gitErrorText(error), { token }),
    );
    return null;
  } finally {
    auth.dispose();
  }
}

export interface ProjectMirrorRequest {
  projectSlug: string;
  /** `owner/repo`. */
  repo: string;
  /** The project's PAT, when one is bound. */
  token: string | null;
  dataRoot?: string;
  /** Default false — see `ensureProjectMirror`'s `create`. */
  create?: boolean;
  /** F27-U1: 0..1 progress for a cold network clone — see `onCloneProgress`. */
  onCloneProgress?: CloneProgress;
}

/**
 * The project's mirror, refreshed, under the per-mirror lock.
 *
 * The one entry point for everything that wants the project's repository
 * WITHOUT touching a task workspace: the workspace clone cuts from it, and the
 * operator's default-branch read (`operator-repo-read.server`) reads out of it.
 * Null when this project has no usable mirror.
 */
export function refreshProjectMirror(
  input: ProjectMirrorRequest,
): Promise<ProjectMirror | null> {
  const mirrorDir = projectRepoMirrorDir(
    input.projectSlug,
    input.repo,
    input.dataRoot,
  );
  if (!mirrorDir) return Promise.resolve(null);
  return withMirrorLock(mirrorDir, () => {
    const ensureInput: Parameters<typeof ensureProjectMirror>[0] = {
      mirrorDir,
      repo: input.repo,
      remoteUrl: githubRepositoryUrl(input.repo),
      token: input.token,
      projectSlug: input.projectSlug,
      create: input.create ?? false,
    };
    // Conditional set (exactOptionalPropertyTypes): never hand across an
    // explicit `undefined` for the optional callback.
    if (input.onCloneProgress) ensureInput.onCloneProgress = input.onCloneProgress;
    return ensureProjectMirror(ensureInput);
  });
}

// ------------------------------------------------------------------ the stage

/**
 * Pass 40 review (R-seams-1): where the server does git work that needs a
 * repository of its OWN — the delivery push, the branch update's fetches from
 * GitHub, a checkout built before it is handed to a workspace. Beside the
 * mirror (`projects/<slug>/.repo-stage/`), outside every task workspace, so no
 * agent can write it; dot-prefixed, so the file watcher never walks it.
 */
function stageRoot(projectSlug: string, dataRoot?: string): string {
  return path.join(projectDir(projectSlug, dataRoot), ".repo-stage");
}

/** A stage older than this was left by a process that died mid-way. */
const STALE_STAGE_MS = 6 * 60 * 60 * 1000;

/** A fresh, uniquely named directory under the project's stage root, with
 *  stages a killed process left behind swept first. */
function newStageDir(projectSlug: string, prefix: string, dataRoot?: string): string {
  const root = stageRoot(projectSlug, dataRoot);
  mkdirSync(root, { recursive: true });
  try {
    const cutoff = Date.now() - STALE_STAGE_MS;
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // Tidying is best effort; a stage that cannot be swept costs disk only.
  }
  return mkdtempSync(path.join(root, prefix));
}

/**
 * Run `work` in a BARE repository the server owns, removed afterwards: the
 * PAT's only workplace outside the mirror (pass 40 review, R-seams-1). The
 * stage borrows the mirror's objects through `objects/info/alternates` when a
 * complete mirror exists, so a fetch into it moves only what the mirror lacks
 * (a task branch's own commits, the base's newest), and the mirror is held
 * under its lock for the stage's whole life, so a rebuild can never pull
 * those objects out from under it. The stage is readable by the agent group
 * (never writable): a workspace fetches GitHub's refs from it as its person.
 */
export async function withServerStage<T>(
  input: { projectSlug: string; repo: string; dataRoot?: string | undefined },
  work: (stage: string) => Promise<T>,
): Promise<T> {
  const mirrorDir = projectRepoMirrorDir(input.projectSlug, input.repo, input.dataRoot);
  const body = async (): Promise<T> => {
    const stage = newStageDir(input.projectSlug, "git-", input.dataRoot);
    try {
      chmodSync(stage, 0o755);
      await execFileAsync("git", ["init", "--bare", "--quiet", stage], {
        timeout: 10_000,
        env: serverGitEnv(),
      });
      if (mirrorDir && mirrorIsComplete(mirrorDir)) {
        const info = path.join(stage, "objects", "info");
        mkdirSync(info, { recursive: true });
        writeFileSync(path.join(info, "alternates"), `${path.join(mirrorDir, "objects")}\n`);
      }
      return await work(stage);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  };
  return mirrorDir ? withMirrorLock(mirrorDir, body) : body();
}

/**
 * Build a checkout in a stage the server owns and only then move it to
 * `destination` (pass 40 review, R-seams-1). A workspace is writable by every
 * agent uid from the moment it exists, so a clone made IN it would have the
 * server's git read a `.git` an agent could write mid-clone (a filter driver
 * a checkout runs, say). Here the server's clone and its origin rewrite run in
 * a directory no agent can reach; the finished tree is handed to the agent
 * group (a file linked from the mirror stays read-only) and renamed into
 * place, and the server's git never touches it again. `clone` makes the
 * repository at the path it is given.
 */
async function cloneThroughStage(
  input: { projectSlug: string; repo: string; destination: string; dataRoot?: string | undefined },
  clone: (target: string) => Promise<void>,
): Promise<void> {
  const stage = newStageDir(input.projectSlug, "clone-", input.dataRoot);
  try {
    const target = path.join(stage, "checkout");
    await clone(target);
    // The tree must never be handed on pointing at a local path: every fetch
    // and push after this one is the server's, against the GitHub URL.
    await execFileAsync("git", setOriginUrlArgs(target, githubRepositoryUrl(input.repo)), {
      timeout: 10_000,
      env: serverGitEnv(),
    });
    shareTreeBuiltForAgents(target);
    mkdirSync(path.dirname(input.destination), { recursive: true });
    try {
      renameSync(target, input.destination);
    } catch (error) {
      // A destination on another filesystem (never the store's own layout,
      // where both sit under the data root): copied instead of moved.
      if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
      cpSync(target, input.destination, { recursive: true, verbatimSymlinks: true });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Drop mirrors for repositories this project no longer points at — otherwise a
 *  repo change leaves a full copy of the old one on disk forever. This is also
 *  what reclaims a `<mirror>.building` sidecar abandoned by a killed build.
 *  Best-effort and silent: a cache that cannot tidy itself is not a failure. */
function pruneStaleMirrors(mirrorDir: string): void {
  const parent = path.dirname(mirrorDir);
  const keep = path.basename(mirrorDir);
  try {
    for (const entry of readdirSync(parent)) {
      if (entry !== keep) {
        rmSync(path.join(parent, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Nothing here is worth failing a clone over.
  }
}

export interface WorkspaceCloneInput {
  projectSlug: string;
  /** `owner/repo`. */
  repo: string;
  /** Where the working tree goes. Must not exist yet. */
  destination: string;
  /** The project's PAT, when one is bound. Absent ⇒ the clone is anonymous. */
  token?: string | null;
  dataRoot?: string;
  /** F27-U1: 0..1 progress for a cold network clone (the mirror build, or the
   *  direct-from-GitHub fallback). Silent on the warm hardlink clone from the
   *  mirror, which finishes in seconds. */
  onCloneProgress?: CloneProgress;
  /** Ruling 485: whom a destination that stands in the clone's way is
   *  removed as — the task's person (`taskWorkspaceLaunch`). Absent or null is
   *  the server's own user, which only a server that launches no agents
   *  allows; with isolation on the removal refuses instead. */
  person?: AgentLaunch | null;
}

export interface WorkspaceCloneResult {
  /** Whether the working tree was cut from the project's mirror cache. */
  viaMirror: boolean;
}

/**
 * Populate `destination` with a working clone of `repo`, through the project's
 * mirror cache when that is possible and straight from GitHub when it is not.
 *
 * Throws exactly what `execFile` throws when the CLONE fails, so the callers'
 * existing classification (`cloneFailureLogDetails` → the prompt and timeline
 * story) is unchanged. Mirror trouble never reaches the caller as a failure.
 */
export async function cloneWorkspaceRepo(
  input: WorkspaceCloneInput,
): Promise<WorkspaceCloneResult> {
  const token = input.token ?? null;
  const mirrorRequest: ProjectMirrorRequest = {
    projectSlug: input.projectSlug,
    repo: input.repo,
    token,
    // The workspace clone is the caller that MAY pay for a mirror: the network
    // clone it replaces is the very cost being avoided.
    create: true,
  };
  if (input.dataRoot) mirrorRequest.dataRoot = input.dataRoot;
  // F27-U1: the mirror build is the cold clone in the normal path — stream its
  // percentage through to the run strip.
  if (input.onCloneProgress) mirrorRequest.onCloneProgress = input.onCloneProgress;
  const mirror = await refreshProjectMirror(mirrorRequest);

  // A mirror with no branches clones into an EMPTY working tree: `git clone`
  // says so in a warning and still exits 0, so this arm would hand a specialist
  // a checkout with no history, no `origin/<base>` and no error to notice.
  // (VIB-1, 2026-09-08: the delivering agent committed a parentless commit into
  // one, and delivery was refused as non-fast-forward against the real branch.)
  // `mirrorIsComplete` should already keep a half-built mirror out of here; a
  // genuinely EMPTY upstream repository is the honest way to reach this, and it
  // costs only a cheap network clone of a repository with nothing in it.
  // Caught live while repairing VIB-1: a hand-seeded mirror whose `HEAD` still
  // named the `git init` default branch had every object and every ref, and
  // still cloned to nothing — which is why the test is HEAD-resolves, not
  // has-refs.
  const usable = mirror && mirrorCanCheckOut(mirror.dir) ? mirror : null;
  if (mirror && !usable) {
    mirrorWarn(
      "the project's repository mirror has no branch to check out; cloning from GitHub",
      { projectSlug: input.projectSlug, repo: input.repo },
      "",
    );
  }

  // R-seams-1: both arms clone into a stage the server owns and move the
  // finished tree into place (`cloneThroughStage`); a half-written tree never
  // reaches the destination.
  const staged = {
    projectSlug: input.projectSlug,
    repo: input.repo,
    destination: input.destination,
    dataRoot: input.dataRoot,
  };
  if (usable) {
    try {
      // Local clone ⇒ git hardlinks the object store: seconds and ~no disk,
      // with no alternates file, so this tree outlives the mirror. No
      // credential is involved at all — this step never leaves the disk — and
      // the prompt suppression is belt and braces against a hang.
      await cloneThroughStage(staged, async (target) => {
        await execFileAsync("git", ["clone", usable.dir, target], {
          timeout: cloneTimeoutMs(),
          env: serverGitEnv(),
        });
      });
      return { viaMirror: true };
    } catch (error) {
      mirrorWarn(
        "cloning from the project's repository mirror failed; cloning from GitHub",
        { projectSlug: input.projectSlug, repo: input.repo },
        redactGitOutput(gitErrorText(error), { token }),
      );
      // Whatever stood in the way (a half-moved tree, a directory already
      // there) would make the move below refuse the destination too. The
      // destination is in a workspace an agent writes, so it goes as the
      // task's person (ruling 485), and a failure to clear it is a fault on
      // the server's disk, never a clone's.
      try {
        await removeAgentTree(input.destination, input.person ?? null);
      } catch (removal) {
        throw workspaceFault(`\`${input.destination}\` stands in the clone's way and could not be removed`, removal);
      }
    }
  }

  // No credential ⇒ no `token` key at all: the plan's askpass leg keys off the
  // property's presence, so a public-repo clone must not carry an empty one.
  await cloneThroughStage(staged, async (target) => {
    const planInput: Parameters<typeof createGitHubClonePlan>[0] = {
      repo: input.repo,
      destination: target,
    };
    if (token) planInput.token = token;
    const plan = createGitHubClonePlan(planInput);
    try {
      // F27-U1: the fallback is also a full network clone (the mirror was
      // unavailable), so it too streams progress. `--progress` goes right after
      // the `clone` subcommand the plan opens with; if the plan ever led with
      // something else, the flag is simply omitted and the clone still runs.
      const progressArgs =
        plan.args[0] === "clone"
          ? ["clone", "--progress", ...plan.args.slice(1)]
          : plan.args;
      await runGitCloneWithProgress(
        progressArgs,
        { timeout: cloneTimeoutMs(), env: plan.env },
        input.onCloneProgress,
      );
    } finally {
      plan.dispose();
    }
  });
  return { viaMirror: false };
}
