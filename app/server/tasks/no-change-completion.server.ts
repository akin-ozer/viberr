import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "~/server/errors/app-error.server";
import {
  type TaskFileRef,
  readTaskFile,
} from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { listKbCorrections, type KbCorrection } from "~/server/org/kb-corrections.server";
import type { GithubContextOptions } from "~/server/github/github-context.server";
import {
  deliveredAsFiles,
  type FileActorRef,
  type TaskFileEvent,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { toError } from "~/shared/errors";

/**
 * R19-8 (ruling 62) — the whole "Completed — no changes" contract:
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

/** The task-file read ref for a call context: `dataRoot` is carried only when
 *  the caller actually has one, so the reader keeps its own default otherwise. */
function taskFileRef(
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
): TaskFileRef {
  const ref: TaskFileRef = { projectSlug, taskKey };
  if (ctx.dataRoot) ref.dataRoot = ctx.dataRoot;
  return ref;
}

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

/** The task has no pull request to merge — the only shape a "no changes" outcome
 *  can have. R20-2 (F20-6): the ACCEPT path probes on this alone, not on the
 *  agent's `noChanges` flag, because an envelope that forgot the flag left the
 *  server refusing with advice that would open an EMPTY PR (VIB-2). */
export function noChangeCandidate(fm: Pick<TaskFrontmatter, "pr">): boolean {
  return !fm.pr;
}

/**
 * Ruling 550: a task the accept-time probe may prove empty: no pull request,
 * and a delivery that was never a branch. A task delivered as the files saved
 * on it has no PR because its delivery never was a branch, and the probe found
 * no branch and recorded a delivered result as "completed with no changes".
 * ONE predicate for the check before the probe and the re-check in the lock.
 */
function probeCandidate(fm: Pick<TaskFrontmatter, "pr" | "workRevision" | "deliveredAt">): boolean {
  return noChangeCandidate(fm) && !deliveredAsFiles(fm);
}

/** `GET /git/ref/...` — the one field this module reads, decoded by the
 *  request itself: a body without a sha (an empty one is no sha at all) comes
 *  back a `decode` failure, which reads as "no base sha" exactly like an HTTP
 *  failure does. */
const refShaSchema = z.object({ object: z.object({ sha: z.string().min(1) }) });

/** What the live probe needs from its caller: where the files are, and the
 *  mock-transport hook the GitHub context already takes (tests only). */
export interface NoChangeProbeContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
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
  ctx: NoChangeProbeContext,
  projectSlug: string,
  taskKey: string,
): Promise<NoChangeProbe> {
  try {
    const { taskBranchName } = await import("~/server/github/branch-sync.server");
    const file = readTaskFile(taskFileRef(ctx, projectSlug, taskKey));
    const branch = file?.parsed.frontmatter.branch ?? taskBranchName(taskKey);

    const { getProjectGithubContext } = await import(
      "~/server/github/github-context.server"
    );
    // `fetchImpl` is an OPTIONAL key: the context reads it with a truthiness
    // check, so the hook is set only when a caller supplied one.
    const githubOptions: GithubContextOptions = {};
    if (ctx.fetchImpl) githubOptions.fetchImpl = ctx.fetchImpl;
    const gh = getProjectGithubContext(db, projectSlug, githubOptions);
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
          `${taskKey} could not be closed as "no changes": this project has no GitHub ` +
          `credential, so \`${branch}\` could not be checked on the remote. Add a credential ` +
          `and accept again (an admin can force-accept, which records that the check did not run).`,
      };
    }

    const { encodeRefPath } = await import("~/server/github/github-client.server");
    // Only the answer's status is read (does the branch exist?), so the body is
    // taken as-is: any 2xx means the branch is there and the compare decides.
    const head = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${branch}`)}`,
      z.unknown(),
    );

    /** The default-branch head — the sha the outcome is pinned to. */
    const readBaseSha = async (): Promise<string | null> => {
      const baseRef = await gh.client.request(
        "GET",
        `/repos/${gh.repo}/git/ref/${encodeRefPath(`heads/${gh.defaultBranch}`)}`,
        refShaSchema,
      );
      return baseRef.ok ? baseRef.data.object.sha : null;
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
              `${taskKey} could not be closed as "no changes": no \`${branch}\` branch exists, ` +
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
          `${taskKey} could not be closed as "no changes": GitHub could not be reached to ` +
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
          `${taskKey} could not be closed as "no changes": \`${branch}\` exists but could not be ` +
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
          `of \`${gh.defaultBranch}\`, so it cannot be completed as "no changes". Deliver the ` +
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
      err: toError(error),
    });
    return {
      status: "unverifiable",
      refusal:
        `${taskKey} could not be closed as "no changes": the remote branch check failed ` +
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
  /** R20-2 (F20-6): the frontmatter did NOT claim `noChanges` — the server
   *  proved it by probing the branch. Drives the disclosure and the frontmatter
   *  repair. */
  autoDetected: boolean;
  /** R20-2: for an UNCLAIMED task the probe could not clear — carried so the
   *  refusal one level up can borrow the counted `has_work` sentence instead of
   *  `verdictGateReason`'s (wrong-for-empty) "open the PR" advice. */
  probe?: "has_work" | "unverifiable";
  probeRefusal?: string | null;
}

/**
 * The accept-time gate, shaped exactly like `acceptancePrHeadCheck`: a live read
 * that cannot run inside the write lock, pinned to the state it verified so the
 * Done writer can re-assert it under the lock
 * (`assertVerifiedNoChangeStillApplies`).
 */
export async function acceptanceNoChangeCheck(
  db: DatabaseSync,
  ctx: NoChangeProbeContext,
  projectSlug: string,
  taskKey: string,
): Promise<AcceptanceNoChangeCheck> {
  const file = readTaskFile(taskFileRef(ctx, projectSlug, taskKey));
  const fm = file?.parsed.frontmatter;
  if (!fm) {
    return { applies: false, refusal: null, verification: null, branch: null, autoDetected: false };
  }
  const claimed = noChangeApplies(fm); // fm.noChanges === true && !fm.pr
  // The ordinary PR path pays NOTHING — a task WITH a PR fails the candidate
  // test, and (ruling 550) so does a task delivered as files.
  if (!claimed && !probeCandidate(fm)) {
    return { applies: false, refusal: null, verification: null, branch: null, autoDetected: false };
  }
  const probe = await probeNothingToDeliver(db, ctx, projectSlug, taskKey);
  if (probe.status === "verified") {
    return {
      applies: true,
      refusal: null,
      verification: probe.verification,
      branch: probe.verification.branch,
      // R20-2: an UNCLAIMED task the server proved empty is auto-detected.
      autoDetected: !claimed,
    };
  }
  // R20-2: an UNCLAIMED task the probe could not clear is simply not a no-change
  // acceptance. It must NOT inherit the claimed path's fail-closed refusal (that
  // would turn every PR-less accept attempt into a GitHub-outage refusal). It
  // falls through to the ordinary gates, which refuse it for the right reason
  // (the counted `has_work` sentence, carried below). A CLAIMED task keeps the
  // R19-8 fail-closed refusal exactly as it was.
  if (!claimed) {
    return {
      applies: false,
      refusal: null,
      verification: null,
      branch: fm.branch,
      autoDetected: false,
      probe: probe.status,
      probeRefusal: probe.refusal,
    };
  }
  return {
    applies: true,
    refusal: probe.refusal,
    verification: null,
    branch: fm.branch,
    autoDetected: false,
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
  // R20-2: re-assert against the predicate the check actually used, or an
  // auto-detected acceptance (which never saw a `noChanges` flag) always throws.
  const stillApplies = check.autoDetected ? probeCandidate(fm) : noChangeApplies(fm);
  if (stillApplies === check.applies) return;
  throw AppError.conflict(
    `${taskKey} changed while the acceptance was being verified: it is ` +
      `${noChangeApplies(fm) ? "now" : "no longer"} a no-change completion, and the state ` +
      `about to be closed is not the state that was checked. Refresh the task and accept again.`,
  );
}

const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Ruling 576: the knowledge-base corrections made on a task that still stand
 * (nobody has undone them), oldest first. They are work the task did, so a
 * task that made them did not complete "with no changes", whatever its branch
 * says. Read from the correction records the Controller page lists.
 */
export function standingKbCorrections(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): KbCorrection[] {
  return listKbCorrections(db, { projectSlug })
    .filter((c) => c.taskKey === taskKey && c.undone === null)
    .reverse();
}

/**
 * Ruling 576: what such a task produced, by id and document, with who made
 * it. Never the passage (ruling 568): the ids and the Controller page carry it.
 */
export function kbCorrectionsOutcome(corrections: readonly KbCorrection[]): string {
  const byDoc = new Map<string, string[]>();
  for (const c of corrections) {
    const where = `\`${c.kb}/${c.doc}\``;
    byDoc.set(where, [...(byDoc.get(where) ?? []), `\`${c.id}\``]);
  }
  const places = [...byDoc].map(([where, ids]) => `${LIST_AND.format(ids)} in ${where}`);
  const makers = LIST_AND.format([...new Set(corrections.map((c) => c.filedBy))]);
  return `the knowledge-base corrections made on it, which stand: ${places.join("; ")}, by ${makers}`;
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
  /** R20-2 (F20-6): the completion did NOT claim `noChanges` — the server proved
   *  it at acceptance. Disclosed so the record states who established the fact. */
  autoDetected?: boolean;
  /** Ruling 576: the task's standing knowledge-base corrections
   *  ({@link standingKbCorrections}). With any, nothing went to the repository
   *  but the task did change something, and the record names what. */
  kbCorrections?: readonly KbCorrection[];
}): TaskFileEvent {
  const { taskKey, verification } = input;
  const kb = input.kbCorrections ?? [];
  const completed = kb.length > 0 ? "completed with no repository changes" : "completed with no changes";
  const outcome = kb.length > 0 ? `Its outcome is ${kbCorrectionsOutcome(kb)}. ` : "";
  // R20-2: one clause naming the server as the verifier, only when auto-detected
  // and only for the two branch-shaped bases (no_repo names its own cause).
  const autoClause =
    input.autoDetected && verification && verification.basis !== "no_repo"
      ? " The completion did not claim this; the server verified it at acceptance."
      : "";
  const who =
    input.by === "operator"
      ? "Operator acceptance under **full-autonomy** policy recorded"
      : verification === null
        ? "Admin force-accept recorded"
        : "Human acceptance recorded";

  let text: string;
  if (verification === null) {
    text =
      `${who}: **${taskKey} closed as "${kb.length > 0 ? "no repository changes" : "no changes"}"** WITHOUT a passing remote re-check. ` +
      outcome +
      (input.forcedRefusal
        ? `The check said: ${input.forcedRefusal} `
        : `The re-check could not be performed. `) +
      `Nothing verified this outcome; nothing was delivered and there was no pull request to merge.`;
  } else if (verification.basis === "no_repo") {
    text =
      `${who}: **${taskKey} ${completed}**. ${outcome}This project has no GitHub ` +
      `repository, so there was nothing to deliver and no pull request to merge.`;
  } else if (verification.basis === "no_branch") {
    text =
      `${who}: **${taskKey} ${completed}**. ${outcome}Nothing was delivered and there was ` +
      `no pull request to merge: no \`${verification.branch}\` branch exists on the remote, ` +
      `checked against \`${verification.baseBranch}\`` +
      (verification.baseSha ? ` at \`${verification.baseSha.slice(0, 12)}\`` : "") +
      ` when this was accepted.` +
      autoClause;
  } else {
    text =
      `${who}: **${taskKey} ${completed}**. ${outcome}Branch \`${verification.branch}\` ` +
      `carries no commits ahead of \`${verification.baseBranch}\`` +
      (verification.baseSha ? ` (\`${verification.baseSha.slice(0, 12)}\`)` : "") +
      `, re-checked at acceptance, so there was nothing to deliver and no pull request to merge.` +
      autoClause;
  }

  return {
    occurredAt: input.occurredAt,
    type: "completion",
    actor: input.actor,
    title: kb.length > 0 ? "Completed with no repository changes" : "Completed with no changes",
    text,
    toAgent: false,
    evidence: null,
  };
}
