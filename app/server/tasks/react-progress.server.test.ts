import { describe, expect, it } from "vitest";
import { DIVERGED_BRANCH_REMEDY, type WorkRevision } from "~/schemas/task-file.schema";
import { serverOutcomeSentence } from "~/shared/packet-server-outcome";
import {
  headMovedSince,
  reportExcerpt,
  STUCK_REPORT_EXCERPT_MAX,
} from "./react-progress.server";

/**
 * Ruling 489 (pass 40, F40-68): the react loop's progress signal is the work
 * revision the server writes, never the agent's prose. The completion tests in
 * `agent-completion.server.test.ts` drive the loop end to end; these pin the
 * reading itself, one arm at a time.
 */

/** The hop's start: the finished run's row was created then. */
const HOP = "2026-09-25T13:55:00.000Z";
const DURING = "2026-09-25T13:55:40.000Z";
const BEFORE = "2026-09-25T13:10:00.000Z";
const HEAD = "c".repeat(40);

function revision(patch: Partial<WorkRevision> = {}): WorkRevision {
  return {
    id: "rev_1",
    headSha: HEAD,
    treeSha: null,
    branch: "web-8",
    createdAt: BEFORE,
    sourceProfileId: "site-engineer",
    kind: "delivered",
    ...patch,
  };
}

describe("ruling 489: headMovedSince reads the revision the server wrote", () => {
  it("a revision minted during the hop is a committed head, whatever its file says of its kind", () => {
    // CANARY: drop the committed arm and the WEB-8 rework reads as no progress.
    expect(headMovedSince(revision({ createdAt: DURING }), HOP)).toEqual({
      sha: HEAD,
      how: "committed",
    });
    // A pre-pass-19 revision carries no kind and is a delivered one.
    const unkinded: WorkRevision = {
      id: "rev_0",
      headSha: HEAD,
      treeSha: null,
      branch: "web-8",
      createdAt: DURING,
      sourceProfileId: "site-engineer",
    };
    expect(headMovedSince(unkinded, HOP)?.how).toBe("committed");
  });

  it("an older revision a delivery pushed during the hop is a delivered head", () => {
    // CANARY: drop the `pushedAt` arm and a head the operator delivered mid-hop
    // is not progress.
    expect(headMovedSince(revision({ pushedAt: DURING }), HOP)).toEqual({
      sha: HEAD,
      how: "delivered",
    });
  });

  it("nothing moved: an older revision, pushed before the hop or never, no revision, no known start", () => {
    // CANARY: drop the `since` comparison on either arm and a chain whose
    // head stood still is reset on every hop — a loop that is never capped.
    expect(headMovedSince(revision(), HOP)).toBeNull();
    expect(headMovedSince(revision({ pushedAt: BEFORE }), HOP)).toBeNull();
    expect(headMovedSince(null, HOP)).toBeNull();
    expect(headMovedSince(revision({ createdAt: DURING }), null)).toBeNull();
  });

  it("not the chain's progress: a stranger's head, a verification of the base, a discarded draft", () => {
    // CANARY: count any revision kind as committed and a stranger's push onto
    // the pull request extends the agents' loop.
    expect(headMovedSince(revision({ kind: "external", createdAt: DURING }), HOP)).toBeNull();
    expect(headMovedSince(revision({ kind: "verified", createdAt: DURING }), HOP)).toBeNull();
    expect(headMovedSince(revision({ kind: "discarded", createdAt: DURING }), HOP)).toBeNull();
  });
});

describe("ruling 489: the operator reads what the delivery option did, in Viberr's words", () => {
  it("names the PR and the head, or the delivery's own refusal", () => {
    // CANARY: drop the delivery arm of `serverOutcomeSentence` and the
    // operator's packet-resolved turn states nothing about the delivery.
    expect(
      serverOutcomeSentence({
        kind: "deliver_for_review",
        outcome: "delivered",
        prNumber: 7,
        headSha: HEAD,
      }),
    ).toBe("the delivery ran: PR #7 now carries the head `ccccccc`, and the reviewers judge that revision.");
    expect(
      serverOutcomeSentence({ kind: "deliver_for_review", outcome: "current", prNumber: 7, headSha: HEAD }),
    ).toBe("the delivery found PR #7 already carrying the head `ccccccc`; nothing needed pushing.");
    expect(
      serverOutcomeSentence({
        kind: "deliver_for_review",
        outcome: "failed",
        reason: "the remote branch diverged",
      }),
    ).toBe("the delivery did not complete (the remote branch diverged); nothing reached the review PR.");
  });

  it("a diverged own PR gets ruling 321's one remedy sentence", () => {
    expect(
      serverOutcomeSentence({ kind: "resolve_remote_collision", outcome: "own_pr_diverged", prNumber: 5 }),
    ).toContain(DIVERGED_BRANCH_REMEDY);
  });
});

describe("ruling 489: the capped packet quotes the report's first paragraph", () => {
  it("drops heading marks and the dispatch cc line, and stops at the first blank line", () => {
    // CANARY: quote the whole reply and the second paragraph lands on the card.
    expect(
      reportExcerpt(
        "## Rework done\non `178dc22`: main merged in.\ncc @Akin @operator\n\nFinding 1 …",
      ),
    ).toBe("Rework done on `178dc22`: main merged in.");
    expect(reportExcerpt("")).toBeNull();
    expect(reportExcerpt(null)).toBeNull();
  });

  it("caps a long first paragraph with an ellipsis", () => {
    // CANARY: drop the cap and a 2,000-character paragraph fills the body.
    const long = "word ".repeat(400).trim();
    const excerpt = reportExcerpt(long)!;
    expect(excerpt.length).toBe(STUCK_REPORT_EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
