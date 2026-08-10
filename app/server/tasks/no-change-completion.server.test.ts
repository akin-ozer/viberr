import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  acceptanceNoChangeCheck,
  noChangeApplies,
  noChangeCompletionEvent,
  probeNothingToDeliver,
} from "./no-change-completion.server";

/**
 * R19-8 — the LIVE, FAIL-CLOSED proof that a task has nothing to deliver.
 *
 * The point of every test here is the same: "we could not look" is NEVER "there
 * is nothing there". Only three bases verify (no repo, no branch, a branch 0
 * commits ahead); a missing credential, an HTTP error, a network failure and —
 * above all — a branch carrying commits must refuse, because the acceptance
 * these gate is irreversible (F19-21).
 */

vi.mock("~/server/github/github-context.server", () => ({
  getProjectGithubContext: vi.fn(),
}));

import { getProjectGithubContext } from "~/server/github/github-context.server";

const ghCtxMock = vi.mocked(getProjectGithubContext);

let ctx: TestDbContext;
let store: TestStore;

const RATE_LIMIT = { limit: 5000, remaining: 4999, reset: null };
const BASE_SHA = "b".repeat(40);

function okResponse(data: unknown) {
  return {
    ok: true as const,
    status: 200,
    data,
    etag: null,
    rateLimit: RATE_LIMIT,
    scopesHeader: null,
    tokenExpiration: null,
  };
}

function httpError(status: number, message = "Not Found") {
  return {
    ok: false as const,
    kind: "http" as const,
    status,
    message,
    data: null,
    rateLimit: RATE_LIMIT,
  };
}

const NETWORK_ERROR = {
  ok: false as const,
  kind: "network" as const,
  message: "fetch failed",
};

/** A fake GitHub transport routed by path: the task-branch ref, the default
 *  branch ref, and the compare. `requestSpy` proves the ordinary PR path never
 *  touches the network at all. */
const requestSpy = vi.fn();

function installGithub(routes: {
  branchRef?: unknown;
  baseRef?: unknown;
  compare?: unknown;
}): void {
  requestSpy.mockImplementation(async (_method: string, path: string) => {
    if (path.includes("/compare/")) {
      return routes.compare ?? okResponse({ ahead_by: 0, behind_by: 0, status: "identical", commits: [] });
    }
    if (path.endsWith("/heads/main")) {
      return routes.baseRef ?? okResponse({ object: { sha: BASE_SHA } });
    }
    return routes.branchRef ?? okResponse({ object: { sha: "c".repeat(40) } });
  });
  ghCtxMock.mockReturnValue({
    status: "ok",
    client: { request: requestSpy } as never,
    repo: "akin-ozer/viberr",
    owner: "akin-ozer",
    defaultBranch: "main",
    patId: "pat_1",
  });
}

function seed(patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      readiness: "ready",
      title: "Confirm the smoke file exists on main",
      ...patch,
    }),
    goal: "Verification only — NO changes are expected.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function dataCtx() {
  return { dataRoot: store.dataRoot };
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  vi.clearAllMocks();
});

afterEach(() => ctx.cleanup());

describe("probeNothingToDeliver — only three bases verify", () => {
  it("a missing task branch verifies against the default-branch head", async () => {
    // CANARY: make the `heads/<branch>` 404 arm return `unverifiable` — the
    // probe stops verifying and F19-21's VC-5 can never close.
    seed();
    installGithub({ branchRef: httpError(404) });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("verified");
    if (probe.status !== "verified") return;
    expect(probe.verification).toEqual({
      basis: "no_branch",
      baseBranch: "main",
      baseSha: BASE_SHA,
      branch: "vib-1",
    });
  });

  it("a branch AHEAD of the default branch is NOT a no-change task", async () => {
    // The exact property F19-21 demands: work on the branch must be REFUSED by
    // name and count, never quietly closed as "no changes".
    // CANARY: delete the `aheadBy > 0` arm and every existing branch verifies.
    seed();
    installGithub({
      compare: okResponse({ ahead_by: 3, behind_by: 0, status: "ahead", commits: [] }),
    });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("has_work");
    if (probe.status !== "has_work") return;
    expect(probe.refusal).toContain("`vib-1`");
    expect(probe.refusal).toContain("3 commit");
    expect(probe.refusal).toContain("main");
  });

  it("an unreachable GitHub fails CLOSED", async () => {
    // CANARY: return `verified` from the network/catch arm.
    seed();
    installGithub({ branchRef: NETWORK_ERROR });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("unverifiable");
    if (probe.status !== "unverifiable") return;
    expect(probe.refusal).toMatch(/could not be reached/i);
  });

  it("a compare that fails after the branch was found fails CLOSED", async () => {
    seed();
    installGithub({ compare: httpError(403, "rate limit exceeded") });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("unverifiable");
  });

  it("a missing credential fails CLOSED", async () => {
    // CANARY: treat `no_pat_configured` like `no_repo_configured`.
    seed();
    ghCtxMock.mockReturnValue({
      status: "no_pat_configured",
      repo: "akin-ozer/viberr",
    });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("unverifiable");
    if (probe.status !== "unverifiable") return;
    expect(probe.refusal).toMatch(/no GitHub credential/i);
  });

  it("a default branch that cannot be read fails CLOSED even with no task branch", async () => {
    // Verified-but-unpinnable is still unverified: the outcome has nothing to
    // name, so it must not be recorded as a fact.
    seed();
    installGithub({ branchRef: httpError(404), baseRef: httpError(500, "boom") });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("unverifiable");
  });

  it("a project with no repository has nothing to deliver", async () => {
    // CANARY: make `no_repo_configured` unverifiable — this also breaks the
    // pre-existing R17-2 coverage in acceptance-closed-pr.server.test.ts, which
    // is the point: planning / non-repo work stays acceptable.
    seed();
    ghCtxMock.mockReturnValue({ status: "no_repo_configured" });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status).toBe("verified");
    if (probe.status !== "verified") return;
    expect(probe.verification.basis).toBe("no_repo");
    expect(probe.verification.baseSha).toBeNull();
  });

  it("probes the frontmatter branch when one is linked, not the derived name", async () => {
    seed({ branch: "vib-1-custom" });
    installGithub({ branchRef: httpError(404) });
    const probe = await probeNothingToDeliver(store.db, dataCtx(), store.slug, "VIB-1");
    expect(probe.status === "verified" && probe.verification.branch).toBe("vib-1-custom");
  });
});

describe("acceptanceNoChangeCheck — the accept-time gate", () => {
  it("does not touch GitHub for an ordinary task", async () => {
    // CANARY: drop the `noChangeApplies` early return — the spy fires and every
    // ordinary acceptance starts paying for a remote read.
    seed({ pr: { number: 7, state: "review", title: "[VIB-1] work" } });
    installGithub({});
    const check = await acceptanceNoChangeCheck(store.db, dataCtx(), store.slug, "VIB-1");
    expect(check).toEqual({
      applies: false,
      refusal: null,
      verification: null,
      branch: null,
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("applies (and verifies) for a flagged task with no PR", async () => {
    seed({ noChanges: true });
    installGithub({ branchRef: httpError(404) });
    const check = await acceptanceNoChangeCheck(store.db, dataCtx(), store.slug, "VIB-1");
    expect(check.applies).toBe(true);
    expect(check.refusal).toBeNull();
    expect(check.verification?.basis).toBe("no_branch");
  });

  it("applies and REFUSES when the branch gained commits", async () => {
    seed({ noChanges: true, branch: "vib-1" });
    installGithub({
      compare: okResponse({ ahead_by: 2, behind_by: 0, status: "ahead", commits: [] }),
    });
    const check = await acceptanceNoChangeCheck(store.db, dataCtx(), store.slug, "VIB-1");
    expect(check.applies).toBe(true);
    expect(check.verification).toBeNull();
    expect(check.refusal).toContain("2 commit");
  });

  it("a flagged task WITH a PR is an ordinary merge acceptance", () => {
    expect(
      noChangeApplies({
        noChanges: true,
        pr: { number: 7, state: "review", title: "t" },
      }),
    ).toBe(false);
    expect(noChangeApplies({ noChanges: true, pr: null })).toBe(true);
    expect(noChangeApplies({ pr: null })).toBe(false);
  });
});

describe("noChangeCompletionEvent — one builder, and it never claims a merge", () => {
  const actor = { kind: "operator" } as const;
  const at = "2026-08-06T10:00:00.000Z";

  it("names the basis and the base sha, and never says 'merged'", () => {
    const event = noChangeCompletionEvent({
      taskKey: "VC-5",
      actor,
      occurredAt: at,
      by: "human",
      verification: {
        basis: "no_branch",
        baseBranch: "main",
        baseSha: "abc123def456789",
        branch: "vc-5",
      },
    });
    expect(event.title).toBe("Completed — no changes");
    expect(event.type).toBe("completion");
    expect(event.text).toContain("VC-5 completed with no changes");
    expect(event.text).toContain("`vc-5`");
    expect(event.text).toContain("abc123def456");
    expect(event.text).not.toMatch(/merged/i);
  });

  it("an empty branch says so, and a repo-less project says THAT", () => {
    const empty = noChangeCompletionEvent({
      taskKey: "VC-5",
      actor,
      occurredAt: at,
      by: "operator",
      verification: {
        basis: "branch_empty",
        baseBranch: "main",
        baseSha: "abc123def456789",
        branch: "vc-5",
      },
    });
    expect(empty.text).toContain("carries no commits ahead of `main`");
    expect(empty.text).not.toMatch(/merged/i);

    const noRepo = noChangeCompletionEvent({
      taskKey: "VC-5",
      actor,
      occurredAt: at,
      by: "human",
      verification: {
        basis: "no_repo",
        baseBranch: null,
        baseSha: null,
        branch: null,
      },
    });
    expect(noRepo.text).toContain("no GitHub repository");
    expect(noRepo.text).not.toMatch(/merged/i);
  });

  it("a FORCED close says the check did not pass — and quotes what it found", () => {
    // The honesty edge: forcing past "the branch carries 2 commits" must NOT
    // read "the re-check could not be performed". It looked, and it found work.
    const forced = noChangeCompletionEvent({
      taskKey: "VC-5",
      actor,
      occurredAt: at,
      by: "human",
      verification: null,
      forcedRefusal: "VC-5's branch `vc-5` carries 2 commit(s) ahead of `main`.",
    });
    expect(forced.text).toContain("WITHOUT a passing remote re-check");
    expect(forced.text).toContain("2 commit(s)");
    expect(forced.text).not.toContain("completed with no changes");
    expect(forced.text).not.toMatch(/merged/i);
  });
});
