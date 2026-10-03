/**
 * Ruling 642: a usage-limit window as a person reads it. The id is the
 * provider's (`five_hour`, `seven_day`, and `seven_day_<model>` for a plan's
 * model-scoped week, ruling 608); Insights printed it with its underscores
 * swapped for spaces ("seven day fable").
 */
export function quotaWindowLabel(rateLimitType: string): string {
  if (rateLimitType === "five_hour") return "5-hour";
  if (rateLimitType === "seven_day") return "Weekly";
  const words = (id: string) =>
    id
      .split("_")
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(" ");
  const scoped = /^seven_day_(.+)$/.exec(rateLimitType);
  if (scoped) return `Weekly · ${words(scoped[1]!)}`;
  return words(rateLimitType) || "Window";
}
