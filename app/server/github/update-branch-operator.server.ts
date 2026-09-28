import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { taskAuditDetails } from "~/server/audit/audit-query.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { describeRevisionDrift, headCarriesRevision, refreshOnlyDrift } from "~/shared/revision-drift";
import {
  pushRecompareSentence,
  recompareAfterPush,
  type GithubActionContext,
} from "./github-reconciler.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  dispatchGate,
  gate,
  operatorDispatchAgent,
  operatorOpenPacket,
  type OperatorActionResult,
  type OperatorAuthority,
} from "~/server/tasks/operator-actions.server";
import {
  recordAcceptancePacketWithdrawal,
  recordRecommendationWithdrawal,
  terminalStageIdFor,
  withdrawAcceptanceOffers,
  withdrawAcceptancePacket,
  type AcceptancePacketWithdrawalSlot,
  type OfferWithdrawal,
} from "~/server/tasks/task-mutation.server";
import { listLiveRunRows } from "~/server/runtimes/run-store.server";
import {
  OPERATOR_AUDIT_ACTOR,
  type TaskActionContext,
} from "~/server/tasks/task-actions.server";
import {
  updateWorkspaceBranchFromBase,
  type RemoteBranchState,
  type UpdateBranchInput,
  type UpdateBranchResult,
} from "./update-branch.server";
import type { Exec } from "./push-workspace.server";
import {
  DIVERGED_BRANCH_REMEDY,
  activeWorkRevision,
  deliveringEngagement,
  type Engagement,
  type FileActorRef,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { listDeployedSpecialists } from "~/server/tasks/specialist-run.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { stageName } from "~/shared/workflow/stage-roles";
import { acceptanceBoundaryRefusal } from "./acceptance-boundary.server";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { countLabel } from "~/shared/text/plural";
import { errorMessage } from "~/shared/errors";

/**
 * The DECISION half of "bring the task branch up to date" (N19 gap 9, owner
 * ruling: operator-decided).
 *
 * Shaped on R15-2 / ruling 21, which decided the adjacent case: delivery is an
 * operator decision, gated by a capability, and the SERVER executes the
 * mechanics while the agent only decides. The same split holds here — no
 * specialist agent may do this, because the delivering engagement is the sole
 * writer of the workspace, branch and PR (the single-writer invariant), and it
 * holds no credential by construction.
 *
 * A conflict is never retried, forced or narrated away: the merge is aborted
 * and the branch is left exactly as it was (R18-4's shape, a remote branch is
 * never force-reset). Who resolves it is ruling 475's owner decision
 * (2026-09-25, superseding the "a person decides" half of rulings 133(b) and
 * 438 for this case): the operator hands it straight to the task's delivering
 * agent when that agent is deployed with a repo-write grant, and the resolved
 * branch goes back through the reviewers before anyone accepts it. The
 * blocking decision packet is the fallback, for when no agent can take it.
 */

/** What the operator's branch-update audit row records about the outcome. */
type BranchUpdateAuditDetails = {
  status: UpdateBranchResult["status"];
  /** Base commits the branch was missing — `updated` only. */
  commits?: number;
  /** Conflicting paths (`conflict`), or the store-layout paths that refused the
   *  update (`store_layout`, ruling 159(b)). */
  files?: string[];
  /** Ruling 134(c): origin's copy of the branch as it stood BEFORE the call. */
  remote?: RemoteBranchState["kind"];
  remoteHeadSha?: string | null;
  /** Ruling 132: the merge commit an `updated` refresh created. */
  mergeSha?: string;
  /** Ruling 133(b): conflicts only — who can resolve it in product: the
   *  deployed, repo-write delivering agent, or nobody. */
  resolver?: "deliverer" | "none";
  /** Ruling 475: conflicts only — where the conflict went. `deliverer`: the
   *  operator handed it to the delivering agent (`handedTo`); `packet`: a
   *  blocking decision packet for a person; `in_progress`: the deliverer is
   *  already resolving this same conflict, so nothing new was sent. */
  route?: "deliverer" | "packet" | "in_progress";
  /** Ruling 475: the profile the conflict was handed to. */
  handedTo?: string;
  /** Ruling 475: the packet is the fallback because the deliverer was already
   *  sent this same conflict once and the branch still conflicts. */
  repeat?: true;
  /** Ruling 475: the handoff was attempted and no run started; the reason. */
  handoffRefused?: string;
  /** Ruling 475: `conflict` only — the base tip the merge was attempted on. */
  baseSha?: string;
  /** Ruling 428: the leased path that refused the update, and its holder. */
  path?: string;
  holder?: string;
};

/** The action the operator's branch-update audit rows carry. */
const BRANCH_UPDATE_AUDIT_ACTION = "github.branch_update.operator";

/** Ruling 133(b): who can resolve a conflict in product. A deliverer only
 *  counts when its profile is deployed with a repo-write grant; otherwise the
 *  packet must not promise a resolver that cannot execute. */
type ConflictResolver =
  | { kind: "deliverer"; name: string; profileId: string }
  | { kind: "none"; reason: string };

function conflictResolverFor(
  ctx: TaskActionContext,
  projectSlug: string,
  fm: { engagements: Engagement[] },
): ConflictResolver {
  const deliverer = deliveringEngagement(fm);
  if (!deliverer) return { kind: "none", reason: "this task has no delivering agent" };
  const view = listDeployedSpecialists(projectSlug, ctx).find((s) => s.id === deliverer.profileId);
  if (!view) {
    return { kind: "none", reason: `its delivering agent (${deliverer.profileId}) is no longer deployed` };
  }
  if (view.capabilities?.delivery !== true) {
    return { kind: "none", reason: `its delivering agent (${view.name}) holds no repo-write grant any more` };
  }
  return { kind: "deliverer", name: view.name, profileId: view.id };
}

/** The two outcomes the conflict arm handles. */
type ConflictResult = Extract<UpdateBranchResult, { status: "conflict" | "push_conflict" }>;

/** Ruling 475: what makes two conflicts "the same one": the same files
 *  against the same base commit, or the same head of origin's copy refusing
 *  the push. A sha that could not be read matches any, which errs towards the
 *  packet (a person decides), never towards a second handoff. */
function sameConflict(
  result: ConflictResult,
  earlier: { sha: string | null; files: readonly string[] },
): boolean {
  const sha =
    result.status === "conflict" ? (result.baseSha ?? null) : (result.remoteHeadSha ?? null);
  const files = result.status === "conflict" ? [...result.files].sort() : [];
  const shaMatches = sha === null || earlier.sha === null || sha === earlier.sha;
  return shaMatches && [...earlier.files].sort().join("\0") === files.join("\0");
}

/** The fields of an earlier branch-update audit row this door reads back. */
const handoffRowSchema = z.object({
  status: z.string(),
  route: z.string().optional(),
  handedTo: z.string().optional(),
  baseSha: z.string().optional(),
  remoteHeadSha: z.string().nullable().optional(),
  files: z.array(z.string()).optional(),
});

/** How far back the earlier-handoff read looks, in this task's own rows. */
const HANDOFF_LOOKBACK_ROWS = 50;

/**
 * Ruling 475: when this same conflict was already handed to the delivering
 * agent, the handoff on record (newest first), else null. Read from this
 * door's own audit rows, which record every routing decision.
 */
function earlierHandoff(
  db: DatabaseSync,
  ref: { projectSlug: string; taskKey: string },
  result: ConflictResult,
): { at: string; profileId: string } | null {
  const rows = taskAuditDetails(db, {
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    action: BRANCH_UPDATE_AUDIT_ACTION,
    limit: HANDOFF_LOOKBACK_ROWS,
  });
  for (const row of rows) {
    const parsed = handoffRowSchema.safeParse(row.details);
    if (!parsed.success) continue;
    const d = parsed.data;
    if (d.route !== "deliverer" || !d.handedTo || d.status !== result.status) continue;
    const sha = d.status === "conflict" ? (d.baseSha ?? null) : (d.remoteHeadSha ?? null);
    if (sameConflict(result, { sha, files: d.files ?? [] })) {
      return { at: row.at, profileId: d.handedTo };
    }
  }
  return null;
}

/** Ruling 475: the profile has a run in flight (running or queued) on the task. */
function hasLiveRun(
  db: DatabaseSync,
  ref: { projectSlug: string; taskKey: string },
  profileId: string,
): boolean {
  return listLiveRunRows(db).some(
    (r) =>
      r.project_slug === ref.projectSlug &&
      r.task_key === ref.taskKey &&
      r.agent_profile_id === profileId,
  );
}

/** "the `package.json` conflict", "the conflict in `a`, `b`", "the conflict". */
function conflictPhrase(files: readonly string[]): string {
  if (files.length === 1) return `the \`${files[0]}\` conflict`;
  if (files.length > 1) return `the conflict in ${files.map((f) => `\`${f}\``).join(", ")}`;
  return "the conflict";
}

/**
 * Ruling 475 (ruling 438's one agent merge): the directive the delivering
 * agent's run starts with. It says what to merge, where it already is, what to
 * resolve, and that delivering is not the agent's job.
 */
function conflictDirective(result: ConflictResult): string {
  const tail =
    "Do not push, and do not open or touch a pull request: the operator delivers the result, " +
    "and the reviewers judge the resolved branch before anyone accepts it.";
  if (result.status === "conflict") {
    const files = result.files.map((f) => `\`${f}\``).join(", ");
    return (
      `\`${result.branch}\` conflicts with \`${result.base}\`` +
      (result.files.length ? ` in ${files}` : "") +
      `. Viberr's merge was aborted, so the branch is exactly as you left it. ` +
      `\`origin/${result.base}\` is already fetched into your workspace: merge it into ` +
      `\`${result.branch}\` (a merge, never a rebase), resolve ` +
      (result.files.length ? files : "every conflicting file") +
      ` keeping the intent of both sides, run the project's gates, and commit the merge. ${tail}`
    );
  }
  return (
    `Origin's copy of \`${result.branch}\` holds commits your workspace does not, so Viberr could ` +
    `not push the branch and rolled its update back. Origin's copy is already fetched into your ` +
    `workspace as \`origin/${result.branch}\`: merge it into \`${result.branch}\` (a merge, never a ` +
    `rebase and never a force-push), resolve anything that conflicts keeping the intent of both ` +
    `sides, run the project's gates, and commit. ${tail}`
  );
}

/**
 * Ruling 475: the sentence the person reads on the timeline when the operator
 * hands the conflict on. Written for a person: who got it, what they do with
 * it, and what happens before anyone accepts the result.
 */
function handoffSentence(
  taskKey: string,
  result: ConflictResult,
  resolverName: string,
  returned: Pick<HandoffReturn, "fromName" | "toName"> | null,
): string {
  const what =
    result.status === "conflict"
      ? `The operator sent ${conflictPhrase(result.files)} between \`${result.branch}\` and ` +
        `\`${result.base}\` to ${resolverName}, which merges \`${result.base}\` into the branch in ` +
        `its own workspace and resolves it.`
      : `The operator sent \`${result.branch}\` to ${resolverName}: GitHub's copy of the branch ` +
        `holds commits the workspace does not, and ${resolverName} merges them in its own ` +
        `workspace. Nothing is forced.`;
  const review = returned
    ? ` ${taskKey} returns from ${returned.fromName} to ${returned.toName}, so the reviewers judge ` +
      `the resolved branch before anyone accepts it.`
    : ` The reviewers judge the resolved branch before anyone accepts it.`;
  return what + review;
}

/** The head sha origin's copy carries, when the state names one. */
function remoteHeadOf(remote: RemoteBranchState): string | null {
  return "headSha" in remote ? remote.headSha : null;
}

/**
 * Ruling 134(c): the sentence about origin's copy of the branch, FOR THE MODEL
 * (the tool result). The tool stays the BASE tool: when origin lags it points
 * at `deliver_for_review` (pushing is delivery, ruling 21) and never at a
 * person. Ruling 475 (F40-60): the timeline gets {@link remotePersonSentence}
 * instead, because this one is an instruction to the operator.
 */
function remoteSentence(branch: string, remote: RemoteBranchState): string {
  switch (remote.kind) {
    case "current":
      return `Origin carries the workspace head \`${remote.headSha.slice(0, 7)}\`.`;
    case "behind":
      return (
        `Origin's copy of \`${branch}\` (\`${remote.headSha.slice(0, 7)}\`) is ` +
        `${countLabel(remote.commits, "commit")} behind the workspace head: call \`deliver_for_review\` ` +
        `to push it. Do not ask a person to push.`
      );
    case "diverged":
      return (
        `Origin's copy of \`${branch}\` (\`${remote.headSha.slice(0, 7)}\`) holds commits this workspace ` +
        `does not, so a plain push would be refused as non-fast-forward. ${DIVERGED_BRANCH_REMEDY} ` +
        `That is a person's act, not yours, and never a force-push.`
      );
    case "absent":
      return `\`${branch}\` does not exist on origin yet: call \`deliver_for_review\` to push it. Do not ask a person to push.`;
    case "unknown":
      return `Origin's copy of \`${branch}\` could not be read (${remote.why}).`;
  }
}

/**
 * Ruling 475 (F40-60): the same fact for the PERSON reading the timeline.
 *
 * Ruling 134(c) put origin's lag on the record for the humans and then wrote
 * the model's sentence there: live on WEB-1, WEB-2 and WEB-4, every delivery
 * was preceded by "call `deliver_for_review` to push it. Do not ask a person
 * to push.", an imperative addressed to the operator about a tool no control
 * on the page carries, and the diverged variant told the person who has to act
 * "That is a person's act, not yours". This says what is true and who acts
 * next, in the page's own terms.
 */
function remotePersonSentence(branch: string, base: string, remote: RemoteBranchState): string {
  const level = `\`${branch}\` is level with \`${base}\`.`;
  switch (remote.kind) {
    case "current":
      return `${level} GitHub carries the workspace head \`${remote.headSha.slice(0, 7)}\`.`;
    case "behind":
      return (
        `${level} GitHub's copy of the branch (\`${remote.headSha.slice(0, 7)}\`) is ` +
        `${countLabel(remote.commits, "commit")} behind the workspace; the operator's next ` +
        `delivery pushes ${remote.commits === 1 ? "it" : "them"}.`
      );
    case "diverged":
      return (
        `${level} GitHub's copy of the branch (\`${remote.headSha.slice(0, 7)}\`) holds commits ` +
        `the workspace does not, so the branch cannot be pushed as it stands. ${DIVERGED_BRANCH_REMEDY}`
      );
    case "absent":
      return `${level} The branch is not on GitHub yet; the operator's next delivery pushes it.`;
    case "unknown":
      return `${level} GitHub's copy of the branch could not be read (${remote.why}).`;
  }
}

/** The capability id that gates the operator's branch-update tool. */
const UPDATE_BRANCH_CAPABILITY = "update-task-branch";

type Gate = "direct" | "recommend" | "deny";

/**
 * Resolve the branch-update capability for this authority.
 *
 * Absent falls back to the DELIVERY gate, deliberately: this capability
 * postdates every operator deployment in existence (the R15-9 situation — an
 * absent grant is the norm, not an edge case), and updating the branch is a
 * strictly SMALLER act than delivering it. Same branch, same server-owned git,
 * no PR, no new work published beyond what the base already merged. An operator
 * trusted to push the branch and open the review PR is trusted to keep that
 * branch current; one that is not trusted to deliver does not get to touch the
 * branch either. Reusing `deliverGate` rather than inventing a second polarity
 * rule also means an undeployed operator (A4) is denied here for free, and the
 * strict-project derivation (`absentDeliverReviewPrMode`) is not duplicated.
 *
 * An EXPLICIT grant always wins, so an admin can separate the two.
 */
export function updateBranchGate(authority: OperatorAuthority): Gate {
  // F31-C2: the absent-follows-delivery polarity now lives inside gate()
  // itself (absentPolarityGate), so this front is a plain delegation.
  return gate(authority, UPDATE_BRANCH_CAPABILITY);
}

export interface OperatorUpdateBranchInput {
  projectSlug: string;
  taskKey: string;
  /** Injected runner (tests). */
  exec?: Exec;
}

/**
 * The conflict packet's options, in EXISTING packet-option kinds only — the
 * resolver dispatches on `kind`, so a new kind would be a button that resolves
 * to nothing. Each carries its own `ev`: the default text for these kinds is
 * "Operator re-engages the specialist with a summon note", which would file
 * "I'll fix the branch myself" under a sentence about summoning an agent.
 */
function conflictOptions(
  branch: string,
  base: string,
  resolver: ConflictResolver,
  outcome: "conflict" | "push_conflict",
  /** Ruling 163: the redirect's resolution returns the task to the review
   *  stage; null when the task stands before it (nothing to return to). */
  returnsToReview: { stageName: string } | null = null,
  /** Ruling 475: the deliverer was already sent this same conflict and the
   *  branch still conflicts, so resolving by hand is recommended and the
   *  redirect becomes a second attempt a person may still choose. */
  alreadyTried = false,
) {
  const byHand = {
    kind: "custom" as const,
    title: `Resolve \`${branch}\` yourself`,
    detail:
      outcome === "conflict"
        ? `Merge \`${base}\` into the branch by hand and push it.`
        : `Reconcile the branch with origin's copy by hand (merge or rebase locally) and push it.`,
    ev:
      `**Decision:** a person resolves \`${branch}\` against \`${base}\` directly. Viberr ` +
      `re-checks the branch on the operator's next turn and reports it up to date.`,
  };
  const archive = {
    kind: "archive_task" as const,
    title: "Archive the task: the work is superseded",
    detail: "Keeps the record and the branch; the task leaves the board.",
    ev: `**Decision:** archive the task rather than resolve \`${branch}\` against \`${base}\`.`,
  };
  // Ruling 133(b): a packet offers only options that can execute. With no
  // deployed, repo-write deliverer the in-product redirect would promise a
  // resolver that does not exist, so resolving by hand is what is recommended.
  if (resolver.kind === "none") {
    return [{ ...byHand, recommended: true }, archive];
  }
  // Ruling 163 (pass 35, F35-13): a redirect resolved on a task at or past the
  // review stage RETURNS it there in the same write (`rework: true` is what
  // `resolvePacket` reads), so the resolved revision gets its verdict where
  // the reviewers are eligible instead of waiting at Merge for a verdict
  // nobody can give there (KNC-20, KNC-22, KNC-16).
  const returnNote = returnsToReview
    ? ` The task returns to ${returnsToReview.stageName} for the re-verdict.`
    : "";
  const redirect = {
    // `redirect` routes the decision back to the agent side (the resolver
    // re-engages the deliverer, which runs at every stage, ruling 133). This
    // is the IN-PRODUCT resolution and it is recommended for a reason: the
    // base is now fetched into the delivering engagement's own workspace, so
    // it can merge `origin/<base>` and resolve the files where it already has
    // the context — without a second writer touching the branch.
    kind: "redirect" as const,
    title: alreadyTried
      ? outcome === "conflict"
        ? `Have ${resolver.name} try the conflict again`
        : `Have ${resolver.name} try reconciling the branch again`
      : outcome === "conflict"
        ? `Have ${resolver.name} resolve the conflict`
        : `Have ${resolver.name} reconcile the branch with origin`,
    detail:
      (outcome === "conflict"
        ? `Its workspace already has \`origin/${base}\` fetched: it merges and resolves ` +
          `the conflicting files, and the next delivery pushes the result.`
        : `Its workspace fetches origin's copy of \`${branch}\`, merges the history it does not ` +
          `have, and the next delivery pushes the result; nothing is forced.`) + returnNote,
    recommended: !alreadyTried,
    rework: returnsToReview !== null,
    ev:
      outcome === "conflict"
        ? `**Decision:** ${resolver.name} resolves the conflict between \`${branch}\` and ` +
          `\`${base}\` in its own workspace.`
        : `**Decision:** ${resolver.name} reconciles \`${branch}\` with origin's copy in its own workspace.`,
  };
  // Ruling 475: a resolver that already failed this conflict once is still a
  // choice a person may make (with their own guidance), but not the one the
  // packet recommends.
  return alreadyTried
    ? [{ ...byHand, recommended: true }, redirect, archive]
    : [redirect, byHand, archive];
}

/** Ruling 163: the review stage a redirect's resolution returns the task to,
 *  by id and display name, when the task stands at or past it (and is not
 *  terminal); null otherwise. Ruling 475's handoff returns the task there
 *  itself, in the same write that records the handoff. */
function redirectReturnsToReview(
  ctx: TaskActionContext,
  projectSlug: string,
  fm: TaskFrontmatter,
  project: { stages: { id: string; name: string }[]; workflow: { from: string; to: string }[] } | null,
): { stageId: string; stageName: string } | null {
  if (!project) return null;
  const target = verdictStageFor(project, fm, listDeployedSpecialists(projectSlug, ctx));
  return target === null ? null : { stageId: target, stageName: stageName(project.stages, target) };
}

/** One sentence per outcome, for the model AND the audit trail. `lead` is the
 *  verb phrase an `updated` sentence opens with (the operator's "Brought", the
 *  acceptance ceremony's "Accepting the completion brought"). */
function outcomeSentence(r: UpdateBranchResult, lead = "Brought"): string {
  switch (r.status) {
    case "updated":
      return (
        `${lead} \`${r.branch}\` up to date with \`${r.base}\` (${countLabel(r.commits, "commit")} ` +
        `merged in, merge commit \`${r.mergeSha.slice(0, 7)}\`; the push published it, so origin now ` +
        `carries the workspace head` +
        (r.remoteBefore.kind === "behind"
          ? `, including the ${countLabel(r.remoteBefore.commits, "workspace commit")} origin was missing`
          : r.remoteBefore.kind === "absent"
            ? `; the branch did not exist on origin before`
            : "") +
        `).`
      );
    case "already_current":
      return `\`${r.branch}\` is already up to date with \`${r.base}\`. ${remoteSentence(r.branch, r.remote)}`;
    case "conflict":
      return (
        `\`${r.branch}\` CONFLICTS with \`${r.base}\`` +
        (r.files.length ? ` in ${r.files.join(", ")}` : "") +
        `. The merge was aborted and the branch is untouched.`
      );
    case "push_conflict":
      return `The update could not be published: ${r.reason}.`;
    case "store_layout":
      // Ruling 159(b): the same refusal the delivery push reports, through the
      // door that pushes the workspace head. Naming the paths is the remedy.
      return `\`${r.branch}\` was NOT updated: ${r.reason}. Remove those paths from the branch, then update it again.`;
    case "lease_held":
      // Ruling 428: the delivery push's lease refusal, through this door.
      return (
        `\`${r.branch}\` was NOT updated, and nothing was merged or pushed: ${r.reason} ` +
        `Do not retry the refresh until ${r.holder} has merged.`
      );
    case "update_failed":
      return `The branch was not updated: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`;
    default:
      return `The branch was not updated: ${r.reason}.`;
  }
}

/**
 * Ruling 132 (pass 34, F34-14), in three explicit steps, shared since pass 35
 * (ruling 162) by the operator's tool and the acceptance ceremony. (A) Under
 * the file lock, record the refresh: the merge commit, the base tip, the base
 * name and the count. Without this row the reconciler has no way to tell this
 * merge from authored work, and it would report the base's commits as
 * unreviewed. (B) Reconcile, so `pr.revisionDrift` is re-measured NOW rather
 * than by the five-minute poll (the PR is open, so no divergence arm fires; the
 * reconcile may still notify watchers or wake the operator on an out-of-band
 * change, which is the same behaviour any pass has). Since ruling 494 this is
 * the push's re-compare (`recompareAfterPush`): the push is recorded first, so
 * a count the pass could not replace reads as the one before it. (C) Re-read
 * and write the timeline event from the re-read, carrying the canonical drift sentence; the
 * returned sentence is built from that same re-read. The crash window between
 * the push and (A) is closed by the next classified pass, which sees the merge
 * commit without a row and counts it as authored: honest, and self-healing once
 * the row lands.
 */
export async function recordBranchRefresh(
  db: DatabaseSync,
  ctx: GithubActionContext,
  ref: { projectSlug: string; taskKey: string },
  result: Extract<UpdateBranchResult, { status: "updated" }>,
  by: {
    /** Who the timeline line is attributed to. */
    timelineActor: FileActorRef;
    /** Who the reconcile's audit rows name. */
    reconcileActor: AuditActor;
    /** The verb phrase the sentence opens with. */
    lead: string;
  },
): Promise<string> {
  const fileRef = { projectSlug: ref.projectSlug, taskKey: ref.taskKey, dataRoot: ctx.dataRoot };
  await updateTaskFile(fileRef, (parsed) => {
    parsed.frontmatter.baseRefreshes.push({
      mergeSha: result.mergeSha,
      baseSha: result.baseSha,
      base: result.base,
      commits: result.commits,
      at: new Date().toISOString(),
      onto: result.onto,
    });
    // Ruling 439: the push that published the merge published the revision it
    // was made onto, the same fact a delivery push stamps (ruling 161).
    const rev = activeWorkRevision(parsed.frontmatter.workRevision);
    if (
      rev &&
      !rev.pushedAt &&
      headCarriesRevision(rev.headSha, result.mergeSha, parsed.frontmatter.baseRefreshes)
    ) {
      rev.pushedAt = new Date().toISOString();
    }
  });
  // Ruling 494 (F40-70): the push moved the branch, so its re-compare records
  // the push and then runs this pass in the task's lock: the count on record
  // is counted on `mergeSha`, or reads as older when the pass could not run.
  const reconcile = await recompareAfterPush(
    db,
    {
      projectSlug: ref.projectSlug,
      taskKey: ref.taskKey,
      branch: result.branch,
      headSha: result.mergeSha,
      via: "branch-update",
    },
    by.reconcileActor,
    ctx,
  );
  // F39-64 (pass 39): GitHub shows a pushed head on the pull request some
  // seconds after the push, and the reconcile above can read the PR first.
  // It then measured no drift at the head it was shown, the reviewed one, and
  // this wrote "The review PR's head now equals the reviewed revision" one line
  // after the merge commit it had just pushed. Live on ax-clone AX-29 the
  // acceptance ceremony did that and merged, so the permanent completion
  // record left out the refresh the acceptance itself shipped. The pushed head
  // is in hand, and Viberr recorded every commit between it and the reviewed
  // revision, so the drift is read from that record (ruling 439) until GitHub
  // catches up. The same record answers when GitHub could not be read at all.
  let lagging = false;
  let fromRecord: ReturnType<typeof refreshOnlyDrift> = null;
  await updateTaskFile(fileRef, (parsed) => {
    const pr = parsed.frontmatter.pr;
    const rev = activeWorkRevision(parsed.frontmatter.workRevision);
    if (!pr || pr.headSha === result.mergeSha) return;
    lagging = true;
    fromRecord = rev
      ? refreshOnlyDrift(rev.headSha, result.mergeSha, parsed.frontmatter.baseRefreshes)
      : null;
    if (fromRecord) pr.revisionDrift = fromRecord;
  });
  const after = readTaskFile(fileRef)?.parsed.frontmatter ?? null;
  const drift = describeRevisionDrift(after?.pr?.revisionDrift);
  const measured = fromRecord
    ? `Drift, from Viberr's own refresh record (GitHub had not shown the new head on the pull request): ${drift.sentence}.`
    : reconcile.status !== "reconciled"
      ? `Drift could not be re-measured now (${reconcile.status}); the next GitHub pass will.`
      : !after?.pr
        ? ""
        : lagging
          ? `GitHub has not shown the new head on the pull request yet, so the drift was not re-measured; the next GitHub pass will.`
          : drift.kind === "none"
            ? `The review PR's head now equals the reviewed revision.`
            : `Drift re-measured: ${drift.sentence}.`;
  // Ruling 494: a re-compare that could not run leaves the count from before
  // the push on record, and the line says so rather than letting it stand.
  const recount =
    reconcile.status === "reconciled"
      ? ""
      : pushRecompareSentence(reconcile, {
          branch: result.branch,
          headSha: result.mergeSha,
          base: result.base,
        });
  const sentence =
    `${outcomeSentence(result, by.lead)}${measured ? ` ${measured}` : ""}` +
    (recount ? ` ${recount}` : "");
  // A branch that moved must SAY it moved. The tool result is text the model
  // reads; the timeline is the record the humans read, and a base merge
  // changes what every reviewer is looking at.
  await appendTimelineEvent(fileRef, {
    occurredAt: new Date().toISOString(),
    type: "github",
    actor: by.timelineActor,
    title: null,
    text: sentence,
    toAgent: false,
    evidence: null,
  });
  rebuildPath(db, resolveTaskFilePath(fileRef), { dataRoot: ctx.dataRoot });
  return sentence;
}

/** F39-69: tell the drive it refreshed, so its settle can see a drive that
 *  stopped right after preparing the branch. */
function stampRefreshed(ctx: TaskActionContext): void {
  if (ctx.operatorRun) ctx.operatorRun.refreshed = true;
}

/**
 * Bring the task branch up to date with the project's base branch, as an
 * operator decision. Never throws; every outcome is a typed
 * {@link OperatorActionResult} whose message says what actually happened.
 */
export async function operatorUpdateBranchFromBase(
  db: DatabaseSync,
  /** The action context: `fetchImpl` (tests) reaches the post-update reconcile. */
  ctx: TaskActionContext,
  input: OperatorUpdateBranchInput,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = updateBranchGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message:
        "Bringing the task branch up to date is not permitted for the operator here.",
    };
  }
  if (g === "recommend") {
    // No recommendation card exists for this action, and inventing one by
    // performing it anyway would be the silent-promotion failure ruling Q1
    // exists to stop. Refuse honestly and name the surface that IS available.
    return {
      outcome: "denied",
      message:
        "Your policy asks a human before the task branch is moved — open a decision packet proposing the update instead of performing it.",
    };
  }
  const ref = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: ctx.dataRoot,
  };
  const existing = readTaskFile(ref);
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  // Ruling 162 / G35-5(d): the operator stops refreshing at the acceptance
  // boundary; the acceptance ceremony refreshes once and merges.
  const projectFile = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  const boundaryRefusal = projectFile
    ? acceptanceBoundaryRefusal(
        existing.parsed.frontmatter,
        input.taskKey,
        projectFile.parsed.frontmatter,
      )
    : null;
  // F39-10: `noop`, not `denied`. The operator's `update-task-branch` grant is
  // whatever the project set it to — on the live ax-clone board it is `direct`,
  // and this refusal fired twice anyway, because what rules the step out is the
  // task's STAGE. Returned as `denied`, `narrateRefusedActions` files it under
  // "refused by its capability policy" as a `policy` event, so the record sends
  // a reader to the Agents page to loosen a grant that was never the cause.
  // That is the misblame class LV-03 exists to prevent, and this type's own
  // contract already says which field decides it.
  if (boundaryRefusal) return { outcome: "noop", message: boundaryRefusal };
  // Ruling 163: a task at or past the review stage returns to it when the
  // conflict's redirect is resolved, so the resolved revision gets its verdict
  // where the reviewers are eligible. Decided here so the option's own text
  // says what its resolution does.
  const returnsToReview = redirectReturnsToReview(
    ctx,
    input.projectSlug,
    existing.parsed.frontmatter,
    projectFile?.parsed.frontmatter ?? null,
  );

  const updateInput: UpdateBranchInput = {
    db,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
  };
  // Optional keys: absent `dataRoot` means the process default root, and absent
  // `exec` means the real git runner.
  if (ctx.dataRoot) updateInput.dataRoot = ctx.dataRoot;
  if (input.exec) updateInput.exec = input.exec;
  const result = await updateWorkspaceBranchFromBase(updateInput);
  // The audit carries whatever the outcome carries — commits only on an actual
  // update, conflicting paths only on a conflict, origin's copy and the merge
  // commit when they were read.
  const details: BranchUpdateAuditDetails = { status: result.status };
  if (result.status === "updated") {
    details.commits = result.commits;
    details.mergeSha = result.mergeSha;
    details.remote = result.remoteBefore.kind;
    details.remoteHeadSha = remoteHeadOf(result.remoteBefore);
  }
  if (result.status === "already_current") {
    details.remote = result.remote.kind;
    details.remoteHeadSha = remoteHeadOf(result.remote);
  }
  if (result.status === "conflict" || result.status === "store_layout") {
    details.files = result.files;
  }
  // Ruling 475: what identifies this conflict, so a second one can be told
  // from the one already handed to the deliverer.
  if (result.status === "conflict" && result.baseSha) details.baseSha = result.baseSha;
  if (result.status === "push_conflict" && result.remoteHeadSha) {
    details.remoteHeadSha = result.remoteHeadSha;
  }
  if (result.status === "lease_held") {
    details.path = result.path;
    details.holder = result.holder;
  }
  const recordBranchUpdateAudit = (): void =>
    recordAudit(db, {
      action: BRANCH_UPDATE_AUDIT_ACTION,
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "branch",
      subjectId: "branch" in result ? result.branch : input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details,
    });

  if (result.status === "conflict" || result.status === "push_conflict") {
    // Ruling 133(b): who can resolve it in product, decided once here so the
    // audit row, the handoff and the packet cannot disagree. The conflict arm
    // records the audit row itself, once it knows where the conflict went.
    const resolver = conflictResolverFor(ctx, input.projectSlug, existing.parsed.frontmatter);
    details.resolver = resolver.kind;
    return routeConflict(db, ctx, authority, {
      ref,
      result,
      resolver,
      returnsToReview,
      stages: projectFile?.parsed.frontmatter.stages ?? [],
      details,
      recordAudit: recordBranchUpdateAudit,
    });
  }
  recordBranchUpdateAudit();

  if (result.status === "updated") {
    const reconcileCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
    if (ctx.fetchImpl) reconcileCtx.fetchImpl = ctx.fetchImpl;
    const sentence = await recordBranchRefresh(
      db,
      reconcileCtx,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      result,
      {
        timelineActor: { kind: "operator" },
        reconcileActor: OPERATOR_AUDIT_ACTOR,
        lead: "Brought",
      },
    );
    stampRefreshed(ctx);
    return { outcome: "done", message: sentence };
  }

  if (result.status === "already_current" && result.remote.kind !== "current") {
    // Ruling 134(c): origin lagging the workspace is a fact the humans need on
    // the record, not only the model. The tool is idempotent by contract, so
    // the record is too: the line is SUPPRESSED when the newest `github` event
    // already says exactly this; the audit row above still fires every call.
    // Ruling 475 (F40-60): the record gets the PERSON's sentence; the model's,
    // which tells the operator which tool to call, stays the tool result.
    const sentence = outcomeSentence(result);
    const personSentence = remotePersonSentence(result.branch, result.base, result.remote);
    const newest = readTaskFile(ref)?.parsed.timeline.find((e) => e.type === "github");
    if (newest?.text !== personSentence) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: { kind: "operator" },
        title: null,
        text: personSentence,
        toAgent: false,
        evidence: null,
      });
      rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    }
    // Ruling 229 (F37-49): `done`, not `noop`. An already-current branch is this
    // tool's SUCCESS condition, not a state conflict — its own description tells
    // the operator so ("It is idempotent and cheap: an already-current branch
    // changes nothing and says so, so call it when you are unsure rather than
    // guessing"). Returned as `noop` it became a REFUSED plan step, and
    // `narrateRefusedActions` headlined it "The operator's plan was not carried
    // out in full." 51 of the 57 such notes on the pass-37 board were this one
    // line. Worse, the sentence was already on the timeline as the `github`
    // event three lines up — the event ruling 134(c) deliberately suppresses
    // when it would duplicate, re-added by the refusal narration with no
    // suppression and a worse headline.
    stampRefreshed(ctx);
    return { outcome: "done", message: sentence };
  }

  // Ruling 229: the other already-current shape — the remote is level too, so
  // there is nothing even to note. Same reasoning: the tool did its job.
  if (result.status === "already_current") {
    stampRefreshed(ctx);
    return { outcome: "done", message: outcomeSentence(result) };
  }

  return { outcome: "noop", message: outcomeSentence(result) };
}

/** "2026-09-25 00:28 UTC", for a sentence a person reads. */
function minuteUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** A dispatch refusal quoted inside a sentence: ends with exactly one period. */
function asSentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, "");
  return trimmed ? `${trimmed}.` : "";
}

/**
 * Ruling 475 (F40-20, owner decision 2026-09-25): where a conflict goes.
 *
 * Live on akinozer-com at 00:27 UTC WEB-2's accept was refused over a
 * `package.json` conflict with WEB-4's merge. The operator ran this door, wrote
 * a comment naming the exact fix (keep the new "test" script and main's
 * "check:contrast"), and then, by design, opened "`web-2` conflicts with
 * `main`": "A person decides how this is resolved." The owner's whole part was
 * to confirm "Have Platform Engineer resolve the conflict", the packet's own
 * recommendation.
 *
 * So the operator routes it:
 *  - A delivering agent deployed with a repo-write grant (ruling 133(b)'s
 *    eligibility) gets it straight away: a task at or past review returns to
 *    the review stage (ruling 163's `returnsToReview`) with a person-facing
 *    line on the timeline, and the agent's run starts with ruling 438's
 *    directive. Its resolved branch is delivered and judged by the reviewers
 *    again before anyone accepts it.
 *  - That same conflict (the same files against the same base commit, or the
 *    same origin head refusing the push) already handed over once: while the
 *    agent's run is live nothing new is sent; after it, the deliverer failed,
 *    and a person decides.
 *  - No deliverer, no repo-write grant, an operator whose policy asks a person
 *    before it starts an agent, or a run that could not start: the blocking
 *    packet, which says which of these it is.
 * Every route writes the branch-update audit row with `route`.
 *
 * Any open packet offering `accept_completion` is withdrawn first (F40-55
 * (b)): the acceptance it offers would be refused, and one packet stands at a
 * time, so it would also keep the fallback packet from opening.
 */
async function routeConflict(
  db: DatabaseSync,
  ctx: TaskActionContext,
  authority: OperatorAuthority,
  input: {
    ref: { projectSlug: string; taskKey: string; dataRoot?: string };
    result: ConflictResult;
    resolver: ConflictResolver;
    returnsToReview: { stageId: string; stageName: string } | null;
    stages: readonly { id: string; name: string }[];
    details: BranchUpdateAuditDetails;
    recordAudit: () => void;
  },
): Promise<OperatorActionResult> {
  const { ref, result, resolver, details } = input;
  const opCtx = { ...ctx, operatorAuthorized: true };
  await withdrawMootAcceptancePacket(db, ref, result);
  const sentence = outcomeSentence(result);

  // Why the fallback packet is needed, in the packet's own words, when a
  // deliverer exists but cannot be handed this conflict now.
  let fallback: { why: string; byHand: boolean } | null = null;
  if (resolver.kind === "deliverer") {
    const earlier = earlierHandoff(db, ref, result);
    if (earlier && hasLiveRun(db, ref, earlier.profileId)) {
      details.route = "in_progress";
      details.handedTo = earlier.profileId;
      input.recordAudit();
      return {
        outcome: "noop",
        message:
          `${sentence} ${resolver.name} was sent this same conflict at ${earlier.at} and its run ` +
          `is still going: wait for its report, then deliver the result with ` +
          `\`deliver_for_review\`. Nothing new was sent and no packet was opened.`,
      };
    }
    if (earlier) {
      details.repeat = true;
      fallback = {
        why:
          `${resolver.name} was already sent this same conflict (${minuteUtc(earlier.at)}) and ` +
          `the branch still conflicts, so a person decides how it is resolved.`,
        byHand: true,
      };
    } else if (dispatchGate(authority) !== "direct") {
      fallback = {
        why:
          `The operator's policy asks a person before it starts an agent, so it could not send ` +
          `the conflict to ${resolver.name} itself. A person decides how it is resolved.`,
        byHand: false,
      };
    } else {
      const dispatch = ctx.deps?.dispatchAgent ?? operatorDispatchAgent;
      // A dispatch that throws is a run that could not start, never a lost
      // conflict: the packet below says so with the error.
      const dispatched = await dispatch(
        db,
        opCtx,
        {
          projectSlug: ref.projectSlug,
          taskKey: ref.taskKey,
          profileId: resolver.profileId,
          prompt: conflictDirective(result),
          reason: `Ruling 475: the branch conflicts with its base, and the delivering agent resolves it.`,
        },
        authority,
      ).catch((error) => ({ outcome: "noop" as const, message: errorMessage(error) }));
      if (dispatched.outcome === "done") {
        const returned = await recordHandoff(db, ctx, input);
        details.route = "deliverer";
        details.handedTo = resolver.profileId;
        input.recordAudit();
        return {
          outcome: "done",
          message:
            `${sentence} Ruling 475: handed it to ${resolver.name}, the delivering agent. ` +
            `${asSentence(dispatched.message)} ` +
            (returned
              ? `${ref.taskKey} returned from ${returned.fromName} to ${returned.toName} for the re-verdict. `
              : "") +
            `Do not open a packet for it and do not refresh the branch again until ${resolver.name} ` +
            `reports. When it reports the merge committed, deliver the result with ` +
            `\`deliver_for_review\`: the reviewers judge the resolved branch before anyone accepts it.`,
        };
      }
      details.handoffRefused = dispatched.message;
      fallback = {
        why:
          `The operator sent it to ${resolver.name}, but no run started: ` +
          `${asSentence(dispatched.message)} A person decides how it is resolved.`,
        byHand: false,
      };
    }
  }

  details.route = "packet";
  input.recordAudit();
  const conflictFiles = result.status === "conflict" ? result.files : [];
  const why =
    resolver.kind === "none"
      ? ` No delivering agent can resolve it in product: ${resolver.reason}. Resolving by hand is the recommended option.`
      : fallback
        ? ` ${fallback.why}${fallback.byHand ? " Resolving by hand is the recommended option." : ""}`
        : "";
  const packet = await operatorOpenPacket(
    db,
    opCtx,
    {
      projectSlug: ref.projectSlug,
      taskKey: ref.taskKey,
      packetType: "blocked",
      title:
        result.status === "conflict"
          ? `\`${result.branch}\` conflicts with \`${result.base}\``
          : `\`${result.branch}\` diverged from its remote`,
      body:
        (result.status === "conflict"
          ? `The task branch cannot be brought up to date automatically. The merge was aborted and the branch is exactly as it was.`
          : `The remote branch holds commits this task's workspace does not, so the update was rolled back rather than forced.`) +
        why,
      observations: [
        { k: "Branch", v: result.branch, code: true },
        { k: "Base", v: result.base, code: true },
        { k: "Delivering agent", v: resolver.kind === "deliverer" ? resolver.name : "none" },
        ...(conflictFiles.length
          ? [{ k: "Conflicting files", v: conflictFiles.join(", "), code: true }]
          : []),
        ...(result.status === "conflict" && result.detail
          ? [{ k: "git", v: result.detail, code: true }]
          : []),
      ],
      options: conflictOptions(
        result.branch,
        result.base,
        resolver,
        result.status,
        input.returnsToReview,
        details.repeat === true,
      ),
    },
    authority,
  );
  const conflicted: OperatorActionResult = {
    outcome: "noop",
    message:
      `${sentence} ` +
      (packet.outcome === "done"
        ? "Opened a blocking decision packet for a human to resolve — do not retry this yourself."
        : `A decision packet could NOT be opened (${packet.message}) — say so and ask a human to resolve the branch.`),
  };
  // Ruling 443: the packet is this step's outcome, not a refusal of it.
  if (packet.outcome === "done") conflicted.openedPacket = true;
  return conflicted;
}

/** Ruling 475 (F40-55 (b)): withdraw an open packet that offers acceptance,
 *  because the branch it would merge conflicts. No write when none stands. */
async function withdrawMootAcceptancePacket(
  db: DatabaseSync,
  ref: { projectSlug: string; taskKey: string; dataRoot?: string },
  result: ConflictResult,
): Promise<void> {
  const open = readTaskFile(ref)?.parsed.packet;
  if (!open || !open.options.some((o) => o.kind === "accept_completion")) return;
  const slot: AcceptancePacketWithdrawalSlot = { withdrawn: null };
  await updateTaskFile(ref, (parsed) => {
    slot.withdrawn = withdrawAcceptancePacket(
      parsed,
      result.status === "conflict"
        ? `\`${result.branch}\` conflicts with \`${result.base}\`, so the acceptance it offers would be refused`
        : `\`${result.branch}\` diverged from its remote, so the acceptance it offers would be refused`,
      { kind: "operator" },
    );
  });
  if (slot.withdrawn === null) return;
  recordAcceptancePacketWithdrawal(db, {
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    withdrawn: slot.withdrawn,
    reason: "pr_conflicting",
    actor: OPERATOR_AUDIT_ACTOR,
  });
  rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ref.dataRoot });
}

/** Ruling 475: a task's return to the review stage, by stage id and names. */
interface HandoffReturn {
  fromId: string;
  fromName: string;
  toName: string;
}

/** What the handoff's locked write carries out of its closure. */
interface HandoffWriteSlot {
  returned: HandoffReturn | null;
  offers: OfferWithdrawal | null;
}

/**
 * Ruling 475: the record of a handoff, in one write: the person-facing
 * sentence, and (ruling 163) the task's return to the review stage when it
 * stands past it, with the acceptance offers that return makes moot withdrawn
 * (ruling 137). The stage move is audited like the packet redirect's.
 */
async function recordHandoff(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    ref: { projectSlug: string; taskKey: string; dataRoot?: string };
    result: ConflictResult;
    resolver: ConflictResolver;
    returnsToReview: { stageId: string; stageName: string } | null;
    stages: readonly { id: string; name: string }[];
  },
): Promise<HandoffReturn | null> {
  const { ref, result, resolver, returnsToReview } = input;
  if (resolver.kind !== "deliverer") return null;
  const terminalId = terminalStageIdFor(ctx, ref.projectSlug);
  const slot: HandoffWriteSlot = { returned: null, offers: null };
  await updateTaskFile(ref, (parsed) => {
    const fm = parsed.frontmatter;
    if (returnsToReview && fm.stage !== returnsToReview.stageId) {
      slot.returned = {
        fromId: fm.stage,
        fromName: stageName([...input.stages], fm.stage),
        toName: returnsToReview.stageName,
      };
      fm.previousStageId = fm.stage;
      fm.stage = returnsToReview.stageId;
      slot.offers = withdrawAcceptanceOffers(
        parsed,
        terminalId,
        { kind: "stage_move", toStageId: returnsToReview.stageId, toStageName: returnsToReview.stageName },
        { kind: "operator" },
      );
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: slot.returned ? "transition" : "github",
      actor: { kind: "operator" },
      title: null,
      text: handoffSentence(ref.taskKey, result, resolver.name, slot.returned),
      toAgent: false,
      evidence: null,
    });
  });
  if (slot.returned && returnsToReview) {
    recordAudit(db, {
      action: "task.transition",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: ref.taskKey,
      projectSlug: ref.projectSlug,
      taskKey: ref.taskKey,
      details: {
        from: slot.returned.fromId,
        to: returnsToReview.stageId,
        boundary: "rework",
        via: "conflict_handoff",
      },
    });
    if (slot.offers && slot.offers.removed.length > 0 && returnsToReview) {
      recordRecommendationWithdrawal(db, {
        projectSlug: ref.projectSlug,
        taskKey: ref.taskKey,
        withdrawal: slot.offers,
        cause: { kind: "stage_move", toStageId: returnsToReview.stageId, toStageName: returnsToReview.stageName },
        actor: OPERATOR_AUDIT_ACTOR,
      });
    }
  }
  rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ref.dataRoot });
  return slot.returned;
}
