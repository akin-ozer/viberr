import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { revokeProjectCompletionEffects } from "~/server/runtimes/run-completion-state.server";
import {
  deriveSyncState,
  ensureTaskBranch,
  taskBranchName,
  taskCommits,
} from "./branch-sync.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

function setupWithCredential(taskKey = "VIB-201", branch: string | null = null) {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, {
      title: "Attach execution workspace to task runtime",
      branch,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_branchsync0001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

function compareRoute(ahead: { sha: string; message: string }[], behindBy = 0) {
  return {
    body: {
      ahead_by: ahead.length,
      behind_by: behindBy,
      status: behindBy > 0 ? "diverged" : ahead.length ? "ahead" : "identical",
      commits: ahead.map((c) => ({ sha: c.sha, commit: { message: c.message } })),
    },
  };
}

describe("taskBranchName", () => {
  it("builds <key-lowercase>-<title-slug> capped at 4 words", () => {
    expect(
      taskBranchName("VIB-142", "Attach execution workspace to task runtime"),
    ).toBe("vib-142-attach-execution-workspace-to");
    expect(taskBranchName("VIB-9", "Şema — türkçe başlık!")).toBe(
      "vib-9-sema-turkce-baslik",
    );
    expect(taskBranchName("VIB-7", "···")).toBe("vib-7");
  });
});

describe("deriveSyncState (ruling 12: merged > behind > synced)", () => {
  it("maps the matrix", () => {
    expect(deriveSyncState({ prMerged: true, behindBy: 3 })).toBe("merged");
    expect(deriveSyncState({ prMerged: false, behindBy: 2 })).toBe("behind_main");
    expect(deriveSyncState({ prMerged: false, behindBy: 0 })).toBe("synced");
  });
});

describe("taskCommits ([VIB-n] prefix convention)", () => {
  it("keeps only task-key-prefixed commits (case-insensitive)", () => {
    const commits = [
      { sha: "a91f7c2", msg: "[VIB-142] add repo attach policy gate" },
      { sha: "4ce0b18", msg: "[vib-142] branch reconciler + task projection" },
      { sha: "12dd9af", msg: "chore: unrelated housekeeping" },
      { sha: "77aa001", msg: "[VIB-151] wrong task" },
    ];
    expect(taskCommits(commits, "VIB-142").map((c) => c.sha)).toEqual([
      "a91f7c2",
      "4ce0b18",
    ]);
  });
});

describe("ensureTaskBranch", () => {
  it("creates the branch from the default branch and writes it into task.md", async () => {
    const store = setupWithCredential();
    const branch = "vib-201-attach-execution-workspace-to";
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads%2F${branch}`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads%2Fmain`]: {
        body: { object: { sha: "basesha00" } },
      },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 201,
        body: { object: { sha: "basesha00" } },
      },
      [`GET ${REPO_PATH}/compare/main...${branch}`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", branch, created: true });
    // Branch name persisted into the canonical file + reprojected.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.frontmatter.branch).toBe(branch);
    const row = store.db
      .prepare(
        `SELECT branch FROM task_projections WHERE project_slug = ? AND task_key = 'VIB-201'`,
      )
      .get(store.slug) as { branch: string };
    expect(row.branch).toBe(branch);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)[0]!.body).toEqual({
      ref: `refs/heads/${branch}`,
      sha: "basesha00",
    });
    expect(listAuditEvents(store.db, { action: "github.branch.created" })).toHaveLength(1);
  });

  it("is idempotent: an existing branch is success without a create call", async () => {
    const store = setupWithCredential("VIB-202", "vib-202-existing");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads%2Fvib-202-existing`]: {
        body: { object: { sha: "headsha" } },
      },
      [`GET ${REPO_PATH}/compare/main...vib-202-existing`]: compareRoute(
        [{ sha: "a91f7c2aaaa", message: "[VIB-202] work" }],
        2,
      ),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-202" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", created: false });
    if (result.status === "synced") {
      expect(result.compare).toMatchObject({ aheadBy: 1, behindBy: 2 });
      expect(result.compare?.commits[0]).toEqual({
        sha: "a91f7c2",
        msg: "[VIB-202] work",
      });
    }
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "github.branch.created" })).toHaveLength(0);
  });

  it("treats a 422 'Reference already exists' race as success", async () => {
    const store = setupWithCredential("VIB-203", "vib-203-race");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads%2Fvib-203-race`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads%2Fmain`]: {
        body: { object: { sha: "basesha00" } },
      },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 422,
        body: { message: "Reference already exists" },
      },
      [`GET ${REPO_PATH}/compare/main...vib-203-race`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-203" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", created: false });
  });

  it("403 creating the ref opens a `repo` scope violation carried by the task", async () => {
    const store = setupWithCredential("VIB-204", "vib-204-forbidden");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads%2Fvib-204-forbidden`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads%2Fmain`]: {
        body: { object: { sha: "basesha00" } },
      },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-204" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("scope_violation");
    const violation = findOpenScopeViolation(store.db, store.slug, "repo", "VIB-204");
    expect(violation).not.toBeNull();
    // Typed policy event written into the task file.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-204",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.timeline[0]).toMatchObject({
      type: "policy",
      text: expect.stringContaining("**Policy violation:** active PAT is missing `repo`."),
    });
  });

  it("degrades typed without a PAT / repo / default branch", async () => {
    // No PAT bound.
    const bare = setupTestStore(ctx);
    writeTask(bare.dataRoot, bare.slug, {
      frontmatter: baseTaskFrontmatter("VIB-205"),
    });
    rebuildAll(bare.db, { dataRoot: bare.dataRoot });
    expect(
      await ensureTaskBranch(
        bare.db,
        { projectSlug: bare.slug, taskKey: "VIB-205" },
        ACTOR,
        { dataRoot: bare.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pat_configured", repo: "akin-ozer/viberr" });

    // Default branch missing on the remote.
    const store = setupWithCredential("VIB-206", "vib-206-x");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads%2Fvib-206-x`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads%2Fmain`]: {
        status: 404,
        body: { message: "Not Found" },
      },
    });
    expect(
      await ensureTaskBranch(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-206" },
        ACTOR,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
      ),
    ).toEqual({ status: "default_branch_missing", defaultBranch: "main" });

    // Unknown task.
    expect(
      await ensureTaskBranch(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-999" },
        ACTOR,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "task_not_found" });
  });

  it("does not create or attach the old branch after a same-key task replacement", async () => {
    const store = setupWithCredential("VIB-207");
    const old = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-207",
      dataRoot: store.dataRoot,
    })!;
    const branch = taskBranchName("VIB-207", old.parsed.frontmatter.title);
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      calls.push(key);
      if (key === `GET ${REPO_PATH}/git/ref/heads%2F${branch}`) {
        markLookupStarted();
        await lookupGate;
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (key === `GET ${REPO_PATH}/git/ref/heads%2Fmain`) {
        return Response.json({ object: { sha: "basesha00" } });
      }
      if (key === `POST ${REPO_PATH}/git/refs`) {
        return Response.json(
          { object: { sha: "basesha00" } },
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const pending = ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-207" },
      ACTOR,
      {
        dataRoot: store.dataRoot,
        fetchImpl,
        taskLifecycle: {
          expectedCreatedAt: old.parsed.frontmatter.createdAt!,
        },
      },
    );
    await lookupStarted;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-207", {
        title: "Replacement task",
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T12:00:00.000Z",
      }),
    });
    releaseLookup();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).not.toContain(`POST ${REPO_PATH}/git/refs`);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-207",
        dataRoot: store.dataRoot,
      })?.parsed.frontmatter.branch,
    ).toBeNull();
    expect(
      listAuditEvents(store.db, { action: "github.branch.created" }),
    ).toHaveLength(0);
  });

  it("stops delayed branch creation when project lifecycle ownership is revoked", async () => {
    const store = setupWithCredential("VIB-208");
    const branch = taskBranchName(
      "VIB-208",
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-208",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.title,
    );
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      calls.push(key);
      if (key === `GET ${REPO_PATH}/git/ref/heads%2F${branch}`) {
        markLookupStarted();
        // Deliberately ignore AbortSignal here: the post-await ownership check
        // must still stop a transport that cannot cancel promptly.
        await lookupGate;
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ object: { sha: "basesha00" } });
    }) as typeof fetch;

    const pending = ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-208" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl },
    );
    await lookupStarted;
    revokeProjectCompletionEffects(store.db, store.slug);
    releaseLookup();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).not.toContain(`POST ${REPO_PATH}/git/refs`);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-208",
        dataRoot: store.dataRoot,
      })?.parsed.frontmatter.branch,
    ).toBeNull();
    expect(
      listAuditEvents(store.db, { action: "github.branch.created" }),
    ).toHaveLength(0);
  });
});
