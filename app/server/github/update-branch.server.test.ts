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
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
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
} = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) {
      return { ok: true, stdout: opts.branch ?? "vib-1", stderr: "" };
    }
    if (args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: opts.shallow ? "true" : "false", stderr: "" };
    }
    if (args.includes("status") && args.includes("--porcelain")) {
      return { ok: true, stdout: opts.dirty ? " M app/main.ts\n" : "", stderr: "" };
    }
    if (args.includes("fetch")) {
      return opts.fetchOk === false
        ? { ok: false, stdout: "", stderr: "fatal: couldn't find remote ref main" }
        : { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("--count")) {
      return { ok: true, stdout: String(opts.behind ?? 3), stderr: "" };
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return { ok: true, stdout: "abc1234def", stderr: "" };
    }
    if (args.includes("merge") && args.includes("--abort")) {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("merge")) {
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
    });
    // Fetches the base by EXPLICIT refspec — `origin/main` is what the merge
    // reads, and relying on git's opportunistic tracking update would make that
    // a git-version question.
    const fetch = git.calls.find((c) => c.includes("fetch"));
    expect(fetch).toContain("+refs/heads/main:refs/remotes/origin/main");
    const merge = git.calls.find(
      (c) => c.includes("merge") && !c.includes("--abort"),
    );
    expect(merge).toContain("origin/main");
    expect(merge!.join(" ")).toContain("[VIB-1] merge main into vib-1");
    expect(git.calls.find((c) => c.includes("push"))).toEqual([
      "-C",
      expect.any(String),
      "push",
      "origin",
      "HEAD:refs/heads/vib-1",
    ]);
  });

  it("MERGES rather than rebases — nothing is ever force-pushed (R18-4)", async () => {
    bindPat();
    const git = fakeGit({ behind: 2 });
    await run(git.exec);
    const flat = git.calls.map((c) => c.join(" ")).join("\n");
    expect(flat).not.toMatch(/rebase/);
    expect(flat).not.toMatch(/--force|\+refs\/heads\/vib-1|-f\b/);
  });

  it("is a no-op that SAYS SO when the branch is already current", async () => {
    bindPat();
    const git = fakeGit({ behind: 0 });
    expect(await run(git.exec)).toEqual({
      status: "already_current",
      branch: "vib-1",
      base: "main",
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
    const fetch = git.calls.find((c) => c.includes("fetch"));
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
