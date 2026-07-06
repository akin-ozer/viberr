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
    // …and the operator assigned a primary specialist while coordinating it.
    const t = readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;
    expect(t.frontmatter.specialist).not.toBeNull();
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
