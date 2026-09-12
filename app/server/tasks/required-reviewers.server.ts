import type {
  AgentDeployment,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import {
  activeWorkRevision,
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
}

/**
 * Whether ONE rule's reviewer has approved the task's current work revision:
 * an `approve` verdict from that profile bound to the ACTIVE revision id
 * (revision-bound, like `currentVerdicts`; an approval of an older revision
 * is history, ruling 163).
 */
export function requiredReviewerApproved(
  rule: Pick<RequiredReviewerView, "profileId">,
  fm: Pick<RequiredReviewerTaskState, "workRevision" | "verdicts">,
): boolean {
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev) return false;
  return fm.verdicts.some(
    (v) =>
      v.profileId === rule.profileId &&
      v.revisionId === rev.id &&
      v.result === "approve",
  );
}

/**
 * The gate: one refusal sentence per rule whose reviewer has no current
 * approval, in rule order. A task with no active work revision and no pull
 * request (planning work, or a discarded revision — ruling 161) is not held:
 * there is nothing for the reviewer to judge.
 */
export function requiredReviewerRefusals(
  rules: readonly RequiredReviewerView[],
  fm: RequiredReviewerTaskState,
): string[] {
  if (rules.length === 0) return [];
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev && !fm.pr) return [];
  const subject = rev
    ? `revision ${rev.headSha.slice(0, 7)}`
    : fm.pr?.headSha
      ? `revision ${fm.pr.headSha.slice(0, 7)}`
      : `pull request #${fm.pr?.number ?? "?"}`;
  return rules
    .filter((rule) => !requiredReviewerApproved(rule, fm))
    .map(
      (rule) =>
        `Required reviewer ${rule.agentName} (project rule at ${rule.stageName}) has not approved ${subject}. ` +
        `Run the review at ${rule.stageName}, or an admin can force-accept.`,
    );
}
