import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { gitOutSync, withLocalGithub } from "../../../test-support/git-origin";
import type {
  Engagement,
  TaskFrontmatter,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { DIVERGED_BRANCH_REMEDY } from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { applyRecommendation } from "./task-recommendations.server";
import { resolvePacket } from "./packet-resolution.server";
import { transitionStage } from "./task-transitions.server";
import { manualDeliverForReview, performDelivery } from "./task-delivery.server";
import { completeTaskMerge, forceAcceptCompletion } from "./task-acceptance.server";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { deliverGate, type OperatorAuthority } from "./operator-authority.server";
import { operatorAcceptCompletion, operatorDeliverForReview } from "./operator-moves.server";

/**
 * R15-2 (owner ruling 2026-07-28): delivery — push the task branch + open the
 * review PR — is an OPERATOR decision, not a stage side-effect. Plus the
 * F15-15/B-GH1 conflict cluster (never open a PR over a stale remote), the
 * R15-1 verdict gate, B-WF1 (in-lock re-check), and F15-13 (already-merged
 * honesty). Every test here FAILS against pre-pass-15 main.
 */

// The delivery/acceptance collaborators ride `TaskActionContext`'s test seams
// instead of module mocks: push-workspace, pr-open and the merge are injected
// as typed doubles through the ctx `deps` bag, and the PR-head gate's GitHub
// reads run a REAL `getProjectGithubContext` over the canned transport
// (`fetchImpl`) — `githubReportsHead` seeds the credential and the routes. With
// no credential seeded the context degrades to `no_pat_configured`, the same
// shape the old default mock returned.
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import type { mergeTaskPr } from "~/server/github/github-reconciler.server";
import {
  fakeGithubFetch,
  type FakeGithub,
} from "../../../test-support/fake-github";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { TaskActionContext } from "./task-action-core.server";

const pushMock = vi.fn<typeof pushWorkspaceBranch>();
const openPrMock = vi.fn<typeof openTaskPr>();
const mergeMock = vi.fn<typeof mergeTaskPr>();
let github: FakeGithub | null = null;

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  vi.clearAllMocks();
  github = null;
  pushMock.mockResolvedValue({
    status: "no_commits",
    reason: "no local commits ahead of the default branch",
  });
  openPrMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
  mergeMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
});

afterEach(() => ctx.cleanup());

function seed(patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function fm() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed;
}

const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};

function revision(id = "rev_1", sha = "a".repeat(40)): WorkRevision {
  return {
    id,
    headSha: sha,
    treeSha: sha === "a".repeat(40) ? "t".repeat(40) : "u".repeat(40),
    branch: "vib-1",
    createdAt: "2026-07-28T09:00:00.000Z",
    sourceProfileId: "developer",
  };
}

function approval(revisionId = "rev_1", sha = "a".repeat(40)) {
  return {
    profileId: "reviewer",
    revisionId,
    headSha: sha,
    result: "approve" as const,
    reason: "clean",
    at: "2026-07-28T09:30:00.000Z",
    rounds: 1,
  };
}

function authority(
  modes: Record<string, "direct" | "recommend" | "human" | "off"> = {},
  autonomy: "supervised" | "full" = "supervised",
  humanGatedBeforeWork = false,
): OperatorAuthority {
  return {
    policy: new Map(Object.entries(modes)),
    autonomy,
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: true,
    humanGatedBeforeWork,
  };
}

/** Every entry point gets the injected doubles; the canned transport rides
 *  along once a test has installed one via `githubReportsHead`. */
function dataCtx(): TaskActionContext {
  const callCtx: TaskActionContext = {
    dataRoot: store.dataRoot,
    deps: {
      pushWorkspaceBranch: pushMock,
      openTaskPr: openPrMock,
      mergeTaskPr: mergeMock,
    },
  };
  if (github) callCtx.fetchImpl = github.fetchImpl;
  return callCtx;
}

describe("R15-2: transitionStage no longer auto-delivers on review entry", () => {
  it("entering the review stage opens NO PR and instead writes the typed 'Review reached with no PR yet' event", async () => {
    // Fails on main twice over: openTaskPr fired on the review transition, and
    // no such event existed (a non-delivering Review entry was silent, F15-17).
    seed({ stage: "impl" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    // The safety-net event is fire-and-forget — let it land.
    await new Promise((r) => setTimeout(r, 80));
    expect(openPrMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    const events = fm().timeline;
    const reached = events.find(
      (e) => e.type === "github" && e.text.includes("no live review pull request"),
    );
    expect(reached).toBeDefined();
    expect(reached!.text).toContain("operator decides delivery");
  });

  it("no safety-net event when a live PR already stands", async () => {
    seed({
      stage: "impl",
      pr: { number: 4, state: "review", title: "[VIB-1] t" },
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(
      fm().timeline.some((e) => e.text.includes("no live review pull request")),
    ).toBe(false);
  });

  it("ruling 546: no safety-net event for a task delivered as the files saved on it", async () => {
    // Live on AWSC-2, a research task whose delivery is two files: the note
    // said the operator decides a push and a review PR. CANARY: drop
    // `deliveredAsFiles` from the condition and the note is written.
    seed({ stage: "impl", deliveredAt: "2026-09-28T08:44:13.751Z" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(fm().frontmatter.stage).toBe("review");
    expect(
      fm().timeline.some((e) => e.text.includes("no live review pull request")),
    ).toBe(false);
  });

  it("ruling 667: no safety-net event on a project with no repository", async () => {
    // A board that delivers results has no pull request to open, and the note
    // told its owner the operator was deciding a push and a review PR.
    // CANARY: drop the repository term from the condition and it is written.
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, { ...project.parsed.frontmatter, repo: null });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seed({ stage: "impl" });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(fm().frontmatter.stage).toBe("review");
    expect(
      fm().timeline.some((e) => e.text.includes("no live review pull request")),
    ).toBe(false);
  });

  it("ruling 576: no safety-net event for a task a reviewer verified has nothing to deliver", async () => {
    // Live on AWSC-11 the note told the owner the operator decides a push and
    // a review PR, 30 seconds after the reviewer's approval verified there was
    // nothing to deliver (R19-8). CANARY: drop `noChangeApplies` from the
    // condition and the note is written.
    seed({
      stage: "impl",
      noChanges: true,
      workRevision: {
        id: "rev_verified",
        headSha: "b".repeat(40),
        treeSha: null,
        branch: null,
        createdAt: "2026-09-28T23:10:22.590Z",
        sourceProfileId: null,
        kind: "verified",
      },
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(fm().frontmatter.stage).toBe("review");
    expect(
      fm().timeline.some((e) => e.text.includes("no live review pull request")),
    ).toBe(false);
  });
});

/**
 * Ruling 202 (F37-22). The stranded-operator backstop judges a drive by what it
 * changed, and delivery changed nothing it could see: a drive whose single
 * action was `deliver_for_review` was recorded as having "held the stage
 * without advancing, dispatching, or opening a packet", and coordination was
 * declared paused on a task that was at that moment being delivered. The stamp
 * has to land on ENTRY, because the push and the PR call can outlive the run
 * row — live, the PR event reached the timeline 8 seconds after the drive was
 * marked finished, and 111ms before that the settle had already called it a
 * hold.
 */
describe("ruling 202: a delivering drive marks itself as having acted", () => {
  it("stamps `delivered` on entry, whatever GitHub then answers", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_failed",
      reason: "the remote rejected the push",
    });
    const ctx = dataCtx();
    ctx.operatorRun = { backend: "codex", autonomy: "supervised", reactDepth: 0 };
    // CANARY: stamp on the `delivered` return instead of on entry — the
    // obvious wrong version, "record it once GitHub said yes" — and this goes
    // red. A refused push is still a drive that ACTED, and the whole point of
    // the stamp is that it cannot wait for an answer the settle will not.
    const outcome = await performDelivery(
      store.db,
      ctx,
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome.status).toBe("push_failed");
    // The drive ACTED. Whether GitHub accepted it is a different question, and
    // not the one the backstop is asking.
    expect(ctx.operatorRun.delivered).toBe(true);
  });

  /**
   * Ruling 211(d) — the correction to 202's own fix, from the adversarial
   * self-review. Stamping on ENTRY counted the arms that do nothing at all as
   * progress, so a nudged drive whose only action was a delivery that could
   * never leave the machine looked like it had moved: the stranded backstop
   * then skipped its durable `heldAtStage` marker and every later trigger
   * re-armed the nudge from scratch — F31-11's fourteen-drives loop, reached
   * through the fix for ruling 202.
   */
  it("ruling 211(d): a delivery REFUSED before the remote is not progress", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "grant_withheld",
      reason: "the delivering agent's repo-write capability is withheld",
    });
    const ctx = dataCtx();
    ctx.operatorRun = { backend: "codex", autonomy: "supervised", reactDepth: 0 };
    // CANARY: stamp on entry (ruling 202's first version) and this reads true —
    // a drive that did nothing at all counts as having delivered.
    const outcome = await performDelivery(
      store.db,
      ctx,
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome.status).toBe("grant_withheld");
    expect(ctx.operatorRun.delivered).toBeUndefined();
  });
});

describe("F15-15/B-GH1: performDelivery refuses a PR over a conflicted or failed push", () => {
  it("push_conflict: no PR is opened, the event names a history conflict — never the credential", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason:
        "the remote branch `vib-1` holds commits that are not in the local delivery (non-fast-forward)",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome.status).toBe("push_conflict");
    // Fails on main: no push_conflict status existed, the PR was opened anyway
    // over the stale remote content, and the copy blamed the credential.
    expect(openPrMock).not.toHaveBeenCalled();
    const event = fm().timeline.find((e) => e.type === "github");
    expect(event).toBeDefined();
    expect(event!.text).toContain("not a credential problem");
    expect(event!.text).toContain("No review PR was opened");
    expect(event!.text).toContain("`vib-1`");
  });

  it("ruling 321: a conflict on the task's OWN open PR does not tell a person to delete it", async () => {
    /**
     * Live on SHOP-11, twice. A backend engineer rebased a branch that had an
     * open pull request, the delivery push was refused, and this event told
     * the owner to *"delete or rename it, or force-push deliberately"* — while
     * Viberr's own collision ceremony wrote, forty-seven milliseconds later,
     * "No collision to clear: PR #15 on `shop-11` is SHOP-11's own review PR."
     * Deleting that branch closes the pull request under review; force-pushing
     * rewrites the commits the reviewers already judged.
     *
     * CANARY: pass `departure: null` at the call site in performDelivery.
     */
    seed({
      stage: "review",
      branch: "vib-1",
      pr: {
        number: 15,
        state: "review",
        title: "[VIB-1] Cart service",
        url: "https://github.com/akin-ozer/viberr/pull/15",
      },
    });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason:
        "the remote branch `vib-1` holds commits that are not in the local delivery (non-fast-forward)",
    });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));

    const text = fm().timeline.find((e) => e.type === "github")!.text;
    // The fact the server had and the sentence did not use.
    expect(text).toContain("OWN review PR #15");
    expect(text).toContain("deleting that branch closes the pull request");
    // The act it used to recommend, and what actually works instead.
    expect(text).not.toContain("delete or rename it");
    expect(text).toContain(DIVERGED_BRANCH_REMEDY);
  });

  it("ruling 321: with no PR and no published head, the branch is an anonymous ref and says so", async () => {
    // The counterweight — the case the old fixed sentence was written for is
    // still allowed to say "delete or rename it", because there is nothing on
    // the branch the product knows this task to have put there. A fix that
    // hedged every push conflict would be its own kind of unhelpful.
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason: "the remote branch `vib-1` holds commits that are not in the local delivery",
    });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));

    const text = fm().timeline.find((e) => e.type === "github")!.text;
    expect(text).toContain("No pull request tracks `vib-1`");
    expect(text).toContain("Delete or rename it on GitHub");
    expect(text).not.toContain("OWN review PR");
  });

  it("ruling 321: a STRANGER's PR on the branch names the ceremony built for it", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      github: { commits: [], changed: null, unownedPr: 22 },
    });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason: "the remote branch `vib-1` holds commits that are not in the local delivery",
    });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));

    const text = fm().timeline.find((e) => e.type === "github")!.text;
    expect(text).toContain("PR #22, which VIB-1 did not open");
    expect(text).toContain("clear the branch collision");
    // Never by hand when the product has a ceremony that states what it destroys.
    expect(text).not.toContain("Delete or rename it on GitHub");
  });

  /**
   * T3 (pass 31) — the SEAM the two mocked halves leave open.
   *
   * Every other test here injects `pushWorkspaceBranch`, and every
   * push-workspace test injects `exec`. So "a remote branch holding foreign
   * commits produces `push_conflict`, and that opens no PR" is proved twice,
   * on either side of a join nothing crosses: the classifier is fed a
   * hand-written stderr string, and the decision is fed a hand-written status.
   * Live on 2026-08-31 the real shape appeared — a stale remote `vib-1` from a
   * wiped instance stood on the task's branch name — and this is the only test
   * that reproduces it with real git: a real bare origin whose `vib-1` carries
   * a commit the local delivery has never seen.
   *
   * `deps` deliberately omits `pushWorkspaceBranch`, so the real module runs;
   * `openTaskPr` stays a double purely so "no PR was opened" is observable.
   */
  it("T3: a REAL non-fast-forward push refuses with push_conflict and opens NO PR", async () => {
    // Canary: relax `isNonFastForwardStderr` (drop the non-fast-forward arm) and
    // this lands on `push_failed` — same refusal, wrong diagnosis, and the
    // event blames a credential. Delete the `openPr` guard on a conflicted push
    // in performDelivery and the openPrMock assertion fails.
    seed({ stage: "review", branch: "vib-1" });
    const patActor = actorOf(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_realpush0001" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);

    // The workspace clone the delivery pushes from. `akin-ozer/viberr` → viberr.
    const repoDir = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      "viberr",
    );
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    gitOutSync(repoDir, ["init", "-q", "-b", "main"]);
    gitOutSync(repoDir, ["config", "user.email", "t@viberr.local"]);
    gitOutSync(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
    gitOutSync(repoDir, ["add", "-A"]);
    gitOutSync(repoDir, ["commit", "-q", "-m", "init"]);

    // The PROJECT's repository, stood in for on disk: pass 40 review
    // (R-seams-1) pushes to the project's own URL from the server's stage,
    // never through the checkout's agent-writable `origin`.
    const origins = path.join(store.dataRoot, "origins");
    const remoteDir = path.join(origins, "akin-ozer", "viberr.git");
    mkdirSync(remoteDir, { recursive: true });
    gitOutSync(remoteDir, ["init", "-q", "--bare"]);
    gitOutSync(repoDir, ["remote", "add", "origin", remoteDir]);
    gitOutSync(repoDir, ["push", "-q", "origin", "main"]);
    gitOutSync(repoDir, ["fetch", "-q", "origin"]);

    // A STRANGER's `vib-1` on the remote: a commit this task never made.
    gitOutSync(repoDir, ["checkout", "-q", "-b", "stranger", "main"]);
    writeFileSync(path.join(repoDir, "stranger.txt"), "from a wiped instance\n");
    gitOutSync(repoDir, ["add", "-A"]);
    gitOutSync(repoDir, ["commit", "-q", "-m", "foreign work"]);
    gitOutSync(repoDir, ["push", "-q", "origin", "stranger:refs/heads/vib-1"]);
    gitOutSync(repoDir, ["checkout", "-q", "main"]);
    gitOutSync(repoDir, ["branch", "-q", "-D", "stranger"]);

    // This task's OWN delivery: a local `vib-1` branched from main, so its
    // history and the remote's share only the root commit.
    gitOutSync(repoDir, ["checkout", "-q", "-b", "vib-1", "main"]);
    writeFileSync(path.join(repoDir, "work.txt"), "this task's work\n");
    gitOutSync(repoDir, ["add", "-A"]);
    gitOutSync(repoDir, ["commit", "-q", "-m", "[VIB-1] deliver"]);

    const outcome = await withLocalGithub(origins, () =>
      performDelivery(
        store.db,
        {
          dataRoot: store.dataRoot,
          // No pushWorkspaceBranch — the real one runs against real git.
          deps: { openTaskPr: openPrMock, mergeTaskPr: mergeMock },
        },
        store.slug,
        "VIB-1",
        actorOf(store.users.arda),
      ),
    );

    expect(outcome.status).toBe("push_conflict");
    if (outcome.status === "push_conflict") {
      expect(outcome.branch).toBe("vib-1");
      expect(outcome.message).toContain("non-fast-forward");
    }
    // The whole point: nothing was opened over the stranger's content.
    expect(openPrMock).not.toHaveBeenCalled();
    const event = fm().timeline.find((e) => e.type === "github");
    expect(event!.text).toContain("not a credential problem");
    expect(event!.text).toContain("No review PR was opened");
    // And the remote branch still holds ONLY the stranger's commit — a refused
    // delivery never force-writes over it (R18-4).
    const remoteTip = gitOutSync(remoteDir, ["log", "-1", "--format=%s", "refs/heads/vib-1"]);
    expect(remoteTip).toBe("foreign work");
  });

  it("push_failed: the PR attempt is refused too (a stale-head PR reviews the wrong content)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_failed",
      reason: "git push returned non-zero",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome.status).toBe("push_failed");
    // Fails on main: the old best-effort flow still attempted the PR.
    expect(openPrMock).not.toHaveBeenCalled();
  });

  it("a delivered push opens (or reuses) the PR and reports it", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 9,
      created: true,
      url: "https://github.com/x/y/pull/9",
    });
    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 9, created: true });
  });

  // F29-7: a prior server-owned push conflicted; the operator opened a blocked
  // "push conflict … no PR opened" packet (its branch/delivery family is
  // marked by the `discard_branch` option) and readiness floored to blocked.
  // The human then clears the remote branch and re-delivers from the panel —
  // the packet's premise is now moot and must not persist next to a live PR.
  //
  // V10 (pass-31 review): F31-6 refuses `discard_branch` authoring exactly when
  // delivered work stands on the branch, so post-F31-6 push-conflict packets
  // carry `resolve_remote_collision` instead. Keying the supersession on
  // `discard_branch` alone reopened F29-7 for every such packet: the human
  // resolves the branch out-of-band, re-delivers, and the task keeps a
  // blocked "no PR opened" card beside a live "PR #N" panel.
  it.each<{ marker: string; packet: TaskPacket }>([
    {
      marker: "discard_branch",
      packet: {
        id: "pkt_conflict",
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Delivery push conflict on branch `vib-1` — remote holds unrelated commits",
        body: "No review PR was opened.",
        observations: [],
        options: [
          { kind: "custom", t: "Delete or rename the remote branch, then retry delivery", d: "", rec: true },
          { kind: "discard_branch", t: "Give this task a different branch name and re-deliver", d: "", rec: false },
          { kind: "custom", t: "Deliberate force-push to `vib-1`", d: "", rec: false },
        ],
      },
    },
    {
      marker: "resolve_remote_collision, V10",
      packet: {
        id: "pkt_conflict_rrc",
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Delivery push conflict on branch `vib-1` — remote holds unrelated commits",
        body: "No review PR was opened.",
        observations: [],
        options: [
          {
            kind: "resolve_remote_collision",
            t: "Clear the stale remote branch and re-deliver",
            d: "",
            rec: true,
          },
          { kind: "archive_task", t: "Archive this task", d: "", rec: false },
        ],
      },
    },
  ])("F29-7: a successful delivery supersedes a stale delivery-conflict blocked packet ($marker)", async ({ packet }) => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        readiness: "blocked",
      }),
      packet,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 11,
      created: true,
      url: "https://github.com/x/y/pull/11",
    });

    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 11 });

    const after = fm();
    expect(after.packet).toBeNull();
    expect(after.frontmatter.readiness).not.toBe("blocked");
    expect(after.timeline.some((e) => /Packet withdrawn/.test(e.text ?? ""))).toBe(
      true,
    );
  });

  it("V11 (pass-31 review): a fully successful resolve_remote_collision lifts the packet's readiness block", async () => {
    // The push-conflict packet floored readiness at `blocked`
    // (operatorOpenPacket does that for every blocked packet), and the
    // resolution write clears the PACKET before the remedy runs — so the F29-7
    // withdrawal can never lift the gate (no packet left to withdraw), and
    // nothing in the delivery path writes readiness. Without the explicit lift
    // the task stayed in the board's Blocked filter forever, packet-less, even
    // after the PR opened.
    const patActor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_v11collision0000000000000000000001" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    github = fakeGithubFetch({
      // Ruling 128: the delivery reads the base ref before pushing.
      "GET /repos/akin-ozer/viberr/git/ref/heads/main": { body: { object: { sha: "c".repeat(40) } } },
      "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
      "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1": { status: 204, body: "" },
    });
    const COLLISION_PACKET: TaskPacket = {
      id: "pkt_v11",
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Delivery push conflict on branch `vib-1`",
      body: "No review PR was opened.",
      observations: [],
      options: [
        {
          kind: "resolve_remote_collision",
          t: "Clear the stale remote branch and re-deliver",
          d: "",
          rec: true,
        },
      ],
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        readiness: "blocked",
        waiting: "human",
        workRevision: revision(),
        github: { commits: [], changed: null, unownedPr: 232 },
      }),
      packet: COLLISION_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 14,
      created: true,
      url: "https://github.com/x/y/pull/14",
    });

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      dataCtx(),
    );

    const after = fm();
    expect(after.packet).toBeNull();
    expect(after.frontmatter.github?.unownedPr ?? null).toBeNull();
    // The lift: cleared + re-delivered means the block is falsified.
    expect(after.frontmatter.readiness).toBe("ready");
    // The resolver is present; acceptance stays verdict-gated regardless.
    expect(after.frontmatter.waiting).toBe("human");
  });

  it("F29-7: a successful delivery does NOT touch a reject-recovery packet (archive_task, not a branch conflict)", async () => {
    // A "PR closed without merging → choose recovery path" packet uses
    // archive_task options; it is a different question and stays for the human.
    const REJECT_PACKET: TaskPacket = {
      id: "pkt_reject",
      type: "input",
      kind: "Decision required",
      from: "operator",
      title: "PR #9 closed without merging — choose recovery path",
      body: "",
      observations: [],
      options: [
        { kind: "custom", t: "Rework and reopen", d: "", rec: true },
        { kind: "archive_task", t: "Archive task and delete branch", d: "", rec: false },
      ],
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", branch: "vib-1" }),
      packet: REJECT_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 12,
      created: true,
      url: "https://github.com/x/y/pull/12",
    });

    await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(fm().packet?.id).toBe("pkt_reject");
  });

  // A3: `grant_withheld` / `push_conflict` / `push_failed` refused; the other
  // four push outcomes fell straight through to `openTaskPr` and opened a
  // review PR over a remote nobody had just written to. Each has to name its
  // own cause — "no PR was opened" is only useful if it says why.
  const NOT_DELIVERABLE = [
    {
      // R19-8: `no_commits` carries the workspace evidence too. A CLEAN tree is
      // what makes "nothing to review" a verified statement rather than a guess.
      push: {
        status: "no_commits" as const,
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: { verified: true as const },
      },
      outcome: "nothing_to_review",
      says: "no commits ahead",
    },
    {
      // …and the same status over a tree the delivery commit failed to clean is
      // a genuine failure: the deliverable is still sitting uncommitted.
      push: {
        status: "no_commits" as const,
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: {
          verified: false as const,
          why: "the workspace still has uncommitted changes after the delivery commit attempt",
        },
      },
      outcome: "failed",
      says: "no commits ahead",
    },
    {
      push: { status: "no_workspace" as const, reason: "no workspace git repo" },
      outcome: "failed",
      says: "no workspace clone",
    },
    {
      push: { status: "no_repo" as const, reason: "project has no repo" },
      outcome: "failed",
      // Ruling 667: a standing state of a board that delivers results.
      says: "has no repository, so there is no branch to push and no review PR to open: a task here is delivered as the files its delivering agent saves on it",
    },
    {
      push: { status: "no_branch" as const, reason: "HEAD not on a task branch (main)" },
      outcome: "failed",
      says: "not on a task branch",
    },
  ];
  for (const c of NOT_DELIVERABLE) {
    const label =
      c.push.status === "no_commits"
        ? `a no_commits push over a ${c.push.defaultBranchEvidence?.verified ? "CLEAN" : "DIRTY"} tree`
        : `a ${c.push.status} push`;
    it(`A3: ${label} opens NO PR and says so`, async () => {
      seed({ stage: "review", branch: "vib-1" });
      pushMock.mockResolvedValue(c.push);
      const outcome = await performDelivery(
        store.db,
        dataCtx(),
        store.slug,
        "VIB-1",
        actorOf(store.users.arda),
      );
      expect(openPrMock, "no PR over an unknown remote state").not.toHaveBeenCalled();
      expect(outcome.status).toBe(c.outcome);
      expect(outcome.status === "delivered" ? "" : outcome.message).toContain(c.says);
      // …and the refusal reaches the timeline, like every other delivery failure.
      const event = fm().timeline.find((e) => e.type === "github");
      expect(event?.text).toContain(c.says);
      // R17-2: an empty branch (nothing_to_review) marks the task as a verified
      // no-change completion so acceptance can close it to Done cleanly; the
      // other not-deliverable outcomes are genuine failures and must NOT.
      if (c.outcome === "nothing_to_review") {
        expect(fm().frontmatter.noChanges).toBe(true);
      } else {
        expect(fm().frontmatter.noChanges).toBeFalsy();
      }
    });
  }
});

describe("R15-2: the operator's deliver_for_review decision", () => {
  it("deliverGate: absent grant = direct; explicit off = deny; recommend promotes to direct only at full autonomy", () => {
    expect(deliverGate(authority({}))).toBe("direct");
    expect(deliverGate(authority({ "deliver-review-pr": "off" }))).toBe("deny");
    expect(deliverGate(authority({ "deliver-review-pr": "human" }))).toBe("deny");
    expect(deliverGate(authority({ "deliver-review-pr": "recommend" }))).toBe("recommend");
    expect(
      deliverGate(authority({ "deliver-review-pr": "recommend" }, "full")),
    ).toBe("direct");
  });

  it("R15-9: an ABSENT grant resolves from the project's governance, not a constant", () => {
    // `deliver-review-pr` postdates every pre-R15-2 deployment, so "absent" is
    // the normal state on existing projects. Resolving it to a flat `direct`
    // meant a strict project created before the pass pushed branches on its own
    // while an identical one created after asked a human first — the same
    // governance behaving differently by creation date.
    // Canary: return "direct" unconditionally from absentDeliverReviewPrMode.
    expect(deliverGate(authority({}, "supervised", false))).toBe("direct");
    expect(deliverGate(authority({}, "supervised", true))).toBe("recommend");

    // An EXPLICIT grant always wins over the derived default, in both directions.
    expect(
      deliverGate(authority({ "deliver-review-pr": "direct" }, "supervised", true)),
    ).toBe("direct");
    expect(
      deliverGate(authority({ "deliver-review-pr": "off" }, "supervised", true)),
    ).toBe("deny");
  });

  it("recommend mode posts a `delivery` recommendation card that round-trips the task file", async () => {
    seed({ stage: "review", branch: "vib-1" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority({ "deliver-review-pr": "recommend", "append-typed-events": "direct" }),
    );
    expect(r.outcome).toBe("recommended");
    expect(pushMock).not.toHaveBeenCalled();
    const recs = fm().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    // Fails on main: "delivery" was not a RECOMMENDATION_KIND — the tolerant
    // parser would have dropped the card on round-trip.
    expect(recs[0]!.kind).toBe("delivery");
  });

  it("direct mode performs the delivery and reports push + PR honestly (push_conflict included)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "push_conflict",
      branch: "vib-1",
      reason: "the remote branch `vib-1` holds commits that are not in the local delivery (non-fast-forward)",
    });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(), // absent grant = direct
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("CONFLICTED");
    expect(r.message).toContain("not a credential problem");
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("github.delivery.operator");
  });

  /**
   * Ruling 134 (pass 34, F34-11): the old pin here ("a live open PR makes
   * delivery a noop") WAS the bug. `operatorDeliverForReview` answered from
   * the cached `pr.state` before `performDelivery` ran, so rework on a task
   * with an open PR was never pushed. The push now runs; the ONLY honest noop
   * is the push itself answering `up_to_date`.
   */
  it("a live open PR no longer short-circuits: rework is pushed to it and the message names what moved", async () => {
    // Canary: restore the deleted cached-state pre-check and the push never runs.
    seed({
      stage: "review",
      branch: "vib-1",
      pr: { number: 4, state: "review", title: "[VIB-1] t" },
    });
    pushMock.mockResolvedValue({
      status: "pushed",
      branch: "vib-1",
      commits: 1,
      headSha: "385047c".padEnd(40, "0"),
      remoteHeadBefore: "6004958".padEnd(40, "0"),
    workflowFiles: [],
    });
    openPrMock.mockResolvedValue({ status: "ok", prNumber: 4, created: false, url: "https://x/pull/4" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(),
    );
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("done");
    expect(r.message).toContain("pushed `385047c` to the open review PR #4");
    // The timeline records the moved head, attributed to the Operator.
    const event = fm().timeline.find((e) => e.text.startsWith("Pushed `385047c`"));
    expect(event?.text).toBe("Pushed `385047c` to **PR #4** for review (was `6004958`).");
    expect(event?.actor).toEqual({ kind: "operator" });
    expect(fm().frontmatter.pr?.headSha).toBe("385047c".padEnd(40, "0"));
    const audit = listAuditEvents(store.db, {}).find((a) => a.action === "github.delivery.operator");
    expect(audit?.details).toMatchObject({ status: "delivered", prNumber: 4, moved: true, headSha: "385047c".padEnd(40, "0") });
  });

  it("nothing to push is the only honest noop: an `up_to_date` push reads as 'already carries'", async () => {
    // Canary: return `done`/"Delivered" regardless of `moved` and the message fails.
    seed({
      stage: "review",
      branch: "vib-1",
      pr: { number: 4, state: "review", title: "[VIB-1] t" },
    });
    pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: "385047c".padEnd(40, "0") });
    openPrMock.mockResolvedValue({ status: "ok", prNumber: 4, created: false, url: "https://x/pull/4" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toContain("Nothing to push: PR #4 already carries `385047c`");
    expect(fm().timeline.some((e) => e.text.startsWith("Pushed"))).toBe(false);
    const audit = listAuditEvents(store.db, {}).find((a) => a.action === "github.delivery.operator");
    expect(audit?.details).toMatchObject({ status: "delivered", moved: false });
  });

  it("explicit off denies the delivery", async () => {
    seed({ stage: "review", branch: "vib-1" });
    const r = await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority({ "deliver-review-pr": "off" }),
    );
    expect(r.outcome).toBe("denied");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("F17-1: the operator's delivery calls openTaskPr operator-authorized (so the PR-open event is the Operator, not a guest)", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 1, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 9,
      created: true,
      url: "https://github.com/x/y/pull/9",
    });
    await operatorDeliverForReview(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority(),
    );
    expect(openPrMock).toHaveBeenCalled();
    // The third arg is the actor; a delivery THROUGH the operator tool must mark
    // it operator-authorized so pr-open renders {kind:"operator"}, not a human.
    // Canary: drop `operatorAuthorized: true` in operatorDeliverForReview and
    // this reads false.
    const actorArg = openPrMock.mock.calls.at(-1)![2];
    expect(actorArg.operatorAuthorized).toBe(true);
  });
});

describe("R15-2 safety net (b): manual delivery from the task page", () => {
  it("maintainer delivers; the act is audited github.delivery.manual", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 12,
      created: true,
      url: "https://github.com/x/y/pull/12",
    });
    const outcome = await manualDeliverForReview(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.murat),
      dataCtx(),
    );
    expect(outcome.status).toBe("delivered");
    const audit = listAuditEvents(store.db, {}).find(
      (a) => a.action === "github.delivery.manual",
    );
    expect(audit).toBeDefined();
  });

  it("the task's contributor OWNER may deliver; a non-owner contributor and a viewer may not", async () => {
    seed({ stage: "review", branch: "vib-1", ownerUserId: store.users.selin.id });
    await expect(
      manualDeliverForReview(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.elif), // viewer
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await manualDeliverForReview(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.selin), // contributor OWNER
      dataCtx(),
    );
    // The owner's delivery ran and is audited as theirs; the viewer was
    // refused before any delivery, so it wrote no row.
    expect(
      listAuditEvents(store.db, { action: "github.delivery.manual" }).map((row) => row.actorUserId),
    ).toEqual([store.users.selin.id]);

    // Ownership moved elsewhere → the same contributor is refused.
    seed({ stage: "review", branch: "vib-1", ownerUserId: store.users.murat.id });
    await expect(
      manualDeliverForReview(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.selin),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("R15-2: an applied `delivery` recommendation performs the delivery", () => {
  const REC = {
    id: "r-deliver",
    kind: "delivery" as const,
    label: "Deliver the branch & open the review PR",
    detail: "Committed work is ready for review.",
  };

  it("apply → performDelivery; a delivered outcome consumes the card", async () => {
    seed({ stage: "review", branch: "vib-1", recommendations: [REC] });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 21,
      created: true,
      url: "https://github.com/x/y/pull/21",
    });
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-deliver" },
      actorOf(store.users.murat),
      dataCtx(),
    );
    expect(openPrMock).toHaveBeenCalled();
    expect(fm().frontmatter.recommendations).toHaveLength(0);
  });

  it("a FAILED delivery refuses the apply with the honest reason and keeps the card for retry", async () => {
    seed({ stage: "review", branch: "vib-1", recommendations: [REC] });
    openPrMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
    await expect(
      applyRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: "r-deliver" },
        actorOf(store.users.murat),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Delivery did not complete"),
    });
    expect(fm().frontmatter.recommendations).toHaveLength(1);
  });
});

describe("R15-1: the verdict gate on human acceptance (F15-19)", () => {
  it("refuses acceptance of a delivered revision with NO verdict — the live VIB-9 hole", async () => {
    // Fails on main: with no verdict-capable reviewer engaged, acceptance
    // sailed through and merged the PR ("awaiting verdict" chip and all).
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no approving verdict"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("refuses delivered work with NO review PR (gate 1)", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      validation: "changed",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no review pull request"),
    });
  });
});

describe("R15-1 gate 2 (F15-15): the PR head must contain the delivered revision", () => {
  /** Point the head gate at a REAL GitHub context — a real credential on the
   *  project's repo — served by the canned transport: the `/pulls/` head and
   *  the `/compare/` verdict below, 404 (unknown, never a refusal) for
   *  anything else. */
  function githubReportsHead(headSha: string, compareStatus = "diverged") {
    const patActor = actorOf(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0001" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: headSha } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${headSha}`]: {
        body: { status: compareStatus },
      },
    });
  }

  const healthySeed = () =>
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 114, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });

  it("refuses acceptance of a PR whose head does not contain the delivered revision — even FORCED", async () => {
    // The F15-15 endgame: a PR opened over stale remote junk would have merged
    // with a green review attached. Fails on main: no head check existed.
    healthySeed();
    githubReportsHead("f".repeat(40), "diverged");
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    // Force-accept bypasses verdicts and packets — NEVER the head mismatch.
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("ruling 135: an UNPUSHED delivered revision is refused BEFORE the conflict sentence", async () => {
    // Canary: swap the gate order in `acceptanceRefusalReason` (conflict
    // first) and the refusal names a rebase for a branch that only needs a push.
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: {
        number: 114, state: "review", title: "[VIB-1] t", mergeable: "conflicting", headSha: "1".repeat(40),
        unpushedRevision: { revisionSha: "a".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" },
      },
      validation: "healthy",
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("delivered revision `aaaaaaa` is not on PR #114"),
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ message: expect.not.stringContaining("Rebase") });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("ruling 135 + 223: a 404 compare, confirmed by GitHub's real 422 commit read, is a REFUSAL, not unverifiable", async () => {
    // Canary: restore the plain `unverifiable` return on `!cmp.ok` and the
    // never-pushed revision is accepted with an "unverified head" note.
    //
    // Ruling 223 (F37-43): this fixture used to stub the commit read as a 404
    // carrying GitHub's 422 SENTENCE — a status the endpoint does not return
    // for a well-formed unknown SHA. The test passed and the guard could never
    // fire on the real API. Live on SHOP-17 that merged the revision the
    // required reviewer had REJECTED and lost the one both reviewers approved.
    // The status below is what `gh api repos/<repo>/commits/<unknown-sha>`
    // actually answers.
    healthySeed();
    const patActor = actorOf(store.users.arda);
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0135" }, patActor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    const head = "f".repeat(40);
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${head}`]: { status: 404, body: { message: "Not Found" } },
      [`GET /repos/akin-ozer/viberr/commits/${"a".repeat(40)}`]: {
        status: 422,
        body: { message: `No commit found for SHA: ${"a".repeat(40)}` },
      },
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("is not on GitHub"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();

    // The commit exists on GitHub: the 404 compare is unexplained. Ruling 226
    // (owner, 2026-09-14): that no longer merges. GitHub answered the pull and
    // refused only the comparison, so the repository is reachable, the merge
    // would land, and what would land is unknown.
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${head}`]: { status: 404, body: { message: "Not Found" } },
      [`GET /repos/akin-ozer/viberr/commits/${"a".repeat(40)}`]: { body: { sha: "a".repeat(40) } },
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("could not be checked against the delivered revision"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("a head that CONTAINS the delivered revision (delivery + auto-commit) is accepted", async () => {
    healthySeed();
    githubReportsHead("f".repeat(40), "ahead");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
  });

  it("an unreachable GitHub is UNKNOWN, not a refusal (offline acceptance keeps its merge-pending honesty)", async () => {
    healthySeed();
    // Default degraded context: the check returns null and acceptance proceeds.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
  });

  it("A2: the full-autonomy OPERATOR acceptance is refused by the head gate too", async () => {
    // The docstring called this "the ONE gate force can NEVER bypass" while two
    // of the four Done writers never called it. `operatorAcceptCompletion`
    // checked `acceptanceRefusalFor` only, so a full-autonomy operator stamped
    // `pr.state: accepted` (merge pending) on a PR carrying content its task
    // never delivered — and the poller then nudged a human to merge it.
    // Canary: drop the headCheck from applyAcceptanceWrite and this accepts.
    healthySeed();
    githubReportsHead("f".repeat(40), "diverged");
    // Fails CLOSED: the shared Done write throws, which aborts the operator's
    // action (and, on the Codex path, the rest of its plan) rather than
    // recording a Done nobody verified.
    await expect(
      operatorAcceptCompletion(
        store.db,
        dataCtx(),
        { projectSlug: store.slug, taskKey: "VIB-1" },
        authority({ "completion-for-acceptance": "direct" }, "full"),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(fm().frontmatter.pr?.state).toBe("review");
  });

  it("A2: completeTaskMerge refuses a stale-head merge instead of performing it", async () => {
    // The other bypassed writer, and the dangerous one: it calls mergeTaskPr,
    // which is irreversible. The merge-pending nudge points a human straight at
    // this button. Canary: drop the headCheck and mergeTaskPr is called.
    seed({
      stage: "done",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 114, state: "accepted", title: "[VIB-1] t" },
      validation: "healthy",
    });
    githubReportsHead("f".repeat(40), "diverged");
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(mergeMock).not.toHaveBeenCalled();
    expect(fm().frontmatter.pr?.state).toBe("accepted");
  });

  it("A2: a PR swapped under the acceptance during the verification refuses (the head was checked against the old one)", async () => {
    // The head gate is a live network read, so it cannot run inside the write
    // lock. The pair it verified is re-asserted there instead — otherwise the
    // window between "verified #114" and the Done write is a hole exactly as
    // wide as a GitHub round-trip.
    healthySeed();
    githubReportsHead("a".repeat(40), "identical"); // #114 verifies clean
    mergeMock.mockImplementation(async () => {
      const current = fm();
      writeTask(store.dataRoot, store.slug, {
        frontmatter: {
          ...current.frontmatter,
          // A different PR now stands for this task — nobody verified ITS head.
          pr: { number: 999, state: "review", title: "[VIB-1] t" },
        },
        goal: current.goal,
        timeline: current.timeline,
      });
      return { status: "merged", prNumber: 114, sha: null };
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed while the acceptance was being verified"),
    });
    expect(fm().frontmatter.stage).toBe("review");
  });

  it("A9: an UNVERIFIABLE head that still merges records the caveat in the completion event", async () => {
    // A9's own case, narrowed by ruling 226 to what it always described:
    // GitHub is UNREACHABLE, so the containment check cannot run — and the
    // merge attempt is subject to the same unreachability, which is what made
    // "the merge's own honesty covers it" true here. Acceptance proceeds and
    // the record must say the check did not run. Canary: drop the A9 branch in
    // applyAcceptanceWrite and the completion event reads like a verified accept.
    //
    // The case where GitHub ANSWERS the pull and refuses only the comparison is
    // ruling 226's, and is tested as a refusal above.
    healthySeed();
    const patActor = actorOf(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0009" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { status: 500, body: { message: "boom" } },
    });
    mergeMock.mockResolvedValue({ status: "merged", prNumber: 114, sha: null });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );

    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.pr?.state).toBe("merged");
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("could not be verified against the");
    expect(completion!.text).toContain("without that containment check");
  });

  /**
   * Ruling 226 (owner, 2026-09-14) — the surviving half of F37-43.
   *
   * Ruling 135 built the guard for a PR head that is not the reviewed revision,
   * and ruling 223 made it reachable against GitHub's real 422. What stayed was
   * A9's trade: a head that could not be VERIFIED still merged, with a note
   * naming the check that did not run rather than the consequence. Live, that
   * merged SHOP-17 at the revision its Code Reviewer had rejected.
   */
  describe("ruling 235: a KNOWN unpushed head is recorded and handed to the operator", () => {
    const head = "f".repeat(40);
    const delivered = "a".repeat(40);
    /** The never-pushed shape: the compare 404s and GitHub's real 422 commit
     *  read confirms the delivered revision does not exist on the remote. */
    const neverPushed = () =>
      fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
        [`GET /repos/akin-ozer/viberr/compare/${delivered}...${head}`]: {
          status: 404,
          body: { message: "Not Found" },
        },
        [`GET /repos/akin-ozer/viberr/commits/${delivered}`]: {
          status: 422,
          body: { message: `No commit found for SHA: ${delivered}` },
        },
      });
    const withCredential = () => {
      const patActor = actorOf(store.users.arda);
      const pat = createPat(
        store.db,
        { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0235" },
        patActor,
      );
      setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    };
    const accept = () =>
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      );
    const notes = () =>
      fm().timeline.filter(
        (e) =>
          e.type === "github" &&
          e.title === "Acceptance refused: the reviewed revision is not on the pull request",
      );

    /**
     * F37-55, measured live: SHOP-2's two required reviewers approved
     * `ea5f2ffd7493`, PR #13's head was `913ce9d`, and pressing Accept refused
     * with an exact sentence naming both. That sentence reached ONE browser's
     * toast and nothing else - no audit row, no timeline event, nothing in
     * `task.md`. The person then pressed "Run operator" to get the branch
     * pushed; the operator re-anchored on a file that said nothing about a
     * refusal and filed the SAME acceptance recommendation again.
     */
    it("writes the refusal to the timeline and the audit log, and opens NO packet", async () => {
      healthySeed();
      withCredential();
      github = neverPushed();

      await expect(accept()).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("is not on GitHub"),
      });
      expect(mergeMock).not.toHaveBeenCalled();
      expect(fm().frontmatter.stage).toBe("review");

      // The record now contains what the browser was told.
      const [note] = notes();
      expect(note).toBeTruthy();
      expect(note!.text).toContain("is not on GitHub");
      expect(note!.text).toContain(delivered.slice(0, 7));
      expect(note!.text).toContain(head.slice(0, 7));

      // And NOT a packet: a known mismatch is not a decision. The reviewed
      // revision must be pushed, ruling 134 reserves pushing for the operator,
      // so there is nothing for a person to choose. Only the UNVERIFIABLE case
      // (ruling 226) asks.
      // `packet` is the signal, not `waiting`: a task sitting at the acceptance
      // boundary already waits on a human before anything here runs, so a
      // waiting-state assertion would pass whatever this code did.
      expect(fm().packet).toBeNull();

      expect(
        listAuditEvents(store.db, { action: "task.acceptance.head_unpushed" }),
      ).toHaveLength(1);
    });

    it("presses Accept twice without a second note or a second operator run", async () => {
      healthySeed();
      withCredential();
      github = neverPushed();

      await expect(accept()).rejects.toMatchObject({ status: 409 });
      await expect(accept()).rejects.toMatchObject({ status: 409 });

      // Idempotent by note text: the button pressed twice is one record and one
      // hand-off, not two paid operator runs.
      expect(notes()).toHaveLength(1);
      expect(
        listAuditEvents(store.db, { action: "task.acceptance.head_unpushed" }),
      ).toHaveLength(1);
    });
  });

  describe("ruling 226: a head GitHub would not compare is refused, not disclosed", () => {
    const head = "f".repeat(40);
    const delivered = "a".repeat(40);
    /** GitHub answers the pull and refuses the comparison: reachable, mergeable,
     *  unknown. Not the never-pushed case (the commit read confirms it exists). */
    const answersPullRefusesCompare = () =>
      fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
        [`GET /repos/akin-ozer/viberr/compare/${delivered}...${head}`]: {
          status: 500,
          body: { message: "boom" },
        },
      });
    const withCredential = () => {
      const patActor = actorOf(store.users.arda);
      const pat = createPat(
        store.db,
        { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0226" },
        patActor,
      );
      setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    };
    const accept = () =>
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      );

    it("refuses the merge and opens a decision naming both shas", async () => {
      healthySeed();
      withCredential();
      github = answersPullRefusesCompare();

      await expect(accept()).rejects.toMatchObject({ status: 409 });
      expect(mergeMock).not.toHaveBeenCalled();
      expect(fm().frontmatter.stage).toBe("review");

      // A refusal with no way forward is its own defect, so the gate records
      // the question rather than only throwing a sentence at the browser.
      const packet = fm().packet!;
      expect(packet.title).toContain("could not be checked before merging");
      expect(packet.body).toContain(head.slice(0, 7));
      expect(packet.body).toContain(delivered.slice(0, 7));
      // TWO options, and the missing third is the point: a "try the check
      // again" option would have to be a `custom`, whose resolution sends the
      // task back to the agent side and re-queues the operator — re-running
      // this gate, refusing again, and re-opening this packet. Answering the
      // decision would re-create it, which is ruling 224's fourth half. A
      // re-check needs no option at all: this packet does not block acceptance.
      expect(packet.options.map((o) => o.kind)).toEqual([
        "request_edit",
        "accept_unverified_head",
      ]);
      expect(packet.body).toContain("Press Accept again to re-run the check");
      // And it reaches the BOARD, not just the markdown. `updateTaskFile`
      // writes the file and nothing else; without an explicit reproject the
      // decision a person was just told about would not appear until the file
      // watcher happened to notice.
      // SAFETY: `packet_json` is the only selected column and 0001_baseline
      // declares it nullable TEXT, so a matching row is exactly this shape —
      // and the task was written by this test, so a row exists.
      const projected = store.db
        .prepare(
          `SELECT packet_json FROM task_projections WHERE project_slug = ? AND task_key = ?`,
        )
        .get(store.slug, "VIB-1") as { packet_json: string | null };
      expect(projected.packet_json ?? "").toContain("could not be checked before merging");
      // The recommendation is the safe one — never the override.
      expect(packet.options.findIndex((o) => o.rec)).toBe(0);
      expect(fm().frontmatter.waiting).toBe("human");
    });

    it("presses Accept twice without stacking a second question", async () => {
      healthySeed();
      withCredential();
      github = answersPullRefusesCompare();

      await expect(accept()).rejects.toMatchObject({ status: 409 });
      const first = fm().packet!.id;
      await expect(accept()).rejects.toMatchObject({ status: 409 });
      expect(fm().packet!.id).toBe(first);
    });

    it("grants NO override when the re-read succeeds", async () => {
      healthySeed();
      withCredential();
      github = answersPullRefusesCompare();
      await expect(accept()).rejects.toMatchObject({ status: 409 });

      // GitHub answers the comparison this time. A waiver written now would be
      // a permission nobody needed.
      github = fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
        [`GET /repos/akin-ozer/viberr/compare/${delivered}...${head}`]: {
          body: { status: "ahead" },
        },
      });
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actorOf(store.users.arda),
        dataCtx(),
      );

      const after = fm();
      expect(after.packet).toBeNull();
      expect(after.frontmatter.headCheckWaiver ?? null).toBeNull();
      expect(
        after.timeline.find((e) => e.type === "transition")!.text,
      ).toContain("answered the comparison this time");
    });

    it("pins the override to the head it was granted for, and says what it admits", async () => {
      healthySeed();
      withCredential();
      github = answersPullRefusesCompare();
      await expect(accept()).rejects.toMatchObject({ status: 409 });

      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actorOf(store.users.arda),
        dataCtx(),
      );
      const waiver = fm().frontmatter.headCheckWaiver!;
      expect(waiver).toMatchObject({
        prNumber: 114,
        revisionHeadSha: delivered,
        liveHeadSha: head,
        byUserId: store.users.arda.id,
      });

      // The merge now goes through, and the record names the consequence and
      // the person — not the procedure that was skipped.
      mergeMock.mockResolvedValue({ status: "merged", prNumber: 114, sha: null });
      await accept();
      const completion = fm().timeline.find((e) => e.type === "completion")!;
      expect(completion.text).toContain("Code no reviewer approved may be on the base branch");
      expect(completion.text).not.toContain("GitHub could not be reached");
    });

    it("refuses again once the branch moves under the override", async () => {
      healthySeed();
      withCredential();
      github = answersPullRefusesCompare();
      await expect(accept()).rejects.toMatchObject({ status: 409 });
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 },
        actorOf(store.users.arda),
        dataCtx(),
      );
      expect(fm().frontmatter.headCheckWaiver).toBeTruthy();

      // Someone pushes. The waiver names a head that is no longer there, and a
      // waiver that outlived its head would be a standing permission to merge
      // whatever the branch later carried.
      const moved = "e".repeat(40);
      github = fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: moved } } },
        [`GET /repos/akin-ozer/viberr/compare/${delivered}...${moved}`]: {
          status: 500,
          body: { message: "boom" },
        },
      });
      await expect(accept()).rejects.toMatchObject({ status: 409 });
      expect(mergeMock).not.toHaveBeenCalled();
    });
  });

  it("A9: a VERIFIED head adds NO caveat (a clean accept never reads as unverified)", async () => {
    healthySeed();
    githubReportsHead("f".repeat(40), "ahead"); // head CONTAINS the delivery
    mergeMock.mockResolvedValue({ status: "merged", prNumber: 114, sha: null });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );

    const completion = fm().timeline.find((e) => e.type === "completion");
    expect(completion!.text).not.toContain("could not be verified");
  });
});

describe("F15-11: no acceptance affordance on a task already at the terminal stage", () => {
  it("the acceptance affordance denies on Done (the button used to render live)", async () => {
    const { acceptanceStanding } = await import("./task-acceptance.server");
    seed({ stage: "done" });
    const affordance = acceptanceStanding(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        viewerUserId: store.users.arda.id,
      },
      dataCtx(),
    ).affordance;
    expect(affordance.hasAuthority).toBe(true);
    expect(affordance.atBoundary).toBe(false);
    expect(affordance.canAccept).toBe(false);
  });
});

describe("B-WF1: the in-lock re-check after the merge await", () => {
  it("a revision delivered DURING the merge await refuses the acceptance instead of closing on it", async () => {
    // Fails on main: the direct path re-checked nothing after the merge await —
    // the stale acceptance closed the task over the brand-new revision.
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    mergeMock.mockImplementation(async () => {
      // Simulate a new delivery landing while the merge round-trips: rev_2
      // exists, nothing has judged it.
      const current = fm();
      writeTask(store.dataRoot, store.slug, {
        frontmatter: {
          ...current.frontmatter,
          workRevision: revision("rev_2", "b".repeat(40)),
          validation: "changed",
        },
        goal: current.goal,
        timeline: current.timeline,
      });
      return { status: "merged", prNumber: 7, sha: null };
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fm().frontmatter.stage).toBe("review");
  });
});

describe("F15-13: already-merged honesty in the acceptance event", () => {
  it("accepting a PR merged out of band says so — and never claims the merge as the human's act", async () => {
    // Fails on main: the event read "…the review PR is accepted, merge pending"
    // (or claimed a fresh merge) and pr.state was DOWNGRADED merged → accepted.
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "merged", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actorOf(store.users.arda),
      dataCtx(),
    );
    expect(mergeMock).not.toHaveBeenCalled(); // nothing left to merge
    const parsed = fm();
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("already been merged on GitHub");
    expect(completion!.text).not.toContain("merge pending");
    expect(parsed.frontmatter.pr?.state).toBe("merged"); // never downgraded
  });
});

describe("gap 1: resolvePacket's accept_completion is the THIRD Done writer and carries every gate", () => {
  const ACCEPT_PACKET: TaskPacket = {
    id: "pkt_accept",
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Accept completion, or send back?",
    body: "The review is clean.",
    observations: [],
    options: [
      {
        kind: "accept_completion",
        t: "Accept completion",
        d: "Mark done and merge.",
        rec: true,
      },
    ],
  };

  function seedWithPacket(patch: Partial<TaskFrontmatter> = {}): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", patch),
      packet: ACCEPT_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("refuses the packet acceptance when the PR head does not contain the delivered revision (F15-15)", async () => {
    // Fails on wave-1 (and on main): the packet path never called
    // acceptancePrHeadCheck — the junk-head PR merged through the
    // operator's own acceptance packet.
    // As in githubReportsHead: a real credential + canned transport, answering
    // this packet's PR #7 with a junk head and the compare with "diverged".
    const patActor = actorOf(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0002" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/7": {
        body: { head: { sha: "f".repeat(40) } },
      },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${"f".repeat(40)}`]: {
        body: { status: "diverged" },
      },
    });
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("does not contain the delivered"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("refuses the packet acceptance for a delivered revision with NO verdict (R15-1 on path 3)", async () => {
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no approving verdict"),
    });
    expect(fm().frontmatter.stage).toBe("review");
  });

  it("ruling 686: packet acceptance on an UNVERIFIABLE head that still merges records the caveat, as the button's does (A9 on path 3)", async () => {
    // The option made the same head check as the button and wrote a record
    // that read like a verified accept: "…and the review PR was merged."
    // CANARY: drop `unverifiedHeadNote` from the packet arm's write.
    const patActor = actorOf(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0010" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    // GitHub cannot be read for the pull, so the containment check cannot run.
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/7": { status: 500, body: { message: "boom" } },
    });
    mergeMock.mockResolvedValue({ status: "merged", prNumber: 7, sha: null });
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      dataCtx(),
    );
    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.pr?.state).toBe("merged");
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("and the review PR was merged.");
    expect(completion!.text).toContain(
      "Note: PR #7's head could not be verified against the delivered revision before the merge " +
        "(GitHub could not be reached for the check). It was accepted without that containment check.",
    );
  });

  it("packet acceptance of an out-of-band-merged PR says so and never downgrades (F15-13 on path 3)", async () => {
    // Fails on wave-1: the packet mutate wrote `reallyMerged ? merged :
    // accepted` — an already-merged PR was downgraded and the event claimed
    // "merge pending".
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "merged", title: "[VIB-1] t" },
      validation: "healthy",
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      dataCtx(),
    );
    expect(mergeMock).not.toHaveBeenCalled();
    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.pr?.state).toBe("merged");
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("already been merged on GitHub");
    expect(completion!.text).not.toContain("merge pending");
  });

  it("acceptance consumes EVERY standing recommendation card, not just the closing kinds (gap 3)", async () => {
    seedWithPacket({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
      recommendations: [
        {
          id: "rec_run",
          kind: "run_agent",
          label: "Run the specialist",
          detail: "leftover offer",
          profileId: "developer",
        },
      ],
    });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      dataCtx(),
    );
    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    // A Done task keeps NO applicable offers — a leftover run card would start
    // a run on a closed task if applied later.
    expect(parsed.frontmatter.recommendations).toEqual([]);
  });
});

describe("ruling 161 (pass 35, G35-6): the delivery push stamps workRevision.pushedAt", () => {
  const HEAD = "8c463b7".padEnd(40, "0");
  function seedReported(): void {
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: {
        id: "rev_reported",
        headSha: HEAD,
        treeSha: "b".repeat(40),
        branch: "vib-1",
        createdAt: "2026-09-06T18:56:57.000Z",
        sourceProfileId: "developer",
        kind: "delivered",
      },
    });
  }

  it("a `pushed` push whose head is the revision stamps pushedAt; the PR step still runs", async () => {
    // Canary: drop the stamp block in performDelivery and `pushedAt` stays
    // absent, so the discard gate reads a published head as a local draft.
    seedReported();
    pushMock.mockResolvedValue({
      status: "pushed",
      branch: "vib-1",
      commits: 1,
      headSha: HEAD,
      remoteHeadBefore: null,
      workflowFiles: [],
    });
    expect(fm().frontmatter.workRevision?.pushedAt ?? null).toBeNull();
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
    const stamped = fm().frontmatter.workRevision;
    expect(stamped?.id).toBe("rev_reported");
    expect(stamped?.pushedAt).toEqual(expect.any(String));
    expect(openPrMock).toHaveBeenCalledTimes(1);
  });

  it("`up_to_date` (origin already carries the head) stamps it too; a head the push did not name is left alone", async () => {
    seedReported();
    pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: "f".repeat(40) });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
    // A different head: nothing says origin holds THIS revision.
    expect(fm().frontmatter.workRevision?.pushedAt ?? null).toBeNull();

    pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: HEAD });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
    expect(fm().frontmatter.workRevision?.pushedAt).toEqual(expect.any(String));
  });

  describe("ruling 439: a pushed head that is Viberr's own base refresh", () => {
    // Live on ax-clone AX-29 the refresh pushed `278c1ed` (the merge onto the
    // revision `4e6c47d`), and the delivery found origin `up_to_date` at that
    // merge.
    const merged = "278c1ed".padEnd(40, "0");
    function seedRefreshedOnto(onto: string): void {
      seed({
        stage: "review",
        branch: "vib-1",
        workRevision: {
          id: "rev_reported",
          headSha: HEAD,
          treeSha: "b".repeat(40),
          branch: "vib-1",
          createdAt: "2026-09-06T18:56:57.000Z",
          sourceProfileId: "developer",
          kind: "delivered",
        },
        baseRefreshes: [
          { mergeSha: merged, baseSha: "b".repeat(40), base: "main", commits: 2, at: "2026-09-23T02:44:06.000Z", onto },
        ],
      });
      pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: merged });
    }

    it("publishes the revision it was merged onto", async () => {
      // CANARY: compare `rev.headSha === pushedHead` again and the revision
      // origin carries is still read as a local draft.
      seedRefreshedOnto(HEAD);
      await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
      const stamped = fm().frontmatter.workRevision;
      expect(stamped?.id).toBe("rev_reported");
      expect(stamped?.pushedAt).toEqual(expect.any(String));
    });

    it("says nothing about a revision the refresh was not merged onto", async () => {
      seedRefreshedOnto("9".repeat(40));
      await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
      expect(fm().frontmatter.workRevision?.pushedAt ?? null).toBeNull();
    });
  });
});

/**
 * Ruling 334 — a transient GitHub blip recorded as broken settings.
 *
 * Four `openTaskPr` statuses shared one remedy: "Fix the repository/credential
 * settings, then deliver again." For the transport one, that accuses a
 * configuration the record proves is fine.
 *
 * Live on SHOP-48, disproved 58 seconds later by the product itself: at
 * 23:45:36 "GitHub was unreachable (network error). Fix the repository/credential
 * settings, then deliver again", and at 23:46:34 "Opened PR #52 for review" —
 * same credential, same repo, nothing touched, and the retry was the operator's
 * own. A successful push to that same origin is recorded two minutes earlier.
 *
 * Ruling 128's comment twelve lines above this arm already states the rule —
 * never "unreachable" paired with "fix the credential settings (nothing is wrong
 * with them)" — and fixed only the `base_branch_missing` arm.
 */
describe("ruling 334: an unreachable GitHub is not a broken credential", () => {
  it("names the transport reason and does not accuse the settings", async () => {
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "pushed",
      branch: "vib-1",
      commits: 1,
      headSha: "a".repeat(40),
      remoteHeadBefore: null,
      workflowFiles: [],
    });
    openPrMock.mockResolvedValue({
      status: "network_unavailable",
      message: "fetch failed: ECONNRESET api.github.com",
    });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));

    const event = fm().timeline.find((e) => e.type === "github" && /No pull request/.test(e.text))!;
    expect(event, "the failure was not surfaced").toBeTruthy();
    // CANARY: fold `network_unavailable` back into the shared remedy.
    expect(event.text).not.toContain("Fix the repository/credential settings");
    expect(event.text).toContain("Nothing about this project's repository or credential is wrong");
    // The reason GitHub's client handed back, which every arm used to drop.
    expect(event.text).toContain("ECONNRESET");
    // And the fact that makes the retry safe.
    expect(event.text).toContain("the branch is pushed and the work is safe");
  });

  it("keeps the settings remedy where it is TRUE", async () => {
    // The counterweight: `no_pat_configured` really is a settings problem, and
    // a fix that hedged every arm would lose the one sentence that helps.
    seed({ stage: "review", branch: "vib-1" });
    pushMock.mockResolvedValue({
      status: "pushed",
      branch: "vib-1",
      commits: 1,
      headSha: "a".repeat(40),
      remoteHeadBefore: null,
      workflowFiles: [],
    });
    openPrMock.mockResolvedValue({ status: "no_pat_configured", repo: null });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));

    const event = fm().timeline.find((e) => e.type === "github" && /No pull request/.test(e.text))!;
    expect(event.text).toContain("no GitHub credential is configured for this project");
    expect(event.text).toContain("Fix the repository/credential settings");
  });
});

/**
 * P11-13: the Review-time push-grant guard, read off the push itself. A
 * withheld-grant deliverer must not have its workspace pushed; and (the
 * regression the adversarial review caught) a deliverer NAMED in the task
 * whose profile was undeployed between the run and Review falls back
 * CONSERVATIVE (deny), never permissive. A project with no repository still
 * reaches the push: the base-branch bootstrap skips without a GitHub context.
 * CANARY: hand the push `canCommitPush: true` unconditionally and the withheld
 * and undeployed rows fail.
 */
describe("P11-13: the delivery push carries the deliverer's repo-write grant", () => {
  /** Deploy a `dev` specialist whose repo-write grants are `mode`. */
  function deployDev(mode: "direct" | "human"): void {
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [
            { capabilityId: "execute-code-or-write-repo", mode },
            { capabilityId: "commit-push-branch", mode },
          ],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "developer",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const deliverer = (profileId: string): Engagement => ({
    profileId,
    backend: "claude",
    role: "developer",
    delivers: true,
    verdictCapable: false,
  });

  it.each([
    ["no deliverer is engaged (no grant to enforce)", true, "direct", null],
    ["the deliverer's repo-write is granted", true, "direct", "dev"],
    ["the deliverer's repo-write is withheld", false, "human", "dev"],
    ["a named deliverer's profile was undeployed", false, "direct", "ghost"],
  ] as const)("%s → canCommitPush %s", async (_label, expected, mode, profileId) => {
    deployDev(mode);
    seed({ stage: "review", engagements: profileId ? [deliverer(profileId)] : [] });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actorOf(store.users.arda));
    expect(pushMock.mock.calls[0]![0].canCommitPush).toBe(expected);
  });
});
