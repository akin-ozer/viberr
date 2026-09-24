/**
 * Client-safe project-name derivations (home spec §5.9) for the New-project
 * modal's live preview. The project slug (and the repo default) is `slugify`
 * from ~/shared/ids/slugify, which the create action calls too — so the modal
 * previews exactly the slug the server creates.
 */

/** Mock-verbatim task-key derivation: multi-word → initials, single word →
 * first 3 chars; uppercase letters only; max 4. */
export function keyFromName(name: string): string {
  const w = (name || "").trim().toUpperCase().replace(/[^A-Z ]/g, "");
  if (!w) return "";
  const parts = w.split(/\s+/);
  return (parts.length > 1 ? parts.map((x) => x[0]).join("") : w.slice(0, 3)).slice(0, 4);
}

/** Inverse direction of the New-project modal's linked name↔repo pair:
 * derive a display name from a repo name ("payments-gateway" / "core_api" →
 * "Payments Gateway" / "Core Api"). Forward direction is `slugify`. */
export function projectNameFromRepo(repo: string): string {
  return repo
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/(?:^| )[a-z]/g, (c) => c.toUpperCase());
}
