import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { FileActorRef, TaskFileEvent, TaskFrontmatter } from "~/schemas/task-file.schema";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { listTaskAttachmentNames } from "~/server/files/task-attachments.server";
import { readTaskSources, taskSourcesDir, writeTaskSource } from "~/server/files/task-sources.server";
import { keepTaskSource, type KeepSourceInput } from "./task-sources.server";

/**
 * Ruling 690: a task keeps the sources its result rests on. The keep is the
 * action behind `keep_source`: it takes a file the run saved in the task's
 * attachments folder, keeps the server's own copy under an id, and takes the
 * file out of the folder. These drive it through the real store.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const RESEARCHER: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "researcher",
  roleHint: "Researcher",
};

/** A store with VIB-1 on it, as `patch` and `timeline` leave it. */
function storeWithTask(patch: Partial<TaskFrontmatter> = {}, timeline: TaskFileEvent[] = []): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ...patch }),
    timeline,
  });
  return store;
}

/** Save a file in VIB-1's attachments folder, as a run's shell does. */
function save(store: TestStore, name: string, body: string | Buffer): string {
  const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body);
  return dir;
}

const keep = (store: TestStore, patch: Partial<KeepSourceInput> = {}): string =>
  keepTaskSource(
    store.db,
    { dataRoot: store.dataRoot },
    {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      file: "aws-pricing.html",
      from: "https://aws.amazon.com/ec2/pricing/on-demand/",
      title: "AWS EC2 on-demand pricing, eu-central-1",
      actorRef: RESEARCHER,
      runId: "run_abc",
      ...patch,
    },
  );

const files = (store: TestStore) => listTaskAttachmentNames(store.slug, "VIB-1", store.dataRoot).sort();
const kept = (store: TestStore) => readTaskSources(store.slug, "VIB-1", store.dataRoot).sources;
const sourceFile = (store: TestStore, name: string) =>
  path.join(taskSourcesDir(store.slug, "VIB-1", store.dataRoot), name);

describe("ruling 690: keeping a source on a task", () => {
  it("keeps a file the run saved as a source: it leaves the task's files, and the record carries its id, origin, title, agent, run, size and hash", () => {
    // CANARY: drop the unlink of the staged file in keepTaskSource and
    // listTaskAttachmentNames still holds it, so the run's reply would post
    // it and a delivery would carry it.
    // CANARY: drop the word boundary in readsAsCredential and this page's
    // address is refused as a token (`risk-management-and-on-demand-rates`
    // ends a word in `sk-`); scan a fetched page's bytes as a command's
    // output is scanned and its markup is refused for a CSS class.
    const store = storeWithTask();
    const page = '<html><div class="sk-fading-circle-wrapper">t3.medium $0.0416 per hour</div></html>';
    const from = "https://docs.example.com/pricing/risk-management-and-on-demand-rates";
    save(store, "aws-pricing.html", page);

    const sha256 = createHash("sha256").update(page).digest("hex");
    expect(keep(store, { from })).toBe(
      `[kept] S1: aws-pricing.html, ${page.length} bytes, sha256 ${sha256.slice(0, 12)}. ` +
        "It left the attachments folder: it is a source now, not a file of the result. " +
        "Cite S1 beside the claim it supports.",
    );

    const lines = readFileSync(sourceFile(store, "index.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        kind: "source",
        id: "S1",
        file: "S1.html",
        name: "aws-pricing.html",
        title: "AWS EC2 on-demand pricing, eu-central-1",
        from,
        keptAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
        runId: "run_abc",
        bytes: page.length,
        sha256,
      },
    ]);
    expect(readFileSync(sourceFile(store, "S1.html"), "utf8")).toBe(page);
    expect(files(store)).toEqual([]);
  });

  it("a kept source is never overwritten: the same bytes answer with the id already kept, new bytes take the next id, and a file standing under the next id is stepped over", () => {
    // CANARY: allocate the id from the index alone and the second keep is
    // given S2, the name a crash left standing: the exclusive open refuses
    // it and the keep fails. Open the bytes file without O_EXCL as well and
    // the planted S2.html is rewritten.
    const store = storeWithTask();
    save(store, "aws-pricing.html", "t3.medium $0.0416 per hour");
    expect(keep(store)).toContain("[kept] S1: aws-pricing.html");

    // The same page, fetched again under another name.
    save(store, "aws-pricing-again.html", "t3.medium $0.0416 per hour");
    expect(keep(store, { file: "aws-pricing-again.html", title: "The same page" })).toBe(
      '[noop] These bytes are already kept as S1 ("AWS EC2 on-demand pricing, eu-central-1"). ' +
        "The file was taken out of the attachments folder; cite S1.",
    );
    expect(kept(store).map((s) => s.id)).toEqual(["S1"]);
    expect(files(store)).toEqual([]);

    // A bytes file whose record never landed: what a crash between the two
    // writes leaves behind.
    writeFileSync(sourceFile(store, "S2.html"), "a source whose record was lost");
    save(store, "rds-pricing.html", "db.t3.medium $0.068 per hour");
    expect(keep(store, { file: "rds-pricing.html", title: "RDS pricing" })).toContain("[kept] S3: rds-pricing.html");

    expect(kept(store).map((s) => [s.id, s.file])).toEqual([
      ["S1", "S1.html"],
      ["S3", "S3.html"],
    ]);
    expect(readFileSync(sourceFile(store, "S1.html"), "utf8")).toBe("t3.medium $0.0416 per hour");
    expect(readFileSync(sourceFile(store, "S2.html"), "utf8")).toBe("a source whose record was lost");
    expect(readFileSync(sourceFile(store, "S3.html"), "utf8")).toBe("db.t3.medium $0.068 per hour");
  });

  interface Refusal {
    what: string;
    /** The file the run saved before it called, when it saved one. */
    saved?: { name: string; body: string | Buffer };
    task?: Partial<TaskFrontmatter>;
    timeline?: TaskFileEvent[];
    /** Sources the task already keeps. */
    alreadyKept?: number;
    call: Partial<KeepSourceInput>;
    /** The whole reply, with `<dir>` for the task's attachments folder. */
    reply: string;
  }

  const TOKEN = "ghp_0123456789abcdefABCDEF0123456789abcd";

  const refusals: Refusal[] = [
    {
      what: "a name the folder does not hold",
      call: { file: "missing.html" },
      reply:
        "[refused] The task's attachments folder holds no `missing.html`. Save the page or the output there first " +
        '(`curl -sSL -o "<dir>/missing.html" "<url>"`, or redirect the command\'s output), then call keep_source with that name.',
    },
    {
      what: "a name with a folder in it",
      call: { file: "../task.md" },
      reply:
        "[refused] `../task.md` is not one file name in the task's attachments folder. Give the file's name alone, with no folder.",
    },
    {
      // CANARY: delete the claimed-name check and this row passes: a person's
      // input leaves the task's files and becomes S1.
      what: "a file a person attached",
      saved: { name: "inventory.csv", body: "host,cpu\napp01,4\n" },
      timeline: [
        {
          occurredAt: "2026-10-07T09:00:00.000Z",
          type: "note",
          actor: { kind: "human", userId: "u_arda", nameHint: "Arda" },
          title: null,
          text: "Attached the inventory.",
          toAgent: false,
          evidence: null,
          attachments: ["inventory.csv"],
        },
      ],
      call: { file: "inventory.csv", from: "the person's upload" },
      reply:
        "[refused] `inventory.csv` is already a file on this task, posted 2026-10-07T09:00:00.000Z by Arda: " +
        "a source is kept from a file your run just saved. Save the page or the output under a new name and keep that.",
    },
    {
      what: "an empty file",
      saved: { name: "aws-pricing.html", body: "" },
      call: {},
      reply:
        "[refused] `aws-pricing.html` is empty, so nothing came back. Fetch it again and keep what you get, " +
        "or say in your result that the source could not be opened.",
    },
    {
      what: "a file over 10 MB",
      saved: { name: "export.json", body: Buffer.alloc(14 * 1024 * 1024, "x") },
      call: { file: "export.json" },
      reply:
        "[refused] `export.json` is 14.0 MB; a source may be up to 10 MB. " +
        "Save the page or the part of the output your claim rests on as its own file and keep that.",
    },
    {
      what: "the 201st source",
      saved: { name: "aws-pricing.html", body: "one page more" },
      alreadyKept: 200,
      call: {},
      reply:
        "[refused] VIB-1 keeps 200 sources, the most a task holds. Cite one already kept (`read_task_source` lists them), " +
        "or say in your result which claim has no kept source.",
    },
    {
      what: "a token in `from`",
      saved: { name: "aws-pricing.html", body: "t3.medium $0.0416 per hour" },
      call: { from: `curl -H "Authorization: Bearer ${TOKEN}" https://api.github.com/repos/acme/site` },
      reply:
        "[refused] `from` holds what reads as a token or a password. Give the URL or the command without it.",
    },
    {
      what: "a command output that prints a token",
      saved: { name: "gh-auth-status.txt", body: `Logged in to github.com\nToken: ${TOKEN}\n` },
      call: { file: "gh-auth-status.txt", from: "gh auth status --show-token" },
      reply:
        "[refused] `gh-auth-status.txt` holds what reads as an access token. A source is kept as it is and every project member can open it: " +
        "run the command again without printing the credential, save that output and keep it.",
    },
    {
      what: "an archived task",
      saved: { name: "aws-pricing.html", body: "t3.medium $0.0416 per hour" },
      task: { archived: true },
      call: {},
      reply: "[refused] VIB-1 is archived, so nothing more is kept on it.",
    },
  ];

  it.each(refusals)("refuses $what and says what to do instead", (row) => {
    const store = storeWithTask(row.task, row.timeline);
    for (let n = 1; n <= (row.alreadyKept ?? 0); n += 1) {
      writeTaskSource(
        store.slug,
        "VIB-1",
        {
          name: `page-${n}.html`,
          data: Buffer.from(`page ${n}`),
          title: `Page ${n}`,
          from: `https://example.com/${n}`,
          by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
          runId: "run_earlier",
        },
        store.dataRoot,
      );
    }
    if (row.saved) save(store, row.saved.name, row.saved.body);
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);

    expect(keep(store, row.call)).toBe(row.reply.replace("<dir>", dir));

    // A refusal writes nothing, and the file stays where the run saved it.
    expect(kept(store)).toHaveLength(row.alreadyKept ?? 0);
    expect(existsSync(sourceFile(store, "index.jsonl"))).toBe((row.alreadyKept ?? 0) > 0);
    expect(files(store)).toEqual(row.saved ? [row.saved.name] : []);
  });
});
