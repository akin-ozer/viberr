import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  recordBackendRunResult,
  resetRegistryForTests,
  setBackendAvailability,
} from "~/server/runtimes/runtime-registry.server";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import { listDeployedSpecialists } from "./specialist-run.server";
import { buildOperatorRoutingContext } from "./operator-routing.server";

describe("operator routing context", () => {
  let ctx: TestDbContext;
  let store: TestStore;

  beforeEach(() => {
    ctx = createTestDbContext();
    store = setupTestStore(ctx);
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (
           id, name, transport, target, auth_json, tools_count, up,
           last_checked_at, created_at, updated_at
         ) VALUES (?, ?, 'HTTP', ?, ?, 7, 1, ?, ?, ?)`,
      )
      .run(
        "mcp_private_http",
        "private-http",
        "https://mcp.example.test",
        JSON.stringify({ Authorization: "secret://org/mcp-token" }),
        now,
        now,
        now,
      );
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    writeProject(store.dataRoot, {
      ...project.frontmatter,
      agents: [
        {
          profileId: "claude-dev",
          capabilities: [
            { capabilityId: "create-task-branch", mode: "direct" },
            { capabilityId: "commit-push-branch", mode: "direct" },
            { capabilityId: "execute-code-or-write-repo", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Claude developer",
            role: "Developer",
            scope: "Implementation and tests",
            backends: ["claude", "codex"],
            model: "sonnet",
            stages: ["impl"],
            resources: { skills: ["typescript"], kb: ["architecture"], mcps: [] },
          },
        },
        {
          profileId: "codex-dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Codex developer",
            role: "Developer",
            scope: "Implementation",
            backends: ["codex", "claude"],
            model: "gpt-5.4-codex",
            stages: ["impl"],
            resources: { skills: [], kb: [], mcps: ["private-http"] },
          },
        },
      ] as never,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("ROUTE-1", {
        stage: "impl",
        specialist: {
          profileId: "claude-dev",
          backend: "codex",
          role: "Developer",
        },
      }),
      goal: "Exercise backend-specific routing workload facts.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    resetRegistryForTests();
    setBackendAvailability("claude", true);
    setBackendAvailability("codex", true);
    recordBackendRunResult("claude", "success");
    recordBackendRunResult("codex", "failure");

    upsertRun(store.db, {
      id: "run_routing_finished",
      projectSlug: store.slug,
      taskKey: "VIB-OLD",
      threadId: "old",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      agentProfileId: "claude-dev",
      state: "finished",
      inputTokens: 900,
      outputTokens: 100,
      totalCostUsd: 0.25,
    });
    upsertRun(store.db, {
      id: "run_routing_active",
      projectSlug: store.slug,
      taskKey: "VIB-NOW",
      threadId: "active",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      agentProfileId: "claude-dev",
      state: "running",
    });
    // Routing context is organization-wide: work and cost in another project
    // still describe the same global specialist's current load.
    upsertRun(store.db, {
      id: "run_routing_other_project",
      projectSlug: "other-project",
      taskKey: "OTHER-1",
      threadId: "other",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      agentProfileId: "claude-dev",
      state: "finished",
      inputTokens: 400,
      outputTokens: 100,
      totalCostUsd: 0.75,
    });
    upsertRun(store.db, {
      id: "run_routing_codex_cost",
      projectSlug: "other-project",
      taskKey: "OTHER-CODEX",
      threadId: "codex-cost",
      role: "Primary specialist",
      kind: "primary",
      backend: "codex",
      simulated: false,
      model: "gpt-5.4-codex",
      sdk: "test",
      agentProfileId: "claude-dev",
      state: "finished",
      inputTokens: 1_800,
      outputTokens: 200,
      totalCostUsd: 1.25,
    });
    for (const backend of ["claude", "codex"] as const) {
      upsertRun(store.db, {
        id: `run_routing_simulated_${backend}`,
        projectSlug: "demo-project",
        taskKey: `DEMO-${backend}`,
        threadId: `demo-${backend}`,
        role: "Primary specialist",
        kind: "primary",
        backend,
        simulated: true,
        model: backend === "claude" ? "sonnet" : "gpt-5.4-codex",
        sdk: "simulated",
        agentProfileId: "claude-dev",
        state: "running",
        inputTokens: 90_000,
        outputTokens: 10_000,
        totalCostUsd: 99,
      });
    }
    upsertRun(store.db, {
      id: "run_routing_stale",
      projectSlug: "old-project",
      taskKey: "OLD-31",
      threadId: "stale",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      simulated: false,
      model: "sonnet",
      sdk: "test",
      agentProfileId: "claude-dev",
      state: "error",
      inputTokens: 9_000,
      outputTokens: 1_000,
      totalCostUsd: 9,
    });
    store.db
      .prepare(
        `UPDATE agent_runs
            SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days')
          WHERE id = 'run_routing_stale'`,
      )
      .run();
  });

  afterEach(() => {
    resetRegistryForTests();
    ctx.cleanup();
  });

  it("hard-filters impossible backends and exposes fit, health, workload, and observed cost without a score", () => {
    const specialists = listDeployedSpecialists(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    const routing = buildOperatorRoutingContext(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        stageId: "impl",
        purpose: "primary",
        specialists,
      },
    );

    expect(routing.decisionRule).toBe("operator_decides_no_static_score");
    expect(routing).not.toHaveProperty("score");
    expect(
      routing.eligible.map((candidate) => [
        candidate.profileId,
        candidate.backend,
      ]),
    ).toEqual([
      ["claude-dev", "claude"],
      ["claude-dev", "codex"],
      ["codex-dev", "claude"],
    ]);
    expect(routing.excluded).toContainEqual(
      expect.objectContaining({
        profileId: "codex-dev",
        backend: "codex",
        reasons: expect.arrayContaining([
          expect.stringContaining("cannot enforce withheld local capabilities"),
          expect.stringContaining("declared MCP private-http is incompatible"),
        ]),
      }),
    );
    const claudeChoice = routing.eligible.find(
      (candidate) =>
        candidate.profileId === "claude-dev" &&
        candidate.backend === "claude",
    )!;
    const codexChoice = routing.eligible.find(
      (candidate) =>
        candidate.profileId === "claude-dev" && candidate.backend === "codex",
    )!;
    const compatibleFallback = routing.eligible.find(
      (candidate) =>
        candidate.profileId === "codex-dev" &&
        candidate.backend === "claude",
    )!;
    expect(claudeChoice).toMatchObject({
      model: "sonnet",
      resources: {
        skills: ["typescript"],
        knowledgeBases: ["architecture"],
      },
      workload: {
        scope: "organization",
        activeRuns: 1,
        currentAssignments: 0,
        recentRuns: 3,
      },
      cost: {
        basis: "observed provider runs across organization (30 days)",
        runsWithUsd: 2,
        averageUsd: 0.5,
        totalUsd: 1,
      },
      backendHealth: { status: "verified" },
    });
    expect(codexChoice).toMatchObject({
      model: defaultModelFor("codex"),
      workload: { activeRuns: 0, currentAssignments: 1, recentRuns: 1 },
      cost: {
        runsWithUsd: 1,
        averageUsd: 1.25,
        totalUsd: 1.25,
        averageTokens: 2_000,
      },
      backendHealth: { status: "degraded" },
    });
    expect(compatibleFallback.backend).toBe("claude");
    expect(compatibleFallback.model).toBe(defaultModelFor("claude"));
    expect(compatibleFallback.resources.mcps).toEqual([
      {
        name: "private-http",
        configured: true,
        up: true,
        tools: 7,
        backendCompatible: true,
      },
    ]);
    // The deliberately expensive/erroring 31-day-old run is outside every
    // recent cost/token/error aggregate; ISO timestamps must compare against
    // an ISO boundary (not SQLite's space-separated datetime format).
    expect(claudeChoice.workload.recentErrors).toBe(0);
    expect(claudeChoice.cost.averageTokens).toBe(500);
    // The two simulated running/cost rows are demo history, not live workload.
    expect(claudeChoice.workload.activeRuns).toBe(1);
    expect(codexChoice.workload.activeRuns).toBe(0);
  });

  it("keeps engaged reviewers out of primary routing and the primary out of reviewer routing", () => {
    const specialists = listDeployedSpecialists(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    const primary = buildOperatorRoutingContext(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        stageId: "impl",
        purpose: "primary",
        specialists,
        reviewerProfileIds: ["claude-dev"],
      },
    );
    expect(
      primary.eligible.some(
        (candidate) => candidate.profileId === "claude-dev",
      ),
    ).toBe(false);
    expect(
      primary.excluded.filter(
        (candidate) => candidate.profileId === "claude-dev",
      ),
    ).toEqual([
      expect.objectContaining({
        backend: "claude",
        reasons: expect.arrayContaining(["already engaged as a reviewer"]),
      }),
      expect.objectContaining({
        backend: "codex",
        reasons: expect.arrayContaining(["already engaged as a reviewer"]),
      }),
    ]);

    const reviewer = buildOperatorRoutingContext(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        stageId: "impl",
        purpose: "reviewer",
        specialists,
        primaryProfileId: "claude-dev",
      },
    );
    expect(
      reviewer.eligible.some(
        (candidate) => candidate.profileId === "claude-dev",
      ),
    ).toBe(false);
    expect(
      reviewer.excluded.filter(
        (candidate) => candidate.profileId === "claude-dev",
      ),
    ).toEqual([
      expect.objectContaining({
        backend: "claude",
        reasons: expect.arrayContaining(["already the primary specialist"]),
      }),
      expect.objectContaining({
        backend: "codex",
        reasons: expect.arrayContaining(["already the primary specialist"]),
      }),
    ]);
  });
});
