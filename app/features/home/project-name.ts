/**
 * Client-safe project-name derivations (home spec §5.9) — shared by the
 * New-project modal (live preview) and the create action.
 */

/** Mock-verbatim task-key derivation: multi-word → initials, single word →
 * first 3 chars; uppercase letters only; max 4. */
export function keyFromName(name: string): string {
  const w = (name || "").trim().toUpperCase().replace(/[^A-Z ]/g, "");
  if (!w) return "";
  const parts = w.split(/\s+/);
  return (parts.length > 1 ? parts.map((x) => x[0]).join("") : w.slice(0, 3)).slice(0, 4);
}

/** Canonical project slug: slugified name (lowercase, runs of non-alnum →
 * "-", trimmed). Decision documented in the phase-4 report (home spec §9.1). */
export function slugifyProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Inverse direction of the New-project modal's linked name↔repo pair:
 * derive a display name from a repo name ("payments-gateway" / "core_api" →
 * "Payments Gateway" / "Core Api"). Forward direction is slugifyProjectName. */
export function projectNameFromRepo(repo: string): string {
  return repo
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/(?:^| )[a-z]/g, (c) => c.toUpperCase());
}
