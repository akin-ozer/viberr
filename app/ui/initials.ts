/**
 * Avatar initials from a display name: the first letters of the first two
 * words, uppercased ("Ada Lovelace" → "AL", "Deniz Şahin" → "DŞ"), or "?" for a
 * blank or missing name. Lives apart from avatar.tsx so that file exports only
 * components (Fast Refresh boundary). Plain TS with no imports, so the server's
 * actor mapping and the mention autocomplete share this one definition.
 */
export function initialsOf(name: string | null | undefined): string {
  return (
    (name || "")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}
