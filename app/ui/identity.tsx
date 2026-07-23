import { Icon } from "./icon";

/**
 * Agent backend glyph.
 *
 * `backend === "claude"` → sparkle/claude; anything else → cpu/codex (mock
 * fallback, kept). The Operator variant (`.agent-glyph.op` + shield) is
 * hand-rolled by mock consumers — here it is first-class via `op`. Branch on
 * operator BEFORE backend (operator rows have no backend and must not render
 * as Codex).
 */

export function AgentGlyph({
  backend,
  lg,
  op,
}: {
  backend?: string;
  lg?: boolean;
  op?: boolean;
}) {
  if (op) {
    return (
      <span className={"agent-glyph op" + (lg ? " lg" : "")}>
        <Icon name="shield" />
      </span>
    );
  }
  const cls = backend === "claude" ? "claude" : "codex";
  return (
    <span
      className={"agent-glyph " + cls + (lg ? " lg" : "")}
      title={backend === "claude" ? "Claude Code" : "Codex"}
    >
      <Icon name={backend === "claude" ? "sparkle" : "cpu"} />
    </span>
  );
}
