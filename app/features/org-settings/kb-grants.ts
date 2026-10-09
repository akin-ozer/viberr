// Lives apart from agent-template-modal.tsx so that file exports only
// components (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * KB grants are stored by store DIR. Older profiles (and anything written by the
 * pre-P13-KM-01 editor) carry the DISPLAY NAME, which resolves to nothing at run
 * time. Rewrite what we can recognize, so opening and saving a profile repairs
 * it instead of preserving an unresolvable string forever. Exported for the
 * controller settings panel, whose KB grants follow the same dir/name split
 * (ruling 270) — the param is the structural pick both callers have.
 */
export const kbDirsOf = (
  list: string[],
  kbs: readonly { dir: string; name: string }[],
) => {
  const byDir = new Set(kbs.map((k) => k.dir));
  const nameToDir = new Map(kbs.map((k) => [k.name, k.dir]));
  const out: string[] = [];
  for (const entry of list) {
    const dir = byDir.has(entry) ? entry : nameToDir.get(entry);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
};

/** Grants that match neither a dir nor a display name — preserved untouched. */
export const kbLegacyOf = (
  list: string[],
  kbs: readonly { dir: string; name: string }[],
) => {
  const known = new Set([...kbs.map((k) => k.dir), ...kbs.map((k) => k.name)]);
  return list.filter((x) => !known.has(x));
};
