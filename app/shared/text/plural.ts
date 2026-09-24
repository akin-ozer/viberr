/**
 * Count-and-noun agreement, in one place.
 *
 * Every surface that renders "{n} thing" had to remember the
 * `n === 1 ? "" : "s"` tail by hand, and the ones that forgot shipped copy the
 * product does not mean: the Users tab read "1 instance accounts", the org
 * resources line "1 knowledge bases", the stage editor "1 stages". A count is
 * data; the noun beside it is a claim about that data, and the two disagreeing
 * is the smallest possible way for the UI to lie.
 *
 * Pure, client-safe, English-only (the product is monolingual today — when it
 * stops being, this is the single call site an Intl.PluralRules swap replaces).
 *
 * Ruling 457 keeps a few client modules on the hand-written tail. This module
 * ships as its own chunk, and the task page and the controller page load it
 * from none of their other modules, so importing it there adds ~100 B gzip to
 * two budgets that have no room: the run console (`runs-panels.tsx`,
 * `runs-helpers.ts`, `log-noise.ts`), the label field (`ui/label-input.tsx`)
 * and the two withdrawn-recommendation lists (`decision-packet.tsx`,
 * `archive-confirm.tsx`) spell it inline. So does `shared/revision-drift.ts`,
 * for the closed dock's module count.
 */

/** The NOUN alone, agreeing with `count` — for copy that renders the number
 *  separately (a styled `<b>{n}</b>` and its label, say). */
export function pluralNoun(
  count: number,
  one: string,
  many: string = one + "s",
): string {
  return count === 1 ? one : many;
}

/** "1 user" / "3 users" — the count and its noun, always agreeing. Irregular
 *  plurals pass the third argument ("knowledge base", "knowledge bases" is
 *  regular; "person"/"people" is not). */
export function countLabel(
  count: number,
  one: string,
  many: string = one + "s",
): string {
  return `${count} ${pluralNoun(count, one, many)}`;
}
