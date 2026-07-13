import { existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type {
  FileActorRef,
  PrRef,
  TaskFileEvent,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  clearReviewEvidence,
  reviewEvidenceFingerprint,
} from "~/server/tasks/review-evidence.server";
import { repositoryWorkspaceKey } from "~/server/tasks/specialist-preflight.server";
import {
  assertTaskLifecycleActive,
  type TaskLifecycleGuard,
} from "~/server/tasks/task-lifecycle.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { mapPrToCacheState } from "./pr-linker.server";
import { POLICY_ENGINE_ACTOR } from "./scope-flag.server";
import { normalizeFullGitSha } from "./head-sha.server";
import {
  defaultCommandExec,
  type CommandExec as SharedCommandExec,
  type CommandExecResult,
} from "./command-exec.server";

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
 * After a REAL (non-simulated) specialist run finishes we inspect the run's
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
export type ExecResult = CommandExecResult;

/**
 * Injectable command runner (git / gh). Mirrors how the GitHub layer injects
 * `fetchImpl`: tests pass a fake that returns canned git/gh output so no real
 * process (or network, or repo) is touched. The default shells out via
 * `execFile` with a short timeout.
 */
export type CommandExec = SharedCommandExec;

// ------------------------------------------------------------------- input

export interface ReconcileWorkspaceDeliveryInput {
  db: Database.Database;
  projectSlug: string;
  taskKey: string;
  /** The repo working dir the run used (the specialist clone dir), when known.
   *  Falls back to probing the conventional paths:
   *  `<taskDir>/workspace/<full-repo-identity>`, then legacy clone paths —
   *  whichever contains a git repo. */
  workdir?: string | null;
  dataRoot?: string;
  /** The finished run's backend + role — attribution for the typed events. */
  backend?: RealBackend;
  role?: string;
  /** Skip entirely for a simulated run (it did no real git work). */
  simulated?: boolean;
  /** Injected command runner (tests). Defaults to a real `execFile` wrapper. */
  exec?: CommandExec;
  /** Server-owned delivery resolves PRs through the GitHub API, so it skips
   *  the legacy ambient `gh` probe while reusing branch/commit reconciliation. */
  skipPrDetection?: boolean;
  /** Exact task incarnation that authorized this delayed reconciliation. */
  expectedTaskCreatedAt?: string;
  signal?: AbortSignal;
  assertAuthorization?: () => void;
}

export interface WorkspaceDeliveryResult {
  status:
    "reconciled" | "no_workspace" | "no_repo" | "task_not_found" | "skipped";
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

function safeJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    // `gh pr view --json` returns an object; `gh pr list --json` an array.
    if (Array.isArray(parsed)) {
      return (parsed[0] as Record<string, unknown> | undefined) ?? null;
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
    exec = defaultCommandExec,
    backend = "claude",
    role = "Specialist",
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
    input.assertAuthorization?.();
    if (input.simulated) {
      return noop("skipped", "simulated run — no real repository work");
    }

    const ref = {
      projectSlug,
      taskKey,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    };
    const file = readTaskFile(ref);
    if (!file) return noop("task_not_found", "task file missing");
    const capturedCreatedAt =
      input.expectedTaskCreatedAt ?? file.parsed.frontmatter.createdAt;
    if (!capturedCreatedAt) {
      throw new DOMException("Task lifecycle ownership is missing.", "AbortError");
    }
    const taskLifecycle: TaskLifecycleGuard = {
      expectedCreatedAt: capturedCreatedAt,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const assertCurrent = () => {
      input.assertAuthorization?.();
      const current = readTaskFile(ref);
      assertTaskLifecycleActive(
        taskLifecycle,
        current?.parsed.frontmatter.createdAt ?? null,
      );
    };
    const runExec: CommandExec = async (fileName, args, options) => {
      assertCurrent();
      const result = await exec(fileName, args, {
        ...options,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      assertCurrent();
      return result;
    };
    const fm = file.parsed.frontmatter;

    // Repo + default branch WITHOUT requiring a viberr PAT — the agent used
    // its own git/gh creds, so we resolve config straight from the files.
    const projectFile = readProjectFile({
      projectSlug,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    });
    const repo = fm.repo ?? projectFile?.parsed.frontmatter.repo ?? null;
    if (!repo) return noop("no_repo", "project has no repo configured");
    const defaultBranch =
      projectFile?.parsed.frontmatter.defaultBranch || "main";
    const repoName = repo.split("/").pop() ?? repo;
    const repoIdentity = repositoryWorkspaceKey(repo);
    const reviewStageId = projectFile
      ? resolveStageRoles(
          projectFile.parsed.frontmatter.stages,
          projectFile.parsed.frontmatter.workflow,
        ).reviewId
      : null;

    // Locate the workspace git repo: the run's own workdir first, then the
    // canonical full-repository-identity path used by specialist preflight.
    // Keep the basename/repo/root probes for legacy workspaces. Callers that
    // can't persist workdir (notably boot recovery) must still find the exact
    // checkout without confusing same-basename repositories.
    const wsRoot = path.join(
      taskDir(projectSlug, taskKey, dataRoot),
      "workspace",
    );
    const candidates = [
      input.workdir ?? null,
      path.join(wsRoot, repoIdentity),
      path.join(wsRoot, repoName),
      path.join(wsRoot, "repo"),
      wsRoot,
    ].filter((c): c is string => !!c);
    const repoDir = candidates.find((c) => existsSync(path.join(c, ".git")));
    if (!repoDir) {
      return noop("no_workspace", "no workspace git repo found");
    }

    const actor: FileActorRef = { kind: "agent", backend, role };

    // 1. Current branch.
    const branchRes = await runExec(
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
      const shallowRes = await runExec(
        "git",
        ["-C", repoDir, "rev-parse", "--is-shallow-repository"],
        { cwd: repoDir, timeoutMs: 5_000 },
      );
      const isShallow = shallowRes.ok && shallowRes.stdout.trim() === "true";
      let historyOk = true;
      if (isShallow) {
        const deepen = await runExec(
          "git",
          ["-C", repoDir, "fetch", "--deepen", "50", "origin", defaultBranch],
          { cwd: repoDir, timeoutMs: 30_000 },
        );
        historyOk = deepen.ok;
      }
      if (historyOk) {
        const logRes = await runExec(
          "git",
          ["-C", repoDir, "log", "--oneline", `origin/${defaultBranch}..HEAD`],
          { cwd: repoDir, timeoutMs: 5_000 },
        );
        if (logRes.ok) commits = parseOneline(logRes.stdout);
      }
    }

    // 3. Branch + commit-cache write (idempotent: only when something changed).
    const branchPatch: Partial<TaskFrontmatter> = {};
    let branchLinked = false;
    if (validBranch && validBranch !== fm.branch) {
      branchPatch.branch = validBranch;
      branchLinked = true;
    }
    if (
      commits &&
      JSON.stringify(commits) !== JSON.stringify(fm.github?.commits ?? [])
    ) {
      branchPatch.github = {
        commits,
        changed: fm.github?.changed ?? null,
      };
    }
    if (Object.keys(branchPatch).length > 0) {
      await updateTaskFile(ref, (parsed) => {
        assertTaskLifecycleActive(taskLifecycle, parsed.frontmatter.createdAt);
        input.assertAuthorization?.();
        if (branchPatch.branch !== undefined) {
          parsed.frontmatter.branch = branchPatch.branch;
        }
        if (branchPatch.github !== undefined) {
          parsed.frontmatter.github = branchPatch.github;
        }
        if (branchLinked) {
          parsed.timeline.unshift(
            githubEvent(
              actor,
              `Reconciled branch \`${validBranch}\` from the specialist workspace.`,
            ),
          );
        }
      });
      assertCurrent();
      rebuildPath(db, resolveTaskFilePath(ref), {
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
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
    if (effectiveBranch && !input.skipPrDetection) {
      const prRes = await runExec(
        "gh",
        [
          "pr",
          "view",
          effectiveBranch,
          "--repo",
          repo,
          "--json",
          "number,state,title,headRefOid",
        ],
        { cwd: repoDir, timeoutMs: 8_000 },
      );
      if (prRes.ok && prRes.stdout.trim()) {
        const obj = safeJsonObject(prRes.stdout);
        const number =
          obj && typeof obj.number === "number" ? obj.number : null;
        if (number !== null) {
          // `gh` returns the GraphQL enum OPEN|CLOSED|MERGED; map it to the
          // SAME cache vocabulary the server delivery path uses (open →
          // "review"). Comparing/writing gh's raw "open" against the
          // canonical "review" would treat an already-linked PR as new and
          // ping-pong the state on every reconcile.
          const liveState = mapPrToCacheState({
            state: String(obj?.state ?? "OPEN"),
          });
          const observedHeadSha = normalizeFullGitSha(
            typeof obj?.headRefOid === "string" ? obj.headRefOid : null,
          );
          const detectedPrFor = (cur: PrRef | null): PrRef => {
            const samePr = !!cur && cur.number === number;
            const previousHeadSha = samePr
              ? normalizeFullGitSha(cur.headSha)
              : null;
            const reconciledHeadSha = observedHeadSha ?? previousHeadSha;
            const detected: PrRef = {
              ...(samePr ? cur : {}),
              number,
              state:
                samePr && cur.state === "accepted" && liveState === "review"
                  ? "accepted"
                  : liveState,
              title:
                typeof obj?.title === "string"
                  ? obj.title
                  : samePr
                    ? cur.title
                    : "",
              ...(reconciledHeadSha ? { headSha: reconciledHeadSha } : {}),
            };
            if (!reconciledHeadSha) delete detected.headSha;
            return detected;
          };
          const initiallyDetected = detectedPrFor(fm.pr);
          // The common case is a confirmation of already-canonical facts. Skip
          // the locked writer entirely so reconciliation stays truly idempotent
          // (no updatedAt churn, audit, or duplicate event).
          if (JSON.stringify(fm.pr) !== JSON.stringify(initiallyDetected)) {
            let previousHeadSha: string | null = null;
            let headChanged = false;
            let evidenceInvalidated = false;
            let prChanged = false;
            const updated = await updateTaskFile(ref, (parsed) => {
              assertTaskLifecycleActive(
                taskLifecycle,
                parsed.frontmatter.createdAt,
              );
              input.assertAuthorization?.();
              const cur = parsed.frontmatter.pr;
              const samePr = !!cur && cur.number === number;
              previousHeadSha = samePr
                ? normalizeFullGitSha(cur.headSha)
                : null;
              // A missing/malformed head in an otherwise useful `gh` response is
              // degraded data, not proof that GitHub erased the commit. Preserve
              // the last verified head only for the same PR; never carry it to a
              // different PR number.
              // H1 guard (same as the server reconciler): a human-set "accepted"
              // (merge pending, D3/S2) is preserved while the exact accepted head
              // remains open. A real replacement head is invalidated below and
              // returns the PR to review through clearReviewEvidence.
              const detected = detectedPrFor(cur);
              if (JSON.stringify(cur) === JSON.stringify(detected)) return;
              prChanged = true;

              const oldEvidence = reviewEvidenceFingerprint(parsed, repo);
              const stateChanged = cur?.state !== detected.state;
              const samePrHeadChanged =
                samePr &&
                observedHeadSha !== null &&
                previousHeadSha !== observedHeadSha;
              parsed.frontmatter.pr = detected;
              const evidenceChanged =
                oldEvidence !== reviewEvidenceFingerprint(parsed, repo);
              if (evidenceChanged) {
                clearReviewEvidence(parsed, reviewStageId);
                // GitHub evidence is stale in every stage, not only while the
                // task happens to sit in Review. Keep `failing` sticky, matching
                // the server reconciler's canonical invalidation semantics.
                if (parsed.frontmatter.validation !== "failing") {
                  parsed.frontmatter.validation = "changed";
                }
                evidenceInvalidated = true;
              }
              headChanged = samePrHeadChanged;

              const finalPr = parsed.frontmatter.pr!;
              const eventText = !samePr
                ? `Linked **PR #${finalPr.number}** opened from the specialist workspace.`
                : samePrHeadChanged
                  ? `Reconciled **PR #${finalPr.number}** head → \`${observedHeadSha}\`${
                      stateChanged ? ` and state → \`${finalPr.state}\`` : ""
                    } from the specialist workspace.`
                  : stateChanged
                    ? `Reconciled **PR #${finalPr.number}** state → \`${finalPr.state}\` from the specialist workspace.`
                    : `Reconciled **PR #${finalPr.number}** metadata from the specialist workspace.`;
              parsed.timeline.unshift(githubEvent(actor, eventText));

              // An accepted (merge-pending) PR that was closed on GitHub without
              // merging loses its Complete-merge path — say why, typed `policy`.
              if (
                samePr &&
                cur.state === "accepted" &&
                detected.state === "closed"
              ) {
                parsed.timeline.unshift({
                  occurredAt: new Date().toISOString(),
                  type: "policy",
                  actor: POLICY_ENGINE_ACTOR,
                  title: null,
                  text: `**Policy note:** accepted PR #${detected.number} was closed on GitHub without merging — the pending merge can no longer be completed from Viberr.`,
                  toAgent: false,
                  evidence: null,
                });
              }
            });
            assertCurrent();
            const detected = updated.frontmatter.pr;
            if (prChanged && detected) {
              rebuildPath(db, resolveTaskFilePath(ref), {
                ...(dataRoot !== undefined ? { dataRoot } : {}),
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
                  previousHeadSha,
                  headSha: normalizeFullGitSha(detected.headSha),
                  headChanged,
                  evidenceInvalidated,
                },
              });
              prLinked = true;
              reconciledPr = detected;
            }
          }
        }
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
      err: error instanceof Error ? error.message : String(error),
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
