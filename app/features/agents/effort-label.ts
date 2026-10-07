// Lives apart from create-profile-modal.tsx so that file exports only
// components (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

const EFFORT_LABEL = new Map<string, string>([
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
]);

/** An effort tier's display name, as the picker offers it. Exported for the
 *  profile panel's runtime row (ruling 479(e)), which names the stored tier in
 *  the same words; the two modules already share one route chunk. */
export function effortLabel(id: string): string {
  return EFFORT_LABEL.get(id) ?? id;
}
