import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { createGitHubAskpassEnv } from "~/server/tasks/git-clone-auth.server";
import { gitErrorText, redactGitOutput } from "~/server/secrets/git-output-redact.server";
import {
  getPatToken,
  getProjectCredential,
} from "~/server/secrets/pat-store.server";
import { taskBranchName } from "./branch-sync.server";

/**
 * Server-side workspace push (F-GH3 — closing the governed-delivery gap).
 *
 * A real coding specialist commits INSIDE its cloned workspace but does not
 * push: the Codex Developer runs sandboxed with no network, and even a Claude
 * run's clone persists only the credential-free origin URL, so it holds no push
 * auth. Meanwhile the server-side delivery path opened the remote task branch at
 * the default branch's SHA (empty). Nobody bridged the two — the local commits
 * never reached the remote, so opening the review PR hit GitHub 422 ("no commits
 * between base and head") and the chain silently dead-ended at "nothing to
 * review".
 *
 * This runs at the review boundary, BEFORE opening the PR: it re-supplies the
 * project PAT via the same short-lived askpass mechanism the clone uses and
 * pushes the workspace's task branch to origin, so the remote branch carries the
 * real diff the PR needs. Best-effort and never throws — a missing PAT, missing
 * workspace, or offline remote degrades to a typed reason the caller surfaces.
 */

const execFileAsync = promisify(execFile);

/**
 * F19-21 — what the server ACTUALLY saw in a workspace whose HEAD sits on the
 * default branch, and therefore whether "this task changed nothing" is a
 * verified fact or a guess.
 *
 * `no_branch` covers two opposite situations that look identical from the ref
 * alone: a verification-only task whose run correctly changed nothing, and a
 * developer that edited files and forgot to `git checkout -B`. The second is a
 * genuine failure, and `performDelivery` reclassifies the first as a no-change
 * COMPLETION — so the distinction cannot rest on prose. `verified: true` is
 * emitted only after three read-only probes agree: a clean working tree, no
 * local commits the default branch does not carry, and no abandoned task branch
 * in the workspace.
 *
 * Every unknown is `verified: false` with its own `why`. A git command that
 * failed, a history that cannot be compared — those are states the server did
 * not read, and an unread workspace is never a verified zero-diff (the same
 * rule that keeps `no_workspace` out of the outcome entirely).
 */
export type DefaultBranchEvidence =
  | { verified: true }
  | { verified: false; why: string };

export type PushWorkspaceResult =
  | { status: "pushed"; branch: string; commits: number }
  /** B-GH1/F15-15: the remote branch holds commits the local delivery does not
   *  (non-fast-forward) — a HISTORY divergence, never a credential problem. The
   *  branch is carried so recovery copy can name what diverged. */
  | { status: "push_conflict"; branch: string; reason: string }
  /** F19-18: the residual failure bucket. `reason` is Viberr's own sentence;
   *  `detail` and `stderrExcerpt` both carry git's own text, scrubbed
   *  (`redactGitOutput`) — `detail` for the structured log field, `stderrExcerpt`
   *  for the human-facing "What the push reported" timeline block. Without them a
   *  protected-branch, pre-receive-hook or permission rejection reached the human
   *  as the literal words "git push returned non-zero", and the only way to learn
   *  the cause was to reproduce the push outside the product. */
  | { status: "push_failed"; reason: string; detail?: string; stderrExcerpt?: string }
  | {
      status: "no_branch";
      reason: string;
      /** Present only when HEAD is on the DEFAULT branch — the one shape a
       *  no-change completion can be read from. Absent for a detached or
       *  unreadable HEAD, and absent means "not verified": callers must require
       *  `defaultBranchEvidence?.verified === true`, never the status alone. */
      defaultBranchEvidence?: DefaultBranchEvidence;
    }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_commits"
        | "grant_withheld"
        | "task_not_found";
      reason: string;
      /** Same contract as the `no_branch` member above, for the OTHER door into
       *  a no-change completion. `no_commits` is decided AFTER the delivery
       *  auto-commit, and that block swallows its own failures (a failed
       *  `git add`/`commit` only logs). So "0 commits ahead" alone can mean
       *  "nothing to deliver" OR "the agent's work is still sitting uncommitted
       *  because the commit failed". Only a tree that is CLEAN at that point is
       *  evidence of the former. Absent means "not verified" here too. */
      defaultBranchEvidence?: DefaultBranchEvidence;
      /** F19-18: declared here too so a caller narrowed to the combined
       *  `push_failed | no_pat` failure block (task-actions `performDelivery`)
       *  can read git's excerpt across the union. Only `push_failed` ever
       *  populates it; on this family it is always absent. */
      stderrExcerpt?: string;
    };

/** Ceiling for the branch push itself (the one network step here). Shared with
 *  the branch-update path, which pushes the same branch the same way. */
export const PUSH_TIMEOUT_MS = 120_000;

/** How much of git's complaint fits inside a one-sentence timeline message
 *  (F19-18). The full redacted excerpt still rides `detail`. */
const REASON_EXCERPT_CHARS = 240;

/** Flatten a multi-line git excerpt into one readable clause: `performDelivery`
 *  drops the reason inside parentheses in a prose sentence, and git's hint
 *  blocks would otherwise shred it. */
function oneLine(excerpt: string): string {
  const flat = excerpt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
  return flat.length > REASON_EXCERPT_CHARS
    ? `${flat.slice(0, REASON_EXCERPT_CHARS - 1)}…`
    : flat;
}

/**
 * The structured fields this module's git log lines carry. The optional members
 * are OMITTED when they do not apply rather than written falsy: `timedOut:
 * false` on a push that simply failed reads as a fact the server checked, not an
 * absent one.
 */
type GitLogFields = {
  taskKey: string;
  branch?: string;
  err?: string;
  timedOut?: true;
  detail?: string;
};

/**
 * `push_failed` carrying git's own (already scrubbed) words. `redactGitOutput`
 * answers "" when git printed nothing, and every reader of the excerpt guards on
 * truthiness — so "git said nothing" stays the ABSENT key, not an empty one.
 */
function pushFailed(reason: string, detail: string): PushWorkspaceResult {
  const failure: Extract<PushWorkspaceResult, { status: "push_failed" }> = {
    status: "push_failed",
    reason,
  };
  if (detail) {
    failure.detail = detail;
    failure.stderrExcerpt = detail;
  }
  return failure;
}

export interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The child was KILLED (timeout), not merely unsuccessful. */
  timedOut?: boolean;
}

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

/** Exported ONLY so its timeout detection can be proven against a really-killed
 *  child. Injecting a fake `exec` in a test proves the classification above but
 *  says nothing about whether a kill is detected at all. */
export const defaultExec: Exec = async (file, args, opts) => {
  const options: ExecFileOptions = {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  };
  if (opts.env) options.env = opts.env;
  try {
    const { stdout, stderr } = await execFileAsync(file, args, options);
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
    // error that was never printed. Same failure the clone path had, one pipe
    // over: the true cause was "we did not wait long enough".
    if (rejection.killed || rejection.signal !== null) outcome.timedOut = true;
    return outcome;
  }
};

/**
 * Non-fast-forward classifier for `git push` stderr (B-GH1). git's rejection
 * text is stable across versions: `! [rejected] ... (non-fast-forward)` or the
 * `(fetch first)` hint when the remote ref moved. Exported for its unit test —
 * misclassifying here re-creates the F15-15 "blame the credential" copy.
 */
export function isNonFastForwardStderr(stderr: string): boolean {
  return (
    /non-fast-forward/i.test(stderr) ||
    /fetch first/i.test(stderr) ||
    (/\[rejected\]/i.test(stderr) && /behind its remote counterpart/i.test(stderr))
  );
}

/**
 * Commits on HEAD that the default branch does not carry — `null` when history
 * cannot answer honestly (A3).
 *
 * Two rules, both matching `reconcileWorkspaceDelivery`'s commit count, which
 * this path had drifted from:
 *  - compare against `origin/<default>`, the remote-tracking ref, not the LOCAL
 *    default branch: the agent owns the local one and a workspace is reused
 *    across runs;
 *  - specialist clones are `--depth 1`, so the range runs over truncated history
 *    and every reachable commit looks "ahead". Deepen first; a deepen that fails
 *    (offline, no remote) leaves the answer unknown rather than wrong.
 */
async function countCommitsAhead(
  exec: Exec,
  repoDir: string,
  defaultBranch: string,
): Promise<number | null> {
  const shallowRes = await exec(
    "git",
    ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  if (shallowRes.ok && shallowRes.stdout.trim() === "true") {
    const deepen = await exec(
      "git",
      ["-C", repoDir, "fetch", "--deepen", "50", "origin", defaultBranch],
      { cwd: repoDir, timeoutMs: 30_000 },
    );
    if (!deepen.ok) return null;
  }
  const countRes = await exec(
    "git",
    ["-C", repoDir, "rev-list", "--count", `origin/${defaultBranch}..HEAD`],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  if (!countRes.ok) return null;
  const parsed = Number.parseInt(countRes.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A single rev resolved to a sha, or "" when git cannot name it. */
async function revParse(
  exec: Exec,
  repoDir: string,
  rev: string,
): Promise<string> {
  const res = await exec(
    "git",
    ["-C", repoDir, "rev-parse", "--verify", "--quiet", rev],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  return res.ok ? res.stdout.trim() : "";
}

/**
 * Commits ahead of the default branch, with the local shortcut first (F19-21).
 *
 * `countCommitsAhead` deepens a shallow clone before it counts, and specialist
 * clones are `--depth 1` over an origin URL that carries NO credential — so on
 * a private repo that fetch can simply fail, and the honest answer is then
 * `null` (unknown). But the shape this exists for — a workspace that was cloned
 * and never moved — needs no history walk at all: HEAD identical to
 * `origin/<default>` is a complete proof of zero commits ahead, offline, in two
 * local reads. Anything else falls through to the real count.
 */
async function commitsAheadOfDefault(
  exec: Exec,
  repoDir: string,
  defaultBranch: string,
): Promise<number | null> {
  const head = await revParse(exec, repoDir, "HEAD");
  const base = await revParse(exec, repoDir, `origin/${defaultBranch}`);
  if (head !== "" && head === base) return 0;
  return countCommitsAhead(exec, repoDir, defaultBranch);
}

/** A local branch belonging to THIS task: the canonical `taskBranchName` form
 *  (`vib-1`) or the legacy `<key>-<slug>` one (`vib-1-normalize`). */
function isTaskBranchName(name: string, taskKey: string): boolean {
  const canonical = taskBranchName(taskKey);
  return name === canonical || name.startsWith(`${canonical}-`);
}

/**
 * F19-21 — the read-only honesty check behind `DefaultBranchEvidence`.
 *
 * Runs BEFORE the delivery auto-commit block and touches nothing: `git status`,
 * `git for-each-ref` and a commit count. The order is deliberate — the two local
 * probes come first so a dirty tree or an abandoned task branch is answered
 * without the count's network deepen.
 */
async function readDefaultBranchEvidence(
  exec: Exec,
  repoDir: string,
  defaultBranch: string,
  taskKey: string,
): Promise<DefaultBranchEvidence> {
  const statusRes = await exec("git", ["-C", repoDir, "status", "--porcelain"], {
    cwd: repoDir,
    timeoutMs: 5_000,
  });
  if (!statusRes.ok) {
    return { verified: false, why: "its working tree could not be read" };
  }
  const dirtyPaths = statusRes.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (dirtyPaths.length > 0) {
    // The exact case this check exists for: the agent EDITED files and never
    // branched. Uncommitted work is work, so this stays a delivery failure.
    return {
      verified: false,
      why:
        `its working tree holds uncommitted changes (${dirtyPaths.length} path` +
        `${dirtyPaths.length === 1 ? "" : "s"}) that never reached a task branch`,
    };
  }
  const refsRes = await exec(
    "git",
    ["-C", repoDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  if (!refsRes.ok) {
    return { verified: false, why: "its local branches could not be listed" };
  }
  const taskBranch = refsRes.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((name) => name !== defaultBranch && isTaskBranchName(name, taskKey));
  if (taskBranch) {
    return {
      verified: false,
      why: `the task branch \`${taskBranch}\` exists in the workspace but HEAD is not on it`,
    };
  }
  const ahead = await commitsAheadOfDefault(exec, repoDir, defaultBranch);
  if (ahead === null) {
    return {
      verified: false,
      why: `its history could not be compared with origin/${defaultBranch}`,
    };
  }
  if (ahead > 0) {
    return {
      verified: false,
      why:
        `it carries ${ahead} local commit${ahead === 1 ? "" : "s"} ` +
        `that origin/${defaultBranch} does not`,
    };
  }
  return { verified: true };
}

/**
 * The git identity args for a workspace commit — none when the clone already
 * carries one (cloneRepo stamps it to the delivering profile, matching the
 * agent's own commits), a stable Viberr identity otherwise so a fresh clone
 * with no identity never dead-ends the commit (F24).
 *
 * Shared with the branch-update path: both write a server-owned commit into the
 * same workspace, and two different fallback identities in one branch's history
 * would read as two different authors doing Viberr's work.
 */
export async function commitIdentityArgs(
  exec: Exec,
  repoDir: string,
): Promise<string[]> {
  const emailRes = await exec("git", ["-C", repoDir, "config", "user.email"], {
    cwd: repoDir,
    timeoutMs: 5_000,
  });
  return emailRes.ok && emailRes.stdout.trim() !== ""
    ? []
    : [
        "-c",
        "user.name=Viberr Delivery",
        "-c",
        "user.email=delivery@viberr.local",
      ];
}

/** Locate the workspace git repo for a task (same conventions as the reconciler). */
export function findWorkspaceRepoDir(
  projectSlug: string,
  taskKey: string,
  repoName: string,
  dataRoot?: string,
  workdir?: string | null,
): string | null {
  const wsRoot = path.join(taskDir(projectSlug, taskKey, dataRoot), "workspace");
  const candidates = [
    workdir ?? null,
    path.join(wsRoot, repoName),
    path.join(wsRoot, "repo"),
    wsRoot,
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(path.join(c, ".git"))) ?? null;
}

export interface PushWorkspaceBranchInput {
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  workdir?: string | null;
  /**
   * Whether the DELIVERING profile is authorized to write/commit/push the repo
   * (its `execute-code-or-write-repo` / `commit-push-branch` grant, resolved by
   * the caller). Defaults to `true` for callers/tests that don't gate. When
   * `false`, the server refuses to stage/commit/push the workspace — capability
   * grants shown as enforced must actually constrain server-owned delivery
   * (F10-03). This is the real enforcement for Codex, which ignores the tool
   * denylist and could otherwise write + have its dirty tree auto-committed.
   */
  canCommitPush?: boolean;
  /** Injected runner (tests). */
  exec?: Exec;
}

/**
 * Push the task's workspace branch to origin using the project PAT. Returns a
 * typed result; never throws. `pushed` means the remote now carries the local
 * commits (a `git push` with nothing new still reports `pushed`); `no_commits`
 * means the branch had no local commits ahead of the default branch; every
 * other status is a degraded reason the caller can log or surface.
 */
export async function pushWorkspaceBranch(
  input: PushWorkspaceBranchInput,
): Promise<PushWorkspaceResult> {
  const { db, projectSlug, taskKey, dataRoot } = input;
  const exec = input.exec ?? defaultExec;
  // F19-18: hoisted so BOTH the push-failure branch and the outer catch can
  // scrub git's words by value before anyone reads them.
  let token = "";
  try {
    const ref = {
      projectSlug,
      taskKey,
      dataRoot,
    };
    // The task file is still read as the existence check — a push against a
    // task that has no canonical record must not proceed.
    if (!readTaskFile(ref)) {
      return { status: "task_not_found", reason: "task file missing" };
    }

    const projectFile = readProjectFile({
      projectSlug,
      dataRoot,
    });
    // P13-D-5: one project, one repository — the task-level override is gone.
    const repo = projectFile?.parsed.frontmatter.repo ?? null;
    if (!repo) return { status: "no_repo", reason: "project has no repo" };
    const defaultBranch =
      projectFile?.parsed.frontmatter.defaultBranch || "main";
    const repoName = repo.split("/").pop() ?? repo;

    const repoDir = findWorkspaceRepoDir(
      projectSlug,
      taskKey,
      repoName,
      dataRoot,
      input.workdir,
    );
    if (!repoDir) {
      return { status: "no_workspace", reason: "no workspace git repo" };
    }

    // The branch HEAD is on (a real task branch, not the default branch).
    const headRes = await exec(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const branch = headRes.ok ? headRes.stdout.trim() : "";
    if (!branch || branch === "HEAD" || branch === defaultBranch) {
      // F19-21: `performDelivery` may reclassify a default-branch `no_branch`
      // as a VERIFIED no-change completion, so this return has to carry what
      // the server actually saw. The evidence is read-only and never reaches
      // the auto-commit block below — a workspace on the default branch is
      // never staged or committed, whatever it holds.
      if (branch !== defaultBranch) {
        // Both of these land inside a delivery sentence, so they say what the
        // reader can act on rather than restating the status ("HEAD not on a
        // task branch (HEAD)" was the old, circular form).
        return {
          status: "no_branch",
          reason:
            branch === "HEAD"
              ? "HEAD is detached, so there is no branch to push"
              : "the workspace's HEAD could not be read",
        };
      }
      const evidence = await readDefaultBranchEvidence(
        exec,
        repoDir,
        defaultBranch,
        taskKey,
      );
      return {
        status: "no_branch",
        reason: evidence.verified
          ? `HEAD is on the default branch (${defaultBranch}) with a clean working tree, ` +
            `no local commits and no task branch`
          : `HEAD is on the default branch (${defaultBranch}) and ${evidence.why}`,
        defaultBranchEvidence: evidence,
      };
    }

    // F10-03: server-owned delivery honors the delivering profile's repo-write
    // grant. If that capability is withheld, the server must NOT stage, commit,
    // or push the workspace — otherwise a "read-only" or grant-withheld profile
    // (notably a Codex run, which ignores the tool denylist) could still have
    // its dirty tree delivered. Refuse before touching the index or the remote.
    if (input.canCommitPush === false) {
      logger.info("skipping workspace delivery — repo-write grant withheld", {
        taskKey,
        branch,
      });
      return {
        status: "grant_withheld",
        reason: "delivering profile's repository-write capability is withheld",
      };
    }

    // Server-side DELIVERY FINALIZATION: if the agent WROTE changes but never
    // committed them, commit the working tree now so delivery reaches the
    // branch. The agent may not commit for legitimate reasons — its
    // `execute-code-or-write-repo` grant is withheld (so its prompt is told NOT
    // to commit), a Codex run wrote files but read its "workspace contract" as
    // prohibiting commit, etc. At the Review boundary those changes ARE the
    // deliverable (the human reviews the resulting PR), and delivery must not
    // dead-end just because the agent left them uncommitted. A well-behaved
    // agent that already committed leaves a clean tree here — this is a no-op
    // for it. Only reachable once HEAD is confirmed on the task branch (never
    // the default), so it can never auto-commit onto main.
    const statusRes = await exec(
      "git",
      ["-C", repoDir, "status", "--porcelain"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    if (statusRes.ok && statusRes.stdout.trim() !== "") {
      // F15: `git add -A` intentionally delivers the agent's whole working tree
      // (the uncommitted changes ARE the deliverable) and already honors
      // `.gitignore`, so build artifacts / deps stay out. Capture the file list
      // so unexpected/stray files in a REUSED workspace are visible for review
      // rather than silently shipped into the PR.
      const changedFiles = statusRes.stdout
        .trim()
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      const addRes = await exec(
        "git",
        ["-C", repoDir, "add", "-A"],
        { cwd: repoDir, timeoutMs: 15_000 },
      );
      if (addRes.ok) {
        // F24: prefer the workspace's configured identity, fall back to a stable
        // Viberr identity (see commitIdentityArgs).
        const identityArgs = await commitIdentityArgs(exec, repoDir);
        const commitRes = await exec(
          "git",
          [
            "-C",
            repoDir,
            ...identityArgs,
            "commit",
            "-m",
            `[${taskKey}] deliver working-tree changes from the agent run`,
          ],
          { cwd: repoDir, timeoutMs: 20_000 },
        );
        if (commitRes.ok) {
          logger.info("committed uncommitted workspace changes for delivery", {
            taskKey,
            branch,
            files: changedFiles,
          });
        } else {
          logger.info("delivery auto-commit failed — pushing existing commits only", {
            taskKey,
            branch,
          });
        }
      }
    }

    // Count local commits not on the default branch — nothing to push otherwise.
    // `null` is UNKNOWN and is NOT "no commits": a failed rev-list used to read
    // as 0, so a real delivery reported `no_commits` and the caller opened a PR
    // over a remote nobody had pushed to (A3, the F15-15 hazard class through a
    // different door). Unknown pushes: a push with nothing new is a no-op, while
    // skipping one that had commits is the failure that matters.
    const localAhead = await countCommitsAhead(exec, repoDir, defaultBranch);
    if (localAhead === 0) {
      // The auto-commit block above logs its failures and falls through, so
      // reaching 0-ahead does NOT by itself mean there was nothing to deliver.
      // Re-read the tree: only a CLEAN one is evidence of a genuine zero-diff.
      // A still-dirty tree here means the deliverable never made it into a
      // commit, which is a delivery failure, not "no changes required".
      const postStatus = await exec(
        "git",
        ["-C", repoDir, "status", "--porcelain"],
        { cwd: repoDir, timeoutMs: 15_000 },
      );
      const evidence: DefaultBranchEvidence = !postStatus.ok
        ? { verified: false, why: "git could not read the workspace state after the delivery commit" }
        : postStatus.stdout.trim() !== ""
          ? {
              verified: false,
              why: "the workspace still has uncommitted changes after the delivery commit attempt",
            }
          : { verified: true };
      return {
        status: "no_commits",
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: evidence,
      };
    }

    const credential = getProjectCredential(db, projectSlug);
    token = (credential ? getPatToken(db, credential.id) : null) ?? "";
    if (!token) return { status: "no_pat", reason: "no project credential" };

    const askpass = createGitHubAskpassEnv({ token });
    try {
      const pushRes = await exec(
        "git",
        ["-C", repoDir, "push", "origin", `HEAD:refs/heads/${branch}`],
        { cwd: repoDir, timeoutMs: PUSH_TIMEOUT_MS, env: askpass.env },
      );
      if (!pushRes.ok) {
        // B-GH1/F15-15: a NON-FAST-FORWARD rejection is a history divergence
        // (the remote branch carries commits the local delivery does not — a
        // pre-existing branch under the task key, a rebase, a reused
        // workspace), and it must never be reported as a credential problem.
        // git names it deterministically on stderr; classify before redacting.
        if (isNonFastForwardStderr(pushRes.stderr)) {
          logger.info("workspace branch push rejected non-fast-forward", {
            taskKey,
            branch,
          });
          return {
            status: "push_conflict",
            branch,
            reason:
              `the remote branch \`${branch}\` holds commits that are not in ` +
              `the local delivery (non-fast-forward)`,
          };
        }
        // F19-18: the residual bucket — a protected branch, a push ruleset, a
        // pre-receive hook, a 403, DNS — used to collapse to the fixed string
        // "git push returned non-zero", and git's stderr was retained NOWHERE:
        // not on the timeline event `performDelivery` builds from this reason,
        // not in this log line, not in any run log. The maintainer had to
        // reproduce the push by hand outside Viberr to learn the cause, which
        // is exactly the failure the UX spec calls make-or-break.
        //
        // git's stderr is SCRUBBED, not dropped: the PAT reaches git only
        // through the askpass env (`createGitHubAskpassEnv`), never argv and
        // never the remote URL, so `redactGitOutput` scrubs BY VALUE and keeps
        // git's diagnosis — the only text that can name the cause.
        //
        // WARN, not info, for the same reason the clone path is: a delivery that
        // did not happen changes what the review PR would have contained.
        const detail = redactGitOutput(pushRes.stderr, { token });
        const fields: GitLogFields = { taskKey, branch };
        if (pushRes.timedOut) fields.timedOut = true;
        if (detail) fields.detail = detail;
        logger.warn("workspace branch push failed", fields);
        return pushFailed(
          // `performDelivery` interpolates this INSIDE a sentence, so the
          // human-facing form is one line; the untouched multi-line excerpt
          // rides the structured field and the log line.
          pushRes.timedOut
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : detail
              ? `git push failed — git said: ${oneLine(detail)}`
              : "git push returned non-zero, and git printed nothing to explain it",
          detail,
        );
      }
    } finally {
      askpass.dispose();
    }

    logger.info("pushed workspace branch to origin", {
      taskKey,
      branch,
      commits: localAhead,
    });
    // `commits: null` (history unreadable) reports 0 — the push happened, the
    // count is the only thing we don't know.
    return { status: "pushed", branch, commits: localAhead ?? 0 };
  } catch (error) {
    // F19-18: "unexpected error" named nothing either. Same redacted channel.
    const detail = redactGitOutput(gitErrorText(error), { token });
    const fields: GitLogFields = {
      taskKey,
      err: error instanceof Error ? error.message : String(error),
    };
    if (detail) fields.detail = detail;
    logger.info("workspace branch push errored — skipping", fields);
    return pushFailed(
      detail
        ? `the push could not run — ${oneLine(detail)}`
        : "the push could not run, and the failure carried no message",
      detail,
    );
  }
}

/**
 * F20-6 (R20-2) — the outcome of discarding a task's LOCAL, never-pushed
 * workspace branch. `deleted` carries the sha it read before removing the ref
 * so the audit + timeline note can name exactly what was destroyed; `on_remote`
 * is the refusal that keeps ruling 17's promise (remote-branch deletion lives
 * only in the archive packet); `failed.reason` is git's own words, redacted
 * (ruling 69).
 */
export type DiscardBranchOutcome =
  | { status: "deleted"; branch: string; sha: string }
  | { status: "not_found"; branch: string }
  | { status: "on_remote"; branch: string }
  | { status: "no_workspace"; branch: string }
  | { status: "failed"; branch: string; reason: string };

/**
 * Delete a task's LOCAL workspace branch on the human's `discard_branch` confirm
 * (Spec 2 §2.5). The operator that authored the option holds no repo-write tool
 * — repo writes are human authority — so its option was inert until this
 * executor ran on the confirm (F20-6: the human had to `git branch -D` by hand).
 *
 * It touches ONLY the workspace clone and refuses the moment the branch exists
 * on origin: this is cleanup for a branch that was never pushed, not a
 * disposition, and remote deletion stays the archive packet's job (ruling 17).
 *
 * Best-effort like the rest of this module — a git failure becomes a typed
 * `failed` outcome, never a throw that could un-resolve the packet the caller
 * already recorded.
 */
export async function discardLocalTaskBranch(input: {
  projectSlug: string;
  taskKey: string;
  branch: string;
  defaultBranch: string;
  dataRoot?: string;
  workdir?: string | null;
  exec?: Exec;
}): Promise<DiscardBranchOutcome> {
  const { projectSlug, taskKey, branch, defaultBranch, dataRoot } = input;
  const exec = input.exec ?? defaultExec;
  try {
    const projectFile = readProjectFile({ projectSlug, dataRoot });
    const repo = projectFile?.parsed.frontmatter.repo ?? null;
    const repoName = repo ? (repo.split("/").pop() ?? repo) : "repo";
    const repoDir = findWorkspaceRepoDir(
      projectSlug,
      taskKey,
      repoName,
      dataRoot,
      input.workdir,
    );
    if (!repoDir) return { status: "no_workspace", branch };

    // Read the branch sha BEFORE any deletion — the outcome must name what it
    // destroyed. An empty answer means the branch is not in this workspace.
    const sha = await revParse(exec, repoDir, `refs/heads/${branch}`);
    if (sha === "") return { status: "not_found", branch };

    // Ruling 17: only a never-pushed branch may be discarded here. `ls-remote
    // --exit-code` exits 0 when origin carries the ref — that is the remote's
    // branch, and only the archive packet may delete it.
    const remote = await exec(
      "git",
      ["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", branch],
      { cwd: repoDir, timeoutMs: 30_000 },
    );
    if (remote.ok) return { status: "on_remote", branch };

    // git refuses to delete the branch HEAD is on, so step onto the default
    // branch first when we are standing on the one being discarded.
    const headRes = await exec(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    if (headRes.ok && headRes.stdout.trim() === branch) {
      const checkout = await exec(
        "git",
        ["-C", repoDir, "checkout", defaultBranch],
        { cwd: repoDir, timeoutMs: 30_000 },
      );
      if (!checkout.ok) {
        const reason = redactGitOutput(checkout.stderr) || "git checkout failed";
        return { status: "failed", branch, reason: oneLine(reason) };
      }
    }

    const del = await exec("git", ["-C", repoDir, "branch", "-D", branch], {
      cwd: repoDir,
      timeoutMs: 5_000,
    });
    if (!del.ok) {
      const reason = redactGitOutput(del.stderr) || "git branch -D returned non-zero";
      return { status: "failed", branch, reason: oneLine(reason) };
    }

    logger.info("discarded local task branch", { taskKey, branch, sha });
    return { status: "deleted", branch, sha };
  } catch (error) {
    const reason =
      redactGitOutput(gitErrorText(error)) || "the discard could not run";
    logger.info("discard local task branch errored", {
      taskKey,
      branch,
      err: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", branch, reason: oneLine(reason) };
  }
}
