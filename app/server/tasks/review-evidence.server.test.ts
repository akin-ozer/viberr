import { describe, expect, it } from "vitest";
import { baseTaskFrontmatter } from "../../../test-support/test-store";
import {
  clearReviewEvidence,
  reviewEvidenceFingerprint,
} from "./review-evidence.server";

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
        headSha: "head-a",
      },
      github: {
        commits: [{ sha: "head-a", msg: "[VIB-1] implementation" }],
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
        copy.frontmatter.pr = { ...copy.frontmatter.pr!, headSha: "head-b" };
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
    expect(clearReviewEvidence(task, "review")).toBe(true);
    expect(task.frontmatter.reviewerVerdicts).toEqual([]);
    expect(task.frontmatter.validation).toBe("changed");
  });
});
