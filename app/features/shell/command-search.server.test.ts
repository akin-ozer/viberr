import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { searchWorkspace } from "./command-search.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * R15-5 — the ⌘K palette's query. The scoping assertions matter most: the
 * palette must never surface a task, branch or agent from a project the viewer
 * cannot open (R15-4 / WI-13).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seed(): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-142", {
      title: "Attach a project credential",
      stage: "review",
      branch: "vib-142-attach-credential",
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-9", {
      title: "Rotate the PAT",
      branch: "vib-9-rotate-pat",
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

const asMember = (store: TestStore) => ({
  id: store.users.selin.id,
  role: "member" as const,
});
const asNonMember = (store: TestStore) => ({
  id: store.users.deniz.id,
  role: "member" as const,
});

describe("searchWorkspace", () => {
  it("returns nothing for an empty query", () => {
    const store = seed();
    expect(
      searchWorkspace(store.db, asMember(store), "   ", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
  });

  it("finds a task by key and by title, pointing at the task page", () => {
    const store = seed();
    const byKey = searchWorkspace(store.db, asMember(store), "VIB-142", {
      dataRoot: store.dataRoot,
    });
    expect(byKey.some((h) => h.href.endsWith("/tasks/VIB-142"))).toBe(true);
    const byTitle = searchWorkspace(store.db, asMember(store), "credential", {
      dataRoot: store.dataRoot,
    });
    expect(byTitle.find((h) => h.kind === "task")?.href).toContain("VIB-142");
  });

  it("files a branch-only match under branches, not tasks", () => {
    const store = seed();
    const hits = searchWorkspace(store.db, asMember(store), "rotate-pat", {
      dataRoot: store.dataRoot,
    });
    const hit = hits.find((h) => h.label === "vib-9-rotate-pat");
    expect(hit?.kind).toBe("branch");
    // A branch is still a jump to its task.
    expect(hit?.href).toContain("/tasks/VIB-9");
  });

  it("finds the project itself", () => {
    const store = seed();
    const hits = searchWorkspace(store.db, asMember(store), "viberr", {
      dataRoot: store.dataRoot,
    });
    expect(hits.some((h) => h.kind === "project")).toBe(true);
  });

  it("shows a NON-MEMBER nothing at all (R15-4 scoping)", () => {
    const store = seed();
    // deniz is a registered user with no membership anywhere. Before the
    // palette existed the topbar promised a global search; a global search that
    // ignored membership would leak task keys, titles and branch names.
    expect(
      searchWorkspace(store.db, asNonMember(store), "VIB-142", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
    expect(
      searchWorkspace(store.db, asNonMember(store), "viberr", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
  });

  it("an ORG ADMIN who is not a member still reaches every project", () => {
    const store = seed();
    const hits = searchWorkspace(
      store.db,
      { id: store.users.deniz.id, role: "admin" },
      "VIB-142",
      { dataRoot: store.dataRoot },
    );
    expect(hits.some((h) => h.href.endsWith("/tasks/VIB-142"))).toBe(true);
  });

  it("treats % and _ as literals, not LIKE wildcards", () => {
    const store = seed();
    expect(
      searchWorkspace(store.db, asMember(store), "%", {
        dataRoot: store.dataRoot,
      }).filter((h) => h.kind === "task"),
    ).toEqual([]);
  });
});
