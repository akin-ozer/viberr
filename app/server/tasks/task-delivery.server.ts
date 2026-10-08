/**
 * Delivering a task's work for review (ruling 654): `performDelivery` pushes
 * the branch, opens or updates the pull request and records the delivered
 * revision, with the conflict and closed-PR remedies around it; a person's
 * manual delivery and the project gates run by hand; and a changed revision's
 * return to review.
 */

import { holdRefusalFor } from "~/server/projections/dependencies.server";
import { headCarriesRevision } from "~/shared/revision-drift";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  activeWorkRevision,
  deliveredAsFiles,
  deliveringEngagement,
  deriveValidation,
  DIVERGED_BRANCH_REMEDY,
  type ParsedTaskFile,
  type Recommendation,
  type RevisionDeparture,
  revisionLeftWorkspace,
  type TaskFrontmatter,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { requireProjectMutable } from "~/server/auth/project-authority.server";
import {
  type AuditActor,
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { systemIdToName } from "~/server/files/actor-ref.server";
import { newId } from "~/shared/ids/new-id.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  loadProjectContext,
  notifyTaskWatchers,
  reprojectTask,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { OpenTaskPrContext } from "~/server/github/pr-open.server";
import type { GithubActionContext } from "~/server/github/github-reconciler.server";
import type { GithubContextOptions } from "~/server/github/github-context.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { logger } from "~/server/logging/logger.server";
import { userDisplayName } from "./user-display-name.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  autoInvokeOperator,
  humanActorRef,
  nextTransitionChainDepth,
  oneLineDetail,
  ownerException,
  requireAction,
  reviewStageIdOf,
  stageName,
  type TaskActionContext,
  verdictStageOf,
} from "./task-action-core.server";
import { withdrawSupersededDeliveryPacket } from "./task-escalations.server";

/**
 * Whether the server-owned Review push may commit+push the delivering profile's
 * workspace (F10-03). Resolves the DELIVERING profile's `execute-code-or-write-repo`
 * authorization; a withheld grant → false. P11-13: when a deliverer is NAMED but
 * its profile can no longer be resolved (undeployed between the run and Review),
 * fall back CONSERVATIVE (false) — never push a workspace whose grant we can't
 * confirm. Only a task with NO deliverer at all (no grant to enforce) is
 * permissive.
 */
async function resolveDeliveryPushGrant(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<boolean> {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const deliverer = file ? deliveringEngagement(file.parsed.frontmatter) : null;
  if (!deliverer) return true; // no grant to enforce
  try {
    const { resolveDeployedSpecialist } = await import("~/server/tasks/specialist-roster.server");
    const { resolveDeliveryPermissions } = await import(
      "~/server/tasks/specialist-tool-policy"
    );
    const resolved = resolveDeployedSpecialist(ctx, projectSlug, deliverer.profileId);
    return resolveDeliveryPermissions(resolved.capabilities).canCommitPush;
  } catch {
    // Known deliverer, unresolvable grant → conservative deny.
    return false;
  }
}

/** GitHub's commit JSON, decoded rather than asserted. The head sha and the
 *  tree sha carry SEPARATE tolerance so a commit whose `tree` is missing or
 *  junk still yields the revision — the tree is an extra (`null` when it can't
 *  be read), the head is the subject (the whole read is `null` without it). */
const commitRevisionSchema = z
  .object({
    sha: z.string().min(1),
    commit: z
      .object({ tree: z.object({ sha: z.string().min(1) }) })
      .nullable()
      .catch(null),
  })
  .nullable()
  .catch(null);

/**
 * F19-21 — the review SUBJECT for a verified no-change completion: the default
 * branch exactly as it stands, as a real (sha, tree) pair read from GitHub.
 *
 * R17-2's outcome was implemented as a delivery ANNOTATION (`noChanges`) on a
 * task that already had a `workRevision`. A verification-only task has none, and
 * the whole review model binds verdicts to a revision id — so a required
 * reviewer's approve was recorded as prose ("there is no delivered revision to
 * bind the verdict to yet"), `currentVerdicts` stayed empty, and acceptance
 * refused forever. Minting the base as the revision is what lets the ORDINARY
 * ceremony run over "nothing changed": the reviewers approve the repository as
 * it stands, and every gate downstream is unmodified.
 *
 * Never invents a sha. When GitHub is unreachable, unconfigured, or the default
 * branch cannot be read, this returns null and the delivery says so — an
 * unverifiable base is not a verified no-change.
 */
async function resolveNoChangeBaseRevision(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): Promise<WorkRevision | null> {
  try {
    const { getProjectGithubContext } = await import(
      "~/server/github/github-context.server"
    );
    // Optional key: set only when a caller supplied a transport (tests), so
    // the client falls back to global fetch on every production path.
    const ghOptions: GithubContextOptions = {};
    if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
    const gh = getProjectGithubContext(db, projectSlug, ghOptions);
    if (gh.status !== "ok") return null;
    const res = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/commits/${gh.defaultBranch}`,
      commitRevisionSchema,
    );
    if (!res.ok) return null;
    if (!res.data) return null;
    const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    const deliverer = file
      ? deliveringEngagement(file.parsed.frontmatter)
      : null;
    return {
      id: newId("rev"),
      headSha: res.data.sha,
      treeSha: res.data.commit?.tree.sha ?? null,
      branch: gh.defaultBranch,
      createdAt: new Date().toISOString(),
      // R19-8: this is a VERIFICATION revision — the base a reviewer judges on a
      // task with nothing to deliver, never a delivered diff. The `verified` kind
      // is what the PR-less acceptance arm (`acceptanceBlockReason` /
      // `verdictGateReason`) admits, and what `probeNothingToDeliver` recognises.
      kind: "verified",
      // The deliverer that found nothing to change owns the outcome, exactly as
      // it would own a revision it had committed. Null when nobody delivers.
      sourceProfileId: deliverer?.profileId ?? null,
    };
  } catch (error) {
    logger.warn("no-change base revision could not be resolved", {
      taskKey,
      err: toError(error),
    });
    return null;
  }
}

/**
 * The outcome of one delivery attempt (R15-2). `delivered` is the only success;
 * every failure names its cause so the operator tool result, the applied
 * `delivery` recommendation and the manual button all report honestly.
 */
export type DeliveryOutcome =
  | {
      status: "delivered";
      prNumber: number;
      url: string;
      /** True when this delivery CREATED the PR; false when one was reused. */
      created: boolean;
      /** The raw push status ("pushed", "up_to_date", or a benign non-push
       *  such as "no_commits" when an agent already delivered with its own
       *  creds). */
      pushStatus: string;
      /** Ruling 134: the workspace head the delivery left on the PR (full
       *  sha), or null when git could not name it. */
      headSha: string | null;
      /** Ruling 134: the PR was opened, or the push moved its head. A reuse
       *  that pushed nothing is `false`, and re-queues nothing (ruling 48). */
      moved: boolean;
      /** Ruling 134(b): a `delivered` operator run was queued for this outcome
       *  (full autonomy, moved head). Ruling 357: false for a delivery made by
       *  a live operator drive — its own lease release decides the follow-up. */
      operatorRequeued: boolean;
      /** Ruling 494: where the pushed branch stands against the base, from the
       *  compare the push ran before this returned (or that it could not run
       *  it, so the count on record is the one from before the push). Null
       *  when the delivery pushed nothing. */
      recompare: string | null;
    }
  /** F15-15/B-GH1: the remote branch diverged (non-fast-forward). No PR was
   *  opened — it would review the stale remote content, not the delivery. */
  | { status: "push_conflict"; branch: string; message: string }
  | { status: "grant_withheld"; message: string }
  /** The push failed outright; no PR was opened over a possibly-stale remote. */
  | { status: "push_failed"; message: string }
  /** Ruling 144: a workflow-file push refused for the `workflow` scope; the
   *  violation is open on the task and the remedy is a human's. */
  | { status: "scope_violation"; scope: string; message: string }
  /** Ruling 159: the revision's tree carries Viberr's own store layout
   *  (`projects/<slug>/tasks/...`); nothing was pushed and `files` names the
   *  offending paths. The remedy is to remove them from the branch. */
  | { status: "store_layout"; files: string[]; message: string }
  /** Ruling 160 (pass 35, F35-11): the task's pull request was closed WITHOUT
   *  merging by a person and no person has answered the recovery packet yet.
   *  No PR was opened; the branch was pushed (the rework waits on the branch
   *  for the person's answer). `closedBy` is the GitHub login GitHub named as
   *  the closer, null when it named none. */
  | { status: "closed_by_human"; prNumber: number; closedBy: string | null; message: string }
  | { status: "nothing_to_review"; message: string }
  | { status: "failed"; message: string };

/**
 * Ruling 160 (pass 35, F35-11): the ONE sentence every delivery door prints
 * when the task's pull request was closed by a person and nobody has answered
 * the recovery packet: the operator's tool result, the task page's Deliver
 * control and the timeline note all read it.
 */
function closedByHumanDeliveryText(
  taskKey: string,
  prNumber: number,
  closedBy: string | null,
): string {
  const who = closedBy ? ` by ${closedBy}` : "";
  return (
    `No pull request was opened for ${taskKey}: PR #${prNumber} was closed without merging${who}. ` +
    `A closed pull request is a person's decision about the task, so Viberr opens no new PR for this branch ` +
    `until the closed-PR decision is answered (rework and open a fresh PR, or archive the task). ` +
    `Reopening PR #${prNumber} on GitHub also lifts the block; the pushed branch keeps the latest work.`
  );
}

/** Ruling 321: what the branch is, read at the moment the push was refused.
 *  Guarded — a remedy sentence must never be the thing that throws a delivery. */
function conflictDeparture(
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
): RevisionDeparture | null {
  try {
    const fm = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter;
    return fm ? revisionLeftWorkspace(fm) : null;
  } catch {
    return null;
  }
}

/**
 * Ruling 321 — what a push conflict costs, by what is actually on the branch.
 *
 * A non-fast-forward push used to end in one fixed sentence: *"Resolve the
 * remote branch `X` (delete or rename it, or force-push deliberately), then
 * deliver again."* It is the same advice whether the branch is an abandoned
 * ref, a stranger's pull request, or the head of THIS task's own open review
 * PR — and in that last case both of the acts it names are destructive:
 * deleting the branch closes the pull request under review, and force-pushing
 * rewrites the commits the reviewers already judged.
 *
 * Live on SHOP-11, twice. A backend engineer rebased a branch that had an open
 * pull request; the delivery push was refused; this sentence told the owner to
 * delete `shop-11` — and forty-seven milliseconds later Viberr's own collision
 * ceremony wrote *"No collision to clear: PR #15 on `shop-11` is SHOP-11's own
 * review PR."* The product had the fact in the same second and the remedy did
 * not use it. The owner then spent a long decision note pricing the loss by
 * hand ("closing PR #15 loses a thread whose conclusion we already have") and
 * wrote the rule that would have prevented it into the project's KB — a merge,
 * never a rebase, once a pull request tracks the branch.
 *
 * So the remedy reads `revisionLeftWorkspace` — the shared answer to "has this
 * revision left the workspace, and by what" — and says what the branch IS
 * before it says what to do to it.
 */
function pushConflictRemedy(input: {
  taskKey: string;
  branch: string;
  reason: string;
  departure: RevisionDeparture | null;
}): string {
  const branch = `\`${input.branch}\``;
  const lede =
    `${input.taskKey}'s delivery was not pushed: ${input.reason}. This is a branch-history ` +
    `conflict, not a credential problem. No review PR was opened; it would review the stale ` +
    `remote content instead of the delivery.`;
  const departure = input.departure;
  if (departure?.kind === "pr") {
    return (
      `${lede} ${branch} is the head of ${input.taskKey}'s OWN review PR #${departure.number}: ` +
      `deleting that branch closes the pull request, and force-pushing it rewrites the commits ` +
      `the reviewers judged. Neither is the move. ${DIVERGED_BRANCH_REMEDY} If those commits are ` +
      `genuinely unwanted, discarding them is a deliberate force-push by a person, and it ` +
      `destroys them.`
    );
  }
  if (departure?.kind === "unowned_pr") {
    return (
      `${lede} ${branch} carries PR #${departure.number}, which ${input.taskKey} did not open. ` +
      `Viberr clears that itself: the recovery packet's "clear the branch collision" option ` +
      `closes that pull request, deletes the stale remote branch and re-delivers this task's ` +
      `work on one confirm. Do it there rather than by hand, so what it destroys is stated first.`
    );
  }
  if (departure?.kind === "pushed") {
    return (
      `${lede} No pull request tracks ${branch}, but ${input.taskKey} published ` +
      `\`${departure.headSha.slice(0, 7)}\` to it, so its commits are this task's own earlier ` +
      `delivery. Merge them into the branch and deliver again, or delete the branch on GitHub ` +
      `if that work is superseded, which loses it.`
    );
  }
  return (
    `${lede} No pull request tracks ${branch} and no delivery of ${input.taskKey} published to ` +
    `it, so what is on it is whatever pushed it last. Delete or rename it on GitHub and deliver ` +
    `again; merge its commits into the branch first if they are wanted.`
  );
}

/**
 * Perform delivery: push the deliverer's workspace branch, re-reconcile the
 * work revision, and open (or reuse) the review PR (R15-2 — the shared core
 * behind the operator's `deliver_for_review` tool, the applied `delivery`
 * recommendation and the task page's manual delivery button; formerly the
 * transitionStage review-entry side effect, deleted by owner ruling).
 *
 * Never throws; degraded GitHub state returns a typed outcome AND surfaces a
 * timeline event so a failed delivery is never silent. RBAC belongs to the
 * caller — the operator gate (`deliver-review-pr`) or the human authority.
 */
export async function performDelivery(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<DeliveryOutcome> {
  const dataCtx = { dataRoot: ctx.dataRoot };
  // Ruling 494: the branch this delivery's push moved, until it is re-compared.
  // Every path out after a push goes through the re-compare, the thrown one too.
  let pushedBranch: { branch: string; headSha: string | null } | null = null;
  try {
    // Ruling 240 (F37-61): a HELD task refuses delivery, for ruling 186's own
    // reason and against its own live case. Ruling 186 gated every DISPATCH
    // door after SHOP-2 "pushed a branch cut from a base that predated the
    // foundation it waited on" — and publishing that branch to a review PR is
    // this function, which had no `blockedBy` check at all. The operator's
    // turn instruction asserted the gate existed for a pass and a half before
    // anyone read the delivery path.
    //
    // Before anything else in the delivery, so a held task never reaches the
    // push, the PR open, or the branch bootstrap: the same shape as the
    // closure and hold gates in `startAgentRun`, and the same refusal sentence,
    // so a person sees one wording wherever a hold stops them.
    {
      const heldFile = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      const held = heldFile?.parsed.frontmatter.blockedBy ?? [];
      if (held.length > 0) {
        const message = holdRefusalFor(db, projectSlug, taskKey, held, "delivering it for review");
        await surfaceDeliveryEvent(db, ctx, projectSlug, taskKey, "Delivery refused", message);
        return { status: "failed", message };
      }
      // Ruling 647: a task delivered as the files its deliverer saved on it
      // (rulings 388, 531) has no branch or pull request (rulings 546, 550).
      // The task page offered this push on every delivered task of the AWS
      // estimates board, whose repository the Calculator Builder's workspace
      // checks out, so one press would have opened a review pull request for
      // a benchmark estimate.
      if (heldFile && deliveredAsFiles(heldFile.parsed.frontmatter)) {
        const message =
          `${taskKey} is delivered as the files saved on it, so there is no branch or pull request to deliver. ` +
          "Its review reads those files; Viberr pushes a branch and opens a pull request only for work committed to one.";
        await surfaceDeliveryEvent(db, ctx, projectSlug, taskKey, "Delivery refused", message);
        return { status: "failed", message };
      }
    }
    const canCommitPush = await resolveDeliveryPushGrant(ctx, projectSlug, taskKey);

    // 0. Ruling 128 (F34-4): the base branch must exist BEFORE the push, or a
    //    task branch becomes an empty repository's first ref. The gate splits by
    //    EVIDENCE: only a positive "there is no default ref and Viberr could not
    //    create it" (`bootstrap_failed`, `scope_violation`) refuses the push; a
    //    probe that merely could not be READ (network, auth) pushes anyway and
    //    the PR-side wording is what the person sees.
    const bootstrap = await ensureDefaultBranchBeforePush(db, ctx, projectSlug, taskKey, actor);
    if (bootstrap.status === "bootstrap_failed" || bootstrap.status === "scope_violation") {
      const message =
        bootstrap.status === "bootstrap_failed"
          ? `${taskKey}'s repository has no \`${bootstrap.defaultBranch}\` branch and Viberr could not create it (${bootstrap.reason}). ` +
            `Nothing was pushed: a task branch must never become the repository's first ref. ` +
            `Create \`${bootstrap.defaultBranch}\` on GitHub (or fix what GitHub named), then deliver again.`
          : `${taskKey}'s repository has no default branch and creating it was refused: the project credential lacks the \`repo\` scope (a scope violation is open on the task). ` +
            `Nothing was pushed. Grant the scope or create the branch on GitHub, then deliver again.`;
      await surfaceDeliveryEvent(db, ctx, projectSlug, taskKey, "Delivery could not run", message);
      return { status: "failed", message };
    }

    // 1. Push the workspace commits to the remote task branch.
    const pushWorkspaceBranch =
      ctx.deps?.pushWorkspaceBranch ??
      (await import("~/server/github/push-workspace.server")).pushWorkspaceBranch;
    const push = await pushWorkspaceBranch({
      db,
      projectSlug,
      taskKey,
      canCommitPush,
      ...dataCtx,
    });
    if (push.status === "pushed") pushedBranch = { branch: push.branch, headSha: push.headSha };
    // Ruling 202, corrected by ruling 211(d): the drive DELIVERED — stamped
    // once the push has actually been attempted, not on entry. Stamping on
    // entry counted the arms that do nothing at all as progress
    // (`grant_withheld`, `no_workspace`, `bootstrap_failed`), so a nudged drive
    // whose only action was a delivery that could never leave the machine
    // looked like it had moved, the stranded backstop skipped its durable
    // `heldAtStage` marker, and every later trigger re-armed the nudge from
    // scratch — F31-11's fourteen-drives loop, reached through the fix for
    // ruling 202. It still stamps BEFORE the PR call and before the result is
    // classified, because a refused push is a drive that acted; what it no
    // longer covers is a refusal that never reached the remote.
    if (ctx.operatorRun && push.status !== "grant_withheld" && push.status !== "no_workspace") {
      ctx.operatorRun.delivered = true;
    }

    // Ruling 134: `up_to_date` is an ordinary delivery (origin already carries
    // the head); only a real non-push is worth a log line.
    if (push.status !== "pushed" && push.status !== "up_to_date") {
      logger.info("workspace push before review PR did not push", {
        taskKey,
        status: push.status,
      });
    }

    // Ruling 245 (F37-74): a file another task LEASES. Surfaced and returned
    // here, before anything reads the push further: nothing was pushed, no PR
    // was opened, and the branch is exactly as it was — so this is a refusal a
    // person acts on, not a failure to diagnose. The sentence is the shared
    // `leaseRefusal` one, so a lease reads the same wherever it stops someone.
    if (push.status === "lease_held") {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery refused: a file is leased",
        push.reason,
      );
      return { status: "failed", message: push.reason };
    }

    // P11-12: a capability-policy refusal is NOT an empty delivery — surface it
    // as its own signal so a human sees the branch was blocked, not stalled.
    if (push.status === "grant_withheld") {
      const message =
        `${taskKey}'s delivering agent's repo-write capability is withheld, so its ` +
        `workspace branch was not pushed. Grant the capability or deliver the change ` +
        `by hand before accepting.`;
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery withheld by policy",
        message,
      );
      return { status: "grant_withheld", message };
    }

    // F15-15/B-GH1: a NON-FAST-FORWARD rejection is a branch-history conflict —
    // the remote already holds commits the delivery does not. Never blame the
    // credential, and never open a PR over the stale remote content: it would
    // carry a green-looking diff of the WRONG work (the live F15-15 failure —
    // the junk PR the reviewer then approved from the local tree).
    if (push.status === "push_conflict") {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery push conflicted",
        // Ruling 321: the branch is not an anonymous ref. Read what is on it
        // before telling a person to destroy it.
        pushConflictRemedy({
          taskKey,
          branch: push.branch,
          reason: push.reason,
          departure: conflictDeparture(ctx, projectSlug, taskKey),
        }),
      );
      return { status: "push_conflict", branch: push.branch, message: push.reason };
    }

    // P11-11 hardened by F15-15: a FAILED push leaves the remote missing (or
    // misrepresenting) the newest work — refuse to open a PR whose head would
    // not match the delivered commit, instead of opening one "best effort".
    if (push.status === "push_refused_scope") {
      // Ruling 144(c): the refusal is a scope violation on the task, with the
      // policy event, the inbox notification, the credential-card flag and the
      // rail count every other violation gets; the remedy names the control.
      const files = push.files.map((f) => `\`${f}\``).join(", ") || "files under `.github/workflows/`";
      const { flagScopeViolation, policyViolationText } = await import(
        "~/server/github/scope-flag.server"
      );
      const flagInput: Parameters<typeof flagScopeViolation>[1] = {
        projectSlug,
        taskKey,
        scope: push.scope,
        detail: policyViolationText(push.scope, `pushing ${files} on \`${push.branch}\``),
      };
      if (actor.userId) flagInput.actor = { userId: actor.userId, label: actor.label };
      await flagScopeViolation(db, flagInput, { dataRoot: ctx.dataRoot });
      const remedy =
        `Nothing was pushed and no review PR was opened. Grant the \`${push.scope}\` scope to the ` +
        `project's token on GitHub, then use Re-check scopes on the project's GitHub page, and deliver again.`;
      const message =
        push.phase === "before_push"
          ? `${taskKey}'s branch changes ${files}, and the project's classic token has no \`${push.scope}\` scope: GitHub would refuse the push. ${remedy}`
          : `GitHub refused to push ${files} on \`${push.branch}\`: the token lacks the \`${push.scope}\` scope (${push.reason}). ${remedy}`;
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery push refused: workflow scope",
        message,
      );
      return { status: "scope_violation", scope: push.scope, message };
    }

    // Ruling 159 (F35-10): the same shape as the scope refusal above, with the
    // offending paths named. Viberr must never publish its own store layout
    // into a customer repository, whatever an agent did.
    if (push.status === "push_refused_store_layout") {
      const files = push.files.map((f) => `\`${f}\``).join(", ");
      const message =
        `${taskKey}'s branch \`${push.branch}\` carries ${files}: that is Viberr's own store layout ` +
        `(\`projects/${projectSlug}/tasks/\`), created inside the repository checkout, not part of the repository. ` +
        `Nothing was pushed and no review PR was opened. Files placed there were never posted on this task; ` +
        `the task's real attachments folder is outside the checkout (the agent's prompt names its absolute path). ` +
        `Remove the folder from the branch, then deliver again.`;
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery push refused: store layout in the branch",
        message,
      );
      return { status: "store_layout", files: push.files, message };
    }

    if (push.status === "push_failed" || push.status === "no_pat") {
      const message =
        `${taskKey}'s execution branch could not be pushed (${push.status === "no_pat" ? "no project credential" : push.reason}). ` +
        `No review PR was opened; a PR over a remote missing the newest commits would ` +
        `review the wrong content. Fix the push, then deliver again.`;
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery push failed",
        message,
        undefined,
        // F19-18 residual: `push.reason` is a ≤240-char ONE-LINER (the sentence
        // has to stay a sentence), and the full redacted excerpt was reaching
        // only the server log — a surface the maintainer reading the task page
        // cannot see. Git's own words are what make a protected branch, a push
        // ruleset or a pre-receive hook actionable, so the untruncated block
        // rides the timeline event, in the same shape the clone failure already
        // uses (the "Workspace checkout failed" note in `dispatchAgentRun`,
        // specialist-run.server.ts).
        push.stderrExcerpt
          ? `\n\nWhat the push reported:\n\n\`\`\`\n${push.stderrExcerpt}\n\`\`\``
          : undefined,
      );
      return { status: "push_failed", message };
    }

    // Ruling 144(c): a successful push of workflow files is the proof that
    // resolves an open `workflow` violation on this project. A push whose
    // workflow files could NOT be measured (`null`, a degraded history read)
    // proves nothing and leaves the violation standing — an empty list is a
    // measurement, an absent one is not.
    if (push.status === "pushed" && (push.workflowFiles?.length ?? 0) > 0) {
      const { listScopeViolations } = await import(
        "~/server/projections/policy-violations.server"
      );
      const { resolveScopeViolationWithEvent } = await import(
        "~/server/github/scope-flag.server"
      );
      for (const violation of listScopeViolations(db, projectSlug, { status: "open" })) {
        if (violation.scope !== "workflow") continue;
        await resolveScopeViolationWithEvent(
          db,
          violation.id,
          { userId: actor.userId, label: actor.label },
          { dataRoot: ctx.dataRoot },
        );
      }
    }

    // A3: every REMAINING non-`pushed` outcome is a state no PR may be opened
    // over, and each one has its own cause. They used to fall straight through
    // to `openTaskPr` — the same hazard the three refusals above exist to stop
    // (a review PR whose head is not the delivery), reached through four
    // quieter doors. `no_commits` in particular was also what a FAILED
    // `git rev-list` looked like before push-workspace learned to say "unknown".
    // Ruling 134: `up_to_date` (origin already carries the head) flows through
    // the reconcile and `openTaskPr` exactly like `pushed`.
    if (push.status !== "pushed" && push.status !== "up_to_date") {
      // F19-21 (pass 19) — R17-2's "Completed — no changes required" outcome was
      // UNREACHABLE for the task shape ruling 43 named. `noChanges` had exactly
      // two writers, both requiring a delivery that got far enough to see an
      // EMPTY BRANCH; but push-workspace classifies a workspace whose HEAD is on
      // the default branch as `no_branch` BEFORE it ever counts commits, so a
      // verification-only task — one that never needed a branch at all — landed
      // in "Delivery could not run", never got the flag, and then dead-ended on
      // `acceptanceBlockedReason`'s "No reviewed revision yet — nothing for the
      // required reviewers to approve". Live (VC-5) the only exits left were
      // force-accept, archive, or an operator packet recommending "manually mark
      // Done" — verbatim the ceremony bypass ruling 43 exists to prevent.
      //
      // The delivery attempt is the honest place to answer it: a human or the
      // operator asked the server to ship this task and the server LOOKED at a
      // real checkout. So `no_branch` — a workspace sitting on the default
      // branch, which is exactly where a verify-only run leaves it — also counts
      // as a verified zero-diff, but ONLY for a task that has never carried a
      // delivery artifact of any kind. A task with a linked branch, a PR, a work
      // revision, or cached commits DID produce something, and a workspace now
      // off its branch is a genuine failure (a reset clone, a run that never
      // committed); those keep the old refusal, so the normal verdict gate is
      // untouched for every task that produced a diff.
      //
      // `no_workspace` is deliberately NOT here: with no checkout the server
      // read nothing, so calling it "verified" would attest to a repository
      // state it never looked at (and would let a task nobody has ever run close
      // as "no changes needed"). It keeps its old, actionable refusal — run the
      // delivering agent first, then deliver.
      //
      // …and the SAME rule binds the workspace this path DOES read. The frontmatter
      // conditions below know nothing about a checkout: they cannot see a dirty
      // tree, a local commit on main, or a task branch the run created and then
      // wandered off. A developer that edited files and forgot `git checkout -B`
      // produces exactly the frontmatter of a verify-only task, so the ref alone
      // would have closed genuine, uncommitted work as "completed with no
      // changes". `defaultBranchEvidence` is push-workspace's read-only answer to
      // precisely that, and it is REQUIRED here: absent or unverified (including
      // every "git could not tell us") keeps the old refusal.
      const preFm =
        readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter ?? null;
      const neverDelivered =
        !!preFm &&
        !preFm.pr &&
        !activeWorkRevision(preFm.workRevision) &&
        !preFm.branch &&
        (preFm.github?.commits ?? []).length === 0 &&
        !preFm.github?.changed;
      // Both doors require the SAME evidence. `no_commits` used to qualify on the
      // status alone, but it is decided after the delivery auto-commit — a block
      // that logs its own failures and falls through — so "0 commits ahead" also
      // describes an agent whose work never got committed. Requiring a clean tree
      // on both paths keeps "verified" meaning the server actually looked.
      const verifiedNoChange =
        push.defaultBranchEvidence?.verified === true &&
        (push.status === "no_commits" ||
          (push.status === "no_branch" && neverDelivered));
      // The SUBJECT the required reviewers approve. Without one, `verdicts` have
      // nothing to bind to (`recordAgentCompletion` records an approve as prose
      // — "Approval noted" — and `currentVerdicts` stays empty), which is the
      // gate that actually wedged VC-5. Anchored to the real default-branch head
      // so "the repo as it stands" is a checkable sha, not a placeholder; when
      // GitHub cannot be reached we mint nothing rather than invent one.
      const baseRevision =
        verifiedNoChange && preFm && !activeWorkRevision(preFm.workRevision)
          ? await resolveNoChangeBaseRevision(db, ctx, projectSlug, taskKey)
          : null;
      // Ruling 391's sentence for a task whose deliverable is files is gone with
      // the push it followed: ruling 647 refuses that task before the push.
      const message =
        push.status === "no_commits"
          ? `${taskKey}'s workspace carries no commits ahead of the default branch, so there is ` +
            `nothing to review and no PR was opened. If the agent produced work, it never reached ` +
            `the task branch. Re-run the delivering agent, then deliver again.`
          : verifiedNoChange
            ? `${taskKey} has never produced a branch, a commit or a pull request, and the server ` +
              `inspected its workspace before recording this: ${push.reason}. The task is recorded as ` +
              `**completed with no changes**. ` +
              (baseRevision
                ? `The subject the required reviewers now approve is the repository as it stands, at ` +
                  `\`${baseRevision.headSha.slice(0, 12)}\` on \`${baseRevision.branch}\`. Nothing has ` +
                  `been accepted; the ordinary verdict path still runs over that revision.`
                : `The default-branch head could not be read from GitHub, so no revision was recorded ` +
                  `for the reviewers to approve. Deliver again once GitHub is reachable.`)
            : push.status === "no_workspace"
              ? `${taskKey} has no workspace clone to deliver from, so its branch was not pushed and ` +
                `no review PR was opened. One opened now would review whatever the remote branch ` +
                `already holds, not this task's work. Run the delivering agent, then deliver again.`
              : push.status === "no_repo"
                ? // Ruling 667: a standing state of a board that delivers
                  // results, not a setting somebody forgot.
                  `${taskKey}'s project has no repository, so there is no branch to push and no ` +
                  `review PR to open: a task here is delivered as the files its delivering agent ` +
                  `saves on it. Hand delivery to an agent that can save files, or attach a ` +
                  `repository in project settings if this board should deliver code.`
                : push.status === "no_branch"
                  ? `${taskKey}'s workspace is not on a task branch, so nothing was pushed and no ` +
                    `review PR was opened: ${push.reason}. The delivering run must commit on the ` +
                    `task branch. Re-run it, then deliver again.`
                  : `${taskKey} has no canonical task file, so nothing could be delivered.`;
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        verifiedNoChange ? "Nothing to deliver" : "Delivery could not run",
        message,
        // R17-2 (F17-L9): a verified empty delivery marks the task a no-change
        // completion so acceptance can close it to Done cleanly. The other push
        // outcomes are genuine failures and must NOT set the flag.
        verifiedNoChange
          ? (fm) => {
              fm.noChanges = true;
              // F19-21: mint the base-anchored revision in the SAME write, so
              // every downstream gate works unchanged — verdicts bind to it,
              // `acceptanceBlockedReason` gates on real approvals instead of
              // refusing for a missing revision, and the `verified`-kind (and
              // `noChanges`) acceptance arm admits the PR-less completion.
              if (baseRevision && !activeWorkRevision(fm.workRevision)) {
                fm.workRevision = baseRevision;
              }
              // F19-27: `validation` is a CACHE and the projection reads the
              // stored value, not a fresh derivation — so setting the flag
              // without recomputing left the pre-delivery `changed` in place,
              // and `changed` renders as "awaiting verdict". Recompute over the
              // WHOLE frontmatter (AFTER any mint) so both the freshly minted
              // revision and the `noChanges` arm are seen. A task whose branch
              // is empty owes nobody a review.
              fm.validation = deriveValidation(fm);
            }
          : undefined,
      );
      // "Nothing to review" is the honest bucket for an empty branch; the rest
      // are failures to deliver at all.
      return verifiedNoChange
        ? { status: "nothing_to_review", message }
        : { status: "failed", message };
    }

    // P11-10: `pushed` means the push may have AUTO-COMMITTED an uncommitted
    // working tree just now (push-workspace.server), so the remote head can
    // postdate the workRevision minted at run completion — reviewer verdicts
    // would bind to a stale sha. Re-reconcile the workspace so the revision
    // reflects exactly what the PR delivers. Best-effort; never blocks the PR.
    try {
      const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      const deliverer = file
        ? deliveringEngagement(file.parsed.frontmatter)
        : null;
      if (deliverer) {
        const { reconcileWorkspaceDelivery } = await import(
          "~/server/github/workspace-delivery.server"
        );
        const reconcile: Parameters<typeof reconcileWorkspaceDelivery>[0] = {
          db,
          projectSlug,
          taskKey,
          profileId: deliverer.profileId,
          ...dataCtx,
        };
        if (deliverer.backend) reconcile.backend = deliverer.backend;
        if (deliverer.role) reconcile.role = deliverer.role;
        await reconcileWorkspaceDelivery(reconcile);
      }
    } catch (reconcileErr) {
      logger.warn("post-push delivery reconcile failed (best-effort)", {
        taskKey,
        err: toError(reconcileErr),
      });
    }

    // Ruling 161 (pass 35, G35-6): the push is the moment the revision LEAVES
    // the workspace. Stamp `pushedAt` on the revision whose head origin now
    // carries (`up_to_date` says origin already had it), so the discard gate
    // can tell a reported head from a published one without a PR to prove it.
    // A revision whose head the push did not name (a stale reconcile) is not
    // stamped: the PR that opens next is the proof for that shape.
    // Ruling 439: a head the revision reaches through Viberr's own base
    // refreshes carries it too, so a push of the refreshed branch publishes it.
    const pushedHead = push.headSha;
    if (pushedHead) {
      const before = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      const revBefore = before
        ? activeWorkRevision(before.parsed.frontmatter.workRevision)
        : null;
      if (
        before &&
        revBefore &&
        !revBefore.pushedAt &&
        headCarriesRevision(revBefore.headSha, pushedHead, before.parsed.frontmatter.baseRefreshes)
      ) {
        await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
          const rev = activeWorkRevision(parsed.frontmatter.workRevision);
          if (
            rev &&
            !rev.pushedAt &&
            headCarriesRevision(rev.headSha, pushedHead, parsed.frontmatter.baseRefreshes)
          ) {
            rev.pushedAt = new Date().toISOString();
          }
        });
        reprojectTask(db, ctx, projectSlug, taskKey);
      }
    }

    // 2. Open (or reuse) the review PR now that the remote carries the diff.
    const openTaskPr =
      ctx.deps?.openTaskPr ??
      (await import("~/server/github/pr-open.server")).openTaskPr;
    const prCtx: OpenTaskPrContext = { ...dataCtx };
    if (ctx.fetchImpl) prCtx.fetchImpl = ctx.fetchImpl;
    const result = await openTaskPr(
      db,
      { projectSlug, taskKey },
      {
        userId: actor.userId,
        label: actor.label,
        operatorAuthorized: ctx.operatorAuthorized === true,
      },
      prCtx,
    );
    // Ruling 494 (F40-70): the push moved the branch, so it is compared with
    // the base again now, whatever the PR door answered, and before anything
    // below re-queues the operator or reads the count. After the PR door so the
    // pass sees the PR this delivery opened, and before `recordPushedHead`, so
    // a pull request GitHub has not caught up on cannot leave its older head
    // on the file (F39-64): that write is the last word on `pr.headSha`.
    const recompare = pushedBranch
      ? await recompareDeliveredBranch(db, ctx, projectSlug, taskKey, pushedBranch, actor)
      : null;
    pushedBranch = null;
    if (result.status === "ok") {
      // R17-2: a real PR now stands for review — clear any stale no-change flag
      // from an earlier empty-branch attempt (a later delivery produced commits).
      //
      // F33-3 (pass 33): the R15-15 collision record goes with it. `unownedPr`
      // means "a PR stands on this task's branch and it is not ours"; `openTaskPr`
      // refuses outright (`branch_collision`) while that is true, so an `ok` here
      // IS the proof that the branch is this task's again. Nothing re-checked it:
      // live (VIB-1) the record from an earlier collision outlived the delivery
      // that resolved it, and the GitHub card plus the packet ceremony went on
      // describing the task's own branch as an unrelated squatter. The next
      // reconcile poll would clear it; the delivery knows sooner.
      const cur = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      const staleNoChanges = cur?.parsed.frontmatter.noChanges === true;
      const staleCollision =
        (cur?.parsed.frontmatter.github?.unownedPr ?? null) !== null ||
        (cur?.parsed.frontmatter.github?.foreignHead ?? null) !== null;
      if (staleNoChanges || staleCollision) {
        await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
          delete parsed.frontmatter.noChanges;
          // Only ever CLEARS: writing the key where it was absent would persist
          // a "checked, no collision" fact this path never established.
          if (parsed.frontmatter.github?.unownedPr != null) {
            parsed.frontmatter.github.unownedPr = null;
          }
          // Ruling 161: an `ok` PR open proves the head is this task's again.
          if (parsed.frontmatter.github?.foreignHead != null) {
            delete parsed.frontmatter.github.foreignHead;
          }
        });
        reprojectTask(db, ctx, projectSlug, taskKey);
      }
      // F29-7: a real PR now stands, so a stale "Delivery push conflict … no PR
      // opened" blocked packet from an earlier failed push is moot. It is
      // human-owned (the operator can't clear it), so clear it here or the task
      // sits `blocked` with a packet that contradicts the live PR panel.
      await withdrawSupersededDeliveryPacket(db, ctx, projectSlug, taskKey);
      // R18-2 (F18-10): opening the review PR is delivery, NOT a stage transition, so
      // the P11-70 every-transition re-trigger (and the auto-boundary stranded backstop)
      // never fires here — an autonomous task would sit `waiting:human` with no packet,
      // recommendation, or card. Under FULL autonomy the operator must proceed on its own
      // (engage the reviewer / recommend the next step): re-queue it with a `delivered`
      // trigger. SUPERVISED keeps the human in the loop — the human drives the next move,
      // so we do NOT re-trigger. Only a NEWLY opened PR counts (`result.created`); a reuse changed
      // nothing, and the operator's own deliver tool already no-ops on a live PR, so this
      // never loops. Fire-and-forget and depth-capped, exactly like the transition
      // re-trigger; `autoInvokeOperator` is itself a no-op when no operator is deployed.
      //
      // R19-4 (F19-1, owner ruling 2026-08-06) — the SUPERVISED arm is no longer
      // empty. Live (VC-1): a supervised operator delivered, narrated "the task
      // will move to Review; no further action needed", and recorded nothing —
      // leaving the task `waiting:human` with no recommendation, no packet and no
      // chip. Delivery is not a transition, so neither the P11-70 re-trigger nor
      // the auto-boundary stranded backstop covers this moment; the invariant
      // rested entirely on the model remembering. `recordDeliveredNextStep` makes
      // it structural — a system-attributed, notified "Move to <review>" card —
      // and it is the ONE writer of that card. A's `ensureDeliveredNextStep` was
      // deleted (two order-dependent writers after a delivery was the hazard this
      // replaces); its workflow-edge check ("never propose a transition the
      // workflow doesn't declare") is folded into `recordDeliveredNextStep`.
      //
      // Exactly ONE mechanism runs after a successful delivery: the R18-2 re-queue
      // (FULL autonomy, newly opened PR — the operator itself is the next step) or
      // the server-recorded card (an operator-authorized SUPERVISED delivery). A
      // human manual delivery gets neither — the human who just clicked Deliver is
      // present and needs no card. That keeps R18-2's full-autonomy behaviour
      // byte-for-byte unchanged and covers every other operator delivery.
      // Ruling 134: did anything MOVE? A newly opened PR, or a push that moved
      // the head of a reused PR. A reuse that pushed nothing (`up_to_date`)
      // moved nothing and re-queues nothing, so ruling 48's loop cannot start.
      const moved = result.created || push.status === "pushed";
      const headSha = push.status === "pushed" || push.status === "up_to_date" ? push.headSha : null;
      if (!result.created && push.status === "pushed") {
        await recordPushedHead(db, ctx, projectSlug, taskKey, {
          prNumber: result.prNumber,
          headSha: push.headSha,
          remoteHeadBefore: push.remoteHeadBefore,
          actor,
        });
      }
      // Ruling 163 (pass 35, F35-13 (c)): a delivery that moved the head of a
      // task standing PAST the review stage, on a revision that changed or
      // failed after the last verdict, records the transition back to the
      // review stage instead of leaving the task at Merge waiting for a verdict
      // nobody can give there.
      if (moved) {
        await returnChangedRevisionToReview(db, ctx, projectSlug, taskKey, headSha, actor);
      }
      let operatorRequeued = false;
      const { resolveOperatorAuthority } = await import("./operator-authority.server");
      const autonomy =
        ctx.operatorRun?.autonomy ??
        resolveOperatorAuthority(ctx, projectSlug).autonomy;
      if (autonomy === "full") {
        // Ruling 48 as amended by ruling 134(b): a newly opened PR, OR a head
        // the push moved, is a new review subject and re-queues the operator.
        if (moved && ctx.operatorRun) {
          // Ruling 357 (pass 38, F38-11): the drive that delivered IS the
          // drive that would be re-queued. Its turn continues on its own (the
          // tool reply names the PR, the prompt says to move the task and
          // engage the reviewer), so queuing a `delivered` turn behind its own
          // lease paid a whole drive for one `get_task` and "the reviewer is
          // already in flight": 140 of the 148 deliveries made inside a drive
          // on the instance, 13 of 13 on the airbnb board, ~$0.15 and the
          // coordination lane for ~15 s each, while a real drive of another
          // task parked behind it. The other 8 drives stopped right after
          // delivering, and the follow-up did the move. So the stamp defers
          // the decision to the lease release, which fires the follow-up only
          // when the drive stopped without moving or dispatching
          // (`deliveredFollowUpFor`), exactly as ruling 152(a) did for a move.
          ctx.operatorRun.deliveredHeadMoved = true;
        } else if (moved) {
          operatorRequeued = true;
          void autoInvokeOperator(
            db,
            ctx,
            projectSlug,
            taskKey,
            "delivered",
            { transitionDepth: nextTransitionChainDepth(ctx) },
          );
        }
      } else if (ctx.operatorAuthorized === true) {
        // A's owner-ruled gate (2026-08-06): operator-authorized AND supervised.
        // A HUMAN who just clicked Deliver (or applied a `delivery`
        // recommendation) reaches here without `operatorAuthorized`, so gets no
        // card; a full-autonomy delivery is covered by the re-queue above.
        // `recordDeliveredNextStep` is best-effort internally, so the open PR is
        // never turned into an error by a failure to record the follow-up card.
        await recordDeliveredNextStep(db, ctx, projectSlug, taskKey, result.prNumber);
      }
      // Ruling 482 (F40-52): the delivered revision is gated by Viberr, not by
      // an agent's report. Queued here and run off this path; a revision whose
      // gates already ran (a reuse that moved nothing) is not run again.
      const { requestProjectGatesQuietly } = await import("./project-gates.server");
      await requestProjectGatesQuietly(
        db,
        { projectSlug, taskKey, dataRoot: ctx.dataRoot, deps: ctx.deps },
        "delivery",
      );
      return {
        status: "delivered",
        prNumber: result.prNumber,
        url: result.url,
        created: result.created,
        pushStatus: push.status,
        headSha,
        moved,
        operatorRequeued,
        recompare,
      };
    }
    logger.info("review PR not opened", { taskKey, reason: result.status });

    // R16-1: an OPEN pull request that is not this task's already occupies the
    // head branch. Delivery stops on the same fact the reconciler reports as a
    // branch collision, and points at the same remedy the non-fast-forward push
    // does — never at the foreign PR as if it were ours.
    if (result.status === "branch_collision") {
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Delivery blocked by a branch collision",
        result.message,
      );
      return { status: "failed", message: result.message };
    }

    // Ruling 160 (pass 35, F35-11): a pull request a person closed without
    // merging is that person's decision about the task. The push above put
    // the rework on the branch; no PR is opened over the closed one until a
    // person answers the recovery packet (the reconciler raised it inside
    // `openTaskPr`, or had already). The sentence names the PR and the closer.
    if (result.status === "closed_by_human") {
      const message = closedByHumanDeliveryText(taskKey, result.prNumber, result.closedBy);
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        `Delivery refused: PR #${result.prNumber} was closed by a person`,
        message,
      );
      return {
        status: "closed_by_human",
        prNumber: result.prNumber,
        closedBy: result.closedBy,
        message,
      };
    }

    // 3. An empty-diff branch means the delivery produced no change (the failed-
    //    push cases returned above with their own precise reason, P11-12/P11-11).
    if (result.status === "nothing_to_review") {
      const message =
        "No review pull request could be opened: the execution branch has no " +
        "commits ahead of the default branch. The delivery may have produced no " +
        "change, or the commits never reached the remote.";
      // R17-2 (F17-L9): the branch is verified empty (zero commits ahead of the
      // default branch). Mark the task as a no-change completion so acceptance
      // can close it to Done cleanly instead of dead-ending on "deliver the
      // branch & open the PR" — which cannot be done for an empty branch.
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Review has no PR",
        message,
        (fm) => {
          fm.noChanges = true;
          // F19-27: recompute the cache alongside the flag — see above.
          fm.validation = deriveValidation(fm);
        },
      );
      return { status: "nothing_to_review", message };
    }
    // Ruling 128 (F34-4): GitHub ANSWERED. A missing base branch and any other
    // refusal are named as what they are, never as "unreachable" and never with
    // "fix the credential settings" (nothing is wrong with them).
    if (result.status === "base_branch_missing") {
      const message =
        `No pull request could be opened for ${taskKey}: ${result.message} ` +
        `The task branch was pushed, so a delivery from this workspace cannot re-cut it: delete the task branch locally and let the deliverer re-cut it from the bootstrapped \`${result.base}\`, or resolve the unrelated history by hand; then deliver again.`;
      await surfaceDeliveryEvent(db, ctx, projectSlug, taskKey, "Review PR could not be opened", message);
      return { status: "failed", message };
    }
    if (result.status === "refused") {
      const message =
        `No pull request could be opened for ${taskKey}: GitHub refused it (${result.message}). ` +
        `Fix what GitHub named, then deliver again.`;
      await surfaceDeliveryEvent(db, ctx, projectSlug, taskKey, "Review PR could not be opened", message);
      return { status: "failed", message };
    }
    // DG-5: a GitHub/credential FAILURE (auth, network, missing PAT/repo) is
    // surfaced so a human knows the review PR is missing and why.
    // (scope_violation already carries its own task-visible violation.)
    if (
      result.status === "auth_failed" ||
      result.status === "network_unavailable" ||
      result.status === "no_pat_configured" ||
      result.status === "no_repo_configured"
    ) {
      /**
       * Ruling 334: four statuses shared one remedy, and for the transport one
       * that remedy accuses a configuration that is provably fine.
       *
       * Ruling 128's own comment twelve lines above states the rule — a GitHub
       * outcome must be "named as what they are, never as 'unreachable' and
       * never with 'fix the credential settings' (nothing is wrong with them)"
       * — and it fixed the `base_branch_missing` arm while leaving the arm that
       * really IS a network failure sharing the credential sentence.
       *
       * Live on SHOP-48, and the record disproves it 58 seconds later: at
       * 23:45:36 "GitHub was unreachable (network error). Fix the
       * repository/credential settings, then deliver again", and at 23:46:34
       * "Opened PR #52 for review" — same credential, same repo, nothing
       * touched, and the retry was the operator's own. A successful push to the
       * same origin is recorded two minutes BEFORE the refusal.
       *
       * `result.message` — the transport reason GitHub's client handed back —
       * was dropped on the floor by every one of the four arms. Viberr already
       * has the right words for this case in `codex-runtime.server.ts`:
       * "Nothing about the account or the task is wrong; check this
       * deployment's network path (TLS, DNS, proxy) and retry in a few
       * minutes."
       *
       * The two `no_*_configured` arms keep the settings remedy, because for
       * them it is the true one.
       */
      // Only the two transport/credential arms carry a message; the two
      // "nothing is configured" arms have nothing to quote and need nothing.
      const said =
        (result.status === "auth_failed" || result.status === "network_unavailable") &&
        result.message.trim()
          ? ` (${oneLineDetail(result.message)})`
          : "";
      const why =
        result.status === "auth_failed"
          ? `GitHub rejected the credential (authentication failed)${said}`
          : result.status === "network_unavailable"
            ? `GitHub was unreachable${said}`
            : result.status === "no_pat_configured"
              ? "no GitHub credential is configured for this project"
              : "no GitHub repository is configured for this task";
      const remedy =
        result.status === "network_unavailable"
          ? "Nothing about this project's repository or credential is wrong; the branch is " +
            "pushed and the work is safe. Deliver again in a few minutes, or check this " +
            "deployment's network path (TLS, DNS, a proxy) if it keeps failing."
          : result.status === "auth_failed"
            ? "Fix the credential on the project's GitHub settings, then deliver again."
            : "Fix the repository/credential settings, then deliver again.";
      await surfaceDeliveryEvent(
        db,
        ctx,
        projectSlug,
        taskKey,
        "Review PR could not be opened",
        `No pull request could be opened for ${taskKey}: ${why}. ${remedy}`,
      );
      return { status: "failed", message: why };
    }
    return {
      status: "failed",
      message: `the review PR was not opened (${result.status})`,
    };
  } catch (error) {
    logger.warn("delivery failed", {
      taskKey,
      err: toError(error),
    });
    // Ruling 494: the push stands whatever threw after it, so the branch it
    // moved is compared again before this returns, as on every other path.
    if (pushedBranch) {
      await recompareDeliveredBranch(db, ctx, projectSlug, taskKey, pushedBranch, actor);
    }
    return {
      status: "failed",
      message: errorMessage(error),
    };
  }
}

/**
 * Ruling 494 (pass 40, F40-70): compare the branch a delivery push moved with
 * the base again, through the reconciler's per-task lock
 * (`recompareAfterPush`), as the delivering actor, and say what that found.
 * Never throws: a delivery is never failed by its own re-compare.
 */
async function recompareDeliveredBranch(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  pushed: { branch: string; headSha: string | null },
  actor: TaskActor,
): Promise<string | null> {
  try {
    const { recompareAfterPush, pushRecompareSentence } = await import(
      "~/server/github/github-reconciler.server"
    );
    const githubCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
    if (ctx.fetchImpl) githubCtx.fetchImpl = ctx.fetchImpl;
    // The pass's audit rows name who delivered: the operator's own actor for
    // an operator delivery (its task actor's id is a sentinel, never a user).
    const auditActor: AuditActor = ctx.operatorAuthorized
      ? OPERATOR_AUDIT_ACTOR
      : { userId: actor.userId, label: actor.label };
    const result = await recompareAfterPush(
      db,
      { projectSlug, taskKey, branch: pushed.branch, headSha: pushed.headSha, via: "delivery" },
      auditActor,
      githubCtx,
    );
    const base =
      readProjectFile({ projectSlug, dataRoot: ctx.dataRoot })?.parsed.frontmatter.defaultBranch ||
      "main";
    return pushRecompareSentence(result, { ...pushed, base });
  } catch (error) {
    logger.warn("the branch a delivery pushed could not be re-compared", {
      taskKey,
      err: toError(error),
    });
    return null;
  }
}

/**
 * R15-2 safety net (b): a human performs delivery directly from the task page's
 * GitHub panel — maintainer+ (the run-agents tier) or the task's own OWNER.
 * Audited as `github.delivery.manual` with the honest outcome.
 */
export async function manualDeliverForReview(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<DeliveryOutcome> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (ownerException(project, actor, existing.parsed.frontmatter.ownerUserId)) {
    // The owner ships their own task's branch; the archived-project freeze
    // (R6-3) still applies.
    requireProjectMutable(project, "deliver the branch & open the review PR");
  } else {
    requireAction(
      db,
      project,
      actor,
      "run-agents",
      "deliver the branch & open the review PR",
    );
  }
  const outcome = await performDelivery(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    actor,
  );
  recordAudit(db, {
    action: "github.delivery.manual",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details:
      outcome.status === "delivered"
        ? {
            status: outcome.status,
            prNumber: outcome.prNumber,
            headSha: outcome.headSha,
            moved: outcome.moved,
          }
        : { status: outcome.status },
  });
  return outcome;
}

/**
 * Ruling 482 (F40-52): a person runs the project's gates on the revision under
 * review again — after an interrupted or failed run, a gate list edited, or a
 * flaky gate. The same authority as a manual delivery (maintainer+, or the
 * task's owner), because it spends the same host time. Queued, never run on
 * this request; a run already queued or running on this revision is not
 * doubled. Audited `task.gates.requested`.
 */
export async function runProjectGatesByHand(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: TaskActor,
  ctx: TaskActionContext = {},
): Promise<{ status: "queued" | "current" | "not_owed"; message: string }> {
  const project = loadProjectContext(ctx, input.projectSlug);
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  if (ownerException(project, actor, existing.parsed.frontmatter.ownerUserId)) {
    requireProjectMutable(project, "run the project's gates");
  } else {
    requireAction(db, project, actor, "run-agents", "run the project's gates");
  }
  const { requestProjectGates } = await import("./project-gates.server");
  const outcome = await requestProjectGates(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey, dataRoot: ctx.dataRoot, deps: ctx.deps },
    { reason: "person", force: true },
  );
  recordAudit(db, {
    action: "task.gates.requested",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { status: outcome.status, runId: outcome.runId ?? null },
  });
  return { status: outcome.status, message: outcome.message };
}

/**
 * Ruling 128: make sure the project's default branch exists before the push.
 * Reads the GitHub context the same way the PR open does; a project with no
 * repository or credential is `skipped` (the push path reports those itself).
 */
async function ensureDefaultBranchBeforePush(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  actor: TaskActor,
): Promise<
  | Awaited<ReturnType<typeof import("~/server/github/repo-bootstrap.server").ensureDefaultBranch>>
  | { status: "skipped" }
> {
  const { getProjectGithubContext } = await import("~/server/github/github-context.server");
  const ghOptions: GithubContextOptions = {};
  if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
  const gh = getProjectGithubContext(db, projectSlug, ghOptions);
  if (gh.status !== "ok") return { status: "skipped" };
  const { ensureDefaultBranch } = await import("~/server/github/repo-bootstrap.server");
  return ensureDefaultBranch(
    db,
    gh,
    { projectSlug, taskKey },
    { userId: actor.userId, label: actor.label },
    { dataRoot: ctx.dataRoot },
  );
}

/**
 * Ruling 134(a): a push that MOVED the head of a reused PR is recorded on the
 * timeline ("Pushed `<sha7>` to **PR #N** for review (was `<old7>`)"), with the
 * same author rule the "Opened PR" event uses (operator → the Operator; a
 * human → that human), and `pr.headSha` is brought up to the pushed head so
 * a recorded unpushed revision it satisfies is cleared in the same write.
 * Nothing is written when git could not name the pushed head.
 */
async function recordPushedHead(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  input: {
    prNumber: number;
    headSha: string | null;
    remoteHeadBefore: string | null;
    actor: TaskActor;
  },
): Promise<void> {
  if (!input.headSha) return;
  const humanUserId =
    !ctx.operatorAuthorized && input.actor.userId ? input.actor.userId : null;
  const nameHint = humanUserId ? userDisplayName(db, humanUserId) : null;
  const actor: FileActorRef = ctx.operatorAuthorized
    ? { kind: "operator" }
    : humanUserId
      ? { kind: "human", userId: humanUserId, nameHint }
      : { kind: "system", systemId: "delivery" };
  const headSha = input.headSha;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "github",
      actor,
      title: null,
      text:
        `Pushed \`${headSha.slice(0, 7)}\` to **PR #${input.prNumber}** for review` +
        (input.remoteHeadBefore ? ` (was \`${input.remoteHeadBefore.slice(0, 7)}\`)` : "") +
        ".",
      toAgent: false,
      evidence: null,
    });
    const pr = parsed.frontmatter.pr;
    if (pr && pr.number === input.prNumber) {
      pr.headSha = headSha;
      if (pr.unpushedRevision?.revisionSha === headSha) delete pr.unpushedRevision;
    }
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
}

/**
 * Ruling 163 (pass 35, F35-13 (c)): after a delivery MOVED the review PR's
 * head, a task standing past the review stage whose derived validation is
 * `changed` or `failing` (a verdict exists, on an older revision, or requests
 * changes) goes back to the review stage in one write: `previousStageId`, a
 * `transition` timeline event naming the head, and a `task.transition` audit
 * row `via: delivery`. A task at or before the review stage, a healthy or
 * unreviewed revision, and a terminal task are left alone.
 */
export async function returnChangedRevisionToReview(
  db: DatabaseSync,
  ctx: TaskActionContext,
  projectSlug: string,
  taskKey: string,
  headSha: string | null,
  actor: TaskActor,
  /** Ruling 179 (pass 36): the reconciler's authored-drift door — the head
   *  moved by a push Viberr did not make; the audit names it and the event is
   *  the policy engine's. Absent = a delivery moved the head (ruling 163). */
  opts: { via?: "delivery" | "authored-drift" } = {},
): Promise<void> {
  const project = loadProjectContext(ctx, projectSlug);
  const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!existing) return;
  const fm = existing.parsed.frontmatter;
  const validation = deriveValidation(fm);
  if (validation !== "changed" && validation !== "failing") return;
  const reviewId = await verdictStageOf(ctx, projectSlug, project, fm);
  if (reviewId === null) return;
  const fromStageId = fm.stage;
  const via = opts.via ?? "delivery";
  const actorRef: FileActorRef =
    via === "authored-drift"
      ? { kind: "system", systemId: "policy-engine" }
      : ctx.operatorAuthorized
        ? { kind: "operator" }
        : actor.userId
          ? humanActorRef(db, actor)
          : { kind: "system", systemId: "delivery" };
  const rev = headSha ? `\`${headSha.slice(0, 7)}\`` : "the delivered revision";
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    if (parsed.frontmatter.stage !== fromStageId) return;
    parsed.frontmatter.previousStageId = fromStageId;
    parsed.frontmatter.stage = reviewId;
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "transition",
      actor: actorRef,
      title: null,
      text:
        via === "authored-drift"
          ? `**Transition:** ${taskKey} returns from ${stageName(project, fromStageId)} to ` +
            `${stageName(project, reviewId)}: the pull request's head moved to ${rev} after the ` +
            `last verdict by commits Viberr did not deliver (ruling 179), so the reviewers judge it there.`
          : `**Transition:** ${taskKey} returns from ${stageName(project, fromStageId)} to ` +
            `${stageName(project, reviewId)}: ${rev} changed after the last verdict, so the ` +
            `reviewers judge it there.`,
      toAgent: false,
      evidence: null,
    });
  });
  recordAudit(db, {
    action: "task.transition",
    actor:
      via === "authored-drift"
        ? SYSTEM_ACTOR
        : ctx.operatorAuthorized
          ? OPERATOR_AUDIT_ACTOR
          : { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { from: fromStageId, to: reviewId, boundary: "rework", via },
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
}

/**
 * Surface a delivery-stage signal as a timeline event + watcher notification
 * (P11-11/P11-12): a policy refusal, a push failure, or an empty-diff review is
 * something a human must see, not just a log line. Best-effort — a failure to
 * surface only logs.
 */
export async function surfaceDeliveryEvent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  title: string,
  text: string,
  /** Optional frontmatter mutation applied in the SAME write (e.g. R17-2's
   *  `noChanges` flag on a `nothing_to_review` result). */
  mutateFm?: (fm: TaskFrontmatter) => void,
  /** F19-18: diagnostics appended to the TIMELINE text only — a fenced excerpt
   *  of git's own output belongs on the task page, not inside a notification
   *  body, which stays the one-sentence summary. */
  timelineDetail?: string,
): Promise<void> {
  try {
    const at = new Date().toISOString();
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: at,
        type: "github",
        actor: { kind: "system", systemId: "delivery" },
        title: null,
        text: timelineDetail ? `${text}${timelineDetail}` : text,
        toAgent: false,
        evidence: null,
      });
      mutateFm?.(parsed.frontmatter);
    });
    reprojectTask(db, ctx, projectSlug, taskKey);
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "policy",
        title,
        text,
        // Ruling 497: the row opens the note, which carries git's own output.
        about: { event: at },
        // Ruling 361: the same system actor the note above carries.
        from: { kind: "system", name: systemIdToName("delivery") },
      },
      ctx,
    );
  } catch (surfaceErr) {
    logger.warn("failed to surface delivery event", {
      taskKey,
      title,
      err: toError(surfaceErr),
    });
  }
}

/** Audit fact for the F19-1 server-recorded next step (same `github.delivery.*`
 *  family as the manual/operator delivery rows). */
const DELIVERY_NEXT_STEP_AUDIT_ACTION = "github.delivery.next_step";

/**
 * F19-1 — after a SUCCESSFUL delivery, guarantee the task carries an actionable
 * next step instead of depending on the operator model volunteering one.
 *
 * Shape: the same `transition` recommendation card the operator writes when its
 * `stage-transitions` capability is `recommend` — the one VC-4/VC-5 produced and
 * VC-1 did not. A recommendation (not a packet) because a packet is the task's
 * ONE open decision and would collide with the operator's next real question,
 * and because `decisionsRequiring` already counts a pending recommendation, so
 * one write lights up the bell, "Waiting on you", the board chip and the card in
 * a single stroke. A typed timeline event alone was rejected: the delivery
 * already writes those and VC-1 proves they leave no affordance to act on.
 *
 * The guarantee is structural and never fabricates operator reasoning — the
 * timeline event is attributed to the `delivery` SYSTEM actor and the card's own
 * detail says outright that Viberr recorded it, not the agent.
 *
 * It stays quiet whenever the task is already actionable or the move is not the
 * honest next step:
 *  - an open packet IS the actionable surface;
 *  - any pending recommendation already is one — including the operator's own
 *    equivalent "Move the task to <review>" (so the two never double up).
 *    The `delivery` kind is the one exception: that card is the step this call
 *    just carried out and `applyRecommendation` clears it moments later, so
 *    counting it would strand the task exactly as before;
 *  - a task already AT or PAST the review stage needs no move — B-FD5's
 *    acceptance predicate is what surfaces it there;
 *  - the edge into the review stage is `auto` (ruling 519): nobody confirms
 *    that move, the operator makes it;
 *  - an archived task or archived (read-only, R6-3) project takes no new cards.
 *
 * Idempotent (NFR16): the suppression re-runs INSIDE the file lock, so a retry,
 * a second delivery, or a concurrent operator recommendation can never leave two
 * cards. Best-effort — a failure here only logs; it never fails the delivery
 * that already succeeded.
 */
export async function recordDeliveredNextStep(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  prNumber: number,
): Promise<void> {
  try {
    const project = loadProjectContext(ctx, projectSlug);
    if (project.archived) return;
    const reviewStageId = reviewStageIdOf(project);
    if (!reviewStageId) return;
    const existing = readTaskFile(taskRef(ctx, projectSlug, taskKey));
    if (!existing) return;
    const fm = existing.parsed.frontmatter;
    if (fm.archived) return;
    // Strictly BEFORE the review stage: at review (or beyond) the move is done.
    // An off-list stage id resolves to -1 and is left alone rather than guessed at.
    const stageIdx = project.stages.findIndex((s) => s.id === fm.stage);
    const reviewIdx = project.stages.findIndex((s) => s.id === reviewStageId);
    if (stageIdx < 0 || reviewIdx < 0 || stageIdx >= reviewIdx) return;
    // Ruling 519: an `auto` edge into the review stage is a move nobody
    // confirms. The operator makes it itself: its drive goes on after the
    // delivery, and a drive that stops at a stage with an `auto` way out is
    // re-invoked by the settle-time backstop. A card here would ask a person to
    // confirm what is not theirs to confirm, and ring their bell for it.
    if (
      project.workflow.some(
        (w) => w.from === fm.stage && w.to === reviewStageId && w.boundary === "auto",
      )
    ) {
      return;
    }
    // F36-6 (pass 36): the card is a VERDICT-AWARE offer. "Review stage" here
    // is the stage with an edge into the terminal one (Merge Approval on a
    // board with a verdict stage before it), so a task sitting AT its verdict
    // stage was "strictly before" it — and this writer, which never read the
    // verdict, invited a human to carry a task whose required review had just
    // FAILED (HLC-8, HLC-14) or was still pending (HLC-3) across the approval
    // boundary; the transition landed because nothing below reads validation
    // either. The card is written only when the delivered revision is
    // verdict-clean, or when the project has no verdict-capable specialist at
    // all (a board that never reviews). Withheld cards leave an audit row that
    // says why, so the silence is explainable.
    const validation = deriveValidation(fm);
    const { listDeployedSpecialists } = await import("./specialist-roster.server");
    const specialistCtx: TaskMutationContext = {};
    if (ctx.dataRoot) specialistCtx.dataRoot = ctx.dataRoot;
    const reviewsExist = listDeployedSpecialists(projectSlug, specialistCtx).some(
      (d) => d.capabilities.verdict,
    );
    const withheld: "verdict-failing" | "verdict-pending" | null =
      validation === "failing"
        ? "verdict-failing"
        : validation !== "healthy" && validation !== "bypassed" && reviewsExist
          ? "verdict-pending"
          : null;
    if (withheld) {
      recordAudit(db, {
        action: DELIVERY_NEXT_STEP_AUDIT_ACTION,
        actor: { userId: null, label: "delivery" },
        subjectKind: "task",
        subjectId: taskKey,
        projectSlug,
        taskKey,
        details: { kind: "transition", toStageId: reviewStageId, prNumber, withheld, validation },
      });
      return;
    }
    // Folded in from A's `ensureDeliveredNextStep`: only ever propose a move the
    // project's OWN workflow declares — a custom board with no `stage → review`
    // edge must not be handed a card for a transition it would refuse.
    if (!project.workflow.some((w) => w.from === fm.stage && w.to === reviewStageId)) return;
    if (alreadyActionable(existing.parsed)) return;

    const reviewName = stageName(project, reviewStageId);
    const label = `Move the task to ${reviewName}`;
    const detail =
      `Recorded by Viberr when the delivery landed; this is not the operator agent's ` +
      `judgement. Review pull request #${prNumber} is open while ${taskKey} is still on ` +
      `${stageName(project, fm.stage)}, and nothing had proposed a next step. Apply it to ` +
      `move the task to ${reviewName}, or dismiss it if the work is not ready for review.`;
    const recommendation: Recommendation = {
      id: newId("rec"),
      kind: "transition",
      toStageId: reviewStageId,
      label,
      detail,
    };

    let recorded = false;
    await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
      // Re-checked under the lock — the read above is not the decision.
      if (alreadyActionable(parsed)) return;
      parsed.frontmatter.recommendations.push(recommendation);
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "delivery" },
        title: null,
        text: `Next step recorded: **${label}**. ${detail}`,
        toAgent: false,
        evidence: null,
      });
      recorded = true;
    });
    if (!recorded) return;
    reprojectTask(db, ctx, projectSlug, taskKey);
    recordAudit(db, {
      action: DELIVERY_NEXT_STEP_AUDIT_ACTION,
      actor: { userId: null, label: "delivery" },
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: { kind: "transition", toStageId: reviewStageId, prNumber },
    });
    // Without this the card only appears to someone who happens to open the
    // task — the exact silence VC-1 sat in. `from` is passed EXPLICITLY: the
    // default sender is the Operator, and letting that stand would put the
    // agent's name on a notice the agent did not write.
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "approval",
        ptype: "input",
        title: `Next step recorded: ${label}`,
        text: detail,
        // Ruling 497: the row opens the card, where it is applied.
        about: "recommendations",
        from: { kind: "system", name: "Delivery" },
      },
      ctx,
    );
  } catch (error) {
    logger.warn("failed to record the delivered task's next step", {
      taskKey,
      err: toError(error),
    });
  }
}

/** True when the task already carries a human-actionable decision surface — an
 *  open packet or a pending recommendation. The `delivery` recommendation kind
 *  does NOT count: it is the step a successful delivery has just performed, and
 *  `applyRecommendation` clears it right after `performDelivery` returns. */
function alreadyActionable(parsed: ParsedTaskFile): boolean {
  if (parsed.packet) return true;
  return parsed.frontmatter.recommendations.some((r) => r.kind !== "delivery");
}
