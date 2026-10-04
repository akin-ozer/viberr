import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { gitOutSync, withLocalGithub } from "../../../test-support/git-origin";
import {
  createPat,
  getProjectCredentialHealth,
  recordPatValidation,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import type { PatValidation } from "~/schemas/github-pat.schema";
import { taskDir } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { serverExec } from "~/server/tasks/workspace-git.server";
import {
  discardLocalTaskBranch,
  pushWorkspaceBranch,
  isWorkflowScopeRejection,
  type ExecOutcome,
} from "./push-workspace.server";

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

/** Push VIB-1's workspace branch over the fake git runner `git`. */
const push = (git: ReturnType<typeof fakeGit>) =>
  pushWorkspaceBranch({ db: store.db, projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, exec: git.exec });

/**
 * git's own `core.quotePath` rendering: a path with a byte outside printable
 * ASCII is emitted as a C-quoted string (octal escapes, wrapped in double
 * quotes). Modelled here so the fake cannot be kinder to the guard than git is.
 */
function gitQuotePath(p: string): string {
  const bytes = Buffer.from(p, "utf8");
  if (bytes.every((b) => b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c)) return p;
  const body = [...bytes]
    .map((b) =>
      b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
        ? String.fromCharCode(b)
        : `\\${b.toString(8).padStart(3, "0")}`,
    )
    .join("");
  return `"${body}"`;
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
  /** Ruling 134: what `git ls-remote --heads origin <branch>` answers — the
   *  sha origin holds for the branch, `null` for "no such branch", or absent
   *  for "same as HEAD" (the default: the fixtures below started on a lagging
   *  remote before ruling 134 existed). */
  remoteHead?: string | null;
  /** `ls-remote` fails outright (offline, refused). */
  lsRemoteFails?: boolean;
  /** Ruling 144: what `git log --format= --name-only <range> -- .github/workflows/`
   *  lists, keyed by range. Absent ranges list nothing. */
  workflowFilesByRange?: Record<string, string[]>;
  /** Ruling 245: what the UNFILTERED `git log --name-only <range>` lists — every
   *  file the push changes, which the lease gate reads. Keyed by range, and
   *  distinct from the workflow list because the two calls differ only by their
   *  pathspec and a shared fixture would make one stand in for the other. */
  changedFilesByRange?: Record<string, string[]>;
  /** Ruling 353: what `git merge-base origin/<default> HEAD` answers — the
   *  fork point the lease gate measures the BRANCH from. Defaults to FORK. */
  mergeBase?: string | null;
  /** Pass 34 review: the `git log` that measures those files FAILS (a shallow
   *  clone with no `origin/<default>`, a truncated history). */
  workflowLogFails?: boolean;
  /** Ruling 159: what `git ls-tree -r --name-only HEAD -- projects/<slug>/tasks/`
   *  lists, i.e. the store-layout paths HEAD's tree carries. `after` lists
   *  them only once the delivery auto-commit ran (the agent left the stray
   *  folder uncommitted). */
  storeLayoutFiles?: string[];
  storeLayoutFilesAfterCommit?: string[];
  /** The tree read itself fails (a corrupt or unreadable HEAD). */
  lsTreeFails?: boolean;
}) {
  const calls: string[][] = [];
  /** The env the `ls-remote` read ran under (ruling 134: the askpass channel). */
  const envs: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  let committed = false;
  const HEAD = "a".repeat(40);
  const FORK = "d".repeat(40);
  const exec = vi.fn(async (_file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push(args);
    envs.push({ args, env: options?.env });
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: opts.branch, stderr: "" };
    if (args.includes("--verify")) {
      const rev = args[args.length - 1]!;
      if (rev === "HEAD" && !opts.revs?.HEAD) return { ok: true, stdout: HEAD, stderr: "" };
      const sha = opts.revs?.[rev];
      return sha
        ? { ok: true, stdout: sha, stderr: "" }
        : { ok: false, stdout: "", stderr: "" };
    }
    if (args.includes("ls-tree")) {
      if (opts.lsTreeFails) return { ok: false, stdout: "", stderr: "fatal: not a tree object" };
      const files = committed
        ? (opts.storeLayoutFilesAfterCommit ?? opts.storeLayoutFiles ?? [])
        : (opts.storeLayoutFiles ?? []);
      // Real git's two output modes, because the difference between them is
      // the whole finding: `-z` prints raw NUL-terminated paths, and WITHOUT
      // it `core.quotePath` (on by default) C-quotes any name carrying a
      // non-ASCII byte, so the line starts with a double quote and no prefix
      // filter can see it.
      return args.includes("-z")
        ? { ok: true, stdout: files.map((f) => `${f}\0`).join(""), stderr: "" }
        : { ok: true, stdout: files.map(gitQuotePath).join("\n"), stderr: "" };
    }
    if (args.includes("merge-base") && !args.includes("--is-ancestor")) {
      if (opts.mergeBase === null) return { ok: false, stdout: "", stderr: "fatal: no merge base" };
      return { ok: true, stdout: opts.mergeBase ?? FORK, stderr: "" };
    }
    if (args.includes("--name-only")) {
      if (opts.workflowLogFails) {
        return { ok: false, stdout: "", stderr: "fatal: bad revision 'origin/main..HEAD'" };
      }
      const range = args[args.indexOf("--name-only") + 1] ?? "";
      // Ruling 245: the lease gate's read carries no pathspec; ruling 144's
      // carries `.github/workflows/`. Same command, different question.
      const scoped = args.includes(".github/workflows/");
      const table = scoped ? opts.workflowFilesByRange : opts.changedFilesByRange;
      return { ok: true, stdout: (table?.[range] ?? []).join("\n"), stderr: "" };
    }
    if (args.includes("ls-remote")) {
      if (opts.lsRemoteFails) return { ok: false, stdout: "", stderr: "fatal: could not read from remote" };
      if (opts.remoteHead === null) return { ok: true, stdout: "", stderr: "" };
      const sha = opts.remoteHead ?? "b".repeat(40);
      return { ok: true, stdout: `${sha}\trefs/heads/${opts.branch}\n`, stderr: "" };
    }
    if (args.includes("for-each-ref")) {
      return { ok: true, stdout: (opts.refs ?? ["main"]).join("\n"), stderr: "" };
    }
    if (args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: opts.shallow ? "true" : "false", stderr: "" };
    }
    if (args.includes("fetch")) {
      // Pass 40 review (R-seams-1): the deepen is the workspace's own fetch
      // from origin; the delivery's hand-off (the server's stage fetching the
      // branch OUT of the workspace) is local and answers on its own.
      if (!args.includes("--deepen")) return { ok: true, stdout: "", stderr: "" };
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
      // `timedOut` is OMITTED unless the child was killed, exactly as
      // `execOutcome` writes it — a falsy key would not be the same outcome.
      const pushed: ExecOutcome = {
        ok: opts.pushOk !== false,
        stdout: "",
        stderr: opts.pushOk === false ? (opts.pushStderr ?? "") : "",
      };
      if (opts.pushTimedOut) pushed.timedOut = true;
      return pushed;
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  return { exec, calls, envs };
}

describe("pushWorkspaceBranch (F-GH3)", () => {
  it("pushes the task branch to origin when local commits are ahead", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 2 });
    const res = await push(git);
    expect(res).toEqual({
      status: "pushed",
      branch: "vib-1-work",
      commits: 2,
      headSha: "a".repeat(40),
      remoteHeadBefore: "b".repeat(40),
    workflowFiles: [],
    });
    // Pass 40 review (R-seams-1): the push runs in the server's own stage,
    // never in the agent-writable workspace, to the project's GitHub URL
    // (never the checkout's `origin`), and publishes the head it compared with origin.
    const pushCall = git.calls.find((c) => c.includes("push"));
    expect(pushCall).toEqual([
      expect.stringMatching(/^--git-dir=.*\.repo-stage/),
      "push",
      "https://github.com/akin-ozer/viberr.git",
      `${"a".repeat(40)}:refs/heads/vib-1-work`,
    ]);
    // …after the branch was fetched OUT of the workspace into that stage.
    const handoff = git.calls.find((c) => c.includes("fetch") && !c.includes("--deepen"));
    expect(handoff?.[0]).toBe(pushCall?.[0]);
    expect(handoff).toContain("+refs/heads/vib-1-work:refs/heads/vib-1-work");
    expect(handoff).toContain(
      path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr"),
    );
  });

  it("ruling 480 (F40-43): a push GitHub accepted proves `repo` on the project's repository; a refused one proves nothing", async () => {
    // Live, the card read "repo unproven (verified on first use)" after three
    // pushes. Canary: drop the `markWriteScopeProven(…, "push")` call after the
    // push and the last assertion reads `unchecked`.
    bindPat();
    const repoChip = () =>
      getProjectCredentialHealth(store.db, store.slug).scopes.find((s) => s.id === "repo");
    expect(repoChip()).toMatchObject({ source: "unchecked" });
    const refused = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr: "remote: error: GH006: Protected branch update failed",
    });
    const failed = await push(refused);
    expect(failed.status).toBe("push_failed");
    expect(repoChip()).toMatchObject({ source: "unchecked" });
    const git = fakeGit({ branch: "vib-1-work", ahead: 2 });
    const res = await push(git);
    expect(res.status).toBe("pushed");
    expect(repoChip()).toEqual({ id: "repo", ok: true, source: "probe" });
  });

  /**
   * Ruling 134 (pass 34, F34-11): delivery is defined by the REMOTE. Origin's
   * head for the branch is read before the push; equal → no push at all.
   */
  describe("ruling 134: the pre-push remote read", () => {
    it("a workspace HEAD origin already carries is `up_to_date` and runs no push", async () => {
      // Canary: delete the early `up_to_date` return and this pushes anyway.
      bindPat();
      const git = fakeGit({ branch: "vib-1-work", ahead: 2, remoteHead: "a".repeat(40) });
      const res = await push(git);
      expect(res).toEqual({ status: "up_to_date", branch: "vib-1-work", headSha: "a".repeat(40) });
      expect(git.calls.some((c) => c.includes("push"))).toBe(false);
      // The remote was read under the askpass env, the same channel the push uses.
      const ls = git.calls.find((c) => c.includes("ls-remote"))!;
      // R-seams-1: asked from the server's stage, of the project's URL.
      expect(ls).toEqual([
        expect.stringMatching(/^--git-dir=.*\.repo-stage/),
        "ls-remote",
        "--heads",
        "https://github.com/akin-ozer/viberr.git",
        "vib-1-work",
      ]);
      const lsEnv = git.envs.find((e) => e.args.includes("ls-remote"))!.env;
      expect(lsEnv?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(lsEnv?.GIT_CONFIG_KEY_0).toBe("credential.helper");
    });

    it("the remote read and the push share ONE credential channel", async () => {
      bindPat();
      const git = fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: "0".repeat(40) });
      await push(git);
      const lsEnv = git.envs.find((e) => e.args.includes("ls-remote"))!.env;
      const pushEnv = git.envs.find((e) => e.args.includes("push"))!.env;
      expect(lsEnv).toBe(pushEnv);
    });

    it("a lagging origin is pushed exactly once, and the result names the head it replaced", async () => {
      // Canary: return the `pushed` literal without reading ls-remote — the
      // remote head reads null on a lagging origin and the ls-remote call is gone.
      bindPat();
      const git = fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: "0".repeat(40) });
      const res = await push(git);
      expect(res).toMatchObject({ status: "pushed", headSha: "a".repeat(40), remoteHeadBefore: "0".repeat(40), workflowFiles: [] });
      expect(git.calls.filter((c) => c.includes("push"))).toHaveLength(1);
      expect(git.calls.filter((c) => c.includes("ls-remote"))).toHaveLength(1);
      // An absent remote branch (first push) records no previous head.
      const first = fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: null });
      const fresh = await push(first);
      expect(fresh).toMatchObject({ status: "pushed", remoteHeadBefore: null, workflowFiles: [] });
    });

    it("an unreadable ls-remote never blocks the push", async () => {
      // Canary: fail the push when ls-remote fails and this reads `push_failed`.
      bindPat();
      const git = fakeGit({ branch: "vib-1-work", ahead: 1, lsRemoteFails: true });
      const res = await push(git);
      expect(res).toMatchObject({ status: "pushed", headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
      expect(git.calls.filter((c) => c.includes("push"))).toHaveLength(1);
    });
  });

  it("no-ops when there are no local commits ahead AND a clean tree", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 0 });
    const res = await push(git);
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
    const res = await push(git);
    expect(res.status).toBe("no_commits");
    if (res.status !== "no_commits") throw new Error("expected no_commits");
    expect(res).toMatchObject({ defaultBranchEvidence: { verified: false } });
    const evidence = res.defaultBranchEvidence;
    if (evidence?.verified !== false) throw new Error("expected unverified evidence");
    expect(evidence.why).toContain("uncommitted");
  });

  it("A3: a FAILED rev-list is UNKNOWN, not `no_commits` — it still pushes", async () => {
    // `countRes.ok ? parseInt(…) || 0 : 0` made an unreadable history
    // indistinguishable from an empty branch, and `no_commits` used to fall
    // through to openTaskPr — a review PR over a remote the delivery never
    // reached. Canary: restore the `: 0` fallback and this returns no_commits.
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 4, countFails: true });
    const res = await push(git);
    expect(res.status).toBe("pushed");
    expect(git.calls.some((c) => c.includes("push"))).toBe(true);
  });

  it("A3: counts against origin/<default> and deepens a shallow clone first", async () => {
    // Clones are `--depth 1`, so `<default>..HEAD` runs over truncated history.
    // The reconcile path has deepened since P11-72; this one compared against
    // the LOCAL default branch with no guard at all.
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 2, shallow: true });
    const res = await push(git);
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
    const res = await push(git);
    expect(res.status).toBe("pushed");
    // Never even asked for a count it could not trust.
    expect(git.calls.some((c) => c.includes("--count"))).toBe(false);
  });

  it("F21-22: the push log states a real count, or states that it has none", async () => {
    bindPat();
    const info = vi.spyOn(logger, "info");
    const counted = fakeGit({ branch: "vib-1-work", ahead: 2 });
    await push(counted);
    const pushedLog = () =>
      info.mock.calls.find((c) => c[0] === "pushed workspace branch to origin")?.[1] ?? {};
    expect(pushedLog()).toMatchObject({ commits: 2 });
    expect(pushedLog()).not.toHaveProperty("commitsUnknown");

    // The same line on a history that could not be counted (a shallow clone
    // whose deepen failed — the operator-deliver shape). It used to log
    // `commits: null`, which a reader takes for zero.
    info.mockClear();
    const unknown = fakeGit({
      branch: "vib-1-work", ahead: 0, shallow: true, deepenOk: false,
    });
    await push(unknown);
    expect(pushedLog()).toEqual({
      taskKey: "VIB-1",
      branch: "vib-1-work",
      commitsUnknown: true,
    });
    info.mockRestore();
  });

  it("COMMITS the agent's uncommitted changes, then pushes (delivery finalization)", async () => {
    bindPat();
    // The agent wrote files but never committed (e.g. execute-code-or-write-repo
    // withheld, or it read its workspace contract as prohibiting commit).
    const git = fakeGit({ branch: "vib-1-work", ahead: 0, dirty: true });
    const res = await push(git);
    expect(res).toEqual({ status: "pushed", branch: "vib-1-work", commits: 1, headSha: "a".repeat(40), remoteHeadBefore: "b".repeat(40), workflowFiles: [] });
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
    const res = await push(git);
    expect(res.status).toBe("no_branch");
    expect(git.calls.some((c) => c.includes("commit"))).toBe(false);
  });

  it("degrades to no_pat when the project has no credential", async () => {
    const git = fakeGit({ branch: "vib-1-work", ahead: 3 });
    const res = await push(git);
    expect(res.status).toBe("no_pat");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("does not push from a detached/default-branch HEAD", async () => {
    bindPat();
    const git = fakeGit({ branch: "main", ahead: 5 });
    const res = await push(git);
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
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr: "remote: error: GH006: Protected branch update failed",
    });
    const res = await push(git);
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
    const res = await push(git);
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
    const res = await push(git);
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
    // Canary: drop the `{ token }` arg to redactGitOutput and this fails.
    bindPat(); // the fixture's PAT is `ghp_faketoken123`
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushStderr:
        "fatal: Authentication failed using ghp_faketoken123 for " +
        "'https://x-access-token:ghp_faketoken123@github.com/acme/app.git/'\n",
    });
    const res = await push(git);
    expect(res.status).toBe("push_failed");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("ghp_faketoken123");
    expect(serialized).toContain("Authentication failed");
  });

  it("F19-18: a push that printed nothing says so, rather than inventing a cause", async () => {
    bindPat();
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, pushOk: false, pushStderr: "" });
    const res = await push(git);
    const reason = res.status === "push_failed" ? res.reason : "";
    expect(reason).toContain("git printed nothing");
    expect(res.status === "push_failed" ? res.stderrExcerpt : "x").toBeUndefined();
  });

  it("a push KILLED by its timeout says so, instead of claiming git returned non-zero", async () => {
    // Same class as the clone-timeout bug this was found with: a process that
    // was killed never "returned" anything, and saying it did sends the reader
    // hunting for a git error that was never printed.
    // Canary: drop the `pushRes.timedOut` arm of the push-failure reason and
    // the reason reverts.
    bindPat();
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      pushOk: false,
      pushTimedOut: true,
    });
    const res = await push(git);
    expect(res.status).toBe("push_failed");
    const reason = res.status === "push_failed" ? res.reason : "";
    expect(reason).toContain("ran past its time limit");
    expect(reason).not.toContain("returned non-zero");
  });

  it("the server's git runner detects a killed child (the fake above cannot prove this)", async () => {
    // The test above injects a fake exec, so it only proves the classification
    // downstream of `timedOut` — it would keep passing with the detection
    // deleted, which is exactly what its first canary showed. This one runs a
    // real process past a real timeout.
    // Canary: drop the `killed || signal` arm in `execOutcome`
    // (workspace-git.server.ts) and this fails.
    const res = await serverExec("sleep", ["5"], { cwd: process.cwd(), timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);

    // …and a plain non-zero exit is NOT reported as a timeout.
    const failed = await serverExec("sh", ["-c", "exit 3"], {
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
    const res = await push(git);
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

describe("discardLocalTaskBranch (F20-6 / R20-2)", () => {
  const REPO = () =>
    path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr");

  /** A REAL git workspace at the repo dir findWorkspaceRepoDir resolves to. */
  function initWorkspaceRepo(withTaskBranch: boolean): string {
    const repoDir = REPO();
    // beforeEach left a fake empty `.git`; start from a clean real repo.
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    gitOutSync(repoDir, ["init", "-q", "-b", "main"]);
    gitOutSync(repoDir, ["config", "user.email", "t@viberr.local"]);
    gitOutSync(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
    gitOutSync(repoDir, ["add", "-A"]);
    gitOutSync(repoDir, ["commit", "-q", "-m", "init"]);
    if (withTaskBranch) {
      gitOutSync(repoDir, ["checkout", "-q", "-b", "vib-1-work"]);
      writeFileSync(path.join(repoDir, "work.txt"), "work\n");
      gitOutSync(repoDir, ["add", "-A"]);
      gitOutSync(repoDir, ["commit", "-q", "-m", "work"]);
      gitOutSync(repoDir, ["checkout", "-q", "main"]);
    }
    return repoDir;
  }

  it("deletes a local, never-pushed task branch and reports its sha", async () => {
    const repoDir = initWorkspaceRepo(true);
    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      branch: "vib-1-work",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
    });
    expect(out.status).toBe("deleted");
    if (out.status === "deleted") {
      expect(out.branch).toBe("vib-1-work");
      expect(out.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    // The branch is really gone.
    expect(() =>
      gitOutSync(repoDir, ["rev-parse", "--verify", "refs/heads/vib-1-work"]),
    ).toThrow();
  });

  it("refuses when the remote cannot answer, instead of destroying commits", async () => {
    // The ruling-17 guard ran `ls-remote` with NO credential, so on a private
    // repo it always failed to authenticate — and `--exit-code` made that
    // failure indistinguishable from "origin does not carry it", so the branch
    // was deleted anyway and the outcome recorded a check that never happened.
    // Canary: treat a failed ls-remote as "not on the remote" again and this
    // returns "deleted" with the commits gone.
    const repoDir = initWorkspaceRepo(true);
    // A real origin the check cannot reach: the question EXISTS and goes
    // unanswered, which is the case that must refuse.
    gitOutSync(repoDir, ["remote", "add", "origin", "https://example.invalid/acme/app.git"]);

    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      branch: "vib-1-work",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
      // Only the REMOTE question fails; every local git call is the real one,
      // so the branch really exists and really would be deletable.
      exec: async (_file, args) => {
        if (args.includes("ls-remote")) {
          return {
            ok: false,
            stdout: "",
            stderr:
              "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled",
          };
        }
        try {
          return { ok: true, stdout: gitOutSync(repoDir, args.slice(2)), stderr: "" };
        } catch (error) {
          return { ok: false, stdout: "", stderr: String(error) };
        }
      },
    });

    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.reason).toContain("could not confirm");
      expect(out.reason).toContain("vib-1-work");
    }
    // The commits are still there — nothing was destroyed on an unanswered
    // safety question.
    expect(() =>
      gitOutSync(repoDir, ["rev-parse", "--verify", "refs/heads/vib-1-work"]),
    ).not.toThrow();
  });

  it("steps off the branch when HEAD is on it, then deletes", async () => {
    const repoDir = initWorkspaceRepo(true);
    gitOutSync(repoDir, ["checkout", "-q", "vib-1-work"]); // HEAD now ON the branch
    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      branch: "vib-1-work",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
    });
    expect(out.status).toBe("deleted");
    expect(gitOutSync(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("reports not_found when the branch is not in the workspace", async () => {
    initWorkspaceRepo(false); // no task branch created
    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      branch: "vib-1-work",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
    });
    expect(out.status).toBe("not_found");
  });

  it("ruling 17: refuses a branch that exists on the remote and keeps it local", async () => {
    const repoDir = initWorkspaceRepo(true);
    // The PROJECT's repository (`akin-ozer/viberr`), stood in for on disk:
    // pass 40 review (R-seams-1) asks GitHub by the project's own URL, from
    // the server's stage, never through the checkout's agent-writable config.
    const origins = path.join(store.dataRoot, "origins");
    const remoteDir = path.join(origins, "akin-ozer", "viberr.git");
    mkdirSync(remoteDir, { recursive: true });
    gitOutSync(remoteDir, ["init", "-q", "--bare"]);
    gitOutSync(repoDir, ["remote", "add", "origin", remoteDir]);
    gitOutSync(repoDir, ["push", "-q", "origin", "vib-1-work"]);
    const out = await withLocalGithub(origins, () =>
      discardLocalTaskBranch({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        branch: "vib-1-work",
        defaultBranch: "main",
        dataRoot: store.dataRoot,
      }),
    );
    expect(out.status).toBe("on_remote");
    // A refused discard leaves the local branch intact.
    expect(() =>
      gitOutSync(repoDir, ["rev-parse", "--verify", "refs/heads/vib-1-work"]),
    ).not.toThrow();
  });

  it("reports no_workspace when the task has no clone", async () => {
    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-404",
      branch: "vib-404",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
    });
    expect(out.status).toBe("no_workspace");
  });

  it("ruling 69: a failed git command carries git's REDACTED words", async () => {
    // Fake exec: the branch delete fails with a token-bearing URL in stderr.
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("--verify")) {
        return { ok: true, stdout: "a".repeat(40), stderr: "" };
      }
      if (args.includes("ls-remote")) return { ok: false, stdout: "", stderr: "" };
      if (args.includes("--abbrev-ref")) return { ok: true, stdout: "main", stderr: "" };
      if (args.includes("branch") && args.includes("-D")) {
        return {
          ok: false,
          stdout: "",
          stderr:
            "error: could not delete refs at https://ghp_SECRETTOKEN0123456789ABCDEF@github.com — locked",
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const out = await discardLocalTaskBranch({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      branch: "vib-1-work",
      defaultBranch: "main",
      dataRoot: store.dataRoot,
      exec,
    });
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.reason).toContain("could not delete");
      expect(out.reason).not.toContain("ghp_SECRETTOKEN");
    }
  });
});

/**
 * Ruling 144 (pass 34, G34-2): the `workflow` scope. (b) Delivery measures the
 * workflow files a push changes as GitHub measures them and refuses BEFORE the
 * push when the bound classic token's published scopes lack `workflow`; (c)
 * GitHub's own refusal is classified `push_refused_scope`, never the generic
 * failure bucket. Canaries: remove the pre-push check; refuse whenever workflow
 * files are present (ignore the token); measure against `origin/<default>`
 * unconditionally; delete the classifier branch.
 */
describe("ruling 144: workflow-file pushes and the workflow scope", () => {
  const CI = ".github/workflows/ci.yml";
  const REMOTE = "b".repeat(40);
  function bindPatWith(validation: Pick<PatValidation, "tokenKind" | "headerScopes">) {
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "t", token: "ghp_faketoken123" }, SYS);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
    recordPatValidation(store.db, pat.id, {
      status: "valid",
      checkedAt: new Date().toISOString(),
      login: "bot",
      tokenKind: validation.tokenKind,
      expiresAt: null,
      repo: null,
      scopes: [],
      missingScopes: [],
      headerScopes: validation.headerScopes,
      detail: "",
    });
  }

  it("refuses BEFORE the push when a classic token lacks `workflow` and the push changes a workflow file", async () => {
    bindPatWith({ tokenKind: "classic", headerScopes: ["repo"] });
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: REMOTE, workflowFilesByRange: { [`${REMOTE}..HEAD`]: [CI] } });
    const res = await push(git);
    expect(res).toMatchObject({ status: "push_refused_scope", scope: "workflow", phase: "before_push", files: [CI], branch: "vib-1-work" });
    expect(res.status === "push_refused_scope" ? res.reason : "").toContain("no `workflow` scope");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("pushes when the token lists `workflow`, and when the scopes are unknown (fine-grained)", async () => {
    bindPatWith({ tokenKind: "classic", headerScopes: ["repo", "workflow"] });
    const listed = await push(fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: REMOTE, workflowFilesByRange: { [`${REMOTE}..HEAD`]: [CI] } }));
    expect(listed).toMatchObject({ status: "pushed", workflowFiles: [CI] });

    // Rebinding the project to a fine-grained token: no published list to read.
    bindPatWith({ tokenKind: "fine_grained", headerScopes: null });
    const unknown = await push(fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: REMOTE, workflowFilesByRange: { [`${REMOTE}..HEAD`]: [CI] } }));
    expect(unknown).toMatchObject({ status: "pushed", workflowFiles: [CI] });
  });

  it("a branch whose workflow file already reached origin is never refused for a push that does not touch it", async () => {
    bindPatWith({ tokenKind: "classic", headerScopes: ["repo"] });
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 3,
      remoteHead: REMOTE,
      // GitHub measures the ref update from origin's head: nothing under
      // .github/ there. The base range would list ci.yml, and must not be used.
      workflowFilesByRange: { [`${REMOTE}..HEAD`]: [], "origin/main..HEAD": [CI] },
    });
    const res = await push(git);
    expect(res).toMatchObject({ status: "pushed", workflowFiles: [] });
    // A FIRST push (no remote branch) measures from the base.
    const first = await push(fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: null, workflowFilesByRange: { "origin/main..HEAD": [CI] } }));
    expect(first).toMatchObject({ status: "push_refused_scope", phase: "before_push", files: [CI] });
  });

  it("GitHub's own rejection is `push_refused_scope`, never a generic `push_failed`", async () => {
    bindPatWith({ tokenKind: "fine_grained", headerScopes: null });
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      workflowFilesByRange: { [`${REMOTE}..HEAD`]: [CI] },
      pushOk: false,
      pushStderr:
        "remote: error: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope\n" +
        " ! [remote rejected] HEAD -> vib-1-work (refusing to allow a Personal Access Token to create or update workflow)",
    });
    const res = await push(git);
    expect(res).toMatchObject({ status: "push_refused_scope", scope: "workflow", phase: "github", files: [CI] });
    expect(res.status === "push_refused_scope" ? res.reason : "").toContain("without `workflow` scope");
  });

  it("an UNMEASURED push reports null, is not refused before the push, and claims nothing", async () => {
    // Canary: return `[]` from changedWorkflowFiles when history cannot answer
    // — the degraded read then reads as "this push changes no workflow files",
    // which the delivery would take as proof (ruling 144(c)).
    bindPatWith({ tokenKind: "classic", headerScopes: ["repo"] });
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, remoteHead: null, workflowLogFails: true });
    const res = await push(git);
    expect(res).toMatchObject({ status: "pushed", workflowFiles: null });
    // The push was attempted: an unmeasurable range refuses nothing on its own,
    // and GitHub's own answer classifies it.
    expect(git.calls.some((c) => c.includes("push"))).toBe(true);
  });

  it("the classifier does not mistake a protected-branch rejection for a scope refusal", () => {
    expect(isWorkflowScopeRejection("remote: error: GH006: Protected branch update failed for refs/heads/vib-1-work.")).toBe(false);
    expect(isWorkflowScopeRejection("refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope")).toBe(true);
  });
});

/**
 * Ruling 159 (pass 35, F35-10): a tree that carries Viberr's own store layout
 * (`projects/<slug>/tasks/...`) is never pushed. KNC-9's agent created the
 * store-relative attachments path inside its checkout, committed it, and the
 * delivery pushed it to GitHub. Canaries: delete the pre-count check (the push
 * proceeds); read the tree before the auto-commit (the uncommitted folder
 * slips through); treat an unreadable tree as empty.
 */
/**
 * Ruling 245 (pass 37, F37-74): a push that changes a file another task LEASES
 * is refused before it reaches GitHub.
 *
 * The seam is ruling 144's: this is the moment the change would become
 * published history, and the last one at which refusing costs nothing.
 */
describe("ruling 245: a leased file refuses the push", () => {
  const REMOTE = "c".repeat(40);
  // Ruling 353: the gate measures the branch from its fork point, not the push.
  const FORK = "d".repeat(40);
  const range = `${FORK}..HEAD`;
  const leaseTo = async (taskKey: string, paths: string[]) => {
    // Ruling 245(b): the holder must be a LIVE task. A lease naming a task that
    // is done, archived or absent binds nobody, so a fixture that skipped
    // seeding it would prove the gate works while actually proving it is
    // skipped — which is how this test first passed against a phantom holder.
    if (taskKey !== "VIB-1") {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(taskKey, { stage: "review" }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    }
    const { updateProjectFile } = await import("~/server/files/project-writer.server");
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.fileLeases = [{ paths, taskKey, reason: "splitting it into fragments" }];
    });
  };

  it("ruling 245(b): a lease whose HOLDER has merged binds nobody", async () => {
    await leaseTo("VIB-9", ["Makefile"]);
    // The live shape: SHOP-11 merged and its lease went on refusing SHOP-5.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "done" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const res = await push(fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      changedFilesByRange: { [range]: ["Makefile"] },
    }));
    // CANARY: read the raw frontmatter in the gate and this is `lease_held` —
    // a completed task fencing off a file forever.
    expect(res.status).toBe("pushed");
  });
  const push = (git: ReturnType<typeof fakeGit>) => {
    bindPat();
    return pushWorkspaceBranch({ db: store.db, projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, exec: git.exec });
  };

  it("refuses, names the holder and the file, and pushes nothing", async () => {
    await leaseTo("VIB-9", ["Makefile", "make/**"]);
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 2,
      remoteHead: REMOTE,
      changedFilesByRange: { [range]: ["services/cart/src/a.ts", "Makefile"] },
    });
    const res = await push(git);
    expect(res).toMatchObject({ status: "lease_held", path: "Makefile", holder: "VIB-9" });
    expect(res.status === "lease_held" ? res.reason : "").toContain("VIB-9 holds");
    // CANARY: drop the gate and this pushes. Nothing may reach the remote.
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("never refuses the HOLDER its own file", async () => {
    await leaseTo("VIB-1", ["Makefile"]);
    const res = await push(fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      changedFilesByRange: { [range]: ["Makefile"] },
    }));
    expect(res.status).toBe("pushed");
  });

  it("passes a push that touches nothing leased", async () => {
    await leaseTo("VIB-9", ["Makefile"]);
    const res = await push(fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      changedFilesByRange: { [range]: ["services/cart/src/a.ts"] },
    }));
    expect(res.status).toBe("pushed");
  });

  it("an UNMEASURABLE diff refuses nothing, rather than refusing everything", async () => {
    // Ruling 144's own distinction: `null` is "history could not answer", not
    // "no files changed". CANARY: treat a failed read as an empty list and this
    // still passes; treat it as a conflict and every degraded clone is blocked.
    await leaseTo("VIB-9", ["Makefile"]);
    const res = await push(fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      workflowLogFails: true,
    }));
    expect(res.status).toBe("pushed");
  });
});

describe("ruling 159: the store layout never reaches origin", () => {
  const STRAY = (slug: string) => `projects/${slug}/tasks/VIB-1/attachments/knc-9-licence-verification.txt`;

  it("refuses a revision whose tree holds projects/<slug>/tasks/..., names the path, and runs no push", async () => {
    bindPat();
    const stray = STRAY(store.slug);
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, storeLayoutFiles: [stray] });
    const res = await push(git);
    expect(res).toMatchObject({ status: "push_refused_store_layout", branch: "vib-1-work", files: [stray] });
    expect(res.status === "push_refused_store_layout" ? res.reason : "").toContain(`\`${stray}\``);
    expect(res.status === "push_refused_store_layout" ? res.reason : "").toContain("store layout");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    // The tree was read under the project's own prefix, from HEAD.
    const lsTree = git.calls.find((c) => c.includes("ls-tree"));
    expect(lsTree).toEqual(["-C", expect.any(String), "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `projects/${store.slug}/tasks/`]);
  });

  it("a stray folder the agent left UNCOMMITTED is caught after the delivery auto-commit", async () => {
    bindPat();
    const stray = STRAY(store.slug);
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 0,
      dirty: true,
      storeLayoutFiles: [],
      storeLayoutFilesAfterCommit: [stray],
    });
    const res = await push(git);
    expect(res).toMatchObject({ status: "push_refused_store_layout", files: [stray] });
    expect(git.calls.some((c) => c.includes("commit"))).toBe(true);
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("a stray file whose NAME is non-ASCII is seen too (git would quote it)", async () => {
    bindPat();
    // The realistic occupant of an attachments folder: a screenshot an agent
    // named with an accent. Under git's default `core.quotePath` this path is
    // printed C-quoted, and a guard that reads the quoted line measures an
    // EMPTY tree and lets the push publish the store layout.
    const stray = `projects/${store.slug}/tasks/VIB-1/attachments/résumé.png`;
    const git = fakeGit({ branch: "vib-1-work", ahead: 1, storeLayoutFiles: [stray] });
    const res = await push(git);
    expect(res).toMatchObject({ status: "push_refused_store_layout", files: [stray] });
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("a clean tree pushes as before, and an unreadable tree is not a measurement", async () => {
    bindPat();
    const clean = await push(fakeGit({ branch: "vib-1-work", ahead: 1, storeLayoutFiles: [] }));
    expect(clean).toMatchObject({ status: "pushed" });
    const unread = await push(fakeGit({ branch: "vib-1-work", ahead: 1, lsTreeFails: true }));
    expect(unread).toMatchObject({ status: "pushed" });
  });
});

/**
 * Ruling 353 (pass 38, F38-7): a lease binds the BRANCH, so a leased path that
 * reached origin before the lease was declared is still refused on the next
 * push — ruling 245's delta read let it through, and the acceptance ceremony
 * (no lease read) merged it ahead of the holder.
 */
describe("ruling 353: the lease gate measures the branch from its fork point", () => {
  const REMOTE = "c".repeat(40);
  const FORK = "d".repeat(40);
  const leaseTo = async (taskKey: string, paths: string[]) => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(taskKey, { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const { updateProjectFile } = await import("~/server/files/project-writer.server");
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.fileLeases = [{ paths, taskKey, reason: "one owner at a time" }];
    });
  };
  const push = (git: ReturnType<typeof fakeGit>) => {
    bindPat();
    return pushWorkspaceBranch({ db: store.db, projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot, exec: git.exec });
  };

  it("refuses a leased path the branch changed BEFORE the lease existed, on a push that does not touch it", async () => {
    await leaseTo("VIB-9", ["Makefile"]);
    const git = fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      changedFilesByRange: {
        // This push's delta is docs only…
        [`${REMOTE}..HEAD`]: ["docs/notes.md"],
        // …but the branch as a whole carries the leased file.
        [`${FORK}..HEAD`]: ["docs/notes.md", "Makefile"],
      },
    });
    const res = await push(git);
    // CANARY: measure `remoteHead..HEAD` again and this pushes.
    expect(res).toMatchObject({ status: "lease_held", path: "Makefile", holder: "VIB-9" });
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    // Merges are excluded, so a base refresh is never charged to the branch.
    const log = git.calls.find((c) => c.includes("--name-only") && c.includes(`${FORK}..HEAD`))!;
    expect(log).toContain("--no-merges");
  });

  it("an unreadable fork point measures nothing and, as before, refuses nothing", async () => {
    await leaseTo("VIB-9", ["Makefile"]);
    const res = await push(fakeGit({
      branch: "vib-1-work",
      ahead: 1,
      remoteHead: REMOTE,
      mergeBase: null,
      changedFilesByRange: { [`${REMOTE}..HEAD`]: ["Makefile"] },
    }));
    expect(res.status).toBe("pushed");
  });
});
