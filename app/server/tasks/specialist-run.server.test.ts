import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  getRun,
  listRunLines,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  configureRunServiceForTests,
  startRun,
  stopRunForLifecycle,
} from "~/server/runtimes/run-service.server";
import {
  advanceRunCompletionPhase,
  RUN_COMPLETION_PHASE,
} from "~/server/runtimes/run-completion-state.server";
import {
  setBackendAvailability,
  type AdapterSet,
} from "~/server/runtimes/runtime-registry.server";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "~/server/runtimes/adapter.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { provisionIdentity } from "~/server/auth/identity.server";
import { projectDir, taskDir } from "~/server/files/file-store-root.server";
import { purgeProjectOperationalState } from "~/server/projects/project-operational-state.server";
import {
  deleteProject,
  setProjectArchived,
} from "~/features/project-settings/settings-actions.server";
import {
  acquireSpecialistWorkspaceLease,
  assignReviewer,
  assignSpecialist,
  listDeployedSpecialists,
  removeReviewer,
  releaseSpecialistWorkspaceLease,
  resolveDeployedSpecialist,
  startReviewerRun,
  startSpecialistRun,
} from "./specialist-run.server";

/**
 * Assign a deployed specialist + start a specialist run — the "deploy a
 * specialist to a task and run it" surface. Simulated engine only (no real
 * keys in tests via configureRunServiceForTests).
 */

let ctx: TestDbContext;
let store: TestStore;

class LifecycleHeldAdapter implements RuntimeAdapter {
  readonly backend = "claude" as const;
  readonly pending: Array<{ spec: RunSpec; callbacks: RunCallbacks }> = [];
  readonly interrupted: string[] = [];
  onStart: ((spec: RunSpec) => void) | null = null;
  acknowledgeInterrupt = false;

  start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
    this.pending.push({ spec, callbacks });
    this.onStart?.(spec);
    return {
      runId: spec.runId,
      interrupt: () => {
        this.interrupted.push(spec.runId);
        if (this.acknowledgeInterrupt) {
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: "claude",
            simulated: false,
            sessionId: null,
          });
        }
      },
    };
  }
}

function useHeldRealClaude(): LifecycleHeldAdapter {
  const adapter = new LifecycleHeldAdapter();
  const adapters: AdapterSet = {
    claude: adapter,
    codex: adapter,
    simulated: adapter,
  };
  configureRunServiceForTests(adapters);
  setBackendAvailability("claude", true);
  return adapter;
}

interface SameSlugRace {
  orphanRunId: string | null;
  replacementStart: ReturnType<typeof startRun> | null;
}

/** Delete the canonical project inside adapter.start(), recreate the same
 * slug/task key with a new incarnation, then open a replacement control run.
 * This makes the post-start ownership race deterministic without timers. */
function armSameSlugRecreation(adapter: LifecycleHeldAdapter): SameSlugRace {
  const originalProject = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  const race: SameSlugRace = {
    orphanRunId: null,
    replacementStart: null,
  };

  adapter.onStart = (spec) => {
    adapter.onStart = null;
    race.orphanRunId = spec.runId;

    rmSync(projectDir(store.slug, store.dataRoot), {
      recursive: true,
      force: true,
    });
    purgeProjectOperationalState(store.db, store.slug, store.dataRoot);
    writeProject(store.dataRoot, originalProject.parsed.frontmatter);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Replacement task incarnation",
        waiting: "human",
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T12:00:00.000Z",
      }),
      goal: "Exercise only the replacement project incarnation.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    race.replacementStart = startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "replacement-control",
      role: "Replacement control",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "Keep the replacement project's exact run alive.",
      dataRoot: store.dataRoot,
    });
  };

  return race;
}

/** Same replacement race, injected after the provider row exists and the
 * launcher's first post-start ownership check has passed. */
function sameSlugAttachmentHook(): {
  race: SameSlugRace;
  hook: (input: {
    projectSlug: string;
    taskKey: string;
    runId: string;
    kind: "primary" | "reviewer";
    resumed: boolean;
  }) => void;
} {
  const originalProject = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  const race: SameSlugRace = {
    orphanRunId: null,
    replacementStart: null,
  };
  return {
    race,
    hook: ({ runId }) => {
      race.orphanRunId = runId;
      rmSync(projectDir(store.slug, store.dataRoot), {
        recursive: true,
        force: true,
      });
      purgeProjectOperationalState(store.db, store.slug, store.dataRoot);
      writeProject(store.dataRoot, originalProject.parsed.frontmatter);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          ownerUserId: store.users.arda.id,
          title: "Replacement after provider start",
          waiting: "human",
          createdAt: "2026-07-13T13:00:00.000Z",
          updatedAt: "2026-07-13T13:00:00.000Z",
        }),
        goal: "The losing launch must not attach to this replacement.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      race.replacementStart = startRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: "replacement-after-attachment",
        role: "Replacement control",
        kind: "primary",
        backend: "claude",
        model: "sonnet",
        prompt: "Keep this replacement run alive.",
        dataRoot: store.dataRoot,
      });
    },
  };
}

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

/** Poll until a run has streamed at least `n` log lines (the analyze stream
 * uses a realistic 1–3s cadence, so it does not finish within a microtask
 * flush — we only need to prove the simulated fallback is streaming). */
async function waitForLines(
  runId: string,
  n = 1,
  timeoutMs = 5_000,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const count = listRunLines(store.db, runId).length;
    if (count >= n) return count;
    if (Date.now() - start > timeoutMs) return count;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Re-write the store's project.md with a deployed `dev` specialist (claude). */
function deployDevSpecialist(
  backends: ("claude" | "codex")[] = ["claude"],
  model = backends[0] === "codex" ? "gpt-5.4-codex" : "sonnet",
): void {
  const file = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    // No repo → the run skips the network clone (kept fast + offline). The
    // clone path itself is best-effort and covered by the "no repo" branch.
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        // Loose `definition` override (survives via .loose()).
        definition: {
          kind: "specialist",
          name: "dev",
          role: "developer",
          backends,
          model,
          effort: "xhigh",
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDevSpecialist();
  // A workable task (owned, in-progress) with no specialist yet.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Attach execution workspace",
    }),
    goal: "Let the operator attach a repo and run the specialist.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  configureRunServiceForTests(); // no real backend keys → simulated engine
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("listDeployedSpecialists", () => {
  it("returns the deployed dev specialist (claude backend)", () => {
    const specialists = listDeployedSpecialists(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    expect(specialists).toHaveLength(1);
    expect(specialists[0]).toMatchObject({
      id: "dev",
      name: "dev",
      role: "developer",
      backend: "claude",
      backends: ["claude"],
    });
  });
});

describe("resolveDeployedSpecialist", () => {
  it("resolves the picked model + effort from the deployment definition", () => {
    const resolved = resolveDeployedSpecialist(
      { dataRoot: store.dataRoot },
      store.slug,
      "dev",
    );
    expect(resolved).toMatchObject({
      profileId: "dev",
      backend: "claude",
      backends: ["claude"],
      model: "sonnet",
      effort: "xhigh",
    });
  });

  it("resolves an explicitly declared alternate backend with a compatible model", () => {
    deployDevSpecialist(["codex", "claude"], "gpt-5.4-codex");
    const resolved = resolveDeployedSpecialist(
      { dataRoot: store.dataRoot },
      store.slug,
      "dev",
      "claude",
    );
    expect(resolved).toMatchObject({
      profileId: "dev",
      backend: "claude",
      backends: ["codex", "claude"],
      model: defaultModelFor("claude"),
    });
  });
});

describe("assignSpecialist", () => {
  it("writes frontmatter + a typed agent event + audit", async () => {
    const result = await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({
      profileId: "dev",
      role: "developer",
      backend: "claude",
    });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.specialist).toMatchObject({
      profileId: "dev",
      backend: "claude",
      role: "developer",
    });
    const event = file.parsed.timeline[0]!;
    expect(event.type).toBe("agent");
    expect(event.text).toContain("Deployed **dev**");
    expect(event.text).toContain("primary specialist");

    const audit = listAuditEvents(store.db, {
      action: "task.specialist.assigned",
    });
    expect(audit[0]?.taskKey).toBe("VIB-1");
  });

  it("errors for an unknown / undeployed profile id", async () => {
    await expect(
      assignSpecialist(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", profileId: "nope" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an assignment backend the deployed profile does not declare", async () => {
    await expect(
      assignSpecialist(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          profileId: "dev",
          backend: "codex",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/does not declare the Codex backend/);
  });

  it("denies reviewer + viewer (admin|maintainer only)", async () => {
    for (const user of [store.users.selin, store.users.elif]) {
      await expect(
        assignSpecialist(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
          actor(user),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("allows maintainer", async () => {
    const result = await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(result.profileId).toBe("dev");
  });
});

describe("startSpecialistRun", () => {
  async function assign(): Promise<void> {
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
  }

  it("errors when no specialist is assigned", async () => {
    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a run override that the assigned profile does not declare", async () => {
    await assign();
    await expect(
      startSpecialistRun(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backendOverride: "codex",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/does not declare the Codex backend/);
  });

  it("rechecks the launching maintainer after workspace preparation before provider start", async () => {
    await assign();
    const setMuratRole = (role: "maintainer" | "viewer") => {
      const project = readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!;
      writeProject(store.dataRoot, {
        ...project.parsed.frontmatter,
        members: project.parsed.frontmatter.members.map((member) =>
          member.userId === store.users.murat.id ? { ...member, role } : member,
        ),
      });
    };

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat),
        {
          dataRoot: store.dataRoot,
          runtimeLaunchAuthorizationHookForTests: ({ kind }) => {
            if (kind === "primary") setMuratRole("viewer");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM agent_runs
              WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, "VIB-1") as { n: number }
      ).n,
    ).toBe(0);
    expect(
      listAuditEvents(store.db, { action: "runtime.run.started" }),
    ).toHaveLength(0);

    // A denied pre-start releases the process workspace lease; restoring the
    // role admits a clean retry instead of leaving a phantom running owner.
    setMuratRole("maintainer");
    const retry = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    stopRunForLifecycle(store.db, retry.runId);
  });

  it("audits the live org-admin override when authority changes at the launch boundary", async () => {
    await assign();
    const result = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      { ...actor(store.users.murat), orgRole: "member" },
      {
        dataRoot: store.dataRoot,
        runtimeLaunchAuthorizationHookForTests: ({ kind }) => {
          if (kind !== "primary") return;
          const project = readProjectFile({
            projectSlug: store.slug,
            dataRoot: store.dataRoot,
          })!;
          writeProject(store.dataRoot, {
            ...project.parsed.frontmatter,
            members: project.parsed.frontmatter.members.filter(
              (member) => member.userId !== store.users.murat.id,
            ),
          });
          // Better Auth membership is authoritative; deliberately leave the
          // legacy users.role cache as member to prove the final check uses it.
          provisionIdentity(store.db, {
            id: store.users.murat.id,
            email: store.users.murat.email,
            name: store.users.murat.name,
            passwordHash: null,
            role: "admin",
          });
        },
      },
    );
    expect(
      listAuditEvents(store.db, { action: "runtime.run.started" })[0]
        ?.details,
    ).toMatchObject({ authoritySource: "org_admin_override" });
    expect(
      listAuditEvents(store.db, {
        action: "task.specialist.run_started",
      })[0]?.details,
    ).toMatchObject({ authoritySource: "org_admin_override" });
    stopRunForLifecycle(store.db, result.runId);
  });

  it("persists an alternate assignment backend and uses it for the run", async () => {
    deployDevSpecialist(["codex", "claude"], "gpt-5.4-codex");
    const assigned = await assignSpecialist(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        backend: "claude",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(assigned.backend).toBe("claude");
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.specialist?.backend,
    ).toBe("claude");

    const started = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(started.backend).toBe("claude");
    expect(getRun(store.db, started.runId)?.backend).toBe("claude");
    const { interruptRun } =
      await import("~/server/runtimes/run-service.server");
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: started.runId },
      actor(store.users.arda),
    );
  });

  it("rejects RUNNING an already-assigned specialist at a stage it isn't eligible for (F1 run boundary)", async () => {
    // Re-deploy `dev` scoped to the REVIEW stage only, assigned to VIB-1.
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "developer",
            backends: ["claude"],
            model: "sonnet",
            effort: "xhigh",
            stages: ["review"], // eligible ONLY at review
          },
        } as never,
      ],
    });
    // VIB-1 is at `impl` (from beforeEach) with `dev` assigned — an ineligible
    // stage for this profile. Assign-time is bypassed; the RUN boundary must
    // still reject (regression for the adversarial-review F1 gap).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        specialist: { profileId: "dev", backend: "claude", role: "developer" },
      }),
      goal: "Let the operator attach a repo and run the specialist.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/not eligible/i);
  });

  it("hard-rejects Codex when omitted local capabilities cannot be enforced", async () => {
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "developer",
            backends: ["codex"],
            model: "gpt-5.4-codex",
            stages: ["impl"],
          },
        } as never,
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assign();

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/Codex cannot enforce.*create-task-branch/);
    expect(
      (
        store.db
          .prepare(
            `SELECT count(*) AS n FROM agent_runs WHERE task_key = 'VIB-1'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("fails closed when an assigned profile was undeployed", async () => {
    await assign();
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/no longer deployed|No agent .* is deployed/);
  });

  it("creates a run row with the specialist backend + a simulated stream (>0 lines)", async () => {
    await assign();
    const result = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.backend).toBe("claude");
    expect(result.simulated).toBe(true); // no real key

    const run = getRun(store.db, result.runId)!;
    expect(run.backend).toBe("claude"); // requested backend kept for glyph fidelity
    expect(run.kind).toBe("primary");
    expect(run.role).toBe("Primary specialist");
    expect(run.simulated).toBe(1);
    // The simulated fallback streams a realistic analyze transcript (>0 lines).
    const lineCount = await waitForLines(result.runId, 1);
    expect(lineCount).toBeGreaterThan(0);

    // Stop the realistic-cadence timer so it does not outlive the test.
    const { interruptRun } =
      await import("~/server/runtimes/run-service.server");
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: result.runId },
      actor(store.users.arda),
    );

    // Typed agent event + task-level audit (runtime.run.started is separate).
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.timeline[0]!.text).toContain(
      "Started a Claude Code run",
    );
    const audit = listAuditEvents(store.db, {
      action: "task.specialist.run_started",
    });
    expect(audit[0]?.taskKey).toBe("VIB-1");
    const startAudit = listAuditEvents(store.db, {
      action: "runtime.run.started",
    });
    expect(startAudit.length).toBe(1); // not double-counted
  });

  it("starts a real repo-less conversation in an isolated non-Git workdir", async () => {
    await assign();
    setBackendAvailability("claude", true);
    try {
      const result = await startSpecialistRun(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          purpose: "conversation",
          directive: "Answer this question without repository delivery.",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(result.simulated).toBe(false);
      expect(getRun(store.db, result.runId)?.run_purpose).toBe("conversation");
      const workdir = path.join(
        taskDir(store.slug, "VIB-1", store.dataRoot),
        "workspace",
        "repo-less",
      );
      expect(existsSync(workdir)).toBe(true);
      expect(existsSync(path.join(workdir, ".git"))).toBe(false);
      const task = readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed;
      expect(task.packet).toBeNull();
    } finally {
      setBackendAvailability("claude", false);
    }
  });

  it("rejects before launch when archive wins during asynchronous workspace preflight", async () => {
    await assign();
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    const adapter = useHeldRealClaude();

    const pending = startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    // The repo-less preflight still crosses an await. Mutate canonical truth
    // synchronously before that continuation so the race is deterministic.
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      archived: true,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await expect(pending).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(adapter.pending).toHaveLength(0);
    expect(
      (
        store.db.prepare(`SELECT count(*) AS n FROM agent_runs`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(after.timeline).toEqual(before.timeline);
    expect(after.frontmatter.waiting).toBe(before.frontmatter.waiting);
    expect(
      listAuditEvents(store.db, { action: "runtime.run.started" }),
    ).toHaveLength(0);
    expect(
      listAuditEvents(store.db, {
        action: "task.specialist.run_started",
      }),
    ).toHaveLength(0);
  });

  it("stops only its exact run when the project is recreated under the same slug during launch", async () => {
    await assign();
    const adapter = useHeldRealClaude();
    const race = armSameSlugRecreation(adapter);

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    const orphanRunId = race.orphanRunId;
    const replacementPromise = race.replacementStart;
    if (!orphanRunId || !replacementPromise) {
      throw new Error("Same-slug launch race did not execute.");
    }
    const replacement = await replacementPromise;

    expect(adapter.interrupted).toEqual([orphanRunId]);
    expect(getRun(store.db, orphanRunId)).toBeNull();
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    const replacementTask = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacementTask.frontmatter.waiting).toBe("human");
    expect(replacementTask.timeline).toHaveLength(0);
    expect(
      listAuditEvents(store.db, {
        action: "task.specialist.run_started",
      }),
    ).toHaveLength(0);

    // A late provider exit from the detached orphan cannot complete against or
    // mutate the replacement incarnation.
    adapter.pending
      .find(({ spec }) => spec.runId === orphanRunId)!
      .callbacks.onExit({
        outcome: "finished",
        effectiveBackend: "claude",
        simulated: false,
        sessionId: `late-${orphanRunId}`,
      });
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.timeline,
    ).toHaveLength(0);
  });

  it("admits archive teardown between provider start and primary attachment without leaving waiting/audit state", async () => {
    await assign();
    const adapter = useHeldRealClaude();
    adapter.acknowledgeInterrupt = true;
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    let archive: Promise<unknown> | null = null;
    let losingRunId: string | null = null;

    const launch = startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      {
        dataRoot: store.dataRoot,
        launchAttachmentHookForTests: ({ runId }) => {
          losingRunId = runId;
          archive = setProjectArchived(
            store.db,
            { projectSlug: store.slug, archived: true },
            actor(store.users.arda),
            { dataRoot: store.dataRoot },
          );
        },
      },
    );

    await expect(launch).rejects.toMatchObject({ code: "conflict", status: 409 });
    if (!archive || !losingRunId) throw new Error("Archive race did not execute.");
    await archive;

    expect(adapter.interrupted).toContain(losingRunId);
    expect(getRun(store.db, losingRunId)?.state).toBe("interrupted");
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(after.frontmatter.waiting).toBe(before.frontmatter.waiting);
    expect(after.timeline).toEqual(before.timeline);
    expect(
      listAuditEvents(store.db, { action: "task.specialist.run_started" }),
    ).toHaveLength(0);
  });

  it("does not attach a primary run to a same-slug replacement after the post-start check", async () => {
    await assign();
    const adapter = useHeldRealClaude();
    const { race, hook } = sameSlugAttachmentHook();

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot, launchAttachmentHookForTests: hook },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    if (!race.orphanRunId || !race.replacementStart) {
      throw new Error("Attachment replacement race did not execute.");
    }
    const replacement = await race.replacementStart;
    expect(adapter.interrupted).toContain(race.orphanRunId);
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    const replacementTask = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacementTask.frontmatter.waiting).toBe("human");
    expect(replacementTask.timeline).toHaveLength(0);
  });

  it("a directive-driven simulated report is a COMPLETION, not a bare findings summary", async () => {
    const { simulatedFinalReport } = await import("./specialist-run.server");
    for (const backend of ["claude", "codex"] as const) {
      // With an operator directive, the simulated agent must report the work DONE —
      // otherwise the operator (reading only a "findings" summary) keeps
      // re-prompting the same canned reply and spirals (the CTL-3 bug).
      const withDirective = simulatedFinalReport(
        backend,
        "@dev implement the feature and add a test",
      );
      expect(withDirective.toLowerCase()).toContain("done");
      expect(withDirective.toLowerCase()).toContain("ready to advance");
      expect(withDirective).not.toContain("Findings:");
      // Deterministic, so a repeat trips the operator's no-progress guard.
      expect(
        simulatedFinalReport(
          backend,
          "@dev implement the feature and add a test",
        ),
      ).toBe(withDirective);
      // Without a directive it is still the plain findings summary.
      expect(simulatedFinalReport(backend)).toContain("Findings:");

      // The report is ROLE-AWARE: the Reviewer is the single quality specialist
      // (it reviews the diff AND authors/runs the validation suite — Tester merged
      // in), so both "review" and "validation" roles report a verdict that covers
      // tests, not an "implemented" summary.
      const reviewReport = simulatedFinalReport(
        backend,
        "@reviewer review it",
        "Code review",
      );
      expect(reviewReport.toLowerCase()).toContain("approve");
      expect(reviewReport).toContain("VIBERR_REVIEW_VERDICT:");
      expect(reviewReport).not.toContain("implemented what you asked for");
      // A "Validation" role classifies as the Reviewer now — same verdict report,
      // which also reports the tests passing.
      const validationReport = simulatedFinalReport(
        backend,
        "@reviewer validate it",
        "Validation",
      );
      expect(validationReport.toLowerCase()).toContain("approve");
      expect(validationReport.toLowerCase()).toContain("pass");
      expect(validationReport).not.toContain("implemented what you asked for");
    }
  });

  it("denies reviewer + viewer (admin|maintainer only)", async () => {
    await assign();
    for (const user of [store.users.selin, store.users.elif]) {
      await expect(
        startSpecialistRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1" },
          actor(user),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("specialist workspace lease convergence", () => {
  function leaseInput() {
    const taskIncarnation = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.createdAt;
    if (!taskIncarnation) throw new Error("Fixture task has no incarnation.");
    return {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      taskIncarnation,
      kind: "primary" as const,
      profileId: "dev",
    };
  }

  function seedWorkspaceOwner(input: {
    id: string;
    state: "queued" | "finished";
    completionContextJson?: string;
  }): void {
    upsertRun(store.db, {
      id: input.id,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: `primary-${input.id}`,
      role: "developer",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "Claude Agent SDK",
      agentProfileId: "dev",
      taskIncarnation: leaseInput().taskIncarnation,
      state: input.state,
      ...(input.completionContextJson
        ? { completionContextJson: input.completionContextJson }
        : {}),
    });
  }

  it("blocks a restart admission behind a queued row even before launch attachment persisted context", () => {
    seedWorkspaceOwner({ id: "run_crashed_before_attach", state: "queued" });

    expect(() =>
      acquireSpecialistWorkspaceLease(store.db, leaseInput()),
    ).toThrow(/incomplete delivery or recovery/i);
  });

  it("blocks terminal incomplete delivery and reopens only after its durable checkpoint completes", () => {
    seedWorkspaceOwner({
      id: "run_incomplete_delivery",
      state: "finished",
    });

    expect(() =>
      acquireSpecialistWorkspaceLease(store.db, leaseInput()),
    ).toThrow(/incomplete delivery or recovery/i);

    advanceRunCompletionPhase(
      store.db,
      "run_incomplete_delivery",
      RUN_COMPLETION_PHASE.complete,
    );
    const lease = acquireSpecialistWorkspaceLease(store.db, leaseInput());
    releaseSpecialistWorkspaceLease(store.db, lease);
  });

  it("keeps the process lease after lifecycle stop until the provider acknowledges exit", async () => {
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const adapter = useHeldRealClaude();
    const first = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    stopRunForLifecycle(store.db, first.runId);
    expect(() =>
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).toThrow(/already has a run in progress/i);

    adapter.pending[0]!.callbacks.onExit({
      outcome: "interrupted",
      effectiveBackend: "claude",
      simulated: false,
      sessionId: null,
    });
    const second = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    adapter.acknowledgeInterrupt = true;
    stopRunForLifecycle(store.db, second.runId);
  });

  it("keeps a primary workspace leased when attachment fails until provider exit", async () => {
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const adapter = useHeldRealClaude();

    await expect(
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        {
          dataRoot: store.dataRoot,
          launchAttachmentHookForTests: () => {
            throw new Error("injected primary attachment failure");
          },
        },
      ),
    ).rejects.toThrow("injected primary attachment failure");
    expect(adapter.interrupted).toHaveLength(1);
    expect(() =>
      startSpecialistRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).toThrow(/already has a run in progress/i);

    adapter.pending[0]!.callbacks.onExit({
      outcome: "interrupted",
      effectiveBackend: "claude",
      simulated: false,
      sessionId: null,
    });
    const successor = await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    adapter.acknowledgeInterrupt = true;
    stopRunForLifecycle(store.db, successor.runId);
  });

  it("keeps a reviewer workspace leased when attachment fails until provider exit", async () => {
    await assignReviewer(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const adapter = useHeldRealClaude();

    await expect(
      startReviewerRun(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          profileId: "dev",
        },
        actor(store.users.arda),
        {
          dataRoot: store.dataRoot,
          launchAttachmentHookForTests: () => {
            throw new Error("injected reviewer attachment failure");
          },
        },
      ),
    ).rejects.toThrow("injected reviewer attachment failure");
    expect(adapter.interrupted).toHaveLength(1);
    expect(() =>
      startReviewerRun(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          profileId: "dev",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).toThrow(/already has a run in progress/i);

    adapter.pending[0]!.callbacks.onExit({
      outcome: "interrupted",
      effectiveBackend: "claude",
      simulated: false,
      sessionId: null,
    });
    const successor = await startReviewerRun(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    adapter.acknowledgeInterrupt = true;
    stopRunForLifecycle(store.db, successor.runId);
  });
});

describe("assignReviewer / removeReviewer", () => {
  it("appends to reviewers[] with a typed agent event + audit", async () => {
    const result = await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ profileId: "dev", alreadyEngaged: false });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.reviewers).toEqual([
      { profileId: "dev", backend: "claude", role: "developer" },
    ]);
    expect(file.parsed.timeline[0]!.text).toContain("Engaged **dev**");
    expect(file.parsed.timeline[0]!.text).toContain("as a reviewer");
    expect(
      listAuditEvents(store.db, { action: "task.reviewer.assigned" })[0]
        ?.taskKey,
    ).toBe("VIB-1");
  });

  it("is idempotent — a second assign is a no-op (alreadyEngaged)", async () => {
    const opts = { dataRoot: store.dataRoot };
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      opts,
    );
    const again = await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      opts,
    );
    expect(again.alreadyEngaged).toBe(true);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.reviewers).toHaveLength(1);
  });

  it("switches an engaged reviewer to another declared backend", async () => {
    deployDevSpecialist(["claude", "codex"], "sonnet");
    const opts = { dataRoot: store.dataRoot };
    await assignReviewer(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        backend: "claude",
      },
      actor(store.users.arda),
      opts,
    );
    const switched = await assignReviewer(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        backend: "codex",
      },
      actor(store.users.arda),
      opts,
    );
    expect(switched).toMatchObject({
      backend: "codex",
      alreadyEngaged: false,
    });
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.reviewers).toEqual([
      { profileId: "dev", backend: "codex", role: "developer" },
    ]);
    expect(file.parsed.timeline[0]?.text).toContain("Switched **dev**");
    expect(file.parsed.frontmatter.reviewRevision).toBeGreaterThan(1);
  });

  it("removeReviewer drops the ref (+ event/audit); missing id is a no-op", async () => {
    const opts = { dataRoot: store.dataRoot };
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      opts,
    );
    const removed = await removeReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      opts,
    );
    expect(removed.removed).toBe(true);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.reviewers).toEqual([]);
    expect(file.parsed.timeline[0]!.text).toContain(
      "Released reviewer **dev**",
    );
    expect(
      listAuditEvents(store.db, { action: "task.reviewer.removed" })[0]
        ?.taskKey,
    ).toBe("VIB-1");

    const noop = await removeReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "ghost" },
      actor(store.users.arda),
      opts,
    );
    expect(noop.removed).toBe(false);
  });

  it("denies reviewer + viewer roles (admin|maintainer only)", async () => {
    for (const user of [store.users.selin, store.users.elif]) {
      await expect(
        assignReviewer(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
          actor(user),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("rejects engaging a reviewer whose profile isn't eligible for the current stage (F1)", async () => {
    // Re-deploy `dev` scoped to REVIEW only; VIB-1 is at impl → ineligible.
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role: "developer",
            backends: ["claude"],
            model: "sonnet",
            effort: "xhigh",
            stages: ["review"],
          },
        } as never,
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      assignReviewer(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/not eligible/i);
  });
});

describe("startReviewerRun", () => {
  async function engage(): Promise<void> {
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
  }

  it("errors when the profile is not an engaged reviewer", async () => {
    await expect(
      startReviewerRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("creates a kind='reviewer' run on its own thread with a simulated stream", async () => {
    await engage();
    const result = await startReviewerRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const run = getRun(store.db, result.runId)!;
    expect(run.kind).toBe("reviewer");
    expect(run.role).toBe("Reviewer");
    expect(run.thread_id.startsWith("r0-")).toBe(true);
    expect(run.agent_profile_id).toBe("dev");
    const lineCount = await waitForLines(result.runId, 1);
    expect(lineCount).toBeGreaterThan(0);

    const { interruptRun } =
      await import("~/server/runtimes/run-service.server");
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: result.runId },
      actor(store.users.arda),
    );
    expect(
      listAuditEvents(store.db, { action: "task.reviewer.run_started" })[0]
        ?.taskKey,
    ).toBe("VIB-1");
  });

  it("starts a real repo-less reviewer conversation without governance bindings", async () => {
    await engage();
    setBackendAvailability("claude", true);
    try {
      const result = await startReviewerRun(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          profileId: "dev",
          purpose: "conversation",
          directive: "Explain the prior review note.",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(result.simulated).toBe(false);
      expect(getRun(store.db, result.runId)).toMatchObject({
        run_purpose: "conversation",
        review_evidence_fingerprint: null,
        review_head_sha: null,
      });
      expect(
        existsSync(
          path.join(
            taskDir(store.slug, "VIB-1", store.dataRoot),
            "workspace",
            "reviewer-dev",
            "repo-less",
          ),
        ),
      ).toBe(true);
    } finally {
      setBackendAvailability("claude", false);
    }
  });

  it("rejects before launch when deletion wins during asynchronous reviewer preflight", async () => {
    await engage();
    const adapter = useHeldRealClaude();

    const pending = startReviewerRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    rmSync(projectDir(store.slug, store.dataRoot), {
      recursive: true,
      force: true,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await expect(pending).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(adapter.pending).toHaveLength(0);
    expect(
      (
        store.db.prepare(`SELECT count(*) AS n FROM agent_runs`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      listAuditEvents(store.db, { action: "runtime.run.started" }),
    ).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.reviewer.run_started" }),
    ).toHaveLength(0);
  });

  it("stops a reviewer launch without touching its same-slug replacement", async () => {
    await engage();
    const adapter = useHeldRealClaude();
    const race = armSameSlugRecreation(adapter);

    await expect(
      startReviewerRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    const orphanRunId = race.orphanRunId;
    const replacementPromise = race.replacementStart;
    if (!orphanRunId || !replacementPromise) {
      throw new Error("Same-slug reviewer launch race did not execute.");
    }
    const replacement = await replacementPromise;

    expect(adapter.interrupted).toEqual([orphanRunId]);
    expect(getRun(store.db, orphanRunId)).toBeNull();
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    const replacementTask = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacementTask.frontmatter.waiting).toBe("human");
    expect(replacementTask.timeline).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "task.reviewer.run_started" }),
    ).toHaveLength(0);
  });

  it("admits delete teardown between reviewer start and attachment, stopping the exact run", async () => {
    await engage();
    const adapter = useHeldRealClaude();
    adapter.acknowledgeInterrupt = true;
    let deletion: Promise<unknown> | null = null;
    let losingRunId: string | null = null;

    const launch = startReviewerRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      {
        dataRoot: store.dataRoot,
        launchAttachmentHookForTests: ({ runId }) => {
          losingRunId = runId;
          deletion = deleteProject(
            store.db,
            { projectSlug: store.slug, confirmName: "Viberr Core" },
            actor(store.users.arda),
            { dataRoot: store.dataRoot },
          );
        },
      },
    );

    await expect(launch).rejects.toMatchObject({ code: "conflict", status: 409 });
    if (!deletion || !losingRunId) throw new Error("Delete race did not execute.");
    await deletion;

    expect(adapter.interrupted).toContain(losingRunId);
    expect(getRun(store.db, losingRunId)).toBeNull();
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }),
    ).toBeNull();
  });

  it("does not attach a reviewer run to a same-slug replacement after the post-start check", async () => {
    await engage();
    const adapter = useHeldRealClaude();
    const { race, hook } = sameSlugAttachmentHook();

    await expect(
      startReviewerRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot, launchAttachmentHookForTests: hook },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    if (!race.orphanRunId || !race.replacementStart) {
      throw new Error("Reviewer attachment replacement race did not execute.");
    }
    const replacement = await race.replacementStart;
    expect(adapter.interrupted).toContain(race.orphanRunId);
    expect(getRun(store.db, replacement.runId)?.state).toBe("running");
    const replacementTask = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacementTask.frontmatter.waiting).toBe("human");
    expect(replacementTask.timeline).toHaveLength(0);
  });

  it("posts the reviewer's reply as a comment when the run finishes (Run-button path)", async () => {
    await engage();
    const result = await startReviewerRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Let it stream, then finish it — the default reply hook (registered by
    // startReviewerRun itself, not an operator/@mention) posts the reviewer's
    // reply as an agent-authored comment. This is the "reviewer didn't comment
    // after a run" fix: the UI "Run" button path now reports back.
    await waitForLines(result.runId, 2);
    const { interruptRun } =
      await import("~/server/runtimes/run-service.server");
    interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: result.runId },
      actor(store.users.arda),
    );
    let replied = false;
    for (let i = 0; i < 120 && !replied; i++) {
      const file = readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      });
      replied = !!file?.parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      );
      if (!replied) await new Promise((r) => setTimeout(r, 25));
    }
    expect(replied).toBe(true);
  });
});
