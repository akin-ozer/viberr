import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  configureRunServiceForTests,
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { listAuditEvents } from "~/server/audit/audit-recorder.server";
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
  operatorPostComment,
  operatorPromptReviewer,
  operatorPromptSpecialist,
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

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
  configureRunServiceForTests();
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
    expect(task().frontmatter.specialist?.profileId).toBe("developer");
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
    expect(task().frontmatter.specialist).toBeNull();
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
    expect(task().frontmatter.specialist).toBeNull();
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
    expect(task().frontmatter.reviewers.map((x) => x.profileId)).toContain("reviewer");
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
    expect(task().frontmatter.specialist?.profileId).toBe("developer");
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
    expect(task().frontmatter.specialist).toBeNull();
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
    expect(task().frontmatter.reviewers.map((x) => x.profileId)).toContain("reviewer");
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
    expect(task().frontmatter.reviewers.map((x) => x.profileId)).toContain("reviewer");
    interruptRunningRuns("VIB-1");
  });
});

describe("operatorTransitionStage", () => {
  it("supervised + recommend mode recommends and does not move", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("triage");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(task().frontmatter.stage).toBe("triage");
    expect(task().frontmatter.waiting).toBe("human");
  });

  it("full autonomy moves the task across the boundary as the operator", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("triage");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("ready");
    // The transition event is attributed to the operator, not a human.
    expect(task().timeline.some((e) => e.type === "transition" && e.actor.kind === "operator")).toBe(true);
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
    expect(task().frontmatter.specialist?.profileId).toBe("developer");
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
  it("supervised opens a completion packet for a human (never moves to Done)", async () => {
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
    expect(task().packet?.options.some((o) => o.kind === "accept_completion")).toBe(true);
  });

  it("full autonomy accepts completion and moves the task to Done", async () => {
    deployRoster(DEFAULT_POLICY);
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
    // The deliberate override is audited distinctly.
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.operator.accepted_completion");
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
    expect(task().frontmatter.specialist?.profileId).toBe("developer");
    // …and the recommendation card was cleared.
    expect(task().frontmatter.recommendations).toHaveLength(0);
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.recommendation.applied");
  });

  it("a stage transition clears stale transition recommendations", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("triage");
    // Supervised operator recommends moving to ready (adds a transition card).
    await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      authority("supervised"),
    );
    expect(task().frontmatter.recommendations.some((r) => r.kind === "transition")).toBe(true);
    // A human then performs the transition — the stale card must clear.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.stage).toBe("ready");
    expect(task().frontmatter.recommendations.some((r) => r.kind === "transition")).toBe(false);
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
    expect(task().frontmatter.specialist).toBeNull(); // NOT assigned
    expect(task().frontmatter.recommendations).toHaveLength(0);
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
    // A fresh task is created at the first (pre-work) stage, so the operator
    // coordinates by advancing it toward the work stage — under supervised
    // autonomy that is a transition recommendation, not a specialist assignment.
    const t = readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;
    expect(t.frontmatter.recommendations.some((r) => r.kind === "transition")).toBe(true);
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
    expect(t.frontmatter.specialist?.profileId).toBe("developer");
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
    expect(t.frontmatter.specialist).toBeNull();
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
