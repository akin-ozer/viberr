import type { DatabaseSync } from "node:sqlite";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { describeRevisionDrift } from "~/shared/revision-drift";
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
import { deliveringEngagement, type Engagement } from "~/schemas/task-file.schema";
import { listDeployedSpecialists } from "~/server/tasks/specialist-run.server";

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
  /** Conflicting paths — `conflict` only. */
  files?: string[];
  /** Ruling 134(c): origin's copy of the branch as it stood BEFORE the call. */
  remote?: RemoteBranchState["kind"];
  remoteHeadSha?: string | null;
  /** Ruling 132: the merge commit an `updated` refresh created. */
  mergeSha?: string;
  /** Ruling 133(b): conflict packets only — who the packet offered as the
   *  resolver: the deployed, repo-write delivering agent, or nobody. */
  resolver?: "deliverer" | "none";
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
        `Origin's copy of \`${branch}\` (\`${remote.headSha.slice(0, 7)}\`) is ${remote.commits} ` +
        `commit${remote.commits === 1 ? "" : "s"} behind the workspace head: call \`deliver_for_review\` ` +
        `to push it. Do not ask a person to push.`
      );
    case "diverged":
      return (
        `Origin's copy of \`${branch}\` (\`${remote.headSha.slice(0, 7)}\`) holds commits this workspace ` +
        `does not, so a plain push would be refused as non-fast-forward. A person resolves the ` +
        `branch history; do not force it.`
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
        outcome === "conflict"
          ? `Its workspace already has \`origin/${base}\` fetched: it merges and resolves ` +
            `the conflicting files, and the next delivery pushes the result.`
          : `Its workspace fetches origin's copy of \`${branch}\`, merges the history it does not ` +
            `have, and the next delivery pushes the result; nothing is forced.`,
      recommended: true,
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

/** One sentence per outcome, for the model AND the audit trail. */
function outcomeSentence(r: UpdateBranchResult): string {
  switch (r.status) {
    case "updated":
      return (
        `Brought \`${r.branch}\` up to date with \`${r.base}\` (${r.commits} commit${r.commits === 1 ? "" : "s"} ` +
        `merged in, merge commit \`${r.mergeSha.slice(0, 7)}\`; the push published it, so origin now ` +
        `carries the workspace head` +
        (r.remoteBefore.kind === "behind"
          ? `, including the ${r.remoteBefore.commits} workspace commit${r.remoteBefore.commits === 1 ? "" : "s"} origin was missing`
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
    case "update_failed":
      return `The branch was not updated: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`;
    default:
      return `The branch was not updated: ${r.reason}.`;
  }
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
  if (result.status === "conflict") details.files = result.files;
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
    // Ruling 132 (pass 34, F34-14), in three explicit steps. (A) Under the
    // file lock, record the refresh: the merge commit, the base tip, the base
    // name and the count. Without this row the reconciler has no way to tell
    // this merge from authored work, and it would report the base's commits as
    // unreviewed. (B) Reconcile, so `pr.revisionDrift` is re-measured NOW rather
    // than by the five-minute poll (the PR is open, so no divergence arm fires;
    // the reconcile may still notify watchers or wake the operator on an
    // out-of-band change, which is the same behaviour any pass has). (C) Re-read
    // and write the timeline event from the re-read, carrying the canonical drift
    // sentence; the tool message is built from that same re-read. The crash
    // window between the push and (A) is closed by the next classified pass,
    // which sees the merge commit without a row and counts it as authored:
    // honest, and self-healing once the row lands.
    await updateTaskFile(ref, (parsed) => {
      parsed.frontmatter.baseRefreshes.push({
        mergeSha: result.mergeSha,
        baseSha: result.baseSha,
        base: result.base,
        commits: result.commits,
        at: new Date().toISOString(),
      });
    });
    const reconcileCtx: GithubActionContext = { dataRoot: ctx.dataRoot };
    if (ctx.fetchImpl) reconcileCtx.fetchImpl = ctx.fetchImpl;
    const reconcile = await reconcileTask(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      OPERATOR_AUDIT_ACTOR,
      reconcileCtx,
    );
    const after = readTaskFile(ref)?.parsed.frontmatter ?? null;
    const drift = describeRevisionDrift(after?.pr?.revisionDrift);
    const measured =
      reconcile.status === "reconciled"
        ? after?.pr
          ? drift.kind === "none"
            ? `The review PR's head now equals the reviewed revision.`
            : `Drift re-measured: ${drift.sentence}.`
          : ""
        : `Drift could not be re-measured now (${reconcile.status}); the next GitHub pass will.`;
    const sentence = `${outcomeSentence(result)}${measured ? ` ${measured}` : ""}`;
    // A branch that moved must SAY it moved. The tool result is text the model
    // reads; the timeline is the record the humans read, and a base merge
    // changes what every reviewer is looking at.
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
    return { outcome: "noop", message: sentence };
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
        ),
      },
      authority,
    );
    return {
      outcome: "noop",
      message:
        `${outcomeSentence(result)} ` +
        (packet.outcome === "done"
          ? "Opened a blocking decision packet for a human to resolve — do not retry this yourself."
          : `A decision packet could NOT be opened (${packet.message}) — say so and ask a human to resolve the branch.`),
    };
  }

  return { outcome: "noop", message: outcomeSentence(result) };
}
