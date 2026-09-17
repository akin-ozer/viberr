import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { baseTaskFrontmatter, setupTestStore, writeTask } from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  SIMILAR_TITLE_THRESHOLD,
  similarOpenTasks,
  titleOverlap,
  titleTokens,
} from "./similar-tasks.server";

/**
 * Ruling 324 — the two real near-misses, and the board they were measured on.
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
/** The three genuinely-adjacent tasks a looser threshold would flag. */
const ADMIN = [
  "Admin product management",
  "Admin inventory management",
  "Admin order management",
];

describe("titleOverlap", () => {
  it("clears the threshold on the near-miss that actually happened", () => {
    // SHOP-27's packet, live: "Gateway routes for orders, cart and inventory"
    // against SHOP-29, already written and sitting at Triage. Four significant
    // words shared of six — 0.67.
    expect(titleOverlap(PROPOSED, SHOP_29)).toBeGreaterThan(SIMILAR_TITLE_THRESHOLD);
    // SHOP-26's packet was the same title word for word.
    expect(titleOverlap(SHOP_29, SHOP_29)).toBe(1);
  });

  it("stays under it on the adjacent tasks a looser bar would flag", () => {
    // CANARY: drop SIMILAR_TITLE_THRESHOLD to 0.5. These three are real,
    // distinct, live tasks; flagging them teaches a person to skip the notice,
    // which is worse than not having one.
    for (const [a, b] of [
      [ADMIN[0]!, ADMIN[1]!],
      [ADMIN[0]!, ADMIN[2]!],
      [ADMIN[1]!, ADMIN[2]!],
    ]) {
      expect(titleOverlap(a, b), `${a} ~ ${b}`).toBeLessThan(SIMILAR_TITLE_THRESHOLD);
    }
  });

  it("ignores word order, punctuation, case and the small words", () => {
    expect(
      titleOverlap("Cart availability against inventory", "INVENTORY! availability; against — cart"),
    ).toBe(1);
    expect(titleTokens("Gateway routes for orders, cart and inventory")).toEqual(
      new Set(["gateway", "routes", "orders", "cart", "inventory"]),
    );
    // A title with nothing significant in it matches nothing, rather than
    // everything — an empty set against an empty set is not a duplicate.
    expect(titleOverlap("it is the", "a to of")).toBe(0);
  });
});

describe("similarOpenTasks", () => {
  function board(titles: Record<string, string>, archived: string[] = []) {
    const store = setupTestStore(ctx);
    for (const [key, title] of Object.entries(titles)) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          title,
          stage: "triage",
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

  it("says nothing about the 3,403 pairs of a real board that are not duplicates", () => {
    // The whole value of this disclosure is that it is quiet. Measured across
    // the shopify-clone board's 83 titles, this threshold flags none of them.
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
      },
      ["VIB-3"],
    );
    // A task cannot be a duplicate of itself, and the caller passes its own key.
    const found = similarOpenTasks(store.db, store.slug, PROPOSED, ["VIB-1"]);
    expect(found.map((t) => t.key)).toEqual(["VIB-2"]);
    // CANARY: drop the `archived = 0` filter and VIB-3 comes back — an archived
    // task is off every board and owns nothing, so naming it is noise.
    expect(found.map((t) => t.key)).not.toContain("VIB-3");
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
