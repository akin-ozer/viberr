import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effortsFor } from "~/server/runtimes/model-catalog.server";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import {
  fakeGithubFetch,
  unreachableFetch,
  type FakeResponseSpec,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  createPat,
  getProjectCredential,
  recordPatValidation,
} from "~/server/secrets/pat-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { isStageColor } from "~/shared/workflow/stage-colors";
import { createProject, type CreateProjectInput } from "./project-create.server";
import { listDeployedSpecialists } from "~/server/tasks/specialist-roster.server";

/** The single columns these tests read back off a just-written row. */
const defaultBranchRow = z.object({ default_branch: z.string() });
const idRow = z.object({ id: z.string() });

const ctx = createTestDbContext();
/**
 * GitHub confirming the repository a project is created against. Ruling 671:
 * a creation it does not confirm is refused, so a test about anything else
 * needs the answer.
 */
function answeringGithub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })),
  );
}

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
    `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run("akin-ozer", "akin-ozer", pat.id, now, now);
  return pat.id;
}

/**
 * Ruling 671 (owner, 2026-10-06): a creation GitHub does not confirm is
 * refused. It used to go on with a warning and `defaultBranch: main`, a guess
 * nothing confirmed later, and `defaultBranch` is what keeps a delivery's
 * push off the repository's real default branch.
 */
describe("createProject refuses a repository GitHub does not confirm (ruling 671)", () => {
  const ghost = { name: "Ghost", key: "GHO", owner: "akin-ozer", repoName: "ghost", policy: "balanced" } as const;

  it("refuses one GitHub does not show, a rejected token, a refusal of GitHub's own, an unreachable GitHub and an answer naming no default branch, and writes nothing", async () => {
    // CANARY: let any of them through and a project is written against a
    // repository nobody confirmed, with a default branch nobody read; call a
    // 403 a bad token and a person replaces a token that single sign-on, not
    // its age, is holding back. Ruling 672: each one names the way on, so
    // dropping `START_WITHOUT_REPOSITORY` leaves the person at a dead end.
    const answered = (spec: Parameters<typeof fakeGithubFetch>[0][string]) =>
      fakeGithubFetch({ "GET /repos/akin-ozer/ghost": spec }).fetchImpl;
    const rows: [typeof fetch, string][] = [
      [
        answered({ status: 404, body: { message: "Not Found" } }),
        "GitHub has no repository akin-ozer/ghost that the akin-ozer connection can see. Check the owner and the name, give the connection's token access to it, or have Viberr create it with the project. No project was created. A project can also start without a repository and connect it later.",
      ],
      [
        answered({ status: 401, body: { message: "Bad credentials" } }),
        "GitHub rejected the akin-ozer connection's token, so Viberr cannot confirm akin-ozer/ghost. Replace the token in Instance settings → GitHub connections, then create the project. No project was created. A project can also start without a repository and connect it later.",
      ],
      [
        answered({ status: 403, body: { message: "Resource protected by organization SAML enforcement." } }),
        "GitHub refused the akin-ozer connection's token for akin-ozer/ghost (Resource protected by organization SAML enforcement), so Viberr cannot confirm the repository. Clear what GitHub names, then create the project. No project was created. A project can also start without a repository and connect it later.",
      ],
      [
        unreachableFetch(),
        "Couldn't reach GitHub to confirm akin-ozer/ghost, so no project was created. Try again once GitHub answers. A project can also start without a repository and connect it later.",
      ],
      [
        answered({ body: { full_name: "akin-ozer/ghost" } }),
        "GitHub named no default branch for akin-ozer/ghost, so Viberr cannot tell which branch tasks start from. Check the repository on GitHub, then try again. No project was created. A project can also start without a repository and connect it later.",
      ],
    ];
    for (const [fetchImpl, userMessage] of rows) {
      const store = setupTestStore(ctx);
      seedConnection(store.db, store.users.arda.id);
      await expect(
        createProject(store.db, ghost, ACTOR, { dataRoot: store.dataRoot, fetchImpl }),
      ).rejects.toMatchObject({ status: 400, userMessage });
      expect(readProjectFile({ projectSlug: "ghost", dataRoot: store.dataRoot })).toBeNull();
      expect(getProjectCredential(store.db, "ghost")).toBeNull();
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM project_github_health`).get()).toEqual({ n: 0 });
      expect(listAuditEvents(store.db, { action: "project.created" })).toHaveLength(0);
    }
  });

  it("refuses a results board that names a repository to read on the same terms, and a name GitHub cannot have before asking", async () => {
    // A repository attached for reading is checked out like any other.
    // CANARY: let one GitHub does not show through and a results board is
    // written against it; check the name's alphabet only when creating and
    // `ghost?tab=readme`, which GitHub answers as `ghost`, is written as the
    // project's repository.
    const reading = setupTestStore(ctx);
    seedConnection(reading.db, reading.users.arda.id);
    await expect(
      createProject(reading.db, { ...ghost, delivers: "results" }, ACTOR, {
        dataRoot: reading.dataRoot,
        fetchImpl: fakeGithubFetch({}).fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage: expect.stringContaining("GitHub has no repository akin-ozer/ghost that the akin-ozer connection can see."),
    });

    const named = setupTestStore(ctx);
    seedConnection(named.db, named.users.arda.id);
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/ghost": { body: { full_name: "akin-ozer/ghost", default_branch: "main" } },
    });
    await expect(
      createProject(named.db, { ...ghost, repoName: "ghost?tab=readme" }, ACTOR, {
        dataRoot: named.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        'GitHub repository names use letters, digits, ".", "-" and "_" only, so "ghost?tab=readme" is not one. Pick a name in that alphabet and ask again.',
    });
    expect(gh.calls).toHaveLength(0);
  });

  it("finds the owner's connection however the owner is cased", async () => {
    // Connections are stored under the owner's slug, and the form offers the
    // owner as it was saved. CANARY: look the connection up by the owner as
    // typed and `Akin-Ozer` answers "No GitHub connection".
    const store = setupTestStore(ctx);
    const patId = seedConnection(store.db, store.users.arda.id);
    const gh = fakeGithubFetch({
      "GET /repos/Akin-Ozer/ghost": { body: { full_name: "akin-ozer/ghost", default_branch: "main" } },
    });
    const result = await createProject(store.db, { ...ghost, owner: "Akin-Ozer" }, ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(getProjectCredential(store.db, result.slug)?.id).toBe(patId);
  });
});

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
        `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
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

  it("balanced = template defaults (pre-work and the move into Review auto, a supervised operator with deliver-review-pr: direct)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    answeringGithub();
    const r = await createProject(
      store.db,
      { name: "Bal", key: "BAL", owner: "akin-ozer", repoName: "b", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(boundary(f.workflow, "triage", "ready")).toBe("auto");
    expect(boundary(f.workflow, "ready", "impl")).toBe("auto");
    // Ruling 519: nobody confirms the move into Review on a new board; the
    // operator makes it. CANARY: put the template's edge back to `approval`.
    expect(boundary(f.workflow, "impl", "review")).toBe("auto");
    expect(opAutonomy(f.agents)).toBeUndefined(); // supervised (default)
    const op = f.agents.find((a) => a.profileId === "operator")!;
    expect(
      op.capabilities.find((c) => c.capabilityId === "deliver-review-pr")?.mode,
    ).toBe("direct");
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
    answeringGithub();
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
    answeringGithub();
    const r = await createProject(
      store.db,
      { name: "Strict", key: "STR", owner: "akin-ozer", repoName: "s", policy: "strict" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(boundary(f.workflow, "triage", "ready")).toBe("approval");
    expect(boundary(f.workflow, "ready", "impl")).toBe("approval");
    // Ruling 519 made the move into Review automatic on the template; a strict
    // board still has a person approve it. CANARY: let `presetWorkflow` gate
    // only the boundaries before work starts and this reads `auto`.
    expect(boundary(f.workflow, "impl", "review")).toBe("approval");
    // review→done stays the locked human boundary.
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

  it("auto = the operator runs at full autonomy + explicit completion-for-acceptance:direct (Q1)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    answeringGithub();
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
    answeringGithub();
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
    const { specialistEligibleForStage } = await import("~/server/tasks/specialist-roster.server");
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

  // Ruling 672: a repository is named whole, connection and name, or not at
  // all, whatever the board delivers. (Every project took one under the
  // 2026-07-17 ruling; ruling 667 lifted that for a board that delivers
  // results, and 672 for one that delivers software.)
  it.each([
    ["a blank repository name", "akin-ozer", "   "],
    ["a repository name with no owner", "", "some-repo"],
  ])("refuses a software board with %s, half a repository", async (_label, owner, repoName) => {
    // CANARY: take the half that was given and a project is written with a
    // repository nobody named, or probed against one that names no owner.
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Repoless", key: "RPL", owner, repoName, policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(
      "Give both a GitHub connection and a repository name, or neither: a board can start without a repository and connect one later.",
    );
    expect(existsSync(join(store.dataRoot, "projects", "repoless"))).toBe(false);
  });

  it("refuses the reserved EPIC prefix before it creates anything", async () => {
    // Canary: drop the isReservedTaskPrefix guard in createProject — the
    // project is created and its task keys read as epic ids (ruling 503).
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Epic Keeper", key: "epic", owner: "akin-ozer", repoName: "epic-keeper", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/not available as a task prefix/i);
    // Nothing was created, and no repo call was attempted.
    expect(existsSync(join(store.dataRoot, "projects", "epic-keeper"))).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

/**
 * Ruling 672 (owner, 2026-10-06): "repoless boards should exist … at
 * creation". A board that delivers software may start with no repository:
 * the dead end the 2026-07-17 ruling closed is gone, because the operator
 * asks for one the first time a task needs it.
 */
describe("ruling 672: a board that delivers software can start with no repository", () => {
  it("is created with none, reaches GitHub for nothing, keeps its agents' repo-write and says what happens next", async () => {
    // CANARY: require a repository of a software board and this throws;
    // withhold repo-write as a results board does and connecting a repository
    // later leaves a Developer that cannot write it.
    const store = setupTestStore(ctx);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await createProject(
      store.db,
      { name: "Later", key: "LAT", owner: "", repoName: "", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({
      slug: "later",
      repo: null,
      repoWarning: null,
      repoNote:
        "It has no repository yet: tasks come back as files until one is connected. The operator asks for it the first time a task needs a pull request, and it can be attached any time in the project's settings.",
    });
    const fm = readProjectFile({ projectSlug: "later", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.repo).toBeNull();
    expect(getProjectCredential(store.db, "later")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      listDeployedSpecialists("later", { dataRoot: store.dataRoot }).map((a) => [a.id, a.capabilities.delivery]),
    ).toContainEqual(["developer", true]);
    expect(listAuditEvents(store.db).find((e) => e.action === "project.created")!.details).toMatchObject({
      delivers: "software",
      repo: null,
    });
  });
});

/**
 * Ruling 667 (owner, 2026-10-06): "now this is a no-code development board. So
 * let's just make the github connection for this board type optional." A
 * board that delivers results hands back the files its agents save on each
 * task, so creation asks what the board delivers and takes a results board
 * with no repository and no connection. Live, the AWS calculator board had to
 * be given `akin-ozer/aws-calculator`, to which ten rounds of work committed
 * nothing and on which 92 empty task branches piled up.
 */
describe("ruling 667: a board that delivers results needs no repository", () => {
  const REPO_WRITE = ["execute-code-or-write-repo", "create-task-branch", "commit-push-branch", "open-review-pr"];
  /** Each specialist's repo-write grants, as project.md holds them. */
  const repoWriteModes = (dataRoot: string, slug: string) =>
    readProjectFile({ projectSlug: slug, dataRoot })!
      .parsed.frontmatter.agents.filter((a) => a.profileId !== "operator")
      .map((a): [string, (string | null)[]] => [
        a.profileId,
        REPO_WRITE.map((id) => a.capabilities.find((c) => c.capabilityId === id)?.mode ?? null),
      ]);

  it("is created with no repository, no connection and no credential, and none of its agents may write one", async () => {
    // CANARY: require `owner` and `repoName` whatever the board delivers and
    // this throws; drop `withoutRepoWrite` and the Developer is deployed able
    // to commit to a repository the board does not have.
    const store = setupTestStore(ctx);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await createProject(
      store.db,
      { name: "Estimates", key: "EST", delivers: "results", owner: "", repoName: "", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ slug: "estimates", repo: null, repoWarning: null, repoNote: null });
    const fm = readProjectFile({ projectSlug: "estimates", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.repo).toBeNull();
    expect(getProjectCredential(store.db, "estimates")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repoWriteModes(store.dataRoot, "estimates")).toEqual([
      ["developer", ["off", "off", "off", "off"]],
      ["reviewer", ["off", "off", "off", "off"]],
    ]);
    // The operator's own row is untouched: its delivery grant is about the
    // server's push, and there is nothing here for it to push.
    expect(fm.agents.find((a) => a.profileId === "operator")!.capabilities).not.toContainEqual({
      capabilityId: "execute-code-or-write-repo",
      mode: "off",
    });
    const created = listAuditEvents(store.db).find((e) => e.action === "project.created")!;
    expect(created.details).toMatchObject({ delivers: "results", repo: null });
  });

  it("takes a repository for its agents to read, binds it, and still deploys nobody able to write it", async () => {
    // CANARY: withhold repo-write only when the repository is left out and a
    // results board that reads a repository gets a Developer that commits to it.
    const store = setupTestStore(ctx);
    const patId = seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 })),
    );
    const result = await createProject(
      store.db,
      { name: "Audit Notes", key: "AUD", delivers: "results", owner: "akin-ozer", repoName: "audit-notes", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result.repo).toBe("akin-ozer/audit-notes");
    expect(getProjectCredential(store.db, result.slug)?.id).toBe(patId);
    expect(repoWriteModes(store.dataRoot, result.slug).flatMap(([, modes]) => modes)).toEqual(
      Array.from({ length: 8 }, () => "off"),
    );
  });

  const refusals: [string, Partial<CreateProjectInput>, string][] = [
    [
      "half a repository",
      { owner: "akin-ozer", repoName: "" },
      "Give both a GitHub connection and a repository name, or neither: a board can start without a repository and connect one later.",
    ],
    [
      "a repository to create that it does not name",
      { owner: "", repoName: "", createRepository: { private: true } },
      "There is no repository to create: name the GitHub connection and the repository, or leave `createRepository` out.",
    ],
  ];
  it.each(refusals)("refuses %s, and writes nothing", async (_label, patch, sentence) => {
    // CANARY: drop either refusal and the project is written with a
    // repository nobody chose, or with a creation request that did nothing.
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Estimates", key: "EST", delivers: "results", owner: "", repoName: "", policy: "balanced", ...patch },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(sentence);
    expect(existsSync(join(store.dataRoot, "projects", "estimates"))).toBe(false);
  });
});

describe("ruling 364: a stage colour is one of twenty preset names, or the door refuses it", () => {
  it("accepts a preset name, refuses a hex naming the presets, and colours omitted stages from the presets", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    answeringGithub();
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
    // Live: the shopify board's `slate` and `amber` drew nothing for two days
    // because ruling 352 refused NAMES and kept hexes — the inverse of what the
    // stylesheet can paint now. CANARY: let isStageColor accept anything.
    await expect(create("CLA", "slate")).resolves.toBeTruthy();
    await expect(create("CLB", "#8b8b8b")).rejects.toThrow(
      /"#8b8b8b".*not a stage colour preset.*slate, gray, stone/,
    );
    await expect(create("CLC", "Slate")).rejects.toThrow(/not a stage colour preset/);
    const created = await create("CLD", "amber");
    const stages = readProjectFile({ projectSlug: created.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.stages;
    expect(stages.map((s) => s.color)).toEqual(["amber", "green"]);
    for (const s of stages) expect(isStageColor(s.color)).toBe(true);
  });
});

/**
 * Ruling 462 (F40-5): creating a project can create its GitHub repository.
 * No product path did: the owner asked the controller to "create everything:
 * the repo and project" and had to make `akin-ozer/website` by hand first,
 * because creation only PROBED an existing repository and warned "create it
 * before agents start delivering".
 *
 * Every case runs against a fake GitHub handed in as `fetchImpl`; nothing here
 * reaches the network.
 */
describe("ruling 462: createRepository creates the repository before the project", () => {
  const TOKEN_LOGIN = "akin-ozer";

  /** A connection for `owner` whose stored validation names the token's login,
   *  the way a real connection save records it. */
  function seedValidatedConnection(
    db: import("node:sqlite").DatabaseSync,
    userId: string,
    owner: string,
  ) {
    const pat = createPat(
      db,
      { userId, label: `connection · ${owner}`, token: "ghp_createrepo000000000000000000000000" },
      ACTOR,
    );
    recordPatValidation(db, pat.id, {
      status: "valid",
      checkedAt: new Date().toISOString(),
      login: TOKEN_LOGIN,
      tokenKind: "classic",
      expiresAt: null,
      repo: null,
      scopes: [],
      missingScopes: [],
      headerScopes: ["repo"],
      detail: "",
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(owner, owner, pat.id, now, now);
  }

  /** The repository is missing until a create succeeds, then GitHub serves it. */
  function missingThenCreated(owner: string, name: string, create: FakeResponseSpec) {
    let created = false;
    const answerCreate = (): FakeResponseSpec => {
      if ((create.status ?? 201) < 300) created = true;
      return create;
    };
    return fakeGithubFetch({
      [`GET /repos/${owner}/${name}`]: () =>
        created
          ? { body: { default_branch: "main", permissions: { push: true } } }
          : { status: 404, body: { message: "Not Found" } },
      "POST /user/repos": answerCreate,
      [`POST /orgs/${owner}/repos`]: answerCreate,
    });
  }

  const website = (extra: Partial<CreateProjectInput> = {}): CreateProjectInput => ({
    name: "Website",
    key: "WEB",
    owner: "akin-ozer",
    repoName: "website",
    policy: "balanced",
    createRepository: { private: true },
    ...extra,
  });

  it("creates a missing repository through the connection's token, then writes and audits the project", async () => {
    // CANARY: drop the createRepositoryWhenMissing call and no POST is made:
    // the creation is refused, because GitHub has no such repository.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = missingThenCreated("akin-ozer", "website", {
      status: 201,
      body: { full_name: "akin-ozer/website", default_branch: "main" },
    });

    const result = await createProject(store.db, website(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });

    // The token's own login owns the repository, so it is a user repository.
    const posts = gh.callsTo("POST /user/repos");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ name: "website", private: true, auto_init: true });
    expect(gh.callsTo("POST /orgs/akin-ozer/repos")).toHaveLength(0);
    // Probed, created, re-probed: the create came before any project write.
    expect(gh.calls.map((c) => `${c.method} ${c.url.pathname}`).slice(0, 3)).toEqual([
      "GET /repos/akin-ozer/website",
      "POST /user/repos",
      "GET /repos/akin-ozer/website",
    ]);

    const file = readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot });
    expect(file?.parsed.frontmatter.repo).toBe("akin-ozer/website");
    expect(file?.parsed.frontmatter.defaultBranch).toBe("main");
    expect(result.repoWarning).toBeNull();
    expect(result.repoNote).toBe("Created akin-ozer/website on GitHub (private).");

    const audit = listAuditEvents(store.db, { action: "project.repository.created" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorLabel).toBe(ACTOR.label);
    expect(audit[0]!.projectSlug).toBe("website");
    expect(audit[0]!.details).toEqual({ repo: "akin-ozer/website", private: true });
    expect(listAuditEvents(store.db, { action: "project.created" })).toHaveLength(1);
  });

  it("ruling 671: a repository Viberr just made, which GitHub then does not confirm, is said to be there and no project is written", async () => {
    // The create answered 201 and the read after it found nothing: GitHub
    // lagging. CANARY: answer with the plain not-found refusal and a person is
    // told to check the name of a repository Viberr created a moment ago.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": { status: 404, body: { message: "Not Found" } },
      "POST /user/repos": { status: 201, body: { full_name: "akin-ozer/website", default_branch: "main" } },
    });
    await expect(
      createProject(store.db, website(), ACTOR, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage:
        "Created akin-ozer/website on GitHub (private). GitHub did not confirm it when asked again, so no project was written. Ask again: the repository is there now, and the project will use it as it is.",
    });
    expect(readProjectFile({ projectSlug: "website", dataRoot: store.dataRoot })).toBeNull();
    expect(listAuditEvents(store.db, { action: "project.repository.created" })).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "project.created" })).toHaveLength(0);
  });

  it("a token that cannot create repositories refuses by name and writes nothing", async () => {
    // CANARY: map the 403 to anything but the ruling's sentence, or let the
    // refusal fall through to a written project with a warning.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = missingThenCreated("akin-ozer", "website", {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    });

    await expect(
      createProject(store.db, website(), ACTOR, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    ).rejects.toThrow(
      "The akin-ozer connection's token cannot create repositories. A fine-grained token needs Administration: Read and write for All repositories (a classic token needs `repo`). Create akin-ozer/website on GitHub, or widen the token, and ask again.",
    );
    expect(existsSync(join(store.dataRoot, "projects", "website"))).toBe(false);
    expect(
      store.db.prepare(`SELECT slug FROM projects WHERE slug = 'website'`).get(),
    ).toBeUndefined();
    expect(listAuditEvents(store.db, { action: "project.repository.created" })).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "project.created" })).toHaveLength(0);
  });

  it("a name GitHub refuses (422) is refused in GitHub's own words, and nothing is written", async () => {
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = missingThenCreated("akin-ozer", "website", {
      status: 422,
      body: {
        message: "Repository creation failed.",
        errors: [
          {
            resource: "Repository",
            code: "custom",
            field: "name",
            message: "name already exists on this account",
          },
        ],
      },
    });

    await expect(
      createProject(store.db, website(), ACTOR, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    ).rejects.toThrow(
      "GitHub refused to create akin-ozer/website: Repository creation failed (name already exists on this account). Nothing was created.",
    );
    expect(existsSync(join(store.dataRoot, "projects", "website"))).toBe(false);
  });

  /** GitHub makes the repository but answers the create 502, and refuses a
   *  second create of the same name the way it does ("name already exists"). */
  function madeThenBadGateway(owner: string, name: string) {
    let made = false;
    return fakeGithubFetch({
      [`GET /repos/${owner}/${name}`]: () =>
        made
          ? { body: { default_branch: "main", permissions: { push: true } } }
          : { status: 404, body: { message: "Not Found" } },
      "POST /user/repos": () => {
        if (made) {
          return {
            status: 422,
            body: {
              message: "Repository creation failed.",
              errors: [{ message: "name already exists on this account" }],
            },
          };
        }
        made = true;
        return { status: 502, body: { message: "Server Error" } };
      },
    });
  }

  it("a create GitHub made but answered 502 is sent once, recorded as made, and the project uses it (R-repo-1)", async () => {
    // CANARY: let the client retry the POST and the retry's 422 says "Nothing
    // was created" about a repository Viberr just made, with no audit row;
    // skip the read-back after a 5xx and it refuses without looking.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = madeThenBadGateway("akin-ozer", "website");

    const result = await createProject(store.db, website(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });

    expect(gh.callsTo("POST /user/repos")).toHaveLength(1);
    expect(result.repoNote).toBe(
      "Created akin-ozer/website on GitHub (private): GitHub answered 502, but the repository is there now.",
    );
    expect(result.repoWarning).toBeNull();
    expect(
      listAuditEvents(store.db, { action: "project.repository.created" }).map((e) => e.details),
    ).toEqual([{ repo: "akin-ozer/website", private: true }]);
    expect(readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot })?.parsed.frontmatter.repo).toBe(
      "akin-ozer/website",
    );
  });

  it("the repository it creates joins the connection's stored reach; an unknown reach stays unknown (R-seams-4)", async () => {
    // CANARY: drop the reach update and `list_github_connections` (which reads
    // this record) says the token cannot see the repository it just made.
    const { getConnection } = await import("~/server/org/connections.server");
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const readAt = "2026-09-24T20:00:00.000Z";
    store.db
      .prepare(`UPDATE github_connections SET reach_json = ? WHERE id = 'akin-ozer'`)
      .run(
        JSON.stringify({
          status: "read",
          readAt,
          repos: [{ fullName: "akin-ozer/viberr", private: false, canPush: true }],
          capped: false,
        }),
      );
    const gh = missingThenCreated("akin-ozer", "website", {
      status: 201,
      body: { full_name: "akin-ozer/website", default_branch: "main" },
    });

    await createProject(store.db, website(), ACTOR, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl });

    expect(getConnection(store.db, "akin-ozer")?.reach).toEqual({
      status: "read",
      readAt,
      repos: [
        { fullName: "akin-ozer/viberr", private: false, canPush: true },
        { fullName: "akin-ozer/website", private: true, canPush: true },
      ],
      capped: false,
      total: 2,
      privateCount: 1,
    });

    // A reach that could not be read is not made into a one-repository count.
    const unknown = { status: "unknown", readAt, reason: "GitHub answered 403 on /user/repos (no)" };
    store.db
      .prepare(`UPDATE github_connections SET reach_json = ? WHERE id = 'akin-ozer'`)
      .run(JSON.stringify(unknown));
    const again = missingThenCreated("akin-ozer", "docs", {
      status: 201,
      body: { full_name: "akin-ozer/docs", default_branch: "main" },
    });
    await createProject(
      store.db,
      website({ name: "Docs", key: "DOC", repoName: "docs" }),
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: again.fetchImpl },
    );
    expect(getConnection(store.db, "akin-ozer")?.reach).toEqual(unknown);
  });

  it("a create whose connection dropped is read back the same way (R-repo-1)", async () => {
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    let made = false;
    const reads = fakeGithubFetch({
      "GET /repos/akin-ozer/website": () =>
        made
          ? { body: { default_branch: "main", permissions: { push: true } } }
          : { status: 404, body: { message: "Not Found" } },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        made = true;
        throw new TypeError("socket hang up");
      }
      return reads.fetchImpl(input, init);
    };

    const result = await createProject(store.db, website(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl,
    });

    expect(result.repoNote).toBe(
      "Created akin-ozer/website on GitHub (private): the connection dropped before GitHub answered, but the repository is there now.",
    );
    expect(listAuditEvents(store.db, { action: "project.repository.created" })).toHaveLength(1);
  });

  it("a 5xx that made nothing refuses without saying nothing was created (R-repo-1)", async () => {
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": { status: 404, body: { message: "Not Found" } },
      "POST /user/repos": { status: 502, body: { message: "Server Error" } },
    });

    const refused = createProject(store.db, website(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    await expect(refused).rejects.toThrow(
      "GitHub answered 502 when asked to create akin-ozer/website: Server Error. No project was written; ask again.",
    );
    expect(gh.callsTo("POST /user/repos")).toHaveLength(1);
    expect(existsSync(join(store.dataRoot, "projects", "website"))).toBe(false);
    expect(listAuditEvents(store.db, { action: "project.repository.created" })).toHaveLength(0);
  });

  it("an existing repository makes the flag a no-op, and the reply says it was used", async () => {
    // CANARY: POST whatever the probe said and this sees a create call.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": {
        body: { default_branch: "trunk", permissions: { push: true } },
      },
    });

    const result = await createProject(store.db, website(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });

    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(result.repoNote).toBe(
      "akin-ozer/website already exists on GitHub, so the project uses it as it is.",
    );
    expect(
      readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot })?.parsed
        .frontmatter.defaultBranch,
    ).toBe("trunk");
    expect(listAuditEvents(store.db, { action: "project.repository.created" })).toHaveLength(0);
  });

  it("an owner that is not the token's own login is an organization: POST /orgs/{owner}/repos", async () => {
    // CANARY: always POST /user/repos and the repository lands under the
    // token's login instead of the organization the project names.
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "viberr-org");
    const gh = missingThenCreated("viberr-org", "site", {
      status: 201,
      body: { full_name: "viberr-org/site", default_branch: "main" },
    });

    const result = await createProject(
      store.db,
      website({
        name: "Org Site",
        key: "ORG",
        owner: "viberr-org",
        repoName: "site",
        createRepository: { private: false, description: "The org's public site" },
      }),
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );

    expect(gh.callsTo("POST /user/repos")).toHaveLength(0);
    const posts = gh.callsTo("POST /orgs/viberr-org/repos");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: "site",
      private: false,
      auto_init: true,
      description: "The org's public site",
    });
    expect(result.repoNote).toBe("Created viberr-org/site on GitHub (public).");
    expect(
      listAuditEvents(store.db, { action: "project.repository.created" })[0]!.details,
    ).toEqual({ repo: "viberr-org/site", private: false });
  });

  it("a probe that cannot tell whether the repository exists refuses instead of guessing", async () => {
    // Created anyway, the project would hold a repository nobody made, and
    // asking again would only answer "already exists".
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    await expect(
      createProject(store.db, website(), ACTOR, {
        dataRoot: store.dataRoot,
        fetchImpl: unreachableFetch(),
      }),
    ).rejects.toThrow(
      "Couldn't reach GitHub to check whether akin-ozer/website exists, so nothing was created.",
    );
    expect(existsSync(join(store.dataRoot, "projects", "website"))).toBe(false);
  });

  it("a name GitHub would rewrite is refused before any call", async () => {
    const store = setupTestStore(ctx);
    seedValidatedConnection(store.db, store.users.arda.id, "akin-ozer");
    const gh = fakeGithubFetch({});
    await expect(
      createProject(store.db, website({ repoName: "my site" }), ACTOR, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).rejects.toThrow(/GitHub repository names use letters, digits/);
    expect(gh.calls).toHaveLength(0);
  });
});

/**
 * Ruling 464 (pass 40, F40-7): a controller that designed six specialists got
 * the template's generic Developer and Reviewer written beside them, both
 * dispatchable, and no tool to take them off. `agents` names the roster; the
 * base one is written only when it is absent.
 */
describe("ruling 464: a designed roster replaces the base specialists", () => {
  /** A claude specialist template in the store, the way a shipped one reads. */
  function writeTemplate(dataRoot: string, id: string, name: string) {
    writeFileSync(
      join(dataRoot, "agents", "profiles", `${id}.md`),
      [
        "---",
        `id: ${id}`,
        "kind: specialist",
        `name: ${name}`,
        "role: Implementation",
        "backends:",
        "  - claude",
        "model: sonnet",
        "stages:",
        "  - impl",
        "resources:",
        "  skills: []",
        "  mcps: []",
        "  kb: []",
        "capabilities:",
        "  - capabilityId: execute-code-or-write-repo",
        "    mode: direct",
        "---",
        "",
        `You are the ${name}.`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  function setup() {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    seedDefaultAgentAssets(store.dataRoot);
    mkdirSync(join(store.dataRoot, "agents", "profiles"), { recursive: true });
    writeTemplate(store.dataRoot, "site-builder", "Site Builder");
    writeTemplate(store.dataRoot, "content-editor", "Content Editor");
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/site": { body: { default_branch: "main", permissions: { push: true } } },
    });
    return { store, gh };
  }

  const TOP = effortsFor("claude").at(-1)!;
  const LOW = effortsFor("claude")[0]!;

  const site = (extra: Partial<CreateProjectInput> = {}): CreateProjectInput => ({
    name: "Site",
    key: "SITE",
    owner: "akin-ozer",
    repoName: "site",
    policy: "balanced",
    ...extra,
  });

  it("writes the operator plus exactly the listed deployments, each with its model and effort, and no base Developer or Reviewer", async () => {
    // CANARY: ignore `agents` in resolveRoster (return the base roster) and
    // developer and reviewer are written; drop the overrides and the models
    // read the template's own sonnet.
    const { store, gh } = setup();
    const result = await createProject(
      store.db,
      site({
        agents: [
          { profileId: "site-builder", model: "opus", effort: TOP },
          { profileId: "content-editor", effort: LOW },
        ],
        operator: { model: "opus", effort: TOP },
      }),
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const agents = readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents;
    expect(agents.map((a) => a.profileId)).toEqual(["operator", "site-builder", "content-editor"]);
    const byId = new Map(agents.map((a) => [a.profileId, a]));
    expect(byId.get("site-builder")!.definition).toMatchObject({ model: "opus", effort: TOP, name: "Site Builder" });
    // An omitted model keeps the template's own.
    expect(byId.get("content-editor")!.definition).toMatchObject({ model: "sonnet", effort: LOW });
    // The template's own grants are copied, as deploy_agent copies them.
    expect(byId.get("site-builder")!.capabilities).toContainEqual({
      capabilityId: "execute-code-or-write-repo",
      mode: "direct",
    });
    expect(byId.get("operator")!.definition).toMatchObject({ model: "opus", effort: TOP });
    expect(result.agents.map((a) => [a.profileId, a.model, a.effort])).toEqual([
      ["operator", "opus", TOP],
      ["site-builder", "opus", TOP],
      ["content-editor", "sonnet", LOW],
    ]);
    const audit = listAuditEvents(store.db, { action: "project.created" })[0]!;
    expect(audit.details).toMatchObject({ agents: ["operator", "site-builder", "content-editor"] });
  });

  it("ruling 545: the operator runs on the backend `operator` names, with that backend's model and effort", async () => {
    // CANARY: drop the backend switch in withOperatorOverrides and the Codex
    // model is refused against the operator's own Claude.
    const { store, gh } = setup();
    const result = await createProject(
      store.db,
      site({
        agents: [{ profileId: "site-builder" }],
        operator: { backend: "codex", model: "gpt-6-luna", effort: "max" },
      }),
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const operator = readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === "operator")!;
    expect(operator.definition).toMatchObject({ backends: ["codex"], model: "gpt-6-luna", effort: "max" });
    expect(result.agents[0]).toMatchObject({ profileId: "operator", model: "gpt-6-luna", effort: "max" });
  });

  it("without `agents` the base roster is still written (the New project modal is unchanged)", async () => {
    // CANARY: write only the operator when `agents` is absent.
    const { store, gh } = setup();
    const result = await createProject(store.db, site(), ACTOR, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    const agents = readProjectFile({ projectSlug: result.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents;
    expect(agents.map((a) => a.profileId)).toEqual(["operator", "developer", "reviewer"]);
  });

  // CANARY: resolve the roster after the repository probe and the refusals
  // below spend a GitHub call; drop the effort check from
  // buildLibraryDeployment and the bad tier is written.
  it.each<[string, Partial<CreateProjectInput>, RegExp]>([
    ["an unknown template", { agents: [{ profileId: "no-such-agent" }] }, /No global agent profile `no-such-agent`/],
    ["the operator as a roster entry", { agents: [{ profileId: "operator" }] }, /`operator` is not a specialist template/],
    ["a bad effort", { agents: [{ profileId: "site-builder", effort: "ludicrous" }] }, /"ludicrous" is not an effort tier Claude offers/],
    ["a foreign model", { agents: [{ profileId: "site-builder", model: "gpt-5.6-terra" }] }, /Claude cannot run it/],
    ["a bad operator effort", { operator: { effort: "ludicrous" } }, /"ludicrous" is not an effort tier Claude offers/],
    // Ruling 545: the refusal names the backend the model needs.
    [
      "a Codex model for the operator without its backend",
      { operator: { model: "gpt-6-luna", effort: "max" } },
      /GPT-6 Luna is a Codex model and the operator runs on Claude\. Pass `backend: "codex"` in `operator` to run it on Codex, or pick a Claude model\. Nothing was created\./,
    ],
    ["a Claude model for a Codex operator", { operator: { backend: "codex", model: "opus" } }, /Codex cannot run it/],
    ["an entry listed twice", { agents: [{ profileId: "site-builder" }, { profileId: "site-builder" }] }, /`site-builder` is listed twice/],
    ["an empty roster", { agents: [] }, /Name at least one agent/],
  ])("refuses %s by name with nothing written, GitHub included", async (_label, extra, message) => {
    const { store, gh } = setup();
    await expect(
      createProject(store.db, site({ ...extra, createRepository: { private: true } }), ACTOR, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).rejects.toThrow(message);
    expect(existsSync(join(store.dataRoot, "projects", "site"))).toBe(false);
    expect(gh.calls).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "project.created" })).toHaveLength(0);
  });
});

/**
 * Ruling 468 (F40-12): project creation tells an EMPTY repository from one
 * with commits, records it on the project's repo access, and says Viberr will
 * make the first commit. Live, `akin-ozer/website` was accepted as `ok` and the
 * first operator run asked the owner to push a README.
 */
describe("ruling 468: an empty repository is recognised at creation", () => {
  it("records `empty` on the repo access and says the first commit is Viberr's", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": {
        body: { default_branch: "main", permissions: { push: true }, size: 0 },
      },
      "GET /repos/akin-ozer/website/commits": { status: 409, body: { message: "Git Repository is empty." } },
    });
    const result = await createProject(
      store.db,
      { name: "Website", key: "WEB", owner: "akin-ozer", repoName: "website", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const { readRepoHealth } = await import("~/server/github/repo-health.server");
    // CANARY: drop `empty` from the probe and the record reads as any
    // connected repository, the state the live packet grew from.
    expect(readRepoHealth(store.db, result.slug)?.result).toMatchObject({
      status: "connected",
      repo: "akin-ozer/website",
      empty: true,
    });
    expect(result.repoWarning).toBeNull();
    expect(result.repoNote).toBe(
      "akin-ozer/website is empty: Viberr will create its first commit on main before the first task branch, so nobody needs to push one.",
    );
  });

  it("a repository with commits (size 0 is only the cue) says nothing of the kind", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": {
        body: { default_branch: "main", permissions: { push: true }, size: 0 },
      },
      "GET /repos/akin-ozer/website/commits": { body: [{ sha: "abc" }] },
    });
    const result = await createProject(
      store.db,
      { name: "Website", key: "WEB", owner: "akin-ozer", repoName: "website", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const { readRepoHealth } = await import("~/server/github/repo-health.server");
    expect(readRepoHealth(store.db, result.slug)?.result).not.toHaveProperty("empty");
    expect(result.repoNote).toBeNull();
  });

  it("an empty repository behind a token that can only read names the token, not a commit Viberr cannot make (R-repo-2)", async () => {
    // CANARY: drop the read-only arm from the note and it promises a first
    // commit GitHub will refuse, beside the warning that says it cannot push.
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/website": {
        body: { default_branch: "main", permissions: { pull: true, push: false }, size: 0 },
      },
      "GET /repos/akin-ozer/website/commits": { status: 409, body: { message: "Git Repository is empty." } },
    });
    const result = await createProject(
      store.db,
      { name: "Website", key: "WEB", owner: "akin-ozer", repoName: "website", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const { readRepoHealth } = await import("~/server/github/repo-health.server");
    expect(readRepoHealth(store.db, result.slug)?.result).toMatchObject({
      status: "connected",
      empty: true,
      readOnly: true,
    });
    expect(result.repoWarning).toContain("can read akin-ozer/website but cannot push to it");
    expect(result.repoNote).toBe(
      "akin-ozer/website is empty, and this connection's token can only read it, so Viberr cannot create its first commit on main yet. Once the token can push, Viberr makes that commit before the first task branch.",
    );
  });
});
