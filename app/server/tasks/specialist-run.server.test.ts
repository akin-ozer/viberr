import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "~/server/audit/audit-recorder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getRun, listRunLines } from "~/server/runtimes/run-store.server";
import { configureRunServiceForTests } from "~/server/runtimes/run-service.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  assignSpecialist,
  listDeployedSpecialists,
  startSpecialistRun,
} from "./specialist-run.server";

/**
 * Assign a deployed specialist + start a specialist run — the "deploy a
 * specialist to a task and run it" surface. Simulated engine only (no real
 * keys in tests via configureRunServiceForTests).
 */

let ctx: TestDbContext;
let store: TestStore;

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
function deployDevSpecialist(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
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
          backends: ["claude"],
          model: "claude-sonnet",
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
    expect(result).toMatchObject({ profileId: "dev", role: "developer", backend: "claude" });

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

    const audit = listAuditEvents(store.db, { action: "task.specialist.assigned" });
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
    const { interruptRun } = await import("~/server/runtimes/run-service.server");
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
    expect(file.parsed.timeline[0]!.text).toContain("Started a Claude Code run");
    const audit = listAuditEvents(store.db, { action: "task.specialist.run_started" });
    expect(audit[0]?.taskKey).toBe("VIB-1");
    const startAudit = listAuditEvents(store.db, { action: "runtime.run.started" });
    expect(startAudit.length).toBe(1); // not double-counted
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
