import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import type { PrRef } from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { readTaskChanges } from "./task-changes.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * Ruling 484 (pass 40, F40-54): the Changes panel's read. A person saw
 * `Diff N files · +a −d` and nothing to read; this is the delivered revision's
 * files and patches, bound to that revision, with who a note would reach.
 */

const REPO = "/repos/akin-ozer/viberr";
const HEAD = "a91f7c2000000000000000000000000000000000";

let ctx: TestDbContext;
let store: TestStore;

function writeTaskWith(pr: PrRef | null, delivered = true): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-9", {
      stage: "review",
      branch: "vib-9",
      engagements: [
        { profileId: "developer", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
      ],
      pr,
      workRevision: delivered
        ? {
            id: "rev_9",
            headSha: HEAD,
            treeSha: null,
            branch: "vib-9",
            createdAt: "2026-09-24T08:00:00Z",
            sourceProfileId: "developer",
            kind: "delivered",
          }
        : null,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
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
        profileId: "developer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "Developer",
          role: "developer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      },
    ],
  });
  writeTaskWith({ number: 21, state: "review", title: "VIB-9" });
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_changes001" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
});
afterEach(() => ctx.cleanup());

const detail = (sha: string) => ({ body: { number: 21, head: { sha } } });
const FILES = {
  body: [
    { filename: "notes/one.md", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
  ],
};

function read(fetchImpl: typeof fetch, path: string | null = null) {
  return readTaskChanges(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-9", path },
    { dataRoot: store.dataRoot, fetchImpl },
  );
}

describe("ruling 484: readTaskChanges", () => {
  it("reads the delivered revision's files and names who a note reaches", async () => {
    const gh = fakeGithubFetch({
      [`GET ${REPO}/pulls/21`]: detail(HEAD),
      [`GET ${REPO}/pulls/21/files`]: FILES,
    });
    const view = await read(gh.fetchImpl);
    expect(view).toMatchObject({
      ok: true,
      prNumber: 21,
      repo: "akin-ozer/viberr",
      headSha: HEAD,
      moreFiles: false,
      truncated: false,
      recipient: { name: "Developer", handle: "developer" },
    });
    if (!view?.ok) return;
    expect(view.files.map((f) => [f.path, f.patchOmitted])).toEqual([
      ["notes/one.md", null],
      ["logo.png", "none-from-github"],
    ]);
  });

  it("never shows a PR that is elsewhere as the delivered work, and says what to do", async () => {
    const elsewhere = fakeGithubFetch({
      [`GET ${REPO}/pulls/21`]: detail("0bad0000"),
      [`GET ${REPO}/pulls/21/files`]: FILES,
    });
    expect(await read(elsewhere.fetchImpl)).toEqual({
      ok: false,
      reason:
        "PR #21 is at 0bad000, not the delivered revision a91f7c2, so its changes are not the ones delivered. The next status check records the new head as the revision under review.",
    });
    writeTaskWith({
      number: 21,
      state: "review",
      title: "VIB-9",
      unpushedRevision: { revisionSha: HEAD, prHeadSha: "0bad0000", relation: "behind" },
    });
    expect(await read(elsewhere.fetchImpl)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not carry the delivered revision a91f7c2 yet. Push it"),
    });
    expect(elsewhere.callsTo(`GET ${REPO}/pulls/21/files`)).toHaveLength(0);
  });

  it("says there is nothing to read before a delivery or a pull request, and calls nothing", async () => {
    const gh = fakeGithubFetch({});
    writeTaskWith(null);
    expect(await read(gh.fetchImpl)).toMatchObject({ ok: false, reason: expect.stringContaining("not on a pull request yet") });
    writeTaskWith({ number: 21, state: "review", title: "VIB-9" }, false);
    expect(await read(gh.fetchImpl)).toMatchObject({ ok: false, reason: "Nothing is delivered on VIB-9 yet, so there are no changes to read." });
    expect(gh.calls).toHaveLength(0);
  });

  it("reads one file by path, and answers null for a task that does not exist", async () => {
    const gh = fakeGithubFetch({
      [`GET ${REPO}/pulls/21`]: detail(HEAD),
      [`GET ${REPO}/pulls/21/files`]: FILES,
    });
    const one = await read(gh.fetchImpl, "notes/one.md");
    expect(one?.ok && one.files.map((f) => f.path)).toEqual(["notes/one.md"]);
    expect(
      await readTaskChanges(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-404", path: null },
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
      ),
    ).toBeNull();
  });
});
