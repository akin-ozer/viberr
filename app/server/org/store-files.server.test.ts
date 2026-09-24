import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
import { isAppError } from "~/server/errors/app-error.server";
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

/** The freshness columns these tests read back off an adopted store row. */
const skillFreshnessRow = z.object({ id: z.string(), updated_at: z.string() });
const kbIndexedRow = z.object({ id: z.string(), last_indexed_at: z.string() });
const kbStampsRow = z.object({
  last_indexed_at: z.string(),
  updated_at: z.string(),
});
const kbLastIndexedRow = z.object({ last_indexed_at: z.string() });

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

  // Ruling 183 (pass 36, F36-2): the upload path is a SKILL.md writer too.
  it("ruling 183: refuses a root-level SKILL.md that is not a skill before any file in the batch is written", async () => {
    // Canary: move the check into the write loop — notes.md lands first.
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { skill } = await saveSkill(
      db,
      { name: "escaped-upload", summary: "Upload probe.", body: "# kept" },
      ACTOR,
      ctx,
    );
    const target = resolveStoreTarget(db, "skill", skill.id, ctx)!;
    expect(() =>
      writeStoreFiles(
        db,
        target,
        [],
        [
          { relPath: "notes.md", data: Buffer.from("# notes") },
          { relPath: "SKILL.md", data: Buffer.from("# Skill\\n\\nArrived escaped.") },
        ],
        ACTOR,
      ),
    ).toThrowError(/JSON-escaped/);
    expect(existsSync(path.join(target.rootAbs, "notes.md"))).toBe(false);
    expect(getSkill(db, skill.id, ctx)!.body).toBe("# kept");
    // A nested SKILL.md is a supporting file, not the skill: not judged.
    const nested = writeStoreFiles(
      db,
      target,
      [],
      [{ relPath: "examples/SKILL.md", data: Buffer.from("literal \\n is fine here") }],
      ACTOR,
    );
    expect(nested.added).toBe(1);
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
  // A PUBLIC repo is readable without a credential, so demanding a connection
  // up front made the commonest case — "import this skill from GitHub" — flatly
  // impossible on an instance that had never linked GitHub. The connection is
  // now an EXPLANATION for a refusal, not a precondition.
  it("imports a PUBLIC repo with NO connection at all, sending no Authorization", async () => {
    const { db, target } = await setupKb();
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const transport = fakeGithubFetch({
      "GET /repos/blader/humanizer/git/trees/main": {
        body: {
          truncated: false,
          tree: [{ path: "SKILL.md", type: "blob", sha: "s1", size: 9 }],
        },
      },
      "GET /repos/blader/humanizer/git/blobs/s1": {
        body: { content: b64("# humanizer"), encoding: "base64" },
      },
    });

    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/blader/humanizer/blob/main/SKILL.md",
      ACTOR,
      { fetchImpl: transport.fetchImpl },
    );

    expect(result.status).toBe("imported");
    expect(readFileSync(path.join(target.rootAbs, "SKILL.md"), "utf8")).toBe(
      "# humanizer",
    );
    // Anonymous means NO header — an empty `Bearer ` would 401 endpoints that
    // answer fine with no credential at all.
    expect(transport.calls.length).toBeGreaterThan(0);
    for (const call of transport.calls) {
      expect(call.headers["authorization"]).toBeUndefined();
    }
  });

  it("falls back to the no-connection state when the anonymous read 404s", async () => {
    const { db, target } = await setupKb();
    // Tree 404 AND repo 404 (unmatched → 404): private or nonexistent, which
    // GitHub will not distinguish without a credential.
    const transport = fakeGithubFetch({});
    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/secret/tree/main/docs",
      ACTOR,
      { fetchImpl: transport.fetchImpl },
    );
    expect(result.status).toBe("no_connection");
    if (result.status === "no_connection") {
      expect(result.message).toContain("owner/secret is not readable");
      expect(result.message).toContain("add a GitHub connection");
    }
  });

  it("names the anonymous rate limit rather than calling it a refusal", async () => {
    const { db, target } = await setupKb();
    const transport = fakeGithubFetch({
      "GET /repos/owner/repo/git/trees/main": {
        status: 403,
        body: { message: "API rate limit exceeded for 1.2.3.4." },
      },
    });
    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/tree/main/docs",
      ACTOR,
      { fetchImpl: transport.fetchImpl },
    );
    expect(result.status).toBe("no_connection");
    if (result.status === "no_connection") {
      expect(result.message).toContain("unauthenticated rate limit");
    }
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
        "2 files imported from owner/repo/docs into docs/ (a snapshot, not a live sync)",
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

  it("a /blob/ URL imports its ONE file into the browsed folder — no wrapper dir", async () => {
    // Live-caught: a single-file URL selected its blob, then the folder flow
    // sliced the relative path to "" and imported nothing behind a misleading
    // "GitHub refused the file contents". The skill flow depends on this shape:
    // SKILL.md must land at the skill ROOT, not as SKILL.md/SKILL.md.
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
            { path: "SKILL.md", type: "blob", sha: "s1", size: 10 },
            { path: "docs/guide.md", type: "blob", sha: "s2", size: 10 },
          ],
        },
      },
      "GET /repos/owner/repo/git/blobs/s1": {
        body: { content: b64("# humanize"), encoding: "base64" },
      },
      "GET /repos/owner/repo/git/blobs/s2": {
        body: { content: b64("# guide"), encoding: "base64" },
      },
    });

    const result = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/blob/main/SKILL.md",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(result.status).toBe("imported");
    if (result.status === "imported") {
      expect(result).toMatchObject({ folder: "SKILL.md", fileCount: 1, skipped: 0 });
      expect(result.toast).toContain("SKILL.md imported from owner/repo/SKILL.md");
    }
    // The file itself, AT the browsed root — not wrapped in a folder.
    expect(readFileSync(path.join(target.rootAbs, "SKILL.md"), "utf8")).toBe("# humanize");

    // Re-import refreshes the same file in place, saying so.
    const again = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/blob/main/SKILL.md",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(again.status).toBe("imported");
    if (again.status === "imported") {
      expect(again.toast).toContain("re-imported");
    }

    // A NESTED single file lands under its own filename too.
    const nested = await importGithubSnapshot(
      db,
      target,
      "https://github.com/owner/repo/blob/main/docs/guide.md",
      ACTOR,
      { fetchImpl: importTransport.fetchImpl },
    );
    expect(nested.status).toBe("imported");
    if (nested.status === "imported") {
      expect(nested.folder).toBe("guide.md");
    }
    expect(readFileSync(path.join(target.rootAbs, "guide.md"), "utf8")).toBe("# guide");
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

  it("F20-1: the collision scan is bounded — a mount that never yields a free name fails the import, it does not spin", async () => {
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
          tree: [{ path: "docs/readme.md", type: "blob", sha: "s1", size: 5 }],
        },
      },
      "GET /repos/owner/repo/git/blobs/s1": {
        body: { content: b64("# readme"), encoding: "base64" },
      },
    });

    // Stand in for the ghost-inode shape deterministically: occupy `docs` and
    // every suffix through the 32-attempt cap with FOREIGN folders (no import
    // marker), so the scan can never settle on a free name. Under the old
    // unbounded loop this pegged the event loop; now it must throw a typed error.
    for (let n = 0; n <= 32; n++) {
      mkdirSync(path.join(target.rootAbs, n === 0 ? "docs" : `docs-${n + 1}`), {
        recursive: true,
      });
    }

    const start = Date.now();
    let caught: unknown;
    try {
      await importGithubSnapshot(
        db,
        target,
        "https://github.com/owner/repo/tree/main/docs",
        ACTOR,
        { fetchImpl: importTransport.fetchImpl },
      );
    } catch (e) {
      caught = e;
    }
    // A typed error naming the folder — not a spin. It returns immediately,
    // nowhere near a hang.
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.status).toBe(503);
      expect(caught.userMessage).toMatch(/after 32 attempts/i);
      expect(caught.userMessage).toContain("docs");
    }
    expect(Date.now() - start).toBeLessThan(2000);
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

    const stored = db
      .prepare(`SELECT id, updated_at FROM org_skills WHERE name = ?`)
      .get("shipped-expertise");
    expect(stored).toBeDefined();
    const row = skillFreshnessRow.parse(stored);
    expect(row.id).toMatch(/^sk_/);
    expect(row.updated_at).toBeTruthy();
    // Exactly ONE listing entry — the adopted row replaces the disk-only one.
    const listed = listSkills(db, ctx).filter((s) => s.name === "shipped-expertise");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.updatedAt).toBe(row.updated_at);
  });

  it("mkdir + delete into a disk-only KB adopt it and bump last_indexed_at", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const dir = kbDirPath("runbooks", ctx.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "deploy.md"), "# runbook");

    const target = resolveStoreTarget(db, "kb", "disk:runbooks", ctx)!;
    createStoreFolder(db, target, [], "archive", ACTOR);

    const stored = db
      .prepare(`SELECT id, last_indexed_at FROM org_knowledge_bases WHERE dir = ?`)
      .get("runbooks");
    expect(stored).toBeDefined();
    expect(kbIndexedRow.parse(stored).last_indexed_at).toBeTruthy();

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

/**
 * C5/pass-16 — the `manual` refresh pin means "advance the re-scan stamp only
 * on an explicit re-scan". The watcher path honoured it; `touchResource` did
 * not, so any in-app upload / doc write / delete made a manual-pinned KB report
 * "re-scanned just now" when nobody had re-scanned it.
 */
describe("the `manual` refresh pin (C5)", () => {
  it("an in-app mutation does NOT advance last_indexed_at on a manual KB", async () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "Pinned", refresh: "manual" },
      ACTOR,
      ctx,
    );
    const before = kbStampsRow.parse(
      db
        .prepare(`SELECT last_indexed_at, updated_at FROM org_knowledge_bases WHERE id = ?`)
        .get(kb.id),
    );

    const target = resolveStoreTarget(db, "kb", kb.id, ctx)!;
    writeStoreDoc(db, target, [], "note.md", "hello", ACTOR);

    const after = kbStampsRow.parse(
      db
        .prepare(`SELECT last_indexed_at, updated_at FROM org_knowledge_bases WHERE id = ?`)
        .get(kb.id),
    );
    // The re-scan stamp is pinned…
    expect(after.last_indexed_at).toBe(before.last_indexed_at);
    // …but the row genuinely changed, so `updated_at` still moves.
    expect(after.updated_at >= before.updated_at).toBe(true);
  });

  it("an 'on change' KB still advances last_indexed_at (the pin is not a freeze)", async () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "Watched", refresh: "on change" },
      ACTOR,
      ctx,
    );
    db.prepare(
      `UPDATE org_knowledge_bases SET last_indexed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(kb.id);

    const target = resolveStoreTarget(db, "kb", kb.id, ctx)!;
    writeStoreDoc(db, target, [], "note.md", "hello", ACTOR);

    const after = kbLastIndexedRow.parse(
      db
        .prepare(`SELECT last_indexed_at FROM org_knowledge_bases WHERE id = ?`)
        .get(kb.id),
    );
    expect(after.last_indexed_at).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

/**
 * C5/pass-16 — containment consistency. The KB reader (`readKbIndexDetailed`
 * today) has refused to follow links out of the store since F9 and every write
 * path since P14-RV-02; the LISTINGS were the odd one out (`subDirNames` used
 * dereferencing `statSync`), so a symlinked folder was a first-class,
 * browsable, injectable resource.
 */
describe("store listings never follow links out of the store (C5)", () => {
  it("a symlinked KB folder is not a knowledge base", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const outside = dbCtx.makeTempDir();
    writeFileSync(path.join(outside, "secret.md"), "MARKER-OUTSIDE");
    mkdirSync(path.join(ctx.dataRoot, "kb"), { recursive: true });
    symlinkSync(outside, path.join(ctx.dataRoot, "kb", "linked"));

    expect(listKnowledgeBases(db, ctx).map((kb) => kb.dir)).not.toContain("linked");
  });

  it("a symlinked SKILL folder is not a skill", () => {
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const outside = dbCtx.makeTempDir();
    writeFileSync(path.join(outside, "SKILL.md"), "MARKER-OUTSIDE");
    mkdirSync(path.join(ctx.dataRoot, "skills"), { recursive: true });
    symlinkSync(outside, path.join(ctx.dataRoot, "skills", "linked"));

    expect(listSkills(db, ctx).map((s) => s.name)).not.toContain("linked");
  });

  it("scanStoreTree lists neither symlinked files nor symlinked directories", () => {
    const root = dbCtx.makeTempDir();
    const outside = dbCtx.makeTempDir();
    writeFileSync(path.join(outside, "secret.md"), "MARKER-OUTSIDE");
    writeFileSync(path.join(root, "real.md"), "real");
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "linked.md"));
    symlinkSync(outside, path.join(root, "linkeddir"));

    const names = scanStoreTree(root).map((n) => n.name);
    expect(names).toEqual(["real.md"]);
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

  /**
   * Ruling 246 (pass 37, F37-75): EXISTENCE is judged before TYPE.
   *
   * The other order answers a path this store has never held with a complaint
   * about its file extension. Live, the controller asked for `make/stack.mk` —
   * a file in the git repository, which this reader has no view of — and was
   * told Viberr "only opens text documents". It retried as `.md` and was told
   * the file "no longer exists", which implies it once did. Two refusals, two
   * causes that were not the reason.
   */
  it("ruling 246: an ABSENT path reads as absent, whatever its extension", async () => {
    const { db, target } = await setupKb();
    writeStoreDoc(db, target, ["notes"], "a.md", "hello", ACTOR);
    // CANARY: put the extension check back in front and this throws "only opens
    // text documents" about a file that was never here.
    expect(readStoreDoc(target, ["make", "stack.mk"])).toBeNull();
    expect(readStoreDoc(target, ["nope.mk"])).toBeNull();
    // A file that IS here and cannot be round-tripped is still refused by TYPE:
    // the ordering change must not lose the editor's own guard.
    const abs = path.join(target.rootAbs, "script.sh");
    writeFileSync(abs, "echo hi");
    expect(() => readStoreDoc(target, ["script.sh"])).toThrowError(
      /only opens text documents/,
    );
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

  /**
   * Ruling 466 (F40-9): a store write reports and audits UTF-8 BYTES. It
   * recorded `body.length`, UTF-16 code units: live, an 8,220-byte document
   * was reported and audited as "8,170 bytes".
   */
  it("ruling 466: a non-ASCII body reports its UTF-8 length in the result and the audit row", async () => {
    const { db, ctx, kb, target } = await setupKb();
    const body = "# Kimlik\n\nAkın Özer — İstanbul’da çalışır. ✓\n";
    expect(body.length).not.toBe(Buffer.byteLength(body, "utf8"));
    const result = writeStoreDoc(db, target, [], "kimlik.md", body, ACTOR);
    const onDisk = readFileSync(path.join(kbDirPath(kb.dir, ctx.dataRoot), "kimlik.md")).length;
    // CANARY: report `body.length` again and both figures fall short of disk.
    expect(result.bytes).toBe(onDisk);
    expect(result.previousBytes).toBeNull();
    const row = listAuditEvents(db, { action: "org.store.doc_written" })[0];
    expect(row?.details).toMatchObject({ path: "kimlik.md", bytes: onDisk, replaced: false });

    // A replace names how many bytes it destroyed, measured on disk (ruling 257).
    const replaced = writeStoreDoc(db, target, [], "kimlik.md", "ş", ACTOR, { overwrite: true });
    expect(replaced).toMatchObject({ replaced: true, previousBytes: onDisk, bytes: 2 });
  });

  /**
   * Ruling 466 (F40-13): an append adds EXACTLY the text sent. The controller's
   * door trimmed each part and forced a blank line between parts, so a part
   * boundary inside a markdown table split the table in two.
   */
  it("ruling 466: two appends that split a table concatenate byte for byte", async () => {
    const { db, ctx, kb, target } = await setupKb();
    const first = "| Rule | Year |\n|---|---|\n| Kör ";
    const second = "nokta | 2026 |\n| Şeffaflık | 2025 |\n";
    const a = writeStoreDoc(db, target, [], "table.md", first, ACTOR, { append: true });
    expect(a).toMatchObject({ previousBytes: null, appendedBytes: Buffer.byteLength(first) });
    const b = writeStoreDoc(db, target, [], "table.md", second, ACTOR, { append: true });
    const abs = path.join(kbDirPath(kb.dir, ctx.dataRoot), "table.md");
    // CANARY: trim the part or insert a separator and the bytes differ.
    expect(readFileSync(abs).equals(Buffer.from(first + second, "utf8"))).toBe(true);
    expect(b).toMatchObject({
      replaced: false,
      previousBytes: Buffer.byteLength(first),
      appendedBytes: Buffer.byteLength(second),
      bytes: Buffer.byteLength(first + second),
    });
    expect(listAuditEvents(db, { action: "org.store.doc_written" })[0]?.details).toMatchObject({
      bytes: Buffer.byteLength(first + second),
      appended: Buffer.byteLength(second),
      replaced: false,
    });
  });

  it("ruling 466: the editor's read cap is in bytes, so `truncated` and the text agree", async () => {
    const { db, target } = await setupKb();
    // 10 two-byte characters = 20 bytes.
    writeStoreDoc(db, target, [], "cap.md", "ç".repeat(10), ACTOR);
    // CANARY: slice characters again and the whole text comes back while
    // `truncated` says it was cut.
    expect(readStoreDoc(target, ["cap.md"], 11)).toEqual({ text: "ç".repeat(5), truncated: true });
    expect(readStoreDoc(target, ["cap.md"], 20)).toEqual({ text: "ç".repeat(10), truncated: false });
  });

  it("ruling 183: a SKILL.md written through the document editor is judged like every other SKILL.md write", async () => {
    // Canary: skip the check in writeStoreDoc.
    const db = dbCtx.makeDb();
    const ctx = { dataRoot: dbCtx.makeTempDir() };
    const { skill } = await saveSkill(
      db,
      { name: "doc-edited", summary: "Doc probe.", body: "# kept" },
      ACTOR,
      ctx,
    );
    const target = resolveStoreTarget(db, "skill", skill.id, ctx)!;
    expect(() =>
      writeStoreDoc(db, target, [], "SKILL.md", "---\nname: [\n---\n# Body", ACTOR, {
        overwrite: true,
      }),
    ).toThrowError(/frontmatter/);
    expect(getSkill(db, skill.id, ctx)!.body).toBe("# kept");
    const ok = writeStoreDoc(db, target, [], "SKILL.md", "# Rewritten\n- fine", ACTOR, {
      overwrite: true,
    });
    expect(ok.replaced).toBe(true);
    expect(getSkill(db, skill.id, ctx)!.body).toBe("# Rewritten\n- fine");
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

describe("in-app writes obey the same dotfile rule as every other store write", () => {
  it("refuses a dot-prefixed document instead of writing an unreachable one", async () => {
    // The scanner skips anything starting with "." and `cleanSegment` calls
    // that rule "server-enforced" — but writeStoreDoc sanitized the NAME with
    // its own near-copy that only checked for "..". So ".secret.md" was really
    // written, reported as saved, and then invisible in the browser, never
    // injected into a run, and impossible to delete in-app.
    // Canary: drop the cleanSegment guard in writeStoreDoc and this resolves.
    const { db, target } = await setupKb();
    expect(() =>
      writeStoreDoc(db, target, [], ".secret.md", "hidden", ACTOR),
    ).toThrowError(/cannot start with a dot/);
    expect(scanStoreTree(target.rootAbs)).toEqual([]);
  });

  it("refuses a dot-prefixed folder for the same reason", async () => {
    const { db, target } = await setupKb();
    expect(() =>
      createStoreFolder(db, target, [], ".drafts", ACTOR),
    ).toThrowError(/cannot start with a dot/);
    // …including as a nested segment of a multi-part name.
    expect(() =>
      createStoreFolder(db, target, [], "docs/.drafts", ACTOR),
    ).toThrowError(/cannot start with a dot/);
    expect(scanStoreTree(target.rootAbs)).toEqual([]);
  });

  it("still accepts ordinary names, and a leading dot is not confused with an extension", async () => {
    const { db, target } = await setupKb();
    createStoreFolder(db, target, [], "docs", ACTOR);
    writeStoreDoc(db, target, ["docs"], "notes", "body", ACTOR);
    const tree = scanStoreTree(target.rootAbs);
    expect(tree).toEqual([
      {
        type: "dir",
        name: "docs",
        children: [
          expect.objectContaining({ type: "file", name: "notes.md" }),
        ],
      },
    ]);
  });
});
