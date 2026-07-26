import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import {
  addStage,
  removeStage,
  renameStage,
  reorderStages,
  repairProjectRepo,
  repoFootprintTasks,
} from "./settings-actions.server";

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

/* ------------- repo repair (owner ruling 2026-07-26) ------------- */

describe("repairProjectRepo — the explicit misconfiguration escape hatch", () => {
  const REPO_OK = "akin-ozer/viberr";

  async function misconfigure(store: TestStore, repo = "akin/viberr") {
    await updateProjectFile(
      { projectSlug: store.slug, dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.repo = repo;
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  function bindCredential(store: TestStore) {
    const actor = admin(store);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "github_pat_repair01" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
  }

  it("repairs owner/name (URL input tolerated), refreshes defaultBranch from the probe, audits from → to", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: {
        body: { full_name: REPO_OK, default_branch: "develop" },
      },
    });
    const result = await repairProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: `https://github.com/${REPO_OK}.git` },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.changed).toBe(true);
    expect(result.repo).toBe(REPO_OK);
    expect(result.toast).toContain("Repository repaired — akin/viberr → akin-ozer/viberr");
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.repo).toBe(REPO_OK);
    expect(fm.defaultBranch).toBe("develop");
    const audits = listAuditEvents(store.db, { action: "project.repo.updated" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      from: "akin/viberr",
      to: REPO_OK,
      probed: true,
      defaultBranch: "develop",
    });
  });

  it("REFUSES a target the bound credential cannot see — a repair must not install the next misconfiguration", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    const gh = fakeGithubFetch({}); // every route 404s
    await expect(
      repairProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: "akin-ozer/typo-again" },
        admin(store),
        { dataRoot: store.dataRoot },
        { fetchImpl: gh.fetchImpl },
      ),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing changed.
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
        .frontmatter.repo,
    ).toBe("akin/viberr");
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })).toHaveLength(0);
  });

  it("with NO credential bound the repair applies unprobed, saying so", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    const result = await repairProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(result.changed).toBe(true);
    expect(result.toast).toContain("attach a credential to verify");
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
        .frontmatter.repo,
    ).toBe(REPO_OK);
  });

  it("a project with remote footprint demands the acknowledgment", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "review",
        branch: "vib-9",
        pr: { number: 42, state: "review", title: "t" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(repoFootprintTasks(store.db, store.slug)).toBe(1);

    await expect(
      repairProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: REPO_OK },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });

    const confirmed = await repairProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK, confirmFootprint: true },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(confirmed.changed).toBe(true);
  });

  it("admin-only (edit-policy): a maintainer is refused; same-repo input is a no-op; garbage input is refused", async () => {
    const store = setupTestStore(ctx);
    await expect(
      repairProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: REPO_OK },
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const noop = await repairProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK }, // fixture already points here
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(noop.changed).toBe(false);

    await expect(
      repairProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: "not a repo" },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
