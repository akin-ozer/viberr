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
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { listOrgUsers } from "~/server/org/org-users.server";
import {
  addStage,
  inviteMember,
  removeStage,
  renameStage,
  reorderStages,
  repairProjectRepo,
  repoFootprintTasks,
  setBranchCleanup,
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
