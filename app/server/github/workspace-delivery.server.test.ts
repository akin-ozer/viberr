import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { createNotification } from "~/server/projections/notifications.server";
import { DIVERGED_BRANCH_REMEDY, type Recommendation } from "~/schemas/task-file.schema";
import { taskDir } from "~/server/files/file-store-root.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  reconcileWorkspaceDelivery,
  type CommandExec,
} from "./workspace-delivery.server";

/**
 * Unit tests for the agent-side delivery reconciliation (finding #31). The
 * git/gh command runner is injected (no real process, network, or repo) — the
 * workspace repo dir is just a directory carrying a `.git` marker.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const BRANCH = "atl-3-add-workspace-feature";
const COMMITS = "abc1234 [ATL-3] Add feature\ndef5678 [ATL-3] Wire tests";

/** A canned git/gh runner keyed by the command shape. */
/** What `git rev-parse HEAD` answers — the sha an adoptable PR's head must be. */
const HEAD_SHA = "1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d";

function fakeExec(config: {
  branch?: string;
  commits?: string;
  pr?: {
    number: number;
    state: string;
    title: string;
    /** R16-1: the PR's head sha. Defaults to the workspace HEAD (ours). */
    headRefOid?: string;
  };
  ghMissing?: boolean;
  /** `rev-parse --is-shallow-repository` answer (default: not shallow). */
  shallow?: boolean;
  /** Whether `git fetch --deepen …` succeeds (default: true). */
  deepenOk?: boolean;
  /** Ruling 135: what the workspace knows about the PR head `gh` reported.
   *  Default: nothing (`merge-base` fails, `cat-file` fails → `unknown`). */
  ancestry?: { prHeadIsAncestor?: boolean; revisionIsAncestor?: boolean; prHeadKnown?: boolean };
}): CommandExec {
  return async (file, args) => {
    if (file === "git" && args.includes("merge-base")) {
      const older = args[args.indexOf("--is-ancestor") + 1];
      const yes = older === HEAD_SHA
        ? config.ancestry?.revisionIsAncestor === true
        : config.ancestry?.prHeadIsAncestor === true;
      return yes ? { ok: true, stdout: "" } : { ok: false, stdout: "", stderr: "", code: 1 };
    }
    if (file === "git" && args.includes("cat-file")) {
      return config.ancestry?.prHeadKnown
        ? { ok: true, stdout: "" }
        : { ok: false, stdout: "", stderr: "missing object", code: 1 };
    }
    if (file === "git" && args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: config.shallow ? "true\n" : "false\n" };
    }
    if (file === "git" && args.includes("HEAD^{tree}")) {
      return { ok: true, stdout: "7ee0000000000000000000000000000000000000\n" };
    }
    if (file === "git" && args.includes("rev-parse") && args.includes("HEAD") && !args.includes("--abbrev-ref")) {
      return { ok: true, stdout: `${HEAD_SHA}\n` };
    }
    if (file === "git" && args.includes("rev-parse")) {
      return config.branch !== undefined
        ? { ok: true, stdout: `${config.branch}\n` }
        : { ok: false, stdout: "", stderr: "not a work tree", code: 128 };
    }
    if (file === "git" && args.includes("fetch")) {
      return config.deepenOk === false
        ? { ok: false, stdout: "", stderr: "could not resolve host", code: 128 }
        : { ok: true, stdout: "" };
    }
    if (file === "git" && args.includes("log")) {
      return { ok: true, stdout: config.commits ?? "" };
    }
    if (file === "gh") {
      if (config.ghMissing) {
        return { ok: false, stdout: "", stderr: "gh: not found", code: 127 };
      }
      return config.pr
        ? {
            ok: true,
            stdout: JSON.stringify({
              headRefOid: HEAD_SHA,
              ...config.pr,
            }),
          }
        : { ok: false, stdout: "", stderr: "no pull requests found", code: 1 };
    }
    return { ok: false, stdout: "", stderr: "unexpected", code: 1 };
  };
}

/** A workspace dir with a `.git` marker (a "cloned repo"). */
function makeWorkspaceRepo(): string {
  const dir = ctx.makeTempDir();
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function setupTask(
  taskKey = "ATL-3",
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
) {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, { title: "Add feature", ...patch }),
    goal: "Deliver the feature.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function readFm(store: ReturnType<typeof setupTask>, taskKey = "ATL-3") {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey,
    dataRoot: store.dataRoot,
  })!.parsed;
}

describe("reconcileWorkspaceDelivery", () => {
  it("writes the real branch + commit cache from the workspace, with a github event + audit", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      backend: "codex",
      role: "Developer",
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(true);
    expect(res.branch).toBe(BRANCH);
    expect(res.commits).toBe(2);

    const parsed = readFm(store);
    expect(parsed.frontmatter.branch).toBe(BRANCH);
    expect(parsed.frontmatter.github?.commits).toEqual([
      { sha: "abc1234", msg: "[ATL-3] Add feature" },
      { sha: "def5678", msg: "[ATL-3] Wire tests" },
    ]);
    const ev = parsed.timeline.find((e) => e.type === "github");
    expect(ev?.text).toContain(`Reconciled branch \`${BRANCH}\``);
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "github.workspace.branch_reconciled",
    );
  });

  it("ruling 137: a new delivered revision withdraws the accept card, records why, keeps the Reconciled branch event, and leaves a surviving run_agent card's bell UNREAD", async () => {
    // Canary: restore the blind branch patch (drop the withdrawal from the
    // locked write) and the accept card survives the revision it no longer
    // describes.
    const accept: Recommendation = {
      id: "r-accept",
      kind: "accept_completion",
      toStageId: "done",
      label: "Accept completion and move ATL-3 to Done",
      detail: "The review is clean.",
      forHeadSha: "01d".padEnd(40, "0"),
    };
    const runAgent: Recommendation = {
      id: "r-run",
      kind: "run_agent",
      profileId: "developer",
      label: "Run Developer",
      detail: "",
    };
    const store = setupTask("ATL-3", { stage: "review", recommendations: [accept, runAgent] });
    createNotification(store.db, {
      userId: store.users.murat.id,
      kind: "approval",
      text: "Run Developer",
      projectSlug: store.slug,
      taskKey: "ATL-3",
      bypassPrefs: true,
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      backend: "codex",
      role: "Developer",
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });
    expect(res.status).toBe("reconciled");

    const parsed = readFm(store);
    expect(parsed.frontmatter.workRevision?.headSha).toBe(HEAD_SHA);
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-run"]);
    // The branch-linked event the reconcile always wrote is still there…
    expect(parsed.timeline.find((e) => e.type === "github")?.text).toContain(
      `Reconciled branch \`${BRANCH}\``,
    );
    // …and the withdrawal is on the record, in the deliverer's name.
    const note = parsed.timeline.find(
      (e) => e.type === "note" && e.title === "Recommendation withdrawn",
    );
    expect(note?.actor).toMatchObject({ kind: "agent", profileId: "developer" });
    expect(note?.text).toContain('"Accept completion and move ATL-3 to Done"');
    expect(note?.text).toContain(`a new revision \`${HEAD_SHA.slice(0, 7)}\` was delivered`);
    expect(note?.text).toContain("still stand");
    const rows = listAuditEvents(store.db, { action: "task.recommendation.withdrawn" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      cause: "revision",
      surviving: 1,
      removed: [{ id: "r-accept", kind: "accept_completion", forHeadSha: "01d".padEnd(40, "0") }],
    });
    // The surviving card's "Waiting on you" bell is NOT marked read.
    // SAFETY: a `count(*) AS c` aggregate answers exactly one row with the integer `c`.
    const unread = store.db
      .prepare(
        `SELECT count(*) AS c FROM notifications WHERE task_key = 'ATL-3' AND kind = 'approval' AND read_at IS NULL`,
      )
      .get() as { c: number };
    expect(unread.c).toBe(1);
  });

  it("ruling 439: a delivery after Viberr's own base refresh keeps the revision and the approval on it", async () => {
    // Live on ax-clone AX-29: revision 4e6c47d, `main` merged onto it by
    // update_branch_from_base as 278c1ed, the reviewer approved, and the
    // deliver_for_review reconcile 65 seconds later minted 278c1ed as a NEW
    // revision (the merge changed the tree), so the approval went stale and the
    // task sat at Review waiting for a verdict nobody was producing. CANARY:
    // pass `[]` instead of `fm.baseRefreshes` to nextWorkRevision.
    const delivered = "4e6c47d51283c3f457b040d4d685ccf1edc373d5";
    const store = setupTask("ATL-3", {
      stage: "review",
      branch: BRANCH,
      engagements: [
        { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "codex", role: "Reviewer", delivers: false, verdictCapable: true },
      ],
      workRevision: {
        id: "rev_1",
        headSha: delivered,
        treeSha: "01d7000000000000000000000000000000000000",
        branch: BRANCH,
        createdAt: "2026-09-23T02:20:00.000Z",
        sourceProfileId: "developer",
        kind: "delivered",
      },
      verdicts: [
        { profileId: "reviewer", revisionId: "rev_1", headSha: delivered, result: "approve", reason: "ok", at: "2026-09-23T02:58:05.000Z", rounds: 1 },
      ],
      validation: "healthy",
      baseRefreshes: [
        { mergeSha: HEAD_SHA, baseSha: "b".repeat(40), base: "main", commits: 2, at: "2026-09-23T02:44:06.000Z", onto: delivered },
      ],
    });
    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir: makeWorkspaceRepo(),
      dataRoot: store.dataRoot,
      backend: "codex",
      role: "Developer",
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });
    expect(res.status).toBe("reconciled");
    const fm = readFm(store).frontmatter;
    expect(fm.workRevision).toMatchObject({ id: "rev_1", headSha: delivered });
    expect(fm.validation).toBe("healthy");
    expect(fm.verdicts).toHaveLength(1);
  });

  it("locates the repo via the conventional <taskDir>/workspace/<name> path when no workdir is given", async () => {
    const store = setupTask();
    // "akin-ozer/viberr" → repo name "viberr".
    mkdirSync(
      path.join(taskDir(store.slug, "ATL-3", store.dataRoot), "workspace", "viberr", ".git"),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(true);
    expect(readFm(store).frontmatter.branch).toBe(BRANCH);
  });

  it("probes <taskDir>/workspace/repo when no workdir is given (reviewer clones — B12)", async () => {
    const store = setupTask();
    mkdirSync(
      path.join(taskDir(store.slug, "ATL-3", store.dataRoot), "workspace", "repo", ".git"),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(true);
    expect(readFm(store).frontmatter.branch).toBe(BRANCH);
  });

  it("probes <taskDir>/workspace itself when the agent cloned into ./ (B12)", async () => {
    const store = setupTask();
    mkdirSync(
      path.join(taskDir(store.slug, "ATL-3", store.dataRoot), "workspace", ".git"),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(true);
  });

  it("shallow clone: deepens before counting ahead-commits (B12)", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();
    const calls: string[][] = [];
    const inner = fakeExec({ branch: BRANCH, commits: COMMITS, shallow: true });
    const spyExec: CommandExec = async (file, args, opts) => {
      calls.push([file, ...args]);
      return inner(file, args, opts);
    };

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: spyExec,
    });

    expect(res.commits).toBe(2);
    // The deepen fetch ran BEFORE the log over origin/<default>..HEAD.
    const deepenIdx = calls.findIndex((c) => c.includes("--deepen"));
    const logIdx = calls.findIndex((c) => c.includes("log"));
    expect(deepenIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeGreaterThan(deepenIdx);
  });

  it("shallow clone whose deepen fails: skips the commit computation instead of misreporting (B12)", async () => {
    // Truncated history would make `origin/main..HEAD` claim every reachable
    // commit is "ahead" — with no way to deepen, write NOTHING rather than a
    // wrong cache (and never wipe a prior run's honest cache).
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      github: { commits: [{ sha: "abc1234", msg: "[ATL-3] real work" }], changed: null },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: "aaa1111 bogus\nbbb2222 bogus\nccc3333 bogus",
        shallow: true,
        deepenOk: false,
      }),
    });

    expect(res.commits).toBe(0);
    expect(readFm(store).frontmatter.github?.commits).toEqual([
      { sha: "abc1234", msg: "[ATL-3] real work" },
    ]);
  });

  it("is a no-op when the branch already matches (confirm + leave, no duplicate event)", async () => {
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      github: { commits: [{ sha: "abc1234", msg: "[ATL-3] Add feature" }], changed: null },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: "abc1234 [ATL-3] Add feature" }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(false);
    expect(res.branch).toBe(BRANCH);
    const parsed = readFm(store);
    expect(parsed.timeline.filter((e) => e.type === "github")).toHaveLength(0);
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).not.toContain(
      "github.workspace.branch_reconciled",
    );
  });

  it("P11-72: a task-branch with ZERO commits mints no work revision (empty diff isn't 'changed')", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      backend: "codex",
      role: "Developer",
      // On the task branch, but the run produced NO commits ahead of base.
      exec: fakeExec({ branch: BRANCH, commits: "" }),
    });

    expect(res.status).toBe("reconciled");
    const fm = readFm(store).frontmatter;
    // No delivered work → no revision, and validation stays "none" (not "changed").
    expect(fm.workRevision).toBeNull();
    expect(fm.validation).toBe("none");
  });

  it("does not touch the branch when the workspace is on the default branch", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      // On "main" (the default branch) — nothing to link.
      exec: fakeExec({ branch: "main", commits: "" }),
    });

    expect(res.branchLinked).toBe(false);
    expect(readFm(store).frontmatter.branch).toBeNull();
  });

  it("does NOT wipe a prior run's commit cache when the clone is on the default branch", async () => {
    // A developer run cached real commits against fm.branch. A later reviewer
    // run clones the DEFAULT branch (HEAD=main). Its `git log origin/main..HEAD`
    // is empty — but those empty commits must NOT overwrite the real cache,
    // because they don't belong to fm.branch.
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      github: { commits: [{ sha: "abc1234", msg: "[ATL-3] real work" }], changed: null },
    });
    const workdir = makeWorkspaceRepo();

    await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: "main", commits: "" }),
    });

    expect(readFm(store).frontmatter.github?.commits).toEqual([
      { sha: "abc1234", msg: "[ATL-3] real work" },
    ]);
  });

  it("links the real PR the agent opened via gh, with a github event + audit", async () => {
    const store = setupTask("ATL-3", { branch: BRANCH });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(true);
    // gh's OPEN maps to the canonical cache vocabulary "review" (same as the
    // server delivery path) — never the raw "open".
    expect(res.pr).toMatchObject({ number: 9, state: "review" });

    const parsed = readFm(store);
    expect(parsed.frontmatter.pr).toMatchObject({ number: 9, state: "review" });
    const prEvent = parsed.timeline.find((e) => e.text.includes("PR #9"));
    expect(prEvent?.type).toBe("github");
    expect(prEvent?.text).toContain("Linked **PR #9**");
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "github.workspace.pr_linked",
    );
  });

  it("R16-1/H8: a MERGED PR found on the branch is never adopted — it is reported as a collision", async () => {
    // The exact live failure (H8, 2026-08-04). `gh pr view <branch>` answers
    // with the branch's newest PR whatever its state, and this path wrote it
    // into `pr:` unconditionally: brand-new VIB-4 came out carrying
    // `{number: 113, state: merged, title: "[VIB-4] Verify MCP tool…"}` — a PR
    // merged a week earlier by an unrelated task that happened to use the same
    // branch name. The reconciler then filled in checks 2/2 against it, because
    // its own ownership test was satisfied by `fm.pr != null`.
    // Canary: delete the `decidePrAdoption` branch and #113 lands in `pr:`.
    const store = setupTask("ATL-3", { branch: BRANCH });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 113,
          state: "MERGED",
          title: "[VIB-4] Verify MCP tool and knowledge-base wiring",
          headRefOid: "93435df0000000000000000000000000000000ff",
        },
      }),
    });

    expect(res.prLinked).toBe(false);
    const parsed = readFm(store);
    expect(parsed.frontmatter.pr, "a stranger's PR never becomes ours").toBeNull();
    const note = parsed.timeline.find((e) => /Branch name collision/.test(e.text));
    expect(note, "the collision is reported once").toBeTruthy();
    expect(note!.text).toContain("#113");
    // F17-L4: a MERGED stranger PR names the fast-forward-safe cause, distinct
    // from a closed-unmerged one (which warns of a push conflict).
    expect(note!.text).toContain("already merged");
    expect(note!.text).toContain("fast-forward");
    // Deduped through the same marker the server reconciler uses, so the note
    // does not repeat on the next run or poll tick.
    expect(parsed.frontmatter.github?.unownedPr).toBe(113);
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).not.toContain(
      "github.workspace.pr_linked",
    );
  });

  it("R16-1: an OPEN PR on the branch whose head is not the delivered revision is not adopted either", async () => {
    const store = setupTask("ATL-3", { branch: BRANCH });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 77,
          state: "OPEN",
          title: "someone else's work on the same branch name",
          headRefOid: "ffffffffffffffffffffffffffffffffffffffff",
        },
      }),
    });

    expect(res.prLinked).toBe(false);
    const parsed = readFm(store);
    expect(parsed.frontmatter.pr).toBeNull();
    // The branch and the delivered revision are still reconciled — refusing the
    // PR must not cost the task its own delivery facts.
    expect(parsed.frontmatter.branch).toBe(BRANCH);
    expect(parsed.frontmatter.workRevision?.headSha).toBe(HEAD_SHA);
    const note = parsed.timeline.find((e) => /Branch name collision/.test(e.text));
    expect(note!.text).toContain("is not ATL-3's delivered revision");
  });

  it("does NOT re-link or ping-pong a PR the server already cached as \"review\"", async () => {
    // The server delivery path stores an open PR as "review"; a later real
    // specialist run's reconcile must treat that as already-linked (gh OPEN →
    // "review" == cached "review"), not clobber it back to "open".
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      pr: { number: 9, state: "review", title: "[ATL-3] Add feature" },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toMatchObject({ number: 9, state: "review" });
    expect(
      readFm(store).timeline.filter((e) => e.text.includes("PR #9")),
    ).toHaveLength(0);
  });

  it("leaves pr untouched (never fabricates) when gh is unavailable", async () => {
    const store = setupTask("ATL-3", { branch: BRANCH });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS, ghMissing: true }),
    });

    expect(res.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toBeNull();
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).not.toContain(
      "github.workspace.pr_linked",
    );
  });

  it("preserves a human-set \"accepted\" (merge pending) while gh reports the PR still OPEN (B1)", async () => {
    // D3/S2 regression: a real agent run finishing on an accepted merge-pending
    // task must NOT clobber pr.state back to "review" — that hides the
    // Complete-merge button and fabricates a "PR opened" event.
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      pr: { number: 9, state: "accepted", title: "[ATL-3] Add feature" },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toMatchObject({ number: 9, state: "accepted" });
    // No misleading "Linked PR opened" event when nothing actually changed.
    expect(
      readFm(store).timeline.filter((e) => e.text.includes("PR #9")),
    ).toHaveLength(0);
  });

  it("a real terminal state overrides \"accepted\": MERGED advances it with an honest state-change event (B1)", async () => {
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      pr: { number: 9, state: "accepted", title: "[ATL-3] Add feature" },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "MERGED", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(true);
    expect(readFm(store).frontmatter.pr).toMatchObject({ number: 9, state: "merged" });
    const ev = readFm(store).timeline.find((e) => e.text.includes("PR #9"));
    // The already-linked PR changed state — never re-announced as "opened".
    expect(ev?.text).toContain("Reconciled **PR #9** state");
    expect(ev?.text).not.toContain("opened from the specialist workspace");
  });

  it("accepted PR closed externally → downgraded to closed + typed policy event explaining why (B9)", async () => {
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      pr: { number: 9, state: "accepted", title: "[ATL-3] Add feature" },
    });
    const workdir = makeWorkspaceRepo();

    await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "CLOSED", title: "[ATL-3] Add feature" },
      }),
    });

    const parsed = readFm(store);
    expect(parsed.frontmatter.pr).toMatchObject({ number: 9, state: "closed" });
    // P13-LV-03: a neutral divergence note, not a policy VIOLATION.
    const policy = parsed.timeline.find((e) => e.type === "note");
    expect(policy?.text).toContain(
      "accepted PR #9 was closed on GitHub without merging",
    );
  });

  it("no-ops when there is no workspace git repo", async () => {
    const store = setupTask();
    const empty = ctx.makeTempDir(); // no .git marker

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir: empty,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH }),
    });

    expect(res.status).toBe("no_workspace");
    expect(readFm(store).frontmatter.branch).toBeNull();
  });

  it("no-ops for a repo-less project", async () => {
    const store = setupTestStore(ctx);
    // Overwrite the project with no repo configured.
    const { writeProject } = await import("../../../test-support/test-store");
    const projectFile = (
      await import("~/server/files/project-writer.server")
    ).readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...projectFile.parsed.frontmatter,
      repo: null,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("ATL-3", { title: "Add feature" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("no_repo");
  });
});

/**
 * Ruling 135 (pass 34, F34-11): the moment a delivering run mints a revision on
 * a branch whose PR is open, the workspace reconcile relates origin's copy (the
 * PR head `gh` reported) to that revision from the workspace's own history and
 * records `pr.unpushedRevision`, so the acceptance gate does not wait for the
 * five-minute poll. Canary: make `classifyUnpushedRevision` return null and
 * the three relations below are never written.
 */
describe("ruling 135: the workspace reconcile records the unpushed revision", () => {
  const PR_HEAD = "0".repeat(40);
  async function reconcile(store: ReturnType<typeof setupTask>, exec: CommandExec) {
    return reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      profileId: "developer",
      workdir: makeWorkspaceRepo(),
      dataRoot: store.dataRoot,
      exec,
    });
  }
  const owned = () =>
    setupTask("ATL-3", { branch: BRANCH, pr: { number: 9, state: "review", title: "[ATL-3] Add feature" } });

  it("`behind` when the PR head is an ancestor of the workspace revision, with the timeline line and the audit row", async () => {
    const store = owned();
    const res = await reconcile(store, fakeExec({
      branch: BRANCH, commits: COMMITS,
      pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature", headRefOid: PR_HEAD },
      ancestry: { prHeadIsAncestor: true },
    }));
    expect(res.prLinked, "a head change is not a link").toBe(false);
    const parsed = readFm(store);
    expect(parsed.frontmatter.pr).toMatchObject({
      number: 9, state: "review", headSha: PR_HEAD,
      unpushedRevision: { revisionSha: HEAD_SHA, prHeadSha: PR_HEAD, relation: "behind" },
    });
    const line = parsed.timeline.find((e) => e.text.includes("is not on **PR #9**"));
    expect(line?.text).toContain("Delivering the branch pushes it");
    expect(line?.text).not.toMatch(/rebase/i);
    const audit = listAuditEvents(store.db, { action: "github.workspace.pr_linked" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ headSha: PR_HEAD, unpushedRevision: "behind" });
  });

  it("`diverged` when both heads are known and neither contains the other; `unknown` when the PR head is not here", async () => {
    const diverged = owned();
    await reconcile(diverged, fakeExec({
      branch: BRANCH, commits: COMMITS,
      pr: { number: 9, state: "OPEN", title: "t", headRefOid: PR_HEAD },
      ancestry: { prHeadKnown: true },
    }));
    expect(readFm(diverged).frontmatter.pr?.unpushedRevision).toEqual({ revisionSha: HEAD_SHA, prHeadSha: PR_HEAD, relation: "diverged" });
    expect(readFm(diverged).timeline[0]!.text).toContain("holds commits this workspace does not");
    // Ruling 321: the diverged line carries the shared remedy (merge, never a
    // rebase), not a sentence of its own.
    expect(readFm(diverged).timeline[0]!.text).toContain(DIVERGED_BRANCH_REMEDY);

    const unknown = owned();
    await reconcile(unknown, fakeExec({
      branch: BRANCH, commits: COMMITS,
      pr: { number: 9, state: "OPEN", title: "t", headRefOid: PR_HEAD },
    }));
    expect(readFm(unknown).frontmatter.pr?.unpushedRevision).toEqual({ revisionSha: HEAD_SHA, prHeadSha: PR_HEAD, relation: "unknown" });
  });

  it("a head that already CONTAINS the revision (origin ahead) records nothing; a head equal to it CLEARS a cached record", async () => {
    const ahead = owned();
    await reconcile(ahead, fakeExec({
      branch: BRANCH, commits: COMMITS,
      pr: { number: 9, state: "OPEN", title: "t", headRefOid: PR_HEAD },
      ancestry: { revisionIsAncestor: true, prHeadKnown: true },
    }));
    expect(readFm(ahead).frontmatter.pr).toMatchObject({ number: 9, headSha: PR_HEAD });
    expect(readFm(ahead).frontmatter.pr).not.toHaveProperty("unpushedRevision");
    expect(readFm(ahead).timeline.filter((e) => e.text.includes("PR #9"))).toHaveLength(0);

    const cleared = setupTask("ATL-3", {
      branch: BRANCH,
      pr: {
        number: 9, state: "review", title: "t", headSha: PR_HEAD,
        checks: { total: 1, passing: 1, failing: 0, pending: 0 },
        unpushedRevision: { revisionSha: HEAD_SHA, prHeadSha: PR_HEAD, relation: "behind" },
      },
    });
    // gh now reports the workspace HEAD as the PR head (the default headRefOid).
    await reconcile(cleared, fakeExec({ branch: BRANCH, commits: COMMITS, pr: { number: 9, state: "OPEN", title: "t" } }));
    const fm = readFm(cleared).frontmatter;
    expect(fm.pr).toMatchObject({ number: 9, headSha: HEAD_SHA, checks: { total: 1, passing: 1, failing: 0, pending: 0 } });
    expect(fm.pr).not.toHaveProperty("unpushedRevision");
    expect(readFm(cleared).timeline[0]!.text).toContain("carries the workspace revision");
  });

  /**
   * Ruling 445, live on ax-clone AX-5: eleven seconds after the delivery
   * reconcile minted `b82bb93`, the review queue still said "PR #24 does not
   * carry the delivered revision 509c0d1", because the workspace could not
   * read the PR and the line is only re-measured beside that read.
   */
  it("ruling 445: a mint the PR cannot be read for re-points the line at the revision that now stands", async () => {
    const SUPERSEDED = "5".repeat(40);
    const stale = () =>
      setupTask("ATL-3", {
        branch: BRANCH,
        pr: {
          number: 9, state: "review", title: "t", headSha: PR_HEAD,
          unpushedRevision: { revisionSha: SUPERSEDED, prHeadSha: PR_HEAD, relation: "behind" },
        },
      });
    const repointed = stale();
    // `gh` cannot answer, as in a workspace with no GitHub credential.
    await reconcile(repointed, fakeExec({ branch: BRANCH, commits: COMMITS, ghMissing: true, ancestry: { prHeadIsAncestor: true } }));
    // CANARY: drop the re-measure and the line keeps naming 5555555.
    expect(readFm(repointed).frontmatter.pr?.unpushedRevision).toEqual({
      revisionSha: HEAD_SHA,
      prHeadSha: PR_HEAD,
      relation: "behind",
    });
    // A PR head on record that already carries the new revision clears it.
    const carried = setupTask("ATL-3", {
      branch: BRANCH,
      pr: {
        number: 9, state: "review", title: "t", headSha: HEAD_SHA,
        unpushedRevision: { revisionSha: SUPERSEDED, prHeadSha: HEAD_SHA, relation: "behind" },
      },
    });
    await reconcile(carried, fakeExec({ branch: BRANCH, commits: COMMITS, ghMissing: true }));
    expect(readFm(carried).frontmatter.pr).not.toHaveProperty("unpushedRevision");
    expect(readFm(carried).frontmatter.pr).toMatchObject({ number: 9, headSha: HEAD_SHA });
  });

  it("a settled PR gets no record", async () => {
    const store = owned();
    await reconcile(store, fakeExec({
      branch: BRANCH, commits: COMMITS,
      pr: { number: 9, state: "MERGED", title: "t", headRefOid: PR_HEAD },
      ancestry: { prHeadIsAncestor: true },
    }));
    expect(readFm(store).frontmatter.pr?.state).toBe("merged");
    expect(readFm(store).frontmatter.pr).not.toHaveProperty("unpushedRevision");
  });
});
