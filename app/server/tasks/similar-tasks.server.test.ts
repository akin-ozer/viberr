import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { baseTaskFrontmatter, setupTestStore, writeTask } from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { similarOpenTasks } from "./similar-tasks.server";

/**
 * Ruling 67 — the two real near-misses, and the board they were measured on.
 *
 * The controller named these unprompted when asked what a reader of the final
 * state would not learn from it: a `create_task` option one confirmation from
 * standing up a second owner for work a live task already held. Both were
 * caught by a person recognising the work. A task that was never created leaves
 * no trace, so the rate is invisible in the record.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** The real titles, from the real board. */
const SHOP_29 = "Gateway routes for inventory, cart and checkout";
const PROPOSED = "Gateway routes for orders, cart and inventory";

describe("similarOpenTasks", () => {
  function board(titles: Record<string, string>, archived: string[] = [], done: string[] = []) {
    const store = setupTestStore(ctx);
    for (const [key, title] of Object.entries(titles)) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          title,
          stage: done.includes(key) ? "done" : "triage",
          archived: archived.includes(key),
        }),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return store;
  }

  it("finds the live task the confirm would have duplicated", () => {
    const store = board({
      "VIB-1": "Orders service and the checkout saga",
      "VIB-29": SHOP_29,
      "VIB-40": "Payments webhook ingestion",
    });
    const found = similarOpenTasks(store.db, store.slug, PROPOSED, ["VIB-1"]);
    expect(found.map((t) => t.key)).toEqual(["VIB-29"]);
    expect(found[0]!.title).toBe(SHOP_29);
    expect(found[0]!.stageId).toBe("triage");
  });

  it("says nothing for distinct live titles at the measured 0.6 threshold", () => {
    // The whole value of this disclosure is that it is quiet. Measured across
    // the shopify-clone board's 83 titles, this threshold flags none of them.
    // CANARY: drop SIMILAR_TITLE_THRESHOLD to 0.5 and "Admin order management"
    // flags its two Admin neighbours: real, distinct, live tasks, and flagging
    // them teaches a person to skip the notice.
    const store = board({
      "VIB-1": "Orders service and the checkout saga",
      "VIB-2": "Cart availability against inventory",
      "VIB-3": "Admin product management",
      "VIB-4": "Admin inventory management",
      "VIB-5": "Documentation and runbook",
      "VIB-6": "Release candidate (source release, no images)",
    });
    for (const title of Object.values({
      a: "Admin order management",
      b: "Contracts amendment: publish the webhook shapes",
      c: "Gateway rate limiting",
    })) {
      expect(similarOpenTasks(store.db, store.slug, title), title).toEqual([]);
    }
  });

  it("excludes the deciding task and every archived one, but keeps Done", () => {
    const store = board(
      {
        "VIB-1": PROPOSED,
        "VIB-2": SHOP_29,
        "VIB-3": SHOP_29,
        "VIB-4": SHOP_29,
      },
      ["VIB-3"],
      ["VIB-4"],
    );
    // A task cannot be a duplicate of itself, and the caller passes its own key.
    const found = similarOpenTasks(store.db, store.slug, PROPOSED, ["VIB-1"]);
    // A Done task stays, with its stage: "this was already built, and here it
    // is" is what the person confirming needs. CANARY: leave Done tasks out of
    // the query and VIB-4 is gone.
    expect(found.map((t) => [t.key, t.stageId])).toEqual([
      ["VIB-2", "triage"],
      ["VIB-4", "done"],
    ]);
    // CANARY: drop the `archived = 0` filter and VIB-3 comes back — an archived
    // task is off every board and owns nothing, so naming it is noise.
    expect(found.map((t) => t.key)).not.toContain("VIB-3");
  });

  it("ignores word order, punctuation, case and the small words; a title of only small words matches nothing", () => {
    const store = board({ "VIB-2": "Cart availability against inventory", "VIB-9": "To do" });
    const found = (title: string) =>
      similarOpenTasks(store.db, store.slug, title).map((t) => t.key);
    // Order, punctuation and case: every significant word is shared.
    expect(found("INVENTORY! Availability; AGAINST — cart")).toEqual(["VIB-2"]);
    // The small words carry no identity: counted, they would dilute this to 0.5.
    expect(found("Cart availability, and the inventory that this is against")).toEqual([
      "VIB-2",
    ]);
    // Nothing significant on either side is not a match: "To do" has no
    // significant word either, and an empty set against an empty set is not a
    // duplicate.
    expect(found("it is the")).toEqual([]);
  });

  it("shows the closest few, not a search result", () => {
    const store = board(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`VIB-${i + 1}`, `${SHOP_29} ${i}`]),
      ),
    );
    expect(similarOpenTasks(store.db, store.slug, SHOP_29)).toHaveLength(3);
  });
});
