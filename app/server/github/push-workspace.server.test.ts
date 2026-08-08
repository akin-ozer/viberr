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
  /** `git rev-parse --verify <rev>` answers (F19-21's local zero-ahead proof).
   *  An absent rev fails, exactly as git does. */
  revs?: Record<string, string>;
  /** What `for-each-ref refs/heads/` lists (F19-21: an abandoned task branch
   *  means the run DID branch, so HEAD sitting on main is a failure). */
  refs?: string[];
  /** The delivery auto-commit FAILS. The real block only logs and falls
   *  through, so the tree stays dirty and 0-ahead — the shape that used to be
   *  read as a verified zero-diff. */
  commitFails?: boolean;
}) {
  const calls: string[][] = [];
  let committed = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: opts.branch, stderr: "" };
    if (args.includes("--verify")) {
      const sha = opts.revs?.[args[args.length - 1]!];
      return sha
        ? { ok: true, stdout: sha, stderr: "" }
        : { ok: false, stdout: "", stderr: "" };
    }
    if (args.includes("for-each-ref")) {
      return { ok: true, stdout: (opts.refs ?? ["main"]).join("\n"), stderr: "" };
    }
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
      if (opts.commitFails) return { ok: false, stdout: "", stderr: "nothing added to commit" };
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
    // F19-21: a clean tree at this point is the EVIDENCE that there was genuinely
    // nothing to deliver — the only shape a no-change completion may be read from.
    expect(res).toMatchObject({ defaultBranchEvidence: { verified: true } });
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    // A clean tree → no auto-commit.
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
  });

  it("F19-21: a FAILED auto-commit leaves `no_commits` UNVERIFIED — uncommitted work is not 'no changes'", async () => {
    // The auto-commit block only LOGS its failures and falls through, so an
    // agent whose deliverable never made it into a commit still lands on
    // 0-ahead. Status alone therefore cannot mean "nothing to deliver": without
    // this evidence the caller closed genuine, uncommitted work as
    // "completed with no changes required".
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 0, dirty: true, commitFails: true });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("no_commits");
    expect(res).toMatchObject({ defaultBranchEvidence: { verified: false } });
    expect(
      (res as { defaultBranchEvidence?: { why?: string } }).defaultBranchEvidence?.why,
    ).toContain("uncommitted");
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

  /**
   * F19-21 — `no_branch` is TWO situations wearing one status: a verify-only run
   * that correctly changed nothing, and a developer who edited files and forgot
   * `git checkout -B`. `performDelivery` closes the first as "completed with no
   * changes", so this module has to tell them apart from the workspace itself —
   * the task file cannot (it holds no branch, no PR and no revision in either
   * case). Read-only throughout: a workspace on the default branch is never
   * staged or committed, whatever it holds.
   */
  describe("F19-21: default-branch evidence", () => {
    const push = (git: ReturnType<typeof fakeGit>) =>
      pushWorkspaceBranch({
        db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
        dataRoot: store.dataRoot, exec: git.exec,
      });

    it("verifies a CLEAN default-branch workspace — the shape a no-change completion is read from", async () => {
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 0 });
      const res = await push(git);
      expect(res).toEqual({
        status: "no_branch",
        reason:
          "HEAD is on the default branch (main) with a clean working tree, no local commits and no task branch",
        defaultBranchEvidence: { verified: true },
      });
      // Read-only: it looked, it never wrote.
      expect(git.calls.some((c) => c.includes("add"))).toBe(false);
      expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
      expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    });

    it("a DIRTY tree is NOT verified — the developer who forgot to branch is a real failure", async () => {
      // The finding: this was the case a disclaimer sentence stood in for, so
      // uncommitted work was recorded as a verified no-change completion.
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 0, dirty: true });
      const res = await push(git);
      expect(res.status).toBe("no_branch");
      expect(res).toMatchObject({
        defaultBranchEvidence: {
          verified: false,
          why: "its working tree holds uncommitted changes (2 paths) that never reached a task branch",
        },
      });
      expect(res.status === "no_branch" && res.reason).toContain("uncommitted changes");
      expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
    });

    it("LOCAL COMMITS on the default branch are not a verified no-change", async () => {
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 2 });
      const res = await push(git);
      expect(res).toMatchObject({
        defaultBranchEvidence: {
          verified: false,
          why: "it carries 2 local commits that origin/main does not",
        },
      });
    });

    it("an ABANDONED task branch is not a verified no-change — the run did branch", async () => {
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 0, refs: ["main", "vib-1-work"] });
      const res = await push(git);
      expect(res).toMatchObject({
        defaultBranchEvidence: {
          verified: false,
          why: "the task branch `vib-1-work` exists in the workspace but HEAD is not on it",
        },
      });
      // Answered locally — no history walk, no deepen.
      expect(git.calls.some((c) => c.includes("--count"))).toBe(false);
    });

    it("a branch belonging to ANOTHER task does not count as this task's", async () => {
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 0, refs: ["main", "vib-10", "spike"] });
      const res = await push(git);
      expect(res).toMatchObject({ defaultBranchEvidence: { verified: true } });
    });

    it("an UNREADABLE history is unknown, never clean", async () => {
      // Same rule as A3 one function over: `null` is not zero.
      bindPat();
      const git = fakeGit({ branch: "main", ahead: 0, countFails: true });
      const res = await push(git);
      expect(res).toMatchObject({
        defaultBranchEvidence: {
          verified: false,
          why: "its history could not be compared with origin/main",
        },
      });
    });

    it("proves zero-ahead LOCALLY when HEAD is origin/<default> — no deepen, no network", async () => {
      // Clones are `--depth 1` over a credential-free origin, so the deepen the
      // count needs can simply fail on a private repo. The shape this exists for
      // needs no history walk: HEAD identical to origin/main IS the proof.
      bindPat();
      const sha = "c".repeat(40);
      const git = fakeGit({
        branch: "main", ahead: 0, shallow: true, deepenOk: false,
        revs: { HEAD: sha, "origin/main": sha },
      });
      const res = await push(git);
      expect(res).toMatchObject({ defaultBranchEvidence: { verified: true } });
      expect(git.calls.some((c) => c.includes("fetch"))).toBe(false);
      expect(git.calls.some((c) => c.includes("--count"))).toBe(false);
    });

    it("a DETACHED HEAD carries no evidence at all — nothing was proven either way", async () => {
      bindPat();
      const git = fakeGit({ branch: "HEAD", ahead: 0 });
      const res = await push(git);
      expect(res).toEqual({
        status: "no_branch",
        reason: "HEAD is detached, so there is no branch to push",
      });
      // Not even probed: a detached HEAD is not the default branch.
      expect(git.calls.some((c) => c.includes("for-each-ref"))).toBe(false);
    });
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

  it("F19-18: a rejected push NAMES git's reason (redacted), instead of 'returned non-zero'", async () => {
    // The residual bucket — protected branch, push ruleset, pre-receive hook,
    // 403, DNS — collapsed to the fixed string "git push returned non-zero",
    // and stderr was kept NOWHERE: not on the timeline event performDelivery
    // builds from this reason, not in the log line, not in any run log. A
    // maintainer with a probe-verified credential had to reproduce the push
    // outside Viberr to learn the word "protected".
    //
    // Canary: drop the `stderrExcerpt` arm from the reason and this fails on
    // the GH006 assertion.
    bindPat();
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr:
        "remote: error: GH006: Protected branch update failed for refs/heads/vib-1-work.\n" +
        "remote: error: Required status check \"ci\" is expected.\n" +
        "To https://github.com/acme/app.git\n" +
        " ! [remote rejected] vib-1-work -> vib-1-work (protected branch hook declined)\n",
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_failed");
    const reason = res.status === "push_failed" ? res.reason : "";
    expect(reason).toContain("GH006: Protected branch update failed");
    expect(reason).not.toContain("returned non-zero");
    // The reason is interpolated INSIDE a prose sentence by performDelivery, so
    // it must stay one line; the full excerpt rides the structured field.
    expect(reason).not.toContain("\n");
    expect(res.status === "push_failed" ? res.stderrExcerpt : "").toContain(
      "protected branch hook declined",
    );
  });

  it("F19-18: the project PAT never reaches the surfaced reason", async () => {
    // The old comment ("Redact stderr — a git push failure can echo the remote
    // URL/token") named a real rule. Keeping git's words means proving the
    // secret is scrubbed BY VALUE, not hoping stderr is clean.
    // Canary: pass `[]` instead of `[token]` to redactGitStderr and this fails.
    bindPat(); // the fixture's PAT is `ghp_faketoken123`
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr:
        "fatal: Authentication failed using ghp_faketoken123 for " +
        "'https://x-access-token:ghp_faketoken123@github.com/acme/app.git/'\n",
    });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    expect(res.status).toBe("push_failed");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("ghp_faketoken123");
    expect(serialized).toContain("Authentication failed");
  });

  it("F19-18: a push that printed nothing says so, rather than inventing a cause", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, pushOk: false, pushStderr: "" });
    const res = await pushWorkspaceBranch({
      db: store.db, projectSlug: store.slug, taskKey: "VIB-1",
      dataRoot: store.dataRoot, exec: git.exec,
    });
    const reason = res.status === "push_failed" ? res.reason : "";
    expect(reason).toContain("git printed nothing");
    expect(res.status === "push_failed" ? res.stderrExcerpt : "x").toBeUndefined();
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
