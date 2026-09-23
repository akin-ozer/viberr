import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { TestDbContext } from "./test-db";
import { setupTestStore, type TestStore } from "./test-store";

/**
 * `setupTestStore(ctx)` (`viberr-core`, repo akin-ozer/viberr on `main`) with
 * its SQLite projection built, for tests that read the projection before their
 * first write. It lives apart from `test-store.ts` so a test that never
 * projects does not load the rebuilder.
 */
export function setupProjectedStore(ctx: TestDbContext): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}
