import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "~/server/logging/logger.server";
import {
  createLocalOrigin,
  withLocalGithub,
  type LocalOrigin,
} from "../../../test-support/git-origin";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  cloneProgressStep,
  cloneStepLabel,
  cloneWorkspaceRepo,
  mirrorGitEnv,
  mirrorIsCold,
  projectRepoMirrorDir,
  refreshProjectMirror,
} from "./repo-mirror.server";

/**
 * R21-4 / OBS-9 — the per-project mirror cache.
 *
 * Live: every task in a project re-cloned `akin-ozer/viberr` (113 MB) from
 * GitHub, 4-12 minutes each, and kept its own copy. These tests run the REAL
 * production path against a local origin: `GIT_ALLOW_PROTOCOL=file`
 * (setup-env) plus a `url.<local>.insteadOf` entry in a temp `GIT_CONFIG_GLOBAL`
 * redirect `https://github.com/` at a directory, so nothing here touches the
 * network and a rewrite that stopped applying would FAIL rather than dial out.
 */
describe("cloneWorkspaceRepo — the per-project repository mirror cache", () => {
  const exec = promisify(execFile);
  const SLUG = "viberr-core";
  const REPO = "acme/widgets";

  let ctx: TestDbContext;
  let dataRoot: string;
  let origins: string;
  let firstCommit: string;

  const mirrorDir = () => projectRepoMirrorDir(SLUG, REPO, dataRoot)!;
  const workspace = (name: string) => path.join(dataRoot, "workspaces", name);

  /** The `acme/widgets` origin (test-support/git-origin.ts), one commit on main. */
  let origin: LocalOrigin;
  async function makeOrigin(): Promise<void> {
    origin = await createLocalOrigin(origins, { repo: REPO });
    firstCommit = origin.firstCommit;
  }

  /** Land another commit on the origin, so a stale mirror is detectable. */
  const advanceOrigin = (): Promise<string> =>
    origin.advance({ file: "CHANGELOG.md", message: "second" });

  const clone = (name: string) =>
    cloneWorkspaceRepo({
      projectSlug: SLUG,
      repo: REPO,
      destination: workspace(name),
      dataRoot,
    });

  /** The loose-object path of a commit, relative to an object store. */
  const objectPath = (sha: string) =>
    path.join("objects", sha.slice(0, 2), sha.slice(2));

  beforeEach(() => {
    ctx = createTestDbContext();
    dataRoot = ctx.makeTempDir();
    origins = ctx.makeTempDir();
    mkdirSync(path.join(dataRoot, "projects", SLUG), { recursive: true });
    mkdirSync(path.join(dataRoot, "workspaces"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.cleanup();
  });

  it("creates the project's mirror on the first clone, outside every task workspace", async () => {
    // Canary: make `ensureProjectMirror` return null unconditionally and the
    // mirror assertions fail (the clone itself still succeeds — that is the
    // point of the fallback, and why the mirror needs its own assertion).
    await makeOrigin();

    const result = await withLocalGithub(origins, () => clone("a"));

    expect(result.viaMirror).toBe(true);
    expect(existsSync(path.join(workspace("a"), "README.md"))).toBe(true);
    expect(existsSync(path.join(mirrorDir(), "HEAD"))).toBe(true);
    // The cache is a peer of `tasks/`, never inside one: the boot reclaim wipes
    // `<taskDir>/workspace` on its own schedule and the projection rebuild scans
    // `tasks/*` for task files. A dot-prefixed name also keeps the file watcher
    // from walking a 100 MB object store.
    const rel = path.relative(path.join(dataRoot, "projects", SLUG), mirrorDir());
    expect(rel.split(path.sep)[0]).toBe(".repo-mirror");
    expect(rel).not.toContain("tasks");
    // Whatever the workspace was cut from, it must talk to GITHUB afterwards —
    // the delivery push and every later fetch depend on this URL.
    const url = await exec("git", [
      "-C",
      workspace("a"),
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url.stdout.trim()).toBe("https://github.com/acme/widgets.git");
  });

  it("cuts the SECOND workspace from the mirror — shared objects, refreshed refs, no dependency on the cache", async () => {
    // The headline: task two must not pay a second network clone, and must
    // still see what the remote has NOW.
    // Canary: delete the `if (mirror) { … }` arm in `cloneWorkspaceRepo` (so
    // every clone goes direct) and the inode assertion fails — the second tree
    // is then a fresh copy with objects of its own.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    const second = await advanceOrigin();

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(result.viaMirror).toBe(true);
    // Fresh-from-remote: the mirror was fetched in the same call, so the commit
    // pushed after the mirror was built is the one checked out.
    const head = await exec("git", ["-C", workspace("b"), "rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe(second);
    expect(existsSync(path.join(workspace("b"), "CHANGELOG.md"))).toBe(true);

    // Cut from the mirror, not fetched: the first commit's object is the SAME
    // file on disk (one inode, two directory entries), which is what makes a
    // 113 MB repo cost a task nothing.
    const inMirror = statSync(path.join(mirrorDir(), objectPath(firstCommit)));
    const inWorkspace = statSync(
      path.join(workspace("b"), ".git", objectPath(firstCommit)),
    );
    expect(inWorkspace.ino).toBe(inMirror.ino);

    // …and hardlinks, not `--reference` alternates, is the whole reason this
    // design was chosen: the workspace owns its objects, so the cache can be
    // deleted under a live run without corrupting it.
    expect(
      existsSync(path.join(workspace("b"), ".git", "objects", "info", "alternates")),
    ).toBe(false);
    rmSync(mirrorDir(), { recursive: true, force: true });
    const log = await exec("git", ["-C", workspace("b"), "log", "--oneline"]);
    expect(log.stdout).toContain("second");
  });

  it("a broken cache never blocks a task — the clone falls back to GitHub", async () => {
    // A cache that can fail a run is worse than no cache. Canary: drop the
    // try/catch around the mirror arm and this test throws instead of cloning.
    await makeOrigin();
    // A FILE where the cache directory belongs: every mirror operation fails.
    writeFileSync(path.join(dataRoot, "projects", SLUG, ".repo-mirror"), "not a dir\n");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await withLocalGithub(origins, () => clone("a"));

    expect(result.viaMirror).toBe(false);
    expect(existsSync(path.join(workspace("a"), "README.md"))).toBe(true);
    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "the project's repository mirror is unavailable; cloning from GitHub",
    );
  });

  /** Refresh THIS project's mirror the way a read-side caller does. */
  const refresh = (create: boolean) =>
    refreshProjectMirror({
      projectSlug: SLUG,
      repo: REPO,
      token: null,
      dataRoot,
      create,
    });

  /** Point the mirror's own `origin` at nothing, so its fetch always fails
   *  while a fresh clone from the (redirected) GitHub URL still works. */
  const breakMirrorRemote = () =>
    exec("git", [
      "-C",
      mirrorDir(),
      "config",
      "--replace-all",
      "remote.origin.url",
      path.join(origins, "no-such-origin.git"),
    ]);

  it("R21-4b: a mirror that cannot REFRESH is served as stale, not thrown away", async () => {
    // Discarding a working 113 MB local copy because the network hiccuped — and
    // then re-downloading it over that same network — is the worst available
    // move. Canary: restore `return null` on the fetch failure and this fails on
    // both the returned mirror and the warning.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    await advanceOrigin();
    await breakMirrorRemote();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "the project's repository mirror could not be refreshed; serving a possibly stale mirror",
    );
    // Cut from the kept copy — no second network clone…
    expect(result.viaMirror).toBe(true);
    expect(existsSync(path.join(workspace("b"), "README.md"))).toBe(true);
    // …and demonstrably the STALE one: the commit pushed after the mirror was
    // built is exactly what a mirror that could not fetch does not have.
    expect(existsSync(path.join(workspace("b"), "CHANGELOG.md"))).toBe(false);
    expect(existsSync(path.join(mirrorDir(), "HEAD"))).toBe(true);
  });

  it("R21-4b: two consecutive refresh failures rebuild the mirror from scratch", async () => {
    // One failure is the network; two on a reachable remote is the mirror
    // itself (a half-written pack, a stale ref lock), and a cache that can only
    // rot is worse than none. Canary: raise MIRROR_REBUILD_AFTER_FAILURES out of
    // reach and the rebuild assertions fail.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    const second = await advanceOrigin();
    await breakMirrorRemote();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // #1 serves stale (its remote is broken, so it never sees `second`)…
    expect(await withLocalGithub(origins, () => refresh(true))).toMatchObject({
      refreshed: false,
    });
    const stale = await exec("git", ["-C", mirrorDir(), "rev-parse", "main"]);
    expect(stale.stdout.trim()).toBe(firstCommit);

    // …#2 condemns it and re-clones from the (redirected) GitHub URL.
    const rebuilt = await withLocalGithub(origins, () => refresh(true));

    expect(rebuilt).toEqual({ dir: mirrorDir(), refreshed: true });
    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "the project's repository mirror failed to refresh twice; rebuilding it",
    );
    // The rebuild is a real clone: the sabotaged remote is gone and the mirror
    // carries what the origin has NOW.
    const url = await exec("git", [
      "-C",
      mirrorDir(),
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(url.stdout.trim()).toBe("https://github.com/acme/widgets.git");
    const head = await exec("git", ["-C", mirrorDir(), "rev-parse", "main"]);
    expect(head.stdout.trim()).toBe(second);
  });

  /** Exactly what `git clone --bare` leaves behind when it is KILLED mid-
   *  transfer: the destination it created, the `HEAD` it wrote before the first
   *  object landed, no refs, no fetch refspec, and the temp pack it was still
   *  streaming into. */
  function leaveKilledCloneAtMirror(): string {
    const dir = mirrorDir();
    mkdirSync(path.join(dir, "objects", "pack"), { recursive: true });
    mkdirSync(path.join(dir, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/.invalid\n");
    writeFileSync(
      path.join(dir, "config"),
      '[core]\n\tbare = true\n[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    );
    const orphan = path.join(dir, "objects", "pack", "tmp_pack_killed");
    writeFileSync(orphan, "half a pack\n");
    return orphan;
  }

  it("a mirror left HALF-BUILT by a killed clone is rebuilt, never served", async () => {
    // VIB-1 (2026-09-08): a `docker compose` restart killed two bare clones of a
    // 190 MB repo. Each left a directory with a `HEAD` and nothing else, which
    // the old `existsSync(HEAD)` test accepted as a mirror — so the refresh arm
    // burned its 120 s budget on a `fetch origin` with no refspec to work with,
    // and the workspace cut from it was EMPTY. Canary: put `existsSync(HEAD)`
    // back in `ensureProjectMirror` and this test's workspace has no README.
    await makeOrigin();
    const orphan = leaveKilledCloneAtMirror();

    const result = await withLocalGithub(origins, () => clone("a"));

    // Rebuilt from the origin, not served: the working tree has real content…
    expect(result.viaMirror).toBe(true);
    expect(existsSync(path.join(workspace("a"), "README.md"))).toBe(true);
    // …the mirror carries the origin's branch and its completion marker…
    const head = await exec("git", ["-C", mirrorDir(), "rev-parse", "main"]);
    expect(head.stdout.trim()).toBe(firstCommit);
    const refspec = await exec("git", [
      "-C",
      mirrorDir(),
      "config",
      "--get",
      "remote.origin.fetch",
    ]);
    expect(refspec.stdout.trim()).toBe("+refs/heads/*:refs/heads/*");
    // …and the killed clone's leavings are gone, which a mere fetch would have
    // kept. That is the difference between a rebuild and serving the wreckage.
    expect(existsSync(orphan)).toBe(false);
  });

  it("the mirror is PUBLISHED by rename — no sidecar survives a successful build", async () => {
    // Building in place is what let a killed clone leave something servable at
    // the mirror path. The build now lands in `<mirror>.building` and is renamed
    // in, so an abandoned sidecar is never mistaken for a mirror — and is swept.
    // Canary: clone straight to `mirrorDir` again and the sidecar assertions
    // stop meaning anything (the leftover below is served instead of rebuilt).
    await makeOrigin();
    const sidecar = `${mirrorDir()}.building`;
    mkdirSync(sidecar, { recursive: true });
    writeFileSync(path.join(sidecar, "HEAD"), "ref: refs/heads/.invalid\n");

    const result = await withLocalGithub(origins, () => clone("a"));

    expect(result.viaMirror).toBe(true);
    expect(existsSync(path.join(workspace("a"), "README.md"))).toBe(true);
    expect(existsSync(sidecar)).toBe(false);
    expect(readdirSync(path.dirname(mirrorDir()))).toEqual([
      path.basename(mirrorDir()),
    ]);
  });

  it("a mirror whose HEAD names a branch it does not have never becomes an empty checkout", async () => {
    // Caught live while repairing VIB-1: a mirror with every object and every
    // ref, whose HEAD still named the `git init` default branch, cloned to an
    // empty tree — `git clone` warns "remote HEAD refers to nonexistent ref"
    // and exits 0. Canary: weaken `mirrorCanCheckOut` to "does it hold any
    // refs?" and this workspace comes back with no README.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    await exec("git", ["-C", mirrorDir(), "symbolic-ref", "HEAD", "refs/heads/nope"]);
    await breakMirrorRemote();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "the project's repository mirror has no branch to check out; cloning from GitHub",
    );
    expect(result.viaMirror).toBe(false);
    expect(existsSync(path.join(workspace("b"), "README.md"))).toBe(true);
  });

  it("ruling 670: a mirror whose HEAD names a branch the remote no longer has follows the remote's HEAD and serves clones again", async () => {
    // The default branch renamed on GitHub, or a repository mirrored while it
    // was empty and first pushed on another name. Viberr no longer creates
    // the old name there, so nothing would ever make this mirror usable.
    // CANARY: drop `followRemoteHead` and every later workspace of the
    // project is a network clone, with the "no branch to check out" warning.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    await exec("git", [`--git-dir=${origin.bare}`, "branch", "-m", "main", "trunk"]);
    await exec("git", [`--git-dir=${origin.bare}`, "symbolic-ref", "HEAD", "refs/heads/trunk"]);

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(result.viaMirror).toBe(true);
    expect((await exec("git", ["-C", workspace("b"), "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
      "trunk",
    );
    expect(existsSync(path.join(workspace("b"), "README.md"))).toBe(true);
  });

  it("ruling 670: a mirror built while the repository was empty follows its first branch, whatever that is named", async () => {
    // The other way a mirror's HEAD names a branch that never comes: the
    // repository was empty, and its first push was a person's own `master`.
    // CANARY: follow only a HEAD that once resolved and this mirror never
    // serves a clone.
    origin = await createLocalOrigin(origins, { repo: REPO, empty: true });
    await withLocalGithub(origins, () => clone("a"));
    writeFileSync(path.join(origin.seed, "app.txt"), "theirs\n");
    await exec("git", ["-C", origin.seed, "add", "-A"]);
    await exec("git", ["-C", origin.seed, "commit", "-qm", "Their first commit"]);
    await exec("git", ["-C", origin.seed, "push", "-q", origin.bare, "HEAD:refs/heads/master"]);
    await exec("git", [`--git-dir=${origin.bare}`, "symbolic-ref", "HEAD", "refs/heads/master"]);

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(result.viaMirror).toBe(true);
    expect((await exec("git", ["-C", workspace("b"), "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
      "master",
    );
    expect(existsSync(path.join(workspace("b"), "app.txt"))).toBe(true);
  });

  it("a mirror with NO branches never becomes an empty checkout", async () => {
    // `git clone <ref-less repo>` warns and exits 0, so this arm used to report
    // success while handing a specialist a tree with no history and no
    // `origin/<base>` — the shape VIB-1's delivering agent committed a
    // parentless commit into. Canary: drop the `mirrorHasRefs` guard and the
    // README assertion fails on an empty workspace.
    await makeOrigin();
    await withLocalGithub(origins, () => clone("a"));
    // Strip every ref and break the remote, so the refresh cannot quietly put
    // them back: a mirror that is COMPLETE, served stale, and holds nothing.
    rmSync(path.join(mirrorDir(), "packed-refs"), { force: true });
    rmSync(path.join(mirrorDir(), "refs", "heads"), {
      recursive: true,
      force: true,
    });
    await breakMirrorRemote();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await withLocalGithub(origins, () => clone("b"));

    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "the project's repository mirror has no branch to check out; cloning from GitHub",
    );
    expect(result.viaMirror).toBe(false);
    expect(existsSync(path.join(workspace("b"), "README.md"))).toBe(true);
  });

  it("a read-side refresh never CREATES a mirror — it degrades instead", async () => {
    // A tool call inside an operator turn must not become a 113 MB download.
    // Canary: default `create` to true in `refreshProjectMirror` and this fails.
    await makeOrigin();

    expect(await withLocalGithub(origins, () => refresh(false))).toBeNull();
    expect(existsSync(mirrorDir())).toBe(false);
  });

  it("two clones racing the same project share ONE mirror", async () => {
    // The operator drive clones, then the specialist it engages clones — two
    // fetches into one bare repo race on the ref lock, and git would turn that
    // into a spurious failure this module would pay a network clone for.
    // Canary: drop `withMirrorLock` and this goes flaky/red under repeat runs.
    await makeOrigin();

    const results = await withLocalGithub(origins, () =>
      Promise.all([clone("a"), clone("b")]),
    );

    expect(results.map((r) => r.viaMirror)).toEqual([true, true]);
    expect(existsSync(path.join(workspace("a"), "README.md"))).toBe(true);
    expect(existsSync(path.join(workspace("b"), "README.md"))).toBe(true);
    expect(readdirSync(path.dirname(mirrorDir()))).toEqual([
      path.basename(mirrorDir()),
    ]);
  });

  /** A second bare origin under `origins/acme/<name>.git` with one commit, so a
   *  project repointed to it builds a NEW mirror beside the old one. */
  async function makeBareOrigin(name: string): Promise<void> {
    await createLocalOrigin(origins, { repo: `acme/${name}` });
  }

  it("E1: a HEALTHY mirror whose local clone fails falls back to a direct GitHub clone", async () => {
    // The tested fallback (repo-mirror.server.test.ts elsewhere) breaks mirror
    // CREATION; this arm is different — the mirror is fine, but `git clone
    // <mirror> <dest>` (or the origin rewrite) fails, so the code warns, rmSync's
    // the half-written destination, and re-clones from GitHub. If that rmSync
    // regresses, the direct re-clone refuses the non-empty dir and EVERY run on
    // the project fails at clone, blamed on GitHub.
    await makeOrigin();
    // Force the mirror→workspace clone to fail deterministically: git refuses a
    // destination that already exists and is not empty. The MIRROR is untouched.
    const dest = workspace("a");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "occupied.txt"), "in the way\n");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await withLocalGithub(origins, () =>
      cloneWorkspaceRepo({
        projectSlug: SLUG,
        repo: REPO,
        destination: dest,
        dataRoot,
      }),
    );

    // It fell back to the direct clone, and the fallback arm is the one that ran:
    expect(result.viaMirror).toBe(false);
    expect(warn.mock.calls.map(([msg]) => msg)).toContain(
      "cloning from the project's repository mirror failed; cloning from GitHub",
    );
    // The half-written destination was cleared (rmSync) before the re-clone…
    expect(existsSync(path.join(dest, "occupied.txt"))).toBe(false);
    // …and the tree is a real working clone.
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    // This is NOT the broken-cache path: the mirror was built healthy.
    expect(existsSync(path.join(mirrorDir(), "HEAD"))).toBe(true);
  });

  it("E7: building the mirror for a CHANGED repo evicts the old repo's mirror, keeps the new", async () => {
    // `pruneStaleMirrors` recursive-deletes every sibling of the mirror it just
    // built, keyed on basename. A wrong comparison silently deletes the
    // just-built mirror (re-paying the full download every clone, hidden by the
    // fallback) or never evicts (unbounded growth). Repoint the project and prove
    // the old mirror is gone while the new one survives.
    await makeOrigin(); // acme/widgets
    await makeBareOrigin("gadgets"); // acme/gadgets, the repointed target
    await withLocalGithub(origins, () => clone("a"));
    const widgetsMirror = projectRepoMirrorDir(SLUG, "acme/widgets", dataRoot)!;
    expect(existsSync(path.join(widgetsMirror, "HEAD"))).toBe(true);

    // The project now points at acme/gadgets: cloning it builds the gadgets
    // mirror and prunes the stale widgets sibling in the same `.repo-mirror` dir.
    await withLocalGithub(origins, () =>
      cloneWorkspaceRepo({
        projectSlug: SLUG,
        repo: "acme/gadgets",
        destination: workspace("b"),
        dataRoot,
      }),
    );

    const gadgetsMirror = projectRepoMirrorDir(SLUG, "acme/gadgets", dataRoot)!;
    expect(existsSync(path.join(gadgetsMirror, "HEAD"))).toBe(true); // new survives
    expect(existsSync(widgetsMirror)).toBe(false); // old evicted
    // Exactly one mirror remains in the parent — the current one.
    expect(readdirSync(path.dirname(gadgetsMirror))).toEqual([
      path.basename(gadgetsMirror),
    ]);
  });
});

/**
 * R21-4b — the mirror's own git environment.
 *
 * The credential-free arm used to pass a copy of `process.env` with only the
 * prompt and the credential helper reset, so a HOST `GIT_ASKPASS` (a developer's
 * helper, a CI runner's agent) was inherited by a mirror fetch — the one thing
 * the credentialed arm is careful to strip. Both arms now come from the single
 * builder that deletes it.
 */
describe("mirrorGitEnv", () => {
  const SAVED = {
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    SSH_ASKPASS: process.env.SSH_ASKPASS,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("drops an inherited askpass on the credential-FREE path", () => {
    // Canary: hand back `{ ...process.env, GIT_TERMINAL_PROMPT: "0", … }` for the
    // no-token arm (what this replaced) and the first two expectations fail.
    process.env.GIT_ASKPASS = "/opt/host/askpass.sh";
    process.env.SSH_ASKPASS = "/opt/host/ssh-askpass.sh";

    const anonymous = mirrorGitEnv(null);
    try {
      expect(anonymous.env.GIT_ASKPASS).toBeUndefined();
      expect(anonymous.env.SSH_ASKPASS).toBeUndefined();
      // The rest of the hardening the manual object carried is still there.
      expect(anonymous.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(anonymous.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(anonymous.env.GIT_CONFIG_VALUE_0).toBe("");
    } finally {
      anonymous.dispose();
    }
  });

  it("installs VIBERR's askpass — never the host's — when a token is supplied", () => {
    process.env.GIT_ASKPASS = "/opt/host/askpass.sh";
    const authed = mirrorGitEnv("ghp_token_value_0123456789");
    try {
      expect(authed.env.GIT_ASKPASS).toBeDefined();
      expect(authed.env.GIT_ASKPASS).not.toBe("/opt/host/askpass.sh");
      expect(existsSync(authed.env.GIT_ASKPASS!)).toBe(true);
      // The PAT rides the environment only — never argv, never a persisted URL.
      expect(Object.values(authed.env)).toContain("ghp_token_value_0123456789");
    } finally {
      authed.dispose();
      expect(authed.env.GIT_ASKPASS).toBeUndefined();
    }
  });
});

describe("projectRepoMirrorDir", () => {
  it("derives a path only from a plain owner/name pair", () => {
    // The repo string comes from `project.md` frontmatter, which a human or an
    // agent edits. A cache path is never derived from anything else — a bad
    // value skips the cache instead of escaping the store.
    const root = "/data";
    expect(projectRepoMirrorDir("p", "acme/widgets", root)).toBe(
      path.join(root, "projects", "p", ".repo-mirror", "acme__widgets.git"),
    );
    for (const bad of [
      "../../etc/passwd",
      "acme/../../evil",
      "acme/widgets/extra",
      "acme/.",
      "./widgets",
      "widgets",
      "acme/",
      "",
    ]) {
      expect(projectRepoMirrorDir("p", bad, root)).toBeNull();
    }
  });
});

describe("D1: mirrorIsCold + cloneStepLabel (first-task clone honesty)", () => {
  let root: string;
  let ctx: TestDbContext;
  beforeEach(() => {
    ctx = createTestDbContext();
    root = ctx.makeTempDir();
  });
  afterEach(() => ctx.cleanup());

  it("is COLD until a COMPLETE mirror lands — a killed clone's leftovers do not count", () => {
    // Canary: go back to `existsSync(<dir>/HEAD)` and the half-built case below
    // reports warm, which is what dropped the honest "this can take a few
    // minutes" label on VIB-1's multi-minute first clone.
    expect(mirrorIsCold("p", "acme/widgets", root)).toBe(true);

    // What `git clone --bare` leaves when it is KILLED mid-transfer: a HEAD
    // written before the first object, no refs, and no fetch refspec.
    const dir = projectRepoMirrorDir("p", "acme/widgets", root)!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/.invalid\n");
    writeFileSync(path.join(dir, "config"), "[core]\n\tbare = true\n");
    expect(mirrorIsCold("p", "acme/widgets", root)).toBe(true);

    // The refspec is written last, after the clone returns — that is the marker.
    writeFileSync(
      path.join(dir, "config"),
      '[core]\n\tbare = true\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/heads/*\n',
    );
    expect(mirrorIsCold("p", "acme/widgets", root)).toBe(false);
  });

  it("reports NOT cold for a repo that does not resolve to a mirror path", () => {
    // An invalid owner/name has no mirror to prewarm; never mislabel the wait.
    expect(mirrorIsCold("p", "../../etc/passwd", root)).toBe(false);
  });

  it("labels the cold clone as the multi-minute first-task build, warm as plain", () => {
    expect(cloneStepLabel("acme/widgets", true)).toBe(
      "Cloning acme/widgets · first task in this project, this can take a few minutes",
    );
    expect(cloneStepLabel("acme/widgets", false)).toBe("Cloning acme/widgets");
  });

  it("F27-U1/F28-U1: cloneProgressStep folds the live percentage in, leading before the context", () => {
    // F28-U1: the percentage comes right after the repo, BEFORE the "first task"
    // context, so the narrow ellipsis-truncated run strip keeps it visible.
    expect(cloneProgressStep("acme/widgets", 0)).toBe(
      "Cloning acme/widgets · 0% · first task in this project",
    );
    expect(cloneProgressStep("acme/widgets", 0.387)).toBe(
      "Cloning acme/widgets · 39% · first task in this project",
    );
    expect(cloneProgressStep("acme/widgets", 1)).toBe(
      "Cloning acme/widgets · 100% · first task in this project",
    );
    // The percentage precedes the context suffix — so it survives truncation.
    const step = cloneProgressStep("acme/widgets", 0.5);
    expect(step.indexOf("50%")).toBeLessThan(step.indexOf("first task"));
    // A stray out-of-range fraction clamps rather than printing "-10%"/"120%".
    expect(cloneProgressStep("acme/widgets", -0.1)).toContain("· 0% ·");
    expect(cloneProgressStep("acme/widgets", 1.2)).toContain("· 100% ·");
  });
});
