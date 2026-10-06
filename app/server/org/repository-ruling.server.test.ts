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
import { deleteKnowledgeBase, saveKnowledgeBase } from "./resources.server";
import { setProjectRulingsKb } from "~/features/project-settings/settings-actions.server";

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

/** The store's project is `viberr-core`, and the document is named for it. */
const DOC = "no-repository-viberr-core.md";

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
    expect(ruling).toEqual({ kb: "core-rulings", doc: DOC, createdKb: false });
    const text = readFileSync(path.join(kbDirPath("core-rulings", store.dataRoot), DOC), "utf8");
    expect(text).toContain("# Viberr Core connects no repository");
    expect(text).toContain("Decided by Arda Test on 2026-10-06, answering the operator's question on VIB-7.");
    expect(text).toContain("Do not ask a person to connect a repository.");
    expect(noRepositoryRuling(store.slug, { dataRoot: store.dataRoot })).toEqual({
      kb: "core-rulings",
      doc: DOC,
    });
    const index = readKbIndexes(["core-rulings"], store.dataRoot, { rulingsKb: "core-rulings" });
    expect(index.parts[0]?.body).toContain("Viberr Core connects no repository");
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_recorded" })[0]).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-7",
      details: { kb: "core-rulings", doc: DOC, createdKb: false },
    });
  });

  it("gives a project that names no rulings knowledge base one, under a name no folder holds", async () => {
    // CANARY: refuse (or write nowhere) when the project names none and the
    // decision is lost on exactly the boards the dialog makes; take a folder
    // that exists and another board's rulings become this one's.
    const store = repoLess(null);
    mkdirSync(kbDirPath(`${store.slug}-rulings`, store.dataRoot), { recursive: true });
    const ruling = await record(store);
    expect(ruling).toEqual({ kb: `${store.slug}-rulings-2`, doc: DOC, createdKb: true });
    expect(projectOf(store).rulingsKb).toBe(`${store.slug}-rulings-2`);
    expect(existsSync(path.join(kbDirPath(ruling.kb, store.dataRoot), DOC))).toBe(true);
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
    expect(removed).toEqual({ kb: ruling.kb, doc: DOC });
    expect(noRepositoryRuling(store.slug, { dataRoot: store.dataRoot })).toBeNull();
    expect(existsSync(kbDirPath(ruling.kb, store.dataRoot))).toBe(true);
    expect(projectOf(store).rulingsKb).toBe(ruling.kb);
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_removed" })[0]?.details).toEqual({
      kb: ruling.kb,
      doc: DOC,
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

  it("is one project's: a second project that names the same rulings knowledge base is not answered by it", async () => {
    // CANARY: name the document for no project and a board imported beside
    // its source, sharing its rulings, is silenced by a decision made on the
    // other board; removing one board's would take the other's.
    const store = repoLess(null);
    await saveKnowledgeBase(store.db, { name: "shared-rulings", refresh: "on change" }, actorOf(store.users.arda), {
      dataRoot: store.dataRoot,
    });
    const first = { ...projectOf(store), rulingsKb: "shared-rulings" };
    writeProject(store.dataRoot, first);
    const second = { ...first, slug: "other-board", name: "Other Board", taskPrefix: "OTH" };
    writeProject(store.dataRoot, second);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const at = { dataRoot: store.dataRoot };

    await record(store);
    expect(repositoryAskState(first, at)).toBe("declined");
    expect(repositoryAskState(second, at)).toBe("open");
    expect(noRepositoryRuling("other-board", at)).toBeNull();

    await recordNoRepositoryRuling(
      store.db,
      { projectSlug: "other-board", byName: "Arda Test", taskKey: "OTH-1", at: "2026-10-06T19:00:00.000Z" },
      actorOf(store.users.arda),
      at,
    );
    expect(noRepositoryRuling("other-board", at)).toEqual({ kb: "shared-rulings", doc: "no-repository-other-board.md" });
    removeNoRepositoryRuling(store.db, { projectSlug: store.slug, repo: "acme/site" }, actorOf(store.users.arda), at);
    expect(repositoryAskState(first, at)).toBe("open");
    expect(repositoryAskState(second, at)).toBe("declined");
  });

  it("goes with the project when it names another rulings knowledge base, and stays found when the knowledge base is renamed", async () => {
    // CANARY: leave the document behind on a change, or leave `rulingsKb`
    // pointing at the old folder on a rename, and a board whose admin only
    // tidied its rulings is asked the question a person already answered
    // (and, on the rename, reads no rulings at all).
    const store = repoLess(null);
    const at = { dataRoot: store.dataRoot };
    const first = await record(store);
    const next = await saveKnowledgeBase(store.db, { name: "house-rules", refresh: "on change" }, actorOf(store.users.arda), at);

    await setProjectRulingsKb(store.db, { projectSlug: store.slug, dir: "house-rules" }, actorOf(store.users.arda), at);
    expect(noRepositoryRuling(store.slug, at)).toEqual({ kb: "house-rules", doc: DOC });
    expect(existsSync(path.join(kbDirPath(first.kb, store.dataRoot), DOC))).toBe(false);
    expect(readFileSync(path.join(kbDirPath("house-rules", store.dataRoot), DOC), "utf8")).toContain(
      "Decided by Arda Test on 2026-10-06",
    );

    await saveKnowledgeBase(store.db, { id: next.kb.id, name: "Core house rules", refresh: "on change" }, actorOf(store.users.arda), at);
    expect(projectOf(store).rulingsKb).toBe("core-house-rules");
    expect(noRepositoryRuling(store.slug, at)).toEqual({ kb: "core-house-rules", doc: DOC });
    expect(repositoryAskState(projectOf(store), at)).toBe("declined");

    // Clearing the rulings knowledge base lifts every ruling, this one too,
    // and leaves no copy to come back. CANARY: keep the document in the old
    // folder and a board that connects a repository next, then names that
    // knowledge base again, tells every run it connects none.
    await setProjectRulingsKb(store.db, { projectSlug: store.slug, dir: null }, actorOf(store.users.arda), at);
    expect(repositoryAskState(projectOf(store), at)).toBe("open");
    expect(existsSync(path.join(kbDirPath("core-house-rules", store.dataRoot), DOC))).toBe(false);
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_removed" })[0]?.details).toEqual({
      kb: "core-house-rules",
      doc: DOC,
      repo: null,
    });
    await setProjectRulingsKb(store.db, { projectSlug: store.slug, dir: "core-house-rules" }, actorOf(store.users.arda), at);
    expect(repositoryAskState(projectOf(store), at)).toBe("open");
  });

  it("stays named when its knowledge base is deleted: the project is not quietly left with no rulings setting", async () => {
    // CANARY: clear `rulingsKb` on a delete and the project's settings stop
    // saying its rulings knowledge base is missing, with no record that
    // anything changed. (A rename, above, is followed; a delete is not.)
    const store = repoLess(null);
    const at = { dataRoot: store.dataRoot };
    const kb = await saveKnowledgeBase(store.db, { name: "house-rules", refresh: "on change" }, actorOf(store.users.arda), at);
    writeProject(store.dataRoot, { ...projectOf(store), rulingsKb: "house-rules" });
    await record(store);
    await deleteKnowledgeBase(store.db, kb.kb.id, actorOf(store.users.arda), at);
    expect(projectOf(store).rulingsKb).toBe("house-rules");
    // The decision went with the folder, so the question may be asked again.
    expect(repositoryAskState(projectOf(store), at)).toBe("open");
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
