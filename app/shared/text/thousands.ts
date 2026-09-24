/**
 * A token count in whole thousands: 112_400 → "112k", 1_500 → "2k", 400 → "0k".
 *
 * The one form the compaction console line and timeline note (ruling 369) and
 * the stale-session sentences (ruling 372) print a context size in. The run
 * console's usage line keeps its own one-decimal form (`wire-format.server.ts`),
 * which is a different number.
 *
 * Pure, client-safe, no imports.
 */
export function wholeThousands(n: number): string {
  return `${(n / 1000).toFixed(0)}k`;
}
