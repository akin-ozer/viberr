import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
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
  readStoreDoc,
  writeStoreDoc,
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

async function setupKb() {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  const ctx = { dataRoot };
  const { kb } = await saveKnowledgeBase(db, { name: "API contracts", refresh: "manual" }, ACTOR, ctx);
  const target = resolveStoreTarget(db, "kb", kb.id, ctx)!;
  return { db, dataRoot, ctx, kb, target };
}

describe("uploads", () => {
  it("writes real files, preserves structure, skips dotfiles", async () => {
    const { db, target } = await setupKb();
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

  it("refuses traversal and file-over-directory clobbering", async () => {
    const { db, target } = await setupKb();
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

  it("flags a root-level SKILL.md landing in a skill folder (capture)", async () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { skill } = await saveSkill(
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
  it("mkdir -p a/b/c; a FILE occupying a segment refuses with mock copy", async () => {
    const { db, target } = await setupKb();
    const made = createStoreFolder(db, target, [], "a/b/c", ACTOR);
    expect(made.createdPath).toEqual(["a", "b", "c"]);
    expect(existsSync(path.join(target.rootAbs, "a", "b", "c"))).toBe(true);

    writeStoreFiles(db, target, [], [{ relPath: "notes.md", data: Buffer.from("x") }], ACTOR);
    expect(() => createStoreFolder(db, target, [], "notes.md/sub", ACTOR)).toThrowError(
      "A file named “notes.md” already exists here",
    );
  });

  it("deletes files and folders recursively with real counts", async () => {
    const { db, target } = await setupKb();
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

  it("scan sorts dirs before files and skips dotfiles", async () => {
    const { db, target } = await setupKb();
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
    const { db, target } = await setupKb();
    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
    );
    expect(result.status).toBe("no_connection");
  });

  it("rejects garbage URLs with the mock copy", async () => {
    const { db, target } = await setupKb();
    const result = await importGithubSnapshot(db, target, "not-a-github-link", ACTOR);
    expect(result.status).toBe("invalid_url");
    if (result.status === "invalid_url") {
      expect(result.message).toContain("Paste a GitHub link");
    }
  });

  it("fetches a real snapshot through the default connection (canned)", async () => {
    const { db, target } = await setupKb();
    insertUser(db, {
      id: "u_admin",
      email: "admin@test.dev",
      name: "Admin Test",
      role: "admin",
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
        "2 files imported from owner/repo/docs into docs/ — snapshot, not a live sync",
      );
    }
    expect(readFileSync(path.join(target.rootAbs, "docs", "readme.md"), "utf8")).toBe(
      "# readme",
    );
    expect(readFileSync(path.join(target.rootAbs, "docs", "sub", "deep.md"), "utf8")).toBe(
      "# deep",
    );
    expect(existsSync(path.join(target.rootAbs, "docs", ".hidden.md"))).toBe(false);

    // P13-KM-13: re-importing the SAME source refreshes its folder in place.
    // It used to suffix (`docs-2`), so every re-import left another full copy
    // behind and all of them were injected into every run.
    const again = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(again.status).toBe("imported");
    if (again.status === "imported") {
      expect(again.folder).toBe("docs");
      // Clean import → nothing skipped, toast stays clean (E5).
      expect(again.skipped).toBe(0);
      expect(again.toast).not.toContain("skipped");
    }
  });

  it("surfaces per-blob failures instead of a clean success (E5)", async () => {
    const { db, target } = await setupKb();
    insertUser(db, {
      id: "u_admin",
      email: "admin@test.dev",
      name: "Admin Test",
      role: "admin",
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

/* ------------------------------- in-app document authoring (P13-LV-06) */

describe("writeStoreDoc", () => {
  it("creates a document inside the KB folder and touches freshness", async () => {
    const { db, ctx, kb, target } = await setupKb();
    const result = writeStoreDoc(db, target, [], "release-facts", "# Facts\n\nSentinel.", ACTOR);
    expect(result.path).toEqual(["release-facts.md"]);
    const abs = path.join(kbDirPath(kb.dir, ctx.dataRoot), "release-facts.md");
    expect(readFileSync(abs, "utf8")).toContain("Sentinel.");
    // The doc is a normal store file: the tree sees it and the KB re-indexes.
    expect(scanStoreTree(kbDirPath(kb.dir, ctx.dataRoot)).map((n) => n.name)).toContain(
      "release-facts.md",
    );
  });

  it("refuses a non-text extension and path traversal", async () => {
    const { db, target } = await setupKb();
    expect(() => writeStoreDoc(db, target, [], "evil.sh", "rm -rf /", ACTOR)).toThrowError(
      /only edits text documents/,
    );
    expect(() => writeStoreDoc(db, target, ["../.."], "x.md", "x", ACTOR)).toThrowError();
    expect(() => writeStoreDoc(db, target, [], "  ", "x", ACTOR)).toThrowError(
      /file name/,
    );
  });

  it("reads a document back for the editor", async () => {
    const { db, target } = await setupKb();
    writeStoreDoc(db, target, ["notes"], "a.md", "hello", ACTOR);
    expect(readStoreDoc(target, ["notes", "a.md"])).toMatchObject({ text: "hello" });
    expect(readStoreDoc(target, ["nope.md"])).toBeNull();
  });

  it("P14-UI-59: refuses to clobber an existing doc unless told to replace it", async () => {
    const { db, ctx, kb, target } = await setupKb();
    writeStoreDoc(db, target, [], "facts.md", "ORIGINAL", ACTOR);

    // The old write path was unconditional create-or-overwrite and reported both
    // with the same "saved" toast, so retyping a name destroyed the file.
    expect(() =>
      writeStoreDoc(db, target, [], "facts.md", "CLOBBER", ACTOR),
    ).toThrowError(/already exists/);
    const abs = path.join(kbDirPath(kb.dir, ctx.dataRoot), "facts.md");
    expect(readFileSync(abs, "utf8")).toBe("ORIGINAL");

    const replaced = writeStoreDoc(db, target, [], "facts.md", "REPLACED", ACTOR, {
      overwrite: true,
    });
    expect(replaced.replaced).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("REPLACED");
  });

  // P14-RV-02: `assertInsideRoot` was LEXICAL — it proved the path STRING sat
  // under the store root, not the file. A symlink inside the store (which users
  // manage on disk, and uploads/imports write to) pointed anywhere: a link named
  // `innocent.md` served an arbitrary host file to whoever opened it in the app,
  // and a write through one would have clobbered the link's target. The KB
  // injector has refused to follow symlinks since F9; the store paths now agree.
  it("P14-RV-02: refuses to READ through a symlink that leaves the store", async () => {
    const { ctx, kb, target } = await setupKb();
    const dir = kbDirPath(kb.dir, ctx.dataRoot);
    const outside = path.join(ctx.dataRoot, "outside-secret.md");
    writeFileSync(outside, "HOST-SECRET");
    symlinkSync(outside, path.join(dir, "innocent.md"));
    expect(() => readStoreDoc(target, ["innocent.md"])).toThrowError(
      /leaves the store folder/,
    );
  });

  it("P14-RV-02: refuses to WRITE through a symlink that leaves the store", async () => {
    const { db, ctx, kb, target } = await setupKb();
    const dir = kbDirPath(kb.dir, ctx.dataRoot);
    const outside = path.join(ctx.dataRoot, "host-file.md");
    writeFileSync(outside, "ORIGINAL");
    symlinkSync(outside, path.join(dir, "looks-local.md"));
    expect(() =>
      writeStoreDoc(db, target, [], "looks-local.md", "CLOBBERED", ACTOR, {
        overwrite: true,
      }),
    ).toThrowError(/leaves the store folder/);
    // The host file the link pointed at is untouched.
    expect(readFileSync(outside, "utf8")).toBe("ORIGINAL");
  });

  it("refuses to open a non-text document by TYPE, not as 'missing'", async () => {
    const { ctx, kb, target } = await setupKb();
    writeFileSync(path.join(kbDirPath(kb.dir, ctx.dataRoot), "contract.pdf"), "%PDF");
    expect(() => readStoreDoc(target, ["contract.pdf"])).toThrowError(
      /only opens text documents/,
    );
    // A doc that just isn't there is still null, not an error.
    expect(readStoreDoc(target, ["gone.md"])).toBeNull();
  });
});

/* --------------------------- re-import refreshes in place (P13-KM-13) */

describe("importGithubSnapshot re-import", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

  it("refreshes the same source's folder instead of creating a second copy", async () => {
    const { db, target } = await setupKb();
    insertUser(db, {
      id: "u_admin2",
      email: "admin2@test.dev",
      name: "Admin Two",
      role: "admin",
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
      { owner: "owner", token: "ghp_valid_token_1234", userId: "u_admin2" },
      ACTOR,
      { fetchImpl: connectTransport.fetchImpl },
    );

    const snapshot = (text: string) =>
      fakeGithubFetch({
        "GET /repos/owner/repo/git/trees/main": {
          body: {
            truncated: false,
            tree: [{ path: "docs/a.md", type: "blob", sha: "s1", size: 5 }],
          },
        },
        "GET /repos/owner/repo/git/blobs/s1": {
          body: { content: b64(text), encoding: "base64" },
        },
      });

    const url = "https://github.com/owner/repo/tree/main/docs";
    const first = await importGithubSnapshot(db, target, url, ACTOR, {
      fetchImpl: snapshot("first").fetchImpl,
    });
    expect(first.status).toBe("imported");

    const second = await importGithubSnapshot(db, target, url, ACTOR, {
      fetchImpl: snapshot("second").fetchImpl,
    });
    // Before this fix the second import landed in `docs-2`, so BOTH copies were
    // injected into every run and the 24k budget was spent on the stale one.
    expect(second.status).toBe("imported");
    if (second.status !== "imported") return;
    expect(second.folder).toBe("docs");
    expect(second.toast).toContain("re-imported");
    expect(scanStoreTree(target.rootAbs).map((n) => n.name)).toEqual(["docs"]);
    expect(readFileSync(path.join(target.rootAbs, "docs", "a.md"), "utf8")).toBe(
      "second",
    );
  });

  it("P14-KM-08: lands under the browsed folder, and refreshes in place there", async () => {
    const { db, target } = await setupKb();
    insertUser(db, {
      id: "u_admin3",
      email: "admin3@test.dev",
      name: "Admin Three",
      role: "admin",
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
      { owner: "owner", token: "ghp_valid_token_1234", userId: "u_admin3" },
      ACTOR,
      { fetchImpl: connectTransport.fetchImpl },
    );
    const snapshot = fakeGithubFetch({
      "GET /repos/owner/repo/git/trees/main": {
        body: {
          truncated: false,
          tree: [{ path: "docs/a.md", type: "blob", sha: "s1", size: 5 }],
        },
      },
      "GET /repos/owner/repo/git/blobs/s1": {
        body: { content: b64("body"), encoding: "base64" },
      },
    });

    const url = "https://github.com/owner/repo/tree/main/docs";
    // The import used to ignore the browsed folder entirely and always write to
    // the store root, so imports could not be organised from the UI.
    const first = await importGithubSnapshot(db, target, url, ACTOR, {
      fetchImpl: snapshot.fetchImpl,
      dirPath: ["vendor"],
    });
    expect(first.status).toBe("imported");
    if (first.status !== "imported") return;
    expect(first.folder).toBe("vendor/docs");
    expect(first.toast).toContain("into vendor/docs/");
    expect(
      readFileSync(path.join(target.rootAbs, "vendor", "docs", "a.md"), "utf8"),
    ).toBe("body");
    expect(existsSync(path.join(target.rootAbs, "docs"))).toBe(false);

    // The provenance marker travels with the folder, so the same source
    // re-imported into the same folder still refreshes rather than suffixing.
    const again = await importGithubSnapshot(db, target, url, ACTOR, {
      fetchImpl: snapshot.fetchImpl,
      dirPath: ["vendor"],
    });
    expect(again.status).toBe("imported");
    if (again.status !== "imported") return;
    expect(again.folder).toBe("vendor/docs");
    expect(
      scanStoreTree(path.join(target.rootAbs, "vendor")).map((n) => n.name),
    ).toEqual(["docs"]);
  });
});
