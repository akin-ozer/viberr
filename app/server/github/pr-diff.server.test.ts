import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { readPullRequestDiff } from "./pr-diff.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const FILES_ROUTE = "GET /repos/akin-ozer/viberr/pulls/7/files";

function configuredStore() {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
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
 * Ruling 266 (pass 37, F37-96): the controller can read what a pull request
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
    expect(missing.reason).toBeTruthy();

    const bad = await readPullRequestDiff(store.db, store.slug, 0, {
      fetchImpl: gh.fetchImpl,
    });
    expect(bad.ok).toBe(false);
    expect(gh.callsTo(FILES_ROUTE)).toHaveLength(1);
  });

  it("a project with no repository or no credential says which, and calls nothing", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({});
    const noCred = await readPullRequestDiff(store.db, store.slug, 7, {
      fetchImpl: gh.fetchImpl,
    });
    expect(noCred.ok).toBe(false);
    if (noCred.ok) return;
    expect(noCred.reason).toContain("credential");
    expect(gh.calls).toHaveLength(0);
  });
});
