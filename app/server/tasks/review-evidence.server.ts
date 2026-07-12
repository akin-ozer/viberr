import { createHash } from "node:crypto";
import type { ParsedTaskFile } from "~/schemas/task-file.schema";

/**
 * The immutable evidence identity a reviewer approved. Deliberately excludes
 * mutable workflow fields (validation, stage and PR state): accepting a
 * completion may change those fields without changing the code/goal that was
 * reviewed. Any goal, repository, branch, PR or head evidence change produces
 * a different token and makes the old verdict unusable.
 */
export function reviewEvidenceFingerprint(
  task: Pick<ParsedTaskFile, "goal" | "frontmatter">,
  projectRepo: string | null,
): string {
  const fm = task.frontmatter;
  const commits = fm.github?.commits.map((commit) => commit.sha) ?? [];
  const evidence = {
    goal: task.goal.trim(),
    repo: fm.repo ?? projectRepo,
    branch: fm.branch,
    prNumber: fm.pr?.number ?? null,
    headSha: fm.pr?.headSha ?? commits[0] ?? null,
    commits,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export function clearReviewEvidence(
  task: Pick<ParsedTaskFile, "frontmatter">,
  reviewStageId: string | null,
): boolean {
  const fm = task.frontmatter;
  let changed = fm.reviewerVerdicts.length > 0;
  fm.reviewerVerdicts = [];
  if (
    reviewStageId &&
    fm.stage === reviewStageId &&
    fm.validation !== "failing"
  ) {
    changed = changed || fm.validation !== "changed";
    fm.validation = "changed";
  }
  return changed;
}
