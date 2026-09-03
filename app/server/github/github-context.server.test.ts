import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  setupTestStore,
  writeProject,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createPat,
  deletePat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { getProjectGithubContext } from "./github-context.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

/**
 * `getProjectGithubContext` is the entry gate EVERY project-scoped GitHub call
 * resolves through, and the contract every one of those callers is written
 * against is: without a repository or a usable credential it returns a TYPED
 * DEGRADED value and NOTHING THROWS. A loader that renders the board, the
 * operator loop that opens a PR and the reconciler poller all call it on paths
 * where a throw is a 500 on a page that has nothing to do with GitHub.
 *
 * The second thing it owes callers is provenance: the client it hands back must
 * authenticate as the credential bound to THAT project
 * (`project_github_credentials`) — never a store-wide "first PAT we found"
 * default — and the `patId` it reports must be the PAT that actually made the
 * call, because `markWriteScopeProven` (F28-U2b) stamps "proven" onto exactly
 * that id.
 */

/** setupTestStore seeds `viberr-core` with repo akin-ozer/viberr on `main`. */
function seeded(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

/** Rewrites the seeded project.md with fields changed, then re-projects. */
function reproject(store: TestStore, patch: Partial<ProjectFrontmatter>): void {
  const file = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  writeProject(store.dataRoot, { ...file.parsed.frontmatter, ...patch });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** A SECOND project in the same store, so "which project's credential?" is a
 *  question with a wrong answer available. */
function secondProject(store: TestStore, slug: string, repo: string): void {
  const file = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    name: `Other ${slug}`,
    slug,
    repo,
    taskPrefix: "OTH",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Stores a PAT and binds it to `projectSlug`; returns its id. */
function bindPat(store: TestStore, projectSlug: string, token: string): string {
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: `bot-${token.slice(-4)}`, token },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug, patId: pat.id }, ACTOR);
  return pat.id;
}

/** The `Authorization` header the context's client actually puts on the wire.
 *  Reading the header (rather than the options object) is the only assertion
 *  that proves the bound token reached GitHub, which is the whole point of the
 *  ok arm. */
async function authHeaderFor(
  db: TestStore["db"],
  projectSlug: string,
): Promise<string | undefined> {
  const gh = fakeGithubFetch({ "GET /user": { body: { login: "octocat" } } });
  const context = getProjectGithubContext(db, projectSlug, {
    fetchImpl: gh.fetchImpl,
  });
  if (context.status !== "ok") return undefined;
  await context.client.request("GET", "/user", z.object({ login: z.string() }));
  return gh.calls[0]?.headers.authorization;
}

describe("getProjectGithubContext — degraded: no repository", () => {
  it("a repo-less project degrades to no_repo_configured even with a usable credential bound", () => {
    // The repo check comes FIRST and is the whole answer: planning-only projects
    // are legitimate (R17-2 / the no-change-completion `no_repo` basis), and such
    // a project must never be reported as a CREDENTIAL problem — that sends an
    // admin off to mint a PAT for a project that will never talk to GitHub.
    const store = seeded();
    bindPat(store, store.slug, "ghp_context_repoless01");
    reproject(store, { repo: null });

    const context = getProjectGithubContext(store.db, store.slug);
    // Exact equality: the no-repo arm carries NO repo field to render.
    expect(context).toEqual({ status: "no_repo_configured" });
  });

  it("an unknown project slug degrades instead of throwing", () => {
    // Loaders hand this the slug straight off the URL. A deleted or mistyped
    // project has to come back as a degraded value like any other missing
    // configuration; a throw here is a 500 on a page render.
    const store = seeded();
    expect(
      getProjectGithubContext(store.db, "no-such-project-ever"),
    ).toEqual({ status: "no_repo_configured" });
  });
});

describe("getProjectGithubContext — degraded: no usable credential", () => {
  it("no_pat_configured carries the repo, and never borrows another project's PAT", () => {
    // Two properties in one: the degraded value names the repository the surface
    // cannot reach (the card says WHICH repo is unauthenticated), and a project
    // with no binding of its own stays degraded even though the store holds a
    // perfectly good PAT bound elsewhere. The credential is per-project
    // (`project_github_credentials`); there is no store-wide fallback and no org
    // connection to fall back to.
    const store = seeded();
    secondProject(store, "other-core", "akin-ozer/other");
    bindPat(store, "other-core", "ghp_context_otherproj1");

    const gh = fakeGithubFetch({});
    expect(
      getProjectGithubContext(store.db, store.slug, { fetchImpl: gh.fetchImpl }),
    ).toEqual({ status: "no_pat_configured", repo: "akin-ozer/viberr" });
    // And nothing was attempted over the wire on a degraded resolve.
    expect(gh.calls).toHaveLength(0);
  });

  it("deleting the bound PAT revokes the context on the very next call", () => {
    // The context is resolved PER CALL, not cached at boot: revoking a
    // credential has to take effect immediately, or a deleted PAT keeps
    // authorizing writes until the process restarts.
    const store = seeded();
    const patId = bindPat(store, store.slug, "ghp_context_revoked001");
    expect(getProjectGithubContext(store.db, store.slug).status).toBe("ok");

    deletePat(store.db, patId, ACTOR);

    expect(getProjectGithubContext(store.db, store.slug)).toEqual({
      status: "no_pat_configured",
      repo: "akin-ozer/viberr",
    });
  });

  it("a bound credential whose stored secret cannot be read degrades — it never builds an ANONYMOUS client", () => {
    // The nastiest failure this guard prevents is SILENT. `createGithubClient`
    // treats a null token as "anonymous" on purpose (public reads at GitHub's
    // 60/hr IP quota), so dropping the `token === null` half of the check does
    // not error — it hands back a status:"ok" context whose every call is
    // unauthenticated, which 404s a private repo as if it did not exist.
    // Degrading is the only honest answer when the credential row is there but
    // its secret will not open.
    const store = seeded();
    bindPat(store, store.slug, "ghp_context_unreadable");
    // A stored secret this reader cannot decode. `getPatToken` answers null for
    // it, exactly as it does for a box that is not a string at all.
    store.db
      .prepare(`UPDATE github_pats SET encrypted_token = ?`)
      .run(new Uint8Array([0, 255, 17]));

    expect(getProjectGithubContext(store.db, store.slug)).toEqual({
      status: "no_pat_configured",
      repo: "akin-ozer/viberr",
    });
  });
});

describe("getProjectGithubContext — ok", () => {
  it("resolves the repo, its owner, the project's default branch and the authorizing pat id", () => {
    // `owner` is split off the repo here ONCE so no caller re-derives it, and
    // `defaultBranch` is the PROJECT's branch (project.md is canonical) — a
    // project that develops on `develop` must not have its PRs based on `main`.
    // `patId` is the F28-U2b anchor: markWriteScopeProven stamps the PAT that
    // actually made the call, so it has to be the one this context authorized.
    const store = seeded();
    reproject(store, { defaultBranch: "develop" });
    const patId = bindPat(store, store.slug, "ghp_context_okarm00001");

    const context = getProjectGithubContext(store.db, store.slug);
    expect(context.status).toBe("ok");
    if (context.status !== "ok") return;
    expect(context.repo).toBe("akin-ozer/viberr");
    expect(context.owner).toBe("akin-ozer");
    expect(context.defaultBranch).toBe("develop");
    expect(context.patId).toBe(patId);
  });

  it("the client it hands back authenticates as THIS project's credential", () => {
    // Provenance, asserted on the wire. Two projects, two different stored
    // tokens: each context must send its own project's binding. A resolver that
    // reached for a store-wide default (or the first row in `github_pats`) would
    // still return status:"ok" everywhere and would still pass every
    // shape-checking test — it would just be pushing to one customer's repo with
    // another's credential.
    const store = seeded();
    secondProject(store, "other-core", "akin-ozer/other");
    bindPat(store, store.slug, "ghp_context_mine000001");
    bindPat(store, "other-core", "ghp_context_theirs0001");

    return Promise.all([
      authHeaderFor(store.db, store.slug),
      authHeaderFor(store.db, "other-core"),
    ]).then(([mine, theirs]) => {
      expect(mine).toBe("Bearer ghp_context_mine000001");
      expect(theirs).toBe("Bearer ghp_context_theirs0001");
    });
  });

  it("re-binding the project's credential changes both the token on the wire and the reported patId", () => {
    // Credential rotation is a live operation (an expired PAT gets replaced
    // mid-flight). Both halves have to move together: if the client kept the old
    // token while `patId` reported the new one, markWriteScopeProven would stamp
    // "pull_request:write proven" onto a PAT that made no call at all — the exact
    // confusion F28-U2b exists to prevent.
    const store = seeded();
    bindPat(store, store.slug, "ghp_context_first00001");
    const second = bindPat(store, store.slug, "ghp_context_second0001");

    const context = getProjectGithubContext(store.db, store.slug);
    expect(context.status === "ok" && context.patId).toBe(second);
    return authHeaderFor(store.db, store.slug).then((header) => {
      expect(header).toBe("Bearer ghp_context_second0001");
    });
  });

  it("an empty default_branch falls back to main rather than an empty ref", () => {
    // Callers concatenate this straight into refs (`heads/${defaultBranch}`), so
    // a blank value is worse than a wrong one — it produces a ref that GitHub
    // answers about some other resource entirely. The `||` is load-bearing; a
    // `??` here would let the empty string through.
    const store = seeded();
    bindPat(store, store.slug, "ghp_context_blankbr001");
    store.db
      .prepare(`UPDATE projects SET default_branch = '' WHERE slug = ?`)
      .run(store.slug);

    const context = getProjectGithubContext(store.db, store.slug);
    expect(context.status === "ok" && context.defaultBranch).toBe("main");
  });
});

