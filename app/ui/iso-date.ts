// Lives apart from calendar.tsx so that file exports only components (Fast
// Refresh boundary, as initials.ts is for avatar.tsx).

/** `YYYY-MM-DD` → a LOCAL-midnight Date, or null when malformed/impossible. */
export function fromISODate(iso: string | null): Date | null {
  if (!iso) return null;
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
    ? dt
    : null;
}

/** A LOCAL Date → `YYYY-MM-DD` (from local parts, never UTC). */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
