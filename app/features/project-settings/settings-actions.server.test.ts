import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
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
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
import { recordRepoAccess } from "~/server/github/repo-health.server";
import { createNotification } from "~/server/projections/notifications.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { listOrgUsers } from "~/server/org/org-users.server";
import {
  addStage,
  deleteProject,
  inviteMember,
  removeMember,
  removeStage,
  renameStage,
  reorderStages,
  repairProjectRepo,
  repoFootprintTasks,
  setBranchCleanup,
  setProjectRulingsKb,
  setRequiredReviewers,
  updateProjectIdentity,
  NEW_STAGE_COLORS,
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

function setup(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

describe("addStage", () => {
  it("splices the new stage into the transition chain instead of stranding the column", async () => {
    const store = setup();
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
    const store = setup();
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
    const store = setup();
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
    const store = setup();
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
    const store = setup();
    // Default chain: ready→impl (auto) + impl→review (approval). Removing In
    // Progress merges them to the STRICTER `approval` — a tightening the toast
    // and audit must name, not swallow.
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
    const store = setup();
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

  it("N20-10: a new stage persists a HEX color, never a CSS var, into project.md", async () => {
    const store = setup();
    const { stageId } = await addStage(
      store.db,
      { projectSlug: store.slug, name: "QA" },
      admin(store),
      { dataRoot: store.dataRoot },
    );
    const stage = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.stages.find((s) => s.id === stageId)!;
    expect(stage.color).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(stage.color).not.toContain("var(");
    // The whole palette is hex — the canonical file holds no stylesheet token.
    for (const color of NEW_STAGE_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
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

  /**
   * The guard checked the LENGTH of the order and that every id is known — but
   * not that the ids are distinct. A payload repeating one id therefore
   * necessarily omits another: the board gains a duplicated column and
   * silently LOSES one, taking `removeStage`'s "move its tasks out first"
   * guard with it and stranding every task sitting in the dropped stage in a
   * column the project no longer defines.
   */
  it("refuses an order that repeats a stage id (and so drops another)", async () => {
    const store = setup();
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
    expect(result.toast).toContain("Repository repaired: akin/viberr → akin-ozer/viberr");
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

  it("F20-15: REFUSES a repo the credential can only READ — a project must be able to push", async () => {
    const store = setupTestStore(ctx);
    await misconfigure(store);
    bindCredential(store);
    // Repo is VISIBLE (res.ok) but the token's computed permissions say no push —
    // the octocat/Hello-World live case. `res.ok` alone must not adopt it.
    const gh = fakeGithubFetch({
      [`GET /repos/octocat/Hello-World`]: {
        body: {
          full_name: "octocat/Hello-World",
          default_branch: "master",
          permissions: { admin: false, maintain: false, push: false },
        },
      },
    });
    await expect(
      repairProjectRepo(
        store.db,
        { projectSlug: store.slug, repo: "octocat/Hello-World" },
        admin(store),
        { dataRoot: store.dataRoot },
        { fetchImpl: gh.fetchImpl },
      ),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing changed, nothing audited.
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
        .frontmatter.repo,
    ).toBe("akin/viberr");
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })).toHaveLength(0);
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
    const result = await repairProjectRepo(
      store.db,
      { projectSlug: store.slug, repo: REPO_OK },
      admin(store),
      { dataRoot: store.dataRoot },
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.changed).toBe(true);
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
    expect(result.toast).toContain("Attach a credential to verify");
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

/**
 * R15-6 (owner ruling 2026-07-28): post-merge branch cleanup is a per-project
 * setting, default ON. Persisted as a project.md guardrail row, so it travels
 * with the file like every other per-project switch.
 */
describe("setBranchCleanup (R15-6)", () => {
  it("defaults ON for a project that has never touched the setting", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Fails on main: `branchCleanupOnMerge` did not exist — nothing deleted a
    // merged task's branch, on any project.
    expect(branchCleanupOnMerge(store.db, store.slug)).toBe(true);
  });

  it("persists the opt-out into project.md and the projection", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
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
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
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
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await expect(
      setBranchCleanup(
        store.db,
        { projectSlug: store.slug, enabled: false },
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow();
  });
});

// F20-12 / N20-6 — inviting an unknown email must mint a USABLE account and the
// toast must not claim an email was sent (there is no mailer, ruling 13).
describe("inviteMember", () => {
  it("F20-12: an unknown email mints a temp-password account (usable + setup-pending), not a passwordless one", async () => {
    const store = setup();
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
    const store = setup();
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
    const store = setup();
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
    const store = setup();
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
    const store = setup();
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
 * Pass 34 review: `GOAL` is the one prefix a project cannot take. The
 * dependency grammar (ruling 131) reads `GOAL-1` as a goal chain's reference
 * missing its link, so tasks keyed that way could never be waited on.
 */
describe("the reserved task prefix", () => {
  it("refuses GOAL, in any casing, and leaves the stored prefix alone", async () => {
    // Canary: drop the isReservedTaskPrefix guard in updateProjectIdentity —
    // the project takes the prefix and its tasks become unwaitable.
    const store = setup();
    const fileCtx = { dataRoot: store.dataRoot };
    for (const typed of ["GOAL", "goal", "Goal"]) {
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
    // A neighbouring four-letter prefix is still fine.
    const ok = await updateProjectIdentity(
      store.db,
      { projectSlug: store.slug, name: "Viberr Core", prefix: "GOAT", description: "" },
      admin(store),
      fileCtx,
    );
    expect(ok.changed).toBe(true);
    expect(prefixOf(store)).toBe("GOAT");
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
    const { createTask } = await import("~/server/tasks/task-actions.server");
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
