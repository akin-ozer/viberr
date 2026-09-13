import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRevisionDrift } from "~/shared/revision-drift";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import {
  deliveringEngagement,
  supportingEngagements,
  type Recommendation,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
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
  operatorDeliverForReview,
  operatorDispatchAgent,
  operatorOpenPacket,
  operatorPostComment,
  operatorSetGoal,
  operatorResolvePacket,
  operatorSnapshot,
  operatorTransitionStage,
  operatorAutonomyFor,
  operatorBackendFor,
  resolveOperatorAuthority,
  type OperatorAutonomy,
  type OperatorPacketOptionInput,
  GOAL_DRAFT_MAX_CHARS,
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
        // Repo-write grant: the dynamic dispatch derives the DELIVERING posture
        // from it (an unengaged repo-write profile on a deliverer-less task).
        profileId: "developer",
        capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }],
        extras: [],
        definition: { kind: "specialist", name: "Dev", role: "Implementation", backends: ["claude"], model: "sonnet" },
      },
      {
        // Verdict grant, no repo-write: dispatches as "a reviewer" (F21-6).
        profileId: "reviewer",
        capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
        extras: [],
        definition: { kind: "specialist", name: "Rev", role: "Code review", backends: ["claude"], model: "sonnet" },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const DEFAULT_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "dispatch-agents", mode: "direct" },
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
    expect(a.policy.get("dispatch-agents")).toBe("direct");
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
    expect(gate(authority("full"), "dispatch-agents")).toBe("direct");
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
    expect(gate(supervised, "dispatch-agents")).toBe("direct");
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

describe("operatorSetDependencies (ruling 131(b))", () => {
  it("done on a new list, noop on an unchanged one, noop with the VALIDATOR's own sentence on a bad reference, denied only when generate-packets is withheld", async () => {
    // Canary: return `denied` for the validator's error (the LV-03 misblame
    // rule: a state refusal must never accuse the project's policy).
    deployRoster([...DEFAULT_POLICY, { capabilityId: "generate-packets", mode: "direct" }]);
    seedTask("impl");
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-9", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const { operatorSetDependencies } = await import("./operator-actions.server");
    const call = (blockedBy: string[], auth = authority("supervised")) =>
      operatorSetDependencies(store.db, { dataRoot: store.dataRoot }, { projectSlug: store.slug, taskKey: "VIB-1", blockedBy, reason: "needs the parser first" }, auth);

    const done = await call(["VIB-9"]);
    expect(done.outcome).toBe("done");
    expect(done.message).toContain("VIB-1 waits on VIB-9");
    expect(done.message).toContain("Reason: needs the parser first");
    expect(task().frontmatter.blockedBy).toEqual(["VIB-9"]);
    expect(task().frontmatter.waiting).toBe("none");
    expect(task().packet).toBeNull();
    expect(task().timeline[0]).toMatchObject({ type: "note", title: "Dependencies updated", actor: { kind: "operator" } });
    const audit = listAuditEvents(store.db, { action: "task.dependencies.updated" });
    expect(audit[0]?.details).toMatchObject({ added: ["VIB-9"], removed: [] });

    const same = await call(["vib-9"]);
    expect(same.outcome).toBe("noop");
    expect(same.message).toContain("already waits on VIB-9");

    const bad = await call(["VIB-1"]);
    expect(bad.outcome).toBe("noop");
    expect(bad.message).toBe("VIB-1: a task cannot wait on itself.");
    const missing = await call(["VIB-404"]);
    expect(missing.outcome).toBe("noop");
    expect(missing.message).toBe("VIB-404 is not a task in this project.");

    deployRoster([{ capabilityId: "generate-packets", mode: "off" }, { capabilityId: "append-typed-events", mode: "direct" }]);
    const denied = await call([], authority("supervised"));
    expect(denied.outcome).toBe("denied");
    expect(task().frontmatter.blockedBy).toEqual(["VIB-9"]);
  });
});

describe("operatorDispatchAgent", () => {
  it("direct mode AUTO-ENGAGES the profile (capability-derived posture) and starts its run", async () => {
    // The pre-assignment ceremony is gone: a bare dispatch of an unengaged
    // repo-write profile on a deliverer-less task engages it as the deliverer
    // and starts the run in one step. The old "Engage it first" refusal no
    // longer exists.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Started a Claude run for Dev (the delivering agent).");
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "primary")).toBe(true);
    await interruptRunningRuns("VIB-1");
  });

  it("ruling 152(c): a dispatch into a held backend is a NOOP naming the hold, never a throw", async () => {
    // The plan's own shape for this door. It matters most on the Codex
    // operator: its plan executor catches a throw from any governed action,
    // ABORTS every remaining step and writes "Coordination stopped" on the
    // timeline — so one held `run_agent` cost the rest of a paid turn for a
    // hold whose own note says nothing was dispatched and no decision is
    // needed. Canary: remove the `isDispatchHeld` arms in
    // `operatorDispatchAgent` and both calls throw.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    // The hold is read for the account the run would bill, so the owner has to
    // have one connected (ruling 127); without it the dispatch is refused for
    // the credential before quota is anyone's question.
    const { connectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await connectFakeBackend(store.db, store.users.arda.id, "claude");
    const { recordBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    recordBackendQuotaExhaustion(store.db, "claude", {
      credentialUserId: null,
      credentialLabel: null,
      resetsAt,
      resetsAtPrecision: "clock",
      providerText: "5-hour limit reached",
      runId: "run_refused",
      observedAt: new Date().toISOString(),
    });
    const bare = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(bare.outcome).toBe("noop");
    expect(bare.message).toContain("Claude is out of quota until");
    // Ruling 207(h): this fixture's owner has ONLY Claude connected — which is
    // the shape the advice used to ignore. The hold is scoped to (backend,
    // owner) because every run bills the owner (ruling 127), so telling the
    // operator to "pick a Codex profile" would send it into a dispatch that is
    // refused on the owner's credential, and THAT failure opens the very packet
    // this sentence forbids.
    // CANARY: restore the unconditional "pick a Codex profile" and this reads
    // as advice on a fixture where no Codex account exists.
    expect(bare.message).toContain(
      "there is no Codex fallback either — this task's runs bill its owner, who has no Codex account connected",
    );
    // …and with the other backend actually reachable for the owner, the
    // fallback is real and is offered. Both arms of ruling 207(h) in one test,
    // because the sentence is only honest when it tracks this fact.
    await connectFakeBackend(store.db, store.users.arda.id, "codex");
    const withFallback = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(withFallback.message).toContain(
      "Do not open a packet for this; pick a Codex profile if the work cannot wait.",
    );

    // The prompt arm is the same door and answers the same way.
    const prompted = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        prompt: "continue the migration",
      },
      authority("supervised"),
    );
    expect(prompted.outcome).toBe("noop");
    expect(prompted.message).toContain("Claude is out of quota until");
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);
    // The hold wrote its own record, and ONE retry stands for both tries: the
    // second attempt carried a directive the first did not, so it replaced the
    // pending occurrence's prompt rather than adding an occurrence.
    const pending = task().frontmatter.schedules.filter((x) => x.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: "run-agent", profileId: "developer" });
    expect(pending[0]!.prompt).toContain("continue the migration");
    expect(task().timeline.some((e) => e.title === "Dispatch held")).toBe(true);
  });

  it("recommend mode adds ONE actionable run_agent card and does NOT engage or run", async () => {
    deployRoster([{ capabilityId: "dispatch-agents", mode: "recommend" }, { capabilityId: "append-typed-events", mode: "direct" }]);
    seedTask("impl");
    const r = await operatorDispatchAgent(
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
    expect(recs[0]!.kind).toBe("run_agent");
    expect(recs[0]!.profileId).toBe("developer");
    expect(recs[0]!.detail).toBe("Dev fits impl.");
    // …no run was started (it is only recommended)…
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);
    // …and the operator's reasoning is also commented to the timeline.
    expect(task().timeline.some((e) => e.actor.kind === "operator" && e.type === "comment")).toBe(true);
  });

  it("F19-12: the rendered card and message use ENGAGEMENT vocabulary, never 'primary specialist'", async () => {
    // D9/Q17-5 retired the primary/consultant model for `engagements[]` with one
    // `delivers: true`. The capability ID history keeps its trace in the docs;
    // the copy this module renders must not.
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.message).toBe("Recommended running Dev as the delivering agent.");
    const rec = task().frontmatter.recommendations[0]!;
    expect(rec.label).toBe("Run Dev");
    // With no reason and no prompt the card explains itself in stage terms.
    expect(rec.detail).toBe(
      "Dev fits what the current stage needs; a maintainer starts the run.",
    );
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

  /** The routing trace `recordAgentSelectionTrace` records, as this test reads it. */
  type AgentSelectionTrace = {
    chosen: string;
    delivers: boolean;
    reason: string | null;
    candidates: { profileId: string; chosen: boolean; eligibleForStage: boolean; alreadyEngaged: boolean; deliveringAtSelection: boolean }[];
  };

  it("F10-35: records a routing trace — candidates considered, chosen, reason", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorDispatchAgent(
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
    // SAFETY: `task.operator.agent_selected` has ONE writer
    // (recordAgentSelectionTrace in operator-actions.server.ts), and it records
    // exactly these four fields — `candidates` straight off the
    // deployed-specialist map.
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
    // Ruling 133 (A19): the trace records the posture the dispatch will TAKE.
    // This is a FIRST dispatch (auto-engage): not yet engaged, delivering at
    // selection. Canary: derive `deliveringAtSelection` from the pre-dispatch
    // file for the chosen profile (it reads false here).
    const dev = d.candidates.find((c) => c.profileId === "developer")!;
    expect(dev.alreadyEngaged).toBe(false);
    expect(dev.deliveringAtSelection).toBe(true);
    expect(d.candidates.find((c) => c.profileId === "reviewer")!.deliveringAtSelection).toBe(false);
    await interruptRunningRuns("VIB-1");
  });

  it("ruling 133 (A19): the snapshot and the trace judge eligibility as 'may RUN here': the engaged deliverer is eligible at a stage it does not declare, with engagedAsDeliverer beside it", async () => {
    // Canary: map `eligibleForCurrentStage` back to `specialistEligibleForStage`.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        { profileId: "operator", capabilities: DEFAULT_POLICY, extras: [], definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet", autonomy: "full" } },
        { profileId: "developer", capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }], extras: [], definition: { kind: "specialist", name: "Dev", role: "Implementation", backends: ["claude"], model: "sonnet", stages: ["impl"] } },
        { profileId: "helper", capabilities: [], extras: [], definition: { kind: "specialist", name: "Helper", role: "Support", backends: ["claude"], model: "sonnet", stages: ["impl"] } },
      ],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        engagements: [
          { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
          { profileId: "helper", backend: "claude", role: "Support", delivers: false, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const snap = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    const dev = snap.deployedSpecialists.find((s) => s.id === "developer")!;
    const helper = snap.deployedSpecialists.find((s) => s.id === "helper")!;
    expect(dev).toMatchObject({ eligibleForCurrentStage: true, engagedAsDeliverer: true });
    expect(helper).toMatchObject({ eligibleForCurrentStage: false, engagedAsDeliverer: false });
    // The trace agrees: a re-prompt of the deliverer at Review is eligible,
    // and it is already delivering.
    await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", prompt: "Address the review." },
      authority("full"),
    );
    const trace = listAuditEvents(store.db, { action: "task.operator.agent_selected" })[0]!;
    // SAFETY: `task.operator.agent_selected` has ONE writer (recordAgentSelectionTrace); its details are this shape.
    const d = trace.details as AgentSelectionTrace;
    expect(d.candidates.find((c) => c.profileId === "developer")).toMatchObject({ eligibleForStage: true, alreadyEngaged: true, deliveringAtSelection: true });
    expect(d.candidates.find((c) => c.profileId === "helper")).toMatchObject({ eligibleForStage: false, alreadyEngaged: true, deliveringAtSelection: false });
    await interruptRunningRuns("VIB-1");
  });

  it("Q34-14 (owner, 2026-09-04): an explicit hand-off to another deployed deliverer still runs directly under direct autonomy after ruling 133", async () => {
    // The regression guard for the owner's answer: it fails the moment
    // somebody re-gates the hand-off with a refusal or a card.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", delivers: true },
      authority("full"),
    );
    await interruptRunningRuns("VIB-1");
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        ...file.parsed.frontmatter.agents,
        { profileId: "developer2", capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }], extras: [], definition: { kind: "specialist", name: "Dev Two", role: "Implementation", backends: ["claude"], model: "sonnet" } },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer2", delivers: true, prompt: "Take over the build." },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.engagements.find((e) => e.delivers)?.profileId).toBe("developer2");
    expect(task().frontmatter.recommendations).toEqual([]);
    await interruptRunningRuns("VIB-1");
  });

  it("an UNKNOWN profileId is a noop that points at the roster, not a crash", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "ghost" },
      authority("full"),
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toBe(
      'No deployed agent "ghost" to run. Pick a profile from get_task\'s deployedSpecialists.',
    );
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);
  });

  it("off mode (don't recommend) is denied", async () => {
    deployRoster([{ capabilityId: "dispatch-agents", mode: "off" }]);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("full"), // even full autonomy cannot override an `off` capability
    );
    expect(r.outcome).toBe("denied");
    expect(r.message).toBe("Dispatching agents is not permitted for the operator here.");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
  });
});

describe("operatorDispatchAgent — explicit delivers posture (P11-22 successor)", () => {
  // The old guard ("not the delivering agent" for any profileId ≠ deliverer) is
  // gone with the slot ceremony: an explicit `delivers: true` is now a delivery
  // HAND-OFF, vetted by the profile's own grants instead of the current slot.
  it("refuses an explicit delivery hand-off to a profile with NO repo-write grant", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    // "reviewer" holds no repo-write grant — a delivering run for it would own
    // a branch it can ship nothing to. The hunt hardened this from a thrown
    // dispatch error into an operator-level NOOP naming the remedy (R21-2's
    // posture) — refused BEFORE any card, trace or engage can announce it.
    const refused = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer", delivers: true },
      authority("full"),
    );
    expect(refused.outcome).toBe("noop");
    expect(refused.message).toMatch(/holds no repo-write grant/i);
    expect(refused.message).toMatch(/Agents surface/);
    // The deliverer was not reassigned.
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
  });

  it("refuses `delivers: false` aimed at the CURRENT deliverer — a delivering run cannot be demoted per-dispatch", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    // Hunt 2026-08-29: the dispatch keeps an engaged profile's shape, so this
    // hint used to be silently dropped — the run went out kind "primary" while
    // the message and the selection trace said "a supporting agent". Refusing
    // the contradiction keeps every governed surface honest.
    const refused = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", delivers: false },
      authority("full"),
    );
    expect(refused.outcome).toBe("noop");
    expect(refused.message).toMatch(/IS the delivering agent/);
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
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
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer", delivers: true },
      authority("full"),
    );
    expect(r.outcome).not.toBe("denied");
    await interruptRunningRuns("VIB-1");
  });
});

describe("operatorDispatchAgent — recommend is an APPLYABLE run_agent card", () => {
  it("run_agent under recommend adds an actionable card (not a dead-end comment) that apply STARTS the run", async () => {
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    // Engage the specialist directly first (engagement isn't what's recommended
    // here — starting its run is).
    const { assignSpecialist } = await import("./specialist-run.server");
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );

    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    // The regression: a STRUCTURED, applyable recommendation — NOT a bare
    // "Awaiting a maintainer to confirm" comment with no button.
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("run_agent");
    // No run started yet (it's only recommended).
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);

    // A maintainer applies the card → the agent run actually starts.
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: recs[0]!.id },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.recommendations).toHaveLength(0);
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
    await interruptRunningRuns("VIB-1");
  });

  it("the card carries the operator's PROMPT, and apply runs it (auto-engaging the profile)", async () => {
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "reviewer",
        prompt: "Review the delivered branch against the acceptance criteria.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("run_agent");
    expect(recs[0]!.profileId).toBe("reviewer");
    // The prompt rides the card so the applied dispatch runs exactly this…
    expect(recs[0]!.prompt).toBe(
      "Review the delivered branch against the acceptance criteria.",
    );
    // …and with no separate reason it doubles as the card's reasoning.
    expect(recs[0]!.detail).toBe(
      "Review the delivered branch against the acceptance criteria.",
    );
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);

    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: recs[0]!.id },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    // The apply auto-engaged the (previously unengaged) reviewer and ran it.
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
    await interruptRunningRuns("VIB-1");
  });

  it("a NEWER prompt for the same agent REPLACES the pending card — never silently dropped (hunt 2026-08-29)", async () => {
    // The per-target dedupe predates `prompt` on run_agent cards: the second
    // recommendation was discarded whole, so the operator narrated directive Y
    // while Apply dispatched the stale X.
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("review");
    await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer", prompt: "Check the API surface." },
      authority("supervised"),
    );
    await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer", prompt: "Check the migration instead." },
      authority("supervised"),
    );
    const recs = task().frontmatter.recommendations;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.prompt).toBe("Check the migration instead.");
    // An IDENTICAL re-recommendation stays the quiet no-op it always was.
    await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer", prompt: "Check the migration instead." },
      authority("supervised"),
    );
    expect(task().frontmatter.recommendations).toHaveLength(1);
  });

  it("an explicit `delivers: false` hint rides the card and Apply installs THAT posture (hunt 2026-08-29)", async () => {
    // The reproduced failure: deliverer-less task, repo-write Dev, the operator
    // recommends a SUPPORTING run — the card dropped the hint, so Apply
    // re-derived and installed Dev as the DELIVERER, the opposite shape.
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        prompt: "Investigate the flake. Do not touch the branch.",
        delivers: false,
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(r.message).toContain("as a supporting agent");
    const recs = task().frontmatter.recommendations;
    expect(recs[0]!.delivers).toBe(false);
    await applyRecommendation(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", recId: recs[0]!.id },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    // Dev engaged SUPPORTING — no delivering engagement was minted.
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("developer");
    await interruptRunningRuns("VIB-1");
  });
});

describe("dispatchGate — absent means the catalog default (hunt 2026-08-29)", () => {
  it("a pre-rework deployment storing only the retired assign/summon ids still dispatches", async () => {
    // The owner's live stores deploy the operator with
    // `assign-primary-specialist` + `summon-reviewers` and no `dispatch-agents`
    // row; the plain gate read absent as off → deny, silently making the whole
    // rework inert on every existing project (no run_agent tool, denied
    // dispatches) while transitions and delivery survived.
    deployRoster([
      { capabilityId: "assign-primary-specialist", mode: "direct" },
      { capabilityId: "summon-reviewers", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
    await interruptRunningRuns("VIB-1");
  });

  it("an EXPLICIT `dispatch-agents: off` still denies — absent-means-granted is not a bypass", async () => {
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "off" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("full"),
    );
    expect(r.outcome).toBe("denied");
  });
});

describe("operatorDispatchAgent — supporting posture (delivers derivation)", () => {
  it("a verdict-capable, non-repo-write profile auto-engages as SUPPORTING and runs as a reviewer", async () => {
    // resolveDeliversIntent: no explicit hint, unengaged, and no repo-write
    // grant → supporting, even though the task has no deliverer yet.
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Started a Claude run for Rev (a reviewer).");
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
    // Supporting, not delivering — the deliverer slot stays empty.
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "reviewer")).toBe(true);
    await interruptRunningRuns("VIB-1");
  });

  it("an ENGAGED profile keeps its shape on a bare re-dispatch", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const { assignReviewer } = await import("./specialist-run.server");
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      { userId: store.users.arda.id, label: "Arda" },
      { dataRoot: store.dataRoot },
    );
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Started a Claude run for Rev (a reviewer).");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    await interruptRunningRuns("VIB-1");
  });
});

/** Stop every still-streaming run's cadence timer so it does not outlive a test. */
async function interruptRunningRuns(taskKey: string): Promise<void> {
  const arda = { userId: store.users.arda.id, label: store.users.arda.email };
  for (const r of listRunsForTask(store.db, store.slug, taskKey)) {
    if (r.lifecycle === "running" || r.lifecycle === "queued") {
      await interruptRun(
        store.db,
        { projectSlug: store.slug, taskKey, runId: r.serverRunId, dataRoot: store.dataRoot },
        arda,
      );
    }
  }
}

describe("operatorDispatchAgent — the prompt hand-off", () => {
  it("direct + prompt engages the profile, posts the @-mention hand-off comment, and starts its run", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        prompt: "implement the auth guard first, then wire the tests.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Prompted @Dev (the delivering agent) and started its run.");
    // The specialist is engaged as the deliverer…
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    // …a routed-to-agent operator comment carries the hand-off, addressed to
    // the agent by @mention ("@Dev …")…
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt).toBeDefined();
    expect(prompt!.text).toBe("@Dev implement the auth guard first, then wire the tests.");
    // …and its run was triggered (the primary run row exists right after the await).
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "primary")).toBe(true);
    await interruptRunningRuns("VIB-1");
  });

  it("F32-8 (pass 32): a directive naming an org MCP server the target does NOT hold is annotated on the hand-off", async () => {
    // Live (VIB-1, VIB-2): "re-call qa_echo yourself" went to a Reviewer with
    // no MCP grant; it burned 20-30 turns hunting the tool. The note rides the
    // comment AND the run's directive. Names match loosely (`qa_echo` is the
    // tool prefix a model sees for the `qa-echo` server).
    // Canary: return `prompt` unchanged from annotateUngrantedMcps.
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES ('mcp_qa', 'qa-echo', 'HTTP', 'https://mcp.example/qa', NULL, ?, ?)`,
      )
      .run(now, now);
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "reviewer",
        prompt: "review the change and re-run qa_echo yourself to compare outputs.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt!.text).toContain("re-run qa_echo yourself");
    expect(prompt!.text).toContain("Rev holds no MCP grant for `qa-echo`");
    expect(prompt!.text).toContain("Do not hunt for them");
    await interruptRunningRuns("VIB-1");
  });

  it("F32-8 (pass 32): a directive that names no ungranted server is handed off verbatim", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES ('mcp_qa', 'qa-echo', 'HTTP', 'https://mcp.example/qa', NULL, ?, ?)`,
      )
      .run(now, now);
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        // Ordinary prose; "echo" alone is not the server's name.
        prompt: "implement the auth guard; echo the config on start.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt!.text).toBe("@Dev implement the auth guard; echo the config on start.");
    await interruptRunningRuns("VIB-1");
  });

  it("direct WITHOUT a prompt starts a bare run and posts NO synthetic comment", async () => {
    // A bare re-dispatch re-anchors the agent on task.md; a manufactured
    // "@Dev …" comment would fake a hand-off nobody wrote.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "developer" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(
      task().timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
      ),
    ).toBe(false);
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "primary")).toBe(true);
    await interruptRunningRuns("VIB-1");
  });

  it("recommend + prompt files the run_agent card and does NOT run the agent", async () => {
    deployRoster([
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "developer",
        prompt: "implement the auth guard first.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(deliveringEngagement(task().frontmatter)).toBeNull();
    expect(task().frontmatter.recommendations[0]?.kind).toBe("run_agent");
    expect(task().frontmatter.recommendations[0]?.prompt).toBe(
      "implement the auth guard first.",
    );
    // No run was triggered.
    await new Promise((res) => setTimeout(res, 40));
    expect(listRunsForTask(store.db, store.slug, "VIB-1").filter((x) => x.kind === "primary")).toHaveLength(0);
  });

  it("prompting a supporting profile engages it, posts the hand-off, and starts its reviewer run", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "reviewer",
        prompt: "review the delivered branch.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Prompted @Rev (a reviewer) and started its run.");
    expect(
      supportingEngagements(task().frontmatter).map((x) => x.profileId),
    ).toContain("reviewer");
    const prompt = task().timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "operator" && e.toAgent,
    );
    expect(prompt).toBeDefined();
    expect(listRunsForTask(store.db, store.slug, "VIB-1").some((x) => x.kind === "reviewer")).toBe(true);
    await interruptRunningRuns("VIB-1");
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
    await interruptRunningRuns("VIB-1");
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
    await interruptRunningRuns("VIB-1");
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
    await interruptRunningRuns("VIB-1");
  });

  /**
   * BUG-2 (pass 23): a manual @operator trigger is REFUSED while a decision
   * packet is open (coordination is paused, waiting on the human). `runOperator`
   * returns `refused: "open-packet"` + `runId: null`; `commentToAgent` used to
   * report `triggered: "started"` anyway, so the route toasted "@Operator is
   * picking it up" for a run that never ran and the reply never came. It now
   * surfaces the refusal so the human is pointed at resolving the packet.
   */
  it("an @operator comment is REFUSED (not 'started') while a decision packet is open", async () => {
    deployRoster(DEFAULT_POLICY);
    // Seed the task WITH an open packet (coordination paused, waiting on human).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "blocked",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
      }),
      goal: "Prove the operator drives the task.",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Pick a recovery path",
        body: "",
        observations: [],
        options: [{ kind: "block_on_policy", t: "Unblock", d: "", rec: true }],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const { resetOperatorLeasesForTests } = await import(
      "~/server/runtimes/operator-run.server"
    );
    resetOperatorLeasesForTests();

    const { commentToAgent } = await import("./task-actions.server");
    const res = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@operator can you summarize?" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );

    // Refusal is surfaced, NOT reported as a started run.
    expect(res.triggered).toBeNull();
    expect(res.operatorRefused).toBe("open-packet");
    expect(res.runtimeDenied).toBe(false);
    // The comment is still recorded and tinted as routed to the mentioned agent.
    expect(res.toAgent).toBe(true);
    // …and no operator run was created for it.
    const opRuns = listRunsForTask(store.db, store.slug, "VIB-1").filter(
      (r) => r.kind === "operator",
    );
    expect(opRuns).toHaveLength(0);
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

  it("ruling 151: full autonomy RECOMMENDS an approval boundary instead of crossing it", async () => {
    // Pass 35, F35-2 (owner Q35-1): the boundary always wins. This case used to
    // assert the opposite ("full autonomy moves the task across an approval
    // boundary as the operator"). Canary: delete the `boundary === "approval"`
    // branch in operatorTransitionStage and the task moves.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("full"),
    );
    expect(r.outcome).toBe("recommended");
    expect(r.message).toContain("approved by a human");
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.recommendations.map((x) => x.kind)).toEqual(["transition"]);
    expect(
      listAuditEvents(store.db, { action: "task.transition" }).filter(
        (row) => row.details?.by === "operator",
      ),
    ).toHaveLength(0);
  });

  it("ruling 151: an EXPLICIT `stage-transitions: direct` grant under supervised autonomy still recommends an approval boundary", async () => {
    // The live KNC-1 shape: the controller set the grant to `direct` and the
    // operator crossed Review to Merge alone (audit `boundary: approval, by:
    // operator`) while every surface said a human approves it.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "stage-transitions"),
      { capabilityId: "stage-transitions", mode: "direct" },
    ]);
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("recommended");
    expect(task().frontmatter.stage).toBe("impl");
    // …and the same grant still crosses an `auto` boundary directly.
    seedTask("ready");
    const auto = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      authority("supervised"),
    );
    expect(auto.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("impl");
  });

  it("ruling 151: a declared `human` boundary before the terminal stage is refused with a sentence", async () => {
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "stage-transitions"),
      { capabilityId: "stage-transitions", mode: "direct" },
    ]);
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      stages: [
        { id: "triage", name: "Triage", color: "#a5a8b5" },
        { id: "impl", name: "Build", color: "#7b61ff" },
        { id: "signoff", name: "Sign-off", color: "#5b76fe" },
        { id: "done", name: "Done", color: "#00b473" },
      ],
      workflow: [
        { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
        { from: "impl", to: "signoff", boundary: "human", by: "A person", locked: false },
        { from: "signoff", to: "done", boundary: "human", by: "Human acceptance", locked: true },
      ],
    });
    seedTask("impl");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "signoff" },
      authority("full"),
    );
    expect(r.outcome).toBe("denied");
    expect(r.message).toBe(
      "Moving VIB-1 to Sign-off is a human decision on this board; the operator cannot cross that boundary. A human moves the task or accepts the completion.",
    );
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.recommendations).toHaveLength(0);
  });

  it("ruling 152(a): the done reply names the NEXT boundary so one turn walks consecutive auto stages", async () => {
    // Canary: return the bare "Moved …" sentence again.
    deployRoster(DEFAULT_POLICY);
    seedTask("triage");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toMatch(/^Moved VIB-1 to Ready\. The next boundary, Ready to In Progress, is auto: continue in this turn/);
    const next = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl" },
      authority("supervised"),
    );
    expect(next.message).toMatch(/next boundary, In Progress to Review, is approved by a human: recommend it/);
  });

  describe("Q35-15: the transition turn writes the acceptance recommendation itself (the fold)", () => {
    // A board whose edge INTO the acceptance boundary is `auto`, so the
    // operator's own move lands there directly (KNC-30 took two operator
    // turns: one for Review to Merge, a second only to write the card).
    const foldBoard = (): void => {
      const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
      writeProject(store.dataRoot, {
        ...file.parsed.frontmatter,
        workflow: [
          { from: "triage", to: "ready", boundary: "auto", by: "Operator", locked: false },
          { from: "ready", to: "impl", boundary: "auto", by: "Operator", locked: false },
          { from: "impl", to: "review", boundary: "auto", by: "Operator", locked: false },
          { from: "review", to: "done", boundary: "human", by: "Human acceptance", locked: true },
        ],
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    };

    it("a direct move onto the acceptance boundary files the accept_completion card in the same call", async () => {
      // Canary: delete the `foldAcceptanceRecommendation` call from the done
      // branch of operatorTransitionStage.
      deployRoster(DEFAULT_POLICY);
      foldBoard();
      seedTask("impl");
      const r = await operatorTransitionStage(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
        authority("supervised"),
      );
      expect(r.outcome).toBe("done");
      expect(task().frontmatter.stage).toBe("review");
      expect(r.message).toMatch(/^Moved VIB-1 to Review\. Recommended accepting completion: move VIB-1 to Done\./);
      expect(task().frontmatter.recommendations.map((x) => x.kind)).toEqual(["accept_completion"]);
      expect(
        listAuditEvents(store.db, { action: "task.operator.recommended_completion" }),
      ).toHaveLength(1);
    });

    it("a refused acceptance gate is reported in the reply and no card is filed", async () => {
      deployRoster(DEFAULT_POLICY);
      foldBoard();
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          ownerUserId: store.users.arda.id,
          operator: { assignedAtStageId: "triage" },
          // A closed, unmerged PR: acceptance is refused by a terminal fact.
          pr: { number: 8, state: "closed", title: "[VIB-1] work" },
        }),
        goal: "Prove the fold reports a refusal.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const r = await operatorTransitionStage(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
        authority("supervised"),
      );
      expect(r.outcome).toBe("done");
      expect(task().frontmatter.stage).toBe("review");
      expect(r.message).toMatch(/Acceptance is not recommended yet: /);
      expect(task().frontmatter.recommendations).toHaveLength(0);
    });

    it("full autonomy with a DIRECT acceptance grant is never folded into an acceptance", async () => {
      deployRoster([
        ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
        { capabilityId: "completion-for-acceptance", mode: "direct" },
      ]);
      foldBoard();
      seedTask("impl");
      const r = await operatorTransitionStage(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
        authority("full"),
      );
      expect(r.outcome).toBe("done");
      expect(task().frontmatter.stage).toBe("review");
      expect(r.message).toMatch(/is acceptance: call accept_completion/);
      expect(task().frontmatter.recommendations).toHaveLength(0);
    });
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

  it("U36-9 (pass 36): the full-autonomy acceptance names the terminal stage as the board calls it", async () => {
    // Live: every completion sentence said "moved to **Done**" on a board whose
    // last stage is Shipped. Canary: put the literal back into the message or
    // the completion event.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "completion-for-acceptance"),
      { capabilityId: "completion-for-acceptance", mode: "direct" },
    ]);
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      stages: project.parsed.frontmatter.stages.map((s) =>
        s.id === "done" ? { ...s, name: "Shipped" } : s,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedTask("review");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Accepted completion: VIB-1 moved to Shipped.");
    // This fixture has no repository, so the completion event takes the
    // verified no-change arm (R17-2); the two merge arms share the sentence the
    // message above was built from, and none of the three may say "Done".
    const completion = task().timeline.find((e) => e.type === "completion");
    expect(completion?.text).toContain("**VIB-1 completed with no changes**");
    expect(completion?.text).not.toContain("moved to Done");
    // The idempotent second call names the stage the same way.
    const again = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(again).toEqual({ outcome: "noop", message: "VIB-1 is already Shipped." });
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
            rounds: 1,
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
            rounds: 1,
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

  it("U36-2 (pass 36): an archive_task option's deleteBranch is dropped on a task with no branch", async () => {
    // Live: an `input` packet on a branchless task carried `deleteBranch`, and
    // the card rendered the closed-PR recovery paragraph about it. Canary:
    // drop the `existing.parsed.frontmatter.branch` half of the guard.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "generate-packets"),
      { capabilityId: "generate-packets", mode: "direct" },
    ]);
    seedTask("impl");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Scope: no-op probe or new fixture",
        options: [
          { kind: "archive_task", title: "Archive it", deleteBranch: true },
          { kind: "edit_goal", title: "Retarget it" },
        ],
      },
      authority("full"),
    );
    const packet = task().packet!;
    expect(packet.options[0]).toMatchObject({ kind: "archive_task" });
    expect("deleteBranch" in packet.options[0]!).toBe(false);
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

  /**
   * Owner ruling (pass 32): `accept_completion` is only coherent AT the
   * acceptance boundary with a healthy verdict — anywhere else the gate refuses
   * the decision the option offers (rulings 20/62). Live (VIB-3): a triage
   * packet offered "Accept as complete now" on a task at Triage with no
   * verdict. Authoring refuses it and names the verbs that fit.
   */
  it("refuses an accept_completion option off the acceptance boundary, and allows it on it", async () => {
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    const open = (stage: string, validation: "none" | "healthy") => {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage,
          validation,
          ownerUserId: store.users.arda.id,
          operator: { assignedAtStageId: "triage" },
        }),
        goal: "Probe only.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      return operatorOpenPacket(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          packetType: "input",
          title: "Nothing to do here",
          body: "The goal names no deliverable.",
          observations: [],
          options: [
            { kind: "accept_completion" as const, title: "Accept as complete now", recommended: true },
            { kind: "archive_task" as const, title: "Archive this task" },
          ],
        },
        authority("supervised"),
      );
    };
    const atTriage = await open("triage", "none");
    expect(atTriage.outcome).toBe("noop");
    expect(atTriage.message).toContain("acceptance boundary");
    expect(atTriage.message).toContain("archive_task");
    expect(task().packet).toBeNull();

    const atReviewUnverified = await open("review", "none");
    expect(atReviewUnverified.outcome).toBe("noop");
    expect(atReviewUnverified.message).toContain("validation is not healthy");

    const atBoundary = await open("review", "healthy");
    expect(atBoundary.outcome).toBe("done");
    expect(task().packet!.options[0]!.kind).toBe("accept_completion");
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

  /**
   * F31-6 (pass 31, live-caught): the operator authored "delete the
   * conflicting REMOTE branch and push this task's commit fresh" onto a
   * `discard_branch` option — whose actual semantics delete the LOCAL branch
   * and its commits. Authoring now refuses the incoherent shape and names the
   * verb that fits, and that verb is accepted on the same task.
   */
  it("F31-6: refuses discard_branch on a delivered/occupied branch and accepts resolve_remote_collision", async () => {
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "Collision shape",
        branch: "vib-1",
        workRevision: {
          id: "rev_collision1",
          headSha: "a".repeat(40),
          treeSha: "b".repeat(40),
          branch: "vib-1",
          createdAt: new Date().toISOString(),
          sourceProfileId: "developer",
          kind: "delivered",
        },
        github: { commits: [], changed: null, unownedPr: 232 },
      }),
      goal: "Prove packet-option coherence.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const refused = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Branch collision — pick a recovery path",
        options: [
          {
            kind: "discard_branch" as const,
            title: "Delete the stale remote vib-1 branch, then redeliver",
            recommended: true,
          },
        ],
      },
      authority("supervised"),
    );
    expect(refused.outcome).toBe("noop");
    expect(refused.message).toContain("resolve_remote_collision");
    // Ruling 161: the refusal names the REAL reason (the unowned PR), not
    // "has a delivered revision".
    expect(refused.message).toContain("unowned PR #232 stands on the branch name `vib-1`");
    expect(refused.message).not.toContain("has a delivered revision");
    expect(task().packet).toBeNull();

    const accepted = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Branch collision — pick a recovery path",
        options: [
          {
            kind: "resolve_remote_collision" as const,
            title: "Clear the stale remote branch and redeliver",
            recommended: true,
          },
          { kind: "custom" as const, title: "Something else" },
        ],
      },
      authority("supervised"),
    );
    expect(accepted.outcome).toBe("done");
    expect(task().packet!.options[0]!.kind).toBe("resolve_remote_collision");
  });

  /**
   * Ruling 161 (pass 35, G35-6): KNC-21's revision was registered by the
   * agent's completion report at 18:56Z, the push was refused at 19:10Z, and
   * the operator's `discard_branch` was refused at 19:3xZ because "a revision
   * exists". The gate keys on whether the revision LEFT the workspace.
   */
  function reportedRevision(pushedAt: string | null): WorkRevision {
    const revision: WorkRevision = {
      id: "rev_MBEIgNbXXyFX",
      headSha: "8c463b7".padEnd(40, "0"),
      treeSha: "b".repeat(40),
      branch: "vib-1",
      createdAt: "2026-09-06T18:56:57.000Z",
      sourceProfileId: "developer",
      kind: "delivered",
    };
    // The key is absent, not undefined, when there was no push: that is the
    // shape a file that never saw a delivery parses to.
    if (pushedAt) revision.pushedAt = pushedAt;
    return revision;
  }
  const discardOption = {
    kind: "discard_branch" as const,
    title: "Throw the local vib-1 draft away",
    recommended: true,
  };

  it("ruling 161: discard_branch is accepted on a reported, never-pushed revision with no PR on the branch", async () => {
    // Canary: restore `hasDeliveredWork = fm.workRevision !== null` and this
    // authoring is refused ("has a delivered revision").
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "Reported, never pushed",
        branch: "vib-1",
        workRevision: reportedRevision(null),
        github: { commits: [{ sha: "8c463b7", msg: "[VIB-1] work" }], changed: null },
      }),
      goal: "Discard a local draft.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const accepted = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "The push was refused: keep or throw away the local work?",
        options: [discardOption, { kind: "custom" as const, title: "Something else" }],
      },
      authority("supervised"),
    );
    expect(accepted.outcome).toBe("done");
    expect(task().packet!.options[0]!.kind).toBe("discard_branch");
  });

  it("ruling 161: discard_branch is refused once the delivery push published the head, naming the push", async () => {
    // Canary: drop the `pushed` arm of `revisionLeftWorkspace` and a pushed
    // revision is offered for a local discard that cannot remove it.
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "Pushed, PR not yet open",
        branch: "vib-1",
        workRevision: reportedRevision("2026-09-06T19:10:35.000Z"),
      }),
      goal: "Refuse the discard of pushed work.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const refused = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Throw the work away?",
        options: [discardOption],
      },
      authority("supervised"),
    );
    expect(refused.outcome).toBe("noop");
    expect(refused.message).toContain("ruling 161");
    expect(refused.message).toContain("`8c463b7` was pushed to origin at 2026-09-06T19:10:35.000Z");
    expect(refused.message).toContain("archive_task with deleteBranch");
    expect(task().packet).toBeNull();
  });

  /**
   * Ruling 164 (pass 35, F35-14) — an option title is a promise the resolution
   * keeps, checked where the option is AUTHORED (the one door both operator
   * backends reach). The two live titles are the cases; the third is the
   * profile surgery KNC-20's packet offered, which no kind can perform.
   */
  it("ruling 164: refuses a send-back option that promises a force-accept, a stage move, or a profile edit", async () => {
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    const open = (option: OperatorPacketOptionInput) => {
      seedTask("impl");
      return operatorOpenPacket(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          packetType: "blocked",
          title: "Stuck at the acceptance boundary",
          options: [option, { kind: "archive_task", title: "Archive it" }],
        },
        authority("supervised"),
      );
    };

    const force = await open({
      kind: "custom",
      title: "Force-accept as admin without a fresh verdict",
      recommended: true,
    });
    expect(force.outcome).toBe("noop");
    expect(force.message).toContain("'force_accept'");
    expect(force.message).toContain("promise the resolution keeps");
    expect(task().packet).toBeNull();

    const move = await open({
      kind: "redirect",
      title: "Move VIB-1 back to Review so the reviewer can verdict 701b5b3",
      recommended: true,
    });
    expect(move.outcome).toBe("noop");
    expect(move.message).toContain("'move_stage'");
    expect(move.message).toContain("toStage: 'review'");
    expect(task().packet).toBeNull();

    const profile = await open({
      kind: "custom",
      title: "Add Review to the two reviewer profiles",
      detail: "The product's own remedy for the eligibility gap.",
      recommended: true,
    });
    expect(profile.outcome).toBe("noop");
    expect(profile.message).toContain("Agents");
    expect(task().packet).toBeNull();

    // The stock send-back vocabulary is untouched: a guard that refused this
    // would take the operator's ordinary options away.
    const fine = await open({
      kind: "redirect",
      title: "Reassign or redirect the work",
      recommended: true,
    });
    expect(fine.outcome).toBe("done");
    expect(task().packet!.options[0]!.kind).toBe("redirect");
  });

  it("ruling 164: a move_stage option names a stage the resolution can move to, and only that kind carries one", async () => {
    deployRoster([
      { capabilityId: "generate-packets", mode: "direct" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    const open = (option: OperatorPacketOptionInput, stage = "impl") => {
      seedTask(stage);
      return operatorOpenPacket(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          packetType: "input",
          title: "Where should this task be shown?",
          options: [option, { kind: "custom", title: "Answer in my own words" }],
        },
        authority("supervised"),
      );
    };

    const noStage = await open({ kind: "move_stage", title: "Move it back", recommended: true });
    expect(noStage.outcome).toBe("noop");
    expect(noStage.message).toContain("has to name the stage");

    const unknown = await open({
      kind: "move_stage",
      title: "Move it to QA",
      toStage: "qa",
      recommended: true,
    });
    expect(unknown.outcome).toBe("noop");
    expect(unknown.message).toContain("not a stage of this project");

    const terminal = await open({
      kind: "move_stage",
      title: "Move it to Done",
      toStage: "done",
      recommended: true,
    });
    expect(terminal.outcome).toBe("noop");
    expect(terminal.message).toContain("accepts its completion");

    const standingThere = await open({
      kind: "move_stage",
      title: "Move it to In Progress",
      toStage: "impl",
      recommended: true,
    });
    expect(standingThere.outcome).toBe("noop");
    expect(standingThere.message).toContain("already stands at");

    const stray = await open({
      kind: "redirect",
      title: "Send it back",
      toStage: "review",
      recommended: true,
    });
    expect(stray.outcome).toBe("noop");
    expect(stray.message).toContain("toStage only fits a move_stage option");

    // Pass-35 cluster review: `move_stage` carries BOTH a free-text title and a
    // target, and the card renders only the words — so a title naming another
    // stage is the ruling's own broken promise, invisible to the person
    // confirming it. Canary: drop the `moveStagePromiseMismatch` call.
    const mismatched = await open({
      kind: "move_stage",
      title: "Move VIB-1 back to Review so the reviewer can verdict",
      toStage: "triage",
      recommended: true,
    });
    expect(mismatched.outcome).toBe("noop");
    expect(mismatched.message).toContain("says Review");
    expect(mismatched.message).toContain("toStage is 'triage'");
    expect(task().packet).toBeNull();

    const good = await open({
      kind: "move_stage",
      title: "Show it at Review while the reviewer runs",
      toStage: "review",
      recommended: true,
    });
    expect(good.outcome).toBe("done");
    expect(task().packet!.options[0]!.toStage).toBe("review");
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
      { capabilityId: "dispatch-agents", mode: "recommend" },
      { capabilityId: "append-typed-events", mode: "direct" },
    ]);
    seedTask("impl");
    await operatorDispatchAgent(
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
    // The recommended dispatch was performed — the run's auto-engage made Dev
    // the deliverer and its run started…
    expect(deliveringEngagement(task().frontmatter)?.profileId).toBe("developer");
    expect(listRunsForTask(store.db, store.slug, "VIB-1").length).toBeGreaterThan(0);
    // …and the recommendation card was cleared.
    expect(task().frontmatter.recommendations).toHaveLength(0);
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).toContain("task.recommendation.applied");
    await interruptRunningRuns("VIB-1");
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
    expect(deliveringEngagement(task().frontmatter)).toBeNull(); // NOT engaged
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0); // NOT run
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
    await operatorDispatchAgent(
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

  it("ruling 131(d): the snapshot carries blockedBy with resolved states", async () => {
    // Canary: omit `blockedBy` from `operatorSnapshot`'s return object.
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(snapshot().blockedBy).toEqual([]);
    const { setTaskDependencies } = await import("./dependencies.server");
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-77", { stage: "done", waiting: "none" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-77", "goal-9 link 1"] },
      { userId: "operator", label: "operator" },
      { dataRoot: store.dataRoot, operatorAuthorized: true },
    ).catch(() => {});
    await setTaskDependencies(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-77"] },
      { userId: "operator", label: "operator" },
      { dataRoot: store.dataRoot, operatorAuthorized: true },
    );
    expect(snapshot().blockedBy).toEqual([
      { ref: "VIB-77", label: "VIB-77", state: "done", taskKey: "VIB-77", goalId: null },
    ]);
  });

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

  it("F31-3: the operator snapshot names the INSTANCE resource catalog (existence is checkable)", async () => {
    seedTask("impl");
    deployRoster([{ capabilityId: "append-typed-events", mode: "direct" }]);
    // An org KB that exists on disk but is granted to nothing on this project
    // — the exact live shape the F31-3 packet misread as "does not exist".
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const kbDir = join(store.dataRoot, "kb", "pass31-qa-conventions");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "rules.md"), "# rules\n");
    const org = snapshot().orgResources!;
    expect(org).toBeTruthy();
    expect(Array.isArray(org.skills)).toBe(true);
    expect(Array.isArray(org.mcps)).toBe(true);
    // The catalog surfaces the ungranted KB by NAME — the operator can now
    // distinguish "exists, not granted here" from "does not exist".
    expect(org.kbs).toContain("pass31-qa-conventions");
  });

  it("V19 (pass-31 review): the snapshot names the recorded branch collision (unownedPr)", () => {
    // The operator authors `resolve_remote_collision` — but the R15-15
    // collision record reached only human surfaces (the Collision card row),
    // so at the exact moment the packet is due the model had to reconstruct
    // the collision from timeline prose. State the fact.
    seedTask("impl");
    deployRoster([{ capabilityId: "append-typed-events", mode: "direct" }]);
    expect(snapshot().unownedPr).toBeNull();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        title: "Operator drive",
        branch: "vib-1",
        github: { commits: [], changed: null, unownedPr: 232 },
      }),
      goal: "Prove the operator drives the task.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(snapshot().unownedPr).toBe(232);
  });

  it("the operator snapshot carries its own PENDING recommendations", async () => {
    await seedRecommendation();
    const pending = snapshot().recommendations!.pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("run_agent");
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
    expect(recs.declined[0]!.kind).toBe("run_agent");
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

  /**
   * Ruling 214 (F37-34). Live on SHOP-10 the operator followed ruling 210's own
   * words — "ask the reviewer, in ONE comment" — and posted "@Code Reviewer,
   * name everything you would still block on across your owned surface, now."
   * `post_comment` starts no run, so the reviewer never read it; the stranded
   * backstop then recorded a deliberate hold ("without advancing, dispatching,
   * or opening a packet") and paused coordination on the task five others were
   * waiting behind. The doctrine now names `run_agent`; this is the backstop
   * for when the tag happens anyway. Same reasoning as S5-G3 above: a visible
   * non-delivery beats a silent one.
   */
  it("an operator comment that @tags an AGENT says the agent was not reached (ruling 214)", async () => {
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@Reviewer name everything you would still block on across your owned surface, now.",
      },
      authority("supervised"),
    );
    const top = task().timeline[0]!;
    expect(top.actor.kind).toBe("operator");
    // CANARY: drop the disclosure and this comment reads as a question put to
    // the reviewer, on a timeline where nothing was ever sent to it.
    expect(top.text).toContain("is an agent, and an operator comment starts no run");
    expect(top.text).toContain("Run the agent to put this to it.");
    // …and it really did start nothing: the tag is decorative, which is the
    // whole reason the sentence has to be there.
    expect(listRunsForTask(store.db, store.slug, "VIB-1")).toHaveLength(0);
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

  it("ruling 160: a closed_by_human delivery answers the operator with the refusal and the packet path, never a retry", async () => {
    // Canary: fold `closed_by_human` into the generic "Delivery did not
    // complete" arm.
    deployRoster(DEFAULT_POLICY);
    seedTask("impl");
    const pushMock = vi.fn<typeof pushWorkspaceBranch>().mockResolvedValue({
      status: "pushed",
      branch: "vib-1",
      commits: 1,
      headSha: "c".repeat(40),
      remoteHeadBefore: null,
      workflowFiles: null,
    });
    const openPrMock = vi.fn<typeof openTaskPr>().mockResolvedValue({
      status: "closed_by_human",
      prNumber: 10,
      closedBy: "akin-ozer",
    });
    const callCtx: TaskActionContext = {
      dataRoot: store.dataRoot,
      deps: { pushWorkspaceBranch: pushMock, openTaskPr: openPrMock },
    };
    const res = await operatorDeliverForReview(
      store.db,
      callCtx,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("full"),
    );
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("Delivery was refused: No pull request was opened for VIB-1: PR #10 was closed without merging by akin-ozer");
    expect(res.message).toContain("Do not deliver again and do not ask any agent to push or open a PR");
    expect(res.message).toContain("The closed-PR recovery packet is the path");
    expect(res.message).toContain("reopening the PR on GitHub is also a valid answer");
    const rows = listAuditEvents(store.db, { action: "github.delivery.operator" });
    expect(rows.at(-1)?.details).toEqual({ status: "closed_by_human" });
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

  /**
   * Ruling 104: the operator-brevity guardrail is gone — narration reaches the
   * canonical record UNTRUNCATED (the timeline collapses it view-side). This
   * locks the WRITE PATH, not just the pure helper: a cap re-introduced
   * anywhere in writeOperatorComment fails here.
   */
  it("stores a long operator narration verbatim on the timeline (ruling 104)", async () => {
    deployWithGuardrails([
      "meaningful-comment",
      "evidence-separation",
      "no-duplicate-summary",
    ]);
    seedTask("triage");
    const long =
      "Acceptance caveat the human must read in full. " +
      "detail ".repeat(500) +
      "end.";
    const result = await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      base(long),
      authority("full"),
    );
    expect(result.outcome).toBe("done");
    const top = task().timeline[0]!;
    expect(top.type).toBe("comment");
    expect(top.text).toBe(long);
  });

  /**
   * B-FD8b: the @mention fan-out scans the PRE-trim text. A handle sitting
   * inside a fenced block that evidence-separation cuts away is gone from the
   * stored comment — the notification must not be lost with it.
   */
  it("notifies a handle that evidence-separation cut from the stored text (B-FD8b)", async () => {
    deployWithGuardrails(["meaningful-comment", "evidence-separation"]);
    seedTask("triage");
    const firstName = store.users.arda.name.split(" ")[0]!;
    const fenceBody = Array.from({ length: 30 }, (_, i) =>
      i === 17 ? `@${firstName} please decide on this line` : `log line ${i}`,
    ).join("\n");
    await operatorPostComment(
      store.db,
      { dataRoot: store.dataRoot },
      base(`Validation output:\n\`\`\`\n${fenceBody}\n\`\`\`\nDecision needed.`),
      authority("full"),
    );
    const top = task().timeline[0]!;
    // The stored record really lost the handle to the trim…
    expect(top.text).toContain("evidence-separation guardrail");
    expect(top.text).not.toContain(`@${firstName}`);
    // …but the tagged human was still notified.
    const notes = listNotifications(store.db, store.users.arda.id).filter(
      (n) => n.kind === "mention",
    );
    expect(notes).toHaveLength(1);
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
   * R26-1 — the operator's snapshot carries the task's human triage metadata
   * (priority · labels · dueDate) as advisory signals. Canary: drop any of the
   * three from `operatorSnapshot`'s payload and this fails. Pairs with the
   * "Triage signals (advisory)" prompt-note assertion in operator-run.server.test.
   */
  it("R26-1: carries the task's triage metadata (priority · labels · dueDate)", () => {
    deployScopedRoster();
    seedTask("impl");
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const file = readTaskFile(ref)!;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...file.parsed.frontmatter,
        priority: "urgent",
        labels: ["security", "hotfix"],
        dueDate: "2026-08-30",
      },
      goal: file.parsed.goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const snap = snapshot();
    // The exact fields the get_task tool exposes to the operator, and that the
    // "Triage signals (advisory)" prompt note points it at.
    expect(snap.priority).toBe("urgent");
    expect(snap.labels).toEqual(["security", "hotfix"]);
    expect(snap.dueDate).toBe("2026-08-30");
  });

  /** The common task carries the defaults — the advisory signals stay quiet. */
  it("R26-1: a plain task reports normal priority, no labels, no due date", () => {
    deployScopedRoster();
    seedTask("impl");
    const snap = snapshot();
    expect(snap.priority).toBe("normal");
    expect(snap.labels).toEqual([]);
    expect(snap.dueDate).toBeNull();
  });

  /**
   * F27-O5 — the operator gets the DERIVED review outcome and each reviewer's
   * own verdict explicitly, so it need not reconstruct review state from the
   * timeline window. Canary: drop `validation`/reviewer `verdict` and this fails.
   */
  it("F27-O5: carries the derived validation state + each reviewer's verdict", () => {
    deployScopedRoster();
    seedTask("review");
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const file = readTaskFile(ref)!;
    const rev = {
      id: "rev_o5",
      headSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      branch: "vib-1",
      createdAt: "2026-08-24T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...file.parsed.frontmatter,
        engagements: [
          { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        workRevision: rev,
        verdicts: [
          { profileId: "reviewer", revisionId: rev.id, headSha: rev.headSha, result: "approve", reason: "ok", at: "2026-08-24T01:00:00.000Z", rounds: 1 },
        ],
      },
      goal: file.parsed.goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const snap = snapshot();
    // The one required reviewer approved the current revision -> healthy.
    expect(snap.validation).toBe("healthy");
    expect(snap.reviewers.find((r) => r.profileId === "reviewer")?.verdict).toBe(
      "approve",
    );
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
          revisionDrift: { headSha: "cab10477beef1234", authored: 2, baseRefresh: null },
        },
      },
      goal: file.parsed.goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect(snapshot().pr?.revisionDrift).toEqual({
      headSha: "cab10477beef1234",
      authored: 2,
      baseRefresh: null,
    });
  });

  it("ruling 132: get_task carries the WHOLE drift record and the canonical sentence, so its read and the ceremony agree", () => {
    // Canary: emit the old `{aheadBy, headSha}` object (or an empty sentence).
    deployScopedRoster();
    seedTask("review");
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const file = readTaskFile(ref)!;
    const record = { headSha: "cab10477beef1234", authored: 0, baseRefresh: { merges: 1, commits: 4 } };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...file.parsed.frontmatter, pr: { number: 318, state: "review", title: "PR", revisionDrift: record } },
      goal: file.parsed.goal,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const pr = snapshot().pr!;
    expect(pr.revisionDrift).toEqual(record);
    expect(pr.revisionDriftSentence).toBe(describeRevisionDrift(record).sentence);
  });
});

/**
 * F21-6 — "… as a reviewer" was emitted for EVERY non-delivering dispatch. The
 * schema already distinguishes them (`!delivers && verdictCapable` makes a
 * required reviewer), and the execution profile renders the rest under
 * "SUPPORTING AGENTS". Live, the verdict-Off Web Verifier was announced "as a
 * reviewer" — a claim of acceptance-gating authority it does not hold. The
 * dispatch rework keeps the vocabulary: `operatorDispatchAgent`'s `as` word
 * still branches on the verdict grant.
 */
describe("supporting-dispatch copy branches on verdict authority (F21-6)", () => {
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

  const dispatch = (profileId: string) =>
    operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId },
      authority("supervised"),
    );

  it("a verdict-capable profile is still dispatched 'as a reviewer'", async () => {
    // Canary: hardcode "a reviewer" in `supportingRoleWord` and the next test
    // fails while this one passes — the pair is what pins the branch.
    deployVerdictRoster();
    seedTask("review");
    const r = await dispatch("reviewer");
    expect(r.message).toBe("Started a Claude run for Rev (a reviewer).");
    await interruptRunningRuns("VIB-1");
  });

  it("a verdict-INCAPABLE profile is dispatched 'as a supporting agent'", async () => {
    deployVerdictRoster();
    seedTask("review");
    const r = await dispatch("web-verifier");
    expect(r.message).toBe("Started a Claude run for Web Verifier (a supporting agent).");
    expect(r.message).not.toContain("reviewer");
    await interruptRunningRuns("VIB-1");
  });

  it("the RECOMMENDATION message carries the same distinction", async () => {
    deployVerdictRoster();
    seedTask("review");
    const recommendOnly = resolveOperatorAuthority(
      { dataRoot: store.dataRoot },
      store.slug,
      { autonomy: "supervised" },
    );
    recommendOnly.policy.set("dispatch-agents", "recommend");

    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "web-verifier" },
      recommendOnly,
    );
    expect(r.outcome).toBe("recommended");
    expect(r.message).toBe("Recommended running Web Verifier as a supporting agent.");
    const card = task().frontmatter.recommendations.at(-1)!;
    expect(card.label).toBe("Run Web Verifier");
  });

  it("prompting a verdict-incapable profile narrates it as supporting too", async () => {
    deployVerdictRoster();
    seedTask("review");
    const r = await operatorDispatchAgent(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "web-verifier",
        prompt: "verify the deployed page renders.",
      },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(r.message).toBe("Prompted @Web Verifier (a supporting agent) and started its run.");
    await interruptRunningRuns("VIB-1");
  });
});

/**
 * R20-9 / ruling 84 — the delegated-ask disclosure was PROMPT-ONLY.
 *
 * When the operator consults an agent and then brings the question to a human
 * itself, the timeline otherwise reads as if that agent never held the ask. A
 * rule the model must remember is a rule it will eventually forget, so the
 * toolkit remembers: a packet opened in the same run as a `run_agent` dispatch
 * carries the disclosure whether or not the model wrote one.
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

    const prompt = toolkit.tools.find((t) => t.name === "run_agent")!;
    await prompt.handler(
      { profileId: "developer", prompt: "Which storage backend does the repo use?", delivers: true },
      {},
    );
    await openPacket(toolkit, "The repo supports both.");

    const packet = task().packet!;
    expect(packet.body).toContain("The repo supports both.");
    expect(packet.body).toContain("the operator prompted Dev on this task");
    expect(packet.body).toContain("not by that agent");
    await interruptRunningRuns("VIB-1");
  });

  it("discloses even when the model leaves the body empty", async () => {
    deployRoster(PACKET_POLICY);
    seedTask("impl");
    const toolkit = await toolkitFor();
    const prompt = toolkit.tools.find((t) => t.name === "run_agent")!;
    await prompt.handler({ profileId: "developer", prompt: "check the repo", delivers: true }, {});
    await openPacket(toolkit, undefined);

    expect(task().packet!.body).toContain("the operator prompted Dev on this task");
    await interruptRunningRuns("VIB-1");
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

/* ---------------- R7-4 rework routing is DISCOVERABLE (reworkStages) --------- */

describe("get_task exposes the rework license the operator was never told about", () => {
  // Live failure this closes: a reviewer requested changes, and the operator
  // reported "there is no Review → In Progress transition available to me" and
  // parked the task on a human for a click. The move was legal the whole time
  // (R7-4), but `nextStages` is built from the forward-only workflow graph, so
  // the one field the operator reads to answer "where may this go?" said no.
  const snapshot = () =>
    operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("supervised"),
    );

  const seed = (validation: "failing" | "healthy") => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        validation,
        title: "Rework discoverability",
      }),
      goal: "Prove the rework license is visible.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  };

  it("offers the earlier stages while the review is failing", () => {
    deployRoster(DEFAULT_POLICY);
    seed("failing");
    const snap = snapshot();
    // Exactly the stages before the current one, in workflow order.
    expect(snap.reworkStages.map((s) => s.id)).toEqual(["triage", "ready", "impl"]);
    // And it names them, so the operator can write the move without guessing.
    expect(snap.reworkStages.at(-1)).toMatchObject({ id: "impl" });
    // The forward graph is untouched — this is an addition, not a widening.
    expect(snap.nextStages.some((s) => s.id === "impl")).toBe(false);
  });

  it("offers nothing while the review is healthy (no rework license)", () => {
    deployRoster(DEFAULT_POLICY);
    seed("healthy");
    expect(snapshot().reworkStages).toEqual([]);
  });

  it("what it offers is exactly what transition_stage accepts", async () => {
    // The guard against the two drifting apart: every stage listed must be a
    // move the operator can actually perform, directly, with no human.
    deployRoster(DEFAULT_POLICY);
    seed("failing");
    const target = snapshot().reworkStages.at(-1)!;
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: target.id },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe(target.id);
  });
});

/**
 * Ruling 135: `get_task` carries the PR head, the CURRENT unpushed record and
 * the acceptance gate's own sentence, so the operator's read and the ceremony
 * never disagree and the persona's "call `deliver_for_review` when `get_task`
 * shows `pr.unpushedRevision`" has something to read. Canary: emit `null` for
 * the record regardless of the file.
 */
describe("ruling 135: the operator snapshot and the unpushed revision", () => {
  it("carries the record, the head and the sentence; a stale record reads as nothing", () => {
    seedTask("review");
    const record = { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" as const };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...task().frontmatter,
        pr: { number: 7, state: "review" as const, title: "[VIB-1] Operator drive", headSha: "1".repeat(40), unpushedRevision: record },
        workRevision: { id: "rev_1", headSha: "9".repeat(40), treeSha: null, branch: "vib-1-work", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "dev" },
      },
      goal: "g",
      timeline: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const snapshot = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("supervised"));
    expect(snapshot.pr).toMatchObject({
      number: 7,
      headSha: "1".repeat(40),
      unpushedRevision: record,
      unpushedRevisionSentence: expect.stringContaining("Deliver the branch to push it"),
    });

    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...task().frontmatter,
        workRevision: { id: "rev_2", headSha: "7".repeat(40), treeSha: null, branch: "vib-1-work", createdAt: "2026-09-04T01:00:00.000Z", sourceProfileId: "dev" },
      },
      goal: "g",
      timeline: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const stale = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("supervised"));
    expect(stale.pr?.unpushedRevision).toBeNull();
    expect(stale.pr?.unpushedRevisionSentence).toBe("");
  });
});

/**
 * Ruling 137 (pass 34, F34-15): an acceptance offer is bound to the revision
 * it was made for and withdrawn, on the record, when a packet opens or the
 * revision is replaced.
 */
describe("ruling 137: acceptance offers are bound to a revision and withdrawn on the record", () => {
  function revision(headSha: string): WorkRevision {
    return {
      id: `rev_${headSha.slice(0, 4)}`,
      headSha,
      treeSha: headSha.split("").reverse().join(""),
      branch: "vib-1-work",
      createdAt: "2026-09-04T10:00:00.000Z",
      sourceProfileId: "developer",
      kind: "delivered",
    };
  }
  /** A delivered revision the engaged reviewer approved, with its review PR:
   *  the state an acceptance offer is made in. */
  async function deliverReviewed(headSha: string): Promise<void> {
    const rev = revision(headSha);
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.engagements = [
        { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false, verdictCapable: true },
      ];
      parsed.frontmatter.workRevision = rev;
      parsed.frontmatter.verdicts = [
        { profileId: "reviewer", revisionId: rev.id, headSha, result: "approve", reason: "clean", at: "2026-09-04T10:05:00.000Z", rounds: 1 },
      ];
      parsed.frontmatter.validation = "healthy";
      parsed.frontmatter.branch = "vib-1-work";
      parsed.frontmatter.pr = { number: 7, state: "review", title: "VIB-1 work" };
    });
  }

  it("opening a packet withdraws the standing acceptance offer and the terminal transition card, and says so", async () => {
    // Canary: delete the `withdrawAcceptanceOffers` call in operatorOpenPacket
    // and both cards outlive the packet.
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "generate-packets"),
      { capabilityId: "generate-packets", mode: "direct" },
    ]);
    seedTask("review");
    const cards: Recommendation[] = [
      { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-1 to Done", detail: "", forHeadSha: "a".repeat(40) },
      { id: "r-done", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" },
      { id: "r-run", kind: "run_agent", profileId: "developer", label: "Run Developer", detail: "" },
    ];
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.recommendations = cards;
    });
    const r = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "blocked",
        title: "Branch conflicts with main",
        options: [{ kind: "redirect", title: "Have the developer resolve the conflict" }],
      },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().packet?.title).toBe("Branch conflicts with main");
    expect(task().frontmatter.recommendations.map((x) => x.id)).toEqual(["r-run"]);
    const note = task().timeline.find((e) => e.type === "note" && e.title === "Recommendation withdrawn");
    expect(note?.actor).toEqual({ kind: "operator" });
    expect(note?.text).toContain('"Accept completion and move VIB-1 to Done"');
    expect(note?.text).toContain('"Move to Done"');
    expect(note?.text).toContain('a decision packet opened ("Branch conflicts with main")');
    const rows = listAuditEvents(store.db, { action: "task.recommendation.withdrawn" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ cause: "packet", surviving: 1 });
  });

  it("recommend accept on revision A, deliver revision B, recommend again: the stored card binds to B", async () => {
    // Canary: leave the in-place update arm of addRecommendation alone (no
    // forHeadSha re-bind) and the card keeps A.
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    await deliverReviewed("a".repeat(40));
    const first = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(first.outcome).toBe("recommended");
    const cardA = task().frontmatter.recommendations.find((x) => x.kind === "accept_completion")!;
    expect(cardA.forHeadSha).toBe("a".repeat(40));
    expect(
      listAuditEvents(store.db, { action: "task.operator.recommended_completion" })[0]!.details,
    ).toMatchObject({ forHeadSha: "a".repeat(40) });

    // Revision B lands (the reconcile's own withdrawal is covered in
    // workspace-delivery.server.test.ts); the operator recommends again.
    await deliverReviewed("b".repeat(40));
    const second = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(second.outcome).toBe("recommended");
    const cards = task().frontmatter.recommendations.filter((x) => x.kind === "accept_completion");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(cardA.id); // the same card, re-bound in place
    expect(cards[0]!.forHeadSha).toBe("b".repeat(40));
  });
});

/**
 * Ruling 138 (pass 34, U34-10): an `edit_goal` option carries `goalDraft`, the
 * proposed goal text itself; it is refused on any other kind.
 */
describe("ruling 138: edit_goal options carry an explicit goalDraft", () => {
  const packetsRoster = () =>
    deployRoster([
      ...DEFAULT_POLICY.filter((c) => c.capabilityId !== "generate-packets"),
      { capabilityId: "generate-packets", mode: "direct" },
    ]);

  it("stores goalDraft on an edit_goal option verbatim", async () => {
    // Canary: drop the goalDraft mapping in operatorOpenPacket.
    packetsRoster();
    seedTask("impl");
    const draft = "Deliver a CSV export of the board.\n\nAcceptance: every visible column downloads.";
    const r = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Scope needed",
        options: [
          { kind: "edit_goal", title: "Ship the CSV export", detail: "Add the export.", recommended: true, goalDraft: ` ${draft} ` },
          { kind: "hold_runtime_debug", title: "Hold" },
        ],
      },
      authority("full"),
    );
    expect(r.outcome).toBe("done");
    expect(task().packet?.options[0]?.goalDraft).toBe(draft);
    expect(task().packet?.options[1]?.goalDraft).toBeUndefined();
  });

  it("caps an over-long goalDraft at GOAL_DRAFT_MAX_CHARS instead of refusing it", async () => {
    packetsRoster();
    seedTask("impl");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Scope needed",
        options: [{ kind: "edit_goal", title: "Ship it", recommended: true, goalDraft: "x".repeat(GOAL_DRAFT_MAX_CHARS + 500) }],
      },
      authority("full"),
    );
    expect(task().packet?.options[0]?.goalDraft).toHaveLength(GOAL_DRAFT_MAX_CHARS);
  });

  it("the operator's snapshot reports the decided packet's awaiting stamp, so it does not re-ask", async () => {
    // Canary: drop `awaiting` from the snapshot's packet.
    packetsRoster();
    seedTask("impl");
    await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Scope needed",
        options: [{ kind: "edit_goal", title: "Specify the goal", recommended: true, goalDraft: "Deliver the export." }],
      },
      authority("full"),
    );
    const { resolvePacket } = await import("./task-actions.server");
    const before = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    expect(before.packet?.awaiting).toBeNull();
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const after = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    expect(after.packet?.awaiting).toBe("goal_edit");
  });

  it("refuses goalDraft on any other option kind, by name, and writes nothing", async () => {
    // Canary: remove the stray-draft refusal.
    packetsRoster();
    seedTask("impl");
    const r = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Pick a path",
        options: [
          { kind: "redirect", title: "Have the developer redo it", recommended: true, goalDraft: "not a goal" },
          { kind: "edit_goal", title: "Refine the goal" },
        ],
      },
      authority("full"),
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain('goalDraft only fits an edit_goal option — "Have the developer redo it" is redirect');
    expect(task().packet).toBeNull();
  });
});

/**
 * Pass 35 S15: rulings 162 and 163 (F35-12, F35-13). Live (KNC-6, KNC-20) the
 * operator moved tasks to Merge and recommended acceptance on PRs whose
 * `mergeable: conflicting` was already on the file; after a conflict rework
 * at Merge it found no route back to a stage where a reviewer could run.
 */
describe("pass 35 S15: the acceptance gate read by the operator (ruling 162) and the rework route (ruling 163)", () => {
  const HEAD = "a".repeat(40);
  function seedReviewedWithPr(stage: string, mergeable: "clean" | "conflicting"): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage,
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        branch: "vib-1-work",
        workRevision: {
          id: "rev_1",
          headSha: HEAD,
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-07-25T09:00:00.000Z",
          sourceProfileId: "developer",
        },
        engagements: [
          { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          { profileId: "reviewer", revisionId: "rev_1", headSha: HEAD, result: "approve", reason: "looks right", at: "2026-07-25T09:30:00.000Z", rounds: 1 },
        ],
        validation: "healthy",
        pr: { number: 7, state: "review", title: "[VIB-1] work", headSha: HEAD, mergeable },
      }),
      goal: "g",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function withMergeBoard(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      stages: [
        { id: "triage", name: "Triage", color: "#a5a8b5" },
        { id: "impl", name: "In Progress", color: "#7b61ff" },
        { id: "review", name: "Review", color: "#5b76fe" },
        { id: "merge", name: "Merge", color: "#187574" },
        { id: "done", name: "Done", color: "#00b473" },
      ],
      workflow: [
        { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
        { from: "impl", to: "review", boundary: "approval", by: "Operator", locked: false },
        { from: "review", to: "merge", boundary: "approval", by: "Operator", locked: false },
        { from: "merge", to: "done", boundary: "human", by: "Human", locked: true },
      ],
      // The reviewer is eligible at Review only (the k9s board's shape): no
      // verdict can be given at Merge.
      agents: file.parsed.frontmatter.agents.map((a) =>
        a.profileId === "reviewer"
          ? { ...a, definition: { ...a.definition, stages: ["review"] } }
          : a,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("ruling 162 (a): the snapshot carries `pr.mergeable` and the gate's `notAcceptableReason`; a clean PR carries null", () => {
    // Canary: drop `notAcceptableReason` from `operatorSnapshot`.
    deployRoster(DEFAULT_POLICY);
    seedReviewedWithPr("review", "conflicting");
    const snap = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    expect(snap.pr?.mergeable).toBe("conflicting");
    expect(snap.notAcceptableReason).toContain("VIB-1's review PR #7 conflicts with the base branch");
    expect(snap.notAcceptableReason).toContain("Rebase the branch and re-review, or archive the task.");
    seedReviewedWithPr("review", "clean");
    const clean = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    expect(clean.pr?.mergeable).toBe("clean");
    expect(clean.notAcceptableReason).toBeNull();
  });

  it("ruling 162 (a): accept_completion refuses with the gate's sentence on a conflicting PR and files no card", async () => {
    deployRoster(DEFAULT_POLICY);
    seedReviewedWithPr("review", "conflicting");
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("conflicts with the base branch");
    expect(task().frontmatter.recommendations).toEqual([]);
    expect(listAuditEvents(store.db, { action: "task.operator.recommended_completion" })).toHaveLength(0);
  });

  it("ruling 162 (b): the move INTO the acceptance stage is refused with the same sentence while the PR conflicts", async () => {
    // Canary: drop the `mergeStageEntryRefusal` read in operatorTransitionStage:
    // the move files a "Move the task to Review" card (the approval boundary).
    deployRoster(DEFAULT_POLICY);
    seedReviewedWithPr("impl", "conflicting");
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("full"),
    );
    expect(r.outcome).toBe("denied");
    expect(r.message).toContain("VIB-1's review PR #7 conflicts with the base branch");
    expect(r.message).toContain("VIB-1 stays at In Progress");
    expect(r.message).toContain("Open the conflict packet (update_branch_from_base)");
    expect(task().frontmatter.stage).toBe("impl");
    expect(task().frontmatter.recommendations).toEqual([]);
    // A clean PR crosses the same boundary as before (a recommendation card) —
    // and it crosses it WITH `notAcceptableReason` standing. Pass-35 cluster
    // review: the field is `acceptanceRefusalFor`, whose third gate is "this
    // task is not at the boundary yet", so it is set on every task short of the
    // acceptance stage and its own remedy is this move. The shipped tool and
    // persona texts keyed the refusal on it; only `mergeReadinessRefusal` may.
    seedReviewedWithPr("impl", "clean");
    const standing = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("full"),
    );
    expect(standing.notAcceptableReason).toContain("Move the task through the workflow first.");
    const ok = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      authority("full"),
    );
    expect(ok.outcome).toBe("recommended");
  });

  it("ruling 163 (a): Merge to Review is a rework move on `validation: changed`; Merge to In Progress is not offered", async () => {
    // Canary: require `failing` again in the operator's `isReworkMove`.
    deployRoster(DEFAULT_POLICY);
    withMergeBoard();
    seedReviewedWithPr("merge", "clean");
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (parsed) => {
      // The revision moved after the verdict: `changed`.
      parsed.frontmatter.workRevision!.id = "rev_2";
      parsed.frontmatter.workRevision!.treeSha = "u".repeat(40);
      parsed.frontmatter.validation = "changed";
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const snap = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("supervised"));
    expect(snap.reworkStages.map((s) => s.id)).toEqual(["review"]);
    const r = await operatorTransitionStage(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", reason: "the conflict rework needs its verdict" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("review");
    expect(task().frontmatter.previousStageId).toBe("merge");
  });

  it("ruling 163 (d): the acceptance refusal past the review stage names the rework move and the person's stage picker", async () => {
    deployRoster(DEFAULT_POLICY);
    withMergeBoard();
    seedReviewedWithPr("merge", "clean");
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.workRevision!.id = "rev_2";
      parsed.frontmatter.workRevision!.treeSha = "u".repeat(40);
      parsed.frontmatter.validation = "changed";
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const r = await operatorAcceptCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1" },
      authority("supervised"),
    );
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("belongs back at Review");
    expect(r.message).toContain("transition_stage");
    expect(r.message).toContain("stage picker on the task page");
  });
});

/**
 * Ruling 178 (pass 36, G36-3): the project's declared required reviewers ride
 * the snapshot, resolved to the stage and agent names the acceptance gate
 * prints, so the operator engages them instead of learning the rule from a
 * refusal at the boundary.
 */
describe("ruling 178: the snapshot carries the project's required reviewers", () => {
  it("lists each rule with its stage and agent names; an empty rule set is an empty list", async () => {
    // Canary: drop `requiredReviewers` from `operatorSnapshot`'s return.
    deployRoster(DEFAULT_POLICY);
    seedTask("review");
    expect(
      operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"))
        .requiredReviewers,
    ).toEqual([]);

    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      requiredReviewers: [{ stageId: "review", profileId: "reviewer" }],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const snap = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority("full"));
    expect(snap.requiredReviewers).toEqual([
      { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Rev" },
    ]);
  });
});

/**
 * F37-11 (pass 37): the operator could not tell whether its branch was behind
 * the base, so it planned `update_branch_from_base` on every delivery and the
 * server answered "already up to date" every time — eight of the pass's nine
 * "plan was not carried out in full" notes were that one step.
 *
 * The redundant call was DELIBERATE ("call it when you are unsure rather than
 * guessing", and a stale base is how a reviewer reads a diff against a base
 * that no longer exists), so the posture is unchanged: the field only lets the
 * operator BE less unsure. `null` is "nothing has compared them yet" and is
 * never a reason to skip the call.
 */
describe("F37-11: the operator snapshot carries the base compare", () => {
  function snapOf(): ReturnType<typeof operatorSnapshot> {
    return operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("full"),
    );
  }

  /** One `github.reconcile` observation row, shaped exactly as the reconciler
   *  writes it — the same three fields `latestReconcileSync` and
   *  `createReconcileBehindByLookup` read back. */
  function seedCompare(behindBy: number): void {
    const details = {
      branch: "vib-1",
      sync: behindBy > 0 ? "behind_main" : "synced",
      behindBy,
    };
    store.db
      .prepare(
        `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
         VALUES (?, NULL, ?, 'github.reconcile', ?)`,
      )
      .run(
        `projects/${store.slug}/tasks/VIB-1/task.md`,
        new Date().toISOString(),
        JSON.stringify(details),
      );
  }

  it("reports null when no pass has compared this task", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", branch: "vib-1" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(snapOf().baseBehindBy).toBeNull();
  });

  it("reports the reconciler's reading once one exists", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", branch: "vib-1" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedCompare(3);
    expect(snapOf().baseBehindBy).toBe(3);
  });

  it("reports 0 for a branch level with the base — the case that was being re-planned", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", branch: "vib-1" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedCompare(0);
    expect(snapOf().baseBehindBy).toBe(0);
  });
});

/**
 * Ruling 193 (F37-14, live): a required reviewer chartered to bring a Docker
 * stack up ran on a host with no `make` and no Docker. It said so in its own
 * words — "an environment/repository-baseline blocker, not a discovered
 * document-scope defect" — and the turn doctrine had exactly one answer to a
 * request-changes, so the deliverer was sent back to rework a one-file document
 * round after round over a wall no revision could move. The snapshot showed
 * only the CURRENT revision's verdict, so every round looked like the first.
 */
describe("ruling 193: the snapshot counts a reviewer's successive request_changes", () => {
  const head = "a".repeat(40);

  function writeVerdicts(
    verdicts: {
      revisionId: string;
      result: "approve" | "request_changes";
      at: string;
      /** Ruling 204: blocking rounds this reviewer spent on THIS revision. */
      rounds?: number;
    }[],
  ): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        workRevision: {
          id: verdicts.at(-1)?.revisionId ?? "rev_1",
          headSha: head,
          treeSha: "t".repeat(40),
          branch: "vib-1",
          createdAt: "2026-09-13T09:00:00.000Z",
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
        verdicts: verdicts.map((v) => ({
          profileId: "reviewer",
          revisionId: v.revisionId,
          headSha: head,
          result: v.result,
          reason: "r",
          at: v.at,
          rounds: v.rounds ?? 1,
        })),
      }),
      goal: "g",
      timeline: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function reviewerRow() {
    const snap = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      authority("full"),
    );
    return snap.reviewers.find((r) => r.profileId === "reviewer");
  }

  it("counts nothing before the reviewer has weighed in", () => {
    writeVerdicts([]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(0);
  });

  it("counts one for an ordinary first request_changes", () => {
    writeVerdicts([{ revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:10:00.000Z" }]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(1);
  });

  /**
   * Ruling 204 REVERSES this case, which ruling 193 decided the other way
   * ("counts the REVISIONS, so a re-run on the same revision is still one
   * objection"). Live on SHOP-9 that reading was exactly backwards: the
   * Integration Verifier blocked on a stack another task owns, the deliverer
   * reported it had nothing in scope to change and committed nothing, and the
   * verifier blocked the SAME revision again. No new revision is ever minted in
   * a deadlock — so a count of distinct revisions sat at 1 while the loop ran,
   * and the doctrine written to put this in front of a human could not see it.
   * The counter was keyed on the one signal that stops moving when the work
   * gets stuck. Rounds, recorded on the verdict as it is overwritten, move.
   */
  it("ruling 204: a reviewer that blocks the SAME revision twice has objected twice", () => {
    // CANARY: sum 1 per verdict row (or count revision ids, ruling 193's
    // reading) and this reads 1 — the deadlock stays invisible.
    writeVerdicts([
      { revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:20:00.000Z", rounds: 2 },
    ]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(2);
  });

  it("ruling 204: an interrupted re-review records no verdict, so it adds no round", () => {
    // The distinction ruling 193 was reaching for and got wrong by proxy: a
    // re-DISPATCH is not an objection. Only a completed review writes a verdict,
    // and only a verdict carrying the same result increments `rounds` — so the
    // count is objections, never retries.
    writeVerdicts([
      { revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:10:00.000Z" },
    ]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(1);
  });

  it("reaches 2 when the objection survives a rework — the escalation signal", () => {
    writeVerdicts([
      { revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:10:00.000Z" },
      { revisionId: "rev_2", result: "request_changes", at: "2026-09-13T09:30:00.000Z" },
    ]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(2);
  });

  it("an approve resets the run — history before it is not held against the work", () => {
    writeVerdicts([
      { revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:10:00.000Z" },
      { revisionId: "rev_2", result: "approve", at: "2026-09-13T09:30:00.000Z" },
      { revisionId: "rev_3", result: "request_changes", at: "2026-09-13T09:50:00.000Z" },
    ]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(1);
  });

  it("a standing approval counts zero", () => {
    writeVerdicts([
      { revisionId: "rev_1", result: "request_changes", at: "2026-09-13T09:10:00.000Z" },
      { revisionId: "rev_2", result: "approve", at: "2026-09-13T09:30:00.000Z" },
    ]);
    expect(reviewerRow()?.consecutiveRequestChanges).toBe(0);
  });
});
