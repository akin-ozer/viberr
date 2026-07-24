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
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  forceAcceptCompletion,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";
import {
  operatorAcceptCompletion,
  operatorSnapshot,
  resolveOperatorAuthority,
} from "./operator-actions.server";

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
        },
      },
    ] as never,
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
  resetSseBrokerForTests();
  installFakeRuntime();
});

afterEach(() => {
  resetSseBrokerForTests();
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
    });
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

describe("the admin override still works, and NAMES the gate it bypassed", () => {
  it("forceAcceptCompletion accepts a closed-PR task and audits the closed-PR reason", async () => {
    seedClosedPrTask();
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      arda(),
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(JSON.stringify(forced[0]?.details)).toMatch(
      /closed on GitHub without merging/i,
    );
  });
});
