import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import { addStage, removeStage, renameStage, reorderStages } from "./settings-actions.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * P13-D-1 — the stage editor maintains the transition chain.
 *
 * Before this, `addStage` mutated `frontmatter.stages` and nothing else: the new
 * column had no rule into it and none out of it, so `transitionStage` refused it
 * except as a manual admin/maintainer move and the operator's `nextStages`
 * (built purely from `workflow`) was empty — no agent could enter or leave it.
 * `removeStage` dropped every rule touching the stage and left a hole in the
 * chain; `reorderStages` left the chain describing the old column order.
 *
 * Each test here fails on the pre-fix code.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function admin(store: TestStore) {
  return { userId: store.users.arda.id, label: store.users.arda.email };
}

function workflowOf(store: TestStore): WorkflowBoundary[] {
  return readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
    .parsed.frontmatter.workflow;
}

function stageIdsOf(store: TestStore): string[] {
  return readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
    .parsed.frontmatter.stages.map((s) => s.id);
}

const edges = (workflow: readonly WorkflowBoundary[]) =>
  workflow.map((w) => [w.from, w.to, w.boundary] as const);

/** Every consecutive stage pair has a rule; no rule names a missing stage. */
function expectChainCoversStages(store: TestStore): void {
  const ids = stageIdsOf(store);
  const workflow = workflowOf(store);
  for (const w of workflow) {
    expect(ids).toContain(w.from);
    expect(ids).toContain(w.to);
  }
  for (let i = 1; i < ids.length; i += 1) {
    expect(
      workflow.some((w) => w.from === ids[i - 1] && w.to === ids[i]),
      `missing chain edge ${ids[i - 1]} → ${ids[i]}`,
    ).toBe(true);
  }
}

function setup(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

describe("addStage", () => {
  it("splices the new stage into the transition chain instead of stranding the column", async () => {
    const store = setup();
    const { stageId } = await addStage(store.db, { projectSlug: store.slug }, admin(store), {
      dataRoot: store.dataRoot,
    });

    expect(stageIdsOf(store)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      stageId,
      "done",
    ]);
    expect(edges(workflowOf(store))).toEqual([
      ["triage", "ready", "auto"],
      ["ready", "impl", "auto"],
      ["impl", "review", "approval"],
      ["review", stageId, "human"],
      [stageId, "done", "human"],
    ]);
    expectChainCoversStages(store);

    // The new stage is reachable in BOTH directions — the whole point.
    const workflow = workflowOf(store);
    expect(workflow.some((w) => w.to === stageId)).toBe(true);
    expect(workflow.some((w) => w.from === stageId)).toBe(true);
    // Only the edge that still ends at Done carries the V1 lock.
    expect(workflow.find((w) => w.to === stageId)!.locked).toBe(false);
    expect(workflow.find((w) => w.to === "done")!.locked).toBe(true);
  });

  it("two adds in a row keep extending the same chain (the second is not stranded)", async () => {
    const store = setup();
    const first = await addStage(store.db, { projectSlug: store.slug }, admin(store), {
      dataRoot: store.dataRoot,
    });
    const second = await addStage(store.db, { projectSlug: store.slug }, admin(store), {
      dataRoot: store.dataRoot,
    });
    expect(edges(workflowOf(store)).slice(3)).toEqual([
      ["review", first.stageId, "human"],
      [first.stageId, second.stageId, "human"],
      [second.stageId, "done", "human"],
    ]);
    expectChainCoversStages(store);
  });
});

describe("removeStage", () => {
  it("re-joins the neighbours and leaves no orphan rule", async () => {
    const store = setup();
    await removeStage(
      store.db,
      { projectSlug: store.slug, stageId: "impl" },
      admin(store),
      { dataRoot: store.dataRoot },
    );

    expect(stageIdsOf(store)).toEqual(["triage", "ready", "review", "done"]);
    expect(edges(workflowOf(store))).toEqual([
      ["triage", "ready", "auto"],
      // ready→impl (auto) + impl→review (approval) collapse to the STRICTER
      // boundary: removing a column must not delete the approval gate.
      ["ready", "review", "approval"],
      ["review", "done", "human"],
    ]);
    expect(
      workflowOf(store).some((w) => w.from === "impl" || w.to === "impl"),
    ).toBe(false);
    expectChainCoversStages(store);
  });

  it("removing the review stage keeps Done reachable and human-locked", async () => {
    const store = setup();
    await removeStage(
      store.db,
      { projectSlug: store.slug, stageId: "review" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const last = workflowOf(store).at(-1)!;
    expect([last.from, last.to, last.boundary, last.locked]).toEqual([
      "impl",
      "done",
      "human",
      true,
    ]);
    expectChainCoversStages(store);
  });

  it("add then remove round-trips back to the preset's 4 rules", async () => {
    const store = setup();
    const before = workflowOf(store);
    const { stageId } = await addStage(store.db, { projectSlug: store.slug }, admin(store), {
      dataRoot: store.dataRoot,
    });
    await removeStage(
      store.db,
      { projectSlug: store.slug, stageId },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(workflowOf(store)).toEqual(before);
  });
});

describe("reorderStages", () => {
  it("re-points the chain at the new column order, each stage keeping its entry gate", async () => {
    const store = setup();
    await reorderStages(
      store.db,
      {
        projectSlug: store.slug,
        orderedIds: ["triage", "review", "impl", "ready", "done"],
      },
      admin(store),
      { dataRoot: store.dataRoot },
    );

    expect(stageIdsOf(store)).toEqual([
      "triage",
      "review",
      "impl",
      "ready",
      "done",
    ]);
    expect(edges(workflowOf(store))).toEqual([
      ["triage", "review", "approval"],
      ["review", "impl", "auto"],
      ["impl", "ready", "auto"],
      ["ready", "done", "human"],
    ]);
    expectChainCoversStages(store);
  });

  it("a stage added after a reorder is still spliced in (the chain never desynced)", async () => {
    const store = setup();
    await reorderStages(
      store.db,
      {
        projectSlug: store.slug,
        orderedIds: ["triage", "review", "impl", "ready", "done"],
      },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const { stageId } = await addStage(store.db, { projectSlug: store.slug }, admin(store), {
      dataRoot: store.dataRoot,
    });
    expect(edges(workflowOf(store)).slice(-2)).toEqual([
      ["ready", stageId, "human"],
      [stageId, "done", "human"],
    ]);
    expectChainCoversStages(store);
  });
});

describe("renameStage", () => {
  it("leaves the chain alone — stage ids are immutable, so nothing can dangle", async () => {
    const store = setup();
    const before = workflowOf(store);
    await renameStage(
      store.db,
      { projectSlug: store.slug, stageId: "impl", name: "Building" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(stageIdsOf(store)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
    expect(workflowOf(store)).toEqual(before);
    expectChainCoversStages(store);
  });
});
