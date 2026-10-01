import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { activeFileLeases, staleFileLeases } from "./file-leases.server";

/**
 * Ruling 245(b) (pass 37, F37-76): a lease whose HOLDER is finished holds
 * nothing.
 *
 * Ruling 245 shipped with `FileLease.taskKey` documented as "released when it
 * reaches a terminal stage" and nothing implementing it. The controller read
 * that contract, believed it, and wrote it into the first real lease's own
 * reason — "Lease releases when SHOP-11 merges". SHOP-11 merged and the lease
 * stood, owning `pnpm-lock.yaml` on behalf of work that had already landed.
 */
let ctx: TestDbContext;
let store: TestStore;

function leaseTo(taskKey: string, paths: string[]): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    fileLeases: [{ paths, taskKey, reason: "merges first" }],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function seedHolder(patch: Parameters<typeof baseTaskFrontmatter>[1]): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-7", { ownerUserId: store.users.arda.id, ...patch }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

describe("activeFileLeases", () => {
  it("binds while the holder is still working", () => {
    seedHolder({ stage: "review" });
    leaseTo("VIB-7", ["pnpm-lock.yaml"]);
    expect(activeFileLeases(store.slug, { dataRoot: store.dataRoot })).toHaveLength(1);
    expect(staleFileLeases(null, store.slug, { dataRoot: store.dataRoot })).toEqual([]);
  });

  it("stops binding the moment the holder reaches the terminal stage", () => {
    seedHolder({ stage: "review" });
    leaseTo("VIB-7", ["pnpm-lock.yaml"]);
    // The live shape: SHOP-11 merged, and the lease it held went on refusing
    // SHOP-5's delivery in the name of work that had already landed.
    // CANARY: read `fm.fileLeases` directly instead of resolving and this
    // stays 1 — a completed task fencing off a file forever.
    seedHolder({ stage: "done" });
    expect(activeFileLeases(store.slug, { dataRoot: store.dataRoot })).toEqual([]);
    // Named, not silently dropped, so a surface can offer to clear the row.
    expect(staleFileLeases(null, store.slug, { dataRoot: store.dataRoot })).toHaveLength(1);
  });

  it("stops binding when the holder is ARCHIVED, not only when it is Done", () => {
    seedHolder({ stage: "review" });
    leaseTo("VIB-7", ["pnpm-lock.yaml"]);
    seedHolder({ stage: "review", archived: true });
    // CANARY: check the terminal stage alone and an archived holder keeps its
    // lease, which is the same dead-record shape one step over.
    expect(activeFileLeases(store.slug, { dataRoot: store.dataRoot })).toEqual([]);
  });

  it("stops binding when the holder does not exist at all", () => {
    leaseTo("VIB-404", ["pnpm-lock.yaml"]);
    // A holder nobody can open can neither deliver the file nor release the
    // lease. CANARY: treat a missing task as "still working" and the path is
    // fenced off forever in the name of a task that is not there.
    expect(activeFileLeases(store.slug, { dataRoot: store.dataRoot })).toEqual([]);
  });

  it("is empty and cheap when the project declares none", () => {
    expect(activeFileLeases(store.slug, { dataRoot: store.dataRoot })).toEqual([]);
    expect(activeFileLeases("no-such-project", { dataRoot: store.dataRoot })).toEqual([]);
  });
});
