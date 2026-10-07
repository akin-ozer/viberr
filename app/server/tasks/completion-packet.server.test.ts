import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { keepDelivery } from "~/server/files/kept-deliveries.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeTaskAttachment } from "~/server/files/task-attachments.server";
import { readTaskSources, recordDeliverySources, writeTaskSource } from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { operatorWriteCompletionPacket } from "./operator-moves.server";
import { resolveOperatorAuthority } from "./operator-authority.server";
import {
  completionPacketFact,
  completionPacketText,
  completionView,
  sourcesRestedOn,
} from "./completion-packet.server";

/**
 * Ruling 521: the completion packet Operator writes before it offers a task
 * for acceptance, and the view the task page draws from it. The offer's
 * refusals are the operator suite's (`operatorAcceptCompletion`), the tool
 * doors the toolkit's and the plan executor's; this suite owns what the
 * writer accepts and stores, and what the page is told. Ruling 668: and the
 * notes and result files that make the packet the task's result.
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
  considerations?: string;
  assumptions?: string;
  gaps?: string;
  files?: { name: string; caption?: string }[];
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
      considerations: null,
      assumptions: null,
      gaps: null,
      files: [],
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

describe("ruling 668: the packet names the result of a task delivered as files", () => {
  const STAMP = "2026-10-06T08:30:52.847Z";
  const DELIVERED = ["estimate.json", "inventory.csv", "summary.md"];

  /** VIB-1 delivered as files at `STAMP`, the delivery kept as it stood
   *  (ruling 597), and one more file saved on the task after it. */
  function seedFiles(): void {
    seed({ workRevision: null, branch: null, github: null, deliveredAt: STAMP });
    for (const name of DELIVERED) attach(name);
    keepDelivery(store.slug, "VIB-1", STAMP, DELIVERED, store.dataRoot);
    attach("late-draft.md");
  }

  it("stores the files it named from the delivery and the three notes, and counts the files on the timeline", async () => {
    // CANARY: drop `...notes` or `files` from the packet the writer builds and
    // the result card has nothing to show for them.
    seedFiles();
    const result = await write({
      summary: "The estimate comes to $2,126.77 a month.",
      considerations: "  Reserved pricing was not applied.  ",
      assumptions: "730 hours a month.",
      gaps: "Nobody gave data transfer figures.",
      files: [{ name: "estimate.json", caption: " The calculator import " }, { name: "summary.md" }],
    });
    expect(result.outcome).toBe("done");
    expect(result.message).toContain("stays on the task as its result once a person accepts it");
    expect(parsed().frontmatter.completionPacket).toEqual({
      subject: `files:${STAMP}`,
      summary: "The estimate comes to $2,126.77 a month.",
      changes: null,
      considerations: "Reserved pricing was not applied.",
      assumptions: "730 hours a month.",
      gaps: "Nobody gave data transfer figures.",
      files: [
        { name: "estimate.json", caption: "The calculator import" },
        { name: "summary.md", caption: "" },
      ],
      screenshots: [],
      at: expect.any(String),
    });
    expect(parsed().timeline[0]!.text).toBe(
      "The operator summarized the files delivered on this task for the person who accepts it, with 2 result files.",
    );
  });

  const listed = "The delivered files: `estimate.json`, `inventory.csv`, `summary.md`.";
  const refusals: [string, Parameters<typeof write>[0], string][] = [
    [
      "it names no result file",
      {},
      `VIB-1 is delivered as files, so the packet names the ones that are its result: pass \`files\`, the final version of each output a person takes away, each with a line saying what it is. Leave out inputs, drafts, logs and working files. ${listed}`,
    ],
    [
      "a named file was saved after the delivery the reviewers judged",
      { files: [{ name: "estimate.json" }, { name: "late-draft.md" }] },
      `\`late-draft.md\` is not among the files VIB-1 delivered, which is what the reviewers judged. ${listed}`,
    ],
    [
      "more than twelve files are named",
      { files: Array.from({ length: 13 }, (_, i) => ({ name: `part-${i}.md` })) },
      "Name at most 12 result files: the ones a person takes away.",
    ],
    [
      "a note runs past its cap",
      { files: [{ name: "estimate.json" }], gaps: "x".repeat(2001) },
      "Gaps is 2001 characters; keep it under 2000.",
    ],
  ];
  it.each(refusals)("refuses, and writes nothing, when %s", async (_label, input, sentence) => {
    // CANARY: drop any one refusal and its row writes a packet.
    seedFiles();
    const result = await write(input);
    expect(result.outcome).toBe("noop");
    expect(result.message).toContain(sentence);
    expect(parsed().frontmatter.completionPacket).toBeUndefined();
  });

  it("ruling 675: names a result stored decomposed by its composed name, and keeps the file's own spelling", async () => {
    // A deliverer's script names its output after a decomposed input, so the
    // result is stored decomposed and the operator types what it reads.
    // CANARY: match the typed name byte for byte and the packet is refused as
    // "X is not among the files VIB-1 delivered. The delivered files: X.".
    const composed = "Müşteri Teklifi.pdf";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    seed({ workRevision: null, branch: null, github: null, deliveredAt: STAMP });
    attach("summary.md");
    // As a run's shell writes it: under the name it was given, not composed.
    writeFileSync(path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), decomposed), "%PDF-1.4");
    keepDelivery(store.slug, "VIB-1", STAMP, [decomposed, "summary.md"], store.dataRoot);
    const result = await write({
      summary: "The proposal is ready.",
      // Both spellings of one file are one result.
      files: [{ name: composed, caption: "The proposal" }, { name: decomposed }, { name: "summary.md" }],
    });
    expect(result.outcome).toBe("done");
    expect(parsed().frontmatter.completionPacket!.files).toEqual([
      { name: decomposed, caption: "The proposal" },
      { name: "summary.md", caption: "" },
    ]);
  });

  it("tells the operator which files it may name: the kept delivery's, or the task's when none was kept", () => {
    // CANARY: offer every file on the task and a draft saved after the
    // delivery, or the browser's own snapshots, is offered as the result.
    seedFiles();
    const fact = () =>
      completionPacketFact(parsed().frontmatter, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      });
    expect(fact()).toMatchObject({
      state: "none",
      resultFilesRequired: true,
      resultFileCandidates: DELIVERED,
      changesSummaryRequired: false,
    });
    expect(fact().note).toContain("the packet names the ones that are the result (`files`, from `resultFileCandidates`)");

    // A delivery nobody kept: the task's files, less the browser's working files.
    seed({ workRevision: null, branch: null, github: null, deliveredAt: "2026-10-06T09:00:00.000Z" });
    attach("page-2026-10-06T02-39-32-303Z.yml");
    expect(fact().resultFileCandidates).toEqual([...DELIVERED, "late-draft.md"].sort());
  });

  it("names no files for a revision, whose pull request holds them, and says so", async () => {
    // CANARY: keep `files` on a revision's packet and the result of a code
    // task lists attachments beside the pull request that holds its files.
    seed();
    attach("after.png");
    const result = await write({ files: [{ name: "after.png" }], gaps: "The cron run is unproven." });
    expect(result.outcome).toBe("done");
    expect(result.message).toContain("`files` was left out: this task's pull request holds its files.");
    expect(parsed().frontmatter.completionPacket).toMatchObject({ files: [], gaps: "The cron run is unproven." });
    expect(
      completionPacketFact(parsed().frontmatter, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      }),
    ).toMatchObject({ resultFilesRequired: false, resultFileCandidates: [] });
  });

  it("hands the page the notes, the result files the viewer may see, and the paths a revision changed", async () => {
    // CANARY: pass the packet's files through without `canSee` and a viewer
    // who may not see the attachments is handed their names.
    const nameOf = (id: string) => id;
    seedFiles();
    await write({
      assumptions: "730 hours a month.",
      files: [{ name: "estimate.json", caption: "The calculator import" }, { name: "summary.md" }],
    });
    const fm = parsed().frontmatter;
    const member = completionView(fm, { canSee: (name) => name === "estimate.json", nameOf, ruleReviewers: [] })!;
    expect(member.packet).toMatchObject({
      considerations: null,
      assumptions: "730 hours a month.",
      gaps: null,
      files: [{ name: "estimate.json", caption: "The calculator import" }],
      hiddenFiles: 1,
    });
    expect(member.paths).toBeNull();
    expect(completionView(fm, { canSee: null, nameOf, ruleReviewers: [] })!.packet).toMatchObject({
      files: [],
      hiddenFiles: 2,
    });
    // Another task reads the same result as one text (ruling 569).
    expect(completionPacketText(fm.completionPacket!)).toBe(
      "The attach flow works.\n\nAssumptions:\n730 hours a month.\n\n" +
        "Result files:\n- estimate.json: The calculator import\n- summary.md",
    );

    // A revision: the paths the pull request changes, the first forty of them.
    const changed = Array.from({ length: 42 }, (_, i) => `app/file-${String(i).padStart(2, "0")}.ts`);
    seed({
      pr: {
        number: 7,
        state: "merged",
        title: "Attach one repository",
        paths: { headSha: SHA, changed, truncated: false },
      },
    });
    const code = completionView(parsed().frontmatter, { canSee: null, nameOf, ruleReviewers: [] })!;
    expect(code.paths).toEqual({ shown: changed.slice(0, 40), more: 2, truncated: false });
  });
});

describe("ruling 690: what the work under review rests on", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Keep one source on VIB-1 at `at`, by the store's own writer. */
  function keepAt(at: string, name: string): void {
    vi.setSystemTime(new Date(at));
    writeTaskSource(
      store.slug,
      "VIB-1",
      {
        name,
        data: Buffer.from(`the page ${name}`),
        title: `The page ${name}`,
        from: `https://aws.amazon.com/${name}`,
        by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
        runId: "run_abc",
      },
      store.dataRoot,
    );
  }

  it("counts a task's sources for the operator and, for the page, the ones its delivery recorded or the ones kept by then, and never one kept afterwards", async () => {
    // A source a reviewer keeps while checking the work is on the task and
    // was not under what it checks. CANARY: count every kept source as rested
    // on and the snapshot says a result stood on a page nobody had read yet.
    vi.useFakeTimers({ toFake: ["Date"] });
    const fact = () =>
      completionPacketFact(parsed().frontmatter, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      }).sources;
    const rested = () =>
      sourcesRestedOn(readTaskSources(store.slug, "VIB-1", store.dataRoot), parsed().frontmatter).map((s) => s.id);
    const files = (deliveredAt: string | null) => seed({ workRevision: null, branch: null, github: null, deliveredAt });

    // Nothing is delivered yet: the task keeps a source, and no result rests on it.
    files(null);
    keepAt("2026-10-07T12:00:00.000Z", "ec2.html");
    expect(fact()).toEqual({ kept: 1, restedOn: 0 });

    // A files delivery whose line was never written rests on what was kept by its stamp.
    files("2026-10-07T13:00:00.000Z");
    keepAt("2026-10-07T14:00:00.000Z", "rds.html");
    expect(rested()).toEqual(["S1"]);
    expect(fact()).toEqual({ kept: 2, restedOn: 1 });

    // A delivery that recorded its sources rests on those, whatever the clock said.
    files("2026-10-07T15:00:00.000Z");
    recordDeliverySources(store.slug, "VIB-1", "2026-10-07T15:00:00.000Z", store.dataRoot);
    keepAt("2026-10-07T14:59:00.000Z", "s3.html");
    expect(rested()).toEqual(["S1", "S2"]);
    expect(fact()).toEqual({ kept: 3, restedOn: 2 });

    // A revision nobody has summarized rests on everything kept so far; once
    // the operator has, on what was kept by then.
    seed();
    expect(rested()).toEqual(["S1", "S2", "S3"]);
    vi.setSystemTime(new Date("2026-10-07T14:30:00.000Z"));
    expect((await write({})).outcome).toBe("done");
    expect(rested()).toEqual(["S1", "S2"]);
    expect(fact()).toEqual({ kept: 3, restedOn: 2 });
  });

  it("the page's card carries the count and the first twelve, says zero for a files result, and nothing for a revision that rests on none or a viewer who may not see", () => {
    // CANARY: carry `sources` on every view and the task page's payload grows
    // on every task that keeps none (ruling 457's console budget measures it);
    // drop it at zero for a files result and the card cannot say the result
    // rests on no kept source.
    vi.useFakeTimers({ toFake: ["Date"] });
    const nameOf = (id: string) => id;
    seed({ workRevision: null, branch: null, github: null, deliveredAt: "2026-10-07T13:00:00.000Z" });
    const filesFm = parsed().frontmatter;
    const view = (fm: TaskFrontmatter, sources: ReturnType<typeof sourcesRestedOn> | null) =>
      completionView(fm, { canSee: null, nameOf, ruleReviewers: [], sources })!;
    expect(view(filesFm, []).sources).toEqual({ count: 0, shown: [] });
    expect("sources" in view(filesFm, null)).toBe(false);

    for (let n = 1; n <= 14; n += 1) keepAt("2026-10-07T12:00:00.000Z", `page-${n}.html`);
    const kept = readTaskSources(store.slug, "VIB-1", store.dataRoot).sources;
    const listed = view(filesFm, kept).sources!;
    expect(listed.count).toBe(14);
    expect(listed.shown.map((s) => s.id)).toEqual(kept.slice(0, 12).map((s) => s.id));
    expect(listed.shown[0]).toEqual({
      id: "S1",
      name: "page-1.html",
      title: "The page page-1.html",
      from: "https://aws.amazon.com/page-1.html",
    });

    seed();
    const revisionFm = parsed().frontmatter;
    expect("sources" in view(revisionFm, [])).toBe(false);
    expect(view(revisionFm, kept.slice(0, 1)).sources).toMatchObject({ count: 1 });
  });
});
