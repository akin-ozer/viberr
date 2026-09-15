import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { refreshProjectMirror } from "./repo-mirror.server";
import { logger } from "~/server/logging/logger.server";
import {
  gitErrorText,
  redactGitOutput,
} from "~/server/secrets/git-output-redact.server";
import { getPatToken, getProjectCredential } from "~/server/secrets/pat-store.server";

/**
 * F21-21 — the operator's ANCHORED read of the project's default branch.
 *
 * The operator's "read-only repository view" is not a private clone: it is the
 * SHARED task workspace (`tasks/<key>/workspace/<repo>`), the very tree the
 * delivering specialist works in. Once that agent commits, the tree stands on
 * the TASK branch. Live (VIB-7) an operator `Read`-ed a file there, saw the row
 * its own deliverer had just written, declared "the repository's DEFAULT branch
 * already contains that exact row … landed outside the governed pipeline", and
 * opened a blocking packet against a perfectly healthy flow.
 *
 * The operator holds no `Bash` (it is on OPERATOR_READ_ONLY_DENIED_TOOLS), so
 * "just run `git show origin/main:path`" is not available to it. This module is
 * the server-side equivalent, exposed as the `read_default_branch_file`
 * governance tool: it reads the default branch out of a git OBJECT STORE, never
 * a working tree.
 *
 * ## Which object store, and why not the checkout's
 *
 * The read is served from the PROJECT MIRROR (`repo-mirror.server`), not from
 * the task checkout. The first cut of this module fetched into the checkout to
 * keep `origin/<default>` fresh — and `git fetch --depth 1` into a FULL clone
 * marks that repository SHALLOW. The shared task workspace is the delivering
 * agent's tree: shallowing it out from under a live run breaks exactly the
 * machinery this operator turn is about to reason over (`merge-base` against
 * `origin/<default>` stops resolving, so the diff and verdict paths lose their
 * base). A read must not mutate the thing it reads about.
 *
 * The mirror is the right store anyway: it is per-project, it is already
 * refreshed on every workspace clone, it is bare (no working tree to disturb),
 * and its refresh is the one place the project's credential is used. When the
 * project has no usable mirror the read degrades to the checkout's CLONE-TIME
 * `origin/<default>` ref — read-only, no fetch — and reports `refreshed: false`
 * so the tool's prose can say the answer may be slightly stale.
 *
 * Never throws — every failure is a typed arm the tool turns into prose, because
 * a thrown tool error is exactly the ambiguity that sends the model back to
 * reading the tree.
 */

const execFileAsync = promisify(execFile);

/** Bound on one `git show`: this is a local object read, not a network call. */
const GIT_SHOW_TIMEOUT_MS = 20_000;
/** Bound on the `git config` that names the checkout's repository. */
const GIT_CONFIG_TIMEOUT_MS = 10_000;
/**
 * Cap on the bytes handed back to the model. A default-branch read exists to
 * settle "is this content on the default branch?", not to stream a 4 MB
 * generated file into an operator turn's context.
 */
export const DEFAULT_BRANCH_READ_MAX_BYTES = 60_000;

export type DefaultBranchRead =
  | {
      kind: "found";
      text: string;
      /** True when the content was cut at DEFAULT_BRANCH_READ_MAX_BYTES. */
      truncated: boolean;
      /** Whether the ref was refreshed from the remote for THIS read. */
      refreshed: boolean;
    }
  /** The ref resolved, but the path is not in it — the answer to "is it on the
   *  default branch?" is a clean NO. */
  | { kind: "absent" }
  /** git could not answer at all (no such ref, no git, a broken checkout). The
   *  operator must say so rather than substitute a working-tree read. */
  | { kind: "unavailable"; reason: string };

/** Reject a path that would escape the ref (git resolves `..` inside a tree
 *  read the same way it resolves it on disk) or name a ref instead of a path. */
function pathIsReadable(repoPath: string): boolean {
  const p = repoPath.trim();
  if (!p || p.startsWith("/") || p.startsWith("-")) return false;
  if (p.includes(":")) return false;
  return !p.split("/").includes("..");
}

/** `https://github.com/<owner>/<repo>.git` (or the ssh form) → `owner/repo`. */
const GITHUB_REMOTE_RE = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Which repository this checkout is a clone of, per its own `origin`.
 *
 * Read from the checkout rather than the project record deliberately: the mirror
 * that can answer for THIS tree is the one for the repo the tree came from, and
 * `remote.origin.url` is the credential-free GitHub URL every clone path writes
 * (`setOriginUrlArgs`). Null when git cannot say, or when the remote is not a
 * GitHub `owner/repo` — the read then falls back to the checkout's own ref.
 */
async function checkoutRepoSlug(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "config", "--get", "remote.origin.url"],
      { timeout: GIT_CONFIG_TIMEOUT_MS },
    );
    const match = GITHUB_REMOTE_RE.exec(stdout.trim());
    const owner = match?.[1];
    const name = match?.[2];
    return owner && name ? `${owner}/${name}` : null;
  } catch {
    return null;
  }
}

/** Where one default-branch read is served from. */
interface ReadSource {
  /** The git directory to run `show` in. */
  dir: string;
  /** The `<ref>:<path>` argument for that directory. */
  ref: string;
  /** Whether this store was brought up to date with the remote for this read. */
  refreshed: boolean;
}

/**
 * Resolve the store to read from: the refreshed project mirror when there is
 * one, else the checkout's clone-time ref.
 *
 * The mirror is refreshed but never CREATED here (`create: false`): a project
 * whose mirror is missing must not turn one operator tool call into a full
 * repository download. In practice the mirror exists — every task workspace is
 * cut from it — so the common path is an incremental fetch of a bare repo.
 */
async function resolveReadSource(
  db: DatabaseSync,
  input: { projectSlug: string; dir: string; defaultBranch: string; dataRoot?: string },
  repoPath: string,
): Promise<ReadSource> {
  const checkoutRef = {
    dir: input.dir,
    ref: `origin/${input.defaultBranch}:${repoPath}`,
    refreshed: false,
  };
  const repo = await checkoutRepoSlug(input.dir);
  if (!repo) return checkoutRef;
  const request: Parameters<typeof refreshProjectMirror>[0] = {
    projectSlug: input.projectSlug,
    repo,
    token: null,
  };
  const cred = getProjectCredential(db, input.projectSlug);
  if (cred) request.token = getPatToken(db, cred.id);
  if (input.dataRoot) request.dataRoot = input.dataRoot;
  const mirror = await refreshProjectMirror(request);
  if (!mirror) {
    // Not an error path: the clone-time ref is still a real answer, and saying
    // so is what keeps the operator from substituting a working-tree read.
    logger.info(
      "no project repository mirror for the default-branch read — reading the checkout's clone-time ref",
      { projectSlug: input.projectSlug, repo, defaultBranch: input.defaultBranch },
    );
    return checkoutRef;
  }
  // The mirror is BARE: its branch heads are local refs, not `origin/…`.
  return {
    dir: mirror.dir,
    ref: `${input.defaultBranch}:${repoPath}`,
    refreshed: mirror.refreshed,
  };
}

/**
 * Read one file as the project's DEFAULT branch has it (`git show
 * <defaultBranch>:<path>`), from the project's mirror — or, when there is none,
 * from the task checkout's clone-time `origin/<defaultBranch>` ref. The checkout
 * is never written to, fetched into, or otherwise disturbed.
 */
export async function readDefaultBranchFile(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    /** Absolute path of the task checkout (OperatorWorkspaceView.dir). */
    dir: string;
    defaultBranch: string;
    /** Repository-relative path, e.g. `docs/guide.md`. */
    path: string;
    /** Test seam; production callers resolve the configured store root. */
    dataRoot?: string;
  },
): Promise<DefaultBranchRead> {
  if (!pathIsReadable(input.path)) {
    return {
      kind: "unavailable",
      reason:
        "that is not a repository-relative file path — pass a path like `docs/guide.md`, " +
        "with no leading slash, no `..` segment and no `ref:path` prefix",
    };
  }
  const source = await resolveReadSource(db, input, input.path.trim());
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", source.dir, "show", source.ref],
      {
        timeout: GIT_SHOW_TIMEOUT_MS,
        maxBuffer: DEFAULT_BRANCH_READ_MAX_BYTES * 4,
      },
    );
    const truncated = stdout.length > DEFAULT_BRANCH_READ_MAX_BYTES;
    return {
      kind: "found",
      text: truncated ? stdout.slice(0, DEFAULT_BRANCH_READ_MAX_BYTES) : stdout,
      truncated,
      refreshed: source.refreshed,
    };
  } catch (error) {
    const detail = redactGitOutput(gitErrorText(error));
    // git says `path 'x' does not exist in 'origin/main'` (or `exists on disk,
    // but not in …`) — both mean the same thing to the caller, and it is an
    // ANSWER, not a failure.
    if (/does not exist in|exists on disk, but not in/i.test(detail)) {
      return { kind: "absent" };
    }
    return {
      kind: "unavailable",
      reason: detail || "git could not read that ref",
    };
  }
}

/**
 * Ruling 299: the same read, for an actor with no checkout.
 *
 * `readDefaultBranchFile` takes a task workspace, because the operator always
 * has one. The CONTROLLER never does, and it is the actor that writes the
 * architecture, the knowledge bases and the goals that every agent is then
 * measured against, and that reviews the packets those agents raise. It found
 * this the way these are found: it endorsed an option on a security-scoped
 * decision whose central factual claim ("the goal names four routes,
 * `origin/main` has nine") it could only take second-hand, and reported that
 * "verify the claim against the repository yourself is the most-repeated rule
 * in this project's own rulings, and I am structurally unable to follow it."
 *
 * The checkout was never the source anyway: `resolveReadSource` prefers the
 * project MIRROR and only falls back to a checkout's clone-time ref. This
 * takes the repo and the branch from the PROJECT, so there is nothing to fall
 * back from -- and when the mirror cannot be built, it says so rather than
 * answering from somewhere else.
 */
export async function readProjectDefaultBranchFile(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    /** `owner/name`, from the project's own frontmatter. */
    repo: string;
    defaultBranch: string;
    /** Repository-relative path, e.g. `docs/guide.md`. */
    path: string;
    dataRoot?: string;
  },
): Promise<DefaultBranchRead> {
  const repoPath = input.path.trim();
  if (!pathIsReadable(repoPath)) {
    return {
      kind: "unavailable",
      reason:
        "that is not a repository-relative file path — pass a path like `docs/guide.md`, " +
        "with no leading slash, no `..` segment and no `ref:path` prefix",
    };
  }
  const request: Parameters<typeof refreshProjectMirror>[0] = {
    projectSlug: input.projectSlug,
    repo: input.repo,
    token: null,
    // The operator's read leaves this false because it can fall back to the
    // checkout's clone-time ref. There is no checkout here, so a missing
    // mirror would make the tool permanently unanswerable on exactly the
    // project where nothing has run yet -- which is when the controller is
    // doing the architecture work that most needs to read the repository.
    create: true,
  };
  // The residual, stated: on a project whose repository has never been cloned
  // on this instance, this builds the mirror inside the tool call, bounded by
  // the clone timeout (15 minutes by default). The controller's tool text says
  // so. The alternative was a tool that can never answer on exactly the
  // project where the architecture work happens, which is worse, and every
  // call after the first is a fetch.
  const cred = getProjectCredential(db, input.projectSlug);
  if (cred) request.token = getPatToken(db, cred.id);
  if (input.dataRoot) request.dataRoot = input.dataRoot;
  const mirror = await refreshProjectMirror(request);
  if (!mirror) {
    // No checkout to fall back to, and inventing one would be the exact error
    // this module exists to stop: answering about the default branch from a
    // tree that is not it.
    return {
      kind: "unavailable",
      reason:
        `no mirror of \`${input.repo}\` could be built for this project, so there is no copy of ` +
        `\`${input.defaultBranch}\` to read. Check the project's GitHub credential`,
    };
  }
  try {
    // The mirror is BARE: its branch heads are local refs, not `origin/…`.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", mirror.dir, "show", `${input.defaultBranch}:${repoPath}`],
      { timeout: GIT_SHOW_TIMEOUT_MS, maxBuffer: DEFAULT_BRANCH_READ_MAX_BYTES * 4 },
    );
    const truncated = stdout.length > DEFAULT_BRANCH_READ_MAX_BYTES;
    return {
      kind: "found",
      text: truncated ? stdout.slice(0, DEFAULT_BRANCH_READ_MAX_BYTES) : stdout,
      truncated,
      refreshed: mirror.refreshed,
    };
  } catch (error) {
    const detail = redactGitOutput(gitErrorText(error));
    if (/does not exist in|exists on disk, but not in/i.test(detail)) {
      return { kind: "absent" };
    }
    return { kind: "unavailable", reason: detail || "git could not read that ref" };
  }
}
