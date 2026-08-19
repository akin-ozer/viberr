import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** All `policy` notification recipient ids, sorted. */
function policyRecipients(db: ReturnType<typeof setupTestStore>["db"]): string[] {
  // SAFETY: the SELECT list is the single `notifications.user_id` column, TEXT
  // NOT NULL in 0001_baseline — every row sqlite returns carries a string.
  return (
    db
      .prepare(`SELECT user_id FROM notifications WHERE kind = 'policy'`)
      .all() as { user_id: string }[]
  )
    .map((r) => r.user_id)
    .sort();
}

describe("flagScopeViolation notification fan-out (E3)", () => {
  it("notifies the task's watchers: owner + project admins/maintainers, deduped", async () => {
    const store = setupTestStore(ctx);
    // Owner selin is a contributor — under the old owner-only path she was
    // the ONLY recipient; watchers add admin arda + maintainer murat.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        ownerUserId: store.users.selin.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const { created } = await flagScopeViolation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        scope: "repo",
        detail: policyViolationText("repo", "PR auto-sync is blocked."),
      },
      { dataRoot: store.dataRoot },
    );
    expect(created).toBe(true);
    expect(policyRecipients(store.db)).toEqual(
      [store.users.arda.id, store.users.murat.id, store.users.selin.id].sort(),
    );

    // The typed policy event landed on the task file too.
    const events = store.db
      .prepare(
        `SELECT type FROM task_events WHERE task_key = 'VIB-1' AND type = 'policy'`,
      )
      .all();
    expect(events.length).toBeGreaterThan(0);
  });

  it("an OWNERLESS task still alerts admins/maintainers (was: nobody)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { ownerUserId: null }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const { created } = await flagScopeViolation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-2",
        scope: "workflow",
        detail: policyViolationText("workflow", "Actions sync is blocked."),
      },
      { dataRoot: store.dataRoot },
    );
    expect(created).toBe(true);
    expect(policyRecipients(store.db)).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
  });

  it("re-flagging an open violation is a no-op — no duplicate notifications", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { ownerUserId: null }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const input = {
      projectSlug: store.slug,
      taskKey: "VIB-3",
      scope: "repo",
      detail: policyViolationText("repo", "PR auto-sync is blocked."),
    };
    await flagScopeViolation(store.db, input, { dataRoot: store.dataRoot });
    const countAfterFirst = policyRecipients(store.db).length;
    const again = await flagScopeViolation(store.db, input, {
      dataRoot: store.dataRoot,
    });
    expect(again.created).toBe(false);
    expect(policyRecipients(store.db)).toHaveLength(countAfterFirst);
  });
});
