import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { FileActorRef, TaskFrontmatter } from "~/schemas/task-file.schema";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { listTaskAttachmentNames } from "~/server/files/task-attachments.server";
import { readTaskSources, taskSourcesDir, writeTaskSource } from "~/server/files/task-sources.server";
import { keepTaskSource, type KeepSourceInput } from "./task-sources.server";

/**
 * Ruling 690: a task keeps the sources its result rests on. The keep is the
 * action behind `keep_source`: it takes a file the run staged in the task's
 * attachments folder under a `.source-` name, keeps the server's own copy
 * under an id, and removes the staged file. These drive it through the real
 * store.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const RESEARCHER: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "researcher",
  roleHint: "Researcher",
};

/** A store with VIB-1 on it, as `patch` leaves it. */
function storeWithTask(patch: Partial<TaskFrontmatter> = {}): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ...patch }),
  });
  return store;
}

const attachmentsDir = (store: TestStore) => taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);

/** Save a file in VIB-1's attachments folder, as a run's shell does. */
function save(store: TestStore, name: string, body: string | Buffer): void {
  mkdirSync(attachmentsDir(store), { recursive: true });
  writeFileSync(path.join(attachmentsDir(store), name), body);
}

const keep = (store: TestStore, patch: Partial<KeepSourceInput> = {}): string =>
  keepTaskSource(
    store.db,
    { dataRoot: store.dataRoot },
    {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      file: ".source-aws-pricing.html",
      from: "https://aws.amazon.com/ec2/pricing/on-demand/",
      title: "AWS EC2 on-demand pricing, eu-central-1",
      actorRef: RESEARCHER,
      runId: "run_abc",
      ...patch,
    },
  );

/** Every entry of the attachments folder, staged files included. */
const inFolder = (store: TestStore) => (existsSync(attachmentsDir(store)) ? readdirSync(attachmentsDir(store)).sort() : []);
/** The folder as every reader of the task's files lists it. */
const files = (store: TestStore) => listTaskAttachmentNames(store.slug, "VIB-1", store.dataRoot).sort();
const kept = (store: TestStore) => readTaskSources(store.slug, "VIB-1", store.dataRoot).sources;
const sourceFile = (store: TestStore, name: string) =>
  path.join(taskSourcesDir(store.slug, "VIB-1", store.dataRoot), name);

/** Keep `count` sources of `bytes` each on VIB-1, by the store's own writer. */
function keepEarlier(store: TestStore, count: number, bytes = 0): void {
  for (let n = 1; n <= count; n += 1) {
    writeTaskSource(
      store.slug,
      "VIB-1",
      {
        name: `page-${n}.html`,
        data: bytes > 0 ? Buffer.alloc(bytes, String(n % 10)) : Buffer.from(`page ${n}`),
        title: `Page ${n}`,
        from: `https://example.com/${n}`,
        by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
        runId: "run_earlier",
      },
      store.dataRoot,
    );
  }
}

const MB = 1024 * 1024;
const TOKEN = "ghp_0123456789abcdefABCDEF0123456789abcd";

describe("ruling 690: keeping a source on a task", () => {
  it("keeps a staged file as a source under the name after the prefix: the staged file goes, no reader of the task's files ever lists it, and the record carries its id, origin, title, agent, run, size and hash", () => {
    // CANARY: drop the removal of the staged file in keepTaskSource and the
    // folder still holds `.source-aws-pricing.html` after the keep.
    const store = storeWithTask();
    const page = "<html>t3.medium $0.0416 per hour</html>";
    save(store, ".source-aws-pricing.html", page);
    // Staged, it is no file of the task: what a completing run lists.
    expect(files(store)).toEqual([]);

    const sha256 = createHash("sha256").update(page).digest("hex");
    expect(keep(store)).toBe(
      `[kept] S1: aws-pricing.html, ${page.length} bytes, sha256 ${sha256.slice(0, 12)}. ` +
        "The staged file left the attachments folder: it is a source now, not a file of the result. " +
        "Say which claim S1 supports in your report or in a notes file beside the result.",
    );

    const lines = readFileSync(sourceFile(store, "index.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        kind: "source",
        id: "S1",
        file: "S1.html",
        name: "aws-pricing.html",
        title: "AWS EC2 on-demand pricing, eu-central-1",
        from: "https://aws.amazon.com/ec2/pricing/on-demand/",
        keptAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
        runId: "run_abc",
        bytes: page.length,
        sha256,
      },
    ]);
    expect(readFileSync(sourceFile(store, "S1.html"), "utf8")).toBe(page);
    expect(inFolder(store)).toEqual([]);
  });

  it("a kept source is never overwritten: the same bytes answer with the id already kept, new bytes take the next id, and a file standing under the next id is stepped over", () => {
    // CANARY: allocate the id from the index alone and the second keep is
    // given S2, the name a crash left standing: the exclusive open refuses
    // it and the keep fails. Open the bytes file without O_EXCL as well and
    // the planted S2.html is rewritten.
    const store = storeWithTask();
    save(store, ".source-aws-pricing.html", "t3.medium $0.0416 per hour");
    expect(keep(store)).toContain("[kept] S1: aws-pricing.html");

    // The same page, fetched again under another name.
    save(store, ".source-aws-pricing-again.html", "t3.medium $0.0416 per hour");
    expect(keep(store, { file: ".source-aws-pricing-again.html", title: "The same page" })).toBe(
      '[noop] These bytes are already kept as S1 ("AWS EC2 on-demand pricing, eu-central-1"): cite S1. ' +
        "The staged file was removed from the attachments folder.",
    );
    expect(kept(store).map((s) => s.id)).toEqual(["S1"]);
    expect(inFolder(store)).toEqual([]);

    // A bytes file whose record never landed: what a crash between the two
    // writes leaves behind.
    writeFileSync(sourceFile(store, "S2.html"), "a source whose record was lost");
    save(store, ".source-rds-pricing.html", "db.t3.medium $0.068 per hour");
    expect(keep(store, { file: ".source-rds-pricing.html", title: "RDS pricing" })).toContain("[kept] S3: rds-pricing.html");

    expect(kept(store).map((s) => [s.id, s.file])).toEqual([
      ["S1", "S1.html"],
      ["S3", "S3.html"],
    ]);
    expect(readFileSync(sourceFile(store, "S1.html"), "utf8")).toBe("t3.medium $0.0416 per hour");
    expect(readFileSync(sourceFile(store, "S2.html"), "utf8")).toBe("a source whose record was lost");
    expect(readFileSync(sourceFile(store, "S3.html"), "utf8")).toBe("db.t3.medium $0.068 per hour");
  });

  it("bytes whose source a person took out of the store are not kept again under a new id", () => {
    // The runbook's removal: the bytes file deleted by hand, the record left.
    // The keep used to answer that those bytes were already kept, remove the
    // staged file and tell the agent to cite an id whose bytes were gone.
    // CANARY: match a duplicate on the record's hash alone and the reply is
    // `[noop] ... cite S1` with the staged file removed.
    const store = storeWithTask();
    save(store, ".source-roster.html", "names and addresses");
    expect(keep(store, { file: ".source-roster.html", title: "The roster" })).toContain("[kept] S1");
    rmSync(sourceFile(store, "S1.html"));

    save(store, ".source-roster-again.html", "names and addresses");
    expect(keep(store, { file: ".source-roster-again.html", title: "The roster" })).toBe(
      "[refused] These bytes were kept as S1 and that source has since been removed from the store, so they are not kept again, " +
        "and the staged file was removed from the attachments folder. " +
        "Say in your result that the source for this claim was removed.",
    );
    expect(kept(store).map((s) => s.id)).toEqual(["S1"]);
    expect(existsSync(sourceFile(store, "S1.html"))).toBe(false);
    // A person took these bytes out; a hidden copy the attachments route
    // serves by name would bring them back. CANARY: leave the staged file.
    expect(inFolder(store)).toEqual([]);
  });

  interface Refusal {
    what: string;
    /** The file the run saved before it called, when it saved one. */
    saved?: { name: string; body: string | Buffer };
    task?: Partial<TaskFrontmatter>;
    /** Sources the task already keeps, and how large each is. */
    alreadyKept?: { count: number; bytes?: number };
    call: Partial<KeepSourceInput>;
    /** The whole reply. */
    reply: string;
    /** The saved file is removed by the refusal itself. */
    removes?: boolean;
  }

  const notStaged = (name: string) =>
    `[refused] \`${name}\` is not a staged source. keep_source takes only a file saved in the task's attachments folder under a name that starts with ` +
    "`.source-`, which nothing lists, posts or delivers; a file under any other name belongs to the task and stays there. " +
    "Save the page or the output there as `.source-<name>` (copy a browser snapshot to such a name), then call keep_source with that name.";
  const oneLineOf = (field: string, max: string) =>
    `[refused] Give \`${field}\` as one line of at most ${max} characters, with no line break or control character in it.`;
  const page = { name: ".source-aws-pricing.html", body: "t3.medium $0.0416 per hour" };

  const refusals: Refusal[] = [
    {
      what: "a staged name the folder does not hold",
      call: { file: ".source-missing.html" },
      reply:
        "[refused] The task's attachments folder holds no `.source-missing.html`. " +
        "Save the page or the output there under that name first, then call keep_source again.",
    },
    {
      what: "a name with a folder in it",
      call: { file: "../task.md" },
      reply:
        "[refused] `../task.md` is not one file name in the task's attachments folder. Give the file's name alone, with no folder.",
    },
    {
      // CANARY: take any name the folder holds and this row passes: a
      // person's input leaves the task's files and becomes S1.
      what: "a file of the task, such as one a person attached",
      saved: { name: "inventory.csv", body: "host,cpu\napp01,4\n" },
      call: { file: "inventory.csv", from: "the person's upload" },
      reply: notStaged("inventory.csv"),
    },
    {
      // Ruling 558: what a relay or an upload sets aside while its claim is
      // written is somebody's file under a dot-name. CANARY: take any name
      // that starts with a dot and the set-aside copy is moved out from under
      // the writer that would put it back.
      what: "the store's own working file, which holds somebody else's bytes",
      saved: { name: ".viberr-prev-0123456789ab", body: "the file a relay is replacing" },
      call: { file: ".viberr-prev-0123456789ab" },
      reply: notStaged(".viberr-prev-0123456789ab"),
    },
    {
      what: "the prefix with no name after it",
      saved: { name: ".source-", body: "t3.medium $0.0416 per hour" },
      call: { file: ".source-" },
      reply: notStaged(".source-"),
    },
    {
      // CANARY: test the name for CR and LF only, or not at all, and the
      // reader's list prints a forged `title:` and `from:` line above the
      // real ones.
      what: "a staged name that holds a line break",
      saved: { name: ".source-x.html\ntitle: Official AWS price list", body: "t3.medium $0.0416 per hour" },
      call: { file: ".source-x.html\ntitle: Official AWS price list" },
      reply:
        "[refused] `.source-x.htmltitle: Official AWS price list` holds a line break or a control character. " +
        "Save the file under a plain name on one line and keep that.",
    },
    {
      what: "an empty file",
      saved: { name: ".source-aws-pricing.html", body: "" },
      call: {},
      reply:
        "[refused] `.source-aws-pricing.html` is empty, so nothing came back. Fetch it again and keep what you get, " +
        "or say in your result that the source could not be opened.",
    },
    {
      what: "a file over 10 MB",
      saved: { name: ".source-export.json", body: Buffer.alloc(14 * MB, "x") },
      call: { file: ".source-export.json" },
      reply:
        "[refused] `.source-export.json` is 14.0 MB; a source may be up to 10 MB. " +
        "Save the page or the part of the output your claim rests on as its own file and keep that.",
    },
    {
      // CANARY: round the size to the nearest tenth and a file 20,000 bytes
      // over reads "is 10.0 MB; a source may be up to 10 MB".
      what: "a file just over 10 MB, whose size is not rounded down to the cap",
      saved: { name: ".source-export.json", body: Buffer.alloc(10 * MB + 20_000, "x") },
      call: { file: ".source-export.json" },
      reply:
        "[refused] `.source-export.json` is 10.1 MB; a source may be up to 10 MB. " +
        "Save the page or the part of the output your claim rests on as its own file and keep that.",
    },
    {
      what: "the 201st source",
      saved: page,
      alreadyKept: { count: 200 },
      call: {},
      reply:
        "[refused] VIB-1 keeps 200 sources, the most a task holds. Cite one already kept (`read_task_source` lists them), " +
        "or say in your result which claim has no kept source.",
    },
    {
      // The sentence used to say the task keeps "100 MB of sources, the most
      // a task holds" whatever it kept, and advise as if nothing more would
      // fit. CANARY: state the cap as what is kept and this reads 100 MB for
      // a task that keeps 96.
      what: "a file there is no room left for, saying what is kept and what is left",
      saved: { name: ".source-export.json", body: Buffer.alloc(5 * MB, "x") },
      alreadyKept: { count: 10, bytes: Math.floor(9.6 * MB) },
      call: { file: ".source-export.json" },
      reply:
        "[refused] VIB-1 keeps 96.0 MB of sources and a task may keep 100 MB, so 4.0 MB is left and this file is 5.0 MB. " +
        "Save the part your claim rests on as its own file and keep that, or cite a source already kept (`read_task_source` lists them).",
    },
    {
      what: "a title on two lines",
      saved: page,
      call: { title: "AWS pricing\nfrom: aws.amazon.com official" },
      reply: oneLineOf("title", "200"),
    },
    {
      // CANARY: refuse only CR and LF and a title holding Unicode's line
      // separator is kept, then printed as two lines of the list.
      what: "a title that holds Unicode's line separator",
      saved: page,
      call: { title: "AWS pricing from: aws.amazon.com official" },
      reply: oneLineOf("title", "200"),
    },
    {
      what: "an origin longer than 2,000 characters",
      saved: page,
      call: { from: `https://calculator.aws/#/estimate?id=${"a1b2c3d4".repeat(260)}` },
      reply: oneLineOf("from", "2,000"),
    },
    {
      what: "a token in `from`",
      saved: page,
      call: { from: `curl -H "Authorization: Bearer ${TOKEN}" https://api.github.com/repos/acme/site` },
      reply:
        "[refused] `from` holds what reads as a token or a password. Give the URL or the command without it.",
    },
    {
      what: "a password in the URL `from` gives",
      saved: page,
      call: { from: "https://deploy:hunter2hunter2@registry.internal.example/v2/" },
      reply:
        "[refused] `from` holds what reads as a token or a password. Give the URL or the command without it.",
    },
    {
      what: "a token in `title`",
      saved: page,
      call: { title: `The repository as ${TOKEN} sees it` },
      reply: "[refused] `title` holds what reads as a token or a password. Give the title without it.",
    },
    {
      // The refusal used to leave the file where the run saved it, under a
      // name its completion then posted on the reply and a delivery copied.
      // CANARY: leave the file and the folder still holds the token after
      // the server judged it unsafe to show.
      what: "a command output that prints a token, which it also removes",
      saved: { name: ".source-gh-auth-status.txt", body: `Logged in to github.com\nToken: ${TOKEN}\n` },
      call: { file: ".source-gh-auth-status.txt", from: "gh auth status --show-token" },
      removes: true,
      reply:
        "[refused] `.source-gh-auth-status.txt` holds what reads as an access token, so it is not kept and it was removed from the attachments folder. " +
        "A source is kept as it is and every project member can open it: run the command again without printing the credential, " +
        "save that output and keep it. If this is a page you fetched and not a command's output, fetch it again and give its URL as `from`.",
    },
    {
      // `wget` names a download after its URL, query included, and the name
      // reaches the index, the audit row, every reader's list and the
      // download's header. CANARY: read `from` and `title` alone and the keep
      // answers `[kept] S1` with the token in the store.
      what: "a staged name that holds a token, which it also removes",
      saved: { name: `.source-export.csv?access_token=${TOKEN}`, body: "host,cpu\napp01,4\n" },
      call: { file: `.source-export.csv?access_token=${TOKEN}` },
      removes: true,
      reply:
        "[refused] The file's name holds what reads as a token or a password, so it is not kept and it was removed from the attachments folder. " +
        "Save what you fetched again under a plain name that starts with `.source-` and keep that.",
    },
    {
      what: "an archived task",
      saved: page,
      task: { archived: true },
      call: {},
      reply: "[refused] VIB-1 is archived, so nothing more is kept on it.",
    },
    {
      what: "a task the project does not hold",
      saved: page,
      call: { taskKey: "VIB-404" },
      reply: "[refused] There is no task VIB-404 in this project to keep a source on.",
    },
    {
      what: "a caller that is not an agent's run",
      saved: page,
      call: { actorRef: { kind: "operator" } },
      reply: "[refused] A source is kept by an agent's run.",
    },
  ];

  it.each(refusals)("refuses $what and says what to do instead", (row) => {
    const store = storeWithTask(row.task);
    keepEarlier(store, row.alreadyKept?.count ?? 0, row.alreadyKept?.bytes);
    if (row.saved) save(store, row.saved.name, row.saved.body);

    expect(keep(store, row.call)).toBe(row.reply);

    // A refusal writes nothing, and the file stays where the run saved it
    // unless the refusal is the one that removes it.
    expect(kept(store)).toHaveLength(row.alreadyKept?.count ?? 0);
    expect(existsSync(sourceFile(store, "index.jsonl"))).toBe((row.alreadyKept?.count ?? 0) > 0);
    expect(inFolder(store)).toEqual(row.saved && !row.removes ? [row.saved.name] : []);
  });

  const lookalikes = [
    {
      // CANARY: count every `sk-` run of sixteen as a key and SK hynix's
      // newsroom cannot be given as an origin at all.
      what: "a page address whose path starts a word with `sk-`",
      from: "https://news.skhynix.com/sk-hynix-reports-third-quarter-2025-financial-results/",
      body: "<html>Revenue rose in the third quarter.</html>",
    },
    {
      // CANARY: drop the word boundary and the tail of `task-` with the
      // build's id after it is read as a key.
      what: "a page address with `sk-` inside a word",
      from: "https://ci.example.com/artifacts/task-3f9a8b7c6d5e4f3a2b1c0d9e/pricing.html",
      body: "<html>t3.medium $0.0416 per hour</html>",
    },
    {
      // The command is given as `from`, so the bytes are read for a
      // credential: scikit-learn's stylesheet is not one.
      what: "a fetched page whose markup names a class that starts `sk-`, kept with the command as its origin",
      from: "curl -sSL https://scikit-learn.org/stable/modules/generated/sklearn.svm.SVC.html",
      body: '<div class="sk-toggleable__content sk-fading-circle-wrapper"><pre>SVC(C=1.0)</pre></div>',
    },
  ];

  it.each([
    ...lookalikes,
    {
      // The scan took everything between `://` and the next `@` with a `:`
      // in it for a password, and that refusal removes the file. CANARY: let
      // a quote or a comma stand in a userinfo and an API answer that holds a
      // site address before an e-mail address is deleted as a credential.
      what: "an API answer with a site address before an e-mail address",
      from: "gh api orgs/acme",
      body: '{"login":"acme","blog":"https://acme.example","location":"Berlin","email":"hello@acme.example"}',
    },
    {
      what: "a line that names a local address before an e-mail address",
      from: "cat README.md",
      body: "see http://localhost:3000,admin@example.com for access",
    },
    {
      // CANARY: let a round bracket or a semicolon stand in a userinfo and a
      // Markdown link or a stylesheet is deleted as a credential.
      what: "a Markdown link to a local address before an e-mail address",
      from: "cat docs/setup.md",
      body: "Open [the app](http://localhost:3000)ops@example.com owns it.",
    },
    {
      what: "a stylesheet whose url() is followed by an at-rule",
      from: "cat site.css",
      body: "body{background:url(http://localhost:3000/bg.png)}a{b:url(http://localhost:3000);@media print{}}",
    },
  ])("keeps $what: it is not a credential", ({ from, body }) => {
    const store = storeWithTask();
    save(store, ".source-page.html", body);
    expect(keep(store, { file: ".source-page.html", from })).toContain("[kept] S1: page.html");
    expect(kept(store).map((s) => s.from)).toEqual([from]);
  });

  it("still refuses a key of the `sk-` shape where one is printed", () => {
    // CANARY: require a capital and a digit of every `sk-` match and a
    // provider's key of lower-case hex is kept and shown to every member;
    // require sixteen letters and digits in a row and a key broken by
    // hyphens is.
    const store = storeWithTask();
    for (const key of ["sk-proj-Ab3dEf7h-Ij1kLm5n-Op9qRs2t", "sk-0123456789abcdef0123456789abcdef"]) {
      save(store, ".source-env.txt", `ANTHROPIC_API_KEY=${key}\n`);
      expect(keep(store, { file: ".source-env.txt", from: "env | sort" })).toContain(
        "holds what reads as an access token, so it is not kept",
      );
    }
    expect(kept(store)).toEqual([]);
  });

  it("reads a long unbroken output for a credential in the time any file takes", () => {
    // A JSON-RPC answer, a hex dump or a one-line sequence is one unbroken
    // run of letters and digits. The userinfo pattern tried a URL scheme at
    // every character of the run and scanned to its end each time: 0.6 s at
    // 40,000 characters, 2.5 s at 80,000, minutes at a megabyte, inside the
    // server's own process with every request and every stream waiting.
    // CANARY: test the bytes with the scrub's pattern again
    // (`new RegExp(URL_USERINFO_RE.source, "i").test(text)`) and this keep
    // runs for about a minute and fails on the suite's own time limit.
    const store = storeWithTask();
    const answer = `{"jsonrpc":"2.0","id":1,"result":"0x${"0123456789abcdef".repeat(25_000)}"}`;
    save(store, ".source-eth-call.json", answer);
    expect(keep(store, { file: ".source-eth-call.json", from: "cast call 0xdAC17F958D2ee523a2206206994597C13D831ec7 'name()'" })).toContain(
      `[kept] S1: eth-call.json, ${answer.length.toLocaleString("en-US")} bytes`,
    );
    // And the shape it looks for is still found past such a run.
    save(store, ".source-remotes.txt", `${"0123456789abcdef".repeat(25_000)}\norigin https://x-access-token:hunter2hunter2@github.com/acme/site.git\n`);
    expect(keep(store, { file: ".source-remotes.txt", from: "git remote -v" })).toContain(
      "holds what reads as an access token, so it is not kept",
    );
  });

  const stuck = [
    {
      what: "a kept source",
      body: "t3.medium $0.0416 per hour",
      reply:
        /^\[kept\] S2: aws-pricing\.html, 26 bytes, sha256 [0-9a-f]{12}\. It is a source now, not a file of the result\. The staged file `\.source-aws-pricing\.html` could not be removed from the attachments folder; nothing posts it, and you may delete it\. Say which claim S2 supports in your report or in a notes file beside the result\.$/,
      keeps: 2,
    },
    {
      what: "bytes the task already keeps",
      body: "page 1",
      reply:
        /^\[noop\] These bytes are already kept as S1 \("Page 1"\): cite S1\. The staged file `\.source-aws-pricing\.html` could not be removed from the attachments folder; nothing posts it, and you may delete it\.$/,
      keeps: 1,
    },
    {
      what: "a refused command output that prints a token",
      body: `Token: ${TOKEN}\n`,
      from: "gh auth status --show-token",
      reply:
        /^\[refused\] `\.source-aws-pricing\.html` holds what reads as an access token, so it is not kept\. It could not be removed from the attachments folder: delete it there yourself\. A source is kept as it is/,
      keeps: 1,
    },
  ];

  it.each(stuck)("says so when the staged file of $what cannot be removed", ({ body, from, reply, keeps }) => {
    // The folder is the agents' to write; a host where the server cannot
    // unlink there still keeps the source, and the answer does not claim a
    // removal that did not happen. CANARY: answer the same sentence whether
    // or not the unlink succeeded.
    const store = storeWithTask();
    keepEarlier(store, 1);
    save(store, ".source-aws-pricing.html", body);
    chmodSync(attachmentsDir(store), 0o555);
    try {
      expect(keep(store, from ? { from } : {})).toMatch(reply);
    } finally {
      chmodSync(attachmentsDir(store), 0o755);
    }
    expect(kept(store)).toHaveLength(keeps);
    expect(inFolder(store)).toEqual([".source-aws-pricing.html"]);
  });
});
