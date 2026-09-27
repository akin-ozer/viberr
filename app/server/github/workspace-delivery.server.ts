import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  FileActorRef,
  PrRef,
  TaskFileEvent,
  TaskFrontmatter, UnpushedRevision } from "~/schemas/task-file.schema";
import {
  DIVERGED_BRANCH_REMEDY,
  activeWorkRevision,
  deriveValidation,
  nextWorkRevision,
  type GithubCache,
} from "~/schemas/task-file.schema";
import { newId } from "~/shared/ids/new-id.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  recordRecommendationWithdrawal,
  withdrawAcceptanceOffers,
  type OfferWithdrawalSlot,
  type OfferWithdrawalCause,
} from "~/server/tasks/task-mutation.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { serverGitEnv } from "~/server/tasks/git-clone-auth.server";
import { taskWorkspaceGit, type WorkspaceGit } from "~/server/tasks/workspace-git.server";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";
import type { PrCacheState } from "./pr-linker.server";
import { POLICY_ENGINE_ACTOR } from "./scope-flag.server";
import { errorMessage } from "~/shared/errors";

/** The github cache a workspace-side collision note writes: the base cache's
 *  footprint plus the unowned PR, carrying the reconciler's foreign-head
 *  record only while it stands (ruling 161). */
function collisionCache(base: GithubCache | null, unownedPr: number): GithubCache {
  const cache: GithubCache = {
    commits: base?.commits ?? [],
    changed: base?.changed ?? null,
    unownedPr,
  };
  if (base?.foreignHead) cache.foreignHead = base.foreignHead;
  return cache;
}

/**
 * Workspace delivery reconciliation (finding #31).
 *
 * The COMPLEMENT to the server's stored-PAT delivery path
 * (`ensureTaskBranch` / `openTaskPr`): a real coding specialist — most
 * notably the Codex Developer running with danger-full-access and the
 * machine's own git/gh credentials — branches, commits, pushes, and opens a
 * PR *from inside its cloned workspace*, entirely outside viberr's PAT flow.
 * The canonical task.md then keeps `branch: null` / `pr: null`, so
 * task↔branch↔PR traceability (NFR15) is broken for agent-delivered work.
 *
 * After a specialist run finishes we inspect the run's
 * workspace git repo and reconcile the task record from what the agent
 * ACTUALLY did: the real branch, the real commits, and (best-effort, via the
 * run's own `gh` auth) the real PR. Everything here is best-effort and never
 * throws — no workspace, no git/gh, no creds, or a repo-less project all
 * no-op quietly. It is idempotent: values that already match are confirmed
 * and left, never clobbered with a second write or a duplicate event, so it
 * never fights the server-side delivery path when that already ran.
 */

// ------------------------------------------------------------- command exec

/** Result of a single external command — never throws, exit failures are values. */
export type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; stdout: string; stderr: string; code: number | null };

/**
 * Injectable command runner (git / gh). Mirrors how the GitHub layer injects
 * `fetchImpl`: tests pass a fake that returns canned git/gh output so no real
 * process (or network, or repo) is touched. The default shells out via
 * `execFile` with a short timeout.
 */
export type CommandExec = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<ExecResult>;

const execFileAsync = promisify(execFile);

/**
 * What a rejected `execFile` promise carries. Node hangs these fields on the
 * error object rather than any declared type, so each is decoded on its own: a
 * rejection whose `stderr` came back as a Buffer must still yield the exit code.
 * `stderr: null` means the rejection carried no usable text and the caller falls
 * back to the error's own message.
 */
const execFileRejection = z
  .object({
    stdout: z.string().catch(""),
    stderr: z.string().nullable().catch(null),
    code: z.number().nullable().catch(null),
  })
  .catch(() => ({ stdout: "", stderr: null, code: null }));

async function runCommand(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: opts.env,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error) {
    const rejection = execFileRejection.parse(error);
    return {
      ok: false,
      stdout: rejection.stdout,
      stderr:
        rejection.stderr ??
        (errorMessage(error)),
      code: rejection.code,
    };
  }
}

/** `gh`'s own sign-in, when a deployment configured one in the environment:
 *  the only names `gh` reads that the credential-free base drops. */
const GH_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
] as const;

/**
 * Pass 40 review (R-seams-1): the reconciler's two commands, split by who runs
 * them. `git` reads the workspace, so it runs as the task's person (`git`);
 * `gh` is the server's own tool, so it runs as the server but in `serverDir` —
 * never with an agent-writable checkout as its working repository (it runs
 * git there itself) — on the credential-free base plus its own sign-in.
 */
function reconcileExec(git: WorkspaceGit, serverDir: string): CommandExec {
  return async (file, args, opts) => {
    if (file === "git") {
      const res = await git.exec("git", args, opts);
      return res.ok
        ? { ok: true, stdout: res.stdout }
        : { ok: false, stdout: res.stdout, stderr: res.stderr, code: null };
    }
    const env: NodeJS.ProcessEnv = serverGitEnv();
    for (const name of GH_ENV_NAMES) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    return runCommand(file, args, { cwd: serverDir, timeoutMs: opts.timeoutMs, env });
  };
}

// ------------------------------------------------------------------- input

export interface ReconcileWorkspaceDeliveryInput {
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  /** The repo working dir the run used (the specialist clone dir), when known.
   *  Falls back to probing the conventional paths:
   *  `<taskDir>/workspace/<repo-name>`, `<taskDir>/workspace/repo`, then
   *  `<taskDir>/workspace` itself — whichever contains a git repo. */
  workdir?: string | null;
  dataRoot?: string;
  /** The finished run's backend + identity — attribution for the typed
   *  events (D7: profileId is the identity; role is the display snapshot). */
  backend?: RealBackend;
  profileId: string;
  role?: string;
  /** Injected command runner (tests). Defaults to a real `execFile` wrapper. */
  exec?: CommandExec;
}

export interface WorkspaceDeliveryResult {
  status:
    | "reconciled"
    | "no_workspace"
    | "no_repo"
    | "task_not_found"
    | "skipped";
  /** True when this call wrote a branch it didn't have before. */
  branchLinked: boolean;
  /** True when this call linked a PR (new or state-changed). */
  prLinked: boolean;
  /** The branch as reconciled (or the pre-existing one). */
  branch: string | null;
  /** The PR as reconciled (or the pre-existing one). */
  pr: PrRef | null;
  /** Number of workspace commits written into the github cache. */
  commits: number;
  /** Why nothing happened, for the debug log. */
  reason?: string;
}

// ---------------------------------------------------------------- helpers

function githubEvent(actor: FileActorRef, text: string): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "github",
    actor,
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

/** Map `gh`'s GraphQL PR-state enum (OPEN|CLOSED|MERGED) to the task-file cache
 *  vocabulary (open → "review") so it matches the server delivery path. */
function mapGhStateToCache(raw: string | null): PrCacheState {
  const s = (raw ?? "OPEN").toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "review";
}

/** Parse `git log --oneline` output into the github-cache commit shape. */
function parseOneline(stdout: string): { sha: string; msg: string }[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      return sp < 0
        ? { sha: line, msg: "" }
        : { sha: line.slice(0, sp), msg: line.slice(sp + 1).trim() };
    });
}

/**
 * Ruling 135: relate origin's copy of the task branch (the PR head `gh`
 * reported) to the workspace revision, from the workspace's own history.
 * `behind`: the PR head is an ancestor of the revision, a plain push
 * fast-forwards. `diverged`: both are known here and neither contains the
 * other. `unknown`: the workspace has no copy of the PR head, so the two
 * cannot be related. Null when there is nothing to record: no revision, no
 * head, a settled PR, a `verified` revision, or a head that already carries
 * the revision (equal, or the revision is an ancestor of the head, which is
 * ruling 42's drift and not this fact).
 */
async function classifyUnpushedRevision(
  exec: CommandExec,
  repoDir: string,
  input: {
    revisionSha: string | null;
    prHeadSha: string | null;
    prState: PrRef["state"];
    verified: boolean;
  },
): Promise<UnpushedRevision | null> {
  const { revisionSha, prHeadSha } = input;
  if (!revisionSha || !prHeadSha || input.verified) return null;
  if (input.prState !== "review" && input.prState !== "accepted") return null;
  if (prHeadSha === revisionSha) return null;
  const isAncestor = (older: string, newer: string) =>
    exec("git", ["-C", repoDir, "merge-base", "--is-ancestor", older, newer], {
      cwd: repoDir,
      timeoutMs: 5_000,
    });
  if ((await isAncestor(prHeadSha, revisionSha)).ok) {
    return { revisionSha, prHeadSha, relation: "behind" };
  }
  if ((await isAncestor(revisionSha, prHeadSha)).ok) return null;
  const known = await exec(
    "git",
    ["-C", repoDir, "cat-file", "-e", `${prHeadSha}^{commit}`],
    { cwd: repoDir, timeoutMs: 5_000 },
  );
  return { revisionSha, prHeadSha, relation: known.ok ? "diverged" : "unknown" };
}

/** The timeline line for a change of the unpushed-revision record alone. */
function unpushedRevisionEventText(pr: PrRef): string {
  const record = pr.unpushedRevision;
  if (!record) {
    return `**PR #${pr.number}** carries the workspace revision \`${(pr.headSha ?? "").slice(0, 7)}\`.`;
  }
  const rev = record.revisionSha.slice(0, 7);
  const head = record.prHeadSha ? `\`${record.prHeadSha.slice(0, 7)}\`` : "an older head";
  if (record.relation === "diverged") {
    return `Revision \`${rev}\` from the specialist workspace is not on **PR #${pr.number}**: its head ${head} holds commits this workspace does not. ${DIVERGED_BRANCH_REMEDY} Then deliver the branch to push it.`;
  }
  return `Revision \`${rev}\` from the specialist workspace is not on **PR #${pr.number}** (its head is ${head}). Delivering the branch pushes it.`;
}

/**
 * What `gh pr view --json number,state,title,headRefOid` prints, decoded at the
 * process boundary. `gh` is the AGENT's own binary at whatever version its
 * workspace carries, so every field is decoded on its own: a field it stopped
 * printing (or prints differently) must not cost us the PR number, the one value
 * this reconciler cannot proceed without. A payload that is not an object at all
 * decodes to the all-absent case, which reads exactly like "gh found no PR".
 */
const ghPrPayload = z.preprocess(
  // `gh pr view --json` prints an object; `gh pr list --json` an array.
  (payload) => (Array.isArray(payload) ? payload[0] : payload),
  z
    .object({
      number: z.number().nullable().catch(null),
      state: z.string().nullable().catch(null),
      title: z.string().catch(""),
      /** The adoption rule's subject (R16-1). */
      headRefOid: z.string().nullable().catch(null),
    })
    .catch(() => ({ number: null, state: null, title: "", headRefOid: null })),
);

type GhPrFacts = z.infer<typeof ghPrPayload>;

/** Decode one `gh pr view` invocation; output that is not JSON at all joins the
 *  all-absent case above. */
function parseGhPr(stdout: string): GhPrFacts {
  try {
    return ghPrPayload.parse(JSON.parse(stdout));
  } catch {
    return ghPrPayload.parse(null);
  }
}

// ------------------------------------------------------------- reconcile

/**
 * Best-effort, never-throwing reconciliation of a task record from its
 * specialist run's workspace. See the module header for the contract.
 */
export async function reconcileWorkspaceDelivery(
  input: ReconcileWorkspaceDeliveryInput,
): Promise<WorkspaceDeliveryResult> {
  const {
    db,
    projectSlug,
    taskKey,
    dataRoot,
    backend = "claude",
    // U12: "specialist" is retired display vocabulary — this default flows into
    // the RENDERED timeline actor role (roleHint → actor-ref). Mirrors
    // DEFAULT_SPECIALIST_ROLE_LABEL in app/features/agents/agent-types.ts.
    role = "Agent profile",
  } = input;

  const noop = (
    status: WorkspaceDeliveryResult["status"],
    reason: string,
    branch: string | null = null,
    pr: PrRef | null = null,
  ): WorkspaceDeliveryResult => ({
    status,
    branchLinked: false,
    prLinked: false,
    branch,
    pr,
    commits: 0,
    reason,
  });

  try {
    const ref = {
      projectSlug,
      taskKey,
      dataRoot,
    };
    const file = readTaskFile(ref);
    if (!file) return noop("task_not_found", "task file missing");
    const fm = file.parsed.frontmatter;

    // Repo + default branch WITHOUT requiring a viberr PAT — the agent used
    // its own git/gh creds, so we resolve config straight from the files.
    const projectFile = readProjectFile({
      projectSlug,
      dataRoot,
    });
    // P13-D-5: one project, one repository — the task-level override is gone.
    const repo = projectFile?.parsed.frontmatter.repo ?? null;
    if (!repo) return noop("no_repo", "project has no repo configured");
    const defaultBranch =
      projectFile?.parsed.frontmatter.defaultBranch || "main";
    const repoName = repo.split("/").pop() ?? repo;

    // Locate the workspace git repo: the run's own workdir first, then the
    // conventional clone paths — cloneRepo() uses <taskDir>/workspace/<name>,
    // reviewers that clone themselves tend to use <taskDir>/workspace/repo,
    // and an agent told "clone into ./" lands on <taskDir>/workspace itself.
    // Callers that can't thread workdir (e.g. the operator path) still get
    // reconciled via these conventions.
    const wsRoot = path.join(taskDir(projectSlug, taskKey, dataRoot), "workspace");
    const candidates = [
      input.workdir ?? null,
      path.join(wsRoot, repoName),
      path.join(wsRoot, "repo"),
      wsRoot,
    ].filter((c): c is string => !!c);
    const repoDir = candidates.find((c) => existsSync(path.join(c, ".git")));
    if (!repoDir) {
      return noop("no_workspace", "no workspace git repo found");
    }
    // R-seams-1: the workspace's git as the task's person; `gh` as the server
    // in the task's own (server-owned) directory. A refusal is a quiet skip,
    // like every other reason this best-effort pass does nothing.
    let exec: CommandExec;
    if (input.exec) {
      exec = input.exec;
    } else {
      try {
        exec = reconcileExec(
          taskWorkspaceGit(db, { projectSlug, taskKey, dataRoot }),
          taskDir(projectSlug, taskKey, dataRoot),
        );
      } catch (error) {
        return noop("skipped", `the workspace's git cannot run as its person: ${errorMessage(error)}`);
      }
    }

    const actor: FileActorRef = {
      kind: "agent",
      backend,
      profileId: input.profileId,
      roleHint: role,
    };

    // 1. Current branch.
    const branchRes = await exec(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeoutMs: 5_000 },
    );
    const rawBranch = branchRes.ok ? branchRes.stdout.trim() : "";
    // A real task branch: not empty, not detached HEAD, not the default branch.
    const validBranch =
      rawBranch && rawBranch !== "HEAD" && rawBranch !== defaultBranch
        ? rawBranch
        : null;
    const effectiveBranch = validBranch ?? fm.branch;

    // 2. Real commits ahead of the default branch → the github cache. Gate on
    //    validBranch (HEAD is actually on the task branch), NOT the fm.branch
    //    fallback: a clone left on the default branch yields `origin/main..HEAD`
    //    = [] which, attributed to fm.branch, would WIPE the real commit cache a
    //    prior developer run recorded. Only compute commits we can honestly
    //    attribute to the branch HEAD is on.
    //
    //    Shallow-clone guard: specialist clones are `--depth 1`, where
    //    `origin/<default>..HEAD` runs over truncated history and misreports
    //    (every reachable commit looks "ahead"). Deepen first, best-effort;
    //    when the repo is shallow and the deepen fails (offline, no remote),
    //    SKIP the commit computation entirely rather than write a wrong cache.
    let commits: { sha: string; msg: string }[] | null = null;
    if (validBranch) {
      const shallowRes = await exec(
        "git",
        ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
        { cwd: repoDir, timeoutMs: 5_000 },
      );
      const isShallow = shallowRes.ok && shallowRes.stdout.trim() === "true";
      let historyOk = true;
      if (isShallow) {
        const deepen = await exec(
          "git",
          ["-C", repoDir, "fetch", "--deepen", "50", "origin", defaultBranch],
          { cwd: repoDir, timeoutMs: 30_000 },
        );
        historyOk = deepen.ok;
      }
      if (historyOk) {
        const logRes = await exec(
          "git",
          ["-C", repoDir, "log", "--oneline", `origin/${defaultBranch}..HEAD`],
          { cwd: repoDir, timeoutMs: 5_000 },
        );
        if (logRes.ok) commits = parseOneline(logRes.stdout);
      }
    }

    // 2b. F10-15: mint/refresh the immutable WORK REVISION the reviewers judge.
    //     `git log --oneline` yields abbreviated shas (display cache only); the
    //     revision needs the FULL head + tree sha so a verdict binds to exactly
    //     this content. A head with the SAME tree as the current revision is the
    //     SAME subject → no new revision (verdicts survive, F10-32); a different
    //     tree mints a new revision id that makes every prior verdict stale.
    // P11-72: only mint a revision when the branch actually carries task work.
    // A run that produced NO commits leaves HEAD at the base tip (its tree == the
    // base tree), so there is nothing to review — minting a revision there would
    // flip validation to "changed" and open a review over an empty diff (seen
    // live when a developer correctly declined to guess and committed nothing).
    // `commits === []` is the known-empty signal; `null` means we could not
    // enumerate history (shallow + offline), so we keep the prior behavior and
    // mint, rather than drop a real delivery we simply couldn't count.
    const hasDeliveredWork = commits === null || commits.length > 0;
    let workRevisionPatch: TaskFrontmatter["workRevision"] | undefined;
    if (validBranch && hasDeliveredWork) {
      const headRes = await exec("git", ["-C", repoDir, "rev-parse", "HEAD"], {
        cwd: repoDir,
        timeoutMs: 5_000,
      });
      const treeRes = await exec(
        "git",
        ["-C", repoDir, "rev-parse", "HEAD^{tree}"],
        { cwd: repoDir, timeoutMs: 5_000 },
      );
      const headSha = headRes.ok ? headRes.stdout.trim() : "";
      const treeSha = treeRes.ok ? treeRes.stdout.trim() || null : null;
      if (headSha) {
        const { revision, changed } = nextWorkRevision(
          fm.workRevision,
          {
            id: newId("rev"),
            headSha,
            treeSha,
            branch: validBranch,
            sourceProfileId: input.profileId ?? null,
            createdAt: new Date().toISOString(),
          },
          fm.baseRefreshes,
        );
        if (changed) workRevisionPatch = revision;
      }
    }

    // 3. Branch + commit-cache write (idempotent: only when something changed).
    const branchPatch: Partial<TaskFrontmatter> = {};
    let branchLinked = false;
    if (validBranch && validBranch !== fm.branch) {
      branchPatch.branch = validBranch;
      branchLinked = true;
    }
    if (workRevisionPatch) {
      branchPatch.workRevision = workRevisionPatch;
      // A new revision invalidates prior verdicts (they target the old id), so
      // recompute the derived validation cache from the new subject.
      branchPatch.validation = deriveValidation({
        engagements: fm.engagements,
        workRevision: workRevisionPatch,
        verdicts: fm.verdicts,
      });
    }
    let commitsChanged = false;
    if (
      commits &&
      JSON.stringify(commits) !== JSON.stringify(fm.github?.commits ?? [])
    ) {
      branchPatch.github = {
        commits,
        changed: fm.github?.changed ?? null,
        // Carry the reconciler's collision marker (R15-15/R16-1) — dropping it
        // here re-armed the "branch name collision" note on the next poll tick.
        unownedPr: fm.github?.unownedPr ?? null,
      };
      // Ruling 161: the foreign-head record is the reconciler's; carried the
      // same way, and only while it stands (an absent key stays absent).
      if (fm.github?.foreignHead) branchPatch.github.foreignHead = fm.github.foreignHead;
      commitsChanged = true;
    }
    if (Object.keys(branchPatch).length > 0) {
      // Ruling 137: the write that mints a new work revision withdraws the
      // acceptance offers authored against the old one, inside the same
      // locked write, and keeps the branch-linked event it always wrote.
      const revisionCause: OfferWithdrawalCause | null = workRevisionPatch
        ? { kind: "revision", headSha: workRevisionPatch.headSha }
        : null;
      const terminalStageId = projectFile
        ? resolveStageRoles(
            projectFile.parsed.frontmatter.stages,
            projectFile.parsed.frontmatter.workflow,
          ).terminalId
        : null;
      const revisionWithdrawal: OfferWithdrawalSlot = { offers: null };
      await updateTaskFile(ref, (parsed) => {
        Object.assign(parsed.frontmatter, branchPatch);
        if (branchLinked) {
          parsed.timeline.unshift(
            githubEvent(
              actor,
              `Reconciled branch \`${validBranch}\` from the specialist workspace.`,
            ),
          );
        }
        if (revisionCause) {
          revisionWithdrawal.offers = withdrawAcceptanceOffers(
            parsed,
            terminalStageId,
            revisionCause,
            actor,
          );
        }
      });
      rebuildPath(db, resolveTaskFilePath(ref), {
        dataRoot,
      });
      if (revisionCause && revisionWithdrawal.offers) {
        recordRecommendationWithdrawal(db, {
          projectSlug,
          taskKey,
          withdrawal: revisionWithdrawal.offers,
          cause: revisionCause,
          actor: { userId: null, label: "system:workspace-reconcile" },
        });
      }
      // Ruling 482 (F40-52): a new head on a task whose pull request stands is
      // the delivered head moving before verdicts count, so the project's
      // gates are queued on it now. Before the first delivery the delivery
      // itself asks.
      if (workRevisionPatch && fm.pr && fm.pr.state !== "closed" && fm.pr.state !== "merged") {
        const { requestProjectGatesQuietly } = await import(
          "~/server/tasks/project-gates.server"
        );
        await requestProjectGatesQuietly(db, { projectSlug, taskKey, dataRoot }, "revision");
      }
    }
    // The branch-reconciled audit fires only for a real BRANCH or COMMIT change,
    // not for a workRevision-only stamp (F10-15): re-reconciling an unchanged
    // branch stays audit-silent even though the first delivery mints a revision.
    if (branchLinked || commitsChanged) {
      recordAudit(db, {
        action: "github.workspace.branch_reconciled",
        actor: { userId: null, label: "system:workspace-reconcile" },
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: {
          repo,
          branch: branchPatch.branch ?? fm.branch,
          branchLinked,
          commits: commits?.length ?? 0,
        },
      });
    }

    // 4. PR detection — uses whatever `gh` auth the run had. Never fabricates:
    //    if gh is absent or returns nothing, the task's `pr` is left untouched.
    let prLinked = false;
    let reconciledPr: PrRef | null = fm.pr;
    if (effectiveBranch) {
      const prRes = await exec(
        "gh",
        [
          "pr",
          "view",
          effectiveBranch,
          "--repo",
          repo,
          "--json",
          // `headRefOid` is the adoption rule's subject (R16-1) — without it
          // this path bound a PR to a task on the branch NAME alone.
          "number,state,title,headRefOid",
        ],
        { cwd: repoDir, timeoutMs: 8_000 },
      );
      if (prRes.ok && prRes.stdout.trim()) {
        const view = parseGhPr(prRes.stdout);
        const number = view.number;
        if (number !== null) {
          // `gh` returns the GraphQL enum OPEN|CLOSED|MERGED; map it to the
          // SAME cache vocabulary the server delivery path uses (open →
          // "review"). Comparing/writing gh's raw "open" against the
          // canonical "review" would treat an already-linked PR as new and
          // ping-pong the state on every reconcile.
          const liveState = mapGhStateToCache(view.state);
          const cur = fm.pr;
          const samePr = !!cur && cur.number === number;
          // R16-1 — this is the path that bound merged PR #113 to a brand-new
          // VIB-4 (H8): `gh pr view <branch>` answers with the branch's newest
          // PR whatever its state, and the result was written into `pr:`
          // unconditionally. A PR the task does not already own may be adopted
          // only when it is OPEN and its head IS the delivered revision.
          const adoption = samePr
            ? { adopt: true as const }
            : decidePrAdoption({
                state: liveState,
                prHeadSha: view.headRefOid,
                revisionHeadSha:
                  workRevisionPatch?.headSha ??
                  activeWorkRevision(fm.workRevision)?.headSha ??
                  null,
              });
          if (!adoption.adopt) {
            // Not this task's PR — say so once (the marker in the github cache
            // is the same one the server reconciler dedupes on) and leave `pr:`
            // alone. Delivery is blocked by the same collision and reports it.
            const baseCache = branchPatch.github ?? fm.github ?? null;
            if (baseCache?.unownedPr !== number) {
              await appendTimelineEvent(
                ref,
                {
                  occurredAt: new Date().toISOString(),
                  type: "note",
                  actor: POLICY_ENGINE_ACTOR,
                  title: null,
                  text: prAdoptionRefusalNote({
                    refusal: adoption.refusal,
                    taskKey,
                    branch: effectiveBranch,
                    prNumber: number,
                    revisionHeadSha:
                      workRevisionPatch?.headSha ??
                      activeWorkRevision(fm.workRevision)?.headSha ??
                      null,
                  }),
                  toAgent: false,
                  evidence: null,
                },
                {
                  github: collisionCache(baseCache, number),
                },
              );
              rebuildPath(db, resolveTaskFilePath(ref), { dataRoot });
            }
            return {
              status: "reconciled",
              branchLinked,
              prLinked: false,
              branch: validBranch ?? fm.branch,
              pr: fm.pr,
              commits: commits?.length ?? 0,
            };
          }
          // H1 guard (same as the server reconciler): a human-set "accepted"
          // (merge pending, D3/S2) must NOT be downgraded to "review" while
          // the PR is still open on GitHub — that would silently hide the
          // "Complete merge" affordance. Only a real terminal state
          // (merged/closed) overrides it.
          const detectedState: PrRef["state"] =
            samePr && cur.state === "accepted" && liveState === "review"
              ? "accepted"
              : liveState;
          // Ruling 135: a refresh of the SAME PR keeps the reconciler-owned
          // facts (checks, review, mergeable, drift), as `writePrToTask` does;
          // a different PR starts clean.
          const detected: PrRef = samePr
            ? { ...cur, number, state: detectedState, title: view.title }
            : { number, state: detectedState, title: view.title };
          // Ruling 135: the moment a delivering run mints a revision on a branch
          // whose PR is open, the file says whether that PR carries it, so the
          // acceptance gate does not wait for the five-minute poll.
          const revisionNow = workRevisionPatch ?? activeWorkRevision(fm.workRevision);
          const unpushed = await classifyUnpushedRevision(exec, repoDir, {
            revisionSha: revisionNow?.headSha ?? null,
            prHeadSha: view.headRefOid,
            prState: detectedState,
            verified: revisionNow?.kind === "verified",
          });
          if (view.headRefOid) detected.headSha = view.headRefOid;
          if (unpushed) detected.unpushedRevision = unpushed;
          else delete detected.unpushedRevision;
          const stateChanged =
            !cur || cur.number !== detected.number || cur.state !== detected.state;
          const unpushedChanged =
            JSON.stringify(cur?.unpushedRevision ?? null) !==
            JSON.stringify(detected.unpushedRevision ?? null);
          const headChanged = (cur?.headSha ?? null) !== (detected.headSha ?? null);
          if (!stateChanged && !unpushedChanged && headChanged) {
            // A head read for the first time (or moved with nothing else to
            // say) is recorded without a timeline line.
            await patchTaskFrontmatter(ref, { pr: detected });
            rebuildPath(db, resolveTaskFilePath(ref), { dataRoot });
            reconciledPr = detected;
          }
          const stale = stateChanged || unpushedChanged;
          if (stale) {
            await appendTimelineEvent(
              ref,
              githubEvent(
                actor,
                // Honest copy: only a NEWLY linked PR "opened from the
                // workspace"; a state change on the already-linked PR is a
                // reconcile, not an open; an unpushed-revision change names it.
                !samePr
                  ? `Linked **PR #${detected.number}** opened from the specialist workspace.`
                  : stateChanged
                    ? `Reconciled **PR #${detected.number}** state → \`${detected.state}\` from the specialist workspace.`
                    : unpushedRevisionEventText(detected),
              ),
              { pr: detected },
            );
            // An accepted (merge-pending) PR that was closed on GitHub without
            // merging loses its Complete-merge path — say why, typed `policy`.
            if (samePr && cur.state === "accepted" && detected.state === "closed") {
              await appendTimelineEvent(ref, {
                occurredAt: new Date().toISOString(),
                // Neutral divergence note, not a violation (P13-LV-03).
                type: "note",
                actor: POLICY_ENGINE_ACTOR,
                title: null,
                text: `**Note:** accepted PR #${detected.number} was closed on GitHub without merging, so the pending merge can no longer be completed from Viberr.`,
                toAgent: false,
                evidence: null,
              });
            }
            rebuildPath(db, resolveTaskFilePath(ref), {
              dataRoot,
            });
            recordAudit(db, {
              action: "github.workspace.pr_linked",
              actor: { userId: null, label: "system:workspace-reconcile" },
              subjectKind: "task",
              subjectId: taskKey,
              projectSlug,
              taskKey,
              details: {
                repo,
                branch: effectiveBranch,
                prNumber: detected.number,
                prState: detected.state,
                headSha: detected.headSha ?? null,
                unpushedRevision: detected.unpushedRevision?.relation ?? null,
              },
            });
            prLinked = stateChanged;
            reconciledPr = detected;
          }
        }
      } else if (workRevisionPatch && fm.pr?.unpushedRevision) {
        // Ruling 445: the PR could not be read here (a workspace with no
        // GitHub credential skips `gh`), and this reconcile minted a revision.
        // The recorded "not on the PR" line named the one it superseded until
        // the GitHub pass, five minutes on. Live on ax-clone AX-5 the review
        // queue said "PR #24 does not carry the delivered revision 509c0d1"
        // eleven seconds after `b82bb93` was minted. Re-measured against the
        // PR head on record, the line names the revision that now stands, or
        // clears when that head already carries it.
        const unpushed = await classifyUnpushedRevision(exec, repoDir, {
          revisionSha: workRevisionPatch.headSha,
          prHeadSha: fm.pr.headSha ?? null,
          prState: fm.pr.state,
          verified: workRevisionPatch.kind === "verified",
        });
        const remeasured: PrRef = { ...fm.pr };
        if (unpushed) remeasured.unpushedRevision = unpushed;
        else delete remeasured.unpushedRevision;
        await patchTaskFrontmatter(ref, { pr: remeasured });
        rebuildPath(db, resolveTaskFilePath(ref), { dataRoot });
        reconciledPr = remeasured;
      }
    }

    return {
      status: "reconciled",
      branchLinked,
      prLinked,
      branch: validBranch ?? fm.branch,
      pr: reconciledPr,
      commits: commits?.length ?? 0,
    };
  } catch (error) {
    // Reconciliation must NEVER error the run. Log and move on.
    logger.info("workspace delivery reconciliation failed — skipping", {
      taskKey,
      err: errorMessage(error),
    });
    return {
      status: "skipped",
      branchLinked: false,
      prLinked: false,
      branch: null,
      pr: null,
      commits: 0,
      reason: "unexpected error (swallowed)",
    };
  }
}
