import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskKeyLinks } from "./task-key-links.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/**
 * U39-29: the tasks a controller transcript names become links, but only the
 * ones this viewer can open. `viberr-core` (VIB) has every fixture user but
 * deniz; `secret` (SEC) has arda alone.
 */
function twoProjects() {
  const store = setupTestStore(ctx);
  const core = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...core,
    name: "Secret",
    slug: "secret",
    taskPrefix: "SEC",
    members: [{ userId: store.users.arda.id, role: "admin" }],
  });
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-100") });
  writeTask(store.dataRoot, "secret", { frontmatter: baseTaskFrontmatter("SEC-1") });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  return store;
}

const said = ["I created VIB-100 and SEC-1.", "VIB-999 does not exist; ax-29 is a branch, not a key."];

describe("taskKeyLinks (U39-29, U39-31)", () => {
  it("a project page links its own project's tasks and nothing else", () => {
    // CANARY: drop the `visible` filter and SEC-1 links on the VIB board.
    const store = twoProjects();
    expect(taskKeyLinks(store.db, said, { projectSlug: store.slug, viewerId: store.users.murat.id })).toEqual({
      "VIB-100": "/projects/viberr-core/tasks/VIB-100",
    });
  });

  it("the instance page links the viewer's own projects, and every project for an org admin", () => {
    const store = twoProjects();
    expect(taskKeyLinks(store.db, said, { projectSlug: null, viewerId: store.users.selin.id })).toEqual({
      "VIB-100": "/projects/viberr-core/tasks/VIB-100",
    });
    // deniz belongs to neither project.
    expect(taskKeyLinks(store.db, said, { projectSlug: null, viewerId: store.users.deniz.id })).toEqual({});
    expect(taskKeyLinks(store.db, said, { projectSlug: null, viewerId: store.users.arda.id })).toEqual({
      "VIB-100": "/projects/viberr-core/tasks/VIB-100",
      "SEC-1": "/projects/secret/tasks/SEC-1",
    });
  });

  it("names nothing when the transcript names no task", () => {
    const store = twoProjects();
    expect(taskKeyLinks(store.db, ["No keys here."], { projectSlug: store.slug, viewerId: store.users.arda.id })).toEqual({});
  });

  it("U39-31: never links the page's own task", () => {
    // CANARY: drop the `exclude` skip.
    const store = twoProjects();
    expect(
      taskKeyLinks(store.db, said, { projectSlug: store.slug, viewerId: store.users.murat.id, exclude: "VIB-100" }),
    ).toEqual({});
  });
});
