import { Icon, type IconName } from "./icon";

/** The tinted medallion tones `.agent-glyph` defines. `warn` is the
 *  release-ownership dialog's; the other three are backends. */
export type IconTileTone = "codex" | "claude" | "op" | "warn";

/**
 * A glyph in a tinted round medallion — the shape `.agent-glyph` has always
 * drawn, now with a name and a `tone` prop instead of a class string each
 * caller assembles.
 *
 * It exists because `.agent-glyph.warn` had no component: the release-ownership
 * dialog hand-wrote `<span className="agent-glyph lg warn"><Icon name="hand" /></span>`,
 * a second copy of AgentGlyph's markup that no prop could reach and that quietly
 * skipped the accessibility branch below. One tile, four tones, one place where
 * the aria decision is made.
 *
 * `label` is the accessible name; omit it for a decorative tile (one whose
 * meaning is already in visible text beside it), and the tile leaves the
 * accessibility tree rather than being announced twice.
 */
export function IconTile({
  tone,
  icon,
  lg,
  label,
}: {
  tone: IconTileTone;
  icon: IconName;
  lg?: boolean;
  /** Accessible name. Omit for a decorative tile. */
  label?: string;
}) {
  // The class string is built inline in BOTH branches rather than hoisted to a
  // `const`: app.css.test.ts harvests the static chunks of a class-attribute
  // concatenation, so passing a bare identifier instead would read to it as a
  // class literally named after that variable. Keeping the string literal at
  // the attribute is what keeps `agent-glyph` and `lg` visible to the
  // orphan-class gate. (The gate scans source text, comments included — so this
  // note deliberately does not spell out the attribute-plus-identifier form.)
  if (!label) {
    return (
      <span
        className={"agent-glyph " + tone + (lg ? " lg" : "")}
        aria-hidden="true"
      >
        <Icon name={icon} />
      </span>
    );
  }
  return (
    <span
      className={"agent-glyph " + tone + (lg ? " lg" : "")}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </span>
  );
}

/**
 * Agent backend glyph.
 *
 * `backend === "claude"` → sparkle/claude; anything else → cpu/codex (mock
 * fallback, kept). The Operator variant (`.agent-glyph.op` + shield) is
 * hand-rolled by mock consumers — here it is first-class via `op`. Branch on
 * operator BEFORE backend (operator rows have no backend and must not render
 * as Codex).
 *
 * The glyph is a picture of who acts, so by default it is an image with a
 * real name (`role="img"` + `aria-label`; the old `title` alone was a tooltip
 * no screen reader used as a name, and it stays only as the sighted hover).
 * A caller that already prints the name beside the glyph passes `decorative`:
 * the glyph then leaves the accessibility tree, so a row is not announced as
 * "Codex Codex" and a button's name is not doubled.
 */

export function AgentGlyph({
  backend,
  op,
  decorative,
}: {
  backend?: string;
  op?: boolean;
  /** The name is visible text beside this glyph: hide it from AT. */
  decorative?: boolean;
}) {
  const claude = !op && backend === "claude";
  const name = op ? "Operator" : claude ? "Claude" : "Codex";
  return (
    <IconTile
      tone={op ? "op" : claude ? "claude" : "codex"}
      icon={op ? "shield" : claude ? "sparkle" : "cpu"}
      label={decorative ? undefined : name}
    />
  );
}

/**
 * Ruling 306: the agent as a badge in the board card's avatar stack — a 22px
 * circle in the backend's tint with the backend's mark, the same size and
 * shape as the owner's avatar beside it, so the two seats read as one stack.
 * The profile's name is not printed on the card; it is the badge's accessible
 * name and its tooltip ("Claude · Backend Engineer"), the way the owner's name
 * is the avatar's. The cut-corner tile stays the agent's mark everywhere else.
 */
export function AgentBadge({ backend, name }: { backend?: string; name: string }) {
  const claude = backend === "claude";
  const label = (claude ? "Claude" : "Codex") + " · " + name;
  return (
    <span
      className={"abadge " + (claude ? "claude" : "codex")}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon name={claude ? "sparkle" : "cpu"} />
    </span>
  );
}
