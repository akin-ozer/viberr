import type { TestDbContext } from "./test-db";
import { setupTestStore, writeProject, type TestStore } from "./test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";

/**
 * `setupTestStore(ctx)` (`viberr-core`, repo akin-ozer/viberr on `main`) with
 * its SQLite projection built, for tests that read the projection before their
 * first write. It lives apart from `test-store.ts` so a test that never
 * projects does not load the rebuilder. It loads `test-store.ts` first, in the
 * order its adopters imported the two before they switched to it.
 */
export function setupProjectedStore(ctx: TestDbContext): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

/**
 * Rewrites the store's project.md with `patch` over the frontmatter it
 * holds (its description kept), then re-projects, the way a board saved in
 * its settings reaches every reader. `patch` may read the current
 * frontmatter, for a change that keeps what is there (`[...fm.agents, x]`).
 */
export function reconfigureProject(
  store: Pick<TestStore, "db" | "dataRoot" | "slug">,
  patch: Partial<ProjectFrontmatter> | ((current: ProjectFrontmatter) => Partial<ProjectFrontmatter>),
): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const current = file.parsed.frontmatter;
  writeProject(
    store.dataRoot,
    { ...current, ...(patch instanceof Function ? patch(current) : patch) },
    file.parsed.description,
  );
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}
