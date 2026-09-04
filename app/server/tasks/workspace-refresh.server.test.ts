import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import {
  createLocalOrigin,
  gitOut,
  withLocalGithub,
  type LocalOrigin,
} from "../../../test-support/git-origin";
import { describeWorkspaceRefresh, refreshWorkspaceFromMirror } from "./workspace-refresh.server";

/**
 * Ruling 129 (pass 34, F34-6): a reused checkout is refreshed from the
 * project mirror on every dispatch — real git against a local origin.
 */
const exec = promisify(execFile);
const REPO = "akin-ozer/viberr";

describe("refreshWorkspaceFromMirror (ruling 129)", () => {
  let ctx: TestDbContext;
  let store: TestStore;
  let origins: string;
  let origin: LocalOrigin;

  beforeEach(async () => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    origins = ctx.makeTempDir();
    origin = await createLocalOrigin(origins, { repo: REPO });
  });
  afterEach(() => ctx.cleanup());

  const refresh = (dir: string, fastForward = true) =>
    withLocalGithub(origins, () =>
      refreshWorkspaceFromMirror(store.db, {
        projectSlug: store.slug,
        repo: REPO,
        dir,
        defaultBranch: "main",
        dataRoot: store.dataRoot,
        fastForward,
      }),
    );

  /** A checkout of the origin AS IT STANDS, with `origin` pointing at the
   *  sanitized GitHub URL exactly as Viberr's clone leaves it. */
  async function checkout(name: string): Promise<string> {
    const dir = path.join(ctx.makeTempDir(), name);
    await withLocalGithub(origins, () =>
      exec("git", ["clone", "-q", `https://github.com/${REPO}`, dir]),
    );
    await exec("git", ["-C", dir, "config", "user.email", "t@t.dev"]);
    await exec("git", ["-C", dir, "config", "user.name", "T"]);
    return dir;
  }

  it("an unborn checkout cloned from an empty origin is fast-forwarded once the origin has a default branch", async () => {
    // Canary: skip the `checkout -B` step (return `fetched` for the unborn
    // arm) and HEAD stays unborn.
    const emptyOrigins = ctx.makeTempDir();
    await createLocalOrigin(emptyOrigins, { repo: REPO, empty: true });
    const dir = path.join(ctx.makeTempDir(), "unborn");
    await withLocalGithub(emptyOrigins, () =>
      exec("git", ["clone", "-q", `https://github.com/${REPO}`, dir]),
    );
    // The clone is unborn (no HEAD commit); the origin now gains `main`.
    await expect(gitOut(dir, ["rev-parse", "--verify", "HEAD"])).rejects.toBeTruthy();
    const nowOrigin = await createLocalOrigin(emptyOrigins, { repo: REPO });
    void nowOrigin;
    const result = await withLocalGithub(emptyOrigins, () =>
      refreshWorkspaceFromMirror(store.db, {
        projectSlug: store.slug,
        repo: REPO,
        dir,
        defaultBranch: "main",
        dataRoot: store.dataRoot,
        fastForward: true,
      }),
    );
    expect(result.status).toBe("fast_forwarded");
    if (result.status !== "fast_forwarded") throw new Error("unreachable");
    expect(result.from).toBe("unborn");
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(result.head);
    expect(await gitOut(dir, ["log", "--oneline"])).toContain("init");
    expect(describeWorkspaceRefresh(result, "main")).toContain("fast-forwarded the unborn checkout");
  });

  it("a clean checkout behind the origin is fast-forwarded; one with local commits is not", async () => {
    // Canary: replace `merge --ff-only` with `reset --hard` and the
    // local-commits checkout loses its commit (the second assertion fails).
    const behind = await checkout("behind");
    const advanced = await origin.advance({ message: "second" });
    const result = await refresh(behind);
    expect(result).toMatchObject({ status: "fast_forwarded", from: "behind", head: advanced });
    expect(await gitOut(behind, ["rev-parse", "HEAD"])).toBe(advanced);

    const local = await checkout("local");
    writeFileSync(path.join(local, "LOCAL.md"), "mine\n");
    await exec("git", ["-C", local, "add", "-A"]);
    await exec("git", ["-C", local, "commit", "-qm", "local work"]);
    const localHead = await gitOut(local, ["rev-parse", "HEAD"]);
    await origin.advance({ message: "third" });
    const kept = await refresh(local);
    expect(kept).toMatchObject({ status: "fetched", head: "local_commits" });
    expect(await gitOut(local, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(await gitOut(local, ["log", "--oneline"])).toContain("local work");
    // The refs DID move: origin/main now carries the third commit.
    expect(await gitOut(local, ["log", "--oneline", "origin/main"])).toContain("third");
  });

  it("a task branch is fetched but never moved; a dirty tree is never touched", async () => {
    // Canary: drop the `status --porcelain` check and the dirty checkout is
    // fast-forwarded (its `head` reads `fast_forwarded`, not `dirty`).
    const task = await checkout("task");
    await exec("git", ["-C", task, "checkout", "-q", "-b", "vib-9"]);
    writeFileSync(path.join(task, "WORK.md"), "work\n");
    await exec("git", ["-C", task, "add", "-A"]);
    await exec("git", ["-C", task, "commit", "-qm", "[VIB-9] work"]);
    const taskHead = await gitOut(task, ["rev-parse", "HEAD"]);
    await origin.advance({ message: "base moved" });
    const result = await refresh(task);
    expect(result).toMatchObject({ status: "fetched", head: "task_branch" });
    expect(await gitOut(task, ["rev-parse", "HEAD"])).toBe(taskHead);
    expect(await gitOut(task, ["log", "--oneline", "origin/main"])).toContain("base moved");

    const dirty = await checkout("dirty");
    writeFileSync(path.join(dirty, "README.md"), "edited but not committed\n");
    const dirtyResult = await refresh(dirty);
    expect(dirtyResult).toMatchObject({ status: "fetched", head: "dirty" });
    expect(await gitOut(dirty, ["status", "--porcelain"])).toContain("README.md");
  });

  it("a branch that shares no history with `origin/<default>` reads `unrelated` and says so", async () => {
    // Canary: fold `unrelated` into `task_branch` and the head assertion fails.
    const dir = await checkout("unrelated");
    // Rewrite the branch as an orphan root commit — the live JC-2/JC-5 damage.
    await exec("git", ["-C", dir, "checkout", "-q", "--orphan", "vib-2"]);
    await exec("git", ["-C", dir, "rm", "-rfq", "."]);
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "spec.md"), "spec\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "[VIB-2] unrelated root"]);
    const head = await gitOut(dir, ["rev-parse", "HEAD"]);
    const result = await refresh(dir);
    expect(result).toMatchObject({ status: "fetched", head: "unrelated" });
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(describeWorkspaceRefresh(result, "main")).toContain("shares NO history");
    expect(describeWorkspaceRefresh(result, "main")).toContain("update_branch_from_base will refuse");
  });

  it("a supporting (fetch-only) refresh moves origin/* and nothing else", async () => {
    // The mirror exists because a DELIVERING dispatch built it (a fetch-only
    // refresh never pays a network clone, `create: false`).
    await refresh(await checkout("deliverer"));
    const dir = await checkout("support");
    const advanced = await origin.advance({ message: "support base" });
    const before = await gitOut(dir, ["rev-parse", "HEAD"]);
    const result = await refresh(dir, false);
    expect(result).toMatchObject({ status: "fetched", head: "not_requested" });
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(await gitOut(dir, ["rev-parse", "origin/main"])).toBe(advanced);
  });

  it("no mirror but a bound credential falls back to a direct fetch under the askpass env", async () => {
    // Canary: return `no_mirror` without attempting the fallback and the
    // status assertion fails.
    const { createPat, setProjectCredential } = await import("~/server/secrets/pat-store.server");
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_refresh0001" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const dir = await checkout("fallback");
    const advanced = await origin.advance({ message: "fallback base" });
    const result = await withLocalGithub(origins, () =>
      refreshWorkspaceFromMirror(store.db, {
        projectSlug: store.slug,
        repo: REPO,
        dir,
        defaultBranch: "main",
        dataRoot: store.dataRoot,
        fastForward: true,
        createMirror: false,
      }),
    );
    expect(result).toMatchObject({ status: "fast_forwarded", head: advanced, mirrorRefreshed: true });
  });

  it("no mirror and no credential is `no_mirror`; a broken fetch degrades to `fetch_failed`", async () => {
    // Canary: return `no_mirror` without attempting the fallback fetch — the
    // credentialed-fallback half is covered by the mirror path above (a
    // `create: true` refresh builds the mirror), so this case asserts the
    // honest degradation: a checkout whose origin cannot be reached reports
    // `fetch_failed` with the redacted reason, never a throw.
    const dir = await checkout("broken");
    // Point the checkout AND the mirror lookup at a directory that does not exist.
    const missing = path.join(ctx.makeTempDir(), "gone");
    const result = await withLocalGithub(missing, () =>
      refreshWorkspaceFromMirror(store.db, {
        projectSlug: store.slug,
        repo: REPO,
        dir,
        defaultBranch: "main",
        dataRoot: store.dataRoot,
        fastForward: true,
        createMirror: false,
      }),
    );
    // No cached mirror, `createMirror: false`, no credential bound: no_mirror.
    expect(result.status).toBe("no_mirror");
    expect(describeWorkspaceRefresh(result, "main")).toContain("no project mirror");

    // A mirror exists (built by a delivering refresh) but the checkout itself is
    // broken: git fails, and the refresh says so instead of throwing.
    await refresh(await checkout("builder"));
    const broken = await checkout("broken-tree");
    writeFileSync(path.join(broken, ".git", "config"), "[core]\n\trepositoryformatversion = 99\n");
    const failed = await refresh(broken);
    expect(failed.status).toBe("fetch_failed");
    expect(describeWorkspaceRefresh(failed, "main")).toContain("not refreshed:");
  });
});
