import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  deliveringEngagement,
  supportingEngagements,
} from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  configureRunServiceForTests,
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { listNotifications } from "~/server/projections/notifications.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  applyRecommendation,
  createTask,
  dismissRecommendation,
  transitionStage,
} from "./task-actions.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import {
  gate,
  operatorAcceptCompletion,
  operatorAssignReviewer,
  operatorAssignSpecialist,
  operatorOpenPacket,
  operatorPostComment,
  operatorSetGoal,
  operatorResolvePacket,
  operatorPromptReviewer,
  operatorPromptSpecialist,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorTransitionStage,
  resolveOperatorAuthority,
  type OperatorAutonomy,
} from "./operator-actions.server";

/**
 * The operator's capability-GATED, operator-authorized actions: the RBAC the
 * operator toolkit enforces. Simulated engine only (no real backend keys).
 */

let ctx: TestDbContext;
let store: TestStore;

/** Deploy the operator (with a policy) + a dev specialist + a reviewer. */
function deployRoster(operatorPolicy: { capabilityId: string; mode: CapabilityMode }[]): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: operatorPolicy,
        extras: [],
        definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet" },
      },
      {
        profileId: "developer",
        capabilities: [],
        extras: [],
        definition: { kind: "specialist", name: "Dev", role: "Implementation", backends: ["claude"], model: "sonnet" },
      },
      {
        profileId: "reviewer",
        capabilities: [],
        extras: [],
        definition: { kind: "specialist", name: "Rev", role: "Code review", backends: ["claude"], model: "sonnet" },
      },
    ] as never,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const DEFAULT_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "assign-primary-specialist", mode: "direct" },
  { capabilityId: "summon-reviewers", mode: "direct" },
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "recommend" },
  { capabilityId: "completion-for-acceptance", mode: "recommend" },
];

function authority(autonomy: OperatorAutonomy) {
  return resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, { autonomy });
}

function task() {
  return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
    .parsed;
}

function seedTask(stage: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage,
      ownerUserId: store.users.arda.id,
      operator: { assignedAtStageId: "triage" },
      title: "Operator drive",
    }),
    goal: "Prove the operator drives the task.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  configureRunServiceForTests();
  const { resetOperatorLeasesForTests } = await import(
    "~/server/runtimes/operator-run.server"
  );
  resetOperatorLeasesForTests();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("resolveOperatorAuthority", () => {
  it("finds the deployed operator + its policy, and honors autonomy override", () => {
    deployRoster(DEFAULT_POLICY);
    const a = authority("full");
    expect(a.deployed).toBe(true);
    expect(a.autonomy).toBe("full");
    expect(a.policy.get("assign-primary-specialist")).toBe("direct");
    expect(a.policy.get("stage-transitions")).toBe("recommend");
  });
});

describe("resolveOperatorAuthority backend override", () => {
  it("uses a backend-appropriate model when the run overrides the backend", () => {
    deployRoster(DEFAULT_POLICY); // definition backends [claude], model sonnet
    const claudeAuth = resolveOperatorAuthority(
      { dataRoot: store.dataRoot },
      store.slug,
      { backend: "claude" },
    );
    const codexAuth = resolveOperatorAuthority(
      { dataRoot: store.dataRoot },
      store.slug,
      { backend: "codex" },
    );
    expect(claudeAuth.model).toBe("sonnet"); // the deployment's own model
    // Overriding to codex must NOT reuse the Claude model (codex would reject it).
    expect(codexAuth.backend).toBe("codex");
    expect(codexAuth.model).not.toBe("sonnet");
    expect(codexAuth.model).toBe(defaultModelFor("codex"));
  });
});

describe("gate", () => {
  it("maps modes to direct / recommend / deny by autonomy", () => {
    deployRoster(DEFAULT_POLICY);
    const supervised = authority("supervised");
    const full = authority("full");
    expect(gate(supervised, "assign-primary-specialist")).toBe("direct");
    expect(gate(supervised, "stage-transitions")).toBe("recommend");
    expect(gate(full, "stage-transitions")).toBe("direct"); // full promotes recommend
    expect(gate(supervised, "change-project-policy")).toBe("deny"); // absent → off → deny
  });
});

describe("operatorSetGoal — draft the goal at the triage gate", () => {
  const DEFAULT_GOAL = "Goal to be refined at the triage quality gate.";

  /** Seed a task whose goal is still the unspecified triage placeholder. */
  function seedUnspecified(): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        readiness: "input_required",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "list files in the project",
      }),
      goal: DEFAULT_GOAL,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("fills an UNSPECIFIED goal (the closed triage-gate gap) + records it", async () => {
    deployRoster(DEFAULT_POLICY);
    seedUnspecified();
    const r = await operatorSetGoal(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        goal: "Write a script that lists every file in the repo; a test asserts it prints the known files.",
        reason: "drafted from the title",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(task().goal).toContain("lists every file");
    // The draft is attributed to the operator on the timeline.
    expect(task().timeline[0]!.actor).toEqual({ kind: "operator" });
    expect(
      listAuditEvents(store.db, { action: "task.goal.updated" })[0]?.taskKey,
    ).toBe("VIB-1");
  });

  it("REFUSES to overwrite an already-specified goal (no scope clobber)", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl"); // goal = "Prove the operator drives the task."
    const r = await operatorSetGoal(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", goal: "something totally different" },
      authority("full"),
    );
    expect(r.outcome).toBe("denied");
    expect(task().goal).toBe("Prove the operator drives the task."); // unchanged
  });

  it("is denied when append-typed-events is withheld", async () => {
    deployRoster([{ capabilityId: "append-typed-events", mode: "off" }]);
    seedUnspecified();
    const r = await operatorSetGoal(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", goal: "A concrete scope for the task." },
      authority("supervised"),
    );
    expect(r.outcome).toBe("denied");
    expect(task().goal).toBe(DEFAULT_GOAL);
  });
});

describe("operatorAssignSpecialist", () => {
  it("direct mode assigns the primary specialist", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
  });

  it("recommend mode adds an actionable recommendation and does NOT assign", async () => {
    deployRoster([{ capabilityId: "assign-primary-specialist", mode: "recommend" }, { capabilityId: "append-typed-events", mode: "direct" }]);
    seedTask("impl");
    const r = await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", reason: "Dev fits impl." },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    // A structured, ACTIONABLE recommendation is added to the task frontmatter…
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("assign_specialist");
    expect(recs[0]!.profileId).toBe("developer");
    expect(recs[0]!.detail).toBe("Dev fits impl.");
    // …and the operator's reasoning is also commented to the timeline.
    expect(task().timeline.some((e) => e.actor.kind === "operator" && e.type === "comment")).toBe(true);
  });

  it("off mode (don't recommend) is denied", async () => {
    deployRoster([{ capabilityId: "assign-primary-specialist", mode: "off" }]);
    seedTask("impl");
    const r = await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("full"), // even full autonomy cannot override an `off` capability
    );
    expect(r.outcome).toBe("denied");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
  });
});

describe("operatorRunSpecialist / operatorRunReviewer — recommend is an APPLYABLE card", () => {
  it("run_specialist under recommend adds an actionable card (not a dead-end comment) that apply STARTS the run", async () => {
    deployRoster([
      { capabilityId: "assign-primary-specialist", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    // Assign the specialist directly first (assignment isn't what's recommended
    // here — starting its run is).
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );

    const r = await operatorRunSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    // The regression: a STRUCTURED, applyable recommendation — NOT a bare
    // "Awaiting a maintainer to confirm" comment with no button.
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("run_specialist");
    // No run started yet (it's only recommended).
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);

    // A maintainer applies the card → the specialist run actually starts.
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: recs[0]!.id },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.recommendations).toHaveLength(0);
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
  });

  it("run_reviewer under recommend adds an applyable card carrying the reviewer profileId", async () => {
    deployRoster([
      { capabilityId: "summon-reviewers", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("review");
    // Engage the reviewer first (starting its run is what's recommended).
    const { assignReviewer } = await import("./specialist-run.server");
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    const r = await operatorRunReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("run_reviewer");
    expect(recs[0]!.profileId).toBe("reviewer");
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);

    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: recs[0]!.id },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
  });
});

describe("operatorAssignReviewer", () => {
  it("direct mode engages a reviewer", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorAssignReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
  });
});

/** Poll until an agent run matching the predicate has appeared AND finished. */
async function waitForFinishedRun(
  taskKey: string,
  predicate: (r: ReturnType<typeof listRunsForTask>[number]) => boolean,
): Promise<boolean> {
  for (let i = 0; i < 160; i++) {
    const run = listRunsForTask(store.db, store.slug, taskKey).find(predicate);
    if (run && run.lifecycle !== "running" && run.lifecycle !== "queued") return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Stop every still-streaming run's cadence timer so it does not outlive a test. */
function interruptRunningRuns(taskKey: string): void {
  const arda = { userId: store.users.arda.id, label: store.users.arda.email };
  for (const r of listRunsForTask(store.db, store.slug, taskKey)) {
    if (r.lifecycle === "running" || r.lifecycle === "queued") {
      interruptRun(store.db, { projectSlug: store.slug, taskKey, runId: r.serverRunId }, arda);
    }
  }
}

describe("operatorPromptSpecialist", () => {
  it("direct mode assigns the specialist, posts a task-related prompt comment, and starts its run", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorPromptSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    // The specialist is assigned…
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    // …a routed-to-agent operator comment prompts it about the task…
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt).toBeDefined();
    expect(prompt!.text).toContain("Operator drive"); // the task title, so it's task-related
    // …addressed to the agent by @mention ("@Dev …")…
    expect(prompt!.text.startsWith("@Dev")).toBe(true);
    // …and its run was triggered (the primary run row exists right after the await).
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "primary")).toBe(true);
    interruptRunningRuns("VIB-1");
  });

  it("respects a custom directive as the prompt text", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorPromptSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        directive: "@Dev implement the auth guard first, then wire the tests.",
      },
      authority("full"),
    );
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt!.text).toBe("@Dev implement the auth guard first, then wire the tests.");
  });

  it("recommend mode posts an assign card and does NOT run the specialist", async () => {
    deployRoster([
      { capabilityId: "assign-primary-specialist", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorPromptSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    expect(task().frontmatter.recommendations[0]?.kind).toBe("assign_specialist");
    // No run was triggered.
    await new Promise((res) => setTimeout(res, 40));
    expect(listRunsForTask(store.db, store.slug, "VIB-1").filter((x) => x.kind === "primary")).toHaveLength(0);
  });
});

describe("operatorPromptReviewer", () => {
  it("direct mode engages the reviewer, posts a prompt comment, and starts its reviewer run", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorPromptReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt).toBeDefined();
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "reviewer")).toBe(true);
    interruptRunningRuns("VIB-1");
  });
});

describe("operatorShouldReactToReply (no-progress guard)", () => {
  it("reacts only to a finished run with a NEW, non-empty report within the depth cap", async () => {
    const { operatorShouldReactToReply } = await import("./task-actions.server");
    // Happy path: finished, a fresh report, first-time reply, depth 0.
    expect(operatorShouldReactToReply("finished", "implemented X, tests pass", null, 0)).toBe(true);
    expect(operatorShouldReactToReply("finished", "round two — different result", "round one", 1)).toBe(true);
    // No progress: the agent repeated its previous reply verbatim → do NOT react
    // (this is the CTL-3 spiral fix).
    expect(operatorShouldReactToReply("finished", "same canned findings", "same canned findings", 0)).toBe(false);
    expect(operatorShouldReactToReply("finished", "  same  ", "same", 0)).toBe(false); // trimmed compare
    // Not a clean finish, or no report → nothing to react to.
    expect(operatorShouldReactToReply("interrupted", "partial", null, 0)).toBe(false);
    expect(operatorShouldReactToReply("error", "boom", null, 0)).toBe(false);
    expect(operatorShouldReactToReply("finished", null, null, 0)).toBe(false);
    expect(operatorShouldReactToReply("finished", "", null, 0)).toBe(false);
    // No active operator run (undefined depth) or depth cap reached → stop.
    expect(operatorShouldReactToReply("finished", "new", null, undefined)).toBe(false);
    expect(operatorShouldReactToReply("finished", "new", null, 4)).toBe(false);
    expect(operatorShouldReactToReply("finished", "new", null, 3)).toBe(true); // just under the cap
  });
});

describe("operator react to an agent report (trigger=agent-reply)", () => {
  it("supervised: reading the report proposes the next transition as a recommendation", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "agent-reply",
      autonomy: "supervised",
      dataRoot: store.dataRoot,
    });
    expect(await waitForFinishedRun("VIB-1", (r) => r.op === true)).toBe(true);
    // Reacting at the work stage proposes advancing to review (recommend-mode).
    expect(
      task().frontmatter.recommendations.some(
        (r) => r.kind === "transition" && r.toStageId === "review",
      ),
    ).toBe(true);
    // It did NOT re-prompt the specialist (no fresh primary run from a react).
    expect(task().frontmatter.stage).toBe("impl");
    interruptRunningRuns("VIB-1");
  });

  it("full autonomy: reading the report performs the move and coordinates the new stage", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "agent-reply",
      autonomy: "full",
      dataRoot: store.dataRoot,
    });
    expect(await waitForFinishedRun("VIB-1", (r) => r.op === true)).toBe(true);
    // Full autonomy performed impl→review and then coordinated review by
    // engaging + prompting a reviewer.
    expect(task().frontmatter.stage).toBe("review");
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
    interruptRunningRuns("VIB-1");
  });

  it("SKIPS a stage-ineligible engaged reviewer instead of hard-halting coordination (F1 regression)", async () => {
    // Deploy a reviewer scoped to `impl` only, engage it, then put the task at
    // `review` — where that reviewer is NOT eligible. The scripted operator
    // drive re-prompts every engaged reviewer at review; before the fix, the
    // run-boundary eligibility throw would propagate and post "Operator halted
    // on an error", permanently stalling the task. It must skip the ineligible
    // reviewer instead.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: DEFAULT_POLICY,
          extras: [],
          definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet" },
        },
        {
          profileId: "reviewer",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist", name: "Rev", role: "Code review",
            backends: ["claude"], model: "sonnet", stages: ["impl"],
          },
        },
      ] as never,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "Ineligible engaged reviewer",
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false },
        ],
      }),
      goal: "Prove the operator skips an ineligible engaged reviewer.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      autonomy: "supervised",
      dataRoot: store.dataRoot,
    });
    await waitForFinishedRun("VIB-1", (r) => r.op === true);
    // The operator must NOT have hard-halted on the eligibility throw.
    const halted = task().timeline.some((e) => /halted on an error/i.test(e.text));
    expect(halted, "operator must skip the ineligible reviewer, not hard-halt").toBe(false);
    interruptRunningRuns("VIB-1");
  });
});

describe("operator single-flight lease + coalesce-queue (A5/A6)", () => {
  it("a trigger arriving while a run is in flight is QUEUED and fired once, not dropped", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { runOperator, resetOperatorLeasesForTests } = await import(
      "~/server/runtimes/operator-run.server"
    );
    resetOperatorLeasesForTests();
    // Fire two concurrent triggers WITHOUT awaiting the first — the second must
    // coalesce (queue), not start a second overlapping operator run.
    const p1 = runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "transition",
      autonomy: "supervised",
      dataRoot: store.dataRoot,
    });
    const r2 = await runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "manual",
      autonomy: "supervised",
      dataRoot: store.dataRoot,
    });
    // The second call coalesced — it returned the queued sentinel, not a new run.
    expect(r2.runId).toBe("queued");
    await p1;
    // Give the queued trigger time to drain, then interrupt anything running.
    await new Promise((r) => setTimeout(r, 50));
    interruptRunningRuns("VIB-1");
    // Exactly the coordination happened; no double-driving (the recommendation
    // isn't duplicated — a transition rec is present at most once).
    const recs = task().frontmatter.recommendations.filter(
      (r) => r.kind === "transition",
    );
    expect(recs.length).toBeLessThanOrEqual(1);
  });
});

describe("operatorTransitionStage", () => {
  it("supervised + recommend mode recommends and does not move (approval boundary)", async () => {
    // impl → review is an `approval` boundary — a human gate — so a supervised
    // operator recommends and waits (triage → ready is now `auto`, so it would
    // NOT recommend; the approval boundary is the one that still routes to a card).
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.waiting).toBe("human");
  });

  it("full autonomy moves the task across an approval boundary as the operator", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("review");
    // The transition event is attributed to the operator, not a human.
    expect(task().timeline.some((e) => e.type === "transition" && e.actor.kind === "operator")).toBe(true);
  });

  it("supervised operator CROSSES the triage → ready `auto` boundary directly", async () => {
    // Post-D2: triage → ready is `auto` (operator advances once scope is clear),
    // so a supervised operator moves it itself rather than filing a recommendation.
    deployRoster(DEFAULT_POLICY);
    seedTask("triage");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("ready");
  });

  it("supervised + recommend mode CROSSES an `auto` boundary directly (no human approval needed)", async () => {
    // ready → impl is an `auto` boundary in the governed workflow ("when a
    // specialist is assigned") — ungoverned, so a supervised operator must move
    // it itself instead of stranding the task with a recommendation nobody
    // needs to approve.
    deployRoster(DEFAULT_POLICY);
    seedTask("ready");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().timeline.some((e) => e.type === "transition" && e.actor.kind === "operator")).toBe(true);
  });

  it("R7-4: a SUPERVISED operator routes a FAILING review BACK to the work stage directly (no recommendation)", async () => {
    // A reviewer requested changes (validation=failing) at Review. review→impl
    // is a backward, off-graph move — but on a failing task it is a rework
    // transition the operator performs itself so the fix re-drives the developer
    // without a human, instead of escalating "no path back to Implementation".
    deployRoster(DEFAULT_POLICY);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        validation: "failing",
        title: "Rework routing",
      }),
      goal: "Prove the operator routes a failing review back.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("impl");
    expect(
      task().timeline.some((e) => e.type === "transition" && e.actor.kind === "operator"),
    ).toBe(true);
  });

  it("R7-4 guard: a HEALTHY task cannot be moved backward by the operator (no rework license)", async () => {
    deployRoster(DEFAULT_POLICY);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        validation: "healthy",
        title: "No rework license",
      }),
      goal: "A healthy review must not slide backward.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      operatorTransitionStage(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
        authority("full"),
      ),
    ).rejects.toThrow(/no governed boundary/i);
    expect(task().frontmatter.stage).toBe("review");
  });
});

describe("auto-invoke on stage transition", () => {
  const arda = () => ({ userId: store.users.arda.id, label: store.users.arda.email });

  it("a human transition to a working stage runs the operator, which prompts the stage's agent", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("ready");
    // Human moves ready → impl (auto boundary). This should hand off to the operator.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      arda(),
      { dataRoot: store.dataRoot },
    );
    const opDone = await waitForFinishedRun("VIB-1", (r) => r.op === true);
    expect(opDone).toBe(true);
    // The operator picked the task up at the new stage and prompted its specialist.
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    expect(
      task().timeline.some((e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent),
    ).toBe(true);
    interruptRunningRuns("VIB-1"); // stop the specialist stream the operator kicked off
  });

  it("a transition INTO the final Done stage does not auto-invoke the operator", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      { dataRoot: store.dataRoot },
    );
    // Give any (unwanted) fire-and-forget invocation a chance to appear.
    await new Promise((r) => setTimeout(r, 60));
    expect(listRunsForTask(store.db, store.slug, "VIB-1").filter((r) => r.op)).toHaveLength(0);
  });
});

describe("operatorAcceptCompletion", () => {
  it("supervised posts an actionable accept-completion → Done recommendation (never moves to Done)", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(task().frontmatter.stage).toBe("review");
    // The review→done boundary now surfaces as a clear, actionable recommendation
    // card (symmetric with the other stage transitions), not a completion packet.
    const rec = task().frontmatter.recommendations.find(
      (x) => x.kind === "accept_completion",
    );
    expect(rec).toBeDefined();
    expect(rec?.toStageId).toBe("done");
    expect(rec?.label.toLowerCase()).toContain("done");
    expect(task().frontmatter.waiting).toBe("human");
  });

  it("full autonomy + EXPLICIT direct accepts completion and moves the task to Done", async () => {
    // Owner ruling Q1: acceptance-to-Done requires an EXPLICIT `direct` grant —
    // full autonomy alone does not promote it. This roster grants it directly.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "direct" },
    ]);
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("done");
    expect(task().frontmatter.waiting).toBe("none");
    expect(task().frontmatter.validation).toBe("healthy");
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.operator.accepted_completion");
  });

  it("full autonomy does NOT accept a task with an OPEN blocked decision (F7-VAL1 mirror)", async () => {
    // The human accept path refuses a task with an open blocked packet; the
    // full-autonomy operator must refuse it too, or it silently buries the
    // unresolved decision. F7-VAL1 decoupled blocked-ness from validation, so a
    // blocked task's `validation` is NOT "failing" — this guard is what stops it.
    deployRoster([
      ...DEFAULT_POLICY.filter(
        (c) =>
          c.capabilityId !== "completion-for-acceptance" &&
          c.capabilityId !== "generate-packets",
      ),
      { capabilityId: "completion-for-acceptance", mode: "direct" },
      { capabilityId: "generate-packets", mode: "direct" },
    ]);
    seedTask("review");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Delivery stalled — needs a human",
        options: [{ kind: "block_on_policy", title: "Update the credential policy" }],
      },
      authority("full"),
    );
    expect(task().frontmatter.readiness).toBe("blocked");
    expect(task().frontmatter.validation).not.toBe("failing"); // the point of F7-VAL1

    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(r.outcome).toBe("noop");
    expect(task().frontmatter.stage).toBe("review"); // NOT moved to Done
    expect(task().packet?.type).toBe("blocked"); // decision still open
  });

  it("full autonomy + RECOMMEND only recommends — it does NOT auto-close (Q1)", async () => {
    // The shipped default operator holds completion-for-acceptance:recommend.
    // Under full autonomy that must NOT silently promote to an agent-close.
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(r.outcome).toBe("recommended");
    expect(task().frontmatter.stage).toBe("review");
    expect(
      task().frontmatter.recommendations.some((rec) => rec.kind === "accept_completion"),
    ).toBe(true);
  });
});

describe("operatorOpenPacket (decision/blocking packet generator)", () => {
  const OPTIONS = [
    { kind: "redirect" as const, title: "Reassign to another developer", recommended: true },
    { kind: "hold_runtime_debug" as const, title: "Hold for runtime debugging" },
  ];

  it("opens a round-trippable input packet, sets waiting=human, notifies supervisors", async () => {
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const res = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Implementation stalled — pick a recovery path",
        body: "The developer has reported no forward progress for three cycles.",
        observations: [{ k: "Branch", v: "vib-1-impl", code: true }],
        options: OPTIONS,
      },
      authority("supervised"),
    );
    expect(res.outcome).toBe("done");

    const p = task().packet!;
    expect(p).not.toBeNull();
    expect(p.type).toBe("input");
    expect(p.title).toBe("Implementation stalled — pick a recovery path");
    expect(p.options).toHaveLength(2);
    // Exactly one recommended option (the parser requires it).
    expect(p.options.filter((o) => o.rec)).toHaveLength(1);
    expect(p.options[0]!.kind).toBe("redirect");
    expect(task().frontmatter.waiting).toBe("human");
    // Supervisors (owner arda + maintainer murat) get a `packet` notification.
    const packets = (userId: string) =>
      listNotifications(store.db, userId).filter((n) => n.kind === "packet");
    expect(packets(store.users.arda.id).length).toBeGreaterThanOrEqual(1);
    expect(packets(store.users.murat.id).length).toBeGreaterThanOrEqual(1);
    // The audit trail records it.
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "task.operator.packet_opened",
    );
  });

  it("operatorResolvePacket withdraws a moot packet: cleared, blocked readiness lifted, timeline notes why", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("triage");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Scope needed before Triage → Ready",
        options: [{ kind: "request_edit", title: "Human refines the goal" }],
      },
      authority("supervised"),
    );
    expect(task().packet).not.toBeNull();
    expect(task().frontmatter.readiness).toBe("blocked");

    const res = await operatorResolvePacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        reason: "the goal now specifies scope + acceptance criteria",
      },
      authority("supervised"),
    );
    expect(res.outcome).toBe("done");
    expect(task().packet).toBeNull();
    // The packet's own block lifts with it.
    expect(task().frontmatter.readiness).toBe("ready");
    expect(task().timeline[0]!.text).toContain("Packet withdrawn");
    expect(task().timeline[0]!.text).toContain("scope + acceptance criteria");
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "task.operator.packet_withdrawn",
    );
  });

  it("operatorResolvePacket is a noop with no open packet and denied without generate-packets", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    const noop = await operatorResolvePacket(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(noop.outcome).toBe("noop");

    deployRoster([{ capabilityId: "append-typed-events", mode: "direct" }]);
    const denied = await operatorResolvePacket(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(denied.outcome).toBe("denied");
  });

  it("a blocked packet also marks the task blocked", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Blocked on a missing credential",
        options: [{ kind: "block_on_policy", title: "Update the credential policy" }],
      },
      authority("supervised"),
    );
    expect(task().frontmatter.readiness).toBe("blocked");
    expect(task().frontmatter.waiting).toBe("human");
    expect(task().packet!.type).toBe("blocked");
    // A missing `recommended` flag defaults to the first option.
    expect(task().packet!.options[0]!.rec).toBe(true);
    // Emits a typed `blocked` timeline event, not a plain comment.
    expect(task().timeline[0]!.type).toBe("blocked");
    // F7-VAL1: a blocked packet marks readiness, NOT validation — `validation`
    // is review health (only a reviewer verdict / acceptance owns it). It used
    // to set validation="failing", which bricked acceptance with a "review is
    // failing" 409 even when no review had ever run.
    expect(task().frontmatter.validation).not.toBe("failing");
  });

  it("is withheld when generate-packets is off (capability gate)", async () => {
    deployRoster([{ capabilityId: "append-typed-events", mode: "direct" }]);
    seedTask("impl");
    const res = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Should not open",
        options: OPTIONS,
      },
      authority("supervised"),
    );
    expect(res.outcome).toBe("denied");
    expect(task().packet).toBeNull();
  });

  it("rejects an unknown option kind", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    const res = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Bad option",
        // @ts-expect-error deliberately invalid kind
        options: [{ kind: "not_a_real_kind", title: "x" }],
      },
      authority("supervised"),
    );
    expect(res.outcome).toBe("denied");
    expect(task().packet).toBeNull();
  });
});

describe("applyRecommendation / dismissRecommendation", () => {
  async function seedRecommendation() {
    deployRoster([
      { capabilityId: "assign-primary-specialist", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    return task().frontmatter.recommendations[0]!.id;
  }

  it("applying a recommendation executes the action and clears it", async () => {
    const recId = await seedRecommendation();
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    const res = await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId },
      actor,
      { dataRoot: store.dataRoot },
    );
    expect(res.label).toContain("Dev");
    // The recommended assignment was performed…
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    // …and the recommendation card was cleared.
    expect(task().frontmatter.recommendations).toHaveLength(0);
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.recommendation.applied");
  });

  it("a stage transition clears stale transition recommendations", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    // Supervised operator recommends moving to review (impl→review is an
    // `approval` boundary, so it produces a transition card).
    await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("supervised"),
    );
    expect(task().frontmatter.recommendations.some((r) => r.kind === "transition")).toBe(true);
    // A human then performs the transition — the stale card must clear.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.recommendations.some((r) => r.kind === "transition")).toBe(false);
  });

  it("applying an accept-completion recommendation moves the task to Done", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    // Supervised operator recommends acceptance (adds an accept_completion card).
    await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    const rec = task().frontmatter.recommendations.find(
      (r) => r.kind === "accept_completion",
    )!;
    expect(rec).toBeDefined();
    // A maintainer applies it → the task is accepted into Done.
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: rec.id },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.stage).toBe("done");
    expect(task().frontmatter.waiting).toBe("none");
    expect(task().frontmatter.recommendations).toHaveLength(0);
  });

  it("dismissing a recommendation clears it without acting", async () => {
    const recId = await seedRecommendation();
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    await dismissRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId },
      actor,
      { dataRoot: store.dataRoot },
    );
    expect(deliveringEngagement(task().frontmatter)).toBeNull(); // NOT assigned
    expect(task().frontmatter.recommendations).toHaveLength(0);
  });

  it("a supervised recommendation notifies the owner + maintainers, not other members", async () => {
    await seedRecommendation(); // seedTask owner = arda (admin); murat = maintainer
    const approvals = (userId: string) =>
      listNotifications(store.db, userId).filter((n) => n.kind === "approval");
    // Owner/admin and the maintainer get a "Waiting on you" ping…
    expect(approvals(store.users.arda.id).length).toBeGreaterThanOrEqual(1);
    expect(approvals(store.users.murat.id).length).toBeGreaterThanOrEqual(1);
    // …a contributor and a viewer do not (not task supervisors).
    expect(approvals(store.users.selin.id)).toHaveLength(0);
    expect(approvals(store.users.elif.id)).toHaveLength(0);
  });

  it("a re-running operator does not re-notify the same pending recommendation", async () => {
    await seedRecommendation();
    const before = listNotifications(store.db, store.users.murat.id).filter(
      (n) => n.kind === "approval",
    ).length;
    // Re-issue the identical recommendation (idempotent card → no new ping).
    await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    const after = listNotifications(store.db, store.users.murat.id).filter(
      (n) => n.kind === "approval",
    ).length;
    expect(after).toBe(before);
  });

  it("only admin|maintainer may dismiss a recommendation", async () => {
    const recId = await seedRecommendation();
    await expect(
      dismissRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId },
        { userId: store.users.selin.id, label: store.users.selin.email }, // contributor
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("auto-invoke on task creation", () => {
  it("creating a task runs the operator, which picks it up", async () => {
    deployRoster(DEFAULT_POLICY);
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Fresh task for the operator" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    // The auto-invoke is fire-and-forget; poll until the operator run has both
    // appeared AND finished (so its sink doesn't finalize after DB teardown).
    const key = created.key;
    let opDone = false;
    for (let i = 0; i < 120 && !opDone; i++) {
      const op = listRunsForTask(store.db, store.slug, key).find((r) => r.op);
      opDone = !!op && op.lifecycle !== "running" && op.lifecycle !== "queued";
      if (!opDone) await new Promise((r) => setTimeout(r, 25));
    }

    expect(opDone).toBe(true); // an operator run streamed for the task and finished
    // Post-D2: the pre-work boundaries (triage→ready, ready→impl) are both
    // `auto`, so a fresh well-scoped task is advanced by the operator all the
    // way to the work stage, where it assigns + prompts the specialist — no
    // human approval needed until impl→review.
    const t = readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;
    expect(t.frontmatter.stage).toBe("impl");
    expect(deliveringEngagement(t.frontmatter)?.profileId).toBe("developer");
    interruptRunningRuns(key);
  });

  it("prompts the specialist by @mention when a task is created at the work stage", async () => {
    deployRoster(DEFAULT_POLICY);
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Work-stage task", stageId: "impl" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const key = created.key;
    let opDone = false;
    for (let i = 0; i < 160 && !opDone; i++) {
      const op = listRunsForTask(store.db, store.slug, key).find((r) => r.op);
      opDone = !!op && op.lifecycle !== "running" && op.lifecycle !== "queued";
      if (!opDone) await new Promise((r) => setTimeout(r, 25));
    }
    expect(opDone).toBe(true);
    const t = readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;
    // The operator assigned the specialist and prompted it with an @mention.
    expect(deliveringEngagement(t.frontmatter)?.profileId).toBe("developer");
    const prompt = t.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt?.text.startsWith("@")).toBe(true);
    interruptRunningRuns(key);
  });

  it("is a no-op when no operator is deployed (project unchanged)", async () => {
    // Default test store project has agents: [] — no operator deployed.
    const created = await createTask(
      store.db,
      { projectSlug: store.slug, title: "No operator here" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    await new Promise((r) => setTimeout(r, 60));
    const t = readTaskFile({ projectSlug: store.slug, taskKey: created.key, dataRoot: store.dataRoot })!.parsed;
    expect(deliveringEngagement(t.frontmatter)).toBeNull();
    expect(listRunsForTask(store.db, store.slug, created.key)).toHaveLength(0);
  });
});

describe("operatorPostComment", () => {
  it("posts an operator-authored comment", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", text: "On it." },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    const top = task().timeline[0]!;
    expect(top.type).toBe("comment");
    expect(top.actor.kind).toBe("operator");
    expect(top.text).toContain("On it.");
  });
});
