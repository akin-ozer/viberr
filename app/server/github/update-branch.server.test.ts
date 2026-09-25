import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { updateWorkspaceBranchFromBase } from "./update-branch.server";

/**
 * N19-9: the operation that did not exist — moving a task branch forward onto a
 * base that advanced. Every test here fails on main because the module does
 * not, but the canaries below neuter ONE line each so a named test fails alone.
 */

let ctx: TestDbContext;
let store: TestStore;

const SYS = { userId: null, label: "test" };
const TOKEN = "ghp_faketoken1234567890";

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      branch: "vib-1",
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  mkdirSync(
    path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr", ".git"),
    { recursive: true },
  );
});

afterEach(() => ctx.cleanup());

function bindPat() {
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "t", token: TOKEN },
    SYS,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
}

/** Ruling 134(c): what origin's copy of the task branch looks like. */
type FakeRemote =
  | { kind: "current" }
  | { kind: "behind"; ahead: number }
  | { kind: "diverged" }
  | { kind: "absent" }
  | { kind: "unknown" };

const PRE_SHA = "abc1234def";
const MERGE_SHA = "merge1234567890abcdef";
const BASE_SHA = "base1234567890abcdef";
const REMOTE_SHA = "remote1234567890abcdef";

/** A fake git that answers every probe the update makes. */
function fakeGit(opts: {
  branch?: string;
  /** Commits on the base the branch does not have. */
  behind?: number;
  shallow?: boolean;
  dirty?: boolean;
  fetchOk?: boolean;
  /** The merge fails; `conflictFiles` non-empty makes it a CONFLICT. */
  mergeOk?: boolean;
  mergeStdout?: string;
  conflictFiles?: string[];
  pushOk?: boolean;
  pushStderr?: string;
  /** Origin's copy of the task branch (default: current). */
  remote?: FakeRemote;
  /** Ruling 132: `rev-parse HEAD` after the merge answers nothing. */
  mergeShaUnreadable?: boolean;
  /** Ruling 159(b): the store-layout paths HEAD's tree carries, as
   *  `git ls-tree -r -z` reports them (NUL-terminated, unquoted). */
  storeLayoutFiles?: string[];
  /** Ruling 428: the files the branch changes since it forked from the base,
   *  as the lease gate reads them (`merge-base`, then `log --name-only`). */
  branchFiles?: string[];
} = {}) {
  const calls: string[][] = [];
  const branch = opts.branch ?? "vib-1";
  const remote: FakeRemote = opts.remote ?? { kind: "current" };
  let merged = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) {
      return { ok: true, stdout: branch, stderr: "" };
    }
    if (args.includes("ls-tree")) {
      return {
        ok: true,
        stdout: (opts.storeLayoutFiles ?? []).map((f) => `${f}\0`).join(""),
        stderr: "",
      };
    }
    if (args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: opts.shallow ? "true" : "false", stderr: "" };
    }
    if (args.includes("status") && args.includes("--porcelain")) {
      return { ok: true, stdout: opts.dirty ? " M app/main.ts\n" : "", stderr: "" };
    }
    if (args.includes("fetch") && args.some((a) => a.includes(`refs/heads/${branch}:`))) {
      if (remote.kind === "absent") {
        return { ok: false, stdout: "", stderr: `fatal: couldn't find remote ref ${branch}` };
      }
      if (remote.kind === "unknown") {
        return { ok: false, stdout: "", stderr: "fatal: unable to access origin: could not resolve host" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("fetch")) {
      return opts.fetchOk === false
        ? { ok: false, stdout: "", stderr: "fatal: couldn't find remote ref main" }
        : { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("--verify")) {
      return { ok: true, stdout: remote.kind === "current" ? PRE_SHA : REMOTE_SHA, stderr: "" };
    }
    if (opts.branchFiles && args.includes("merge-base") && !args.includes("--is-ancestor")) {
      return { ok: true, stdout: "f".repeat(40), stderr: "" };
    }
    if (opts.branchFiles && args.includes("--name-only") && args.includes("--no-merges")) {
      return { ok: true, stdout: `${opts.branchFiles.join("\n")}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) {
      return remote.kind === "behind"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: "", code: 1 };
    }
    if (args.includes("--count")) {
      const range = args[args.length - 1] ?? "";
      if (range.endsWith("..HEAD")) {
        return { ok: true, stdout: String(remote.kind === "behind" ? remote.ahead : 0), stderr: "" };
      }
      return { ok: true, stdout: String(opts.behind ?? 3), stderr: "" };
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      if (merged && opts.mergeShaUnreadable) return { ok: false, stdout: "", stderr: "fatal: bad revision" };
      return { ok: true, stdout: merged ? MERGE_SHA : PRE_SHA, stderr: "" };
    }
    if (args.includes("rev-parse") && args.some((a) => a.startsWith("refs/remotes/origin/"))) {
      return { ok: true, stdout: BASE_SHA, stderr: "" };
    }
    if (args.includes("merge") && args.includes("--abort")) {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("merge")) {
      if (opts.mergeOk !== false) merged = true;
      return {
        ok: opts.mergeOk !== false,
        stdout:
          opts.mergeOk === false
            ? (opts.mergeStdout ??
              "CONFLICT (content): Merge conflict in app/main.ts\nAutomatic merge failed")
            : "",
        stderr: "",
      };
    }
    if (args.includes("--diff-filter=U")) {
      return { ok: true, stdout: (opts.conflictFiles ?? []).join("\n"), stderr: "" };
    }
    if (args.includes("push")) {
      return {
        ok: opts.pushOk !== false,
        stdout: "",
        stderr: opts.pushOk === false ? (opts.pushStderr ?? "") : "",
      };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  return { exec, calls };
}

const run = (exec: ReturnType<typeof fakeGit>["exec"]) =>
  updateWorkspaceBranchFromBase({
    db: store.db,
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
    exec,
  });

describe("updateWorkspaceBranchFromBase (N19-9)", () => {
  it("merges the base into the branch and pushes it", async () => {
    bindPat();
    const git = fakeGit({ behind: 3 });
    expect(await run(git.exec)).toEqual({
      status: "updated",
      branch: "vib-1",
      base: "main",
      commits: 3,
      mergeSha: MERGE_SHA,
      baseSha: BASE_SHA,
      // Ruling 439: the head the merge was made on. Canary: drop `onto: preSha`.
      onto: PRE_SHA,
      remoteBefore: { kind: "current", headSha: PRE_SHA },
      remote: { kind: "current", headSha: MERGE_SHA },
    });
    // Fetches the base by EXPLICIT refspec — `origin/main` is what the merge
    // reads, and relying on git's opportunistic tracking update would make that
    // a git-version question.
    // Pass 40 review (R-seams-1): GitHub's base lands in the server's own
    // stage (with the PAT), and the WORKSPACE fetches it from there.
    const stageFetch = git.calls.find((c) => c.includes("fetch"))!;
    expect(stageFetch[0]).toMatch(/^--git-dir=.*\.repo-stage/);
    expect(stageFetch).toContain("https://github.com/akin-ozer/viberr.git");
    expect(stageFetch).toContain("+refs/heads/main:refs/heads/main");
    const fetch = git.calls.find(
      (c) => c.includes("fetch") && c.includes("+refs/heads/main:refs/remotes/origin/main"),
    );
    expect(fetch?.slice(0, 2)).toEqual(["-C", expect.any(String)]);
    expect(fetch).toContain(stageFetch[0]!.slice("--git-dir=".length));
    const merge = git.calls.find(
      (c) => c.includes("merge") && !c.includes("--abort"),
    );
    expect(merge).toContain("origin/main");
    expect(merge!.join(" ")).toContain("[VIB-1] merge main into vib-1");
    // The merge commit is pushed from the stage, not from the workspace.
    expect(git.calls.find((c) => c.includes("push"))).toEqual([
      stageFetch[0],
      "push",
      "https://github.com/akin-ozer/viberr.git",
      `${MERGE_SHA}:refs/heads/vib-1`,
    ]);
  });

  it("MERGES rather than rebases — nothing is ever force-pushed (R18-4)", async () => {
    bindPat();
    const git = fakeGit({ behind: 2 });
    await run(git.exec);
    const flat = git.calls.map((c) => c.join(" ")).join("\n");
    expect(flat).not.toMatch(/rebase/);
    expect(flat).not.toMatch(/--force|-f\b/);
    // The PUSH refspec is never forced. (The FETCH of origin's copy of the
    // branch, ruling 134(c), force-updates the local tracking ref with a `+`,
    // which touches nothing on the remote.)
    for (const push of git.calls.filter((c) => c.includes("push"))) {
      expect(push.join(" ")).not.toMatch(/\+refs\/heads\/vib-1/);
    }
  });

  it("is a no-op that SAYS SO when the branch is already current", async () => {
    bindPat();
    const git = fakeGit({ behind: 0 });
    expect(await run(git.exec)).toEqual({
      status: "already_current",
      branch: "vib-1",
      base: "main",
      remote: { kind: "current", headSha: PRE_SHA },
    });
    expect(git.calls.some((c) => c.includes("merge"))).toBe(false);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("CONFLICT: aborts the merge, names the files, and pushes nothing", async () => {
    bindPat();
    const git = fakeGit({
      behind: 4,
      mergeOk: false,
      conflictFiles: ["app/main.ts", "docs/README.md"],
    });
    const res = await run(git.exec);
    expect(res.status).toBe("conflict");
    if (res.status !== "conflict") throw new Error("unreachable");
    expect(res.files).toEqual(["app/main.ts", "docs/README.md"]);
    // The branch is left exactly as it was: aborted, never pushed.
    expect(
      git.calls.some((c) => c.includes("merge") && c.includes("--abort")),
    ).toBe(true);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    // The conflicting paths are read BEFORE the abort — after it there is
    // nothing left to name.
    const filesAt = git.calls.findIndex((c) => c.includes("--diff-filter=U"));
    const abortAt = git.calls.findIndex((c) => c.includes("--abort"));
    expect(filesAt).toBeGreaterThan(-1);
    expect(filesAt).toBeLessThan(abortAt);
  });

  it("ruling 144(c): a workflow-scope refusal is named, not dropped in the generic bucket", async () => {
    // The DELIVERY push classifies this and names the remedy; the operator's
    // base-refresh push — the sibling — never did, so a branch that touches
    // `.github/workflows/` failed with "pushing the updated branch returned
    // non-zero" every single time, with nothing saying the token merely lacks
    // a scope. The operator retried forever on an unactionable message.
    // Canary: drop the isWorkflowScopeRejection branch and the reason below
    // goes back to the generic one.
    bindPat();
    const git = fakeGit({
      behind: 2,
      pushOk: false,
      pushStderr:
        "! [remote rejected] vib-1 -> vib-1 (refusing to allow a Personal Access Token to " +
        "create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
    });
    const res = await run(git.exec);
    expect(res.status).toBe("update_failed");
    if (res.status === "update_failed") {
      expect(res.reason).toContain("`workflow` scope");
      expect(res.reason).toContain(".github/workflows/");
      // It says what to DO, which the generic bucket never could.
      expect(res.reason).toMatch(/re-authorize/i);
      expect(res.reason).not.toContain("returned non-zero");
    }
    // Still all-or-nothing: the local merge is rolled back, never forced.
    expect(
      git.calls.some(
        (c) => c.includes("reset") && c.includes("--hard") && c.includes("abc1234def"),
      ),
    ).toBe(true);
  });

  it("a NON-FAST-FORWARD push rolls the local merge back instead of forcing it", async () => {
    bindPat();
    const git = fakeGit({
      behind: 2,
      pushOk: false,
      pushStderr: "! [rejected] vib-1 -> vib-1 (non-fast-forward)",
    });
    const res = await run(git.exec);
    expect(res.status).toBe("push_conflict");
    // All-or-nothing: HEAD goes back to the pre-merge commit, and no retry with
    // --force is ever attempted (R18-4).
    expect(
      git.calls.some(
        (c) => c.includes("reset") && c.includes("--hard") && c.includes("abc1234def"),
      ),
    ).toBe(true);
    expect(git.calls.filter((c) => c.includes("push")).length).toBe(1);
  });

  it("refuses a DIRTY workspace instead of sweeping the agent's changes into a merge", async () => {
    bindPat();
    const git = fakeGit({ dirty: true });
    const res = await run(git.exec);
    expect(res.status).toBe("dirty_workspace");
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
    expect(git.calls.some((c) => c.includes("merge"))).toBe(false);
  });

  it("UNSHALLOWS a depth-1 clone before merging (a truncated history has no merge base)", async () => {
    bindPat();
    const git = fakeGit({ behind: 1, shallow: true });
    expect((await run(git.exec)).status).toBe("updated");
    // The WORKSPACE's fetch (from the server's stage) is the one that
    // unshallows: the stage borrows the mirror's full history.
    const fetch = git.calls.find(
      (c) => c.includes("fetch") && c.includes("+refs/heads/main:refs/remotes/origin/main"),
    );
    expect(fetch).toContain("--unshallow");
  });

  it("records git's OWN reason when the fetch fails (F19-6: a dropped reason is not an acceptable failure)", async () => {
    bindPat();
    const git = fakeGit({ fetchOk: false });
    const res = await run(git.exec);
    expect(res.status).toBe("update_failed");
    if (res.status !== "update_failed") throw new Error("unreachable");
    expect(res.detail).toContain("couldn't find remote ref main");
    expect(git.calls.some((c) => c.includes("merge"))).toBe(false);
  });

  it("never runs a git network command without a project credential", async () => {
    const git = fakeGit({ behind: 5 });
    const res = await run(git.exec);
    expect(res.status).toBe("no_pat");
    expect(git.calls.some((c) => c.includes("fetch"))).toBe(false);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("refuses when HEAD is on the default branch — it can never merge onto main", async () => {
    bindPat();
    const git = fakeGit({ branch: "main" });
    expect((await run(git.exec)).status).toBe("no_branch");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });
});

/**
 * Ruling 134(c) (pass 34, F34-11): the update reports origin's copy of the
 * TASK branch beside its base answer, derived locally from the fetched remote
 * ref. Canary: drop the branch fetch (`readRemoteBranchState` returns
 * `unknown`) and every state below reads `unknown`.
 */
describe("ruling 134(c): origin's copy of the task branch", () => {
  it("`already_current` carries `behind` with the count when origin lags the workspace", async () => {
    bindPat();
    const git = fakeGit({ behind: 0, remote: { kind: "behind", ahead: 2 } });
    const res = await run(git.exec);
    expect(res).toEqual({
      status: "already_current",
      branch: "vib-1",
      base: "main",
      remote: { kind: "behind", headSha: REMOTE_SHA, commits: 2 },
    });
    // The remote ref is FETCHED (the object is needed for the ancestry test),
    // not merely listed.
    expect(git.calls.some((c) => c.includes("fetch") && c.some((a) => a.includes("refs/heads/vib-1:")))).toBe(true);
    expect(git.calls.some((c) => c.includes("ls-remote"))).toBe(false);
  });

  it("the four other states: current, diverged, absent, unknown", async () => {
    // Canary: collapse `diverged` into `behind` (treat a failed ancestry test as behind).
    bindPat();
    expect(await run(fakeGit({ behind: 0 }).exec)).toMatchObject({ remote: { kind: "current", headSha: PRE_SHA } });
    expect(await run(fakeGit({ behind: 0, remote: { kind: "diverged" } }).exec)).toMatchObject({
      remote: { kind: "diverged", headSha: REMOTE_SHA },
    });
    expect(await run(fakeGit({ behind: 0, remote: { kind: "absent" } }).exec)).toMatchObject({ remote: { kind: "absent" } });
    const unknown = await run(fakeGit({ behind: 0, remote: { kind: "unknown" } }).exec);
    expect(unknown).toMatchObject({ remote: { kind: "unknown" } });
    expect(unknown.status === "already_current" && unknown.remote.kind === "unknown" ? unknown.remote.why : "").toContain("could not resolve host");
  });

  it("`updated` reports `current` after the push and names the pre-push lag", async () => {
    // Canary: report the pre-push state in `remote` (copy `remoteBefore`).
    bindPat();
    const res = await run(fakeGit({ behind: 2, remote: { kind: "behind", ahead: 1 } }).exec);
    expect(res).toMatchObject({
      status: "updated",
      commits: 2,
      remoteBefore: { kind: "behind", headSha: REMOTE_SHA, commits: 1 },
      remote: { kind: "current", headSha: MERGE_SHA },
    });
  });
});

/**
 * Ruling 132 (pass 34, F34-14): an updated branch names its merge commit and
 * the base tip, read BEFORE the push; a refresh that cannot be recorded is
 * rolled back and never published. Canary: return the old four-field result.
 */
describe("ruling 132: the refresh is recorded before it is published", () => {
  it("an updated branch names its merge commit and the base tip, and merges with --no-ff", async () => {
    bindPat();
    const git = fakeGit({ behind: 2 });
    const res = await run(git.exec);
    expect(res).toMatchObject({ status: "updated", mergeSha: MERGE_SHA, baseSha: BASE_SHA, base: "main" });
    const merge = git.calls.find((c) => c.includes("merge") && !c.includes("--abort"))!;
    expect(merge).toContain("--no-ff");
    // The shas were read BEFORE the push.
    const pushIndex = git.calls.findIndex((c) => c.includes("push"));
    const shaIndex = git.calls.findIndex((c) => c.includes("rev-parse") && c.some((a) => a.startsWith("refs/remotes/origin/")));
    expect(shaIndex).toBeGreaterThan(-1);
    expect(shaIndex).toBeLessThan(pushIndex);
  });

  it("an unreadable merge sha resets to the pre-merge commit and pushes nothing", async () => {
    bindPat();
    const git = fakeGit({ behind: 2, mergeShaUnreadable: true });
    const res = await run(git.exec);
    expect(res).toMatchObject({ status: "update_failed", reason: expect.stringContaining("rolled back") });
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    expect(git.calls.some((c) => c.includes("reset") && c.includes(PRE_SHA))).toBe(true);
  });
});

/**
 * Ruling 159(b), pass 35 review: the delivery push is not the only door that
 * publishes the branch. This one pushes the whole workspace HEAD, so the stray
 * store-layout folder a refused delivery left committed on the local branch
 * would reach origin the moment an acceptance (or the operator's
 * `update_branch_from_base`) refreshed it. Canary: drop the tree read and the
 * push runs.
 */
describe("ruling 159: the base refresh will not publish the store layout either", () => {
  const STRAY = (slug: string) => `projects/${slug}/tasks/VIB-1/attachments/résumé.png`;

  it("refuses a branch whose tree carries the store layout, merging and pushing nothing", async () => {
    bindPat();
    const stray = STRAY(store.slug);
    const git = fakeGit({ behind: 2, storeLayoutFiles: [stray] });
    const res = await run(git.exec);
    expect(res).toMatchObject({ status: "store_layout", branch: "vib-1", files: [stray] });
    expect(res.status === "store_layout" ? res.reason : "").toContain(`\`${stray}\``);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    expect(git.calls.some((c) => c.includes("merge") && !c.includes("merge-base"))).toBe(false);
    // Read from HEAD's tree, NUL-delimited so a quoted path cannot hide.
    const lsTree = git.calls.find((c) => c.includes("ls-tree"));
    expect(lsTree).toEqual(["-C", expect.any(String), "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `projects/${store.slug}/tasks/`]);
  });

  it("a clean tree still updates the branch", async () => {
    bindPat();
    const git = fakeGit({ behind: 2, storeLayoutFiles: [] });
    expect(await run(git.exec)).toMatchObject({ status: "updated" });
    expect(git.calls.some((c) => c.includes("push"))).toBe(true);
  });
});

/**
 * Ruling 428 (pass 39): the base refresh is a door that publishes the branch,
 * and ruling 245's lease gate stood only at the delivery push. Live on
 * ax-clone at 00:11, AX-22's refresh published its rework commit while AX-20
 * held `internal/controller/task.go`, which AX-22's branch changes.
 */
describe("ruling 428: the base refresh honours file leases", () => {
  function leaseTo(holder: string, paths: string[]): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(holder, { stage: "review", branch: holder.toLowerCase() }),
    });
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      fileLeases: [{ paths, taskKey: holder, reason: "lands first" }],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("refuses a branch that changes a path another task holds, merging and pushing nothing", async () => {
    // CANARY: drop the lease gate from `updateWorkspaceBranchFromBase`.
    bindPat();
    leaseTo("VIB-2", ["internal/controller/task.go"]);
    const git = fakeGit({ behind: 2, branchFiles: ["internal/controller/gateway.go", "internal/controller/task.go"] });
    const res = await run(git.exec);
    expect(res).toMatchObject({ status: "lease_held", branch: "vib-1", path: "internal/controller/task.go", holder: "VIB-2" });
    expect(res.status === "lease_held" ? res.reason : "").toContain(
      "VIB-1 changes `internal/controller/task.go`, which VIB-2 holds (lands first).",
    );
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    expect(git.calls.some((c) => c.includes("merge") && !c.includes("merge-base"))).toBe(false);
  });

  it("a branch clear of every leased path still updates, and a finished holder binds nobody", async () => {
    bindPat();
    leaseTo("VIB-2", ["internal/controller/task.go"]);
    const clear = fakeGit({ behind: 2, branchFiles: ["internal/controller/gateway.go"] });
    expect(await run(clear.exec)).toMatchObject({ status: "updated" });
    // Ruling 245(b): the holder merged, so the lease is spent.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "done", branch: "vib-2" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const spent = fakeGit({ behind: 2, branchFiles: ["internal/controller/task.go"] });
    expect(await run(spent.exec)).toMatchObject({ status: "updated" });
  });
});
