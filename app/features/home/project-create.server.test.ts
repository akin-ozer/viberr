import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { createPat, getProjectCredential } from "~/server/secrets/pat-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { createProject } from "./project-create.server";

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
      { name: "Containerless", key: "CTL", owner: "akin-ozer", repoName: "containerless", template: "governed", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );

    // Credential is bound to the project (branch/PR sync + health work).
    const bound = getProjectCredential(store.db, result.slug);
    expect(bound?.id).toBe(patId);

    // Default branch reflects the real repo, not a hardcoded "main".
    const row = store.db
      .prepare(`SELECT default_branch FROM projects WHERE slug = ?`)
      .get(result.slug) as { default_branch: string };
    expect(row.default_branch).toBe("master");
  });

  it("rejects an owner with NO connection behind it (PAT required)", async () => {
    const store = setupTestStore(ctx);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      createProject(
        store.db,
        { name: "Ghostly", key: "GHO", owner: "nobody", repoName: "ghost", template: "governed", policy: "balanced" },
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
      { name: "Bal", key: "BAL", owner: "akin-ozer", repoName: "b", template: "governed", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    const f = fm(store, r.slug);
    expect(boundary(f.workflow, "triage", "ready")).toBe("auto");
    expect(boundary(f.workflow, "ready", "impl")).toBe("auto");
    expect(opAutonomy(f.agents)).toBeUndefined(); // supervised (default)
  });

  it("strict = human-gates the pre-work boundaries (no operator auto-advance)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Strict", key: "STR", owner: "akin-ozer", repoName: "s", template: "governed", policy: "strict" },
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
  });

  it("auto = the operator runs at full autonomy + explicit completion-for-acceptance:direct (Q1)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    const r = await createProject(
      store.db,
      { name: "Auto", key: "AUT", owner: "akin-ozer", repoName: "a", template: "governed", policy: "auto" },
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

  // Repo-bound projects only (2026-07-17 ruling, reverses F10): a repository +
  // PAT connection are mandatory — repo-less creation is rejected in every form.
  it("an EMPTY repo field is rejected (repo-less projects were cut)", async () => {
    const store = setupTestStore(ctx);
    seedConnection(store.db, store.users.arda.id);
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      createProject(
        store.db,
        { name: "Repoless", key: "RPL", owner: "akin-ozer", repoName: "   ", template: "governed", policy: "balanced" },
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
        { name: "First Project", key: "FST", owner: "", repoName: "", template: "governed", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/GitHub repository is required/i);
  });

  it("a repo NAME without an owner is rejected", async () => {
    const store = setupTestStore(ctx);
    await expect(
      createProject(
        store.db,
        { name: "Needs Owner", key: "NDO", owner: "", repoName: "some-repo", template: "governed", policy: "balanced" },
        ACTOR,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrow(/GitHub repository is required/i);
  });
});
