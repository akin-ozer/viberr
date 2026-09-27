import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeTaskAttachment } from "~/server/files/task-attachments.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { operatorWriteCompletionPacket, resolveOperatorAuthority } from "./operator-actions.server";
import { completionView } from "./completion-packet.server";

/**
 * Ruling 521: the completion packet Operator writes before it offers a task
 * for acceptance, and the view the task page draws from it. The offer's
 * refusals are the operator suite's (`operatorAcceptCompletion`), the tool
 * doors the toolkit's and the plan executor's; this suite owns what the
 * writer accepts and stores, and what the page is told.
 */

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
/** The bytes are never read as an image; the name and the file are what count. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: [{ capabilityId: "completion-for-acceptance", mode: "recommend" }],
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: ["claude"],
          model: "sonnet",
          autonomy: "supervised",
        },
      },
    ],
  });
});

afterEach(() => ctx.cleanup());

/** VIB-1 at Review with revision `rev_1` delivered: 40 changed lines unless
 *  the patch says otherwise. */
function seed(patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      ownerUserId: store.users.arda.id,
      operator: { assignedAtStageId: "triage" },
      branch: "vib-1-work",
      workRevision: {
        id: "rev_1",
        headSha: SHA,
        treeSha: "t".repeat(40),
        branch: "vib-1-work",
        createdAt: "2026-09-27T09:00:00.000Z",
        sourceProfileId: "developer",
      },
      github: { commits: [], changed: { files: 2, add: 30, del: 10 } },
      ...patch,
    }),
    goal: "Attach one repository to a task.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function write(input: {
  summary?: string;
  changes?: string;
  screenshots?: { name: string; caption?: string }[];
}) {
  return operatorWriteCompletionPacket(
    store.db,
    { dataRoot: store.dataRoot },
    { projectSlug: store.slug, taskKey: "VIB-1", summary: "The attach flow works.", ...input },
    resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, { autonomy: "supervised" }),
  );
}

function attach(name: string): void {
  writeTaskAttachment(store.slug, "VIB-1", name, PNG, store.dataRoot);
}

const parsed = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;

describe("ruling 521: the operator writes the completion packet", () => {
  it("stores it in task.md for the revision under review, with the screenshots it named, and notes it on the timeline", async () => {
    // CANARY: bind the packet to the head sha alone (no `subject`) and a
    // revision re-delivered on the same head would keep an old summary.
    seed();
    attach("after.png");
    const result = await write({
      summary: "One repo per task; the branch is recorded before GitHub is touched.",
      screenshots: [{ name: "after.png", caption: "  The GitHub page with the repo attached  " }],
    });
    expect(result.outcome).toBe("done");
    expect(parsed().frontmatter.completionPacket).toEqual({
      subject: "rev_1",
      headSha: SHA,
      summary: "One repo per task; the branch is recorded before GitHub is touched.",
      changes: null,
      screenshots: [{ name: "after.png", caption: "The GitHub page with the repo attached" }],
      at: expect.any(String),
    });
    const note = parsed().timeline[0]!;
    expect(note).toMatchObject({ type: "note", actor: { kind: "operator" }, title: "Completion packet" });
    expect(note.text).toBe(
      "The operator summarized revision `aaaaaaa` for the person who accepts it, with 1 screenshot.",
    );
  });

  const refusals: [string, Partial<TaskFrontmatter>, Parameters<typeof write>[0], string][] = [
    [
      "nothing is delivered yet",
      { workRevision: null },
      {},
      "Nothing is delivered on VIB-1 yet.",
    ],
    [
      "a change over 200 lines comes without its summary",
      { github: { commits: [], changed: { files: 9, add: 180, del: 60 } } },
      {},
      "The change is 240 lines, more than 200, so the packet shows your summary of it instead of the whole diff: pass `changes`",
    ],
    [
      "a screenshot is not among the task's attachments",
      {},
      { screenshots: [{ name: "missing.png" }] },
      "`missing.png` is not among VIB-1's attachments. The images it has: `after.png`.",
    ],
    [
      "a screenshot is not an image",
      {},
      { screenshots: [{ name: "notes.txt" }] },
      "`notes.txt` is not an image (png, jpg, webp or gif).",
    ],
    [
      "more than six screenshots are named",
      {},
      { screenshots: ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ name: `${n}.png` })) },
      "Pick at most 6 screenshots: the ones that show the result.",
    ],
    [
      "the summary is empty",
      {},
      { summary: "   " },
      "The summary is empty: say what was done and why it meets the goal.",
    ],
  ];
  it.each(refusals)("refuses, and writes nothing, when %s", async (_label, patch, input, sentence) => {
    // CANARY: drop any one refusal and its row writes a packet.
    seed(patch);
    attach("after.png");
    const result = await write(input);
    expect(result.outcome).toBe("noop");
    expect(result.message).toContain(sentence);
    expect(parsed().frontmatter.completionPacket).toBeUndefined();
  });

  it("takes a change over 200 lines with Operator's summary of it", async () => {
    seed({ github: { commits: [], changed: { files: 9, add: 180, del: 60 } } });
    const result = await write({ changes: "- **Policy gate**: refuses a second repo." });
    expect(result.outcome).toBe("done");
    expect(parsed().frontmatter.completionPacket?.changes).toBe(
      "- **Policy gate**: refuses a second repo.",
    );
  });
});

describe("ruling 521: what the task page is told", () => {
  const nameOf = (id: string) => ({ reviewer: "Code Reviewer", qa: "QA" })[id] ?? id;
  const verdict = (
    profileId: string,
    revisionId: string,
    result: "approve" | "request_changes",
    at: string,
  ) => ({
    profileId,
    revisionId,
    headSha: revisionId === "rev_1" ? SHA : OLD_SHA,
    result,
    reason: `${profileId} on ${revisionId}`,
    at,
    rounds: 1,
  });

  it("reads each reviewer's verdict on the revision under review, and marks one on earlier work stale", () => {
    // CANARY: match verdicts by profile alone and the stale approval of
    // rev_0 reads as an approval of what is up for acceptance.
    seed({
      engagements: [
        { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
        { profileId: "qa", backend: "claude", role: "QA", delivers: false, verdictCapable: true },
      ],
      verdicts: [
        verdict("qa", "rev_0", "approve", "2026-09-27T08:00:00.000Z"),
        verdict("reviewer", "rev_1", "request_changes", "2026-09-27T09:30:00.000Z"),
        // Not engaged as a reviewer now, so it is listed after the required ones.
        verdict("security", "rev_1", "approve", "2026-09-27T09:40:00.000Z"),
      ],
    });
    const view = completionView(parsed().frontmatter, { canSee: () => true, nameOf, ruleReviewers: [] })!;
    expect(view.subjectSha).toBe("aaaaaaa");
    expect(view.change).toEqual({ files: 2, add: 30, del: 10, small: true });
    expect(view.verdicts).toEqual([
      {
        profileId: "reviewer",
        name: "Code Reviewer",
        result: "request_changes",
        reason: "reviewer on rev_1",
        at: "2026-09-27T09:30:00.000Z",
        required: true,
        earlier: null,
      },
      {
        profileId: "qa",
        name: "QA",
        result: "pending",
        reason: "",
        at: null,
        required: true,
        earlier: { result: "approve", sha: "bbbbbbb", at: "2026-09-27T08:00:00.000Z" },
      },
      {
        profileId: "security",
        name: "security",
        result: "approve",
        reason: "security on rev_1",
        at: "2026-09-27T09:40:00.000Z",
        required: false,
        earlier: null,
      },
    ]);
  });

  it("counts the reviewer a project rule requires as required, whether or not anyone engaged it", () => {
    // CANARY: leave `ruleReviewers` out of the required set and QA, which the
    // project requires and nobody engaged, is missing while acceptance waits
    // on its approval.
    seed({
      engagements: [
        { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
      ],
      verdicts: [verdict("reviewer", "rev_1", "approve", "2026-09-27T09:30:00.000Z")],
    });
    const view = completionView(parsed().frontmatter, {
      canSee: () => true,
      nameOf,
      ruleReviewers: ["qa", "reviewer"],
    })!;
    expect(view.verdicts.map((v) => [v.name, v.result, v.required])).toEqual([
      ["Code Reviewer", "approve", true],
      ["QA", "pending", true],
    ]);
  });

  it("shows only the screenshots the viewer may see, and says when the packet describes earlier work", async () => {
    // CANARY: pass the packet's screenshots through without `canSee` and a
    // viewer who may not see the attachments is handed their names.
    seed();
    attach("after.png");
    attach("before.png");
    await write({
      screenshots: [{ name: "after.png", caption: "After" }, { name: "before.png" }],
    });
    const fm = parsed().frontmatter;
    const member = completionView(fm, { canSee: (name) => name === "after.png", nameOf, ruleReviewers: [] })!;
    expect(member.packet).toMatchObject({
      summary: "The attach flow works.",
      screenshots: [{ name: "after.png", caption: "After" }],
      hiddenScreenshots: 1,
      staleFor: null,
    });
    expect(completionView(fm, { canSee: null, nameOf, ruleReviewers: [] })!.packet).toMatchObject({
      screenshots: [],
      hiddenScreenshots: 2,
    });
    // A new revision replaces the work the packet describes.
    const redelivered = {
      ...fm,
      workRevision: { ...fm.workRevision!, id: "rev_2", headSha: "c".repeat(40) },
    };
    expect(completionView(redelivered, { canSee: null, nameOf, ruleReviewers: [] })!.packet?.staleFor).toBe("aaaaaaa");
  });
});
