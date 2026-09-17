import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Ruling 324 — the `create_task` confirm says what already looks like it.
 *
 * Ruling 269's option creates a real task on a person's confirm, and the card
 * discloses what it WILL create. It says nothing about what already exists,
 * and the operator authoring it is reasoning about a board it cannot see all
 * of.
 *
 * The controller named three near-misses from this board, unprompted, when
 * asked what a reader of the final state would not learn from it: *"the
 * near-misses were about as frequent as the catches, and they leave no trace…
 * SHOP-27's decision packet was one confirmation away from creating a
 * duplicate of SHOP-29 — same three route modules, same pattern, already
 * written and sitting at Triage."* Both were caught by a person reading the
 * packet and recognising the work. A task that was never created leaves
 * nothing behind, so the rate is invisible in the record.
 *
 * `read_board` (ruling 273) gave the operator a way to check before it offers.
 * This is the other half: the person confirming gets the same fact, at the
 * moment the confirm is in front of them, without having to recognise it.
 */

const titleRow = z.object({
  task_key: z.string(),
  title: z.string(),
  stage: z.string(),
});

export interface SimilarTask {
  key: string;
  title: string;
  stageId: string;
}

/**
 * Words that carry no identity. Deliberately short: a stop list that grows
 * starts deciding which tasks are the same, and the threshold below was
 * measured against THIS list.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "with", "from", "into", "is", "are", "be", "as", "it", "its", "this", "that",
  "not", "no",
]);

/** The significant words of a title: lowercased, punctuation dropped, short
 *  and empty words dropped. `"Gateway routes for orders, cart and inventory"`
 *  → `{gateway, routes, orders, cart, inventory}`. */
export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/** Jaccard overlap of two titles' significant words, 0…1. */
export function titleOverlap(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * MEASURED, not chosen.
 *
 * Against the 83 real titles of the shopify-clone board — 3,403 pairs — this
 * threshold flags **none** of them, while both of the real near-misses the
 * controller named clear it comfortably: the proposed *"Gateway routes for
 * orders, cart and inventory"* scores 0.67 against SHOP-29's *"Gateway routes
 * for inventory, cart and checkout"*, and the SHOP-26 case was a title repeated
 * word for word, at 1.0.
 *
 * 0.5 would have flagged three pairs, all of them the genuinely adjacent
 * `Admin product / inventory / order management` trio — defensible, and noise
 * on a card whose whole value is that it is quiet until it is not. A
 * disclosure a person learns to skip is worse than no disclosure.
 */
export const SIMILAR_TITLE_THRESHOLD = 0.6;

/** How many echoes a card will show. More than this is not a disclosure, it is
 *  a search result, and the board is where you search. */
export const SIMILAR_TITLE_LIMIT = 3;

/**
 * Tasks on this project whose title is close to `title`, most alike first.
 *
 * Archived tasks are excluded — they are off every board and own nothing. DONE
 * tasks are NOT: "this was already built, and here it is" is exactly what a
 * person confirming needs, and the stage travels so the card can say which.
 */
export function similarOpenTasks(
  db: DatabaseSync,
  projectSlug: string,
  title: string,
  exclude: readonly string[] = [],
): SimilarTask[] {
  const skip = new Set(exclude.map((k) => k.trim().toUpperCase()));
  const rows = db
    .prepare(
      `SELECT task_key, title, stage FROM task_projections
        WHERE project_slug = ? AND archived = 0`,
    )
    .all(projectSlug);
  return rows
    .flatMap((row) => {
      const parsed = titleRow.safeParse(row);
      if (!parsed.success) return [];
      if (skip.has(parsed.data.task_key.toUpperCase())) return [];
      const score = titleOverlap(title, parsed.data.title);
      if (score < SIMILAR_TITLE_THRESHOLD) return [];
      return [
        {
          score,
          task: {
            key: parsed.data.task_key,
            title: parsed.data.title,
            stageId: parsed.data.stage,
          },
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.task.key.localeCompare(b.task.key))
    .slice(0, SIMILAR_TITLE_LIMIT)
    .map((r) => r.task);
}
