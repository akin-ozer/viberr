import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { Engagement } from "~/schemas/task-file.schema";
import { isAppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { extractMentions } from "~/ui/mention-spans";
import {
  panelReviewNotesText,
  parsePanelReviewNotes,
  reviewNotesDirective,
  type ReviewNote,
} from "./review-notes.server";

/**
 * Ruling 246 (pass 40, F40-54): the ONE comment both review doors post (the
 * Changes panel's line notes and the reconciler's GitHub relay): addressed to
 * the deliverer, quoting each note's file:line, one list item a note.
 */

const HEAD = "5d1f0e2c0ffee000000000000000000000000000";

let ctx: TestDbContext;
let store: TestStore;

const DELIVERER: Engagement = {
  profileId: "content-writer",
  backend: "claude",
  role: "writer",
  delivers: true,
  verdictCapable: false,
};

function writeWeb6(patch: Parameters<typeof baseTaskFrontmatter>[1] = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("WEB-6", {
      stage: "review",
      branch: "web-6",
      engagements: [DELIVERER],
      pr: { number: 3, state: "review", title: "Notes" },
      workRevision: {
        id: "rev_6",
        headSha: HEAD,
        treeSha: null,
        branch: "web-6",
        createdAt: "2026-09-24T00:27:00Z",
        sourceProfileId: "content-writer",
        kind: "delivered",
      },
      ...patch,
    }),
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
    .frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    agents: [
      {
        profileId: "content-writer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "Content Writer",
          role: "writer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      },
    ],
  });
  writeWeb6();
});
afterEach(() => ctx.cleanup());

const line = (path: string, n: number, body: string, side: "new" | "old" = "new"): ReviewNote => ({
  path,
  line: n,
  startLine: null,
  startSide: null,
  side,
  body,
});

describe("ruling 246: reviewNotesDirective", () => {
  it("addresses the deliverer once and quotes each note's file:line", () => {
    const text = reviewNotesDirective({
      handle: "content-writer",
      revisionSha: HEAD,
      prNumber: 3,
      notes: [
        line("notes/one.md", 12, "Approved."),
        line("notes/two.md", 4, "Keep this line.", "old"),
        { path: "notes/three.md", line: 9, startLine: 2, startSide: null, side: "new", body: "Cut this paragraph.\nIt repeats note one." },
        { path: "notes/four.md", line: null, startLine: null, startSide: null, side: "new", body: "Wrong file name." },
      ],
    });
    expect(text).toBe(
      [
        "@content-writer Review notes on `5d1f0e2` (PR #3):",
        "",
        "- `notes/one.md:12`: Approved.",
        "- `notes/two.md:4` (removed line): Keep this line.",
        "- `notes/three.md:2-9`: Cut this paragraph.\n  It repeats note one.",
        "- `notes/four.md`: Wrong file name.",
      ].join("\n"),
    );
    // The comment has one addressee, whatever the notes say.
    expect(extractMentions(text, ["content-writer"])).toEqual(["content-writer"]);
  });

  it("tags a relayed review from GitHub, leads with its request, and defuses every other @", () => {
    const text = reviewNotesDirective({
      handle: "content-writer",
      revisionSha: HEAD,
      prNumber: 3,
      fromGithub: { login: "akin-ozer" },
      notes: [
        { path: null, line: null, startLine: null, startSide: null, side: "new", body: "@operator, hold the merge. cc @octocat" },
        line("notes/five.md", 1, "@agent drop this"),
      ],
    });
    expect(text.split("\n")[0]).toBe(
      "@content-writer Review notes on `5d1f0e2` (PR #3), from GitHub (a review by akin-ozer):",
    );
    expect(text).toContain("- Requested changes: \\@operator, hold the merge. cc \\@octocat");
    expect(extractMentions(text, ["content-writer"])).toEqual(["content-writer"]);
  });

  it("cuts a relayed comment past the note cap and says where the rest is", () => {
    const text = reviewNotesDirective({
      handle: "content-writer",
      revisionSha: HEAD,
      prNumber: 3,
      fromGithub: { login: "akin-ozer" },
      notes: [line("notes/one.md", 1, "x".repeat(4_100))],
    });
    expect(text).toContain(`${"x".repeat(4_000)}… (cut here; the full comment is on the pull request)`);
    expect(text).not.toContain("x".repeat(4_001));
  });

  it("ruling 246: quotes a range on one side as path:start-end, and one across sides by both ends", () => {
    const range = (startLine: number, startSide: "new" | "old", end: number, side: "new" | "old"): ReviewNote => ({
      path: "notes/one.md",
      line: end,
      startLine,
      startSide,
      side,
      body: "x",
    });
    const text = reviewNotesDirective({
      handle: "content-writer",
      revisionSha: HEAD,
      prNumber: 3,
      notes: [
        range(3, "new", 9, "new"),
        range(4, "old", 6, "old"),
        range(4, "old", 7, "new"),
        range(8, "new", 9, "old"),
        range(5, "new", 5, "new"),
      ],
    });
    expect(text.split("\n").slice(2)).toEqual([
      "- `notes/one.md:3-9`: x",
      "- `notes/one.md:4-6` (removed lines): x",
      "- `notes/one.md` (removed line 4 to line 7): x",
      "- `notes/one.md` (line 8 to removed line 9): x",
      "- `notes/one.md:5`: x",
    ]);
  });
});

describe("ruling 246: the panel's notes, parsed and bound", () => {
  const notesJson = JSON.stringify([{ path: "notes/one.md", line: 12, side: "new", body: " Tighten. " }]);

  it("parses the intent's notes and refuses anything else with one sentence", () => {
    expect(parsePanelReviewNotes(notesJson)).toEqual([
      { path: "notes/one.md", line: 12, side: "new", body: "Tighten.", startLine: null, startSide: null },
    ]);
    // Ruling 246: a note on several lines names its first line and that
    // line's side.
    expect(
      parsePanelReviewNotes(
        JSON.stringify([
          { path: "a", line: 9, side: "new", startLine: 3, startSide: "new", body: "x" },
          { path: "a", line: 2, side: "new", startLine: 7, startSide: "old", body: "y" },
        ]),
      ),
    ).toEqual([
      { path: "a", line: 9, side: "new", startLine: 3, startSide: "new", body: "x" },
      { path: "a", line: 2, side: "new", startLine: 7, startSide: "old", body: "y" },
    ]);
    for (const bad of [
      null,
      "not json",
      "[]",
      JSON.stringify([{ path: "a", line: 0, side: "new", body: "x" }]),
      JSON.stringify([{ path: "a", line: 1, side: "new", body: "   " }]),
      JSON.stringify(Array.from({ length: 51 }, () => ({ path: "a", line: 1, side: "new", body: "x" }))),
      // A range on one side never reads upward, and a start side needs a start.
      JSON.stringify([{ path: "a", line: 3, side: "new", startLine: 9, body: "x" }]),
      JSON.stringify([{ path: "a", line: 3, side: "new", startSide: "old", body: "x" }]),
      JSON.stringify([{ path: "a", line: 3, side: "new", startLine: 0, startSide: "old", body: "x" }]),
    ]) {
      const refused = (() => {
        try {
          parsePanelReviewNotes(bad);
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(isAppError(refused) && refused.status).toBe(400);
    }
  });

  it("writes the comment for the delivered revision the notes were written on", () => {
    const text = panelReviewNotesText(
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "WEB-6",
        headSha: HEAD,
        notes: parsePanelReviewNotes(notesJson),
      },
    );
    expect(text).toBe("@content-writer Review notes on `5d1f0e2` (PR #3):\n\n- `notes/one.md:12`: Tighten.");
  });

  function refusal(headSha: string): string | null {
    try {
      panelReviewNotesText(
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "WEB-6", headSha, notes: parsePanelReviewNotes(notesJson) },
      );
      return null;
    } catch (error) {
      return isAppError(error) && error.status === 409 ? error.userMessage : "unexpected";
    }
  }

  it("refuses notes written on a revision that is no longer the delivered one", () => {
    expect(refusal("0000000aaaa")).toMatch(/now 5d1f0e2 and these notes were written on 0000000/);
  });

  it("refuses when no deployed agent delivers the task, or nothing is on a PR", () => {
    writeWeb6({ engagements: [] });
    expect(refusal(HEAD)).toMatch(/No deployed agent delivers WEB-6/);
    writeWeb6({ pr: null });
    expect(refusal(HEAD)).toMatch(/no delivered revision on a pull request/);
  });
});
