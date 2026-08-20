import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { readDefaultBranchFile } from "./operator-repo-read.server";
import { cloneWorkspaceRepo, projectRepoMirrorDir } from "./repo-mirror.server";

/**
 * F21-21 — the operator's anchored "what is on the default branch?" read.
 *
 * The residual defect this file pins: the read used to keep its answer fresh by
 * running `git fetch --depth 1` INSIDE the shared task workspace. That marks a
 * full clone SHALLOW, and the workspace is the delivering agent's own tree — so
 * an operator asking a read-only question quietly broke the merge-base the diff
 * and verdict machinery runs on. The answer now comes from the project MIRROR
 * (bare, per-project, refreshed on every workspace clone); the checkout is only
 * ever read, and only when there is no mirror at all.
 *
 * Real git throughout, against a local origin: `GIT_ALLOW_PROTOCOL=file`
 * (setup-env) plus a `url.<local>.insteadOf` entry in a temp `GIT_CONFIG_GLOBAL`
 * point `https://github.com/` at a directory, so nothing here touches the
 * network.
 */
describe("readDefaultBranchFile", () => {
  const exec = promisify(execFile);
  const SLUG = "viberr-core";
  const REPO = "acme/widgets";
  const TASK_BRANCH = "vib-1";

  let ctx: TestDbContext;
  let db: DatabaseSync;
  let dataRoot: string;
  let origins: string;
  let checkout: string;

  /** A local bare origin for `acme/widgets` with `docs/guide.md` on `main`. */
  async function makeOrigin(): Promise<void> {
    const bare = path.join(origins, "acme", "widgets.git");
    mkdirSync(path.dirname(bare), { recursive: true });
    await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const seed = path.join(origins, "seed");
    mkdirSync(path.join(seed, "docs"), { recursive: true });
    writeFileSync(path.join(seed, "docs", "guide.md"), "the guide\n");
    await exec("git", ["init", "-q", "-b", "main", seed]);
    await exec("git", ["-C", seed, "config", "user.email", "t@t.dev"]);
    await exec("git", ["-C", seed, "config", "user.name", "T"]);
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-qm", "init"]);
    await exec("git", ["-C", seed, "push", "-q", bare, "HEAD:refs/heads/main"]);
  }

  /** Land another commit on the origin's `main`. */
  async function advanceOrigin(text: string): Promise<void> {
    const seed = path.join(origins, "seed");
    writeFileSync(path.join(seed, "docs", "guide.md"), text);
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-qm", "second"]);
    await exec("git", [
      "-C",
      seed,
      "push",
      "-q",
      path.join(origins, "acme", "widgets.git"),
      "HEAD:refs/heads/main",
    ]);
  }

  async function withOrigin<T>(work: () => Promise<T>): Promise<T> {
    const configPath = path.join(origins, "gitconfig");
    writeFileSync(
      configPath,
      `[url "${origins}${path.sep}"]\n\tinsteadOf = https://github.com/\n`,
    );
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = configPath;
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      return await work();
    } finally {
      for (const [key, value] of [
        ["GIT_CONFIG_GLOBAL", saved.global],
        ["GIT_CONFIG_SYSTEM", saved.system],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /**
   * The workspace as a run leaves it: cut from the project's mirror (so the
   * project HAS a mirror, as every real task does), then standing on the TASK
   * branch with the deliverer's commit — the live shape of VIB-7.
   */
  async function makeCheckout(): Promise<void> {
    await withOrigin(() =>
      cloneWorkspaceRepo({
        projectSlug: SLUG,
        repo: REPO,
        destination: checkout,
        dataRoot,
      }),
    );
    await exec("git", ["-C", checkout, "config", "user.email", "t@t.dev"]);
    await exec("git", ["-C", checkout, "config", "user.name", "T"]);
    await exec("git", ["-C", checkout, "checkout", "-qb", TASK_BRANCH]);
    writeFileSync(
      path.join(checkout, "docs", "guide.md"),
      "the guide\nthe governed row\n",
    );
    writeFileSync(path.join(checkout, "docs", "new.md"), "brand new\n");
    await exec("git", ["-C", checkout, "add", "-A"]);
    await exec("git", ["-C", checkout, "commit", "-qm", "the deliverer's work"]);
  }

  const read = (repoPath: string) =>
    withOrigin(() =>
      readDefaultBranchFile(db, {
        projectSlug: SLUG,
        dir: checkout,
        defaultBranch: "main",
        path: repoPath,
        dataRoot,
      }),
    );

  const gitOut = async (args: string[]) =>
    (await exec("git", ["-C", checkout, ...args])).stdout.trim();

  beforeEach(async () => {
    ctx = createTestDbContext();
    db = ctx.makeDb();
    dataRoot = ctx.makeTempDir();
    origins = ctx.makeTempDir();
    mkdirSync(path.join(dataRoot, "projects", SLUG), { recursive: true });
    checkout = path.join(dataRoot, "workspace", "widgets");
    await makeOrigin();
    await makeCheckout();
  });

  afterEach(() => ctx.cleanup());

  it("answers from the default branch while the tree stands on the task branch", async () => {
    // The false-positive input: the deliverer's row IS in the working tree.
    expect(readFileSync(path.join(checkout, "docs", "guide.md"), "utf8")).toContain(
      "the governed row",
    );

    const changed = await read("docs/guide.md");
    const added = await read("docs/new.md");

    expect(changed.kind).toBe("found");
    expect(changed.kind === "found" && changed.text).toContain("the guide");
    expect(changed.kind === "found" && changed.text).not.toContain("the governed row");
    // A file only the task branch has is ABSENT from the default branch — the
    // clean NO that stops the out-of-band accusation.
    expect(added.kind).toBe("absent");
  });

  it("leaves the delivering agent's checkout UNSHALLOWED and its merge-base intact", async () => {
    // The residual defect, exactly. Canary: put the old
    // `git fetch --depth 1 origin +refs/heads/main:refs/remotes/origin/main`
    // back into the read (against `input.dir`) and both assertions fail — the
    // checkout flips to shallow and the merge-base stops resolving.
    expect(await gitOut(["rev-parse", "--is-shallow-repository"])).toBe("false");
    const base = await gitOut(["merge-base", "origin/main", TASK_BRANCH]);

    await read("docs/guide.md");

    expect(await gitOut(["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(await gitOut(["merge-base", "origin/main", TASK_BRANCH])).toBe(base);
    // Nothing was written into the workspace at all: the tree is still the
    // deliverer's, on its own branch, with its own commit at the tip.
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(TASK_BRANCH);
    expect(await gitOut(["status", "--porcelain"])).toBe("");
  });

  it("reads what the default branch has NOW — the mirror is refreshed for the read", async () => {
    // Freshness is why the old code fetched at all. The mirror supplies it
    // without touching the checkout, whose `origin/main` is frozen at clone time.
    await advanceOrigin("the guide\nthe rewritten section\n");

    const after = await read("docs/guide.md");

    expect(after.kind).toBe("found");
    expect(after.kind === "found" && after.refreshed).toBe(true);
    expect(after.kind === "found" && after.text).toContain("the rewritten section");
    // …and the checkout's own remote-tracking ref never moved.
    expect(await gitOut(["show", "origin/main:docs/guide.md"])).toBe("the guide");
  });

  it("degrades to the checkout's CLONE-TIME ref when the project has no mirror", async () => {
    // No mirror ⇒ no network, no fetch, and an honest `refreshed: false` for the
    // tool's prose to report. Canary: pass `create: true` from the read and this
    // recreates the mirror instead of degrading.
    rmSync(projectRepoMirrorDir(SLUG, REPO, dataRoot)!, {
      recursive: true,
      force: true,
    });
    await advanceOrigin("the guide\nthe rewritten section\n");

    const fallback = await read("docs/guide.md");

    expect(fallback.kind).toBe("found");
    expect(fallback.kind === "found" && fallback.refreshed).toBe(false);
    // The clone-time answer, not the working tree's, and not the newer remote's.
    expect(fallback.kind === "found" && fallback.text).toBe("the guide\n");
    expect(await gitOut(["rev-parse", "--is-shallow-repository"])).toBe("false");
  });

  it("refuses a path that is not a repository-relative file path", async () => {
    // A ref-ish argument would let the read escape the default branch — the one
    // thing this tool exists to pin down.
    for (const bad of ["vib-1:docs/guide.md", "/etc/passwd", "../secrets", "-C"]) {
      const result = await read(bad);
      expect(result.kind).toBe("unavailable");
    }
  });
});
