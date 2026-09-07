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
  | {
      status: "pushed";
      branch: string;
      commits: number;
      /** Ruling 134: the workspace head the push published (full sha), or null
       *  when git could not name HEAD (the push still ran). */
      headSha: string | null;
      /** Ruling 134: origin's head for the branch BEFORE the push (full sha),
       *  or null when the branch did not exist on origin or could not be read. */
      remoteHeadBefore: string | null;
      /** Ruling 144: the files under `.github/workflows/` this push changed, as
       *  GitHub measures them (from origin's head, or the base on a first push).
       *  `null` when history could not answer — an unmeasured push, which is
       *  not the same claim as a measured empty list. */
      workflowFiles: string[] | null;
    }
  /**
   * Ruling 144: a push of `.github/workflows/*` refused for the `workflow`
   * scope. `before_push`: the bound classic token's published scopes lack it,
   * so the push was not attempted; `github`: GitHub itself refused it (any
   * token kind). Either way `performDelivery` opens the scope violation.
   */
  | {
      status: "push_refused_scope";
      branch: string;
      scope: "workflow";
      phase: "before_push" | "github";
      files: string[];
      reason: string;
    }
  /**
   * Ruling 159 (pass 35, F35-10): the revision's tree carries Viberr's own
   * store layout (`projects/<slug>/tasks/...`), the path an older prompt named
   * store-relatively and an agent created inside its checkout. Viberr never
   * publishes its store layout into a customer repository, whatever an agent
   * did: no push ran, and `files` names every offending path for the refusal
   * `performDelivery` reports on the task.
   */
  | {
      status: "push_refused_store_layout";
      branch: string;
      files: string[];
      reason: string;
    }
  /** Ruling 134: origin already carries the workspace head; no push ran.
   *  The only honest noop for a delivery: the PR (if any) is up to date. */
  | { status: "up_to_date"; branch: string; headSha: string }
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

/** Ruling 134: the pre-push read of origin's branch head. */
const LS_REMOTE_TIMEOUT_MS = 30_000;
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
  /** Commits the push carried — a REAL count, never a placeholder. */
  commits?: number;
  /** F21-22: set instead of `commits` when the history could not be counted
   *  (a shallow clone whose deepen failed). `commits: null` used to be logged
   *  there, and a reader parses that as zero — the operator-deliver path looked
   *  like it had pushed nothing while the agent path showed a count. */
  commitsUnknown?: true;
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
 * Ruling 144(c): GitHub's refusal of a workflow-file push for a token without
 * the `workflow` scope ("refusing to allow a Personal Access Token to create
 * or update workflow `.github/workflows/ci.yml` without `workflow` scope").
 * Exported for its unit test.
 */
export function isWorkflowScopeRejection(stderr: string): boolean {
  return /refusing to allow .*(create|update) workflow/i.test(stderr) && /workflow.? scope/i.test(stderr);
}

/**
 * Ruling 144(b): the files under `.github/workflows/` a push changes, measured
 * as GitHub measures the ref update: from origin's current head for the
 * branch, and from the base branch only when the branch does not exist on
 * origin yet. A branch whose workflow file already reached origin is never
 * refused for a push that does not touch it. Unreadable history reads as
 * nothing (the push itself then answers, ruling 144(c)).
 */
async function changedWorkflowFiles(
  exec: Exec,
  repoDir: string,
  remoteHead: string | null,
  defaultBranch: string,
): Promise<string[] | null> {
  const listFrom = async (range: string): Promise<string[] | null> => {
    const res = await exec(
      "git",
      ["-C", repoDir, "log", "--format=", "--name-only", range, "--", ".github/workflows/"],
      { cwd: repoDir, timeoutMs: 10_000 },
    );
    if (!res.ok) return null;
    return [...new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
  };
  if (remoteHead) {
    const files = await listFrom(`${remoteHead}..HEAD`);
    if (files) return files;
  }
  // Pass 34 review: `null` is "history could not answer" (a shallow clone with
  // no `origin/<default>`, an unreadable remote head), NOT "no workflow files
  // changed". An empty array is a MEASUREMENT; conflating the two let a
  // degraded read silently stand in for proof — the pre-push refusal skipped
  // and, worse, ruling 144(c)'s resolution of a standing violation claimed
  // nothing was pushed when nothing was measured.
  return listFrom(`origin/${defaultBranch}..HEAD`);
}

/** Ruling 159: the store's own layout for one project, as a tree prefix. */
export function storeLayoutPrefix(projectSlug: string): string {
  return `projects/${projectSlug}/tasks/`;
}

/**
 * Ruling 159 (pass 35, F35-10): every path in the revision's tree that lies
 * under the store's own layout for this project. Read from HEAD itself
 * (`git ls-tree -r -z --name-only HEAD -- <prefix>`), not from a range: a path
 * that reached origin under an older prompt is still Viberr's layout in a
 * customer repository, and the next delivery must refuse to carry it forward
 * until a person removes it. `null` when git could not read the tree at all,
 * which is not a measurement (the push then answers for itself).
 */
export async function storeLayoutFilesInTree(
  exec: Exec,
  repoDir: string,
  projectSlug: string,
): Promise<string[] | null> {
  const prefix = storeLayoutPrefix(projectSlug);
  const res = await exec(
    "git",
    // `-z` is what makes this a MEASUREMENT. Without it git prints paths under
    // `core.quotePath` (on by default), so a name carrying a single non-ASCII
    // byte — an accented screenshot an agent saved — comes back C-quoted as
    // `"projects/…/r\303\251sum\303\251.png"`, starting with a double quote.
    // The prefix filter then dropped it and the guard reported a clean tree:
    // the one failure mode ruling 159(b) cannot have, because an empty list
    // means "no store layout" and lets the push go. `-z` also ends the need to
    // trim, so a name with leading or trailing spaces is reported verbatim.
    ["-C", repoDir, "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", prefix],
    { cwd: repoDir, timeoutMs: 10_000 },
  );
  if (!res.ok) return null;
  return res.stdout.split("\0").filter((line) => line.startsWith(prefix));
}

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
 * typed result; never throws.
 *
 * Ruling 134 (pass 34, F34-11): delivery is defined by the REMOTE, not by a
 * cached PR state. Before pushing, origin's head for the branch is read
 * (`git ls-remote --heads origin <branch>`, under the same askpass env as the
 * push): equal to the workspace HEAD → `up_to_date`, no push; otherwise the
 * push runs and `pushed` carries the head it published and the remote head
 * it replaced (`remoteHeadBefore`, null when the branch was absent on origin
 * or could not be read). An unreadable HEAD skips the compare and pushes as
 * before, with `headSha: null`. `no_commits` means the branch had no local
 * commits ahead of the default branch; every other status is a degraded
 * reason the caller can log or surface.
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

    // Ruling 159 (F35-10): a tree that carries the store's own layout is never
    // pushed, whether the agent committed it or the auto-commit above just
    // did. Decided on HEAD's tree, before the commit count, so a branch that
    // already published the layout under an older prompt is refused too.
    const storeLayoutFiles = await storeLayoutFilesInTree(exec, repoDir, projectSlug);
    if (storeLayoutFiles === null) {
      logger.info("could not read the workspace tree for the store-layout check", {
        taskKey,
        branch,
      });
    } else if (storeLayoutFiles.length > 0) {
      logger.info("workspace branch push refused: the tree carries the store layout", {
        taskKey,
        branch,
        files: storeLayoutFiles,
      });
      return {
        status: "push_refused_store_layout",
        branch,
        files: storeLayoutFiles,
        reason:
          `the branch carries ${storeLayoutFiles.map((f) => `\`${f}\``).join(", ")}, ` +
          `which is Viberr's own store layout (\`${storeLayoutPrefix(projectSlug)}\`), not part of the repository`,
      };
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
    let pushedHead = "";
    let pushedRemoteBefore: string | null = null;
    let pushedWorkflowFiles: string[] | null = null;
    try {
      // Ruling 134: what does origin hold for this branch right now? Read
      // BEFORE the push so the delivery can say what moved, and skip the push
      // entirely when origin already carries the workspace head.
      const headSha = await revParse(exec, repoDir, "HEAD");
      pushedHead = headSha;
      let remoteHeadBefore: string | null = null;
      if (headSha) {
        const remoteRes = await exec(
          "git",
          ["-C", repoDir, "ls-remote", "--heads", "origin", branch],
          { cwd: repoDir, timeoutMs: LS_REMOTE_TIMEOUT_MS, env: askpass.env },
        );
        if (remoteRes.ok) {
          const remoteSha = remoteRes.stdout.trim().split(/\s+/)[0] ?? "";
          remoteHeadBefore = /^[0-9a-f]{40}$/i.test(remoteSha) ? remoteSha : null;
          pushedRemoteBefore = remoteHeadBefore;
          if (remoteHeadBefore === headSha) {
            logger.info("workspace branch already on origin — no push needed", {
              taskKey,
              branch,
            });
            return { status: "up_to_date", branch, headSha };
          }
        } else {
          // An unreadable remote never blocks the push: the push itself is the
          // authority, and a non-fast-forward is still classified below.
          logger.info("could not read origin's head for the branch before pushing", {
            taskKey,
            branch,
            detail: redactGitOutput(remoteRes.stderr, { token }),
          });
        }
      }
      // Ruling 144(b): the workflow files this push would change, measured
      // as GitHub measures them (origin's head for the branch; the base only
      // on a first push). A classic token whose published list lacks
      // `workflow` is refused HERE, with the remedy named, before GitHub is
      // asked; a fine-grained token (no list to read) pushes and lets GitHub
      // answer, classified below.
      const workflowFiles = await changedWorkflowFiles(exec, repoDir, pushedRemoteBefore, defaultBranch);
      pushedWorkflowFiles = workflowFiles;
      if (workflowFiles === null) {
        // Nothing to refuse on and nothing to prove with: the push goes ahead
        // and GitHub's own answer classifies it (ruling 144(c)).
        logger.info("could not measure the workflow files this push changes", {
          taskKey,
          branch,
        });
      }
      const validation = credential?.validation ?? null;
      if (
        workflowFiles !== null &&
        workflowFiles.length > 0 &&
        validation?.tokenKind === "classic" &&
        validation.headerScopes !== null &&
        !validation.headerScopes.includes("workflow")
      ) {
        logger.info("workspace branch push refused before GitHub: workflow scope", {
          taskKey,
          branch,
          files: workflowFiles,
        });
        return {
          status: "push_refused_scope",
          branch,
          scope: "workflow",
          phase: "before_push",
          files: workflowFiles,
          reason: `the project's classic token has no \`workflow\` scope, and this push changes ${workflowFiles.map((f) => `\`${f}\``).join(", ")}`,
        };
      }
      const pushRes = await exec(
        "git",
        ["-C", repoDir, "push", "origin", `HEAD:refs/heads/${branch}`],
        { cwd: repoDir, timeoutMs: PUSH_TIMEOUT_MS, env: askpass.env },
      );
      if (!pushRes.ok) {
        // Ruling 144(c): GitHub's own refusal of a workflow-file push, on any
        // token kind, is a scope fact and never the generic failure bucket.
        if (isWorkflowScopeRejection(pushRes.stderr)) {
          logger.info("workspace branch push refused by GitHub: workflow scope", {
            taskKey,
            branch,
            files: workflowFiles ?? [],
          });
          return {
            status: "push_refused_scope",
            branch,
            scope: "workflow",
            phase: "github",
            files: workflowFiles ?? [],
            reason: oneLine(redactGitOutput(pushRes.stderr, { token })) || "GitHub refused the workflow-file push",
          };
        }
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
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s because it ran past its time limit rather than failing`
            : detail
              ? `git push failed (git said: ${oneLine(detail)})`
              : "git push returned non-zero, and git printed nothing to explain it",
          detail,
        );
      }
    } finally {
      askpass.dispose();
    }

    const pushed: GitLogFields = { taskKey, branch };
    if (localAhead === null) pushed.commitsUnknown = true;
    else pushed.commits = localAhead;
    logger.info("pushed workspace branch to origin", pushed);
    // The RESULT's `commits` is a number by contract, so an unreadable history
    // reports 0 there — the push happened, the count is the only thing we don't
    // know, and the log line above is where that difference is stated.
    return {
      status: "pushed",
      branch,
      commits: localAhead ?? 0,
      headSha: pushedHead || null,
      remoteHeadBefore: pushedRemoteBefore,
      workflowFiles: pushedWorkflowFiles,
    };
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
        ? `the push could not run (${oneLine(detail)})`
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
  /** The project's PAT is resolved from here so the ruling-17 remote check can
   *  actually answer on a PRIVATE repo. Optional only so the existing exec-fake
   *  tests keep working; a caller without one gets the anonymous check, which
   *  still refuses when it cannot reach a verdict. */
  db?: DatabaseSync;
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
    //
    // This ran with NO credential, so on a private repo it always failed to
    // authenticate — and the code below read every failure as "not on the
    // remote" and deleted the branch anyway, destroying commits while
    // recording that it had verified something it could never ask. Two fixes:
    // carry the project's PAT the way every other remote read in this module
    // does, and treat "could not ask" as a refusal rather than a green light.
    // No `origin` at all is a definite answer, not a failed question: a branch
    // cannot exist on a remote the clone does not have. Ask this first so the
    // refusal below is reserved for a remote that EXISTS and would not answer.
    const originRes = await exec(
      "git",
      ["-C", repoDir, "remote", "get-url", "origin"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const hasOrigin = originRes.ok && originRes.stdout.trim() !== "";

    const credential = input.db ? getProjectCredential(input.db, projectSlug) : null;
    const token =
      (input.db && credential ? getPatToken(input.db, credential.id) : null) ?? "";
    const askpassInput: Parameters<typeof createGitHubAskpassEnv>[0] = {};
    if (token) askpassInput.token = token;
    const askpass = createGitHubAskpassEnv(askpassInput);
    // Without `--exit-code` the command SUCCEEDS whether or not it matched, so
    // the three cases separate cleanly on `ok` + stdout — the same read the
    // delivery push above performs. `--exit-code` conflated "origin does not
    // carry it" with every kind of failure into one non-zero exit.
    // Only ask when there is a remote to ask. `--exit-code` used to conflate
    // "origin does not carry it" with every kind of failure into one non-zero
    // exit; without it the command succeeds whether or not it matched, so the
    // cases separate cleanly on `ok` + stdout — the same read the delivery
    // push above performs.
    if (hasOrigin) {
      let remote;
      try {
        remote = await exec(
          "git",
          ["-C", repoDir, "ls-remote", "--heads", "origin", branch],
          { cwd: repoDir, timeoutMs: 30_000, env: askpass.env },
        );
      } finally {
        askpass.dispose();
      }
      if (!remote.ok) {
        // The question went unanswered (auth refused, network, DNS, timeout).
        // A destructive operation must not proceed on an unanswered safety
        // question — which is exactly what deleting here used to do.
        const why = redactGitOutput(remote.stderr) || "git ls-remote failed";
        return {
          status: "failed",
          branch,
          reason: oneLine(
            `could not confirm whether ${branch} exists on origin, so it was not discarded: ${why}`,
          ),
        };
      }
      if (remote.stdout.trim() !== "") return { status: "on_remote", branch };
    } else {
      askpass.dispose();
    }

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
