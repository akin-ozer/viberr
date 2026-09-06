import { Icon } from "./icon";

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
  lg,
  op,
  decorative,
}: {
  backend?: string;
  lg?: boolean;
  op?: boolean;
  /** The name is visible text beside this glyph: hide it from AT. */
  decorative?: boolean;
}) {
  const claude = !op && backend === "claude";
  const name = op ? "Operator" : claude ? "Claude" : "Codex";
  const icon = op ? "shield" : claude ? "sparkle" : "cpu";
  const cls = op ? "op" : claude ? "claude" : "codex";
  if (decorative) {
    return (
      <span
        className={"agent-glyph " + cls + (lg ? " lg" : "")}
        aria-hidden="true"
      >
        <Icon name={icon} />
      </span>
    );
  }
  return (
    <span
      className={"agent-glyph " + cls + (lg ? " lg" : "")}
      role="img"
      aria-label={name}
      title={name}
    >
      <Icon name={icon} />
    </span>
  );
}
