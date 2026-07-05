import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { createPat, getProjectCredential } from "~/server/secrets/pat-store.server";
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
function seedConnection(db: import("better-sqlite3").Database, userId: string) {
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

  it("falls back to main and binds nothing when the connection is unknown", async () => {
    const store = setupTestStore(ctx);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createProject(
      store.db,
      { name: "Ghostly", key: "GHO", owner: "nobody", repoName: "ghost", template: "governed", policy: "balanced" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );

    expect(getProjectCredential(store.db, result.slug)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = store.db
      .prepare(`SELECT default_branch FROM projects WHERE slug = ?`)
      .get(result.slug) as { default_branch: string };
    expect(row.default_branch).toBe("main");
  });
});
