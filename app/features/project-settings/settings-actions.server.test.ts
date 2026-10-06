import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  approveReviewEntry,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
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
import { setupProjectedStore } from "../../../test-support/projected-store";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
import { readRepoHealth, recordRepoAccess } from "~/server/github/repo-health.server";
import { createNotification } from "~/server/projections/notifications.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { listOrgUsers } from "~/server/org/org-users.server";
import {
  addStage,
  changeProjectRepo,
  deleteProject,
  inviteMember,
  removeMember,
  removeProjectRepo,
  removeStage,
  renameStage,
  reorderStages,
  repoFootprintTasks,
  setBranchCleanup,
  setProjectRulingsKb,
  setRequiredReviewers,
  updateProjectIdentity,
  recolorStage,
} from "./settings-actions.server";
import { isStageColor } from "~/shared/workflow/stage-colors";

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

function prefixOf(store: TestStore): string {
  return readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
    .parsed.frontmatter.taskPrefix;
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

describe("addStage", () => {
  it("splices the new stage into the transition chain instead of stranding the column", async () => {
    const store = setupProjectedStore(ctx);
    const { stageId } = await addStage(store.db, { projectSlug: store.slug, name: "QA" }, admin(store), {
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
      ["impl", "review", "auto"],
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
    const store = setupProjectedStore(ctx);
    const first = await addStage(store.db, { projectSlug: store.slug, name: "QA" }, admin(store), {
      dataRoot: store.dataRoot,
    });
    const second = await addStage(store.db, { projectSlug: store.slug, name: "Staging" }, admin(store), {
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

// 2026-07-28 UX ruling: "Add stage" is name-first. A stage is a governed edge
// in the transition chain; a nameless request must not mint one.
describe("addStage names the stage (name-first)", () => {
  it("stores the caller's name instead of the old default 'New stage'", async () => {
    const store = setupProjectedStore(ctx);
    const { stageId, toast } = await addStage(
      store.db,
      { projectSlug: store.slug, name: "  QA sweep  " },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const stage = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.stages.find((s) => s.id === stageId);
    expect(stage?.name).toBe("QA sweep");
    expect(toast).toContain("QA sweep");
  });

  it("refuses an empty name and writes nothing", async () => {
    const store = setupProjectedStore(ctx);
    const before = stageIdsOf(store);
    await expect(
      addStage(store.db, { projectSlug: store.slug, name: "   " }, admin(store), {
        dataRoot: store.dataRoot,
      }),
    ).rejects.toThrow(/name is required/i);
    expect(stageIdsOf(store)).toEqual(before);
  });
});

describe("removeStage", () => {
  it("re-joins the neighbours and leaves no orphan rule", async () => {
    const store = setupProjectedStore(ctx);
    // A person approves the move into Review on this board (the Standard
    // template's is `auto` since ruling 519), so the merge has a gate to keep.
    approveReviewEntry(store);
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
    const store = setupProjectedStore(ctx);
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
    const store = setupProjectedStore(ctx);
    const before = workflowOf(store);
    const { stageId } = await addStage(store.db, { projectSlug: store.slug, name: "QA" }, admin(store), {
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

// F20-27 / F20-13 / N20-10 — the stage-write audit + disclosure + persisted color.
describe("stage writes: audit names, boundary disclosure, hex color", () => {
  it("F20-27: added records { id, name }; removed records { id, name } (renderer reads d.name)", async () => {
    const store = setupProjectedStore(ctx);
    const { stageId } = await addStage(
      store.db,
      { projectSlug: store.slug, name: "QA" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const added = listAuditEvents(store.db, { action: "project.stage.added" });
    expect(added).toHaveLength(1);
    expect(added[0]!.details).toMatchObject({ id: stageId, name: "QA" });

    await removeStage(
      store.db,
      { projectSlug: store.slug, stageId },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const removed = listAuditEvents(store.db, { action: "project.stage.removed" });
    expect(removed).toHaveLength(1);
    expect(removed[0]!.details).toMatchObject({ id: stageId, name: "QA" });
  });

  it("F20-13: removing a stage that collapses two edges to a stricter hop discloses it (toast + audit)", async () => {
    const store = setupProjectedStore(ctx);
    // A chain where a person approves the move into Review (the Standard
    // template's is `auto` since ruling 519): ready→impl (auto) + impl→review
    // (approval). Removing In Progress merges them to the STRICTER `approval`
    // — a tightening the toast and audit must name, not swallow.
    approveReviewEntry(store);
    const { toast } = await removeStage(
      store.db,
      { projectSlug: store.slug, stageId: "impl" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(toast).toContain("Ready");
    expect(toast).toContain("Review");
    expect(toast).toContain("Human approval");
    const removed = listAuditEvents(store.db, { action: "project.stage.removed" })[0]!;
    // Contract with the renderer (C-WORKFLOW-POLICY): `tightened: { from, to,
    // boundary }` as display NAMES + boundary id, alongside `{ id, name }`.
    expect(removed.details).toMatchObject({
      id: "impl",
      name: "In Progress",
      tightened: { from: "Ready", to: "Review", boundary: "approval" },
    });
  });

  it("F20-13: a removal that keeps the same boundary is NOT reported as a tightening", async () => {
    const store = setupProjectedStore(ctx);
    // Add a stage before Done then remove it: both new edges inherit review→done's
    // `human`, so the merge is `human`→`human` — no tightening.
    const { stageId } = await addStage(
      store.db,
      { projectSlug: store.slug, name: "Sign-off" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const { toast } = await removeStage(
      store.db,
      { projectSlug: store.slug, stageId },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(toast).toBe('Stage "Sign-off" removed');
    const removed = listAuditEvents(store.db, { action: "project.stage.removed" })[0]!;
    expect(removed.details).not.toHaveProperty("tightened");
  });

  it("ruling 364: a new stage takes the first preset NAME no sibling wears — project.md holds the name", async () => {
    const store = setupProjectedStore(ctx);
    const { stageId } = await addStage(
      store.db,
      { projectSlug: store.slug, name: "QA" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const stages = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.stages;
    const stage = stages.find((s) => s.id === stageId)!;
    expect(isStageColor(stage.color)).toBe(true);
    // Distinct from every sibling — the Standard template wears five presets
    // (slate/teal/violet/blue/green), so the sixth is the first default none of
    // them took.
    expect(stages.filter((s) => s.color === stage.color)).toHaveLength(1);
    expect(stage.color).toBe("amber");
  });
});

describe("recolorStage (ruling 364)", () => {
  it("writes the preset name into project.md, reprojects and audits it", async () => {
    const store = setupProjectedStore(ctx);
    const result = await recolorStage(
      store.db,
      { projectSlug: store.slug, stageId: "impl", color: "rose" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(result.changed).toBe(true);
    expect(result.toast).toContain("rose");
    const stage = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.stages.find((s) => s.id === "impl")!;
    expect(stage.color).toBe("rose");
    const audit = listAuditEvents(store.db, { action: "project.stage.recolored" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ name: "In Progress", color: "rose" });
    // The same colour again is not a change and not an audit row.
    const again = await recolorStage(
      store.db,
      { projectSlug: store.slug, stageId: "impl", color: "rose" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(again.changed).toBe(false);
    expect(listAuditEvents(store.db, { action: "project.stage.recolored" })).toHaveLength(1);
  });

  it("refuses a hex, a token and an unknown name, naming the presets", async () => {
    const store = setupProjectedStore(ctx);
    for (const wrong of ["#7b61ff", "var(--muted)", "goldenrod"]) {
      await expect(
        recolorStage(
          store.db,
          { projectSlug: store.slug, stageId: "impl", color: wrong },
          admin(store),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toThrow(/not a stage colour preset.*slate, gray, stone/);
    }
    const stage = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.stages.find((s) => s.id === "impl")!;
    expect(stage.color).toBe("violet");
  });
});

describe("reorderStages", () => {
  it("re-points the chain at the new column order, each stage keeping its entry gate", async () => {
    const store = setupProjectedStore(ctx);
    // A person approves the move into Review here, so Review's entry gate
    // differs from its neighbours' and a gate that moved with the wrong edge shows.
    approveReviewEntry(store);
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

  /**
   * The guard checked the LENGTH of the order and that every id is known — but
   * not that the ids are distinct. A payload repeating one id therefore
   * necessarily omits another: the board gains a duplicated column and
   * silently LOSES one, taking `removeStage`'s "move its tasks out first"
   * guard with it and stranding every task sitting in the dropped stage in a
   * column the project no longer defines.
   */
  it("refuses an order that repeats a stage id (and so drops another)", async () => {
    const store = setupProjectedStore(ctx);
    const before = stageIdsOf(store);

    await expect(
      reorderStages(
        store.db,
        {
          projectSlug: store.slug,
          // Right length, every id known — and `review` quietly gone.
          orderedIds: ["triage", "ready", "impl", "impl", "done"],
        },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(stageIdsOf(store)).toEqual(before);
  });

  it("a stage added after a reorder is still spliced in (the chain never desynced)", async () => {
    const store = setupProjectedStore(ctx);
    await reorderStages(
      store.db,
      {
        projectSlug: store.slug,
        orderedIds: ["triage", "review", "impl", "ready", "done"],
      },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const { stageId } = await addStage(store.db, { projectSlug: store.slug, name: "QA" }, admin(store), {
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
    const store = setupProjectedStore(ctx);
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

/* ------- repository change (owner ruling 2026-07-26, ruling 539) ------- */

/** Deploy one specialist on the store's project, its repo-write headline in `mode`. */
function deploy(store: TestStore, mode: "direct" | "off"): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [
      {
        profileId: "builder",
        capabilities: [
          { capabilityId: "execute-code-or-write-repo", mode },
          { capabilityId: "attach-evidence-references", mode: "direct" },
        ],
        extras: [],
        definition: { kind: "specialist", name: "Calculator Builder", role: "Estimate", backends: ["codex"], model: "gpt-6-luna" },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** A GitHub connection under `owner`, the instance default. Returns its PAT's id. */
function connect(store: TestStore, owner: string): string {
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: `connection · ${owner}`, token: "github_pat_connect01" },
    admin(store),
  );
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(owner, owner, pat.id, now, now);
  return pat.id;
}

describe("changeProjectRepo — the one door that changes a project's repository", () => {
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
      { userId: store.users.arda.id, label: "bot", token: "github_pat_change01" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
  }

  it("changes owner/name (URL input tolerated), refreshes defaultBranch from the probe, audits from → to", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: {
        body: { full_name: REPO_OK, default_branch: "develop" },
      },
    });
    const result = await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: `https://github.com/${REPO_OK}.git` },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.changed).toBe(true);
    expect(result.repo).toBe(REPO_OK);
    expect(result.toast).toContain("Repository changed: akin/viberr → akin-ozer/viberr");
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

  it("ruling 517: the change's probe is the reading the board shows from then on", async () => {
    // The board and Home read the last reading taken of the project's
    // repository. A change probes the new repository and used to keep that
    // answer to itself, so "akin-ozer/akin-website · repo not found" stayed on
    // the board of a project that no longer pointed there.
    const store = setupTestStore(ctx);
    await misconfigure(store, "akin-ozer/akin-website");
    bindCredential(store);
    recordRepoAccess(store.db, store.slug, {
      status: "repo_not_found",
      repo: "akin-ozer/akin-website",
    });
    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: {
        body: { full_name: REPO_OK, default_branch: "main", private: true },
      },
    });
    await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    // CANARY: drop the change's `recordRepoAccess` and this reads null: the
    // old reading is about another repository, and no reading replaced it.
    expect(readRepoHealth(store.db, store.slug)?.result).toEqual({
      status: "connected",
      repo: REPO_OK,
      remoteDefaultBranch: "main",
      private: true,
    });
  });

  it("REFUSES a target the bound credential cannot see — a change must not install the next misconfiguration", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    const gh = fakeGithubFetch({}); // every route 404s
    await expect(
      changeProjectRepo(
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

  it("F20-15: REFUSES a repo the credential can only READ where an agent writes it, and takes it where none does (ruling 669)", async () => {
    // Repo is VISIBLE (res.ok) but the token's computed permissions say no push —
    // the octocat/Hello-World live case. `res.ok` alone must not adopt it for a
    // board that delivers through its repository. CANARY: require push of
    // every board and a results board cannot change the repository its agents
    // only read, though it could attach it; require it of none and a board
    // whose agent commits adopts a repository it cannot push to.
    const gh = fakeGithubFetch({
      [`GET /repos/octocat/Hello-World`]: {
        body: {
          full_name: "octocat/Hello-World",
          default_branch: "master",
          permissions: { admin: false, maintain: false, push: false },
        },
      },
    });
    const change = (store: TestStore) =>
      changeProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: "octocat/Hello-World" },
        admin(store),
        { dataRoot: store.dataRoot },
        { fetchImpl: gh.fetchImpl },
      );

    const writes = setupTestStore(ctx);
    await misconfigure(writes);
    deploy(writes, "direct");
    bindCredential(writes);
    await expect(change(writes)).rejects.toMatchObject({
      status: 400,
      userMessage:
        "The attached credential can see octocat/Hello-World but cannot push to it. A project needs write access to open branches and PRs. Grant the token write access (or pick a repo you own), then try again. Nothing was changed.",
    });
    // Nothing changed, nothing audited.
    expect(
      readProjectFile({ projectSlug: writes.slug, dataRoot: writes.dataRoot })!.parsed
        .frontmatter.repo,
    ).toBe("akin/viberr");
    expect(listAuditEvents(writes.db, { action: "project.repo.updated" })).toHaveLength(0);

    const reads = setupTestStore(ctx);
    await misconfigure(reads);
    deploy(reads, "off");
    bindCredential(reads);
    expect((await change(reads)).changed).toBe(true);
    expect(readRepoHealth(reads.db, reads.slug)?.result).toMatchObject({
      status: "connected",
      repo: "octocat/Hello-World",
      readOnly: true,
    });
  });

  it("F20-15: ACCEPTS a repo the credential can push to (permissions.push true)", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: {
        body: {
          full_name: REPO_OK,
          default_branch: "main",
          permissions: { admin: false, maintain: false, push: true },
        },
      },
    });
    const result = await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.changed).toBe(true);
  });

  it("ruling 669: with NO credential bound it is checked with a connection, takes GitHub's default branch and binds that connection", async () => {
    // The `defaultBranch` on file is the repository's the project is leaving.
    // A change that wrote the new one unchecked kept it, and ruling 128's
    // bootstrap would then create that branch on the new repository and make
    // it the default there. CANARY: restore the unchecked write and
    // `defaultBranch` stays `main` on a repository whose default is `trunk`,
    // with no credential bound and no reading taken.
    const store = setupTestStore(ctx);
    await misconfigure(store);
    const patId = connect(store, "akin-ozer");
    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: {
        body: { full_name: REPO_OK, default_branch: "trunk", private: true, permissions: { push: true } },
      },
    });
    const result = await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(result).toEqual({
      toast:
        "Repository changed: akin/viberr → akin-ozer/viberr (default branch trunk), checked and bound with akin-ozer's connection",
      changed: true,
      repo: REPO_OK,
    });
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter,
    ).toMatchObject({ repo: REPO_OK, defaultBranch: "trunk" });
    expect(
      store.db.prepare(`SELECT pat_id FROM project_github_credentials WHERE project_slug = ?`).get(store.slug),
    ).toEqual({ pat_id: patId });
    expect(readRepoHealth(store.db, store.slug)?.result).toMatchObject({
      status: "connected",
      repo: REPO_OK,
      remoteDefaultBranch: "trunk",
    });
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })[0]!.details).toMatchObject({
      from: "akin/viberr",
      to: REPO_OK,
      probed: true,
      defaultBranch: "trunk",
      connection: "akin-ozer",
    });
  });

  it("ruling 669: REFUSES with no credential and no connection to check it with, and a repository GitHub names no default branch for", async () => {
    // Nothing is written unchecked. CANARY: let the first through and a
    // typo'd repository is written with the default branch of the one the
    // project left; let the second through and that branch is the one tasks
    // on the new repository start from.
    const projectRepo = (store: TestStore) =>
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.repo;
    const bare = setupTestStore(ctx);
    await misconfigure(bare);
    await expect(
      changeProjectRepo(bare.db, { projectSlug: bare.slug, repo: REPO_OK }, admin(bare), { dataRoot: bare.dataRoot }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "This project has no credential attached, so changing to akin-ozer/viberr needs a GitHub connection to check it with. Add one in Instance settings → GitHub connections, then change the repository here. Nothing was changed.",
    });
    expect(projectRepo(bare)).toBe("akin/viberr");
    expect(listAuditEvents(bare.db, { action: "project.repo.updated" })).toHaveLength(0);

    const bound = setupTestStore(ctx);
    await misconfigure(bound);
    bindCredential(bound);
    const gh = fakeGithubFetch({ [`GET /repos/${REPO_OK}`]: { body: { full_name: REPO_OK } } });
    await expect(
      changeProjectRepo(
        bound.db,
        { projectSlug: bound.slug, repo: REPO_OK },
        admin(bound),
        { dataRoot: bound.dataRoot },
        { fetchImpl: gh.fetchImpl },
      ),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "GitHub named no default branch for akin-ozer/viberr, so Viberr cannot tell which branch tasks start from. Nothing was changed.",
    });
    expect(projectRepo(bound)).toBe("akin/viberr");
  });

  it("a project with remote footprint demands the acknowledgment", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "review",
        branch: "vib-9",
        pr: { number: 42, state: "review", title: "t" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(repoFootprintTasks(store.db, store.slug)).toBe(1);

    // The refusal's count and verb agree, as the dialog's note does.
    await expect(
      changeProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: REPO_OK },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "1 task in this project carries branch/PR records against akin/viberr. Confirm the change to proceed; those records keep their history but future sync runs against akin-ozer/viberr.",
    });

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-10", {
        stage: "review",
        branch: "vib-10",
        pr: { number: 43, state: "review", title: "t" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(repoFootprintTasks(store.db, store.slug)).toBe(2);
    await expect(
      changeProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: REPO_OK },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "2 tasks in this project carry branch/PR records against akin/viberr. Confirm the change to proceed; those records keep their history but future sync runs against akin-ozer/viberr.",
    });

    const gh = fakeGithubFetch({
      [`GET /repos/${REPO_OK}`]: { body: { full_name: REPO_OK, default_branch: "main" } },
    });
    const confirmed = await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK, confirmFootprint: true },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(confirmed.changed).toBe(true);
  });

  it("admin-only (edit-policy): a maintainer is refused; same-repo input is a no-op; garbage input is refused", async () => {
    const store = setupTestStore(ctx);
    await expect(
      changeProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: REPO_OK },
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    const noop = await changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK }, // fixture already points here
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(noop.changed).toBe(false);

    await expect(
      changeProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: "not a repo" },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * Ruling 667 (owner, 2026-10-06): a board that delivers results needs no
 * repository, and until this door a project could change its repository and
 * never be without one. The AWS calculator board kept a repository through
 * ten rounds of work that committed nothing to it.
 */
describe("removeProjectRepo — the door that takes a project's repository away (ruling 667)", () => {
  const ctxOf = (store: TestStore) => ({ dataRoot: store.dataRoot });

  it("removes the repository, unbinds the credential, forgets its reading and audits the removal", async () => {
    // CANARY: leave the credential bound, or the reading on file, and a board
    // with no repository keeps a token pointed at nothing and a pill about it.
    const store = setupTestStore(ctx);
    deploy(store, "off");
    const actor = admin(store);
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "github_pat_remove01" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    recordRepoAccess(store.db, store.slug, { status: "connected", repo: "akin-ozer/viberr", remoteDefaultBranch: "main", private: true });
    // A finished task keeps the branch it recorded: history, not a blocker.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "done", branch: "vib-9", pr: { number: 12, state: "merged", title: "t" } }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const result = await removeProjectRepo(store.db, { projectSlug: store.slug }, actor, ctxOf(store));
    expect(result).toEqual({
      toast: "Repository removed: akin-ozer/viberr. Tasks are delivered as the files their agents save on them",
      changed: true,
    });
    expect(readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.repo).toBeNull();
    // The row itself, not `readRepoHealth`: that already reads a reading of
    // another repository as none, and the same repository attached again
    // would bring a kept row back as its current reading.
    expect(
      store.db
        .prepare(`SELECT COUNT(*) AS c FROM project_github_health WHERE project_slug = ?`)
        .get(store.slug),
    ).toEqual({ c: 0 });
    expect(listAuditEvents(store.db, { action: "github.credential.cleared" })).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "project.repo.removed" })[0]!.details).toEqual({
      from: "akin-ozer/viberr",
      credentialUnbound: true,
    });
    // A second removal has nothing to take.
    expect(await removeProjectRepo(store.db, { projectSlug: store.slug }, actor, ctxOf(store))).toEqual({
      toast: "This project has no repository",
      changed: false,
    });
  });

  it("refuses while an agent may write the repository, or a task's work on it is unfinished, and changes nothing", async () => {
    // CANARY: drop the writer check and a software board loses the repository
    // its Developer commits to; drop the unfinished-work check, or narrow it
    // to `review`, and a pull request accepted with its merge pending, or a
    // delivered revision nobody has accepted, is left with no repository to
    // merge into.
    const store = setupTestStore(ctx);
    deploy(store, "direct");
    await expect(
      removeProjectRepo(store.db, { projectSlug: store.slug }, admin(store), ctxOf(store)),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        'Calculator Builder may write akin-ozer/viberr, so this board delivers through it. Withhold "Execute code or write to the repo" from that agent on the Agents page first, or change the repository instead. Nothing was changed.',
    });

    deploy(store, "off");
    const sha = "a".repeat(40);
    const unfinished: [string, Parameters<typeof baseTaskFrontmatter>[1]][] = [
      // Under review.
      ["VIB-10", { stage: "review", branch: "vib-10", pr: { number: 43, state: "review", title: "t" } }],
      // Accepted into Done with the merge left to a person.
      ["VIB-11", { stage: "done", branch: "vib-11", pr: { number: 44, state: "accepted", title: "t" } }],
      // Delivered, not yet pushed to a pull request or accepted.
      [
        "VIB-12",
        {
          stage: "impl",
          branch: "vib-12",
          workRevision: { id: "rev_1", headSha: sha, treeSha: null, branch: "vib-12", createdAt: "2026-10-06T09:00:00.000Z", sourceProfileId: "builder" },
        },
      ],
    ];
    for (const [key, patch] of unfinished) {
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, patch) });
      rebuildAll(store.db, { dataRoot: store.dataRoot });
      await expect(
        removeProjectRepo(store.db, { projectSlug: store.slug }, admin(store), ctxOf(store)),
        key,
      ).rejects.toMatchObject({
        status: 400,
        userMessage: `${key} has unfinished work on akin-ozer/viberr: a pull request still open, or a delivered revision not yet accepted. Merge or close it, or archive the task, then remove the repository. Nothing was changed.`,
      });
      // Archived, the task no longer holds the repository.
      writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, { ...patch, archived: true }) });
      rebuildAll(store.db, { dataRoot: store.dataRoot });
    }
    expect(readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.repo).toBe("akin-ozer/viberr");

    // The tier of the change: a maintainer is refused.
    await expect(
      removeProjectRepo(
        store.db,
        { projectSlug: store.slug },
        { userId: store.users.murat.id, label: store.users.murat.email },
        ctxOf(store),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * Ruling 667: a project with no repository takes one through the Change door.
 * It has no credential to probe with, and an attach that skipped the probe
 * kept the placeholder `defaultBranch: main`: on a repository whose default is
 * `master`, ruling 128's bootstrap would then create `main` and make it the
 * repository's default branch.
 */
describe("changeProjectRepo attaches a repository to a project that has none (ruling 667)", () => {
  const REPO = "acme/site";
  /** A project with no repository, and (unless told otherwise) an `acme` connection. */
  function repoLess(connection = true) {
    const store = setupTestStore(ctx);
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, { ...file.parsed.frontmatter, repo: null, defaultBranch: "main" });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    return { store, patId: connection ? connect(store, "acme") : null };
  }
  const attach = (store: TestStore, routes: Parameters<typeof fakeGithubFetch>[0]) =>
    changeProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
  const projectOf = (store: TestStore) =>
    readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;

  it("checks it with the owner's connection, takes GitHub's default branch and binds that connection", async () => {
    // CANARY: write the repository without the probe and `defaultBranch`
    // stays `main` on a repository whose default is `master`; skip the bind
    // and the project is left with a repository and no credential.
    const { store, patId } = repoLess();
    const result = await attach(store, {
      [`GET /repos/${REPO}`]: { body: { full_name: REPO, default_branch: "master", private: true, permissions: { push: true } } },
    });
    expect(result).toEqual({
      toast: "Repository attached: acme/site (default branch master), checked and bound with acme's connection",
      changed: true,
      repo: REPO,
    });
    expect(projectOf(store)).toMatchObject({ repo: REPO, defaultBranch: "master" });
    expect(
      store.db.prepare(`SELECT pat_id FROM project_github_credentials WHERE project_slug = ?`).get(store.slug),
    ).toEqual({ pat_id: patId });
    expect(readRepoHealth(store.db, store.slug)?.result).toMatchObject({ status: "connected", repo: REPO, remoteDefaultBranch: "master" });
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })[0]!.details).toMatchObject({
      from: null,
      to: REPO,
      probed: true,
      defaultBranch: "master",
      connection: "acme",
    });
  });

  it("refuses with no connection to check it with, and on a repository the token cannot see, changing nothing", async () => {
    // CANARY: let either through and a typo'd repository is attached.
    const bare = repoLess(false).store;
    await expect(attach(bare, {})).rejects.toMatchObject({
      status: 400,
      userMessage:
        "Attaching acme/site needs a GitHub connection to check it with. Add one in Instance settings → GitHub connections, then attach the repository here. Nothing was changed.",
    });
    expect(projectOf(bare).repo).toBeNull();

    const { store } = repoLess();
    await expect(
      attach(store, { [`GET /repos/${REPO}`]: { status: 404, body: { message: "Not Found" } } }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "The acme connection's token cannot see acme/site. Check the owner/name, the token's repository access, or a pending organization approval. Nothing was changed.",
    });
    expect(projectOf(store).repo).toBeNull();
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })).toHaveLength(0);
  });

  it("takes a repository its token can only read when no agent writes it, and refuses one when an agent does", async () => {
    // A board that delivers results attaches a repository for its agents to
    // read. CANARY: require push for every attach and it cannot; require it
    // for none and a board whose Developer commits is bound to a repository
    // it cannot push to.
    const readOnly = {
      [`GET /repos/${REPO}`]: { body: { full_name: REPO, default_branch: "main", permissions: { push: false, admin: false, maintain: false } } },
    };
    const { store } = repoLess();
    expect((await attach(store, readOnly)).changed).toBe(true);
    expect(readRepoHealth(store.db, store.slug)?.result).toMatchObject({ status: "connected", readOnly: true });

    const writer = repoLess().store;
    deploy(writer, "direct");
    await expect(attach(writer, readOnly)).rejects.toMatchObject({
      status: 400,
      userMessage:
        "The acme connection's token can see acme/site but cannot push to it. A project needs write access to open branches and PRs. Grant the token write access (or pick a repo you own), then try again. Nothing was changed.",
    });
    expect(projectOf(writer).repo).toBeNull();
  });
});

/**
 * R15-6 (owner ruling 2026-07-28): post-merge branch cleanup is a per-project
 * setting, default ON. Persisted as a project.md guardrail row, so it travels
 * with the file like every other per-project switch.
 */
describe("setBranchCleanup (R15-6)", () => {
  it("defaults ON for a project that has never touched the setting", () => {
    const store = setupProjectedStore(ctx);
    // Fails on main: `branchCleanupOnMerge` did not exist — nothing deleted a
    // merged task's branch, on any project.
    expect(branchCleanupOnMerge(store.db, store.slug)).toBe(true);
  });

  it("persists the opt-out into project.md and the projection", async () => {
    const store = setupProjectedStore(ctx);
    const result = await setBranchCleanup(
      store.db,
      { projectSlug: store.slug, enabled: false },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(result.enabled).toBe(false);
    expect(result.toast).toContain("kept on GitHub");

    const guardrails = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.guardrails;
    expect(guardrails.find((g) => g.id === "delete-branch-after-merge")).toMatchObject(
      { on: false },
    );
    expect(branchCleanupOnMerge(store.db, store.slug)).toBe(false);
    expect(
      listAuditEvents(store.db, { action: "project.settings.updated" }),
    ).toHaveLength(1);
  });

  it("turning it back on rewrites the single row, never a duplicate", async () => {
    const store = setupProjectedStore(ctx);
    const actor = admin(store);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    await setBranchCleanup(store.db, { projectSlug: store.slug, enabled: false }, actor, ref);
    await setBranchCleanup(store.db, { projectSlug: store.slug, enabled: true }, actor, ref);
    const guardrails = readProjectFile(ref)!.parsed.frontmatter.guardrails.filter(
      (g) => g.id === "delete-branch-after-merge",
    );
    expect(guardrails).toHaveLength(1);
    expect(guardrails[0]!.on).toBe(true);
    expect(branchCleanupOnMerge(store.db, store.slug)).toBe(true);
  });

  it("refuses a non-admin — this is policy, not credential hygiene", async () => {
    const store = setupProjectedStore(ctx);
    await expect(
      setBranchCleanup(
        store.db,
        { projectSlug: store.slug, enabled: false },
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// F20-12 / N20-6 — inviting an unknown email must mint a USABLE account and the
// toast must not claim an email was sent (there is no mailer, ruling 13).
describe("inviteMember", () => {
  it("F20-12: an unknown email mints a temp-password account (usable + setup-pending), not a passwordless one", async () => {
    const store = setupProjectedStore(ctx);
    const result = await inviteMember(
      store.db,
      { projectSlug: store.slug, name: "New Person", email: "probe.nobody@viberr.dev" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    // A temp password was minted (the same ceremony Allow-access uses).
    expect(result.tempPassword).toBeDefined();
    expect(result.tempPassword!.length).toBeGreaterThanOrEqual(8);

    const record = findUserByEmail(store.db, "probe.nobody@viberr.dev")!;
    // Usable: a credential exists and a reset is required at first sign-in — so
    // `statusOf` reads "setup pending", not the old healthy "active".
    expect(record.hasPassword).toBe(true);
    expect(record.pwresetRequired).toBe(true);
    const view = listOrgUsers(store.db).find((u) => u.id === record.id)!;
    expect(view.status).toBe("invited");
  });

  it("N20-6: the toast says what happened, never 'Invite sent' (no mailer)", async () => {
    const store = setupProjectedStore(ctx);
    const result = await inviteMember(
      store.db,
      { projectSlug: store.slug, name: "New Person", email: "someone@viberr.dev" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(result.toast).toContain("Added someone@viberr.dev");
    expect(result.toast).toContain("Viewer");
    expect(result.toast).not.toContain("Invite sent");
  });

  it("C4: the role reaches the member row, the audit row and the toast", async () => {
    // Canary: hardcode `viewer` again — all three go back to Viewer.
    const store = setupProjectedStore(ctx);
    const result = await inviteMember(
      store.db,
      { projectSlug: store.slug, name: "Deniz", email: store.users.deniz.email, role: "maintainer" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(result.toast).toBe(`Added ${store.users.deniz.email}, who joins as Maintainer`);
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const member = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.members.find((m) => m.userId === store.users.deniz.id)!;
    expect(member.role).toBe("maintainer");
    expect(
      listAuditEvents(store.db, { action: "project.member.invited" })[0]!.details,
    ).toMatchObject({ role: "maintainer" });
  });

  it("C4: an unknown role is refused by name and nothing is written", async () => {
    const store = setupProjectedStore(ctx);
    await expect(
      inviteMember(
        store.db,
        { projectSlug: store.slug, name: "Deniz", email: store.users.deniz.email, role: "owner" },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow("Unknown project role.");
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
        .parsed.frontmatter.members.some((m) => m.userId === store.users.deniz.id),
    ).toBe(false);
  });

  it("an already-registered email is added without minting a second account", async () => {
    const store = setupProjectedStore(ctx);
    const result = await inviteMember(
      store.db,
      { projectSlug: store.slug, name: "Deniz", email: store.users.deniz.email },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    // No new account → no temp password to hand over.
    expect(result.tempPassword).toBeUndefined();
    expect(result.toast).toBe(`Added ${store.users.deniz.email}, who joins as Viewer`);
  });
});

/**
 * Pass 34 review: one prefix a project cannot take. It was `GOAL`, because the
 * dependency grammar (ruling 131) read `GOAL-1` as a goal chain's reference
 * missing its link; since ruling 503 it is `EPIC`, because an epic's id is
 * `epic-1` and tasks keyed EPIC-1 would read as epics wherever they are named.
 */
describe("the reserved task prefix", () => {
  it("refuses EPIC, in any casing, and leaves the stored prefix alone", async () => {
    // Canary: drop the isReservedTaskPrefix guard in updateProjectIdentity —
    // the project takes the prefix and its task keys read as epic ids.
    const store = setupProjectedStore(ctx);
    const fileCtx = { dataRoot: store.dataRoot };
    for (const typed of ["EPIC", "epic", "Epic"]) {
      await expect(
        updateProjectIdentity(
          store.db,
          { projectSlug: store.slug, name: "Viberr Core", prefix: typed, description: "" },
          admin(store),
          fileCtx,
        ),
      ).rejects.toThrow(/not available as a task prefix/i);
    }
    expect(prefixOf(store)).toBe("VIB");
    // The prefix ruling 503 freed is fine now: `GOAL-1` is a task key again.
    const ok = await updateProjectIdentity(
      store.db,
      { projectSlug: store.slug, name: "Viberr Core", prefix: "GOAL", description: "" },
      admin(store),
      fileCtx,
    );
    expect(ok.changed).toBe(true);
    expect(prefixOf(store)).toBe("GOAL");
  });
});

describe("deleteProject leaves no app-owned rows behind", () => {
  it("clears the credential binding and the cached repo probe with the project", async () => {
    // Neither table has an FK to `projects` and a rebuild deliberately does not
    // touch them, so both outlived the delete. The binding is the one with
    // visible fallout: the connections panel counts these rows per PAT to
    // report how many projects a connection is bound to, so an orphan made
    // that count — and the removal disclosure built on it — plainly wrong.
    // Canary: drop clearProjectCredential / deleteRepoHealth from
    // deleteProject and both counts below come back non-zero.
    const store = setupTestStore(ctx);
    const actor = admin(store);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "github_pat_delete01" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    recordRepoAccess(store.db, store.slug, {
      status: "connected",
      repo: "acme/app",
      remoteDefaultBranch: "main",
      private: false,
    });

    const bound = () =>
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM project_github_credentials WHERE pat_id = ?`,
        )
        .get(pat.id);
    const health = () =>
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM project_github_health WHERE project_slug = ?`,
        )
        .get(store.slug);
    expect(bound()).toEqual({ c: 1 });
    expect(health()).toEqual({ c: 1 });

    const name = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.name;
    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: name },
      actor,
      { dataRoot: store.dataRoot },
    );

    // The PAT itself survives — it belongs to the person, not the project.
    expect(bound(), "no orphan inflating the bound-projects count").toEqual({ c: 0 });
    expect(health(), "no stale probe for a slug that may be reused").toEqual({ c: 0 });
    expect(
      store.db.prepare(`SELECT COUNT(*) AS c FROM github_pats WHERE id = ?`).get(pat.id),
    ).toEqual({ c: 1 });
  });
});

/**
 * Ruling 274 (pass 37, F37-107): `controller_conversations` is the fourth
 * app-owned table with no FK cascade, and the only one whose orphan is worse
 * than stale. A conversation's `project_slug` is what the controller
 * toolkit's `slugOf()` DEFAULTS to, so a conversation left bound to a deleted
 * slug acts on whatever comes back under it — and a slug comes back the
 * ordinary way, by creating a project with the same name.
 */
describe("deleteProject releases the conversations bound to it (ruling 274)", () => {
  it("unbinds them to instance scope, keeps the transcript, and says why", async () => {
    const store = setupTestStore(ctx);
    const actor = admin(store);
    const { createConversation, appendMessage, getConversation, listMessages } =
      await import("~/server/controller/controller-conversations.server");
    const bound = createConversation(store.db, {
      userId: store.users.arda.id,
      userLabel: "arda@viberr.dev",
      projectSlug: store.slug,
    });
    appendMessage(store.db, {
      conversationId: bound.id,
      author: "user",
      userId: store.users.arda.id,
      text: "What is on this board?",
    });
    // An instance conversation must not be touched by a project's delete.
    const instance = createConversation(store.db, {
      userId: store.users.arda.id,
      userLabel: "arda@viberr.dev",
      projectSlug: null,
    });

    const name = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.name;
    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: name },
      actor,
      { dataRoot: store.dataRoot },
    );

    // CANARY: drop `releaseProjectConversations` from deleteProject and this
    // conversation keeps pointing at the dead slug — so recreating a project
    // under that name silently hands it this transcript AND makes every
    // unqualified board tool in it act on the new project.
    const after = getConversation(store.db, bound.id)!;
    expect(after.projectSlug).toBeNull();
    expect(after.taskKey).toBeNull();
    // The record is kept: this product does not destroy transcripts.
    const messages = listMessages(store.db, bound.id);
    expect(messages.some((m) => m.text === "What is on this board?")).toBe(true);
    // …and its author is told where the board went.
    const last = messages[messages.length - 1]!;
    expect(last.author).toBe("controller");
    expect(last.text).toContain(`"${name}" was deleted`);
    expect(last.text).toContain("instance conversation");
    // Untouched, because it was never bound to this project.
    expect(listMessages(store.db, instance.id)).toEqual([]);
  });
});

describe("deleteProject stops the agents it is deleting", () => {
  it("interrupts in-flight runs before the files go", async () => {
    // Nothing stopped them, so a delete left every running agent going against
    // a workspace that no longer existed — still billing the owner's provider
    // account — and unstoppable afterwards, because the only interrupt door is
    // the task route and that 404s once the project is gone.
    // Canary: drop the interrupt loop from deleteProject and the run below is
    // still 'running' after the project is deleted.
    const store = setupTestStore(ctx);
    const actor = admin(store);
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO agent_runs
           (id, project_slug, task_key, thread_id, kind, role, backend, model,
            agent_profile_id, state, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'primary', 'Developer', 'claude', 'sonnet',
                 'developer', 'running', ?, ?, ?)`,
      )
      .run("run_live", store.slug, "VIB-1", "thr_1", now, now, now);

    const stateOf = () =>
      store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get("run_live");
    expect(stateOf()).toEqual({ state: "running" });

    const name = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.name;
    await deleteProject(
      store.db,
      { projectSlug: store.slug, confirmName: name },
      actor,
      { dataRoot: store.dataRoot },
    );

    expect(stateOf(), "the run must not outlive its project").not.toEqual({
      state: "running",
    });
  });
});

describe("removeMember clears the notifications they can no longer open", () => {
  it("drops the removed member's rows for that project, and nobody else's", async () => {
    // deleteProject already does this (F2: an orphan dead-ends on a 404). A
    // removal is the same harm through the other door — and the harder one:
    // the project still EXISTS, so `countUnreadNotifications`' deleted-project
    // discount does not cover it, and the ex-member's bell kept counting rows
    // that 403 on click.
    // Canary: drop deleteMemberProjectNotifications from removeMember and the
    // removed member's row survives.
    const store = setupTestStore(ctx);
    const actor = admin(store);
    const target = store.users.selin;
    const mine = createNotification(store.db, {
      userId: target.id,
      kind: "mention",
      title: "You were mentioned",
      text: "Have a look",
      projectSlug: store.slug,
      bypassPrefs: true,
    });
    const someoneElse = createNotification(store.db, {
      userId: store.users.arda.id,
      kind: "mention",
      title: "Also mentioned",
      text: "Have a look",
      projectSlug: store.slug,
      bypassPrefs: true,
    });
    expect(mine).not.toBeNull();
    expect(someoneElse).not.toBeNull();

    await removeMember(
      store.db,
      { projectSlug: store.slug, targetUserId: target.id },
      actor,
      { dataRoot: store.dataRoot },
    );

    const rows = store.db
      .prepare(`SELECT user_id FROM notifications WHERE project_slug = ?`)
      .all(store.slug);
    expect(rows).toEqual([{ user_id: store.users.arda.id }]);

    // …and the removal says how many it dropped, rather than doing it quietly.
    const audit = listAuditEvents(store.db, { action: "project.member.removed" });
    expect((audit[0]?.details ?? {}).notificationsDropped).toBe(1);
  });
});

/**
 * Ruling 178 (pass 36, G36-3): the project's required-reviewer rule has ONE
 * writer, shared by the Settings form and the controller tool — same
 * validation (ids checked by name, nothing written on a refusal), same audit
 * row, same tier (`edit-policy`: a required reviewer is acceptance policy).
 */
describe("setRequiredReviewers (ruling 178)", () => {
  function withReviewers(): TestStore {
    const store = setupTestStore(ctx);
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        {
          profileId: "reviewer",
          capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
          extras: [],
          definition: { kind: "specialist", name: "Code Reviewer", role: "Review", backends: ["claude"], model: "sonnet", stages: ["review"] },
        },
        {
          profileId: "developer",
          capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }],
          extras: [],
          definition: { kind: "specialist", name: "Dev", role: "Implementation", backends: ["claude"], model: "sonnet", stages: ["impl"] },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return store;
  }
  const rulesOf = (store: TestStore) =>
    readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.requiredReviewers;

  it("writes the WHOLE list to project.md, reprojects it, audits with the resolved names, and [] clears it", async () => {
    // Canary: skip `recordAudit` in the writer.
    const store = withReviewers();
    const saved = await setRequiredReviewers(
      store.db,
      { projectSlug: store.slug, rules: [{ stageId: "review", profileId: "reviewer" }] },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(saved.changed).toBe(true);
    expect(saved.toast).toBe("Required reviewers saved: Code Reviewer at Review");
    expect(rulesOf(store)).toEqual([{ stageId: "review", profileId: "reviewer" }]);
    // The projection row carries the resolved rule (the queue reads it).
    const { getProject } = await import("~/server/projections/board-query.server");
    expect(getProject(store.db, store.slug)!.requiredReviewers).toEqual([
      { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" },
    ]);
    const audits = listAuditEvents(store.db, { action: "project.required_reviewers.updated" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({
      count: 1,
      rules: [{ stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" }],
    });

    // The same list again is a no-op: nothing audited twice.
    const same = await setRequiredReviewers(
      store.db,
      { projectSlug: store.slug, rules: [{ stageId: "review", profileId: "reviewer" }] },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(same.changed).toBe(false);
    expect(listAuditEvents(store.db, { action: "project.required_reviewers.updated" })).toHaveLength(1);

    const cleared = await setRequiredReviewers(
      store.db,
      { projectSlug: store.slug, rules: [] },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(cleared.toast).toBe("Required reviewers cleared");
    expect(rulesOf(store)).toEqual([]);
    expect(listAuditEvents(store.db, { action: "project.required_reviewers.updated" })).toHaveLength(2);
  });

  it("refuses an unknown stage, the terminal stage, an unknown profile and a profile that cannot report a verdict — by name, writing nothing", async () => {
    const store = withReviewers();
    const attempt = (rules: { stageId: string; profileId: string }[]) =>
      setRequiredReviewers(store.db, { projectSlug: store.slug, rules }, admin(store), { dataRoot: store.dataRoot });
    await expect(attempt([{ stageId: "qa", profileId: "reviewer" }])).rejects.toThrow(
      '"qa" is not a stage of viberr-core. Nothing was written. The project\'s stage ids are: triage, ready, impl, review, done.',
    );
    await expect(attempt([{ stageId: "done", profileId: "reviewer" }])).rejects.toThrow(
      "Done is the terminal stage; a review runs before it. Nothing was written.",
    );
    await expect(attempt([{ stageId: "review", profileId: "ghost" }])).rejects.toThrow(
      'No agent "ghost" is deployed on viberr-core. Nothing was written. Verdict-capable agents here: Code Reviewer (reviewer).',
    );
    await expect(attempt([{ stageId: "review", profileId: "developer" }])).rejects.toThrow(
      'Dev (developer) cannot report a validation verdict, so it cannot be a required reviewer. Nothing was written. Verdict-capable agents here: Code Reviewer (reviewer).',
    );
    expect(rulesOf(store)).toEqual([]);
    expect(listAuditEvents(store.db, { action: "project.required_reviewers.updated" })).toHaveLength(0);
  });

  it("is edit-policy tier: a maintainer, a contributor and a viewer are refused", async () => {
    const store = withReviewers();
    for (const user of [store.users.murat, store.users.selin, store.users.elif]) {
      await expect(
        setRequiredReviewers(
          store.db,
          { projectSlug: store.slug, rules: [{ stageId: "review", profileId: "reviewer" }] },
          { userId: user.id, label: user.email },
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(rulesOf(store)).toEqual([]);
  });
});

/**
 * Ruling 239 (pass 37): the project's rulings knowledge base — the one KB every
 * run on the project reads, whether or not a profile grants it.
 */
/**
 * Ruling 245 (pass 37, F37-74): a lease says which task owns a shared path
 * until it merges — the statement `blockedBy` cannot make, because `blockedBy`
 * means "do not START until done" and what is wanted is "both may proceed, this
 * one owns the lockfile until it lands".
 */
describe("setProjectFileLeases (ruling 245)", () => {
  let store: TestStore;
  let holderA = "";
  let holderB = "";
  const leases = () =>
    readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter
      .fileLeases;
  beforeEach(async () => {
    store = setupTestStore(ctx);
    const { createTask } = await import("~/server/tasks/task-edits.server");
    // The real keys, not assumed ones: the project's own prefix and counter
    // decide them, and a lease is validated against the board.
    holderA = (
      await createTask(store.db, { projectSlug: store.slug, title: "Holder one" }, admin(store), {
        dataRoot: store.dataRoot,
      })
    ).key;
    holderB = (
      await createTask(store.db, { projectSlug: store.slug, title: "Holder two" }, admin(store), {
        dataRoot: store.dataRoot,
      })
    ).key;
  });

  it("writes the list, and reads it back off the project file", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    const saved = await setProjectFileLeases(
      store.db,
      {
        projectSlug: store.slug,
        leases: [{ paths: ["pnpm-lock.yaml", " make/** "], taskKey: holderA, reason: " the fragments " }],
      },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(saved.changed).toBe(true);
    // Trimmed and deduped on the way in: a lease is matched by string, so a
    // stray space is a lease that silently covers nothing.
    expect(leases()).toEqual([
      { paths: ["pnpm-lock.yaml", "make/**"], taskKey: holderA, reason: "the fragments" },
    ]);
    expect(saved.toast).toContain(holderA);
  });

  it("refuses a holder this project does not have, and writes nothing", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    await expect(
      setProjectFileLeases(
        store.db,
        { projectSlug: store.slug, leases: [{ paths: ["Makefile"], taskKey: "VIB-999", reason: "x" }] },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/VIB-999 is not a task in this project/);
    // CANARY: drop the holder check and a refusal names a task nobody can open.
    expect(leases()).toEqual([]);
  });

  it("refuses two leases over the same glob, because order would decide the owner", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    await expect(
      setProjectFileLeases(
        store.db,
        {
          projectSlug: store.slug,
          leases: [
            { paths: ["pnpm-lock.yaml"], taskKey: holderA, reason: "a" },
            { paths: ["pnpm-lock.yaml"], taskKey: holderB, reason: "b" },
          ],
        },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/Two leases both cover/);
    expect(leases()).toEqual([]);
  });

  it("ruling 417: refuses two ACTIVE holders whose globs overlap, not only identical ones", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    // CANARY: go back to the exact-glob check and this saves, and each lease
    // refuses the other holder's delivery forever.
    await expect(
      setProjectFileLeases(
        store.db,
        {
          projectSlug: store.slug,
          leases: [
            { paths: ["internal/sandbox/**"], taskKey: holderA, reason: "rewriting the sandbox" },
            { paths: ["internal/sandbox/local.go"], taskKey: holderB, reason: "one file" },
          ],
        },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/Two leases overlap: `internal\/sandbox\/\*\*` \(.+\) and `internal\/sandbox\/local.go`/);
    expect(leases()).toEqual([]);
  });

  it("ruling 417: a lease whose holder has FINISHED overlaps nothing, since it binds nobody", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    await updateTaskFile({ projectSlug: store.slug, taskKey: holderA, dataRoot: store.dataRoot }, (f) => {
      f.frontmatter.archived = true;
    });
    const saved = await setProjectFileLeases(
      store.db,
      {
        projectSlug: store.slug,
        leases: [
          { paths: ["internal/**"], taskKey: holderA, reason: "spent" },
          { paths: ["internal/cli/render.go"], taskKey: holderB, reason: "live" },
        ],
      },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(saved.changed).toBe(true);
  });

  it("clears with an empty list, and reports an unchanged write as unchanged", async () => {
    const { setProjectFileLeases } = await import("./settings-actions.server");
    const args = {
      projectSlug: store.slug,
      leases: [{ paths: ["Makefile"], taskKey: holderA, reason: "splitting it" }],
    };
    await setProjectFileLeases(store.db, args, admin(store), { dataRoot: store.dataRoot });
    const again = await setProjectFileLeases(store.db, args, admin(store), {
      dataRoot: store.dataRoot,
    });
    expect(again.changed).toBe(false);
    const cleared = await setProjectFileLeases(
      store.db,
      { projectSlug: store.slug, leases: [] },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(cleared.changed).toBe(true);
    expect(leases()).toEqual([]);
  });
});

describe("setProjectRulingsKb (ruling 239)", () => {
  let store: TestStore;
  const projectFm = () =>
    readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;
  async function seedKb(name: string): Promise<string> {
    const { saveKnowledgeBase } = await import("~/server/org/resources.server");
    const saved = await saveKnowledgeBase(
      store.db,
      { name, refresh: "on change" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    return saved.kb.dir;
  }
  beforeEach(() => {
    store = setupTestStore(ctx);
  });

  it("refuses a directory no knowledge base occupies, and writes nothing", async () => {
    // A rulings KB that resolves to nothing injects silently-empty context into
    // every run and reads on every surface as though the project had settled
    // rules it has not. CANARY: drop the `listKnowledgeBases` check.
    await expect(
      setProjectRulingsKb(
        store.db,
        { projectSlug: store.slug, dir: "no-such-kb" },
        admin(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/No knowledge base lives at "no-such-kb"/);
    expect(projectFm().rulingsKb ?? null).toBeNull();
  });

  it("names a real one, reports it, and clears back to null", async () => {
    const dir = await seedKb("team-rulings");
    const set = await setProjectRulingsKb(
      store.db,
      { projectSlug: store.slug, dir },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(set.changed).toBe(true);
    expect(set.dir).toBe(dir);
    expect(projectFm().rulingsKb).toBe(dir);

    // Idempotent: the same value is not a change and writes no audit row.
    const again = await setProjectRulingsKb(
      store.db,
      { projectSlug: store.slug, dir },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(again.changed).toBe(false);

    const cleared = await setProjectRulingsKb(
      store.db,
      { projectSlug: store.slug, dir: null },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    expect(cleared.changed).toBe(true);
    expect(projectFm().rulingsKb ?? null).toBeNull();
  });
});
