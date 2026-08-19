import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
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
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import { listAuditEvents } from "../../../test-support/audit-log";
import { listNotifications } from "~/server/projections/notifications.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  RECOMMENDATION_DECLINED_TITLE,
  applyRecommendation,
  createTask,
  dismissRecommendation,
  transitionStage,
  type TaskActionContext,
} from "./task-actions.server";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import {
  AUTONOMY_CLAMPED_AUDIT_ACTION,
  clampAutonomy,
  deliverGate,
  gate,
  operatorAcceptCompletion,
  operatorAssignReviewer,
  operatorAssignSpecialist,
  operatorDeliverForReview,
  operatorEngageAgent,
  operatorOpenPacket,
  operatorPostComment,
  operatorSetGoal,
  operatorResolvePacket,
  operatorPromptReviewer,
  operatorPromptSpecialist,
  operatorRunAgent,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorSnapshot,
  operatorTransitionStage,
  operatorAutonomyFor,
  operatorBackendFor,
  resolveOperatorAuthority,
  type OperatorAutonomy,
} from "./operator-actions.server";

/**
 * The operator's capability-GATED, operator-authorized actions: the RBAC the
 * operator toolkit enforces. Fake adapter only (no real backend keys).
 */

let ctx: TestDbContext;
let store: TestStore;

/**
 * Deploy the operator (with a policy) + a dev specialist + a reviewer.
 *
 * R19-A: the operator's CONFIGURED autonomy is the ceiling for every run, so it
 * is part of the fixture now. It defaults to `full` because the tests below
 * assert what a project that ALLOWS full autonomy does — before the clamp, a
 * per-run override alone conjured that power on a project configured
 * `supervised`, which is exactly what R19-A forbids. The clamp's own tests pass
 * `"supervised"` explicitly.
 */
function deployRoster(
  operatorPolicy: { capabilityId: string; mode: CapabilityMode }[],
  configuredAutonomy: OperatorAutonomy = "full",
): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: operatorPolicy,
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: ["claude"],
          model: "sonnet",
          autonomy: configuredAutonomy,
        },
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
    ],
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
  installFakeRuntime();
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
  it("finds the deployed operator + its policy, and honors an autonomy override WITHIN the ceiling", () => {
    deployRoster(DEFAULT_POLICY); // configured: full
    const a = authority("full");
    expect(a.deployed).toBe(true);
    expect(a.autonomy).toBe("full");
    expect(a.configuredAutonomy).toBe("full");
    expect(a.autonomyClampedFrom).toBeNull();
    expect(a.policy.get("assign-primary-specialist")).toBe("direct");
    expect(a.policy.get("stage-transitions")).toBe("recommend");
  });
});

/**
 * R19-A (owner ruling, pass 19) — **a run may never exceed the project's
 * configured autonomy.** The old assertion here (`"honors autonomy override"`,
 * unqualified) pinned the defect: on a project whose operator is deployed
 * `supervised`, any maintainer could launch ONE turn at `full` and promote every
 * `recommend` capability to direct execution, with no confirm and no audit row.
 * Lowering for a single run is still allowed — this is a CEILING, not a pin.
 */
describe("R19-A — per-run autonomy is clamped to project policy", () => {
  it("clampAutonomy is a ceiling: it caps a raise, passes a lowering through", () => {
    expect(clampAutonomy("full", "supervised")).toEqual({
      autonomy: "supervised",
      clampedFrom: "full",
    });
    expect(clampAutonomy("supervised", "full")).toEqual({
      autonomy: "supervised",
      clampedFrom: null,
    });
    expect(clampAutonomy("full", "full")).toEqual({
      autonomy: "full",
      clampedFrom: null,
    });
    // No override at all = run at the configured level; not a clamp.
    expect(clampAutonomy(undefined, "supervised")).toEqual({
      autonomy: "supervised",
      clampedFrom: null,
    });
    expect(clampAutonomy(undefined, "full")).toEqual({
      autonomy: "full",
      clampedFrom: null,
    });
  });

  it("a run asking for full on a SUPERVISED project runs supervised", () => {
    deployRoster(DEFAULT_POLICY, "supervised");
    const a = authority("full");
    expect(a.configuredAutonomy).toBe("supervised");
    expect(a.autonomy).toBe("supervised");
    expect(a.autonomyClampedFrom).toBe("full");
  });

  it("the clamp actually withholds the power: recommend is NOT promoted to direct", () => {
    deployRoster(DEFAULT_POLICY, "supervised");
    // `stage-transitions` is deployed `recommend`. Before the clamp, a run
    // launched at "full" executed it directly with no human gate.
    expect(gate(authority("full"), "stage-transitions")).toBe("recommend");
    expect(gate(authority("full"), "assign-primary-specialist")).toBe("direct");
    // The same project configured `full` DOES promote it — proving the clamp,
    // not the gate, is what changed.
    deployRoster(DEFAULT_POLICY, "full");
    expect(gate(authority("full"), "stage-transitions")).toBe("direct");
  });

  it("lowering autonomy for one run stays allowed on a full-autonomy project", () => {
    deployRoster(DEFAULT_POLICY, "full");
    const a = authority("supervised");
    expect(a.autonomy).toBe("supervised");
    expect(a.autonomyClampedFrom).toBeNull();
    expect(gate(a, "stage-transitions")).toBe("recommend");
  });

  it("audits the clamp WHEN IT BITES, naming what was asked for and what ran", () => {
    deployRoster(DEFAULT_POLICY, "supervised");
    const actor = { userId: store.users.arda.id, label: "arda@viberr.dev" };
    resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
      autonomy: "full",
      db: store.db,
      taskKey: "VIB-1",
      actor,
    });
    const rows = listAuditEvents(store.db, { action: AUTONOMY_CLAMPED_AUDIT_ACTION });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorLabel).toBe("arda@viberr.dev");
    expect(rows[0]!.projectSlug).toBe(store.slug);
    expect(rows[0]!.taskKey).toBe("VIB-1");
    expect(rows[0]!.details).toMatchObject({ requested: "full", ranAt: "supervised" });
  });

  it("records NOTHING when the clamp does not bite, or on a read path with no db", () => {
    deployRoster(DEFAULT_POLICY, "full");
    resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
      autonomy: "full",
      db: store.db,
      taskKey: "VIB-1",
    });
    expect(listAuditEvents(store.db, { action: AUTONOMY_CLAMPED_AUDIT_ACTION })).toHaveLength(0);
    // A pure READ (loader paths resolve authority too) must never write audit
    // rows, even when the requested autonomy is above the ceiling.
    deployRoster(DEFAULT_POLICY, "supervised");
    authority("full");
    expect(listAuditEvents(store.db, { action: AUTONOMY_CLAMPED_AUDIT_ACTION })).toHaveLength(0);
  });

  it("an UNDEPLOYED operator reports the supervised ceiling rather than a phantom full", () => {
    // No roster written at all — no operator deployed.
    const a = resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
      autonomy: "full",
    });
    expect(a.deployed).toBe(false);
    expect(a.autonomy).toBe("supervised");
    expect(a.configuredAutonomy).toBe("supervised");
    expect(a.autonomyClampedFrom).toBe("full");
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

describe("operatorAutonomyFor (R19-A — the run picker's ceiling)", () => {
  it("returns the operator deployment's configured autonomy", () => {
    deployRoster(DEFAULT_POLICY, "supervised");
    expect(operatorAutonomyFor({ dataRoot: store.dataRoot }, store.slug)).toBe(
      "supervised",
    );
    deployRoster(DEFAULT_POLICY, "full");
    expect(operatorAutonomyFor({ dataRoot: store.dataRoot }, store.slug)).toBe("full");
  });
  it("defaults to supervised when no operator is deployed or the project is unknown", () => {
    expect(operatorAutonomyFor({ dataRoot: store.dataRoot }, store.slug)).toBe(
      "supervised",
    );
    expect(operatorAutonomyFor({ dataRoot: store.dataRoot }, "nope")).toBe("supervised");
  });
});

describe("operatorBackendFor (P11-76 — run-picker default)", () => {
  it("returns the operator deployment's configured backend", () => {
    deployRoster(DEFAULT_POLICY); // definition backends [claude]
    expect(operatorBackendFor({ dataRoot: store.dataRoot }, store.slug)).toBe("claude");
  });
  it("defaults to claude for an unknown project (no operator deployed)", () => {
    expect(operatorBackendFor({ dataRoot: store.dataRoot }, "ghost-project")).toBe(
      "claude",
    );
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
    // `noop`, not `denied`: the operator HELD `append-typed-events` — the
    // task's state (a goal that is already specified) is what ruled it out.
    // The plan narration files the two apart, so a state conflict returned as
    // `denied` accuses the project's policy of a block it never made.
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("already specified");
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

  it("F19-12: the rendered card and message use ENGAGEMENT vocabulary, never 'primary specialist'", async () => {
    // D9/Q17-5 retired the primary/consultant model for `engagements[]` with one
    // `delivers: true`. The capability ID keeps its historical name; the copy
    // this module renders must not.
    deployRoster([
      { capabilityId: "assign-primary-specialist", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorAssignSpecialist(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.message).toBe("Recommended engaging Dev as the delivering agent.");
    const rec = task().frontmatter.recommendations[0]!;
    expect(rec.label).toBe("Engage Dev as the delivering agent");
    // The retired phrase appears nowhere the human reads: card, message, or the
    // operator comment the card's reasoning writes to the timeline.
    const rendered = [
      r.message,
      rec.label,
      rec.detail,
      ...task().timeline.map((e) => e.text),
    ].join("\n");
    expect(rendered).not.toMatch(/primary specialist/i);
  });

  /** The routing trace `traceAgentSelection` records, as this test reads it. */
  type AgentSelectionTrace = {
    chosen: string;
    delivers: boolean;
    reason: string | null;
    candidates: { profileId: string; chosen: boolean; eligibleForStage: boolean }[];
  };

  it("F10-35: records a routing trace — candidates considered, chosen, reason", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorEngageAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        delivers: true,
        reason: "Dev fits the impl stage.",
      },
      authority("full"),
    );
    const trace = listAuditEvents(store.db, {
      action: "task.operator.agent_selected",
    })[0];
    expect(trace).toBeTruthy();
    // SAFETY: `task.operator.agent_selected` has ONE writer (traceAgentSelection
    // in operator-actions.server.ts), and it records exactly these four fields —
    // `candidates` straight off the deployed-specialist map.
    const d = trace!.details as AgentSelectionTrace;
    expect(d.chosen).toBe("developer");
    expect(d.delivers).toBe(true);
    expect(d.reason).toBe("Dev fits the impl stage.");
    // Every deployed specialist is recorded as a considered candidate, exactly
    // one marked chosen — a deterministic, auditable trace (not a free-text blob).
    expect(d.candidates.length).toBeGreaterThan(0);
    expect(d.candidates.filter((c) => c.chosen).map((c) => c.profileId)).toEqual([
      "developer",
    ]);
    expect(
      d.candidates.find((c) => c.profileId === "developer")?.eligibleForStage,
    ).toBe(true);
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

describe("operatorRunAgent — delivering profileId guard (P11-22)", () => {
  it("refuses a delivering run for a profileId that is NOT the current deliverer", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    // "reviewer" is not the deliverer ("developer" is) — a delivering run for it
    // must be refused, not silently run as the developer.
    const r = await operatorRunAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer", delivers: true },
      authority("full"),
    );
    // A STATE refusal (who currently delivers), not a withheld capability.
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("not the delivering agent");
  });

  it("allows a delivering run when the profileId IS the current deliverer", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    const r = await operatorRunAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", delivers: true },
      authority("full"),
    );
    expect(r.outcome).not.toBe("denied");
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

describe("operator transition chain (P11-70 runaway backstop)", () => {
  it("human transitions restart the chain at 0; operator ones extend the drive's depth", async () => {
    const { nextTransitionChainDepth, OPERATOR_TRANSITION_CHAIN_CAP } = await import(
      "./task-actions.server"
    );
    expect(nextTransitionChainDepth({})).toBe(0); // human-authored
    expect(nextTransitionChainDepth({ operatorAuthorized: true })).toBe(1); // first link
    const drive = (transitionDepth: number) => ({
      operatorAuthorized: true,
      operatorRun: {
        backend: "claude" as const,
        autonomy: "supervised" as const,
        reactDepth: 0,
        transitionDepth,
      },
    });
    expect(nextTransitionChainDepth(drive(0))).toBe(1);
    expect(nextTransitionChainDepth(drive(3))).toBe(4);
    expect(nextTransitionChainDepth(drive(OPERATOR_TRANSITION_CHAIN_CAP - 1))).toBe(
      OPERATOR_TRANSITION_CHAIN_CAP,
    );
  });

  it("at the cap, the transition lands but coordination pauses on a stuck-loop packet", async () => {
    deployRoster([...DEFAULT_POLICY, { capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("triage");
    const { OPERATOR_TASK_ACTOR, OPERATOR_TRANSITION_CHAIN_CAP } = await import(
      "./task-actions.server"
    );
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      OPERATOR_TASK_ACTOR,
      {
        dataRoot: store.dataRoot,
        operatorAuthorized: true,
        operatorRun: {
          backend: "claude",
          autonomy: "supervised",
          reactDepth: 0,
          transitionDepth: OPERATOR_TRANSITION_CHAIN_CAP - 1,
        },
      },
    );
    const t = task();
    expect(t.frontmatter.stage).toBe("ready"); // the move itself still lands
    expect(t.packet).toBeTruthy(); // …but the next hop is a human packet, not another run
    expect(t.packet!.type).toBe("blocked");
    expect(t.packet!.body).toContain("coordination loop");
    // No follow-up operator run was auto-invoked.
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);
  });

  it("below the cap, the transition re-triggers coordination and opens no packet", async () => {
    deployRoster([...DEFAULT_POLICY, { capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("triage");
    const { OPERATOR_TASK_ACTOR } = await import("./task-actions.server");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      OPERATOR_TASK_ACTOR,
      {
        dataRoot: store.dataRoot,
        operatorAuthorized: true,
        operatorRun: {
          backend: "claude",
          autonomy: "supervised",
          reactDepth: 0,
          transitionDepth: 0,
        },
      },
    );
    expect(task().packet).toBeFalsy();
    // Let the fire-and-forget auto-invoke settle, then clean up its fake run.
    await new Promise((r) => setTimeout(r, 50));
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
    // The second call coalesced — it says so with `queued`, not a new run.
    expect(r2.queued).toBe(true);
    // B10: it must NEVER invent a run id. The first drive has not written its
    // run row yet in this window, so there is nothing to name — this used to
    // return the literal string "queued", which `appendComment`'s @operator
    // path passed straight into `resolveReplyLogThread` as if it were an id.
    expect(r2.runId).toBeNull();
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

  /**
   * B10, consumer side. The nullable `runId` is a TYPE contract — the compiler
   * is its canary (`resolveReplyLogThread` declared `runId: string` and was
   * handed the literal "queued"). What is observable is the other half of the
   * same rule: a queued trigger reports the run it is queued BEHIND, and every
   * id that leaves `runOperator` resolves to a real row.
   */
  it("an @operator comment queued behind a live drive names that live run, never a synthetic id", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { resetOperatorLeasesForTests, runOperator } = await import(
      "~/server/runtimes/operator-run.server"
    );
    resetOperatorLeasesForTests();
    const inFlight = runOperator(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      trigger: "transition",
      autonomy: "supervised",
      dataRoot: store.dataRoot,
    });

    const { commentToAgent } = await import("./task-actions.server");
    const res = await commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@operator what is holding this up?",
      },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(res.triggered).toBe("started");
    // The comment was answered by queueing behind the live drive, and the log
    // thread it reports is that drive's REAL thread — the literal "queued"
    // resolved to nothing and silently produced a null here instead.
    const live = listRunsForTask(store.db, store.slug, "VIB-1").find(
      (r) => r.kind === "operator",
    )!;
    expect(live).toBeDefined();
    expect(res.logThreadId).toBe(live.id);

    await inFlight;
    await new Promise((r) => setTimeout(r, 50));
    interruptRunningRuns("VIB-1");
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

  /**
   * F19-26 — a transition whose TARGET is the terminal stage IS an acceptance.
   *
   * A supervised operator calling transition_stage("done") used to file a plain
   * "Move the task to Done" card whose Apply runs the full acceptance contract
   * (a real, irreversible PR merge) under a label that never says "accept" or
   * "merge" — a third route to Done that the accept-completion fixes would not
   * have covered. Gate on the TARGET, not the tool.
   */
  it("F19-26: a supervised transition to the TERMINAL stage produces an ACCEPTANCE card, not a disguised move", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(r.message).toMatch(/accepting completion/i);
    expect(task().frontmatter.stage).toBe("review");
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("accept_completion");
    // The card names what Apply really does — accept, and merge the PR.
    expect(recs[0]!.label).toMatch(/^Accept completion/);
    expect(recs[0]!.label).toContain("Done");
    expect(recs[0]!.detail).toMatch(/Accepting completion moves/i);
    expect(recs[0]!.detail).toMatch(/merges the review PR/i);
    // The pre-fix harm, gone from every string the human reads: a bland move
    // that never says "accept" or "merge" over an irreversible merge.
    const rendered = [r.message, recs[0]!.label, recs[0]!.detail].join("\n");
    expect(rendered).not.toMatch(/Recommended moving the task to Done/i);
    expect(rendered).not.toMatch(/ready to advance to Done/i);
    // …and it is recorded as a completion recommendation, not a bare transition.
    expect(
      listAuditEvents(store.db, { action: "task.operator.recommended_completion" }),
    ).toHaveLength(1);
  });

  /**
   * R19-6 — the capability LEAK the F19-26 reroute opened, proven live this
   * pass by cluster B's verifier.
   *
   * `operatorTransitionStage` gates only on `stage-transitions`. With
   * `stage-transitions: recommend` + `completion-for-acceptance: off` — the
   * mode the schema documents as "withheld entirely (the tool is not even
   * offered)" — a probe got back a real `accept_completion` recommendation card
   * AND a `task.operator.recommended_completion` audit row, because the
   * delegated `operatorAcceptCompletion` had no withheld-mode guard of its own.
   * The acceptance capability now answers on this path too.
   */
  it("R19-6: a terminal-target transition is refused when completion-for-acceptance is OFF — no card, no audit row", async () => {
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "off" },
    ]);
    seedTask("review");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("denied");
    expect(r.message).toMatch(/not permitted for the operator here/i);
    expect(task().frontmatter.stage).toBe("review");
    // Neither the acceptance card the reroute would file NOR the plain
    // "Move the task to Done" card the reroute replaced.
    expect(task().frontmatter.recommendations).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.operator.recommended_completion" }),
    ).toHaveLength(0);
  });

  it("F19-26: a terminal-target transition from a PRE-BOUNDARY stage is refused out loud, with no card", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("noop");
    // The shared acceptance gate speaks: the task is not at the boundary.
    expect(r.message).toMatch(/In Progress, not Review/);
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.recommendations).toHaveLength(0);
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
      // F19-39: the refusal used to say "No governed boundary" — a BANNED word
      // in copy a human reads. The pin follows the corrected string.
    ).rejects.toThrow(/no allowed transition/i);
    expect(task().frontmatter.stage).toBe("review");
  });
});

describe("auto-invoke on stage transition", () => {
  const arda = () => ({ userId: store.users.arda.id, label: store.users.arda.email });

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
    // P14-LV-02: DERIVED, not asserted. This fixture has no reviewer and no
    // revision, so nothing validated the work — and the record has to say that.
    // It used to be hardcoded `"healthy"`, which put a green pill on an empty
    // review record whenever an autonomous operator closed a task.
    expect(task().frontmatter.validation).toBe("none");
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.operator.accepted_completion");
  });

  it("reports validation HEALTHY when a required reviewer really approved the revision", async () => {
    // The other half of the derivation: real review evidence still reads healthy,
    // so the honest version is not just "always none".
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "direct" },
    ]);
    seedTask("review");
    const head = "a".repeat(40);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...task().frontmatter,
        // R15-1: delivered work needs its review PR to be acceptable.
        pr: { number: 7, state: "review" as const, title: "[VIB-1] Operator drive" },
        workRevision: {
          id: "rev_1",
          headSha: head,
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-07-25T09:00:00.000Z",
          sourceProfileId: "dev",
        },
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: head,
            result: "approve" as const,
            reason: "looks right",
            at: "2026-07-25T09:30:00.000Z",
          },
        ],
      },
      goal: "g",
      timeline: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(task().frontmatter.validation).toBe("healthy");
  });

  it("U3: a task that went Done during the accept is a NOOP — no second audit row", async () => {
    // `applyAcceptanceWrite` re-checks "already Done" INSIDE the write lock and
    // reports it (`accepted: false`); this caller ignored the answer, so a human
    // acceptance landing while the operator was verifying the PR head left a
    // `task.operator.accepted_completion` row and a "moved to Done" message for
    // a write the operator never made — two records of one acceptance, the
    // second one attributed to an agent. CANARY: drop the `if (!accepted)`
    // return.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "direct" },
    ]);
    // deployRoster clears the project's repo; the race below rides the ONE
    // remote read this path makes (the PR-head verification), so it needs a repo
    // and a credential to reach GitHub at all.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      repo: "akin-ozer/viberr",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const patActor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    const pat = createPat(
      store.db,
      { ...patActor, label: "bot", token: "ghp_operatornoop01" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );

    seedTask("review");
    const head = "a".repeat(40);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...task().frontmatter,
        pr: { number: 7, state: "review" as const, title: "[VIB-1] work" },
        branch: "vib-1-work",
        workRevision: {
          id: "rev_1",
          headSha: head,
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-08-19T09:00:00.000Z",
          sourceProfileId: "developer",
        },
        // R15-1: delivered work needs an approving verdict, or the gate refuses
        // before the write this test is about is ever reached.
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: head,
            result: "approve" as const,
            reason: "looks right",
            at: "2026-08-19T09:30:00.000Z",
          },
        ],
        validation: "healthy" as const,
      },
      goal: "g",
      timeline: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // The human acceptance lands mid-verification: after the operator's own
    // already-Done read (which is OUTSIDE the lock, and therefore a guess) and
    // before the write lock is taken.
    const humanCompletion = {
      occurredAt: "2026-08-19T10:00:00.000Z",
      type: "completion" as const,
      actor: {
        kind: "human" as const,
        userId: store.users.arda.id,
        nameHint: "Arda",
      },
      title: "Completion accepted",
      text: "Human acceptance recorded — the human got there first.",
      toAgent: false,
      evidence: null,
    };
    const github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/pulls/7": () => {
        writeTask(store.dataRoot, store.slug, {
          frontmatter: {
            ...task().frontmatter,
            stage: "done",
            readiness: "ready",
            waiting: "none",
          },
          goal: "g",
          timeline: [humanCompletion],
        });
        return { body: { head: { sha: head } } };
      },
    });

    const ctxWithGithub: TaskActionContext = {
      dataRoot: store.dataRoot,
      fetchImpl: github.fetchImpl,
    };
    const r = await operatorAcceptCompletion(
      store.db,
      ctxWithGithub,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );

    expect(github.callsTo("GET /repos/akin-ozer/viberr/pulls/7")).toHaveLength(1);
    expect(r.outcome).toBe("noop");
    expect(r.message).toMatch(/already Done/i);
    // The human's completion stands alone — no operator event written over it.
    expect(
      task().timeline.filter((e) => e.type === "completion"),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "task.operator.accepted_completion" }),
    ).toHaveLength(0);
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

  /**
   * R19-6 (owner ruling 2026-08-06) — a capability set to `off` is a HARD
   * REFUSE by every route: no recommendation card, no audit row, and the
   * operator says so out loud instead of silently rerouting.
   *
   * The hole this closes: the function's ONLY `gate()` read lived inside the
   * direct/recommend choice (`!== "direct"` ⇒ recommend), so `off` — the mode
   * the schema documents as "withheld entirely (the tool is not even offered)"
   * — fell into the RECOMMEND branch and produced a real `accept_completion`
   * card plus a `task.operator.recommended_completion` audit row.
   */
  it("R19-6: `completion-for-acceptance: off` is a hard refuse — no card, no audit row", async () => {
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "off" },
    ]);
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("denied");
    // Refused OUT LOUD: the sentence names the withholding, so the operator
    // narrates it rather than the run going quiet.
    expect(r.message).toMatch(/withheld from the operator here/i);
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.recommendations).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.operator.recommended_completion" }),
    ).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.operator.accepted_completion" }),
    ).toHaveLength(0);
  });

  it("R19-6: `human` refuses the same way, and says it is reserved for a human", async () => {
    // `human` and `off` are distinct modes (schema: withheld entirely vs.
    // reserved for a human to perform) and both mean "not the operator's to
    // do". A card is not a neutral note — applying one IS the acceptance
    // (ruling 22) — so `human` gets the same hard refuse with its own sentence,
    // matching the Claude toolkit, which builds the `accept_completion` tool for
    // neither mode.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "human" },
    ]);
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(r.outcome).toBe("denied");
    expect(r.message).toMatch(/reserved for a human here/i);
    expect(task().frontmatter.recommendations).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.operator.recommended_completion" }),
    ).toHaveLength(0);
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
    // A malformed step, not a policy refusal — `denied` is reserved for
    // authority so the plan narration can name the real reason.
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("Unknown packet option kind");
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

  // ---------------------------------------------------------------- gap [1]
  // A declined recommendation used to leave NO trace on task.md (only a 90-day
  // audit row nothing reads), and the operator's snapshot carried no
  // recommendations at all — so the supervised loop could spin: propose,
  // decline, re-propose, decline.

  function snapshot() {
    return operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("supervised"),
    );
  }

  it("dismissing a recommendation writes a typed timeline event NAMING what was declined", async () => {
    const recId = await seedRecommendation();
    const label = task().frontmatter.recommendations[0]!.label;
    await dismissRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    // The refusal is on the CANONICAL record, newest-first, attributed to the
    // human who said no — not only in the audit table.
    const event = task().timeline[0]!;
    expect(event.title).toBe(RECOMMENDATION_DECLINED_TITLE);
    expect(event.type).toBe("transition");
    expect(event.actor.kind).toBe("human");
    // It names the recommendation, not "a recommendation".
    expect(event.text).toContain(label);
    expect(event.text).toContain("declined");
    // …and it stays readable without its title, because the operator's own
    // recentTimeline window drops titles.
    expect(snapshot().recentTimeline[0]!.text).toContain(label);
  });

  it("the operator snapshot carries its own PENDING recommendations", async () => {
    await seedRecommendation();
    const pending = snapshot().recommendations!.pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("assign_specialist");
    expect(pending[0]!.profileId).toBe("developer");
    expect(pending[0]!.label).toContain("Dev");
    expect(snapshot().recommendations!.declined).toHaveLength(0);
  });

  it("the operator snapshot carries recently-DECLINED recommendations", async () => {
    const recId = await seedRecommendation();
    const label = task().frontmatter.recommendations[0]!.label;
    await dismissRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const recs = snapshot().recommendations!;
    expect(recs.pending).toHaveLength(0);
    expect(recs.declined).toHaveLength(1);
    expect(recs.declined[0]!.kind).toBe("assign_specialist");
    expect(recs.declined[0]!.label).toBe(label);
    expect(recs.declined[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("the declined list is BOUNDED (the snapshot is embedded in a prompt)", async () => {
    // Seven proposals, each declined — the loop this field exists to stop. The
    // snapshot must not grow with the task's age.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Operator drive",
        recommendations: Array.from({ length: 7 }, (_, i) => ({
          id: `rec-${i}`,
          kind: "transition" as const,
          toStageId: "review",
          label: `Move to Review (proposal ${i})`,
          detail: "",
        })),
      }),
      goal: "Prove the operator drives the task.",
    });
    deployRoster(DEFAULT_POLICY);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(snapshot().recommendations!.pending).toHaveLength(5);
    for (let i = 0; i < 7; i++) {
      await dismissRecommendation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", recId: `rec-${i}` },
        { userId: store.users.arda.id, label: store.users.arda.email },
        { dataRoot: store.dataRoot },
      );
    }
    const recs = snapshot().recommendations!;
    expect(recs.pending).toHaveLength(0);
    expect(recs.declined).toHaveLength(5);
    // …while every one of the seven refusals is on the durable record.
    expect(
      task().timeline.filter((e) => e.title === RECOMMENDATION_DECLINED_TITLE),
    ).toHaveLength(7);
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

  // NEW-4: the operator is instructed to tag the person it answers; the tag
  // must actually notify them (a `mention` row, from the Operator).
  it("an operator comment that @tags a human notifies them, attributed to the Operator", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: `@${store.users.arda.name.split(" ")[0]} summary: developer implemented and reviewer approved — no action needed.`,
      },
      authority("supervised"),
    );
    const notes = listNotifications(store.db, store.users.arda.id).filter(
      (n) => n.kind === "mention",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.from).toMatchObject({ kind: "agent", name: "Operator" });
  });

  /**
   * S5-G3: the B-FD2 ladder drops an ambiguous handle for EVERY caller, but the
   * non-delivery note was planned for human comments only — so the operator,
   * which is explicitly instructed to tag by handle, tagged a name that matched
   * two people and reached nobody, with no trace anywhere. The old behavior was
   * noisy and wrong; this one was silent, which is worse.
   */
  it("an AMBIGUOUS @tag in an operator comment discloses the non-delivery instead of dropping it (S5-G3)", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();
    await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: `@${firstName} the reviewer approved — acceptance is yours.`,
      },
      authority("supervised"),
    );
    const top = task().timeline[0]!;
    expect(top.actor.kind).toBe("operator");
    expect(top.text).toContain(`@${firstName}`);
    expect(top.text).toContain("nobody was notified");
    // …and it really did notify nobody, so the disclosure is the only signal.
    expect(
      listNotifications(store.db, store.users.arda.id).filter(
        (n) => n.kind === "mention",
      ),
    ).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- A4 / B1-B3 */

/** Deploy a roster with NO operator profile — the A4 shape. */
function deployWithoutOperator(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "developer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "Dev",
          role: "Implementation",
          backends: ["claude"],
          model: "sonnet",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

describe("A4 — an UNDEPLOYED operator has no authority at all", () => {
  it("deliverGate DENIES with no operator deployed (absent-means-granted is about old deployments, not no deployment)", () => {
    deployWithoutOperator();
    const a = authority("supervised");
    expect(a.deployed).toBe(false);
    // The board is non-strict (triage → ready is `auto`), which is exactly the
    // shape that used to resolve the ABSENT grant to `direct`.
    expect(a.humanGatedBeforeWork).toBe(false);
    expect(deliverGate(a)).toBe("deny");
    // …and every other capability with it — one rule, one answer.
    expect(gate(a, "generate-packets")).toBe("deny");
    expect(gate(a, "stage-transitions")).toBe("deny");
  });

  it("operatorDeliverForReview refuses to push a branch / open a PR for an undeployed operator", async () => {
    deployWithoutOperator();
    seedTask("impl");
    const res = await operatorDeliverForReview(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(res.outcome).toBe("denied");
    expect(res.message).toContain("not permitted");
  });

  it("a DEPLOYED operator still delivers with the grant absent (the R15-2 polarity is intact)", async () => {
    deployRoster(DEFAULT_POLICY); // no deliver-review-pr entry
    expect(deliverGate(authority("supervised"))).toBe("direct");
  });
});

describe("B1 — an operator-authored retry_other_backend names the OTHER backend", () => {
  const RETRY = [
    { kind: "retry_other_backend" as const, title: "Retry on the other backend", recommended: true },
    { kind: "redirect" as const, title: "Redirect the work" },
  ];

  async function openRetryPacket() {
    return operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "The delivering run failed — pick a recovery path",
        options: RETRY,
      },
      authority("supervised"),
    );
  }

  it("stamps the opposite of the backend the failed AGENT run used (it used to always mean Claude)", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    // The run that just failed ran on Claude — retrying on Claude is retrying
    // the dead backend, which is what `option.backend ?? "claude"` did.
    upsertRun(store.db, {
      id: "run_failed_claude",
      taskKey: "VIB-1",
      projectSlug: store.slug,
      threadId: "t-dev",
      role: "Implementation",
      kind: "primary",
      backend: "claude",
      agentProfileId: "developer",
      model: "sonnet",
      sdk: "Claude Agent SDK",
      state: "error",
    });

    expect((await openRetryPacket()).outcome).toBe("done");
    const retry = task().packet!.options.find((o) => o.kind === "retry_other_backend")!;
    expect(retry.backend).toBe("codex");
    // …and it names the agent whose run failed, so the retry re-runs THAT one.
    expect(retry.profileId).toBe("developer");
  });

  it("falls back to the delivering engagement's backend when no agent run exists yet", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          {
            profileId: "developer",
            backend: "codex",
            role: "Implementation",
            delivers: true,
            verdictCapable: false,
          },
        ],
      }),
      goal: "Ship the parser.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect((await openRetryPacket()).outcome).toBe("done");
    const retry = task().packet!.options.find((o) => o.kind === "retry_other_backend")!;
    expect(retry.backend).toBe("claude");
    expect(retry.profileId).toBe("developer");
  });

  it("an EXPLICIT backend from the operator always wins", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Retry deliberately on Claude",
        options: [
          {
            kind: "retry_other_backend",
            title: "Retry on Claude Code",
            backend: "claude",
            profileId: "reviewer",
            recommended: true,
          },
        ],
      },
      authority("supervised"),
    );
    const retry = task().packet!.options[0]!;
    expect(retry.backend).toBe("claude");
    expect(retry.profileId).toBe("reviewer");
  });
});

describe("B3 — one open decision at a time", () => {
  const OPTION = [{ kind: "request_edit" as const, title: "Send it back" }];

  async function open(title: string) {
    return operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title,
        options: OPTION,
      },
      authority("supervised"),
    );
  }

  it("refuses a SECOND packet instead of replacing the one a human is answering", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    expect((await open("Which endpoint should this target?")).outcome).toBe("done");

    const second = await open("Something else entirely");
    expect(second.outcome).toBe("noop");
    expect(second.message).toContain("already open");
    // The human's packet is untouched — this used to be silently overwritten.
    expect(task().packet!.title).toBe("Which endpoint should this target?");
    // …and no second "Decision packet:" event was written either.
    expect(
      task().timeline.filter((e) => e.text.includes("Something else entirely")),
    ).toHaveLength(0);
  });

  // The pre-read guard alone only orders SEQUENTIAL opens. Two turns that both
  // read the task before either writes (the operator's own coalesce-queue makes
  // this reachable: a queued trigger fires the moment the in-flight run's
  // completion work lands) both saw "no packet" and both wrote — the second
  // silently replacing a question a human might already be answering. The
  // authoritative check has to be INSIDE the locked write, the way the
  // acceptance head gate does it (`assertVerifiedHeadStillApplies`).
  it("refuses the loser of a CONCURRENT open — both passed the pre-read", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");

    // Do NOT await the first: it suspends inside `updateTaskFile` (the file
    // mutex) with nothing written yet, so the second call's pre-read sees a
    // packet-free task and gets past the guard the sequential test covers.
    const first = open("Which endpoint should this target?");
    const second = await open("Something else entirely");
    const firstResult = await first;

    expect(firstResult.outcome).toBe("done");
    expect(second.outcome).toBe("noop");
    expect(second.message).toContain("was opened on VIB-1 first");
    expect(task().packet!.title).toBe("Which endpoint should this target?");
    // …and the loser wrote no timeline event either — a noop is a NON-write.
    expect(
      task().timeline.filter((e) => e.text.includes("Something else entirely")),
    ).toHaveLength(0);
  });

  it("withdrawing the open packet first makes room for the next one", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    await open("First decision");
    await operatorResolvePacket(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", reason: "answered out of band" },
      authority("supervised"),
    );
    expect((await open("Second decision")).outcome).toBe("done");
    expect(task().packet!.title).toBe("Second decision");
  });

  it("an agent's ask_human packet is never clobbered by an operator packet", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    const { openAgentQuestionPacket } = await import("./agent-toolkit.server");
    expect(
      await openAgentQuestionPacket(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          actorRef: {
            kind: "agent",
            backend: "claude",
            profileId: "developer",
            roleHint: "Implementation",
          },
          title: "Which database should I migrate?",
        },
      ),
    ).toBe(true);

    expect((await open("Operator decides instead")).outcome).toBe("noop");
    expect(task().packet!.title).toBe("Which database should I migrate?");
    expect(task().packet!.askedBy).toBe("developer");
  });
});

describe("B2 — the operator may only withdraw ITS OWN packet", () => {
  it("refuses to withdraw an agent's ask_human question (the askedBy resume must stay reachable)", async () => {
    deployRoster([{ capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    const { openAgentQuestionPacket } = await import("./agent-toolkit.server");
    await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        actorRef: {
          kind: "agent",
          backend: "claude",
          profileId: "developer",
          roleHint: "Implementation",
        },
        title: "Which database should I migrate?",
      },
    );

    const res = await operatorResolvePacket(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", reason: "I have decided already" },
      authority("full"),
    );
    expect(res.outcome).toBe("denied");
    expect(res.message).toContain("not by you");
    // The question — and the profile the answer resumes — survives.
    expect(task().packet!.title).toBe("Which database should I migrate?");
    expect(task().packet!.askedBy).toBe("developer");
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).not.toContain(
      "task.operator.packet_withdrawn",
    );
  });
});

describe("operatorPostComment honest outcome (G1/B-FD8)", () => {
  /** Deploy the operator roster, then turn the named anti-noise guardrails ON. */
  function deployWithGuardrails(ids: string[]): void {
    deployRoster(DEFAULT_POLICY);
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      guardrails: ids.map((id) => ({ id, desc: `${id} on`, on: true })),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const base = (text: string) => ({ projectSlug: store.slug, taskKey: "VIB-1", text });

  it("a chatter comment dropped by meaningful-comment returns NOOP + honest message + audit, and nothing lands on the timeline", async () => {
    deployWithGuardrails(["meaningful-comment"]);
    seedTask("triage");
    const result = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      base("ok"),
      authority("full"),
    );
    // The model must be told the truth — NOT "Comment posted to the timeline."
    expect(result.outcome).toBe("noop"); // a state refusal → the Codex executor narrates it
    expect(result.message).toContain("NOT posted");
    expect(task().timeline.some((e) => e.type === "comment")).toBe(false);
    expect(
      listAuditEvents(store.db, { action: "task.comment.dropped" }),
    ).toHaveLength(1);
  });

  it("an exact duplicate of the last operator comment returns NOOP, not a false 'posted'", async () => {
    deployWithGuardrails(["meaningful-comment", "no-duplicate-summary"]);
    seedTask("triage");
    const substantive = base("Assigned the developer; the first run is queued now.");
    const first = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      substantive,
      authority("full"),
    );
    expect(first.outcome).toBe("done");
    const second = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      substantive,
      authority("full"),
    );
    expect(second.outcome).toBe("noop");
    expect(second.message).toContain("identical to your previous comment");
    // Only ONE comment ever reached the record.
    expect(task().timeline.filter((e) => e.type === "comment")).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "task.comment.dropped" }),
    ).toHaveLength(1);
  });

  it("a substantive, first-time comment still reports DONE and posts", async () => {
    deployWithGuardrails(["meaningful-comment", "no-duplicate-summary"]);
    seedTask("triage");
    const result = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      base("Assigned the developer; the first run is queued now."),
      authority("full"),
    );
    expect(result.outcome).toBe("done");
    expect(result.message).toBe("Comment posted to the timeline.");
    expect(task().timeline.some((e) => e.type === "comment")).toBe(true);
  });
});

/**
 * F21-16 (live VIB-5) — `get_task` shipped a bare `policy` map with nothing
 * saying WHOSE policy it was, sitting right next to `deployedSpecialists`.
 * After a human granted the Web Verifier profile web + browser, the operator
 * read `use-web-search-fetch: off` out of that map — its OWN withheld egress —
 * and generated a "Web egress grant did not take effect" packet about the
 * specialist. The specialist's next run mounted the browser fine.
 */
/** Capability grants as the deployment file carries them. */
const grants = (
  modes: Record<string, CapabilityMode>,
): { capabilityId: string; mode: CapabilityMode }[] =>
  Object.entries(modes).map(([capabilityId, mode]) => ({ capabilityId, mode }));

describe("operatorSnapshot — two capability scopes, both labelled (F21-16)", () => {
  /** Deploy an operator whose own egress is WITHHELD alongside a specialist
   *  whose egress and browser are GRANTED — the exact live configuration. */
  function deployScopedRoster(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: [
            ...DEFAULT_POLICY,
            ...grants({ "use-web-search-fetch": "off" }),
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "full",
          },
        },
        {
          profileId: "web-verifier",
          capabilities: grants({
            "use-web-search-fetch": "direct",
            "use-browser": "direct",
            "report-validation-verdict": "off",
          }),
          extras: [],
          definition: {
            kind: "specialist",
            name: "Web Verifier",
            role: "Live verification",
            backends: ["claude"],
            model: "sonnet",
          },
        },
        {
          profileId: "quiet",
          // P13-AP-06: an EMPTY grant list is a fully WITHHELD profile, not an
          // unspecified one — its egress must read false, not the catalog
          // default.
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Quiet",
            role: "Docs",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const snapshot = () =>
    operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("full"),
    );

  it("labels the operator's own policy and carries the note that stops the misread", () => {
    // Canary: rename `operatorPolicy` back to `policy` (or drop the note) and
    // this fails.
    deployScopedRoster();
    seedTask("impl");
    const snap = snapshot();

    expect(snap.operatorPolicy.scope).toBe("operator");
    expect(snap.operatorPolicy.capabilities["use-web-search-fetch"]).toBe("off");
    expect(snap.operatorPolicy.note).toContain("deployedSpecialists[].capabilities");
    expect(snap.operatorPolicy.note).toContain("YOURS, the operator's");
    // The payload no longer carries an unlabelled `policy` key at all.
    expect("policy" in snap).toBe(false);
  });

  it("carries each specialist's OWN browser/web grants — the right place to look", () => {
    deployScopedRoster();
    seedTask("impl");
    const byId = new Map(snapshot().deployedSpecialists.map((s) => [s.id, s]));

    // The profile the human actually granted: both true, while the operator's
    // own egress row above is `off`.
    expect(byId.get("web-verifier")!.capabilities.web).toBe(true);
    expect(byId.get("web-verifier")!.capabilities.browser).toBe(true);
    // Verdict stays explicit-only (F10-14) — "supporting", not a reviewer.
    expect(byId.get("web-verifier")!.capabilities.verdict).toBe(false);
    // A withheld (empty-grants) profile must not inherit the catalog's
    // granted-by-default egress.
    expect(byId.get("quiet")!.capabilities.web).toBe(false);
    expect(byId.get("quiet")!.capabilities.browser).toBe(false);
  });

  /**
   * F21-17 — the drift fact the PR-closed recovery packet was missing. The
   * operator was structurally blind to it: `pr` carried number/state/title only.
   */
  it("exposes the PR's unreviewed-commit drift (F21-17)", () => {
    deployScopedRoster();
    seedTask("review");
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const file = readTaskFile(ref)!;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...file.parsed.frontmatter,
        pr: {
          number: 318,
          state: "closed",
          title: "PR",
          revisionDrift: { aheadBy: 2, headSha: "cab10477beef1234" },
        },
      },
      goal: file.parsed.goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect(snapshot().pr?.revisionDrift).toEqual({
      aheadBy: 2,
      headSha: "cab10477beef1234",
    });
  });
});

/**
 * F21-6 — "Engaged … as a reviewer" was emitted for EVERY non-delivering
 * engagement. The schema already distinguishes them (`!delivers &&
 * verdictCapable` makes a required reviewer), and the execution profile renders
 * the rest under "SUPPORTING AGENTS". Live, the verdict-Off Web Verifier was
 * announced "as a reviewer" — a claim of acceptance-gating authority it does
 * not hold.
 */
describe("supporting-engagement copy branches on verdict authority (F21-6)", () => {
  function deployVerdictRoster(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: DEFAULT_POLICY,
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "full",
          },
        },
        {
          profileId: "reviewer",
          capabilities: grants({ "report-validation-verdict": "direct" }),
          extras: [],
          definition: {
            kind: "specialist",
            name: "Rev",
            role: "Code review",
            backends: ["claude"],
            model: "sonnet",
          },
        },
        {
          profileId: "web-verifier",
          capabilities: grants({ "use-browser": "direct" }),
          extras: [],
          definition: {
            kind: "specialist",
            name: "Web Verifier",
            role: "Live verification",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const engage = (profileId: string) =>
    operatorAssignReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId },
      authority("supervised"),
    );

  it("a verdict-capable profile is still engaged 'as a reviewer'", async () => {
    // Canary: hardcode "a reviewer" in `supportingRoleWord` and the next test
    // fails while this one passes — the pair is what pins the branch.
    deployVerdictRoster();
    seedTask("review");
    const r = await engage("reviewer");
    expect(r.message).toBe("Engaged Rev as a reviewer.");
  });

  it("a verdict-INCAPABLE profile is engaged 'as a supporting agent'", async () => {
    deployVerdictRoster();
    seedTask("review");
    const r = await engage("web-verifier");
    expect(r.message).toBe("Engaged Web Verifier as a supporting agent.");
    expect(r.message).not.toContain("reviewer");
  });

  it("the RECOMMENDATION card carries the same distinction", async () => {
    deployVerdictRoster();
    seedTask("review");
    const recommendOnly = resolveOperatorAuthority(
      { dataRoot: store.dataRoot },
      store.slug,
      { autonomy: "supervised" },
    );
    recommendOnly.policy.set("summon-reviewers", "recommend");

    const r = await operatorAssignReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "web-verifier" },
      recommendOnly,
    );
    expect(r.outcome).toBe("recommended");
    expect(r.message).toBe("Recommended engaging Web Verifier as a supporting agent.");
    const card = task().frontmatter.recommendations.at(-1)!;
    expect(card.label).toBe("Engage Web Verifier as a supporting agent");
  });

  it("prompting a verdict-incapable profile narrates it as supporting too", async () => {
    deployVerdictRoster();
    seedTask("review");
    const r = await operatorPromptReviewer(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "web-verifier" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Prompted supporting agent @Web Verifier and started its run.");
    interruptRunningRuns("VIB-1");
  });
});

/**
 * R20-9 / ruling 84 — the delegated-ask disclosure was PROMPT-ONLY.
 *
 * When the operator consults an agent and then brings the question to a human
 * itself, the timeline otherwise reads as if that agent never held the ask. A
 * rule the model must remember is a rule it will eventually forget, so the
 * toolkit remembers: a packet opened in the same run as a `prompt_agent` carries
 * the disclosure whether or not the model wrote one.
 */
describe("delegated-ask disclosure is mechanical, not just prose (R20-9)", () => {
  const PACKET_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
    ...DEFAULT_POLICY,
    { capabilityId: "generate-packets", mode: "direct" },
  ];

  async function toolkitFor() {
    const { buildOperatorToolkit } = await import("./operator-toolkit.server");
    return buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority("full"),
    });
  }

  const openPacket = async (
    toolkit: Awaited<ReturnType<typeof toolkitFor>>,
    body: string | undefined,
  ) => {
    const tool = toolkit.tools.find((t) => t.name === "open_decision_packet")!;
    const options = [
      { kind: "custom", title: "Postgres", recommended: true },
      { kind: "custom", title: "SQLite" },
    ];
    const packetType = "input";
    const title = "Which storage backend?";
    // An ABSENT `body` is a different call from one carrying a body — the
    // second test below is exactly the absent case.
    await (body === undefined
      ? tool.handler({ packetType, title, options }, {})
      : tool.handler({ packetType, title, body, options }, {}));
  };

  it("a packet opened after prompting an agent DISCLOSES the consultation by name", async () => {
    // Canary: drop the `consultationDisclosure()` append in
    // `open_decision_packet` and the disclosure vanishes.
    deployRoster(PACKET_POLICY);
    seedTask("impl");
    const toolkit = await toolkitFor();

    const prompt = toolkit.tools.find((t) => t.name === "prompt_agent")!;
    await prompt.handler(
      { profileId: "developer", prompt: "Which storage backend does the repo use?", delivers: true },
      {},
    );
    await openPacket(toolkit, "The repo supports both.");

    const packet = task().packet!;
    expect(packet.body).toContain("The repo supports both.");
    expect(packet.body).toContain("the operator prompted Dev on this task");
    expect(packet.body).toContain("not by that agent");
    interruptRunningRuns("VIB-1");
  });

  it("discloses even when the model leaves the body empty", async () => {
    deployRoster(PACKET_POLICY);
    seedTask("impl");
    const toolkit = await toolkitFor();
    const prompt = toolkit.tools.find((t) => t.name === "prompt_agent")!;
    await prompt.handler({ profileId: "developer", prompt: "check the repo", delivers: true }, {});
    await openPacket(toolkit, undefined);

    expect(task().packet!.body).toContain("the operator prompted Dev on this task");
    interruptRunningRuns("VIB-1");
  });

  it("says nothing when no agent was consulted this run — the disclosure is a FACT, not decoration", async () => {
    deployRoster(PACKET_POLICY);
    seedTask("impl");
    const toolkit = await toolkitFor();
    await openPacket(toolkit, "Nobody was asked.");

    const packet = task().packet!;
    expect(packet.body).toBe("Nobody was asked.");
    expect(packet.body).not.toContain("Disclosure");
  });
});
