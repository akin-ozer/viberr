import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  setupTestStore,
  writeProject,
  type TestStore,
} from "../../../test-support/test-store";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { readKbIndexes } from "~/server/files/kb-injection.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  noRepositoryRuling,
  recordNoRepositoryRuling,
  removeNoRepositoryRuling,
  repositoryAskState,
} from "./repository-ruling.server";
import { saveKnowledgeBase } from "./resources.server";

/**
 * Ruling 672: a person's decision that a board connects no repository is one
 * document in the project's rulings knowledge base. "If they refuse that's
 * stored as a ruling on project kb never asked again" (owner, 2026-10-06).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** A project with no repository, and the rulings knowledge base it names. */
function repoLess(rulingsKb: string | null): TestStore {
  const store = setupTestStore(ctx);
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, { ...file.parsed.frontmatter, repo: null, rulingsKb });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  return store;
}

const projectOf = (store: TestStore) =>
  readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;

const record = (store: TestStore) =>
  recordNoRepositoryRuling(
    store.db,
    { projectSlug: store.slug, byName: "Arda Test", taskKey: "VIB-7", at: "2026-10-06T18:00:00.000Z" },
    actorOf(store.users.arda),
    { dataRoot: store.dataRoot },
  );

describe("the ruling that a board connects no repository (ruling 672)", () => {
  it("is written into the rulings knowledge base the project names, under a heading every run's index shows", async () => {
    // CANARY: write it anywhere but the project's rulings knowledge base and
    // no run reads it; drop the heading and the index names a file and says
    // nothing about what was decided.
    const store = repoLess(null);
    await saveKnowledgeBase(store.db, { name: "core-rulings", refresh: "on change" }, actorOf(store.users.arda), {
      dataRoot: store.dataRoot,
    });
    writeProject(store.dataRoot, { ...projectOf(store), rulingsKb: "core-rulings" });
    expect(noRepositoryRuling(store.slug, { dataRoot: store.dataRoot })).toBeNull();

    const ruling = await record(store);
    expect(ruling).toEqual({ kb: "core-rulings", doc: "no-repository.md", createdKb: false });
    const text = readFileSync(path.join(kbDirPath("core-rulings", store.dataRoot), "no-repository.md"), "utf8");
    expect(text).toContain("# This board connects no repository");
    expect(text).toContain("Decided by Arda Test on 2026-10-06, answering the operator's question on VIB-7.");
    expect(text).toContain("Do not ask a person to connect a repository.");
    expect(noRepositoryRuling(store.slug, { dataRoot: store.dataRoot })).toEqual({
      kb: "core-rulings",
      doc: "no-repository.md",
    });
    const index = readKbIndexes(["core-rulings"], store.dataRoot, { rulingsKb: "core-rulings" });
    expect(index.parts[0]?.body).toContain("This board connects no repository");
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_recorded" })[0]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-7",
      details: { kb: "core-rulings", doc: "no-repository.md", createdKb: false },
    });
  });

  it("gives a project that names no rulings knowledge base one, under a name no folder holds", async () => {
    // CANARY: refuse (or write nowhere) when the project names none and the
    // decision is lost on exactly the boards the dialog makes; take a folder
    // that exists and another board's rulings become this one's.
    const store = repoLess(null);
    mkdirSync(kbDirPath(`${store.slug}-rulings`, store.dataRoot), { recursive: true });
    const ruling = await record(store);
    expect(ruling).toEqual({ kb: `${store.slug}-rulings-2`, doc: "no-repository.md", createdKb: true });
    expect(projectOf(store).rulingsKb).toBe(`${store.slug}-rulings-2`);
    expect(existsSync(path.join(kbDirPath(ruling.kb, store.dataRoot), "no-repository.md"))).toBe(true);
    expect(listAuditEvents(store.db, { action: "project.rulings_kb.updated" })[0]?.details).toEqual({
      dir: `${store.slug}-rulings-2`,
    });
  });

  it("is removed when a repository is connected, and the knowledge base stays", async () => {
    // CANARY: leave the document and every run on a board with a repository
    // is still told it has none; delete the knowledge base with it and the
    // project's other rulings go too.
    const store = repoLess(null);
    const ruling = await record(store);
    const removed = removeNoRepositoryRuling(
      store.db,
      { projectSlug: store.slug, repo: "acme/site" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(removed).toEqual({ kb: ruling.kb, doc: "no-repository.md" });
    expect(noRepositoryRuling(store.slug, { dataRoot: store.dataRoot })).toBeNull();
    expect(existsSync(kbDirPath(ruling.kb, store.dataRoot))).toBe(true);
    expect(projectOf(store).rulingsKb).toBe(ruling.kb);
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_removed" })[0]?.details).toEqual({
      kb: ruling.kb,
      doc: "no-repository.md",
      repo: "acme/site",
    });
    // None standing: nothing to remove, and nothing audited twice.
    expect(
      removeNoRepositoryRuling(store.db, { projectSlug: store.slug, repo: "acme/site" }, actorOf(store.users.arda), {
        dataRoot: store.dataRoot,
      }),
    ).toBeNull();
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_removed" })).toHaveLength(1);
  });

  it("says whether the question may be asked: open with no repository, declined once the ruling stands, and not at all with one", async () => {
    // CANARY: read `declined` as `open` and the operator is offered the
    // question a person already answered; read a project with a repository as
    // `open` and it is asked to connect what it has.
    const store = repoLess(null);
    const at = { dataRoot: store.dataRoot };
    expect(repositoryAskState(projectOf(store), at)).toBe("open");
    await record(store);
    expect(repositoryAskState(projectOf(store), at)).toBe("declined");
    expect(repositoryAskState({ ...projectOf(store), repo: "acme/site" }, at)).toBeNull();
  });
});
