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
import { defaultExec, pushWorkspaceBranch } from "./push-workspace.server";

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
  /** The push child was KILLED by its timeout rather than exiting non-zero. */
  pushTimedOut?: boolean;
  dirty?: boolean;
  aheadAfterCommit?: number;
  /** `git rev-list --count` fails outright (A3: UNKNOWN, not "no commits"). */
  countFails?: boolean;
  /** `rev-parse --is-shallow-repository` answer (default: not shallow). */
  shallow?: boolean;
  /** Whether the deepen fetch succeeds (default: true). */
  deepenOk?: boolean;
}) {
  const calls: string[][] = [];
  let committed = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: opts.branch, stderr: "" };
    if (args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: opts.shallow ? "true" : "false", stderr: "" };
    }
    if (args.includes("fetch")) {
      return opts.deepenOk === false
        ? { ok: false, stdout: "", stderr: "could not resolve host" }
        : { ok: true, stdout: "", stderr: "" };
    }
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
      if (opts.countFails) {
        return { ok: false, stdout: "", stderr: "fatal: bad revision" };
      }
      const ahead = committed ? (opts.aheadAfterCommit ?? opts.ahead + 1) : opts.ahead;
      return { ok: true, stdout: String(ahead), stderr: "" };
    }
    if (args.includes("push")) {
      return {
        ok: opts.pushOk !== false,
        ...(opts.pushTimedOut ? { timedOut: true } : {}),
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

  it("A3: a FAILED rev-list is UNKNOWN, not `no_commits` — it still pushes", async () => {
    // `countRes.ok ? parseInt(…) || 0 : 0` made an unreadable history
    // indistinguishable from an empty branch, and `no_commits` used to fall
    // through to openTaskPr — a review PR over a remote the delivery never
    // reached. Canary: restore the `: 0` fallback and this returns no_commits.
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 4, countFails: true });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("pushed");
    expect(git.calls.some((c) => c.includes("push"))).toBe(true);
  });

  it("A3: counts against origin/<default> and deepens a shallow clone first", async () => {
    // Clones are `--depth 1`, so `<default>..HEAD` runs over truncated history.
    // The reconcile path has deepened since P11-72; this one compared against
    // the LOCAL default branch with no guard at all.
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 2, shallow: true });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("pushed");
    const deepen = git.calls.find((c) => c.includes("fetch"));
    expect(deepen).toEqual([
      "-C", expect.any(String), "fetch", "--deepen", "50", "origin", "main",
    ]);
    const count = git.calls.find((c) => c.includes("--count"));
    expect(count).toContain("origin/main..HEAD");
  });

  it("A3: a shallow clone whose deepen FAILS is unknown — it pushes rather than claiming no_commits", async () => {
    bindPat();
    const git = fakeGit({
      branch: "vib-1-work", ahead: 0, shallow: true, deepenOk: false,
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("pushed");
    // Never even asked for a count it could not trust.
    expect(git.calls.some((c) => c.includes("--count"))).toBe(false);
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
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr: "remote: error: GH006: Protected branch update failed",
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_failed");
    expect(res.status === "push_failed" && res.detail).toContain("GH006");
  });

  it("F19-18: a rejected push carries git's own reason, scrubbed, instead of 'returned non-zero'", async () => {
    // A failed delivery push recorded its reason NOWHERE — not the timeline,
    // not the log. The human got the fixed words "git push returned non-zero"
    // and had to reproduce the push outside the product to learn that a branch
    // ruleset had declined it.
    // Canary: delete the `...(detail ? { detail } : {})` spread from the
    // push_failed return → the GH006 assertion fails.
    bindPat(); // stores ghp_faketoken123 as the project credential
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr:
        "remote: error: GH006: Protected branch update failed for refs/heads/vib-1-work.\n" +
        "remote: error: At least 1 approving review is required.\n" +
        "To https://x-access-token:ghp_faketoken123@github.com/akin-ozer/viberr.git\n" +
        " ! [remote rejected] vib-1-work -> vib-1-work (protected branch hook declined)\n" +
        "error: failed to push some refs",
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    // NOT push_conflict — isNonFastForwardStderr must not claim this one.
    expect(res.status).toBe("push_failed");
    const detail = res.status === "push_failed" ? (res.detail ?? "") : "";
    expect(detail).toContain("GH006");
    expect(detail).toContain("protected branch hook declined");
    // Layered redaction: the by-value layer catches the project PAT, and the
    // URL-userinfo layer removes the credential mechanism it was wearing.
    // Second canary: pass `{}` instead of `{ token }` to redactGitOutput and
    // this still passes (userinfo layer) — drop the userinfo rule too and it
    // fails. That independence is the point of the layering.
    expect(detail).not.toContain("ghp_faketoken123");
    expect(detail).not.toContain("x-access-token:");
  });

  it("a push KILLED by its timeout says so, instead of claiming git returned non-zero", async () => {
    // Same class as the clone-timeout bug this was found with: a process that
    // was killed never "returned" anything, and saying it did sends the reader
    // hunting for a git error that was never printed.
    // Canary: drop `timedOut` from defaultExec and the reason reverts.
    bindPat();
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushTimedOut: true,
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_failed");
    const reason = res.status === "push_failed" ? res.reason : "";
    expect(reason).toContain("ran past its time limit");
    expect(reason).not.toContain("returned non-zero");
  });

  it("defaultExec actually DETECTS a killed child (the fake above cannot prove this)", async () => {
    // The test above injects a fake exec, so it only proves the classification
    // downstream of `timedOut` — it would keep passing with the detection
    // deleted, which is exactly what its first canary showed. This one runs a
    // real process past a real timeout.
    // Canary: set `const timedOut = false` in defaultExec and this fails.
    const res = await defaultExec("sleep", ["5"], { cwd: process.cwd(), timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);

    // …and a plain non-zero exit is NOT reported as a timeout.
    const failed = await defaultExec("sh", ["-c", "exit 3"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(failed.ok).toBe(false);
    expect(failed.timedOut).toBeUndefined();
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
