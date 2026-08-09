import type { DatabaseSync } from "node:sqlite";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  deliverGate,
  gate,
  operatorOpenPacket,
  type OperatorActionResult,
  type OperatorAuthority,
} from "~/server/tasks/operator-actions.server";
import {
  OPERATOR_AUDIT_ACTOR,
  type TaskMutationContext,
} from "~/server/tasks/task-actions.server";
import {
  updateWorkspaceBranchFromBase,
  type UpdateBranchResult,
} from "./update-branch.server";
import type { Exec } from "./push-workspace.server";

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
  if (!authority.deployed) return "deny";
  if (authority.policy.has(UPDATE_BRANCH_CAPABILITY)) {
    return gate(authority, UPDATE_BRANCH_CAPABILITY);
  }
  return deliverGate(authority);
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
function conflictOptions(branch: string, base: string) {
  return [
    {
      // `redirect` routes the decision back to the agent side (the resolver
      // re-engages the deliverer). This is the IN-PRODUCT resolution and it is
      // recommended for a reason: the base is now fetched into the delivering
      // engagement's own workspace, so it can merge `origin/<base>` and resolve
      // the files where it already has the context — without a second writer
      // touching the branch.
      kind: "redirect" as const,
      title: "Have the delivering agent resolve the conflict",
      detail:
        `Its workspace already has \`origin/${base}\` fetched — it merges and resolves ` +
        `the conflicting files, and the next delivery pushes the result.`,
      recommended: true,
      ev:
        `**Decision:** the delivering agent resolves the conflict between \`${branch}\` and ` +
        `\`${base}\` in its own workspace.`,
    },
    {
      kind: "custom" as const,
      title: `Resolve \`${branch}\` yourself`,
      detail: `Merge \`${base}\` into the branch by hand and push it.`,
      ev:
        `**Decision:** a person resolves \`${branch}\` against \`${base}\` directly. Viberr ` +
        `re-checks the branch on the operator's next turn and reports it up to date.`,
    },
    {
      kind: "archive_task" as const,
      title: "Archive the task — the work is superseded",
      detail: "Keeps the record and the branch; the task leaves the board.",
      ev: `**Decision:** archive the task rather than resolve \`${branch}\` against \`${base}\`.`,
    },
  ];
}

/** One sentence per outcome, for the model AND the audit trail. */
function outcomeSentence(r: UpdateBranchResult): string {
  switch (r.status) {
    case "updated":
      return `Brought \`${r.branch}\` up to date with \`${r.base}\` (${r.commits} commit${r.commits === 1 ? "" : "s"} merged in).`;
    case "already_current":
      return `\`${r.branch}\` is already up to date with \`${r.base}\` — nothing to do.`;
    case "conflict":
      return (
        `\`${r.branch}\` CONFLICTS with \`${r.base}\`` +
        (r.files.length ? ` in ${r.files.join(", ")}` : "") +
        `. The merge was aborted and the branch is untouched.`
      );
    case "push_conflict":
      return `The update could not be published: ${r.reason}.`;
    case "update_failed":
      return `The branch was not updated: ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`;
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
  ctx: TaskMutationContext,
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
  if (!readTaskFile(ref)) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }

  const result = await updateWorkspaceBranchFromBase({
    db,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {}),
    ...(input.exec ? { exec: input.exec } : {}),
  });
  recordAudit(db, {
    action: "github.branch_update.operator",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "branch",
    subjectId: "branch" in result ? result.branch : input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      status: result.status,
      ...(result.status === "updated" ? { commits: result.commits } : {}),
      ...(result.status === "conflict" ? { files: result.files } : {}),
    },
  });

  if (result.status === "updated") {
    // A branch that moved must SAY it moved. The tool result is text the model
    // reads; the timeline is the record the humans read, and a base merge
    // changes what every reviewer is looking at.
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: { kind: "operator" },
      title: null,
      text: outcomeSentence(result),
      toAgent: false,
      evidence: null,
    });
    rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    return { outcome: "done", message: outcomeSentence(result) };
  }

  if (result.status === "conflict" || result.status === "push_conflict") {
    const conflictFiles =
      result.status === "conflict" ? result.files : ([] as string[]);
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
          result.status === "conflict"
            ? `The task branch cannot be brought up to date automatically — the merge was aborted and the branch is exactly as it was. A person decides how this is resolved.`
            : `The remote branch holds commits this task's workspace does not, so the update was rolled back rather than forced. A person decides how this is resolved.`,
        observations: [
          { k: "Branch", v: result.branch, code: true },
          { k: "Base", v: result.base, code: true },
          ...(conflictFiles.length
            ? [{ k: "Conflicting files", v: conflictFiles.join(", "), code: true }]
            : []),
          ...(result.status === "conflict" && result.detail
            ? [{ k: "git", v: result.detail, code: true }]
            : []),
        ],
        options: conflictOptions(result.branch, result.base),
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
