/**
 * Human avatar. The initials helper lives in initials.ts. `tone` maps to the
 * CSS classes .avatar.rose / .teal
 * / .violet (empty string = default).
 *
 * Size is a prop, not a set of contextual overrides. Five call sites used to
 * resize the avatar from the OUTSIDE — `.rev-stack .avatar`, `.stack .avatar`,
 * `.own-menu .avatar`, `.rel-owner .avatar`, `.handoff-chip .avatar` — so the
 * rendered size of an `<Avatar />` depended on which ancestor it happened to
 * land in, and a sixth surface wanting 22px meant a sixth descendant selector.
 * The sizes are now named on the component and the overrides are gone.
 */

export interface AvatarPerson {
  initials?: string | null;
  tone?: string | null;
}

/** A person in a group: an avatar plus the name the group announces. */
export interface AvatarGroupPerson extends AvatarPerson {
  name: string;
}

/** The five sizes the app draws: 22 · 24 · 26 (default) · 34 · 56px. */
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export function Avatar({
  person,
  size = "md",
}: {
  person?: AvatarPerson | null;
  size?: AvatarSize;
}) {
  const tone = person && person.tone ? " " + person.tone : "";
  return (
    <span className={"avatar" + (size === "md" ? "" : " " + size) + tone}>
      {(person && person.initials) || "?"}
    </span>
  );
}

/**
 * Overlapping avatars for a set of people — the shape `.stack` drew by hand.
 *
 * The group carries ONE accessible name listing everyone, so the overlap (and
 * the `+N` fold) is presentation only: nobody is hidden from a screen reader by
 * a visual cap. `role="img"` is what makes the label count — ARIA prohibits
 * `aria-label` on a role-less span and readers drop it.
 */
export function AvatarGroup({
  people,
  max,
}: {
  people: readonly AvatarGroupPerson[];
  /** Fold everyone past this many into a `+N` chip. Omit for no cap. */
  max?: number;
}) {
  // An image with an empty name is an axe violation, and there is nothing to
  // show: a project can lose every member only by hand-editing.
  if (people.length === 0) return null;
  const shown = max == null ? people : people.slice(0, max);
  const folded = people.length - shown.length;
  return (
    <span
      className="avatar-group"
      role="img"
      aria-label={people.map((p) => p.name).join(", ")}
    >
      {shown.map((p) => (
        <Avatar key={p.name} person={p} size="sm" />
      ))}
      {/* The `+N` chip, hidden from assistive tech: the group's own label
          already names every person, folded ones included. */}
      {folded > 0 && (
        <span className="avatar count sm" aria-hidden="true">
          +{folded}
        </span>
      )}
    </span>
  );
}
