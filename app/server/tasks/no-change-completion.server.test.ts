import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import {
  fakeGithubFetch,
  unreachableFetch,
  type FakeGithub,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  acceptanceNoChangeCheck,
  assertVerifiedNoChangeStillApplies,
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

let ctx: TestDbContext;
let store: TestStore;
let github: FakeGithub;

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_probe", label: "arda@viberr.test" };

const refBody = (sha: string) => ({ body: { object: { sha } } });
const compareBody = (aheadBy: number) => ({
  body: { ahead_by: aheadBy, behind_by: 0, status: aheadBy > 0 ? "ahead" : "identical", commits: [] },
});
const httpError = (status: number, message = "Not Found") => ({
  status,
  body: { message },
});

/**
 * Point the probe at a real GitHub context — a real credential on a real repo —
 * served by the canned transport. An OMITTED route answers 404, which is
 * literally the "no such branch" case the probe reads, so the fixtures only
 * name the routes a scenario changes.
 */
function installGithub(routes: {
  branchRef?: FakeResponder;
  baseRef?: FakeResponder;
  compare?: FakeResponder;
  branch?: string;
}): void {
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_nochange000000000000000000000001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  const branch = routes.branch ?? "vib-1";
  github = fakeGithubFetch({
    [`GET ${REPO_PATH}/git/ref/heads/${branch}`]: routes.branchRef ?? refBody(HEAD_SHA),
    [`GET ${REPO_PATH}/git/ref/heads/main`]: routes.baseRef ?? refBody(BASE_SHA),
    [`GET ${REPO_PATH}/compare/main...${branch}`]: routes.compare ?? compareBody(0),
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
  return { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl };
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // The default fixture: a repo with no credential yet. Tests that need one
  // call `installGithub`, which seeds it along with the canned routes.
  github = fakeGithubFetch({});
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
      compare: compareBody(3),
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
    installGithub({});
    const probe = await probeNothingToDeliver(
      store.db,
      { dataRoot: store.dataRoot, fetchImpl: unreachableFetch() },
      store.slug,
      "VIB-1",
    );
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
    seed(); // no `installGithub` — the project has a repo and no credential
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
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, { ...project.parsed.frontmatter, repo: null });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
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
      // R20-2: an ordinary task (has a PR) fails noChangeCandidate → never probed.
      autoDetected: false,
    });
    expect(github.calls).toHaveLength(0);
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
      compare: compareBody(2),
    });
    const check = await acceptanceNoChangeCheck(store.db, dataCtx(), store.slug, "VIB-1");
    expect(check.applies).toBe(true);
    expect(check.verification).toBeNull();
    expect(check.refusal).toContain("2 commit");
  });

  it("ruling 550: a files delivery that lands during the probe stops the no-change close", () => {
    // The probe found no branch for a task with nothing delivered; then its
    // deliverer's files were stamped while the acceptance awaited GitHub. The
    // re-check in the lock must see what the check before the probe would
    // have. CANARY: re-check with `noChangeCandidate` alone and this closes a
    // delivered result as "completed with no changes".
    const delivered: TaskFrontmatter = {
      ...baseTaskFrontmatter("VIB-1", { pr: null }),
      deliveredAt: "2026-09-28T08:44:13.751Z",
    };
    expect(() =>
      assertVerifiedNoChangeStillApplies(
        delivered,
        { applies: true, refusal: null, verification: null, branch: null, autoDetected: true },
        "VIB-1",
      ),
    ).toThrow(/changed while the acceptance was being verified/);
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
