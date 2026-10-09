import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject } from "../../../test-support/test-store";
import type { ProjectFrontmatter, StageDef } from "~/schemas/project-file.schema";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getOrgSettingsView } from "./org-view.server";

const ctx = createTestDbContext();
afterEach(() => ctx.cleanup());

/** A board in the chain shape the stage editor keeps: one edge per
 *  consecutive pair, the last one a person's. */
function boardOf(stages: StageDef[]): Pick<ProjectFrontmatter, "stages" | "workflow"> {
  return {
    stages,
    workflow: stages.slice(1).map((to, i) => ({
      from: stages[i]!.id,
      to: to.id,
      boundary: i === stages.length - 2 ? "human" : "auto",
      by: "",
      locked: i === stages.length - 2,
    })),
  };
}

/**
 * Ruling 326: the global profile editor offers each live project's own
 * stages under the project's name, from this slice of the loader. A stage the
 * default workflow has is already a Default workflow chip; a board's last
 * stage is closed by a human whatever the board calls it; an archived
 * project's board is one nobody edits any more.
 */
describe("getOrgSettingsView: projectStages (ruling 326)", () => {
  it("serves each live project's stages outside the default workflow, never its last, by name", () => {
    // CANARY: drop the terminal filter and `shipped` joins Estimates' row;
    // drop the archived filter and Old Board's row comes back; drop the
    // default-id filter and `review` joins it; drop the sort and akinozer.com
    // follows Estimates (SQLite orders names binary).
    const store = setupTestStore(ctx);
    const intake: StageDef = { id: "intake", name: "Intake", color: "slate" };
    const estimate: StageDef = { id: "estimate", name: "Estimate", color: "amber" };
    const base = {
      repo: null,
      defaultBranch: "main",
      nextTaskNumber: 1,
      members: [],
      agents: [],
      credentialPolicy: null,
      guardrails: [],
      requiredReviewers: [],
      fileLeases: [],
    };
    writeProject(store.dataRoot, {
      ...base,
      name: "Estimates",
      slug: "estimates",
      taskPrefix: "EST",
      ...boardOf([
        intake,
        estimate,
        { id: "review", name: "Check", color: "blue" },
        { id: "shipped", name: "Shipped", color: "green" },
      ]),
    });
    const build: StageDef = { id: "build", name: "Build", color: "orange" };
    writeProject(store.dataRoot, {
      ...base,
      name: "akinozer.com",
      slug: "akinozer-com",
      taskPrefix: "AKN",
      ...boardOf([
        { id: "triage", name: "Triage", color: "slate" },
        build,
        { id: "review", name: "Review", color: "blue" },
        { id: "done", name: "Done", color: "green" },
      ]),
    });
    writeProject(store.dataRoot, {
      ...base,
      name: "Old Board",
      slug: "old-board",
      taskPrefix: "OLD",
      archived: true,
      ...boardOf([intake, { id: "wrap", name: "Wrap", color: "teal" }, estimate]),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // The store's own Viberr Core runs the default workflow: no row.
    expect(getOrgSettingsView(store.db, { dataRoot: store.dataRoot }).projectStages).toEqual([
      { slug: "akinozer-com", name: "akinozer.com", prefix: "AKN", stages: [build] },
      { slug: "estimates", name: "Estimates", prefix: "EST", stages: [intake, estimate] },
    ]);
  });
});
