import type {
  AgentDeployment,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import {
  activeWorkRevision,
  reviewSubjectId,
  type Engagement,
  type PrRef,
  type ReviewVerdict,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { deploymentRuntimeIdentity } from "~/server/agents/deployment-view.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { stageName } from "~/shared/workflow/stage-roles";

/**
 * Ruling 89 (pass 36, G36-3): the project-level REQUIRED-reviewer rule.
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
function deployedAgentName(
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
    stageName: stageName(fm.stages, rule.stageId),
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
   * Ruling 81 (F39-12(c)) / ruling 84: when a DELIVERER last saved files —
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
 * is history, ruling 90).
 */
function requiredReviewerApproved(
  rule: Pick<RequiredReviewerView, "profileId">,
  fm: Pick<RequiredReviewerTaskState, "workRevision" | "deliveredAt" | "verdicts">,
): boolean {
  // Ruling 84: the subject, not the revision. Keyed on `workRevision` alone
  // this returned false forever on a task whose deliverable is a saved file —
  // an approval could not be stored, so the gate ruling 81 added could never
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
 * Ruling 81 (owner, 2026-09-22; F39-12(c)): the gate holds on DELIVERED WORK,
 * in whatever form the task delivered it — a work revision, a pull request, or
 * files a run saved. It used to hold on git alone, and ax-clone AX-12 walked
 * straight through: a standalone research task whose deliverable was a 27KB
 * report, attached, no commit and no PR, reached an enabled one-click Accept
 * with `verdicts: []` while the board's own rule said "Reviewer reviews at
 * Review". Any task whose deliverable is not a commit skipped its project's
 * required reviewer, silently.
 *
 * A task that produced NOTHING is still not held — that is ruling 234's case
 * (planning work, or a discarded revision), and there really is nothing to
 * judge.
 */
export function requiredReviewerRefusals(
  rules: readonly RequiredReviewerView[],
  fm: RequiredReviewerTaskState & {
    engagements: readonly Pick<Engagement, "profileId" | "delivers">[];
  },
  /** Ruling 89: who made the review subject ({@link reviewSubjectAuthor}),
   *  whose own verdict never binds to it. */
  subjectAuthor: string | null,
): string[] {
  if (rules.length === 0) return [];
  // Ruling 89: a rule whose reviewer is this task's deliverer can never be
  // met, whatever has been delivered, and "run the review" sends the operator
  // into a loop of delivering runs; nor is such a task one that has "nothing
  // to judge", since its deliverer's work is what no review will judge.
  const deliverer = fm.engagements.find((e) => e.delivers)?.profileId ?? null;
  const asDeliverer = rules
    .filter((rule) => rule.profileId === deliverer)
    .map(
      (rule) =>
        `Required reviewer ${rule.agentName} (project rule at ${rule.stageName}) is this task's deliverer, ` +
        `so its review cannot count. Hand delivery to another agent, have that agent deliver, and run ` +
        `${rule.agentName}'s review, or an admin can force-accept.`,
    );
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev && !fm.pr && !fm.deliveredAt) return asDeliverer;
  const subject = rev
    ? `revision ${rev.headSha.slice(0, 7)}`
    : fm.pr?.headSha
      ? `revision ${fm.pr.headSha.slice(0, 7)}`
      : fm.pr
        ? `pull request #${fm.pr.number}`
        : // Ruling 81: no git subject at all — name what there IS to review.
          "the work delivered on this task";
  // Ruling 89: nor one whose reviewer MADE what is delivered: delivery handed
  // to another agent that has saved nothing yet leaves the reviewer's own work
  // as the subject, and its review of that can never count either.
  const asAuthor = rules
    .filter((rule) => rule.profileId !== deliverer && rule.profileId === subjectAuthor)
    .map(
      (rule) =>
        `Required reviewer ${rule.agentName} (project rule at ${rule.stageName}) made ${subject}, ` +
        `so its review of it cannot count. Have another agent deliver its own work, then run ` +
        `${rule.agentName}'s review, or an admin can force-accept.`,
    );
  return [
    ...asDeliverer,
    ...asAuthor,
    ...rules
      .filter(
        (rule) =>
          rule.profileId !== deliverer && rule.profileId !== subjectAuthor && !requiredReviewerApproved(rule, fm),
      )
      .map(
        (rule) =>
          `Required reviewer ${rule.agentName} (project rule at ${rule.stageName}) has not approved ${subject}. ` +
          `Run the review at ${rule.stageName}, or an admin can force-accept.`,
      ),
  ];
}

const LIST_AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Ruling 89: the refusal when an agent the project requires as a reviewer is
 * asked to deliver a task. Its verdict on its own delivery does not count
 * (ruling 87), so the task could never pass the stage the rule holds it at.
 * Live on AWSC-3 the operator made the Estimate Judge the benchmark's
 * deliverer on a board whose rule is "Estimate Judge reviews at Review".
 */
export function requiredReviewerDeliversRefusal(
  agentName: string,
  taskKey: string,
  rules: readonly RequiredReviewerView[],
): string {
  const stages = LIST_AND.format(rules.map((r) => r.stageName));
  return (
    `${agentName} is this project's required reviewer at ${stages}, so it cannot deliver ${taskKey}: ` +
    `its verdict on its own delivery would not count, and ${taskKey} could never pass ${stages}. ` +
    `Have another agent deliver it and run ${agentName}'s review on what that agent delivers, or change ` +
    `Settings → Required reviewers.`
  );
}

/**
 * Ruling 99 (F39-12): the acceptance card's opening clause, DERIVED.
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
  // Ruling 84: the subject, not the revision, the same one the verdict
  // writer and the gate read. Keyed on the revision alone, a task whose
  // deliverable is a saved file was told "No review verdict is recorded" over
  // the approval its reviewer had just given.
  const subject = reviewSubjectId(fm);
  const approvals = subject
    ? fm.verdicts.filter((v) => v.revisionId === subject && v.result === "approve")
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
  return rev
    ? `${names.join(", ")} approved \`${rev.headSha.slice(0, 7)}\`.`
    : `${names.join(", ")} approved the files delivered on this task.`;
}
