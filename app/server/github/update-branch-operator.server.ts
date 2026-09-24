import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { describeRevisionDrift, headCarriesRevision, refreshOnlyDrift } from "~/shared/revision-drift";
import { reconcileTask, type GithubActionContext } from "./github-reconciler.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  gate,
  operatorOpenPacket,
  type OperatorActionResult,
  type OperatorAuthority,
} from "~/server/tasks/operator-actions.server";
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
 * The one thing the operator may NOT decide is a conflict. Ruling R18-4 already
 * settled the adjacent shape: a branch collision stays a human-gated packet and
 * a remote branch is never force-reset. A merge conflict is the same class of
 * fact — a genuine disagreement between two people's work — so it opens a
 * decision packet and the branch is left exactly as it was, rather than being
 * retried, forced, or narrated away.
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
  /** Ruling 133(b): conflict packets only — who the packet offered as the
   *  resolver: the deployed, repo-write delivering agent, or nobody. */
  resolver?: "deliverer" | "none";
  /** Ruling 428: the leased path that refused the update, and its holder. */
  path?: string;
  holder?: string;
};

/** Ruling 133(b): who can resolve a conflict in product. A deliverer only
 *  counts when its profile is deployed with a repo-write grant; otherwise the
 *  packet must not promise a resolver that cannot execute. */
type ConflictResolver =
  | { kind: "deliverer"; name: string }
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
  return { kind: "deliverer", name: view.name };
}

/** The head sha origin's copy carries, when the state names one. */
function remoteHeadOf(remote: RemoteBranchState): string | null {
  return "headSha" in remote ? remote.headSha : null;
}

/**
 * Ruling 134(c): the sentence about origin's copy of the branch. The tool
 * stays the BASE tool: when origin lags it points at `deliver_for_review`
 * (pushing is delivery, ruling 21) and never at a person.
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

/** The capability id that gates the operator's branch-update tool. */
export const UPDATE_BRANCH_CAPABILITY = "update-task-branch";

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
  return [
    {
      // `redirect` routes the decision back to the agent side (the resolver
      // re-engages the deliverer, which runs at every stage, ruling 133). This
      // is the IN-PRODUCT resolution and it is recommended for a reason: the
      // base is now fetched into the delivering engagement's own workspace, so
      // it can merge `origin/<base>` and resolve the files where it already has
      // the context — without a second writer touching the branch.
      kind: "redirect" as const,
      title:
        outcome === "conflict"
          ? `Have ${resolver.name} resolve the conflict`
          : `Have ${resolver.name} reconcile the branch with origin`,
      detail:
        (outcome === "conflict"
          ? `Its workspace already has \`origin/${base}\` fetched: it merges and resolves ` +
            `the conflicting files, and the next delivery pushes the result.`
          : `Its workspace fetches origin's copy of \`${branch}\`, merges the history it does not ` +
            `have, and the next delivery pushes the result; nothing is forced.`) + returnNote,
      recommended: true,
      rework: returnsToReview !== null,
      ev:
        outcome === "conflict"
          ? `**Decision:** ${resolver.name} resolves the conflict between \`${branch}\` and ` +
            `\`${base}\` in its own workspace.`
          : `**Decision:** ${resolver.name} reconciles \`${branch}\` with origin's copy in its own workspace.`,
    },
    byHand,
    archive,
  ];
}

/** Ruling 163: the review stage a redirect's resolution returns the task to,
 *  by display name, when the task stands at or past it (and is not terminal);
 *  null otherwise. */
function redirectReturnsToReview(
  ctx: TaskActionContext,
  projectSlug: string,
  fm: TaskFrontmatter,
  project: { stages: { id: string; name: string }[]; workflow: { from: string; to: string }[] } | null,
): { stageName: string } | null {
  if (!project) return null;
  const target = verdictStageFor(project, fm, listDeployedSpecialists(projectSlug, ctx));
  return target === null ? null : { stageName: stageName(project.stages, target) };
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
 * change, which is the same behaviour any pass has). (C) Re-read and write the
 * timeline event from the re-read, carrying the canonical drift sentence; the
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
  const reconcile = await reconcileTask(db, ref, by.reconcileActor, ctx);
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
  const sentence = `${outcomeSentence(result, by.lead)}${measured ? ` ${measured}` : ""}`;
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
  if (result.status === "lease_held") {
    details.path = result.path;
    details.holder = result.holder;
  }
  // Ruling 133(b): who the conflict packet will offer as the resolver, decided
  // once here so the audit row and the packet cannot disagree.
  const resolver: ConflictResolver | null =
    result.status === "conflict" || result.status === "push_conflict"
      ? conflictResolverFor(ctx, input.projectSlug, existing.parsed.frontmatter)
      : null;
  if (resolver) details.resolver = resolver.kind;
  recordAudit(db, {
    action: "github.branch_update.operator",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "branch",
    subjectId: "branch" in result ? result.branch : input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });

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
    const sentence = outcomeSentence(result);
    const newest = readTaskFile(ref)?.parsed.timeline.find((e) => e.type === "github");
    if (newest?.text !== sentence) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "github",
        actor: { kind: "operator" },
        title: null,
        text: sentence,
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

  if (result.status === "conflict" || result.status === "push_conflict") {
    const conflictFiles = result.status === "conflict" ? result.files : [];
    const packet = await operatorOpenPacket(
      db,
      { ...ctx, operatorAuthorized: true },
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title:
          result.status === "conflict"
            ? `\`${result.branch}\` conflicts with \`${result.base}\``
            : `\`${result.branch}\` diverged from its remote`,
        body:
          (result.status === "conflict"
            ? `The task branch cannot be brought up to date automatically. The merge was aborted and the branch is exactly as it was. A person decides how this is resolved.`
            : `The remote branch holds commits this task's workspace does not, so the update was rolled back rather than forced. A person decides how this is resolved.`) +
          (resolver?.kind === "none"
            ? ` No delivering agent can resolve it in product: ${resolver.reason}. Resolving by hand is the recommended option.`
            : ""),
        observations: [
          { k: "Branch", v: result.branch, code: true },
          { k: "Base", v: result.base, code: true },
          { k: "Delivering agent", v: resolver?.kind === "deliverer" ? resolver.name : "none" },
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
          resolver ?? { kind: "none", reason: "this task has no delivering agent" },
          result.status,
          returnsToReview,
        ),
      },
      authority,
    );
    const conflicted: OperatorActionResult = {
      outcome: "noop",
      message:
        `${outcomeSentence(result)} ` +
        (packet.outcome === "done"
          ? "Opened a blocking decision packet for a human to resolve — do not retry this yourself."
          : `A decision packet could NOT be opened (${packet.message}) — say so and ask a human to resolve the branch.`),
    };
    // Ruling 443: the packet is this step's outcome, not a refusal of it.
    if (packet.outcome === "done") conflicted.openedPacket = true;
    return conflicted;
  }

  // Ruling 229: the other already-current shape — the remote is level too, so
  // there is nothing even to note. Same reasoning: the tool did its job.
  if (result.status === "already_current") {
    stampRefreshed(ctx);
    return { outcome: "done", message: outcomeSentence(result) };
  }

  return { outcome: "noop", message: outcomeSentence(result) };
}
