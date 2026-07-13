import { afterEach, describe, expect, it } from "vitest";
import type { StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { projectCompletionAdmissionOpen } from "~/server/runtimes/run-completion-state.server";
import { RUN_COMPLETION_PHASE } from "~/server/runtimes/run-completion-state.server";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";
import type { RuntimeAdapter } from "~/server/runtimes/adapter.server";
import {
  configureRunServiceForTests,
  startRun,
} from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { setMemberRole as setOrgMemberRole } from "~/server/auth/identity.server";
import { updateUserFields } from "~/server/auth/user-store.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import {
  deleteProject,
  removeMember,
  setProjectArchived,
  workflowForStageOrder,
} from "./settings-actions.server";
import { setMemberRole as setProjectMemberRole } from "~/features/policy/policy-actions.server";
import { recoverOwnershipCleanupIntents } from "~/server/tasks/ownership-cleanup.server";

const ctx = createTestDbContext();
afterEach(() => {
  configureRunServiceForTests();
  ctx.cleanup();
});

describe("workflowForStageOrder", () => {
  it("preserves a configured human-only intermediate boundary across reorder", () => {
    const stages = [
      { id: "triage", name: "Triage", color: "#aaa" },
      { id: "review", name: "Review", color: "#00f" },
      { id: "impl", name: "Implementation", color: "#a0a" },
      { id: "done", name: "Done", color: "#0a0" },
    ] satisfies StageDef[];
    const previous = [
      {
        from: "triage",
        to: "impl",
        boundary: "auto",
        by: "Operator",
        locked: false,
      },
      {
        from: "impl",
        to: "review",
        boundary: "human",
        by: "Human gate",
        locked: false,
      },
      {
        from: "review",
        to: "done",
        boundary: "human",
        by: "Acceptance",
        locked: true,
      },
    ] satisfies WorkflowBoundary[];

    expect(workflowForStageOrder(stages, previous)).toEqual([
      {
        from: "triage",
        to: "review",
        boundary: "human",
        by: "Human gate",
        locked: false,
      },
      {
        from: "review",
        to: "impl",
        boundary: "auto",
        by: "Operator",
        locked: false,
      },
      {
        from: "impl",
        to: "done",
        boundary: "human",
        by: "Acceptance",
        locked: true,
      },
    ]);
  });
});

describe("role-binding ownership cleanup", () => {
  function seedOwnedTasks(
    store: ReturnType<typeof setupTestStore>,
    ownerUserId: string,
  ): void {
    for (const taskKey of ["VIB-1", "VIB-2"]) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(taskKey, { ownerUserId }),
        goal: `Release ${taskKey} before role binding is removed.`,
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function owner(
    store: ReturnType<typeof setupTestStore>,
    taskKey: string,
  ): string | null {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.ownerUserId;
  }

  it("commits membership removal before owner cleanup and boot releases every seat", async () => {
    const store = setupTestStore(ctx);
    seedOwnedTasks(store, store.users.selin.id);
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let injected = false;

    await expect(
      removeMember(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          afterOwnershipCanonicalReleaseForTests: () => {
            if (!injected) {
              injected = true;
              throw new Error("injected member cleanup failure");
            }
          },
        },
      ),
    ).rejects.toThrow("injected member cleanup failure");

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.some(
        (member) => member.userId === store.users.selin.id,
      ),
    ).toBe(false);
    expect([owner(store, "VIB-1"), owner(store, "VIB-2")]).toContain(null);
    expect([owner(store, "VIB-1"), owner(store, "VIB-2")]).toContain(
      store.users.selin.id,
    );
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 0 });

    await expect(
      recoverOwnershipCleanupIntents(store.db, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toEqual({ completed: 2, cancelled: 0, errors: 0 });
    expect(owner(store, "VIB-1")).toBeNull();
    expect(owner(store, "VIB-2")).toBeNull();
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.some(
        (member) => member.userId === store.users.selin.id,
      ),
    ).toBe(false);
  });

  it("commits role demotion before owner cleanup and retry releases every seat", async () => {
    const store = setupTestStore(ctx);
    seedOwnedTasks(store, store.users.selin.id);
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let injected = false;

    await expect(
      setProjectMemberRole(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
          role: "viewer",
        },
        actor,
        {
          dataRoot: store.dataRoot,
          afterOwnershipCanonicalReleaseForTests: () => {
            if (!injected) {
              injected = true;
              throw new Error("injected role cleanup failure");
            }
          },
        },
      ),
    ).rejects.toThrow("injected role cleanup failure");

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.find(
        (member) => member.userId === store.users.selin.id,
      )?.role,
    ).toBe("viewer");
    expect([owner(store, "VIB-1"), owner(store, "VIB-2")]).toContain(null);
    expect([owner(store, "VIB-1"), owner(store, "VIB-2")]).toContain(
      store.users.selin.id,
    );
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 0 });

    await expect(
      setProjectMemberRole(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
          role: "viewer",
        },
        actor,
        { dataRoot: store.dataRoot },
      ),
    ).resolves.toMatchObject({ changed: false });
    expect(owner(store, "VIB-1")).toBeNull();
    expect(owner(store, "VIB-2")).toBeNull();
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.find(
        (member) => member.userId === store.users.selin.id,
      )?.role,
    ).toBe("viewer");
  });

  it("actor revocation before the final role write preserves every owner seat", async () => {
    const store = setupTestStore(ctx);
    seedOwnedTasks(store, store.users.selin.id);
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let revoked = false;

    await expect(
      setProjectMemberRole(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
          role: "viewer",
        },
        actor,
        {
          dataRoot: store.dataRoot,
          beforeOwnershipReleaseForTests: async () => {
            if (revoked) return;
            revoked = true;
            setOrgMemberRole(store.db, store.users.arda.id, "member");
            updateUserFields(store.db, store.users.arda.id, { role: "member" });
            await updateProjectFile(
              { projectSlug: store.slug, dataRoot: store.dataRoot },
              (parsed) => {
                const arda = parsed.frontmatter.members.find(
                  (member) => member.userId === store.users.arda.id,
                );
                if (arda) arda.role = "viewer";
              },
            );
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.find(
        (member) => member.userId === store.users.selin.id,
      )?.role,
    ).toBe("contributor");
    expect(owner(store, "VIB-1")).toBe(store.users.selin.id);
    expect(owner(store, "VIB-2")).toBe(store.users.selin.id);
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'project.member.role_changed'
             AND subject_id = ?`,
        )
        .get(store.users.selin.id),
    ).toEqual({ count: 0 });
    await expect(
      recoverOwnershipCleanupIntents(store.db, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toEqual({ completed: 0, cancelled: 2, errors: 0 });
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("target-role conflict before the final write cancels staged cleanup without stripping seats", async () => {
    const store = setupTestStore(ctx);
    seedOwnedTasks(store, store.users.selin.id);
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let changed = false;

    await expect(
      setProjectMemberRole(
        store.db,
        {
          projectSlug: store.slug,
          targetUserId: store.users.selin.id,
          role: "viewer",
        },
        actor,
        {
          dataRoot: store.dataRoot,
          beforeOwnershipReleaseForTests: async () => {
            if (changed) return;
            changed = true;
            await updateProjectFile(
              { projectSlug: store.slug, dataRoot: store.dataRoot },
              (parsed) => {
                const target = parsed.frontmatter.members.find(
                  (member) => member.userId === store.users.selin.id,
                );
                if (target) target.role = "maintainer";
              },
            );
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(owner(store, "VIB-1")).toBe(store.users.selin.id);
    expect(owner(store, "VIB-2")).toBe(store.users.selin.id);
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.members.find(
        (member) => member.userId === store.users.selin.id,
      )?.role,
    ).toBe("maintainer");
    await expect(
      recoverOwnershipCleanupIntents(store.db, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toEqual({ completed: 0, cancelled: 2, errors: 0 });
    expect(owner(store, "VIB-1")).toBe(store.users.selin.id);
    expect(owner(store, "VIB-2")).toBe(store.users.selin.id);
    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE action = 'task.ownership.admin_released'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});

describe("serialized project lifecycle", () => {
  it("reopens admission when archive fails anywhere after revocation", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          lifecycleDrainHookForTests: () => {
            throw new Error("injected archive drain failure");
          },
        },
      ),
    ).rejects.toThrow("injected archive drain failure");
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("reopens admission when delete fails anywhere after revocation", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };

    await expect(
      deleteProject(
        store.db,
        { projectSlug: store.slug, confirmName: "Viberr Core" },
        actor,
        {
          dataRoot: store.dataRoot,
          lifecycleDrainHookForTests: () => {
            throw new Error("injected delete drain failure");
          },
        },
      ),
    ).rejects.toThrow("injected delete drain failure");
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      }),
    ).not.toBeNull();
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("keeps admission revoked after an archive timeout until the provider acknowledges exit", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      goal: "Hold a provider open through the teardown deadline.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let acknowledgeExit: (() => void) | null = null;
    const held: RuntimeAdapter = {
      backend: "simulated",
      start(spec, callbacks) {
        acknowledgeExit = () =>
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: "simulated",
            simulated: true,
            sessionId: null,
          });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({
      claude: held,
      codex: held,
      simulated: held,
    });
    await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "archive-timeout",
      role: "Developer",
      kind: "primary",
      backend: "claude",
      model: "test-model",
      prompt: "hold",
      dataRoot: store.dataRoot,
    });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          lifecycleTerminationTimeoutMsForTests: 1,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);

    const exit = acknowledgeExit as (() => void) | null;
    if (!exit) throw new Error("Held provider did not start.");
    exit();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (projectCompletionAdmissionOpen(store.db, store.slug)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("does not let an older timeout continuation reopen admission under an archive retry", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      goal: "Keep the retry's revocation generation authoritative.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let acknowledgeExit: (() => void) | null = null;
    const held: RuntimeAdapter = {
      backend: "simulated",
      start(spec, callbacks) {
        acknowledgeExit = () =>
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: "simulated",
            simulated: true,
            sessionId: null,
          });
        return { runId: spec.runId, interrupt() {} };
      },
    };
    configureRunServiceForTests({
      claude: held,
      codex: held,
      simulated: held,
    });
    await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Developer",
      kind: "primary",
      backend: "claude",
      model: "test-model",
      prompt: "hold",
      dataRoot: store.dataRoot,
    });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          lifecycleTerminationTimeoutMsForTests: 1,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    let releaseRetry!: () => void;
    let announceRetry!: () => void;
    const retryPaused = new Promise<void>((resolve) => {
      announceRetry = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retry = setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      {
        dataRoot: store.dataRoot,
        beforeProjectLifecycleCommitHookForTests: async () => {
          announceRetry();
          await retryGate;
        },
      },
    );
    const exit = acknowledgeExit as (() => void) | null;
    if (!exit) throw new Error("Held provider did not start.");
    exit();
    await retryPaused;
    await Promise.resolve();
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);

    releaseRetry();
    await expect(retry).resolves.toMatchObject({ archived: true });
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);
  });

  it("revalidates project and org-admin authority at the archive commit boundary", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
      orgRole: "admin" as const,
    };

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          beforeProjectLifecycleCommitHookForTests: () => {
            const current = readProjectFile({
              projectSlug: store.slug,
              dataRoot: store.dataRoot,
            })!;
            writeProject(store.dataRoot, {
              ...current.parsed.frontmatter,
              members: current.parsed.frontmatter.members.map((member) =>
                member.userId === actor.userId
                  ? { ...member, role: "maintainer" as const }
                  : member,
              ),
            });
            setOrgMemberRole(store.db, actor.userId, "member");
            updateUserFields(store.db, actor.userId, { role: "member" });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("uses fresh org-admin emergency authority even when the request snapshot is stale", async () => {
    const store = setupTestStore(ctx);
    const current = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...current.parsed.frontmatter,
      members: current.parsed.frontmatter.members.filter(
        (member) => member.userId !== store.users.arda.id,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        {
          userId: store.users.arda.id,
          label: store.users.arda.email,
          orgRole: "member",
        },
        { dataRoot: store.dataRoot },
      ),
    ).resolves.toMatchObject({ archived: true });
  });

  it("revalidates authority before restoring an archived project", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
      orgRole: "admin" as const,
    };
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      { dataRoot: store.dataRoot },
    );

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: false },
        actor,
        {
          dataRoot: store.dataRoot,
          beforeProjectLifecycleCommitHookForTests: (operation) => {
            if (operation !== "restore") return;
            const current = readProjectFile({
              projectSlug: store.slug,
              dataRoot: store.dataRoot,
            })!;
            writeProject(store.dataRoot, {
              ...current.parsed.frontmatter,
              members: current.parsed.frontmatter.members.map((member) =>
                member.userId === actor.userId
                  ? { ...member, role: "maintainer" as const }
                  : member,
              ),
            });
            setOrgMemberRole(store.db, actor.userId, "member");
            updateUserFields(store.db, actor.userId, { role: "member" });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(true);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);
  });

  it("revalidates the typed project name at the deletion commit boundary", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await expect(
      deleteProject(
        store.db,
        { projectSlug: store.slug, confirmName: "Viberr Core" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          beforeProjectLifecycleCommitHookForTests: (operation) => {
            if (operation !== "delete") return;
            const current = readProjectFile({
              projectSlug: store.slug,
              dataRoot: store.dataRoot,
            })!;
            writeProject(store.dataRoot, {
              ...current.parsed.frontmatter,
              name: "Renamed During Drain",
            });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.name,
    ).toBe("Renamed During Drain");
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("does not abandon replayable run checkpoints before archive becomes canonical", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      goal: "Keep delivery replayable until canonical archive commit.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const stopping: RuntimeAdapter = {
      backend: "simulated",
      start(spec, callbacks) {
        return {
          runId: spec.runId,
          interrupt() {
            callbacks.onExit({
              outcome: "interrupted",
              effectiveBackend: "simulated",
              simulated: true,
              sessionId: null,
            });
          },
        };
      },
    };
    configureRunServiceForTests({
      claude: stopping,
      codex: stopping,
      simulated: stopping,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Developer",
      kind: "primary",
      backend: "claude",
      model: "test-model",
      prompt: "hold",
      dataRoot: store.dataRoot,
    });

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          beforeProjectLifecycleCommitHookForTests: () => {
            throw new Error("injected pre-commit failure");
          },
        },
      ),
    ).rejects.toThrow("injected pre-commit failure");

    expect(getRun(store.db, started.runId)?.completion_phase).toBeLessThan(
      RUN_COMPLETION_PHASE.complete,
    );
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("uses canonical lifecycle truth and reopens a restore before projection", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    await setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      { dataRoot: store.dataRoot },
    );
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: false },
        actor,
        {
          dataRoot: store.dataRoot,
          reprojectHookForTests: () => {
            throw new Error("injected restore projection failure");
          },
        },
      ),
    ).rejects.toThrow("injected restore projection failure");
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
    expect(() =>
      assertProjectActive(store.db, store.slug, { dataRoot: store.dataRoot }),
    ).not.toThrow();
    // The projection deliberately still says archived; canonical truth wins.
    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 1 });
  });

  it("rejects mutations from canonical archive truth when projection lags", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };

    await expect(
      setProjectArchived(
        store.db,
        { projectSlug: store.slug, archived: true },
        actor,
        {
          dataRoot: store.dataRoot,
          reprojectHookForTests: () => {
            throw new Error("injected archive projection failure");
          },
        },
      ),
    ).rejects.toThrow("injected archive projection failure");
    expect(
      store.db
        .prepare(`SELECT archived FROM projects WHERE slug = ?`)
        .get(store.slug),
    ).toEqual({ archived: 0 });
    expect(() =>
      assertProjectActive(store.db, store.slug, { dataRoot: store.dataRoot }),
    ).toThrow(/archived and read-only/i);
  });

  it("queues restore behind an in-flight archive without reopening admission", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let entered!: () => void;
    let release!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const drainGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const archive = setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: true },
      actor,
      {
        dataRoot: store.dataRoot,
        lifecycleDrainHookForTests: async () => {
          entered();
          await drainGate;
        },
      },
    );
    await didEnter;

    let restoreSettled = false;
    const restore = setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: false },
      actor,
      { dataRoot: store.dataRoot },
    ).then((result) => {
      restoreSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(restoreSettled).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);

    release();
    await expect(archive).resolves.toMatchObject({ archived: true });
    await expect(restore).resolves.toMatchObject({ archived: false });
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.archived,
    ).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(true);
  });

  it("queues restore behind delete and never reopens the deleted slug", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    let entered!: () => void;
    let release!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const drainGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: "Viberr Core" },
      actor,
      {
        dataRoot: store.dataRoot,
        lifecycleDrainHookForTests: async () => {
          entered();
          await drainGate;
        },
      },
    );
    await didEnter;

    let restoreSettled = false;
    const restore = setProjectArchived(
      store.db,
      { projectSlug: store.slug, archived: false },
      actor,
      { dataRoot: store.dataRoot },
    ).finally(() => {
      restoreSettled = true;
    });
    const restoreFailure = expect(restore).rejects.toMatchObject({
      status: 404,
    });
    await Promise.resolve();
    expect(restoreSettled).toBe(false);
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);

    release();
    await expect(deletion).resolves.toEqual({
      toast: 'Project "Viberr Core" deleted',
    });
    await restoreFailure;
    expect(
      readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      }),
    ).toBeNull();
    expect(projectCompletionAdmissionOpen(store.db, store.slug)).toBe(false);
  });
});
