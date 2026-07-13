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
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { reviewEvidenceFingerprint } from "~/server/tasks/review-evidence.server";
import { repositoryWorkspaceKey } from "~/server/tasks/specialist-preflight.server";
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
const REVIEWED_HEAD = "1".repeat(40);
const REPLACEMENT_HEAD = "2".repeat(40);

/** A canned git/gh runner keyed by the command shape. */
function fakeExec(config: {
  branch?: string;
  commits?: string;
  pr?: {
    number: number;
    state: string;
    title: string;
    /** Omitted/null simulates a degraded state-only gh response. */
    headRefOid?: string | null;
  };
  ghMissing?: boolean;
  /** `rev-parse --is-shallow-repository` answer (default: not shallow). */
  shallow?: boolean;
  /** Whether `git fetch --deepen …` succeeds (default: true). */
  deepenOk?: boolean;
}): CommandExec {
  return async (file, args) => {
    if (file === "git" && args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: config.shallow ? "true\n" : "false\n" };
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
        ? { ok: true, stdout: JSON.stringify(config.pr) }
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
    frontmatter: baseTaskFrontmatter(taskKey, {
      title: "Add feature",
      ...patch,
    }),
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

async function seedApproval(
  store: ReturnType<typeof setupTask>,
  taskKey = "ATL-3",
): Promise<void> {
  await updateTaskFile(
    { projectSlug: store.slug, taskKey, dataRoot: store.dataRoot },
    (parsed) => {
      parsed.frontmatter.reviewers = [
        { profileId: "reviewer", backend: "claude", role: "Reviewer" },
      ];
      parsed.frontmatter.validation = "healthy";
      parsed.frontmatter.reviewerVerdicts = [
        {
          profileId: "reviewer",
          verdict: "approve",
          summary: "Approved the exact PR head.",
          runId: "run-review",
          reviewedAt: "2026-07-13T00:00:00.000Z",
          evidenceFingerprint: reviewEvidenceFingerprint(
            parsed,
            "akin-ozer/viberr",
          ),
        },
      ];
      parsed.frontmatter.humanValidation = {
        userId: store.users.arda.id,
        validatedAt: "2026-07-13T00:01:00.000Z",
        evidenceFingerprint: reviewEvidenceFingerprint(
          parsed,
          "akin-ozer/viberr",
        ),
      };
    },
  );
}

describe("reconcileWorkspaceDelivery", () => {
  it("writes the real branch + commit cache from the workspace, with a github event + audit", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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

  it("locates the repo via the conventional <taskDir>/workspace/<name> path when no workdir is given", async () => {
    const store = setupTask();
    // "akin-ozer/viberr" → repo name "viberr".
    mkdirSync(
      path.join(
        taskDir(store.slug, "ATL-3", store.dataRoot),
        "workspace",
        "viberr",
        ".git",
      ),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("reconciled");
    expect(res.branchLinked).toBe(true);
    expect(readFm(store).frontmatter.branch).toBe(BRANCH);
  });

  it("prefers the canonical full-repository-identity workspace over a same-basename legacy clone", async () => {
    const store = setupTask();
    const workspace = path.join(
      taskDir(store.slug, "ATL-3", store.dataRoot),
      "workspace",
    );
    const canonical = path.join(
      workspace,
      repositoryWorkspaceKey("akin-ozer/viberr"),
    );
    const legacyBasename = path.join(workspace, "viberr");
    mkdirSync(path.join(canonical, ".git"), { recursive: true });
    // This could belong to a previous project-repo identity with the same
    // basename; canonical identity must win deterministically.
    mkdirSync(path.join(legacyBasename, ".git"), { recursive: true });
    const commandCwds: string[] = [];
    const inner = fakeExec({ branch: BRANCH, commits: COMMITS });
    const exec: CommandExec = async (file, args, opts) => {
      if (opts.cwd) commandCwds.push(opts.cwd);
      return inner(file, args, opts);
    };

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      dataRoot: store.dataRoot,
      exec,
    });

    expect(res.status).toBe("reconciled");
    expect(commandCwds.length).toBeGreaterThan(0);
    expect(new Set(commandCwds)).toEqual(new Set([canonical]));
  });

  it("probes <taskDir>/workspace/repo when no workdir is given (reviewer clones — B12)", async () => {
    const store = setupTask();
    mkdirSync(
      path.join(
        taskDir(store.slug, "ATL-3", store.dataRoot),
        "workspace",
        "repo",
        ".git",
      ),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      path.join(
        taskDir(store.slug, "ATL-3", store.dataRoot),
        "workspace",
        ".git",
      ),
      { recursive: true },
    );

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      github: {
        commits: [{ sha: "abc1234", msg: "[ATL-3] real work" }],
        changed: null,
      },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      github: {
        commits: [{ sha: "abc1234", msg: "[ATL-3] Add feature" }],
        changed: null,
      },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: "abc1234 [ATL-3] Add feature",
      }),
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

  it("does not touch the branch when the workspace is on the default branch", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      github: {
        commits: [{ sha: "abc1234", msg: "[ATL-3] real work" }],
        changed: null,
      },
    });
    const workdir = makeWorkspaceRepo();

    await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 9,
          state: "OPEN",
          title: "[ATL-3] Add feature",
          headRefOid: REVIEWED_HEAD,
        },
      }),
    });

    expect(res.prLinked).toBe(true);
    // gh's OPEN maps to the canonical cache vocabulary "review" (same as the
    // server delivery path) — never the raw "open".
    expect(res.pr).toMatchObject({
      number: 9,
      state: "review",
      headSha: REVIEWED_HEAD,
    });

    const parsed = readFm(store);
    expect(parsed.frontmatter.pr).toMatchObject({
      number: 9,
      state: "review",
      headSha: REVIEWED_HEAD,
    });
    const prEvent = parsed.timeline.find((e) => e.text.includes("PR #9"));
    expect(prEvent?.type).toBe("github");
    expect(prEvent?.text).toContain("Linked **PR #9**");
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "github.workspace.pr_linked",
    );
  });

  it('does NOT re-link or ping-pong a PR the server already cached as "review"', async () => {
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
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toMatchObject({
      number: 9,
      state: "review",
    });
    expect(
      readFm(store).timeline.filter((e) => e.text.includes("PR #9")),
    ).toHaveLength(0);
  });

  it("updates same-PR state without dropping its unchanged verified head or approval evidence", async () => {
    const store = setupTask("ATL-3", {
      stage: "review",
      branch: BRANCH,
      pr: {
        number: 9,
        state: "review",
        title: "[ATL-3] Add feature",
        headSha: REVIEWED_HEAD,
      },
    });
    await seedApproval(store);
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 9,
          state: "MERGED",
          title: "[ATL-3] Add feature",
          headRefOid: REVIEWED_HEAD,
        },
      }),
    });

    expect(res.prLinked).toBe(true);
    const fm = readFm(store).frontmatter;
    expect(fm.pr).toMatchObject({
      number: 9,
      state: "merged",
      headSha: REVIEWED_HEAD,
    });
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.humanValidation).not.toBeNull();
    expect(fm.validation).toBe("healthy");
  });

  it("rebinds a real same-PR replacement head and invalidates evidence for the old head", async () => {
    const store = setupTask("ATL-3", {
      stage: "review",
      branch: BRANCH,
      pr: {
        number: 9,
        state: "review",
        title: "[ATL-3] Add feature",
        headSha: REVIEWED_HEAD,
      },
    });
    await seedApproval(store);
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 9,
          state: "OPEN",
          title: "[ATL-3] Add feature",
          headRefOid: REPLACEMENT_HEAD,
        },
      }),
    });

    expect(res.prLinked).toBe(true);
    const parsed = readFm(store);
    expect(parsed.frontmatter.pr?.headSha).toBe(REPLACEMENT_HEAD);
    expect(parsed.frontmatter.reviewerVerdicts).toEqual([]);
    expect(parsed.frontmatter.humanValidation).toBeNull();
    expect(parsed.frontmatter.validation).toBe("changed");
    expect(
      parsed.timeline.find((event) => event.text.includes("PR #9"))?.text,
    ).toContain(`head → \`${REPLACEMENT_HEAD}\``);
    const audit = listAuditEvents(store.db, {
      action: "github.workspace.pr_linked",
    }).at(0);
    expect(audit?.details).toMatchObject({
      previousHeadSha: REVIEWED_HEAD,
      headSha: REPLACEMENT_HEAD,
      headChanged: true,
      evidenceInvalidated: true,
    });
  });

  it("preserves the verified same-PR head and evidence when gh degrades to state-only data", async () => {
    const store = setupTask("ATL-3", {
      stage: "review",
      branch: BRANCH,
      pr: {
        number: 9,
        state: "review",
        title: "[ATL-3] Add feature",
        headSha: REVIEWED_HEAD,
      },
    });
    await seedApproval(store);
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: {
          number: 9,
          state: "CLOSED",
          title: "[ATL-3] Add feature",
          // Deliberately no headRefOid: absence is unknown, not deletion.
        },
      }),
    });

    expect(res.prLinked).toBe(true);
    const fm = readFm(store).frontmatter;
    expect(fm.pr).toMatchObject({
      number: 9,
      state: "closed",
      headSha: REVIEWED_HEAD,
    });
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.humanValidation).not.toBeNull();
    expect(fm.validation).toBe("healthy");
  });

  it("leaves pr untouched (never fabricates) when gh is unavailable", async () => {
    const store = setupTask("ATL-3", { branch: BRANCH });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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

  it('a legacy non-canonical "open" cache reads as "review" (schema coercion) — no re-link, no ping-pong', async () => {
    // The prRefSchema enum coerces the legacy raw "open" to "review" at parse
    // time, so reconcile sees an already-linked canonical PR: nothing to heal,
    // no duplicate event, ever.
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      // Legacy raw value written before the enum tightening — cast past the
      // compile-time contract to prove the runtime coercion.
      pr: {
        number: 9,
        state: "open" as unknown as "review",
        title: "[ATL-3] Add feature",
      },
    });
    const workdir = makeWorkspaceRepo();
    const opts = {
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    };

    const first = await reconcileWorkspaceDelivery(opts);
    expect(first.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toMatchObject({
      number: 9,
      state: "review",
    });

    const second = await reconcileWorkspaceDelivery(opts);
    expect(second.prLinked).toBe(false);
    expect(
      readFm(store).timeline.filter((e) => e.text.includes("PR #9")),
    ).toHaveLength(0);
  });

  it('preserves a human-set "accepted" (merge pending) while gh reports the PR still OPEN (B1)', async () => {
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
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "OPEN", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(false);
    expect(readFm(store).frontmatter.pr).toMatchObject({
      number: 9,
      state: "accepted",
    });
    // No misleading "Linked PR opened" event when nothing actually changed.
    expect(
      readFm(store).timeline.filter((e) => e.text.includes("PR #9")),
    ).toHaveLength(0);
  });

  it('a real terminal state overrides "accepted": MERGED advances it with an honest state-change event (B1)', async () => {
    const store = setupTask("ATL-3", {
      branch: BRANCH,
      pr: { number: 9, state: "accepted", title: "[ATL-3] Add feature" },
    });
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({
        branch: BRANCH,
        commits: COMMITS,
        pr: { number: 9, state: "MERGED", title: "[ATL-3] Add feature" },
      }),
    });

    expect(res.prLinked).toBe(true);
    expect(readFm(store).frontmatter.pr).toMatchObject({
      number: 9,
      state: "merged",
    });
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
    const policy = parsed.timeline.find((e) => e.type === "policy");
    expect(policy?.text).toContain(
      "accepted PR #9 was closed on GitHub without merging",
    );
  });

  it("skips a simulated run entirely", async () => {
    const store = setupTask();
    const workdir = makeWorkspaceRepo();

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      dataRoot: store.dataRoot,
      simulated: true,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("skipped");
    expect(readFm(store).frontmatter.branch).toBeNull();
  });

  it("no-ops when there is no workspace git repo", async () => {
    const store = setupTask();
    const empty = ctx.makeTempDir(); // no .git marker

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "ATL-3",
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
      workdir,
      dataRoot: store.dataRoot,
      exec: fakeExec({ branch: BRANCH, commits: COMMITS }),
    });

    expect(res.status).toBe("no_repo");
  });
});
