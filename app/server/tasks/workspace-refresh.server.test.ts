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

  it("ruling 179: a clean task-branch checkout strictly behind origin's copy is fast-forwarded; a DIVERGED one is not", async () => {
    // Canary: delete the `behind_task_branch` arm (let every non-default branch
    // fall through to `task_branch`) and the first head assertion fails — the
    // rework starts from the stale head, which is the dead end HLC-18 hit live
    // on 2026-09-11: the delivery of the rework was refused as non-fast-forward
    // ("delete or rename the remote branch, or force-push") for work the ruling
    // had just declared the revision under review.
    const refreshTask = (dir: string, taskBranch: string) =>
      withLocalGithub(origins, () =>
        refreshWorkspaceFromMirror(store.db, {
          projectSlug: store.slug,
          repo: REPO,
          dir,
          defaultBranch: "main",
          dataRoot: store.dataRoot,
          fastForward: true,
          taskBranch,
        }),
      );

    /** Land one commit on `branch` from a checkout that is NOT `dir`, so the
     *  commit only reaches `dir` through the refresh's own fetch. */
    async function externalCommit(branch: string, file: string): Promise<string> {
      const pusher = await checkout(`pusher-${branch}`);
      await withLocalGithub(origins, () => exec("git", ["-C", pusher, "fetch", "-q", "origin", branch]));
      await exec("git", ["-C", pusher, "checkout", "-q", "-B", branch, "FETCH_HEAD"]);
      writeFileSync(path.join(pusher, file), "someone else's work\n");
      await exec("git", ["-C", pusher, "add", "-A"]);
      await exec("git", ["-C", pusher, "commit", "-qm", `observer: ${file}`]);
      await withLocalGithub(origins, () => exec("git", ["-C", pusher, "push", "-q", "origin", branch]));
      return gitOut(pusher, ["rev-parse", "HEAD"]);
    }

    // The delivering checkout, on the task branch, pushed as Viberr delivers it.
    const dir = await checkout("rework");
    await exec("git", ["-C", dir, "checkout", "-q", "-b", "vib-18"]);
    writeFileSync(path.join(dir, "WORK.md"), "delivered\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "[VIB-18] delivered"]);
    const delivered = await gitOut(dir, ["rev-parse", "HEAD"]);
    await withLocalGithub(origins, () => exec("git", ["-C", dir, "push", "-q", "origin", "vib-18"]));

    // A commit Viberr did not deliver joins the branch: the external revision.
    const external = await externalCommit("vib-18", "OBSERVER.md");
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(delivered);

    const result = await refreshTask(dir, "vib-18");
    expect(result).toMatchObject({ status: "fast_forwarded", from: "behind_task_branch", head: external });
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(external);
    // Still ON the branch — a detached rework could not be delivered at all.
    expect(await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("vib-18");
    expect(await gitOut(dir, ["log", "--oneline"])).toContain("[VIB-18] delivered");
    expect(describeWorkspaceRefresh(result, "main")).toContain(
      "fast-forwarded the task branch to origin's copy",
    );
    expect(describeWorkspaceRefresh(result, "main")).toContain("ruling 179");

    // A branch that DIVERGED is left exactly as it stands: the delivery's
    // non-fast-forward refusal and a person own that, never a silent merge.
    const diverged = await checkout("diverged");
    await exec("git", ["-C", diverged, "checkout", "-q", "-b", "vib-19"]);
    writeFileSync(path.join(diverged, "WORK.md"), "delivered\n");
    await exec("git", ["-C", diverged, "add", "-A"]);
    await exec("git", ["-C", diverged, "commit", "-qm", "[VIB-19] delivered"]);
    await withLocalGithub(origins, () => exec("git", ["-C", diverged, "push", "-q", "origin", "vib-19"]));
    await externalCommit("vib-19", "OBSERVER.md");
    // ...and the local checkout committed its OWN follow-up on the old head.
    writeFileSync(path.join(diverged, "MINE.md"), "local rework\n");
    await exec("git", ["-C", diverged, "add", "-A"]);
    await exec("git", ["-C", diverged, "commit", "-qm", "[VIB-19] local rework"]);
    const mine = await gitOut(diverged, ["rev-parse", "HEAD"]);
    const kept = await refreshTask(diverged, "vib-19");
    expect(kept).toMatchObject({ status: "fetched", head: "task_branch" });
    expect(await gitOut(diverged, ["rev-parse", "HEAD"])).toBe(mine);

    // A task branch refreshed WITHOUT the ruling-179 input is untouched too:
    // the fast-forward follows the task's own branch, not any branch.
    const unnamed = await checkout("unnamed");
    await exec("git", ["-C", unnamed, "checkout", "-q", "-b", "vib-20"]);
    writeFileSync(path.join(unnamed, "WORK.md"), "delivered\n");
    await exec("git", ["-C", unnamed, "add", "-A"]);
    await exec("git", ["-C", unnamed, "commit", "-qm", "[VIB-20] delivered"]);
    const head20 = await gitOut(unnamed, ["rev-parse", "HEAD"]);
    await withLocalGithub(origins, () => exec("git", ["-C", unnamed, "push", "-q", "origin", "vib-20"]));
    await externalCommit("vib-20", "OBSERVER.md");
    expect(await refresh(unnamed)).toMatchObject({ status: "fetched", head: "task_branch" });
    expect(await gitOut(unnamed, ["rev-parse", "HEAD"])).toBe(head20);
  });

  it("ruling 179: a task branch says WHICH it is — unpushed, in sync, ahead, or diverged", async () => {
    // Canary: return `{ status: "fetched", head: "task_branch" }` without the
    // standing and every sentence below goes back to the one live text that
    // called an IN-SYNC branch "a diverged task branch" (2026-09-12, HLC-18's
    // deliverer, minutes after its rework had landed on origin).
    const refreshTask = (dir: string, taskBranch: string) =>
      withLocalGithub(origins, () =>
        refreshWorkspaceFromMirror(store.db, {
          projectSlug: store.slug,
          repo: REPO,
          dir,
          defaultBranch: "main",
          dataRoot: store.dataRoot,
          fastForward: true,
          taskBranch,
        }),
      );
    const say = (r: Awaited<ReturnType<typeof refreshTask>>) => describeWorkspaceRefresh(r, "main");

    const dir = await checkout("standing");
    await exec("git", ["-C", dir, "checkout", "-q", "-b", "vib-30"]);
    writeFileSync(path.join(dir, "WORK.md"), "one\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "[VIB-30] one"]);

    // 1. origin has never seen the branch.
    const unpushed = await refreshTask(dir, "vib-30");
    expect(unpushed).toMatchObject({
      status: "fetched",
      head: "task_branch",
      taskBranch: { name: "vib-30", standing: "unpushed" },
    });
    expect(say(unpushed)).toContain("which origin does not have yet");

    // 2. ahead: committed locally, not yet delivered — the delivery pushes it.
    await withLocalGithub(origins, () => exec("git", ["-C", dir, "push", "-q", "origin", "vib-30"]));
    writeFileSync(path.join(dir, "WORK.md"), "two\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "[VIB-30] two"]);
    const ahead = await refreshTask(dir, "vib-30");
    expect(ahead).toMatchObject({ taskBranch: { standing: "ahead" } });
    expect(say(ahead)).toContain("ahead of `origin/vib-30`: the delivery is what pushes it");

    // 3. in sync: the delivery pushed it. NOT "diverged".
    await withLocalGithub(origins, () => exec("git", ["-C", dir, "push", "-q", "origin", "vib-30"]));
    const inSync = await refreshTask(dir, "vib-30");
    expect(inSync).toMatchObject({ taskBranch: { standing: "in_sync" } });
    expect(say(inSync)).toContain("matches `origin/vib-30`: nothing to move");
    expect(say(inSync)).not.toContain("diverged");

    // 4. diverged: both moved. The old sentence, now earned.
    const pusher = await checkout("standing-pusher");
    await withLocalGithub(origins, () => exec("git", ["-C", pusher, "fetch", "-q", "origin", "vib-30"]));
    await exec("git", ["-C", pusher, "checkout", "-q", "-B", "vib-30", "FETCH_HEAD"]);
    writeFileSync(path.join(pusher, "THEIRS.md"), "theirs\n");
    await exec("git", ["-C", pusher, "add", "-A"]);
    await exec("git", ["-C", pusher, "commit", "-qm", "observer"]);
    await withLocalGithub(origins, () => exec("git", ["-C", pusher, "push", "-q", "origin", "vib-30"]));
    writeFileSync(path.join(dir, "MINE.md"), "mine\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-qm", "[VIB-30] mine"]);
    const mine = await gitOut(dir, ["rev-parse", "HEAD"]);
    const diverged = await refreshTask(dir, "vib-30");
    expect(diverged).toMatchObject({ taskBranch: { standing: "diverged" } });
    expect(say(diverged)).toContain("BOTH moved");
    expect(await gitOut(dir, ["rev-parse", "HEAD"])).toBe(mine);
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
