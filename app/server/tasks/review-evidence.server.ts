import { createHash } from "node:crypto";
import type { ParsedTaskFile } from "~/schemas/task-file.schema";
import { normalizeFullGitSha } from "~/server/github/head-sha.server";

function effectiveRepo(
  task: Pick<ParsedTaskFile, "frontmatter">,
  projectRepo: string | null,
): string | null {
  const repo = task.frontmatter.repo ?? projectRepo;
  return repo?.trim().toLowerCase() || null;
}

/** The full, verified PR head that repository review and merge are pinned to. */
export function verifiedReviewHeadSha(
  task: Pick<ParsedTaskFile, "frontmatter">,
): string | null {
  return normalizeFullGitSha(task.frontmatter.pr?.headSha);
}

/** Repository-backed review is incomplete until Viberr knows the full PR head. */
export function repositoryReviewEvidenceReady(
  task: Pick<ParsedTaskFile, "frontmatter">,
  projectRepo: string | null,
): boolean {
  return effectiveRepo(task, projectRepo) === null || verifiedReviewHeadSha(task) !== null;
}

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
  const headSha = verifiedReviewHeadSha(task);
  // Commits are a degraded fallback for genuinely PR-less evidence. Once a
  // verified head exists it alone identifies the reviewed Git history; mutable
  // projection ordering/filtering must never revoke an otherwise-current review.
  const commits = headSha
    ? []
    : [
        ...new Set(
          (fm.github?.commits ?? [])
            .map((commit) => commit.sha.trim().toLowerCase())
            .filter(Boolean),
        ),
      ].sort();
  const evidence = {
    goal: task.goal.trim(),
    repo: effectiveRepo(task, projectRepo),
    branch: fm.branch?.trim() ?? null,
    prNumber: fm.pr?.number ?? null,
    headSha,
    baseRepo: fm.pr?.baseRepo?.trim().toLowerCase() ?? null,
    baseRef: fm.pr?.baseRef?.trim() ?? null,
    commits,
    reviewRevision: fm.reviewRevision,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/** A zero-reviewer task may be validated by an authorized human owner/admin,
 * but that validation is evidence, not acceptance. It is usable only for the
 * exact review revision and delivery fingerprint the human inspected. */
export function hasCurrentHumanValidation(
  task: Pick<ParsedTaskFile, "goal" | "frontmatter">,
  projectRepo: string | null,
): boolean {
  const validation = task.frontmatter.humanValidation;
  return (
    validation !== null &&
    validation.evidenceFingerprint ===
      reviewEvidenceFingerprint(task, projectRepo)
  );
}

export function clearReviewEvidence(
  task: Pick<ParsedTaskFile, "frontmatter">,
  reviewStageId: string | null,
): boolean {
  const fm = task.frontmatter;
  let changed = fm.reviewerVerdicts.length > 0 || fm.humanValidation !== null;
  fm.reviewerVerdicts = [];
  fm.humanValidation = null;
  // Merge-pending acceptance belongs to the evidence that was accepted. When
  // that evidence changes, the human must validate and accept the new evidence
  // as two fresh actions; an old acceptance must never carry forward.
  if (fm.pr?.state === "accepted") {
    fm.pr = { ...fm.pr, state: "review" };
    changed = true;
  }
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
