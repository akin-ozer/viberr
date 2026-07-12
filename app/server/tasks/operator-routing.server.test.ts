import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import {
  setupTestStore,
  writeProject,
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
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    writeProject(store.dataRoot, {
      ...project.frontmatter,
      agents: [
        {
          profileId: "claude-dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Claude developer",
            role: "Developer",
            scope: "Implementation and tests",
            backends: ["claude"],
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
            backends: ["codex"],
            model: "gpt-5.4-codex",
            stages: ["impl"],
          },
        },
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

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
  });

  afterEach(() => ctx.cleanup());

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
    expect(routing.eligible.map((candidate) => candidate.profileId)).toEqual([
      "claude-dev",
    ]);
    expect(routing.excluded).toContainEqual(
      expect.objectContaining({
        profileId: "codex-dev",
        reasons: expect.arrayContaining([
          expect.stringContaining("cannot enforce withheld local capabilities"),
        ]),
      }),
    );
    expect(routing.eligible[0]).toMatchObject({
      resources: {
        skills: ["typescript"],
        knowledgeBases: ["architecture"],
      },
      workload: { scope: "organization", activeRuns: 1, recentRuns: 3 },
      cost: {
        basis: "observed provider runs across organization (30 days)",
        runsWithUsd: 2,
        averageUsd: 0.5,
        totalUsd: 1,
      },
    });
    expect(routing.eligible[0]?.backendHealth).toHaveProperty("status");
  });
});
