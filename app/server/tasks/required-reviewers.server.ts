import type {
  AgentDeployment,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import {
  activeWorkRevision,
  reviewSubjectId,
  type PrRef,
  type ReviewVerdict,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { deploymentRuntimeIdentity } from "~/server/agents/deployment-view.server";
import { readProjectFile } from "~/server/files/project-writer.server";

/**
 * Ruling 178 (pass 36, G36-3): the project-level REQUIRED-reviewer rule.
 *
 * Required-ness used to be emergent: `requiredReviewers(fm)` (task-file schema)
 * is the set of engaged, non-delivering, verdict-capable engagements, so a
 * reviewer gated a task only once the operator had engaged it there. Live, a
 * task whose operator never engaged the project's reviewer reached the
 * acceptance boundary with `validation: healthy` from whichever other
 * verdict-capable agent had run, and nothing named the reviewer the project
 * meant. `project.md` now declares "profile X reviews at stage Y" per review
 * stage, and ONE pure gate below is read by the acceptance refusal stack
 * (`acceptanceRefusalReasons`), the projection (`acceptanceBlockReason`, so
 * the review queue and the decisions inbox agree with the writers), the
 * operator snapshot and the controller.
 *
 * The task-level emergent set stays as it is: an engaged verdict-capable
 * agent is still required on that task. The project rule ADDS a reviewer the
 * task must hear from whether or not anyone engaged it.
 */

/** One rule resolved to the names its sentences print. `stageName` and
 *  `agentName` fall back to the raw ids, so a rule naming something since
 *  removed still reads (and is still refused by the writers). */
export interface RequiredReviewerView {
  stageId: string;
  stageName: string;
  profileId: string;
  agentName: string;
}

/** The display name a deployment resolves to — its own definition, else the
 *  org template it deploys, else the bare profile id. */
export function deployedAgentName(
  deployment: AgentDeployment | undefined,
  profileId: string,
  dataRoot?: string,
): string {
  if (!deployment) return profileId;
  const { def, template } = deploymentRuntimeIdentity(deployment, dataRoot);
  return def?.name ?? template?.name ?? profileId;
}

export function resolveRequiredReviewers(
  fm: Pick<ProjectFrontmatter, "requiredReviewers" | "stages" | "agents">,
  dataRoot?: string,
): RequiredReviewerView[] {
  return fm.requiredReviewers.map((rule) => ({
    stageId: rule.stageId,
    stageName: fm.stages.find((s) => s.id === rule.stageId)?.name ?? rule.stageId,
    profileId: rule.profileId,
    agentName: deployedAgentName(
      fm.agents.find((a) => a.profileId === rule.profileId),
      rule.profileId,
      dataRoot,
    ),
  }));
}

/** The rules as project.md holds them right now, resolved — the file is the
 *  truth the Policy and Settings pages read (the projected copy is what the
 *  rebuilder's task walk prints). Empty for an unreadable project. */
export function readRequiredReviewers(
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): RequiredReviewerView[] {
  const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  return file ? resolveRequiredReviewers(file.parsed.frontmatter, ctx.dataRoot) : [];
}

/** The review-relevant slice of a task the gate reads. */
export interface RequiredReviewerTaskState {
  workRevision: WorkRevision | null;
  verdicts: ReviewVerdict[];
  pr: PrRef | null;
  /**
   * Ruling 385 (F39-12(c)) / ruling 388: when a DELIVERER last saved files —
   * this task's non-commit delivery. It started life as a timeline scan the
   * callers threaded in; it is frontmatter now, because the same fact has to
   * identify what a verdict was given ON, which no reader can reconstruct from
   * a boolean.
   */
  deliveredAt?: string | null;
}

/**
 * Whether ONE rule's reviewer has approved the task's current work revision:
 * an `approve` verdict from that profile bound to the ACTIVE revision id
 * (revision-bound, like `currentVerdicts`; an approval of an older revision
 * is history, ruling 163).
 */
export function requiredReviewerApproved(
  rule: Pick<RequiredReviewerView, "profileId">,
  fm: Pick<RequiredReviewerTaskState, "workRevision" | "deliveredAt" | "verdicts">,
): boolean {
  // Ruling 388: the subject, not the revision. Keyed on `workRevision` alone
  // this returned false forever on a task whose deliverable is a saved file —
  // an approval could not be stored, so the gate ruling 385 added could never
  // be satisfied and force-accept was the only way out.
  const subject = reviewSubjectId(fm);
  if (!subject) return false;
  return fm.verdicts.some(
    (v) =>
      v.profileId === rule.profileId &&
      v.revisionId === subject &&
      v.result === "approve",
  );
}

/**
 * The gate: one refusal sentence per rule whose reviewer has no current
 * approval, in rule order.
 *
 * Ruling 385 (owner, 2026-09-22; F39-12(c)): the gate holds on DELIVERED WORK,
 * in whatever form the task delivered it — a work revision, a pull request, or
 * files a run saved. It used to hold on git alone, and ax-clone AX-12 walked
 * straight through: a standalone research task whose deliverable was a 27KB
 * report, attached, no commit and no PR, reached an enabled one-click Accept
 * with `verdicts: []` while the board's own rule said "Reviewer reviews at
 * Review". Any task whose deliverable is not a commit skipped its project's
 * required reviewer, silently.
 *
 * A task that produced NOTHING is still not held — that is ruling 161's case
 * (planning work, or a discarded revision), and there really is nothing to
 * judge.
 */
export function requiredReviewerRefusals(
  rules: readonly RequiredReviewerView[],
  fm: RequiredReviewerTaskState,
): string[] {
  if (rules.length === 0) return [];
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev && !fm.pr && !fm.deliveredAt) return [];
  const subject = rev
    ? `revision ${rev.headSha.slice(0, 7)}`
    : fm.pr?.headSha
      ? `revision ${fm.pr.headSha.slice(0, 7)}`
      : fm.pr
        ? `pull request #${fm.pr.number}`
        : // Ruling 385: no git subject at all — name what there IS to review.
          "the work delivered on this task";
  return rules
    .filter((rule) => !requiredReviewerApproved(rule, fm))
    .map(
      (rule) =>
        `Required reviewer ${rule.agentName} (project rule at ${rule.stageName}) has not approved ${subject}. ` +
        `Run the review at ${rule.stageName}, or an admin can force-accept.`,
    );
}

/**
 * Ruling 384 (F39-12): the acceptance card's opening clause, DERIVED.
 *
 * The card used to open with a fixed sentence — "The review is clean and the
 * work meets the goal" — on every acceptance offer the operator filed. Live on
 * ax-clone AX-12 that sentence sat on a task with `verdicts: []`,
 * `validation: none` and no reviewer ever engaged: the deliverer wrote a report,
 * the operator moved the task Design → Build → Verify → Review in three minutes
 * saying "advance to Review **for the required reviewer verdict**", and then,
 * on its next turn, offered a one-click acceptance asserting the review was
 * clean. The state that would have refuted it was on the file the whole time.
 *
 * So the clause says what the record holds, and nothing else: who approved the
 * revision being accepted, or that nobody did.
 */
export function acceptanceOfferBasis(
  fm: RequiredReviewerTaskState,
  rules: readonly RequiredReviewerView[],
): string {
  const rev = activeWorkRevision(fm.workRevision);
  const approvals = rev
    ? fm.verdicts.filter((v) => v.revisionId === rev.id && v.result === "approve")
    : [];
  if (approvals.length === 0) {
    // Named, because "no verdict" reads as an oversight and the reader needs to
    // know whether the project even asked for one.
    return rules.length > 0
      ? `No review verdict is recorded on this task, and the project requires ${rules
          .map((r) => r.agentName)
          .join(", ")} at ${rules.map((r) => r.stageName).join(", ")}.`
      : "No review verdict is recorded on this task.";
  }
  const names = approvals.map((v) => {
    const rule = rules.find((r) => r.profileId === v.profileId);
    return rule?.agentName ?? v.profileId;
  });
  return `${names.join(", ")} approved \`${rev!.headSha.slice(0, 7)}\`.`;
}
