import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { writeProject } from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { readPullRequestDiff } from "./pr-diff.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const FILES_ROUTE = "GET /repos/akin-ozer/viberr/pulls/7/files";

function configuredStore() {
  const store = setupProjectedStore(ctx);
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_prdiff01" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
  return store;
}

/** One `pulls/{n}/files` row as GitHub sends it. `patch` is ABSENT (not null)
 *  on a binary file, which is the distinction under test. */
interface GithubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

function file(
  name: string,
  patch: string | null,
  extra: Partial<GithubPrFile> = {},
): GithubPrFile {
  const row: GithubPrFile = {
    filename: name,
    status: "modified",
    additions: 3,
    deletions: 1,
    changes: 4,
    ...extra,
  };
  if (patch !== null) row.patch = patch;
  return row;
}

/**
 * Ruling 265 (pass 37, F37-96): the controller can read what a pull request
 * CHANGED. Asked to judge three open PRs it had a filename list and a line
 * count, and said so: "I can commission a review; I cannot check one."
 */
describe("readPullRequestDiff — the hunks, bounded, and honest about what it cut", () => {
  it("returns every changed file with its patch, and carries the sealed token nowhere", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: { body: [file("a.ts", "@@ -1 +1 @@\n-x\n+y"), file("b.ts", "@@ -2 +2 @@\n-p\n+q")] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repo).toBe("akin-ozer/viberr");
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.files[0]!.patch).toContain("+y");
    expect(result.moreFiles).toBe(false);
    expect(result.truncated).toBe(false);
    // Server-mediated, exactly like `runAgentGithubRead`: the request is made
    // with the project's sealed PAT and the token never crosses back.
    expect(gh.callsTo(FILES_ROUTE)[0]!.headers["authorization"]).toBe("Bearer ghp_prdiff01");
    expect(JSON.stringify(result)).not.toContain("ghp_prdiff01");
  });

  it("withholds patches for the byte budget but still LISTS the file, and says it cut", async () => {
    const store = configuredStore();
    const big = "@@\n".concat("+line\n".repeat(400));
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: { body: [file("first.ts", big), file("second.ts", big)] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      maxPatchBytes: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CANARY: drop the row when the budget runs out (`continue` instead of
    // flagging) and the reply reads as a PR that does not touch second.ts —
    // a silent truncation presented as a complete answer.
    expect(result.files.map((f) => f.path)).toEqual(["first.ts", "second.ts"]);
    expect(result.files[1]!.patch).toBeNull();
    expect(result.files[1]!.patchOmitted).toBe("budget");
    expect(result.files[1]!.additions).toBe(3);
    expect(result.truncated).toBe(true);
  });

  /**
   * Ruling 269 (pass 37, F37-98). The first version budgeted RAW patch
   * characters against 120 KB. The reply is JSON, where every newline in a diff
   * becomes `\n` and every quote `\"`, so a hunk roughly doubles on the way
   * out. Live, PR #32's four files came back as 83,196 bytes with
   * `patchesWithheldForSize: false` — this guard never fired, and the Agent
   * SDK's own offload caught it instead, writing the result to a file and
   * telling a model with no filesystem tool to read it in chunks.
   */
  it("spends the budget in ENCODED characters, which is what the reply carries", async () => {
    const store = configuredStore();
    // A patch whose RAW length is under the budget and whose JSON encoding is
    // over it: every character is a newline, and each becomes two.
    const raw = "\n".repeat(600);
    const gh = fakeGithubFetch({ [FILES_ROUTE]: { body: [file("a.ts", raw), file("b.ts", raw)] } });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      maxPatchBytes: 1_300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CANARY: spend `f.patch.length` again and BOTH patches fit under 1,300 by
    // the raw count while the reply carries over 2,400 — the guard reports
    // nothing withheld and the reply is twice the size it was bounded to.
    expect(result.files[0]!.patch).not.toBeNull();
    expect(result.files[1]!.patchOmitted).toBe("budget");
    expect(result.truncated).toBe(true);
    // The measurable claim: what the reply actually carries stays under the
    // budget it was given.
    const carried = result.files.reduce(
      (n, f) => n + (f.patch === null ? 0 : JSON.stringify(f.patch).length),
      0,
    );
    expect(carried).toBeLessThanOrEqual(1_300);
  });

  it("`patches: false` lists every file with no hunks, and is not a truncation", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: { body: [file("a.ts", "@@ a"), file("b.ts", "@@ b")] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      patches: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The loop this closes: `path` needs the file list, and the only way to get
    // the list used to be asking for every patch — the call most likely to be
    // too big. CANARY: drop the `patches === false` arm and the safe first call
    // is the unsafe one again.
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.files.every((f) => f.patch === null)).toBe(true);
    expect(result.files.every((f) => f.patchOmitted === "not-requested")).toBe(true);
    // Nothing was cut from under the caller, so nothing claims it was.
    expect(result.truncated).toBe(false);
    expect(result.files[0]!.additions).toBe(3);
  });

  it("tells a binary file apart from a budget cut", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: { body: [file("logo.png", null, { status: "added" })] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CANARY: collapse both to a bare `patch: null` and a reader cannot tell
    // "GitHub has no diff for this" from "we ran out of room".
    expect(result.files[0]!.patchOmitted).toBe("none-from-github");
    expect(result.truncated).toBe(false);
  });

  it("`path` narrows to one file, including by its pre-rename name", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: {
        body: [
          file("a.ts", "@@ a"),
          file("new.ts", "@@ b", { status: "renamed", previous_filename: "old.ts" }),
        ],
      },
    });
    const only = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      path: "new.ts",
    });
    expect(only.ok).toBe(true);
    if (!only.ok) return;
    expect(only.files.map((f) => f.path)).toEqual(["new.ts"]);
    expect(only.files[0]!.renamedFrom).toBe("old.ts");
    // A rename is the case where the path a reader knows is not the path the
    // PR lists, so the old name has to find it too.
    const byOld = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      path: "old.ts",
    });
    expect(byOld.ok).toBe(true);
    if (!byOld.ok) return;
    expect(byOld.files.map((f) => f.path)).toEqual(["new.ts"]);
  });

  it("a PR with more files than the page cap says so instead of ending quietly", async () => {
    const store = configuredStore();
    // Every page full through the cap: GitHub has at least one more.
    const full = Array.from({ length: 100 }, (_, i) => file(`f${i}.ts`, "@@ x"));
    const gh = fakeGithubFetch({ [FILES_ROUTE]: { body: full } });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      maxPatchBytes: 1_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CANARY: return `moreFiles: false` unconditionally and a 900-file PR
    // reads as a 600-file one, with nothing saying the list ends early.
    expect(result.moreFiles).toBe(true);
    expect(result.files).toHaveLength(600);
  });

  it("surfaces GitHub's own failure, and refuses a nonsense number without a request", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [FILES_ROUTE]: { status: 404, body: { message: "Not Found" } },
    });
    const missing = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    // GitHub's own words, not a generic failure.
    expect(missing.reason).toBe("Not Found");

    const bad = await readPullRequestDiff(store.db, store.slug, 0, {
      fetchImpl: gh.fetchImpl,
    });
    expect(bad.ok).toBe(false);
    expect(gh.callsTo(FILES_ROUTE)).toHaveLength(1);
  });

  it("a project with no repository or no credential says which, and calls nothing", async () => {
    const store = setupProjectedStore(ctx);
    const gh = fakeGithubFetch({});
    // CANARY: word both refusals the same and one of these names the wrong gap.
    expect(
      await readPullRequestDiff(store.db, store.slug, 7, { fetchImpl: gh.fetchImpl }),
    ).toEqual({ ok: false, reason: "no GitHub credential is configured for this project" });

    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
      .frontmatter;
    writeProject(store.dataRoot, { ...fm, repo: null });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(
      await readPullRequestDiff(store.db, store.slug, 7, { fetchImpl: gh.fetchImpl }),
    ).toEqual({ ok: false, reason: "no repository is configured for this project" });
    expect(gh.calls).toHaveLength(0);
  });
});

/**
 * Ruling 246 (pass 40, F40-54): the task page's Changes panel reads the same
 * diff for a person, BOUND to the delivered revision. `pulls/{n}/files` always
 * describes the PR's current head, so without the bind a person noting lines
 * for the deliverer could be reading a push nobody delivered.
 */
describe("ruling 246: a diff read bound to a head", () => {
  const DETAIL_ROUTE = "GET /repos/akin-ozer/viberr/pulls/7";

  it("reads the files when the pull request is at that head", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [DETAIL_ROUTE]: { body: { number: 7, head: { sha: "abc1234def" } } },
      [FILES_ROUTE]: { body: [file("a.ts", "@@ -1 +1 @@\n-x\n+y")] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      headSha: "abc1234def",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("answers the head the PR is really at, and lists no files, when it is elsewhere", async () => {
    const store = configuredStore();
    const gh = fakeGithubFetch({
      [DETAIL_ROUTE]: { body: { number: 7, head: { sha: "9999999aaa" } } },
      [FILES_ROUTE]: { body: [file("a.ts", "@@ -1 +1 @@\n-x\n+y")] },
    });
    const result = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
      headSha: "abc1234def",
    });
    expect(result).toMatchObject({ ok: false, liveHeadSha: "9999999aaa" });
    expect(gh.callsTo(FILES_ROUTE)).toHaveLength(0);
  });
});
