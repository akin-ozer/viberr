import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "./rebuilder.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { listAgentDeployments } from "./agent-deployments.server";

/**
 * Live-deployment projection (agents spec §3.3 + ruling 7): derivation from
 * task assignment records by PROFILE ID, mock status vocabulary from
 * waiting state, done-stage exclusion, and the agent_runs join marking
 * engagements with live runs.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seedTasks(dataRoot: string, slug: string) {
  // review + waiting human → operator "packet open", primary "waiting on
  // human", reviewer "anchored · on call".
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      waiting: "human",
      operator: { assignedAtStageId: "triage" },
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
    }),
  });
  // impl + waiting agent → operator "coordinating", primary "working".
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "impl",
      waiting: "agent",
      operator: { assignedAtStageId: "ready" },
      specialist: { profileId: "developer", backend: "claude", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "codex", role: "Reviewer" }],
    }),
  });
  // ready + waiting none → primary "on call".
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", {
      stage: "ready",
      waiting: "none",
      operator: { assignedAtStageId: "ready" },
      specialist: { profileId: "reviewer", backend: "codex", role: "Reviewer" },
    }),
  });
  // done → contributes NOTHING even with a full crew.
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", {
      stage: "done",
      waiting: "none",
      operator: { assignedAtStageId: "triage" },
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
    }),
  });
  // triage, no operator/specialist → contributes nothing.
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-5", { stage: "triage" }),
  });
}

describe("listAgentDeployments", () => {
  it("derives engagement instances by profile id with the mock status vocabulary", () => {
    const store = setupTestStore(ctx);
    seedTasks(store.dataRoot, store.slug);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const deployments = listAgentDeployments(store.db, store.slug);
    // VIB-1: 3 · VIB-2: 3 · VIB-3: 2 · VIB-4 (done): 0 · VIB-5: 0.
    expect(deployments).toHaveLength(8);
    expect(deployments.some((d) => d.taskKey === "VIB-4")).toBe(false);
    expect(deployments.some((d) => d.taskKey === "VIB-5")).toBe(false);

    const byKey = (key: string) => deployments.filter((d) => d.taskKey === key);
    expect(byKey("VIB-1").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "packet open"],
      ["developer", "primary", "waiting on human"],
      ["reviewer", "reviewer", "anchored · on call"],
    ]);
    expect(byKey("VIB-2").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["developer", "primary", "working"],
      ["reviewer", "reviewer", "anchored · on call"],
    ]);
    expect(byKey("VIB-3").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["reviewer", "primary", "on call"],
    ]);

    // Join key is the ASSIGNMENT's profileId — the display role string is
    // carried separately (never .toLowerCase() matching).
    const primary = byKey("VIB-2").find((d) => d.engagement === "primary")!;
    expect(primary.profileId).toBe("developer");
    expect(primary.role).toBe("Developer");
    expect(primary.backend).toBe("claude");
    // Operator engagements carry no backend (rendered "orchestration").
    expect(byKey("VIB-2")[0]!.backend).toBeNull();
  });

  it("joins agent_runs: engagements with a running run are marked running", () => {
    const store = setupTestStore(ctx);
    seedTasks(store.dataRoot, store.slug);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const base = {
      projectSlug: store.slug,
      role: "Primary specialist",
      model: "m",
      sdk: "sdk",
      simulated: true,
    } as const;
    upsertRun(store.db, {
      ...base,
      id: "run_p",
      taskKey: "VIB-2",
      threadId: "primary",
      kind: "primary",
      backend: "claude",
      state: "running",
    });
    upsertRun(store.db, {
      ...base,
      id: "run_c",
      taskKey: "VIB-2",
      threadId: "c0",
      kind: "reviewer",
      backend: "codex",
      state: "running",
    });
    upsertRun(store.db, {
      ...base,
      id: "run_done",
      taskKey: "VIB-1",
      threadId: "primary",
      kind: "primary",
      backend: "codex",
      state: "finished",
    });

    const deployments = listAgentDeployments(store.db, store.slug);
    const vib2 = deployments.filter((d) => d.taskKey === "VIB-2");
    expect(vib2.find((d) => d.engagement === "primary")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "reviewer")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "operator")!.running).toBe(false);
    // A finished run does NOT mark its engagement running.
    const vib1Primary = deployments.find(
      (d) => d.taskKey === "VIB-1" && d.engagement === "primary",
    )!;
    expect(vib1Primary.running).toBe(false);
    // Status vocabulary is untouched by the join.
    expect(vib1Primary.status).toBe("waiting on human");
  });
});
