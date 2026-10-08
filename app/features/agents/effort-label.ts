// Lives apart from create-profile-modal.tsx for react-doctor's
// only-export-components. That file still exports the `useModelCatalog` hook,
// so it is not a Fast Refresh boundary (see use-command-palette.ts).

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
