import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  closedPrBlockedReason,
  type TaskFrontmatter,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { forceAcceptCompletion, acceptanceStanding } from "./task-acceptance.server";
import { resolvePacket } from "./packet-resolution.server";
import { transitionStage } from "./task-transitions.server";
import { operatorAcceptCompletion, operatorSnapshot } from "./operator-actions.server";
import { resolveOperatorAuthority } from "./operator-authority.server";

/**
 * P13-D-4 — the closed-PR guard on ALL THREE paths to Done.
 *
 * A review PR a human CLOSED on GitHub without merging is an out-of-band
 * rejection. Pass-12 NEW-1 only guarded the direct `acceptCompletion` path;
 * `resolvePacket`'s inlined accept and `operatorAcceptCompletion`'s
 * full-autonomy branch both overwrote `pr.state` to "accepted" and landed the
 * task in Done. `pr.state` self-heals on the next reconcile poll — `stage` does
 * not, so Done was durable.
 */

let ctx: TestDbContext;
let store: TestStore;

const OPERATOR_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "direct" },
  { capabilityId: "completion-for-acceptance", mode: "direct" },
];

function deployOperator(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: OPERATOR_POLICY,
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: ["claude"],
          model: "sonnet",
          // R19-A: a per-run `autonomy: "full"` is now CLAMPED to the project's
          // configured level, so the full-autonomy paths below only exist on a
          // project that actually configured full autonomy. Previously the
          // fixture left this unset (= supervised) and the run override alone
          // conjured the power — the very hole R19-A closes.
          autonomy: "full",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** A task sitting in Review whose PR a human closed on GitHub. */
function seedClosedPrTask(
  patch: Partial<TaskFrontmatter> = {},
  packet: TaskPacket | null = null,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      readiness: "ready",
      waiting: "human",
      validation: "healthy",
      ownerUserId: store.users.arda.id,
      title: "Attach execution workspace",
      branch: "vib-1-attach-execution-workspace",
      pr: { number: 318, state: "closed", title: "[VIB-1] Attach execution workspace" },
      ...patch,
    }),
    goal: "Prove the closed-PR guard covers every writer to Done.",
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

function arda() {
  return { userId: store.users.arda.id, label: store.users.arda.email };
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  installFakeRuntime();
});

afterEach(() => {
  ctx.cleanup();
});

describe("closedPrBlockedReason (the one shared guard)", () => {
  it("blocks only a CLOSED pr — review/merged/accepted/no-pr all pass", () => {
    expect(closedPrBlockedReason({ pr: null }, "VIB-1")).toBeNull();
    for (const state of ["review", "merged", "accepted"] as const) {
      expect(
        closedPrBlockedReason({ pr: { number: 1, state, title: "t" } }, "VIB-1"),
      ).toBeNull();
    }
    const reason = closedPrBlockedReason(
      { pr: { number: 1, state: "closed", title: "t" } },
      "VIB-1",
    );
    expect(reason).toContain("VIB-1");
    expect(reason).toMatch(/closed on GitHub without merging/i);
  });
});

describe("path 1 — the human acceptance path (pass-12 NEW-1, still guarded)", () => {
  it("a manual transition into Done refuses while the PR is closed", async () => {
    seedClosedPrTask();
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/closed on GitHub without merging/i);
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.pr?.state).toBe("closed");
  });
});

describe("path 2 — resolvePacket's inlined accept_completion", () => {
  it("refuses the accept_completion option while the PR is closed (D-4)", async () => {
    // The acceptance packet the operator opens at the review boundary.
    seedClosedPrTask(
      {},
      {
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
      },
    );

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        arda(),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/closed on GitHub without merging/i);

    // Nothing moved and the closed PR was NOT overwritten to "accepted".
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.pr?.state).toBe("closed");
    // The packet is still open for the human to choose a real next step.
    expect(task().packet).not.toBeNull();
  });
});

describe("path 3 — operatorAcceptCompletion", () => {
  it("full autonomy refuses to move a closed-PR task to Done (D-4)", async () => {
    deployOperator();
    seedClosedPrTask();
    const result = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
        autonomy: "full",
      }),
    );
    expect(result.outcome).toBe("noop");
    expect(result.message).toMatch(/closed on GitHub without merging/i);
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.pr?.state).toBe("closed");
  });

  it("R17-1: a full-autonomy accept of a drifted-head PR names the divergence in the completion event", async () => {
    deployOperator();
    // An OPEN review PR whose head drifted ahead of the reviewed revision by 2.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        validation: "healthy",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        branch: "vib-1-attach-execution-workspace",
        pr: {
          number: 318,
          state: "review",
          title: "[VIB-1] Attach execution workspace",
          revisionDrift: { headSha: "aheadhead0000", authored: 2, baseRefresh: null },
        },
      }),
      goal: "Prove the divergence note lands on the completion record.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const result = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
        autonomy: "full",
      }),
    );
    expect(result.message).toMatch(/accepted|Done/i);
    expect(task().frontmatter.stage).toBe("done");
    const completion = task().timeline.find((e) => e.type === "completion");
    // Ruling 132: the record says AUTHORED, in the shared vocabulary.
    expect(completion?.text).toContain("2 authored commits were added to the PR head");
    // The note shows the first 12 chars of the drifted head sha.
    expect(completion?.text).toContain("aheadhead000");
  });

  it("R17-2: a full-autonomy accept of a verified no-change task closes to Done with a distinct completion", async () => {
    deployOperator();
    // A delivered task whose branch is empty (no PR) — the R17-2 no-change flag.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        validation: "healthy",
        ownerUserId: store.users.arda.id,
        title: "Normalize headings",
        branch: "vib-1-normalize",
        pr: null,
        noChanges: true,
        workRevision: {
          id: "rev_1",
          headSha: "maintipsha000",
          treeSha: null,
          branch: "vib-1-normalize",
          createdAt: "2026-08-04T08:00:00.000Z",
          sourceProfileId: "developer",
        },
      }),
      goal: "Normalize the headings (already consistent).",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const result = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
        autonomy: "full",
      }),
    );
    expect(result.message).toMatch(/Done|accepted/i);
    expect(task().frontmatter.stage).toBe("done");
    const completion = task().timeline.find((e) => e.type === "completion");
    // R19-8: the outcome now has its OWN event title, from the shared builder,
    // and its text names the basis the LIVE re-check established — here
    // `no_repo` (this fixture's project has `repo: null`), which is why a
    // repo-less project stays acceptable.
    expect(completion?.title).toBe("Completed with no changes");
    expect(completion?.text).toContain("completed with no changes");
    expect(completion?.text).toContain("no GitHub repository");
    // Nothing was merged — no PR ever existed, and the record never says it was.
    expect(completion?.text).not.toMatch(/merged/i);
    expect(task().frontmatter.pr).toBeNull();
  });

  it("R17-2: WITHOUT the no-change flag, a delivered-no-PR task is still refused", async () => {
    deployOperator();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        validation: "healthy",
        ownerUserId: store.users.arda.id,
        title: "Ship the feature",
        branch: "vib-1-feature",
        pr: null,
        // no `noChanges` — delivered work that simply never opened a PR.
        workRevision: {
          id: "rev_1",
          headSha: "realworksha00",
          treeSha: null,
          branch: "vib-1-feature",
          createdAt: "2026-08-04T08:00:00.000Z",
          sourceProfileId: "developer",
        },
      }),
      goal: "Ship it.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const result = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
        autonomy: "full",
      }),
    );
    expect(result.outcome).toBe("noop");
    expect(result.message).toMatch(/no review pull request|deliver the branch/i);
    expect(task().frontmatter.stage).toBe("review");
  });

  it("supervised does not even RECOMMEND acceptance on a closed-PR task", async () => {
    deployOperator();
    seedClosedPrTask();
    const result = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
        autonomy: "supervised",
      }),
    );
    expect(result.outcome).toBe("noop");
    expect(task().frontmatter.recommendations).toHaveLength(0);
  });

  it("operatorSnapshot exposes `pr` so the operator can SEE the closure", () => {
    deployOperator();
    seedClosedPrTask();
    const snapshot = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {}),
    );
    expect(snapshot.pr).toEqual({
      number: 318,
      state: "closed",
      title: "[VIB-1] Attach execution workspace",
      // F21-17: null here because this fixture's head IS the reviewed revision;
      // when it is not, the fact travels into the recovery packet.
      revisionDrift: null,
      revisionDriftSentence: "",
      headSha: null,
      unpushedRevision: null,
      unpushedRevisionSentence: "",
      // Ruling 162 (pass 35): a settled PR carries no mergeability.
      mergeable: null,
    });
  });

  it("operatorSnapshot.liveRuns carries queued/running rows — the ONLY in-flight truth", () => {
    // Live-caught: the operator inferred an in-flight deliverer from
    // `waiting: "agent"` + its own directive comment while the prompt's run
    // had REFUSED to start; the snapshot now states run truth directly.
    deployOperator();
    seedClosedPrTask();
    const empty = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {}),
    );
    expect(empty.liveRuns).toEqual([]);

    store.db
      .prepare(
        `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
           backend, model, state, created_at, updated_at, agent_profile_id)
         VALUES ('run_live1', 'VIB-1', ?, 't1', 'Implementation', 'primary',
           'codex', 'gpt-test', 'running', ?, ?, 'blog-writer')`,
      )
      .run(store.slug, new Date().toISOString(), new Date().toISOString());
    const withRun = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {}),
    );
    expect(withRun.liveRuns).toEqual([
      { kind: "primary", profileId: "blog-writer", state: "running" },
    ]);
  });

  it("operatorSnapshot.pr is null when the task has no PR", () => {
    deployOperator();
    seedClosedPrTask({ pr: null });
    const snapshot = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {}),
    );
    expect(snapshot.pr).toBeNull();
  });
});

describe("R16-3: a terminal GitHub fact outranks the process gates in the refusal", () => {
  const REVISION = {
    id: "rev_1",
    headSha: "a".repeat(40),
    treeSha: "t".repeat(40),
    branch: "vib-1-attach-execution-workspace",
    createdAt: "2026-08-01T09:00:00.000Z",
    sourceProfileId: "developer",
  };

  it("names the closed PR, not the missing verdict — and withholds the override", () => {
    // Live (H10): the task page showed a correct "PR #124 closed without
    // merging — choose recovery path" packet while the acceptance box beside it
    // read "no approving verdict yet — run a review for a verdict, or an admin
    // can force-accept". Both sentences come from acceptanceRefusalReason; the
    // verdict gate simply sat higher in the chain. Running a review is not the
    // path when the PR is gone.
    // Canary: move closedPrBlockedReason back below verdictGateReason and this
    // reads "no approving verdict yet" again.
    seedClosedPrTask({ workRevision: REVISION, validation: "changed" });
    const affordance = acceptanceStanding(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        viewerUserId: store.users.arda.id,
      },
      { dataRoot: store.dataRoot },
    ).affordance;
    expect(affordance.blockedReason).toMatch(/closed on GitHub without merging/i);
    expect(affordance.blockedReason).not.toMatch(/approving verdict/i);
    // The machine-readable half the rail uses to withhold force-accept.
    expect(affordance.terminallyBlocked).toBe(true);
    expect(affordance.canAccept).toBe(false);
  });

  it("with the PR still open, the process gates speak exactly as before", () => {
    seedClosedPrTask({
      pr: { number: 318, state: "review", title: "[VIB-1] Attach execution workspace" },
      workRevision: REVISION,
      validation: "changed",
    });
    const affordance = acceptanceStanding(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        viewerUserId: store.users.arda.id,
      },
      { dataRoot: store.dataRoot },
    ).affordance;
    expect(affordance.blockedReason).toMatch(/approving verdict/i);
    expect(affordance.terminallyBlocked).toBe(false);
  });
});

describe("F19-25 — the admin override is WITHDRAWN on the server too, not only in the UI", () => {
  /**
   * INVERTED from pass 13 ("the admin override still works, and NAMES the gate
   * it bypassed", which asserted `stage === "done"` on a closed-PR task).
   *
   * That test was written before R16-3 (ruling 37, 2026-08-04) and pinned the
   * exact write the ruling names as the harm: "moves the task to Done over a
   * rejection and stamps `pr.state: accepted` on a PR GitHub has already
   * closed". Pass 19 found the withdrawal had shipped CLIENT-side only
   * (task-detail-hooks.ts hides the button), so every non-UI caller — and any
   * stale client — still wrote it. The rule is now server-side, and this suite
   * asserts the refusal instead of the write.
   */
  it("forceAcceptCompletion REFUSES a closed-PR task — no Done, no `accepted` stamp, no forced audit", async () => {
    seedClosedPrTask();
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        arda(),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/closed on GitHub without merging/i),
    });
    // The task did not move and the closed PR was NOT overwritten.
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.pr?.state).toBe("closed");
    // No audit row either: a `task.acceptance.forced` record for an override
    // that was refused would read as a completed bypass in the log.
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(0);
  });

  it("the refusal says WHY the override does not apply here", async () => {
    seedClosedPrTask();
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        arda(),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Force-accept cannot override that"),
    });
  });

  it("ruling 123: force-accept refuses an ARCHIVED task and says to restore it first", async () => {
    // Pass 33 / F33-6, proven live on SBX-1: `force` skipped the shared refusal
    // helper, which is where the archived gate lives, so an admin could leave a
    // task both archived AND accepted — a state every other path forbids.
    seedClosedPrTask({
      archived: true,
      pr: { number: 318, state: "review", title: "[VIB-1] Attach execution workspace" },
    });
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        arda(),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Restore it before accepting"),
    });
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.archived).toBe(true);
    // And no "forced" row claiming a bypass that never happened.
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(0);
  });

  it("ruling 123: the force affordance is WITHDRAWN on an archived task", async () => {
    seedClosedPrTask({
      archived: true,
      pr: { number: 318, state: "review", title: "[VIB-1] Attach execution workspace" },
    });
    const affordance = acceptanceStanding(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    ).affordance;
    expect(affordance.terminallyBlocked).toBe(true);
    expect(affordance.canAccept).toBe(false);
  });
});
