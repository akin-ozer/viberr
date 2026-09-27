import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  flagScopeViolation,
  policyViolationText,
  resolveScopeViolationWithEvent,
  scopeFlagText,
} from "./scope-flag.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { credentialAdvisories } from "~/server/secrets/pat-store.server";
import { scopeIsAdvisory } from "~/shared/credential-scopes";

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

/**
 * F39-5 (pass 39): a scope the project does not require is an ADVISORY, and the
 * permanent record says so.
 *
 * Live, one minute apart, viberr said both of these about one fact: the task
 * record carried "**Policy violation:** active PAT is missing `checks:read`"
 * under the red shield `event-meta.ts` gives the `policy` type, and the
 * credential card said "All required scopes proven." Ruling 360 had already
 * settled which one was right — `credentialAdvisories` says "Not a missing
 * REQUIRED scope — merging never needed it" — but only the card had learned it.
 */
describe("F39-5: advisory scopes are not violations", () => {
  const seed = () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        ownerUserId: store.users.selin.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return store;
  };
  const topEvent = (store: ReturnType<typeof setupTestStore>) =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline[0]!;

  it("checks:read writes a neutral note that never says violation", async () => {
    const store = seed();
    await flagScopeViolation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        scope: "checks:read",
        detail: scopeFlagText("checks:read", "CI status is not shown."),
      },
      { dataRoot: store.dataRoot },
    );
    const event = topEvent(store);
    // CANARY: write `type: "policy"` unconditionally in appendPolicyEvent and
    // this goes red — the row goes back to the "Policy violation" shield.
    expect(event.type).toBe("note");
    expect(event.text).toContain("Credential advisory");
    expect(event.text).toContain("this project does not require");
    expect(event.text).not.toContain("Policy violation");
    expect(event.text).toContain("CI status is not shown.");
  });

  it("a REQUIRED scope still writes the violation, under the shield", async () => {
    const store = seed();
    await flagScopeViolation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        scope: "repo",
        detail: scopeFlagText("repo", "PR auto-sync is blocked."),
      },
      { dataRoot: store.dataRoot },
    );
    const event = topEvent(store);
    expect(event.type).toBe("policy");
    expect(event.text).toContain("Policy violation");
    expect(event.text).not.toContain("advisory");
  });

  it("the clearing note matches the flag that opened it", async () => {
    const store = seed();
    /** Flag `scope`, resolve it, and return the note the resolution wrote. */
    const clear = async (scope: string) => {
      const { violation } = await flagScopeViolation(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", scope, detail: scopeFlagText(scope, "x") },
        { dataRoot: store.dataRoot },
      );
      await resolveScopeViolationWithEvent(store.db, violation.id, undefined, {
        dataRoot: store.dataRoot,
      });
      return topEvent(store).text;
    };
    // CANARY: word `policyUpdateText` the same for both kinds and the advisory
    // resolves as a "violation" it never was.
    const advisory = await clear("checks:read");
    expect(advisory).toContain("Credential update");
    expect(advisory).toContain("advisory is resolved");
    const required = await clear("repo");
    expect(required).toContain("Policy update");
    expect(required).toContain("violation is resolved");
  });

  it("the timeline writer and the credential card read the SAME advisory list", () => {
    expect(scopeIsAdvisory("checks:read")).toBe(true);
    expect(scopeIsAdvisory("repo")).toBe(false);
    expect(scopeIsAdvisory("workflow")).toBe(false);
    // The card's advisory still fires for the same scope, so the two surfaces
    // agree about which kind of thing happened.
    const advisories = credentialAdvisories(null, [
      { scope: "checks:read", taskKey: "VIB-1" },
    ]);
    expect(advisories.map((a) => a.id)).toEqual(["checks_read"]);
  });
});
