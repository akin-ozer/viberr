import type { DatabaseSync } from "node:sqlite";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import type {
  FileActorRef,
  TaskFileEvent,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";

/**
 * R19-1 (owner ruling 2026-08-06) — the whole "Completed — no changes" contract:
 * the live proof, the accept-time gate, and the ONE completion event every
 * writer to Done uses. Extends ruling 43 (R17-2) to the shape it was named for.
 *
 * F19-21, live: VC-5 was a verification-only task ("confirm the file exists on
 * main; NO changes are expected"). The operator correctly engaged the reviewer
 * alone with no deliverer, the reviewer approved — and the verdict had nothing
 * to bind to, so `accept_completion` returned "[noop] No reviewed revision yet"
 * and the operator opened a packet asking a human how to close the task out,
 * whose recommended option was "Manually mark Done". That bypasses the entire
 * acceptance ceremony R17-2 exists to preserve.
 *
 * The `noChanges` flag alone cannot be the evidence. It records a check from
 * some past delivery attempt, and closing a task is irreversible: a branch that
 * has since gained commits must NOT ride a stale flag into Done. So the basis is
 * re-established by a LIVE read at the moment of acceptance, and the check FAILS
 * CLOSED — "we could not look" is never "there is nothing there".
 *
 * Everything lives in one module so a fifth writer to Done cannot ship without
 * the gate (the same reason `closedPrBlockedReason` is one shared helper).
 */

/** What a passing verification established — the facts the event may state. */
export interface NoChangeVerification {
  basis: "no_repo" | "no_branch" | "branch_empty";
  /** The default branch checked against (null only for `no_repo`). */
  baseBranch: string | null;
  /** The default-branch head sha at check time (null for `no_repo`). */
  baseSha: string | null;
  /** The task branch that was probed (null for `no_repo`). */
  branch: string | null;
}

export type NoChangeProbe =
  | { status: "verified"; verification: NoChangeVerification }
  | { status: "has_work"; refusal: string }
  | { status: "unverifiable"; refusal: string };

/** Is this acceptance a no-change completion at all? Pure, sync, no I/O — so the
 *  ordinary PR path never pays for a remote read. */
export function noChangeApplies(
  fm: Pick<TaskFrontmatter, "noChanges" | "pr">,
): boolean {
  return fm.noChanges === true && !fm.pr;
}

interface GhRef {
  object?: { sha?: string };
}

/**
 * The LIVE proof that a task has nothing to deliver. Exactly three bases verify:
 *
 * - `no_repo`     — the project has no GitHub repository: no place for work to exist.
 * - `no_branch`   — `GET git/ref/heads/<task branch>` 404s: no branch was ever created.
 * - `branch_empty`— the branch exists and compares 0 commits ahead of the default branch.
 *
 * Everything else REFUSES: a missing credential, an HTTP error, a rate limit, a
 * network failure — and, most importantly, a branch carrying commits, which is
 * refused by name and count. Fails closed by construction: there is no arm that
 * turns an unknown into a pass.
 */
export async function probeNothingToDeliver(
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
): Promise<NoChangeProbe> {
  try {
    const { taskBranchName } = await import("~/server/github/branch-sync.server");
    const file = readTaskFile({
      projectSlug,
      taskKey,
      ...(ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
    });
    const branch = file?.parsed.frontmatter.branch ?? taskBranchName(taskKey);

    const { getProjectGithubContext } = await import(
      "~/server/github/github-context.server"
    );
    const gh = getProjectGithubContext(db, projectSlug);
    if (gh.status === "no_repo_configured") {
      // Nothing was configured to deliver INTO. This is the one basis with no
      // sha to name, and it keeps repo-less (planning) projects acceptable.
      return {
        status: "verified",
        verification: {
          basis: "no_repo",
          baseBranch: null,
          baseSha: null,
          branch: null,
        },
      };
    }
    if (gh.status !== "ok") {
      return {
        status: "unverifiable",
        refusal:
          `${taskKey} could not be closed as "no changes" — this project has no GitHub ` +
          `credential, so \`${branch}\` could not be checked on the remote. Add a credential ` +
          `and accept again (an admin can force-accept, which records that the check did not run).`,
      };
    }

    const { encodeRefPath } = await import("~/server/github/github-client.server");
    const head = await gh.client.request<GhRef>(
      "GET",
      `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${branch}`)}`,
    );

    /** The default-branch head — the sha the outcome is pinned to. */
    const readBaseSha = async (): Promise<string | null> => {
      const baseRef = await gh.client.request<GhRef>(
        "GET",
        `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${gh.defaultBranch}`)}`,
      );
      const sha = baseRef.ok ? baseRef.data?.object?.sha : null;
      return typeof sha === "string" && sha !== "" ? sha : null;
    };

    if (!head.ok) {
      if (head.kind === "http" && head.status === 404) {
        // No branch was ever created. Pin the base we checked against, so the
        // record names WHAT was true and WHEN rather than asserting a bare
        // "nothing to do".
        const baseSha = await readBaseSha();
        if (baseSha === null) {
          return {
            status: "unverifiable",
            refusal:
              `${taskKey} could not be closed as "no changes" — no \`${branch}\` branch exists, ` +
              `but the default branch \`${gh.defaultBranch}\` could not be read, so there is ` +
              `nothing to record the outcome against. Try again once GitHub is reachable.`,
          };
        }
        return {
          status: "verified",
          verification: {
            basis: "no_branch",
            baseBranch: gh.defaultBranch,
            baseSha,
            branch,
          },
        };
      }
      return {
        status: "unverifiable",
        refusal:
          `${taskKey} could not be closed as "no changes" — GitHub could not be reached to ` +
          `check \`${branch}\` (${head.kind === "http" ? `GitHub ${head.status}` : head.kind === "network" ? head.message : "no response"}). ` +
          `Nothing verified that there is no work on the branch, so the task stays open.`,
      };
    }

    const { getBranchCompare } = await import("~/server/github/branch-sync.server");
    const compare = await getBranchCompare(
      gh.client,
      gh.repo,
      gh.defaultBranch,
      branch,
    );
    if (compare.status !== "ok") {
      return {
        status: "unverifiable",
        refusal:
          `${taskKey} could not be closed as "no changes" — \`${branch}\` exists but could not be ` +
          `compared against \`${gh.defaultBranch}\` (${compare.status.replace(/_/g, " ")}). ` +
          `Nothing verified that the branch is empty, so the task stays open.`,
      };
    }
    if (compare.compare.aheadBy > 0) {
      // The property F19-21 demands: a branch carrying commits is named, with
      // its count, and refused — never quietly closed as "no changes".
      return {
        status: "has_work",
        refusal:
          `${taskKey}'s branch \`${branch}\` carries ${compare.compare.aheadBy} commit(s) ahead ` +
          `of \`${gh.defaultBranch}\` — it cannot be completed as "no changes". Deliver the ` +
          `branch & open the review PR, or archive the task.`,
      };
    }
    const baseSha = await readBaseSha();
    return {
      status: "verified",
      verification: {
        basis: "branch_empty",
        baseBranch: gh.defaultBranch,
        baseSha,
        branch,
      },
    };
  } catch (error) {
    // An acceptance path must never take a throw from this probe — but it must
    // never take a PASS from a throw either.
    logger.warn("no-change verification failed (treated as unverifiable)", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return {
      status: "unverifiable",
      refusal:
        `${taskKey} could not be closed as "no changes" — the remote branch check failed ` +
        `unexpectedly, so nothing verified that there is no work to deliver.`,
    };
  }
}

/** One no-change verification, and the state it was performed against (A2). */
export interface AcceptanceNoChangeCheck {
  /** True when this acceptance closes a no-change completion. */
  applies: boolean;
  /** The refusal sentence, or null. Always null when `!applies`. */
  refusal: string | null;
  /** What was verified; null when refused or not applicable. */
  verification: NoChangeVerification | null;
  /** The probed branch — carried for the caller's copy. */
  branch: string | null;
}

/**
 * The accept-time gate, shaped exactly like `acceptancePrHeadCheck`: a live read
 * that cannot run inside the write lock, pinned to the state it verified so the
 * Done writer can re-assert it under the lock
 * (`assertVerifiedNoChangeStillApplies`).
 */
export async function acceptanceNoChangeCheck(
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
): Promise<AcceptanceNoChangeCheck> {
  const file = readTaskFile({
    projectSlug,
    taskKey,
    ...(ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
  });
  const fm = file?.parsed.frontmatter;
  // The ordinary PR path pays NOTHING — no read, no request.
  if (!fm || !noChangeApplies(fm)) {
    return { applies: false, refusal: null, verification: null, branch: null };
  }
  const probe = await probeNothingToDeliver(db, ctx, projectSlug, taskKey);
  if (probe.status === "verified") {
    return {
      applies: true,
      refusal: null,
      verification: probe.verification,
      branch: probe.verification.branch,
    };
  }
  return {
    applies: true,
    refusal: probe.refusal,
    verification: null,
    branch: fm.branch,
  };
}

/**
 * The in-lock half (A2). The verification above was performed against a task
 * that either IS or IS NOT a no-change completion; if that changed during the
 * await — a delivery landed and opened a PR, or the flag was cleared — the write
 * would close over something nobody verified. Refuse rather than proceed.
 */
export function assertVerifiedNoChangeStillApplies(
  fm: TaskFrontmatter,
  check: AcceptanceNoChangeCheck,
  taskKey: string,
): void {
  if (noChangeApplies(fm) === check.applies) return;
  throw AppError.conflict(
    `${taskKey} changed while the acceptance was being verified — it is ` +
      `${noChangeApplies(fm) ? "now" : "no longer"} a no-change completion, and the state ` +
      `about to be closed is not the state that was checked. Refresh the task and accept again.`,
  );
}

/**
 * The ONE "Completed — no changes" completion event, for all three writers to
 * Done. Its title is distinct from the merge path's "Completion accepted", and
 * its text never uses the word "merged" — nothing was: the honesty rule is that
 * a record may only state what the server actually did.
 */
export function noChangeCompletionEvent(input: {
  taskKey: string;
  actor: FileActorRef;
  occurredAt: string;
  by: "human" | "operator";
  /** null ⇒ the acceptance was FORCED past a check that did not pass. */
  verification: NoChangeVerification | null;
  /** The refusal that was overridden, when forced. Named verbatim so a forced
   *  close can never claim "we could not look" when we looked and found work. */
  forcedRefusal?: string | null;
}): TaskFileEvent {
  const { taskKey, verification } = input;
  const who =
    input.by === "operator"
      ? "Operator acceptance under **full-autonomy** policy recorded"
      : verification === null
        ? "Admin force-accept recorded"
        : "Human acceptance recorded";

  let text: string;
  if (verification === null) {
    text =
      `${who} — **${taskKey} closed as "no changes"** WITHOUT a passing remote re-check. ` +
      (input.forcedRefusal
        ? `The check said: ${input.forcedRefusal} `
        : `The re-check could not be performed. `) +
      `Nothing verified this outcome; nothing was delivered and there was no pull request to merge.`;
  } else if (verification.basis === "no_repo") {
    text =
      `${who} — **${taskKey} completed with no changes**. This project has no GitHub ` +
      `repository, so there was nothing to deliver and no pull request to merge.`;
  } else if (verification.basis === "no_branch") {
    text =
      `${who} — **${taskKey} completed with no changes**. Nothing was delivered and there was ` +
      `no pull request to merge: no \`${verification.branch}\` branch exists on the remote, ` +
      `checked against \`${verification.baseBranch}\`` +
      (verification.baseSha ? ` at \`${verification.baseSha.slice(0, 12)}\`` : "") +
      ` when this was accepted.`;
  } else {
    text =
      `${who} — **${taskKey} completed with no changes**. Branch \`${verification.branch}\` ` +
      `carries no commits ahead of \`${verification.baseBranch}\`` +
      (verification.baseSha ? ` (\`${verification.baseSha.slice(0, 12)}\`)` : "") +
      `, re-checked at acceptance — so there was nothing to deliver and no pull request to merge.`;
  }

  return {
    occurredAt: input.occurredAt,
    type: "completion",
    actor: input.actor,
    title: "Completed — no changes",
    text,
    toAgent: false,
    evidence: null,
  };
}
