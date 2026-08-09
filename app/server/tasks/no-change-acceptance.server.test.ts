import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import type {
  Engagement,
  FileActorRef,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  forceAcceptCompletion,
  recordAgentCompletion,
  resolveAcceptanceAffordance,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";
import {
  operatorAcceptCompletion,
  operatorSnapshot,
  resolveOperatorAuthority,
} from "./operator-actions.server";

/**
 * R19-8 (ruling 62) — "Completed — no changes", end to end.
 *
 * The live dead end (F19-21): VC-5 was a verification-only task. The operator
 * correctly engaged the reviewer alone with NO deliverer; the reviewer approved;
 * the verdict had nothing to bind to, so the quality event read "there is no
 * delivered revision to bind the verdict to yet", `accept_completion` returned
 * "[noop] No reviewed revision yet — nothing for the required reviewers to
 * approve", and the operator opened a packet asking a human how to close the
 * task out — recommending "Manually mark Done", which bypasses the entire
 * acceptance ceremony.
 *
 * Every test below fails against pre-R19-8 main.
 */

vi.mock("~/server/github/github-context.server", () => ({
  getProjectGithubContext: vi.fn(),
}));
vi.mock("~/server/github/github-reconciler.server", () => ({
  mergeTaskPr: vi.fn(async () => ({ status: "no_pr" as const })),
  deleteTaskRemoteBranch: vi.fn(async () => ({ status: "no_branch" as const })),
}));

import { getProjectGithubContext } from "~/server/github/github-context.server";
import { mergeTaskPr } from "~/server/github/github-reconciler.server";

const ghCtxMock = vi.mocked(getProjectGithubContext);
const mergeMock = vi.mocked(mergeTaskPr);

let ctx: TestDbContext;
let store: TestStore;

const BASE_SHA = "b".repeat(40);
const RATE_LIMIT = { limit: 5000, remaining: 4999, reset: null };

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

const requestSpy = vi.fn();

/** The remote as the probe will see it. `aheadBy: null` means the task branch
 *  does not exist at all (the VC-5 shape); a number means it does. */
function remote(options: { aheadBy?: number | null; network?: boolean } = {}): void {
  const aheadBy = options.aheadBy ?? null;
  requestSpy.mockImplementation(async (_method: string, path: string) => {
    if (options.network) {
      return { ok: false as const, kind: "network" as const, message: "fetch failed" };
    }
    if (path.includes("/compare/")) {
      return okResponse({
        ahead_by: aheadBy ?? 0,
        behind_by: 0,
        status: aheadBy ? "ahead" : "identical",
        commits: [],
      });
    }
    if (path.endsWith("/heads/main")) return okResponse({ object: { sha: BASE_SHA } });
    // The task branch ref: 404 when the branch was never created.
    return aheadBy === null
      ? httpError(404)
      : okResponse({ object: { sha: "c".repeat(40) } });
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

const OPERATOR_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "direct" },
  { capabilityId: "completion-for-acceptance", mode: "direct" },
];

/** A verdict-capable reviewer profile (+ optionally the operator). Keeps the
 *  project's repo, so the LIVE probe path is what runs. */
function deployAgents(withOperator = false): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [
      {
        profileId: "reviewer",
        capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
        extras: [],
        definition: {
          kind: "specialist",
          name: "reviewer",
          role: "Review & validation",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      },
      ...(withOperator
        ? [
            {
              profileId: "operator",
              capabilities: OPERATOR_POLICY,
              extras: [],
              definition: {
                kind: "operator",
                name: "Operator",
                backends: ["claude"],
                model: "sonnet",
                // R19-A: a per-run `autonomy: "full"` is CLAMPED to the
                // project's configured ceiling, so a fixture that exercises
                // full-autonomy behaviour must configure full autonomy.
                autonomy: "full",
              },
            },
          ]
        : []),
    ] as never,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
const DEVELOPER: Engagement = {
  profileId: "developer",
  backend: "claude",
  role: "Implementation",
  delivers: true,
  verdictCapable: false,
};

const REVIEWER_ACTOR: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "reviewer",
  roleHint: "Review & validation",
};

/** The operator's acceptance packet, for the `resolvePacket` path. Seeded UP
 *  FRONT: a raw test write that lands within 100ms of a real `updateTaskFile`
 *  is treated as a stale read and repaired from the in-process write cache
 *  (task-writer's `repairStaleRead`), which would silently drop it. */
const ACCEPT_PACKET: TaskPacket = {
  id: "pkt_accept",
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Accept completion?",
  body: "The review is clean and there is nothing to deliver.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "Close it out.", rec: true },
  ],
};

/** The live VC-5 shape: at the review boundary, a verdict-capable reviewer
 *  engaged ALONE, and nothing ever delivered — no branch, no PR, no revision. */
function seedVerificationTask(
  patch: Partial<TaskFrontmatter> = {},
  packet: TaskPacket | null = null,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      readiness: "ready",
      waiting: "agent",
      ownerUserId: store.users.arda.id,
      title: "Confirm the smoke file exists on main",
      engagements: [REVIEWER],
      ...patch,
    }),
    goal: "Confirm qa/smoke/pass19.md exists on main; NO changes are expected.",
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function task() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed;
}

function completionEvent() {
  return task().timeline.find((e) => e.type === "completion");
}

function arda() {
  return { userId: store.users.arda.id, label: store.users.arda.email };
}

function dataCtx() {
  return { dataRoot: store.dataRoot };
}

/** Drive the reviewer's approving verdict exactly as the run pipeline does. */
async function reviewerApproves(): Promise<void> {
  await recordAgentCompletion(store.db, dataCtx(), store.slug, "VIB-1", {
    actorRef: REVIEWER_ACTOR,
    runId: "run_review_1",
    replyText: "Checked main: the file is present and correct. Nothing to change.",
    verdict: "approve",
    question: null,
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  vi.clearAllMocks();
  mergeMock.mockResolvedValue({ status: "no_pr" } as never);
  remote();
  resetSseBrokerForTests();
  installFakeRuntime();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("the verdict binds — a verification revision is minted at review time", () => {
  it("R19-8: a reviewer approving a task with nothing to deliver mints a verification revision and binds the verdict", async () => {
    // CANARY: remove the mint block in recordAgentCompletion — the event reverts
    // to "Approval noted", validation stays "none", and the task is VC-5 again.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.workRevision).not.toBeNull();
    expect(fm.workRevision?.kind).toBe("verified");
    expect(fm.workRevision?.headSha).toBe(BASE_SHA);
    expect(fm.workRevision?.branch).toBeNull();
    expect(fm.noChanges).toBe(true);
    // The verdict now HAS a subject, so it binds and derives a pass.
    expect(fm.verdicts).toHaveLength(1);
    expect(fm.verdicts[0]?.revisionId).toBe(fm.workRevision?.id);
    expect(fm.validation).toBe("healthy");

    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Review passed");
    expect(quality?.text).toContain("nothing to deliver");
    expect(quality?.text).toContain("`main`");
    expect(quality?.text).toContain(BASE_SHA.slice(0, 12));
    // The live sentence this replaces.
    expect(quality?.text).not.toContain("no delivered revision to bind");

    // …and the acceptance affordance is now OPEN for the human.
    const affordance = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      dataCtx(),
    );
    expect(affordance.blockedReason).toBeNull();
    expect(affordance.canAccept).toBe(true);
  });

  it("R19-8: a reviewer approving while a deliverer is engaged mints NOTHING", async () => {
    // The mid-run hazard: the branch does not exist YET, which is not the same
    // as never. CANARY: drop the `deliveringEngagement(pre) === null`
    // precondition and an in-flight delivery gets marked "no changes".
    deployAgents();
    seedVerificationTask({ engagements: [DEVELOPER, REVIEWER] });
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.workRevision).toBeNull();
    expect(fm.noChanges).toBeFalsy();
    expect(fm.validation).toBe("none");
    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Approval noted");
  });

  it("R19-8: a reviewer approving a task that already has a branch mints nothing", async () => {
    deployAgents();
    seedVerificationTask({ branch: "vib-1" });
    await reviewerApproves();
    expect(task().frontmatter.workRevision).toBeNull();
    expect(task().frontmatter.noChanges).toBeFalsy();
  });

  it("R19-8: a verification revision alone clears the verdict gate", async () => {
    // `verdictGateReason` refuses "delivered work with no PR". A verification
    // revision is not delivered work, and that must hold on the revision KIND
    // alone — the `noChanges` flag is a separate fact, and pinning only the
    // flag would let the kind arm be deleted with every test still green.
    // CANARY: remove `|| fm.workRevision.kind === "verified"` from
    // verdictGateReason — this reads "deliver the branch & open the PR".
    deployAgents();
    seedVerificationTask({
      engagements: [],
      validation: "healthy",
      workRevision: {
        id: "rev_v9",
        headSha: BASE_SHA,
        treeSha: null,
        branch: null,
        createdAt: "2026-08-06T09:00:00.000Z",
        sourceProfileId: null,
        kind: "verified",
      },
    });
    const affordance = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      dataCtx(),
    );
    expect(affordance.blockedReason).toBeNull();
  });

  it("R19-8: an unverifiable remote mints nothing — the mint fails closed too", async () => {
    deployAgents();
    seedVerificationTask();
    remote({ network: true });
    await reviewerApproves();
    expect(task().frontmatter.workRevision).toBeNull();
    expect(task().frontmatter.noChanges).toBeFalsy();
  });
});

describe("acceptance closes it — with its OWN completion event, and no merge", () => {
  it("R19-8: acceptance closes it to Done with the no-change completion event and merges nothing", async () => {
    // CANARY: delete the `noChange.applies` arm from acceptCompletion's event
    // builder — the title falls back to "Completion accepted" and the record
    // stops naming what was verified.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(task().frontmatter.pr).toBeNull();
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed — no changes");
    expect(completion?.text).toContain("completed with no changes");
    expect(completion?.text).toContain(BASE_SHA.slice(0, 12));
    expect(completion?.text).not.toMatch(/merged/i);
    // The shared acceptance path still pings mergeTaskPr (it is the one place
    // that knows whether a PR exists); it answers `no_pr`, so nothing merges and
    // the record says so. Assert the OUTCOME, not the call.
    expect(await mergeMock.mock.results[0]?.value).toEqual({ status: "no_pr" });
  });

  it("R19-8 fails CLOSED: a branch that gained commits refuses the acceptance", async () => {
    // The whole reason the stored flag is not the evidence. CANARY: remove the
    // check from BOTH acceptCompletion and applyAcceptanceWrite — either layer
    // alone still refuses, which is the point of the two-layer guard.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();
    // …and THEN a delivery lands on the branch, out of band.
    remote({ aheadBy: 2 });

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/carries 2 commit\(s\) ahead of `main`/);

    expect(task().frontmatter.stage).toBe("review");
    expect(completionEvent()).toBeUndefined();
  });

  it("R19-8: an unverifiable remote refuses, and force-accept says the check did not pass", async () => {
    // CANARY: pass a non-null `verification` when forced — the event would then
    // claim a verification that never happened.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();
    remote({ network: true });

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/could not be reached/i);
    expect(task().frontmatter.stage).toBe("review");

    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      arda(),
      dataCtx(),
    );
    expect(task().frontmatter.stage).toBe("done");
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed — no changes");
    expect(completion?.text).toContain("WITHOUT a passing remote re-check");
    expect(completion?.text).not.toContain("completed with no changes");
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(1);
  });

  it("R19-8: the packet path runs the same check", async () => {
    // CANARY: remove the check from resolvePacket's inlined accept.
    deployAgents();
    seedVerificationTask({}, ACCEPT_PACKET);
    await reviewerApproves();
    remote({ aheadBy: 2 });

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/carries 2 commit\(s\) ahead of `main`/);
    expect(task().frontmatter.stage).toBe("review");
  });

  it("R19-8: the packet path closes a verified task with the shared event", async () => {
    deployAgents();
    seedVerificationTask({}, ACCEPT_PACKET);
    await reviewerApproves();

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      arda(),
      dataCtx(),
    );
    expect(task().frontmatter.stage).toBe("done");
    expect(completionEvent()?.title).toBe("Completed — no changes");
    expect(completionEvent()?.text).not.toMatch(/merged/i);
  });
});

describe("the operator reaches the outcome without deliver_for_review", () => {
  it("R19-8: supervised recommends completing with no changes, and does not promise a merge", async () => {
    // CANARY: restore the old single `detail` string — the card tells a human
    // that applying it merges a PR the task does not have.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "supervised" }),
    );
    expect(result.outcome).toBe("recommended");
    const rec = task().frontmatter.recommendations[0];
    expect(rec?.label).toMatch(/no changes/i);
    const detail = task().timeline.find((e) => e.text.includes("nothing to deliver"));
    expect(detail?.text).not.toContain("merges the review PR");
  });

  it("R19-8: full autonomy closes it with the no-change event", async () => {
    // CANARY: delete the operator's `noChange.applies` arm.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("done");
    expect(completionEvent()?.title).toBe("Completed — no changes");
    expect(completionEvent()?.text).toContain("full-autonomy");
    expect(completionEvent()?.text).not.toMatch(/merged/i);
  });

  it("R19-8: full autonomy is REFUSED when the branch carries work", async () => {
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();
    remote({ aheadBy: 4 });

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).toBe("noop");
    expect(result.message).toMatch(/carries 4 commit\(s\)/);
    expect(task().frontmatter.stage).toBe("review");
  });

  it("R19-8: the operator can SEE the shape — get_task carries `noChanges`", async () => {
    // CANARY: drop the snapshot field — the operator is blind again and opens a
    // "how do we close this out?" packet instead of accepting.
    deployAgents(true);
    seedVerificationTask();
    expect(
      operatorSnapshot(store.db, dataCtx(), store.slug, "VIB-1", resolveOperatorAuthority(dataCtx(), store.slug, {})).noChanges,
    ).toBe(false);
    await reviewerApproves();
    expect(
      operatorSnapshot(store.db, dataCtx(), store.slug, "VIB-1", resolveOperatorAuthority(dataCtx(), store.slug, {})).noChanges,
    ).toBe(true);
  });

  it("F19-21 regression: the old dead end is gone", async () => {
    // The verbatim live noop. CANARY: revert the mint — this sentence returns.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).not.toBe("noop");
    expect(result.message).not.toContain("No reviewed revision yet");
  });
});
