import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { pushWorkspaceBranch } from "./push-workspace.server";

let ctx: TestDbContext;
let store: TestStore;

const SYS = { userId: null, label: "test" };

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      branch: "vib-1-work",
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  // A workspace repo dir so findRepoDir resolves (contents don't matter — exec is faked).
  mkdirSync(path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr", ".git"), {
    recursive: true,
  });
});

afterEach(() => ctx.cleanup());

function bindPat() {
  const pat = createPat(store.db, { userId: store.users.arda.id, label: "t", token: "ghp_faketoken123" }, SYS);
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
}

/** A fake git that answers the helper's probes and records the push. `dirty`
 * simulates uncommitted working-tree changes the agent left behind; once the
 * helper commits them, the ahead-count reflects the new commit. */
function fakeGit(opts: {
  branch: string;
  ahead: number;
  pushOk?: boolean;
  /** stderr the failed push emits (B-GH1 non-fast-forward classification). */
  pushStderr?: string;
  dirty?: boolean;
  aheadAfterCommit?: number;
}) {
  const calls: string[][] = [];
  let committed = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: opts.branch, stderr: "" };
    if (args.includes("status") && args.includes("--porcelain")) {
      return {
        ok: true,
        stdout: opts.dirty && !committed ? " M README.md\n?? scripts/list-files.ts\n" : "",
        stderr: "",
      };
    }
    if (args.includes("commit")) {
      committed = true;
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("--count")) {
      const ahead = committed ? (opts.aheadAfterCommit ?? opts.ahead + 1) : opts.ahead;
      return { ok: true, stdout: String(ahead), stderr: "" };
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

describe("pushWorkspaceBranch (F-GH3)", () => {
  it("pushes the task branch to origin when local commits are ahead", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 2 });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res).toEqual({ status: "pushed", branch: "vib-1-work", commits: 2 });
    const pushCall = git.calls.find((c) => c.includes("push"));
    expect(pushCall).toEqual(["-C", expect.any(String), "push", "origin", "HEAD:refs/heads/vib-1-work"]);
  });

  it("no-ops when there are no local commits ahead AND a clean tree", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 0 });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_commits");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    // A clean tree → no auto-commit.
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
  });

  it("COMMITS the agent's uncommitted changes, then pushes (delivery finalization)", async () => {
    bindPat();
    // The agent wrote files but never committed (e.g. execute-code-or-write-repo
    // withheld, or it read its workspace contract as prohibiting commit).
    const git = fakeGit({ branch: "vib-1-work", ahead: 0, dirty: true });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res).toEqual({ status: "pushed", branch: "vib-1-work", commits: 1 });
    // Staged everything, then committed with an inline identity + task-key message.
    expect(git.calls.some((c) => c.includes("add") && c.includes("-A"))).toBe(true);
    const commitCall = git.calls.find((c) => c.includes("commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall!.join(" ")).toContain("[VIB-1] deliver working-tree changes");
    expect(commitCall!.join(" ")).toContain("user.email=delivery@viberr.local");
    // And it never commits onto the default branch.
  });

  it("F10-03: refuses to stage/commit/push when the repo-write grant is withheld", async () => {
    bindPat();
    // Even with a dirty tree, a delivering profile whose execute-code-or-write-repo
    // grant is withheld must NOT have its workspace delivered — the honest
    // enforcement for Codex, which ignores the tool denylist.
    const git = fakeGit({ branch: "vib-1-work", ahead: 3, dirty: true });
    const res = await pushWorkspaceBranch({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
      exec: git.exec,
      canCommitPush: false,
    });
    expect(res.status).toBe("grant_withheld");
    expect(git.calls.some((c) => c.includes("add"))).toBe(false);
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("never auto-commits onto the default branch (HEAD on main)", async () => {
    bindPat();
    const git = fakeGit({ branch: "main", ahead: 0, dirty: true });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_branch");
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
  });

  it("degrades to no_pat when the project has no credential", async () => {
    const git = fakeGit({ branch: "vib-1-work", ahead: 3 });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_pat");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("does not push from a detached/default-branch HEAD", async () => {
    bindPat();
    const git = fakeGit({ branch: "main", ahead: 5 });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_branch");
  });

  it("returns push_failed when git push errors", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, pushOk: false });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_failed");
  });

  it("B-GH1/F15-15: a NON-FAST-FORWARD rejection is push_conflict, naming the branch, never a generic failure", async () => {
    // Fails on pre-pass-15 main: the union had no push_conflict and this
    // rejection surfaced as push_failed → "check the credential" copy.
    bindPat();
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr:
        " ! [rejected]        vib-1-work -> vib-1-work (non-fast-forward)\n" +
        "error: failed to push some refs\n" +
        "hint: Updates were rejected because the tip of your current branch is behind\n",
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_conflict");
    if (res.status === "push_conflict") {
      expect(res.branch).toBe("vib-1-work");
      expect(res.reason).toContain("non-fast-forward");
      expect(res.reason).not.toContain("credential");
    }
  });

  it("isNonFastForwardStderr classifies git's rejection texts and nothing else", async () => {
    const { isNonFastForwardStderr } = await import("./push-workspace.server");
    expect(isNonFastForwardStderr("! [rejected] x -> x (non-fast-forward)")).toBe(true);
    expect(isNonFastForwardStderr("hint: (e.g., 'git pull ...') — fetch first")).toBe(true);
    expect(isNonFastForwardStderr("fatal: Authentication failed for 'https://…'")).toBe(false);
    expect(isNonFastForwardStderr("fatal: unable to access: Could not resolve host")).toBe(false);
  });
});
