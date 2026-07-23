/**
 * Avatar initials from a display name ("Ada Lovelace" → "AL"). Lives apart
 * from avatar.tsx so
 * that file exports only components (Fast Refresh boundary).
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
