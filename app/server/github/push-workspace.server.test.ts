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
      repo: "akin-ozer/viberr",
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

/** A fake git that answers the helper's probes and records the push. */
function fakeGit(opts: { branch: string; ahead: number; pushOk?: boolean }) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: opts.branch, stderr: "" };
    if (args.includes("--count")) return { ok: true, stdout: String(opts.ahead), stderr: "" };
    if (args.includes("push")) return { ok: opts.pushOk !== false, stdout: "", stderr: "" };
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

  it("no-ops when there are no local commits ahead", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 0 });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_commits");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
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
});
