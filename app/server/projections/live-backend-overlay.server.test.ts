import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Owner report 2026-08-21: the Developer profile was switched to the other
 * backend but the task page's Delivering-agent card still said "Codex" — and
 * its Run button would have started a Claude run under that label. The run
 * path already follows the LIVE deployment (specialist-run.server.ts resolves
 * the current profile and even discloses "switched from …" on the next run);
 * these cases pin that DISPLAY follows the same law: every query overlays the
 * live deployment's backend over the engage-time snapshot in task.md, and the
 * snapshot stands only for profiles no longer deployed (the run path's own
 * fallback).
 *
 * The demo seed is the fixture on purpose: VIB-151 snapshots the developer as
 * `claude` and the reviewer as `codex`, while the deployed profiles resolve to
 * codex (developer, backends ["codex","claude"]) and claude (reviewer,
 * ["claude"]) — both drifted, exactly the state a profile edit leaves behind.
 */

let app: AppTestContext;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
});
afterAll(() => app.cleanup());

describe("deployedSpecialistBackends", () => {
  it("maps each deployed specialist to the backend a run would start on; operators excluded", async () => {
    const { deployedSpecialistBackends } = await import(
      "~/server/agents/deployment-view.server"
    );
    const map = deployedSpecialistBackends("viberr-core", app.dataRoot);
    expect(map.get("developer")).toBe("codex"); // backends ["codex","claude"] → first real one
    expect(map.get("reviewer")).toBe("claude");
    expect(map.has("operator")).toBe(false);
  });

  it("an unknown project yields an empty map (display falls back to the snapshot, never throws)", async () => {
    const { deployedSpecialistBackends } = await import(
      "~/server/agents/deployment-view.server"
    );
    expect(deployedSpecialistBackends("no-such-project", app.dataRoot).size).toBe(0);
  });
});

describe("task queries overlay the live backend over the engage-time snapshot", () => {
  it("getTaskSummary: VIB-151's drifted snapshots flip to what Run would use — via the production env-root default", async () => {
    const { getTaskSummary } = await import("./task-query.server");
    // No dataRoot opt on purpose: setupAppTest sets VIBERR_DATA_ROOT, so this
    // exercises the exact default production loaders take.
    const summary = getTaskSummary(app.db, "viberr-core", "VIB-151")!;
    expect(summary.specialist).toMatchObject({
      profileId: "developer",
      backend: "codex",
      name: "Codex",
    });
    expect(summary.reviewers[0]).toMatchObject({
      profileId: "reviewer",
      backend: "claude",
      name: "Claude",
    });
  });

  it("an agreeing snapshot passes through untouched (VIB-153's developer is already codex)", async () => {
    const { getTaskSummary } = await import("./task-query.server");
    const summary = getTaskSummary(app.db, "viberr-core", "VIB-153")!;
    expect(summary.specialist).toMatchObject({ backend: "codex", name: "Codex" });
  });

  it("the board list gives the same answer as the task page (one mapping, rulings 237/297)", async () => {
    const { listProjectTasks } = await import("./board-query.server");
    const vib151 = listProjectTasks(app.db, "viberr-core").find(
      (t) => t.key === "VIB-151",
    )!;
    expect(vib151.specialist).toMatchObject({ backend: "codex", name: "Codex" });
    expect(vib151.reviewers[0]).toMatchObject({ backend: "claude" });
  });

  it("the agents-page roster chips the live backend on engagement rows", async () => {
    const { listAgentDeployments } = await import("./agent-deployments.server");
    const rows = listAgentDeployments(app.db, "viberr-core");
    const primary = rows.find(
      (r) => r.taskKey === "VIB-151" && r.engagement === "primary",
    )!;
    const reviewer = rows.find(
      (r) => r.taskKey === "VIB-151" && r.engagement === "reviewer",
    )!;
    expect(primary.backend).toBe("codex");
    expect(reviewer.backend).toBe("claude");
  });
});

describe("the owner's flow: a profile edit propagates with NO run in between", () => {
  it("switching the developer deployment to claude flips VIB-151's card instantly; undeploying restores the snapshot", async () => {
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { getTaskSummary } = await import("./task-query.server");
    const ref = { projectSlug: "viberr-core", dataRoot: app.dataRoot };

    // The profile editor's write: a deployment-definition override. Backends
    // ["claude"] is what the form persists when the admin picks Claude.
    await updateProjectFile(ref, (parsed) => {
      const dev = parsed.frontmatter.agents.find(
        (a) => a.profileId === "developer",
      )!;
      dev.definition = { backends: ["claude"] };
    });
    expect(
      getTaskSummary(app.db, "viberr-core", "VIB-151")!.specialist,
    ).toMatchObject({ backend: "claude", name: "Claude" });

    // Undeployed since engagement → the engage-time snapshot stands (VIB-151
    // snapshots the developer as claude), same fallback the run start applies.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.agents = parsed.frontmatter.agents.filter(
        (a) => a.profileId !== "developer",
      );
    });
    expect(
      getTaskSummary(app.db, "viberr-core", "VIB-151")!.specialist,
    ).toMatchObject({ backend: "claude" });

    // Restore the seeded deployment shape for any case that runs after this.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.agents.push({
        profileId: "developer",
        capabilities: [],
        extras: [],
      });
    });
    expect(
      getTaskSummary(app.db, "viberr-core", "VIB-151")!.specialist,
    ).toMatchObject({ backend: "codex" });
  });
});
