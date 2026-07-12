import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import { hashPassword } from "~/server/auth/password.server";
import { insertUser } from "~/server/auth/user-store.server";
import {
  kbDirPath,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { createConnection } from "./connections.server";
import {
  getSkill,
  listKnowledgeBases,
  listSkills,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveSkill,
} from "./resources.server";
import {
  createStoreFolder,
  deleteStoreNode,
  importGithubSnapshot,
  scanStoreTree,
  writeStoreFiles,
} from "./store-files.server";

/**
 * StoreBrowser fs layer: every op is a REAL mutation under the store root
 * — uploads (structure-preserving), mkdir -p, recursive delete, dotfile
 * skip + traversal rejection, SKILL.md capture, GitHub snapshot import via
 * the default connection (canned transport) incl. the honest
 * "needs a connection" state.
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

const ACTOR = { userId: "u_t", label: "t@test" };

function setupKb() {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  const ctx = { dataRoot };
  const { kb } = saveKnowledgeBase(db, { name: "API contracts", refresh: "manual" }, ACTOR, ctx);
  const target = resolveStoreTarget(db, "kb", kb.id, ctx)!;
  return { db, dataRoot, ctx, kb, target };
}

describe("uploads", () => {
  it("writes real files, preserves structure, skips dotfiles", () => {
    const { db, target } = setupKb();
    const result = writeStoreFiles(
      db,
      target,
      [],
      [
        { relPath: "endpoints/tasks.md", data: Buffer.from("# tasks") },
        { relPath: "versioning.md", data: Buffer.from("# versioning") },
        { relPath: ".DS_Store", data: Buffer.from("junk") },
        { relPath: ".git/config", data: Buffer.from("junk") },
      ],
      ACTOR,
    );
    expect(result.added).toBe(2);
    expect(result.topLevelDirs).toEqual(["endpoints"]);
    expect(readFileSync(path.join(target.rootAbs, "endpoints", "tasks.md"), "utf8")).toBe(
      "# tasks",
    );
    expect(existsSync(path.join(target.rootAbs, ".DS_Store"))).toBe(false);

    // Same-name file replaced silently (mock merge semantics).
    writeStoreFiles(
      db,
      target,
      [],
      [{ relPath: "versioning.md", data: Buffer.from("v2") }],
      ACTOR,
    );
    expect(readFileSync(path.join(target.rootAbs, "versioning.md"), "utf8")).toBe("v2");
  });

  it("refuses traversal and file-over-directory clobbering", () => {
    const { db, target } = setupKb();
    expect(() =>
      writeStoreFiles(
        db,
        target,
        ["../../evil"],
        [{ relPath: "x.md", data: Buffer.from("x") }],
        ACTOR,
      ),
    ).toThrowError(/Invalid folder path/);

    createStoreFolder(db, target, [], "docs", ACTOR);
    expect(() =>
      writeStoreFiles(db, target, [], [{ relPath: "docs", data: Buffer.from("x") }], ACTOR),
    ).toThrowError(/already exists there/);
  });

  it("flags a root-level SKILL.md landing in a skill folder (capture)", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { skill } = saveSkill(
      db,
      { name: "api-design", summary: "REST rules.", body: "old" },
      ACTOR,
      ctx,
    );
    const target = resolveStoreTarget(db, "skill", skill.id, ctx)!;
    const result = writeStoreFiles(
      db,
      target,
      [],
      [{ relPath: "SKILL.md", data: Buffer.from("## captured body") }],
      ACTOR,
    );
    expect(result.capturedSkillMd).toBe(true);
    // The skill body is re-read from disk on the next load.
    expect(getSkill(db, skill.id, ctx)!.body).toBe("## captured body");
  });
});

describe("mkdir + delete", () => {
  it("mkdir -p a/b/c; a FILE occupying a segment refuses with mock copy", () => {
    const { db, target } = setupKb();
    const made = createStoreFolder(db, target, [], "a/b/c", ACTOR);
    expect(made.createdPath).toEqual(["a", "b", "c"]);
    expect(existsSync(path.join(target.rootAbs, "a", "b", "c"))).toBe(true);

    writeStoreFiles(db, target, [], [{ relPath: "notes.md", data: Buffer.from("x") }], ACTOR);
    expect(() => createStoreFolder(db, target, [], "notes.md/sub", ACTOR)).toThrowError(
      "A file named “notes.md” already exists here",
    );
  });

  it("deletes files and folders recursively with real counts", () => {
    const { db, target } = setupKb();
    writeStoreFiles(
      db,
      target,
      [],
      [
        { relPath: "docs/a.md", data: Buffer.from("a") },
        { relPath: "docs/sub/b.md", data: Buffer.from("b") },
      ],
      ACTOR,
    );
    const gone = deleteStoreNode(db, target, ["docs"], ACTOR);
    expect(gone).toMatchObject({ name: "docs", wasDir: true, filesRemoved: 2 });
    expect(existsSync(path.join(target.rootAbs, "docs"))).toBe(false);
    expect(() => deleteStoreNode(db, target, ["docs"], ACTOR)).toThrowError(
      /no longer exists/,
    );
  });

  it("scan sorts dirs before files and skips dotfiles", () => {
    const { db, target } = setupKb();
    writeStoreFiles(
      db,
      target,
      [],
      [
        { relPath: "zeta.md", data: Buffer.from("z") },
        { relPath: "alpha/inner.md", data: Buffer.from("i") },
      ],
      ACTOR,
    );
    writeFileSync(path.join(target.rootAbs, ".hidden"), "x");
    const tree = scanStoreTree(target.rootAbs);
    expect(tree.map((n) => `${n.type}:${n.name}`)).toEqual([
      "dir:alpha",
      "file:zeta.md",
    ]);
  });
});

describe("github import", () => {
  it("returns the honest no-connection state when no validated token exists", async () => {
    const { db, target } = setupKb();
    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
    );
    expect(result.status).toBe("no_connection");
  });

  it("rejects garbage URLs with the mock copy", async () => {
    const { db, target } = setupKb();
    const result = await importGithubSnapshot(db, target, "not-a-github-link", ACTOR);
    expect(result.status).toBe("invalid_url");
    if (result.status === "invalid_url") {
      expect(result.message).toContain("Paste a GitHub link");
    }
  });

  it("fetches a real snapshot through the default connection (canned)", async () => {
    const { db, target } = setupKb();
    insertUser(db, {
      id: "u_admin",
      email: "admin@test.dev",
      name: "Admin Test",
      role: "admin",
      passwordHash: hashPassword("viberr-dev-2828"),
    });
    const connectTransport = fakeGithubFetch({
      "GET /user": {
        body: { login: "owner" },
        headers: { "x-oauth-scopes": "repo, workflow" },
      },
      "GET /users/owner": { body: { public_repos: 1 } },
    });
    await createConnection(
      db,
      { owner: "owner", token: "ghp_valid_token_1234", userId: "u_admin" },
      ACTOR,
      { fetchImpl: connectTransport.fetchImpl },
    );

    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const importTransport = fakeGithubFetch({
      "GET /repos/owner/repo/git/trees/main": {
        body: {
          truncated: false,
          tree: [
            { path: "docs/readme.md", type: "blob", sha: "s1", size: 5 },
            { path: "docs/sub/deep.md", type: "blob", sha: "s2", size: 5 },
            { path: "docs/.hidden.md", type: "blob", sha: "s3", size: 5 },
            { path: "other/skip.md", type: "blob", sha: "s4", size: 5 },
          ],
        },
      },
      "GET /repos/owner/repo/git/blobs/s1": {
        body: { content: b64("# readme"), encoding: "base64" },
      },
      "GET /repos/owner/repo/git/blobs/s2": {
        body: { content: b64("# deep"), encoding: "base64" },
      },
    });

    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(result.status).toBe("imported");
    if (result.status === "imported") {
      expect(result).toMatchObject({ folder: "docs", fileCount: 2 });
      expect(result.toast).toContain(
        "2 files imported from owner/repo/docs — snapshot, not a live sync",
      );
    }
    expect(readFileSync(path.join(target.rootAbs, "docs", "readme.md"), "utf8")).toBe(
      "# readme",
    );
    expect(readFileSync(path.join(target.rootAbs, "docs", "sub", "deep.md"), "utf8")).toBe(
      "# deep",
    );
    expect(existsSync(path.join(target.rootAbs, "docs", ".hidden.md"))).toBe(false);

    // Name collision → suffixed folder (mock semantics, real dirs).
    const again = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(again.status).toBe("imported");
    if (again.status === "imported") {
      expect(again.folder).toBe("docs-2");
      // Clean import → nothing skipped, toast stays clean (E5).
      expect(again.skipped).toBe(0);
      expect(again.toast).not.toContain("skipped");
    }
  });

  it("surfaces per-blob failures instead of a clean success (E5)", async () => {
    const { db, target } = setupKb();
    insertUser(db, {
      id: "u_admin",
      email: "admin@test.dev",
      name: "Admin Test",
      role: "admin",
      passwordHash: hashPassword("viberr-dev-2828"),
    });
    const connectTransport = fakeGithubFetch({
      "GET /user": {
        body: { login: "owner" },
        headers: { "x-oauth-scopes": "repo, workflow" },
      },
      "GET /users/owner": { body: { public_repos: 1 } },
    });
    await createConnection(
      db,
      { owner: "owner", token: "ghp_valid_token_1234", userId: "u_admin" },
      ACTOR,
      { fetchImpl: connectTransport.fetchImpl },
    );

    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    // Blob s2 has NO route → its fetch 404s; the import must not pretend it
    // was a full snapshot.
    const importTransport = fakeGithubFetch({
      "GET /repos/owner/repo/git/trees/main": {
        body: {
          truncated: false,
          tree: [
            { path: "docs/readme.md", type: "blob", sha: "s1", size: 5 },
            { path: "docs/broken.md", type: "blob", sha: "s2", size: 5 },
          ],
        },
      },
      "GET /repos/owner/repo/git/blobs/s1": {
        body: { content: b64("# readme"), encoding: "base64" },
      },
    });

    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(result.status).toBe("imported");
    if (result.status === "imported") {
      expect(result.fileCount).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.toast).toContain("1 file skipped (fetch failed)");
    }
    expect(existsSync(path.join(target.rootAbs, "docs", "readme.md"))).toBe(true);
    expect(existsSync(path.join(target.rootAbs, "docs", "broken.md"))).toBe(false);
  });
});

describe("disk-only resource freshness (E6)", () => {
  it("uploading into a disk-only skill ADOPTS it — freshness advances", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const dir = skillDirPath("shipped-expertise", ctx.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# body");

    // Synthetic disk id → no metadata row; the old touchResource UPDATE
    // matched zero rows and freshness never advanced.
    const target = resolveStoreTarget(db, "skill", "disk:shipped-expertise", ctx)!;
    writeStoreFiles(
      db,
      target,
      [],
      [{ relPath: "notes.md", data: Buffer.from("x") }],
      ACTOR,
    );

    const row = db
      .prepare(`SELECT id, updated_at FROM org_skills WHERE name = ?`)
      .get("shipped-expertise") as { id: string; updated_at: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toMatch(/^sk_/);
    expect(row!.updated_at).toBeTruthy();
    // Exactly ONE listing entry — the adopted row replaces the disk-only one.
    const listed = listSkills(db, ctx).filter((s) => s.name === "shipped-expertise");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.updatedAt).toBe(row!.updated_at);
  });

  it("mkdir + delete into a disk-only KB adopt it and bump last_indexed_at", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const dir = kbDirPath("runbooks", ctx.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "deploy.md"), "# runbook");

    const target = resolveStoreTarget(db, "kb", "disk:runbooks", ctx)!;
    createStoreFolder(db, target, [], "archive", ACTOR);

    const row = db
      .prepare(`SELECT id, last_indexed_at FROM org_knowledge_bases WHERE dir = ?`)
      .get("runbooks") as { id: string; last_indexed_at: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.last_indexed_at).toBeTruthy();

    // A later mutation touches the SAME row (no duplicate adoption).
    deleteStoreNode(db, target, ["deploy.md"], ACTOR);
    const rows = db
      .prepare(`SELECT id FROM org_knowledge_bases WHERE dir = ?`)
      .all("runbooks");
    expect(rows).toHaveLength(1);
    expect(
      listKnowledgeBases(db, ctx).filter((kb) => kb.dir === "runbooks"),
    ).toHaveLength(1);
  });
});
