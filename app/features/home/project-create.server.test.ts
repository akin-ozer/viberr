import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { createPat, getProjectCredential } from "~/server/secrets/pat-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { createProject } from "./project-create.server";

// F20-1: fault-inject a stale-mount write through `createProjectFileImpl` —
// the ctx seam standing in for the project.md write. Every other test in this
// file leaves the seam off and writes for real. The ESTALE→typed-error
// translation itself is unit-proven in atomic-file.server.test.ts; here we
// assert the ACTION surfaces a typed error and never hangs.
const staleMountWrite = async (): Promise<never> => {
  throw new AppError({
    code: ERROR_CODES.INTERNAL,
    status: 503,
    message: "ESTALE writing project.md — data root unreachable",
    userMessage: "The data root is unreachable (ESTALE) — project.md was not written.",
  });
};

/** The single columns these tests read back off a just-written row. */
const defaultBranchRow = z.object({ default_branch: z.string() });
const idRow = z.object({ id: z.string() });

// Hermetic env for the secret box.
process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

/** Seed a validated connection (owner → PAT) the way org settings would. */
function seedConnection(db: import("node:sqlite").DatabaseSync, userId: string) {
  const pat = createPat(
    db,
    { userId, label: "connection · akin-ozer", token: "ghp_testtesttesttesttesttesttesttest0000" },
    ACTOR,
  );
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO github_connections (id, owner, pat_id, is_default, repos_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, 3, ?, ?)`,
  ).run("akin-ozer", "akin-ozer", pat.id, now, now);
  return pat.id;
}

describe("createProject — GitHub connection wiring", () => {
  it("binds the selected connection's PAT and adopts the repo's real default branch", async () => {
    const store = setupTestStore(ctx);
    const patId = seedConnection(store.db, store.users.arda.id);

    // The repo's real default branch is `master`, not `main`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ default_branch: "master" }), { status: 200 }),
      ),
    );

    const result = await createProject(
      store.db,
      { name: "Containerless", key: "CTL", owner: "akin-ozer", repoName: "containerless", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );

    // Credential is bound to the project (branch/PR sync + health work).
    const bound = getProjectCredential(store.db, result.slug);
    expect(bound?.id).toBe(patId);

    // Default branch reflects the real repo, not a hardcoded "main".
    const row = defaultBranchRow.parse(
      store.db
        .prepare(`SELECT default_branch FROM projects WHERE slug = ?`)
        .get(result.slug),
    );
    expect(row.default_branch).toBe("master");
  });

  it("F20-14/F20-15: creation warns when the token can only READ the repo (no push)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);

    // The repo is VISIBLE, so its default branch is adopted, but the token's
    // computed permissions say no push — the same check Repair now enforces.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            default_branch: "master",
            permissions: { admin: false, maintain: false, push: false },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await createProject(
      store.db,
      { name: "Readonly", key: "RDO", owner: "akin-ozer", repoName: "hello-world", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    // Created (creating before the repo is deliverable is a real flow) but the
    // caller is told delivery won't work yet — no longer silently accepted.
    expect(result.repoWarning).toBeTruthy();
    expect(result.repoWarning).toMatch(/push|write access/i);
    // The visible default branch is still adopted.
    const row = defaultBranchRow.parse(
      store.db
        .prepare(`SELECT default_branch FROM projects WHERE slug = ?`)
        .get(result.slug),
    );
    expect(row.default_branch).toBe("master");
  });

  it("F15-01: creation PROVES the bound credential against the real repo", async () => {
    // Before this, creation bound the PAT and stopped — a fine-grained token's
    // scope chips stayed `assumed`, so a brand-new project's credential card
    // affirmed scopes nothing had checked. Attach/rotate always probed; this is
    // the same proof on the creation path.
    const store = setupTestStore(ctx);
    createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "connection · akin-ozer",
        token: "github_pat_11CREATE0123456789_createcreate",
      },
      ACTOR,
    );
    const patId = idRow.parse(
      store.db
        .prepare(`SELECT id FROM github_pats ORDER BY created_at DESC LIMIT 1`)
        .get(),
    ).id;
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO github_connections (id, owner, pat_id, is_default, repos_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 3, ?, ?)`,
      )
      .run("akin-ozer", "akin-ozer", patId, now, now);

    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr": {
        // A8 (pass 16): repo write is read from the `permissions` block the
        // authenticated token gets back, not from a probe that wrote a file
        // into the real repository. Real GitHub always sends it.
        body: {
          full_name: "akin-ozer/viberr",
          default_branch: "main",
          permissions: { push: true },
        },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 422,
        body: { message: "Validation Failed" },
      },
    });
    vi.stubGlobal("fetch", gh.fetchImpl);

    const result = await createProject(
      store.db,
      { name: "Viberr", key: "VIB", owner: "akin-ozer", repoName: "viberr", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );

    const bound = getProjectCredential(store.db, result.slug);
    // The validation now carries the PROJECT's repo and probe-backed verdicts —
    // on the old code it was the connection-time result with no repo at all.
    expect(bound?.validation?.repo).toBe("akin-ozer/viberr");
    const repoScope = bound?.validation?.scopes.find((sc) => sc.id === "repo");
    expect(repoScope?.source).toBe("probe");
  });

  it("rejects an owner with NO connection behind it (PAT required)", async () => {
    const store = setupTestStore(ctx);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      createProject(
        store.db,
        { name: "Ghostly", key: "GHO", owner: "nobody", repoName: "ghost", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/No GitHub connection for "nobody"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("createProject — policy preset shapes REAL governance", () => {
  const fm = (store: ReturnType<typeof setupTestStore>, slug: string) =>
    readProjectFile({ projectSlug: slug, dataRoot: store.dataRoot })!.parsed
      .frontmatter;
  const opAutonomy = (agents: { profileId: string; definition?: { autonomy?: string } }[]) =>
    agents.find((a) => a.profileId === "operator")?.definition?.autonomy;
  const boundary = (
    wf: { from: string; to: string; boundary: string }[],
    from: string,
    to: string,
  ) => wf.find((b) => b.from === from && b.to === to)?.boundary;

  it("balanced = template defaults (pre-work auto, supervised operator)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Bal", key: "BAL", owner: "akin-ozer", repoName: "b", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(boundary(f.workflow, "triage", "ready")).toBe("auto");
    expect(boundary(f.workflow, "ready", "impl")).toBe("auto");
    expect(opAutonomy(f.agents)).toBeUndefined(); // supervised (default)
  });

  /**
   * The synthesized description and the written stage list are produced two
   * lines apart, and only the stage list honoured the custom blueprint — so a
   * controller-built board was stored, projected and rendered as the
   * "Standard 5-stage workflow" it is not.
   */
  it("a custom board is not described as the Standard 5-stage workflow", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      {
        name: "Release Ops",
        key: "ROPS",
        owner: "akin-ozer",
        repoName: "r",
        policy: "balanced",
        custom: {
          stages: [
            { name: "Intake" },
            { name: "Plan" },
            { name: "Execute" },
            { name: "Shipped" },
          ],
        },
      },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const parsed = readProjectFile({
      projectSlug: r.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.stages).toHaveLength(4);
    expect(parsed.description).not.toContain("Standard 5-stage");
    expect(parsed.description).toContain("Custom 4-stage");
    // The policy half of the sentence is untouched.
    expect(parsed.description).toContain("balanced agent policy.");
  });

  it("strict = human-gates the pre-work boundaries (no operator auto-advance)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Strict", key: "STR", owner: "akin-ozer", repoName: "s", policy: "strict" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(boundary(f.workflow, "triage", "ready")).toBe("approval");
    expect(boundary(f.workflow, "ready", "impl")).toBe("approval");
    // impl→review stays approval; review→done stays the locked human boundary.
    expect(boundary(f.workflow, "review", "done")).toBe("human");
    expect(f.workflow.find((b) => b.to === "done")?.locked).toBe(true);
    expect(opAutonomy(f.agents)).toBeUndefined(); // still supervised
    // R15-2/H3: the strict preset maps delivery to recommend — an operator on
    // the everything-human-gated preset must not push branches or open PRs at
    // its own discretion. (Fails on wave-1: presetAgents only touched `auto`.)
    const op = f.agents.find((a) => a.profileId === "operator")!;
    expect(
      op.capabilities.find((c) => c.capabilityId === "deliver-review-pr")?.mode,
    ).toBe("recommend");
  });

  it("balanced keeps the shipped template's deliver-review-pr: direct", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Bal", key: "BAL", owner: "akin-ozer", repoName: "b", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    const op = f.agents.find((a) => a.profileId === "operator")!;
    expect(
      op.capabilities.find((c) => c.capabilityId === "deliver-review-pr")?.mode,
    ).toBe("direct");
  });

  it("auto = the operator runs at full autonomy + explicit completion-for-acceptance:direct (Q1)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Auto", key: "AUT", owner: "akin-ozer", repoName: "a", policy: "auto" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(opAutonomy(f.agents)).toBe("full");
    // review→done is ALWAYS human-locked — no preset can grant it.
    expect(boundary(f.workflow, "review", "done")).toBe("human");
    // The auto preset EXPLICITLY grants acceptance (full autonomy alone no
    // longer promotes it — owner ruling Q1).
    const op = f.agents.find((a) => a.profileId === "operator")!;
    expect(
      op.capabilities.find((c) => c.capabilityId === "completion-for-acceptance")?.mode,
    ).toBe("direct");
  });

  // P13-AP-04 / LV-01 (owner ruling 2): the "Lightweight · 3 stages" preset was
  // DELETED because it created a todo/doing/done board while the preinstalled
  // roster's eligible stages are the governed ids — no specialist was ever
  // stage-eligible and the operator could not hand work off. The rule this
  // pins: WHATEVER board creation produces, every preinstalled specialist must
  // be eligible for at least one stage on it. (The old test passed
  // `template: "light"`; there is no such input any more.)
  it("AP-04: every preinstalled specialist is stage-eligible on the board creation produced", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Eligible", key: "ELG", owner: "akin-ozer", repoName: "e", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    const boardStages = f.stages.map((s) => s.id);
    expect(boardStages).toEqual(["triage", "ready", "impl", "review", "done"]);

    const { effectiveProfileView } = await import(
      "~/features/agents/agents-query.server"
    );
    const { specialistEligibleForStage } = await import(
      "~/server/tasks/specialist-run.server"
    );
    const specialists = f.agents
      .map((a) => effectiveProfileView(a, store.dataRoot, "direct"))
      .filter((v) => v.kind === "specialist");
    expect(specialists.length).toBeGreaterThan(0);
    for (const spec of specialists) {
      const eligible = boardStages.filter((stageId) =>
        specialistEligibleForStage(spec, stageId),
      );
      expect(eligible, `${spec.name} has no eligible stage`).not.toHaveLength(0);
    }
  });

  // Repo-bound projects only (2026-07-17 ruling, reverses F10): a repository +
  // PAT connection are mandatory — repo-less creation is rejected in every form.
  it("an EMPTY repo field is rejected (repo-less projects were cut)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Repoless", key: "RPL", owner: "akin-ozer", repoName: "   ", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/GitHub repository is required/i);
  });

  it("empty owner + empty repo is rejected (no more F10 self-serve repo-less)", async () => {
    const store = setupTestStore(ctx);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "First Project", key: "FST", owner: "", repoName: "", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/GitHub repository is required/i);
  });

  it("refuses the reserved GOAL prefix before it creates anything", async () => {
    // Canary: drop the isReservedTaskPrefix guard in createProject — the
    // project is created and every task it keys becomes unwaitable.
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Goal Keeper", key: "goal", owner: "akin-ozer", repoName: "goal-keeper", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/not available as a task prefix/i);
    // Nothing was created, and no repo call was attempted.
    expect(existsSync(join(store.dataRoot, "projects", "goal-keeper"))).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a repo NAME without an owner is rejected", async () => {
    const store = setupTestStore(ctx);
    await expect(
      createProject(
        store.db,
        { name: "Needs Owner", key: "NDO", owner: "", repoName: "some-repo", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/GitHub repository is required/i);
  });
});

describe("createProject — F20-1 data-root write resilience", () => {
  it("a stale-mount write fails the ACTION with a typed error and does not hang", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      ),
    );

    // The fault reaches ONLY this call — the store seeding above wrote for real.
    const start = Date.now();
    let caught: unknown;
    try {
      await createProject(
        store.db,
        { name: "Ghost Mount", key: "GHM", owner: "akin-ozer", repoName: "ghost", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot, createProjectFileImpl: staleMountWrite },
      );
    } catch (e) {
      caught = e;
    }

    // Rejects with a typed AppError (not a raw errno, not a hang). The action
    // watchdog window is 30s; a real fault returns in milliseconds.
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.status).toBe(503);
      expect(caught.userMessage).toMatch(/data root is unreachable/i);
    }
    expect(Date.now() - start).toBeLessThan(2000);

    // The half-created project left no readable project.md behind.
    expect(readProjectFile({ projectSlug: "ghost-mount", dataRoot: store.dataRoot })).toBeNull();
  });
});

describe("ruling 352: a stage colour is a CSS value Viberr can draw, or the door refuses it", () => {
  it("refuses a palette NAME by name, and accepts a hex value", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const create = (key: string, color: string) =>
      createProject(
        store.db,
        {
          name: `Colour ${key}`,
          key,
          owner: "akin-ozer",
          repoName: "c",
          policy: "balanced",
          custom: { stages: [{ name: "Intake", color }, { name: "Shipped" }] },
        },
        ACTOR,
        { dataRoot: store.dataRoot },
      );
    // Live: the shopify board's Triage and Review dots drew nothing, because
    // `slate` and `amber` are not CSS colours and every renderer hands the
    // string to CSS as it is. CANARY: store the string unchecked.
    await expect(create("CLA", "slate")).rejects.toThrow(/"slate".*not a CSS colour/);
    await expect(create("CLB", "#8b8b8b")).resolves.toBeTruthy();
  });
});
