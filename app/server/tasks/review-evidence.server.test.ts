import { describe, expect, it } from "vitest";
import { baseTaskFrontmatter } from "../../../test-support/test-store";
import {
  clearReviewEvidence,
  hasCurrentHumanValidation,
  repositoryReviewEvidenceReady,
  reviewEvidenceFingerprint,
  verifiedReviewHeadSha,
} from "./review-evidence.server";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function evidenceTask() {
  return {
    goal: "Ship the reviewed behavior.",
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      validation: "healthy",
      branch: "codex/vib-1",
      pr: {
        number: 42,
        state: "review",
        title: "Reviewed PR",
        headSha: HEAD_A,
      },
      github: {
        commits: [{ sha: HEAD_A, msg: "[VIB-1] implementation" }],
        changed: { files: 1, add: 10, del: 2 },
      },
    }),
  };
}

describe("review evidence fingerprint", () => {
  it("tracks goal, repository, branch, PR and head evidence", () => {
    const task = evidenceTask();
    const original = reviewEvidenceFingerprint(task, "akin-ozer/viberr");

    for (const mutate of [
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.goal = "A changed acceptance goal.";
      },
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.frontmatter.repo = "akin-ozer/other";
      },
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.frontmatter.branch = "codex/vib-1-v2";
      },
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.frontmatter.pr = { ...copy.frontmatter.pr!, number: 43 };
      },
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.frontmatter.pr = { ...copy.frontmatter.pr!, headSha: HEAD_B };
      },
      (copy: ReturnType<typeof evidenceTask>) => {
        copy.frontmatter.reviewRevision += 1;
      },
    ]) {
      const copy = structuredClone(task);
      mutate(copy);
      expect(reviewEvidenceFingerprint(copy, "akin-ozer/viberr")).not.toBe(
        original,
      );
    }
  });

  it("ignores workflow state while preserving the reviewed evidence identity", () => {
    const task = evidenceTask();
    const original = reviewEvidenceFingerprint(task, "akin-ozer/viberr");
    task.frontmatter.stage = "done";
    task.frontmatter.validation = "changed";
    task.frontmatter.pr = { ...task.frontmatter.pr!, state: "merged" };
    task.frontmatter.updatedAt = "2030-01-01T00:00:00.000Z";
    expect(reviewEvidenceFingerprint(task, "akin-ozer/viberr")).toBe(original);
  });

  it("ignores mutable commit-cache reshaping when a full verified head exists", () => {
    const task = evidenceTask();
    const original = reviewEvidenceFingerprint(task, "akin-ozer/viberr");
    task.frontmatter.github = {
      commits: [
        { sha: "fffffff", msg: "unrelated projection entry" },
        { sha: "1111111", msg: "a reordered projection entry" },
      ],
      changed: { files: 99, add: 1000, del: 500 },
    };
    expect(reviewEvidenceFingerprint(task, "akin-ozer/viberr")).toBe(original);
  });

  it("requires a full verified head before repository review is complete", () => {
    const task = evidenceTask();
    expect(verifiedReviewHeadSha(task)).toBe(HEAD_A);
    expect(repositoryReviewEvidenceReady(task, "akin-ozer/viberr")).toBe(true);

    task.frontmatter.repo = "akin-ozer/viberr";
    task.frontmatter.pr = { ...task.frontmatter.pr!, headSha: "abcdef0" };
    expect(verifiedReviewHeadSha(task)).toBeNull();
    expect(repositoryReviewEvidenceReady(task, "akin-ozer/viberr")).toBe(false);
    expect(repositoryReviewEvidenceReady(task, null)).toBe(false);

    task.frontmatter.repo = null;
    expect(repositoryReviewEvidenceReady(task, null)).toBe(true);
  });

  it("clears verdicts and makes a healthy Review task require fresh review", () => {
    const task = evidenceTask();
    task.frontmatter.reviewerVerdicts = [
      {
        profileId: "reviewer",
        verdict: "approve",
        summary: "Approved.",
        runId: "run-review",
        reviewedAt: "2026-07-13T00:00:00.000Z",
        evidenceFingerprint: reviewEvidenceFingerprint(
          task,
          "akin-ozer/viberr",
        ),
      },
    ];
    task.frontmatter.humanValidation = {
      userId: "u_validator",
      validatedAt: "2026-07-13T00:00:00.000Z",
      evidenceFingerprint: reviewEvidenceFingerprint(
        task,
        "akin-ozer/viberr",
      ),
    };
    task.frontmatter.pr = { ...task.frontmatter.pr!, state: "accepted" };
    expect(hasCurrentHumanValidation(task, "akin-ozer/viberr")).toBe(true);
    expect(clearReviewEvidence(task, "review")).toBe(true);
    expect(task.frontmatter.reviewerVerdicts).toEqual([]);
    expect(task.frontmatter.humanValidation).toBeNull();
    expect(task.frontmatter.validation).toBe("changed");
    expect(task.frontmatter.pr?.state).toBe("review");
    expect(hasCurrentHumanValidation(task, "akin-ozer/viberr")).toBe(false);
  });
});
