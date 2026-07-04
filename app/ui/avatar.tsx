/**
 * Human avatar + initials helper, ported 1:1 from design/html-app/app/ui.jsx.
 * `tone` maps to the CSS classes .avatar.rose / .teal / .violet (empty
 * string = default). AgentGlyph/Identity arrive with the surfaces that use
 * them (phase 4+).
 */

export interface AvatarPerson {
  initials?: string | null;
  tone?: string | null;
}

/** Sizes: base 26px, `lg` 34px, `xl` 56px (profile) — CSS classes as-is. */
export function Avatar({
  person,
  lg,
  xl,
}: {
  person?: AvatarPerson | null;
  lg?: boolean;
  xl?: boolean;
}) {
  const tone = person && person.tone ? " " + person.tone : "";
  const size = xl ? " xl" : lg ? " lg" : "";
  return (
    <span className={"avatar" + size + tone}>
      {(person && person.initials) || "?"}
    </span>
  );
}

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
