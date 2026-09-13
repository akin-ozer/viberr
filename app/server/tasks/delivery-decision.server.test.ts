import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  Engagement,
  TaskFrontmatter,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  applyRecommendation,
  completeTaskMerge,
  forceAcceptCompletion,
  manualDeliverForReview,
  performDelivery,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";
import {
  deliverGate,
  operatorAcceptCompletion,
  operatorDeliverForReview,
  type OperatorAuthority,
} from "./operator-actions.server";

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
import type { TaskActionContext } from "./task-actions.server";

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

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

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
      actor(store.users.arda),
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
      actor(store.users.arda),
      dataCtx(),
    );
    await new Promise((r) => setTimeout(r, 80));
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
      actor(store.users.arda),
    );
    expect(outcome.status).toBe("push_failed");
    // The drive ACTED. Whether GitHub accepted it is a different question, and
    // not the one the backstop is asking.
    expect(ctx.operatorRun.delivered).toBe(true);
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
      actor(store.users.arda),
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
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_realpush0001" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);

    const git = (cwd: string, args: string[]): string =>
      execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

    // The workspace clone the delivery pushes from. `akin-ozer/viberr` → viberr.
    const repoDir = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      "viberr",
    );
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "user.email", "t@viberr.local"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);

    const remoteDir = path.join(store.dataRoot, "bare-origin.git");
    mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "-q", "--bare"]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["push", "-q", "origin", "main"]);
    git(repoDir, ["fetch", "-q", "origin"]);

    // A STRANGER's `vib-1` on the remote: a commit this task never made.
    git(repoDir, ["checkout", "-q", "-b", "stranger", "main"]);
    writeFileSync(path.join(repoDir, "stranger.txt"), "from a wiped instance\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "foreign work"]);
    git(repoDir, ["push", "-q", "origin", "stranger:refs/heads/vib-1"]);
    git(repoDir, ["checkout", "-q", "main"]);
    git(repoDir, ["branch", "-q", "-D", "stranger"]);

    // This task's OWN delivery: a local `vib-1` branched from main, so its
    // history and the remote's share only the root commit.
    git(repoDir, ["checkout", "-q", "-b", "vib-1", "main"]);
    writeFileSync(path.join(repoDir, "work.txt"), "this task's work\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "[VIB-1] deliver"]);

    const outcome = await performDelivery(
      store.db,
      {
        dataRoot: store.dataRoot,
        // No pushWorkspaceBranch — the real one runs against real git.
        deps: { openTaskPr: openPrMock, mergeTaskPr: mergeMock },
      },
      store.slug,
      "VIB-1",
      actor(store.users.arda),
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
    const remoteTip = git(remoteDir, ["log", "-1", "--format=%s", "refs/heads/vib-1"]);
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
      actor(store.users.arda),
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
      actor(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 9, created: true });
  });

  it("F29-7: a successful delivery supersedes a stale delivery-conflict blocked packet", async () => {
    // A prior server-owned push conflicted; the operator opened a blocked
    // "push conflict … no PR opened" packet (its branch/delivery family is
    // marked by the `discard_branch` option) and readiness floored to blocked.
    // The human then clears the remote branch and re-delivers from the panel —
    // the packet's premise is now moot and must not persist next to a live PR.
    const CONFLICT_PACKET: TaskPacket = {
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
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        readiness: "blocked",
      }),
      packet: CONFLICT_PACKET,
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
      actor(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 11 });

    const after = fm();
    expect(after.packet).toBeNull();
    expect(after.frontmatter.readiness).not.toBe("blocked");
    expect(after.timeline.some((e) => /Packet withdrawn/.test(e.text ?? ""))).toBe(
      true,
    );
  });

  it("V10 (pass-31 review): a conflict packet authored with resolve_remote_collision is superseded too", async () => {
    // F31-6 refuses `discard_branch` authoring exactly when delivered work
    // stands on the branch, so post-F31-6 push-conflict packets carry
    // `resolve_remote_collision` instead. Keying the supersession on
    // `discard_branch` alone reopened F29-7 for every such packet: the human
    // resolves the branch out-of-band, re-delivers, and the task keeps a
    // blocked "no PR opened" card beside a live "PR #N" panel.
    const COLLISION_CONFLICT_PACKET: TaskPacket = {
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
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        readiness: "blocked",
      }),
      packet: COLLISION_CONFLICT_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    pushMock.mockResolvedValue({ status: "pushed", branch: "vib-1", commits: 2, headSha: "a".repeat(40), remoteHeadBefore: null, workflowFiles: [] });
    openPrMock.mockResolvedValue({
      status: "ok",
      prNumber: 13,
      created: true,
      url: "https://github.com/x/y/pull/13",
    });

    const outcome = await performDelivery(
      store.db,
      dataCtx(),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome).toMatchObject({ status: "delivered", prNumber: 13 });

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
      actor(store.users.arda),
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
      actor(store.users.arda),
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
      says: "no GitHub repository configured",
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
        actor(store.users.arda),
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
      actor(store.users.murat),
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
        actor(store.users.elif), // viewer
        dataCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const outcome = await manualDeliverForReview(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.selin), // contributor OWNER
      dataCtx(),
    );
    expect(outcome.status).not.toBe(undefined);

    // Ownership moved elsewhere → the same contributor is refused.
    seed({ stage: "review", branch: "vib-1", ownerUserId: store.users.murat.id });
    await expect(
      manualDeliverForReview(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.selin),
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
      actor(store.users.murat),
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
        actor(store.users.murat),
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
        actor(store.users.arda),
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
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no review pull request"),
    });
  });

  it("accepts once a verdict-capable reviewer approved the delivered revision", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      engagements: [REVIEWER],
      workRevision: revision(),
      verdicts: [approval()],
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "healthy",
    });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(task.stage).toBe("done");
  });

  it("a task with NOTHING delivered stays acceptable (planning / non-repo work)", async () => {
    seed({ stage: "review" });
    const task = await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(task.stage).toBe("done");
  });

  it("admin force-accept remains the audited bypass for the missing verdict", async () => {
    seed({
      stage: "review",
      branch: "vib-1",
      workRevision: revision(),
      pr: { number: 7, state: "review", title: "[VIB-1] t" },
      validation: "changed",
    });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, {}).find(
      (a) => a.action === "task.acceptance.forced",
    );
    expect(forced).toBeDefined();
    expect(JSON.stringify(forced!.details)).toContain("no approving verdict");
  });
});

describe("R15-1 gate 2 (F15-15): the PR head must contain the delivered revision", () => {
  /** Point the head gate at a REAL GitHub context — a real credential on the
   *  project's repo — served by the canned transport: the `/pulls/` head and
   *  the `/compare/` verdict below, 404 (unknown, never a refusal) for
   *  anything else. */
  function githubReportsHead(headSha: string, compareStatus = "diverged") {
    const patActor = actor(store.users.arda);
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
        actor(store.users.arda),
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
        actor(store.users.arda),
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
        actor(store.users.arda),
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
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({ message: expect.not.stringContaining("Rebase") });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();
  });

  it("ruling 135: a compare GitHub answers 404 to, confirmed by a 404 commit read, is a REFUSAL, not unverifiable", async () => {
    // Canary: restore the plain `unverifiable` return on `!cmp.ok` and the
    // never-pushed revision is accepted with an "unverified head" note.
    healthySeed();
    const patActor = actor(store.users.arda);
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0135" }, patActor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    const head = "f".repeat(40);
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${head}`]: { status: 404, body: { message: "Not Found" } },
      [`GET /repos/akin-ozer/viberr/commits/${"a".repeat(40)}`]: { status: 404, body: { message: "No commit found for SHA" } },
    });
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("is not on GitHub"),
    });
    expect(fm().frontmatter.stage).toBe("review");
    expect(mergeMock).not.toHaveBeenCalled();

    // The commit exists on GitHub: the 404 compare is unexplained, so the head
    // stays unverifiable and the acceptance proceeds with its disclosure.
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: head } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${head}`]: { status: 404, body: { message: "Not Found" } },
      [`GET /repos/akin-ozer/viberr/commits/${"a".repeat(40)}`]: { body: { sha: "a".repeat(40) } },
    });
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );
    expect(fm().frontmatter.stage).toBe("done");
  });

  it("a head that CONTAINS the delivered revision (delivery + auto-commit) is accepted", async () => {
    healthySeed();
    githubReportsHead("f".repeat(40), "ahead");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
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
      actor(store.users.arda),
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
        actor(store.users.arda),
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
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed while the acceptance was being verified"),
    });
    expect(fm().frontmatter.stage).toBe("review");
  });

  it("A9: an UNVERIFIABLE head that still merges records the caveat in the completion event", async () => {
    // The head reads (a different sha), but the CONTAINMENT compare 404s — the
    // check could not run. Acceptance still proceeds (an unverifiable head is
    // allowed, unlike a KNOWN mismatch), the merge lands, and the record must
    // say the containment check did not run. Canary: drop the A9 branch in
    // applyAcceptanceWrite and the completion event reads like a verified accept.
    healthySeed();
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_headgate0009" },
      patActor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
    // The PR-head read answers; the compare fails in a way that is NOT the
    // never-pushed evidence (ruling 135 reads a 404 compare confirmed by a 404
    // commit read as a refusal), so the head stays unverifiable.
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/114": { body: { head: { sha: "f".repeat(40) } } },
      [`GET /repos/akin-ozer/viberr/compare/${"a".repeat(40)}...${"f".repeat(40)}`]: { status: 500, body: { message: "boom" } },
    });
    mergeMock.mockResolvedValue({ status: "merged", prNumber: 114, sha: null });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );

    const parsed = fm();
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.pr?.state).toBe("merged");
    const completion = parsed.timeline.find((e) => e.type === "completion");
    expect(completion!.text).toContain("could not be verified against the");
    expect(completion!.text).toContain("without that containment check");
  });

  it("A9: a VERIFIED head adds NO caveat (a clean accept never reads as unverified)", async () => {
    healthySeed();
    githubReportsHead("f".repeat(40), "ahead"); // head CONTAINS the delivery
    mergeMock.mockResolvedValue({ status: "merged", prNumber: 114, sha: null });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
      actor(store.users.arda),
      dataCtx(),
    );

    const completion = fm().timeline.find((e) => e.type === "completion");
    expect(completion!.text).not.toContain("could not be verified");
  });
});

describe("F15-11: no acceptance affordance on a task already at the terminal stage", () => {
  it("resolveAcceptanceAffordance denies on Done (the button used to render live)", async () => {
    const { resolveAcceptanceAffordance } = await import("./task-actions.server");
    seed({ stage: "done" });
    const affordance = resolveAcceptanceAffordance(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        viewerUserId: store.users.arda.id,
      },
      dataCtx(),
    );
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
        actor(store.users.arda),
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
      actor(store.users.arda),
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
    // acceptancePrHeadMismatch — the junk-head PR merged through the
    // operator's own acceptance packet.
    // As in githubReportsHead: a real credential + canned transport, answering
    // this packet's PR #7 with a junk head and the compare with "diverged".
    const patActor = actor(store.users.arda);
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
        actor(store.users.arda),
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
        actor(store.users.arda),
        dataCtx(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no approving verdict"),
    });
    expect(fm().frontmatter.stage).toBe("review");
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
      actor(store.users.arda),
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
      actor(store.users.arda),
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
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actor(store.users.arda));
    const stamped = fm().frontmatter.workRevision;
    expect(stamped?.id).toBe("rev_reported");
    expect(stamped?.pushedAt).toEqual(expect.any(String));
    expect(openPrMock).toHaveBeenCalledTimes(1);
  });

  it("`up_to_date` (origin already carries the head) stamps it too; a head the push did not name is left alone", async () => {
    seedReported();
    pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: "f".repeat(40) });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actor(store.users.arda));
    // A different head: nothing says origin holds THIS revision.
    expect(fm().frontmatter.workRevision?.pushedAt ?? null).toBeNull();

    pushMock.mockResolvedValue({ status: "up_to_date", branch: "vib-1", headSha: HEAD });
    await performDelivery(store.db, dataCtx(), store.slug, "VIB-1", actor(store.users.arda));
    expect(fm().frontmatter.workRevision?.pushedAt).toEqual(expect.any(String));
  });
});
