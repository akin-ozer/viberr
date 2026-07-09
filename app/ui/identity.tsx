import { Avatar, type AvatarPerson } from "./avatar";
import { Icon } from "./icon";

/**
 * AgentGlyph + Identity, ported from design/html-app/app/ui.jsx.
 *
 * AgentGlyph: `backend === "claude"` → sparkle/claude; anything else →
 * cpu/codex (mock fallback, kept). The Operator variant (`.agent-glyph.op`
 * + shield) is hand-rolled by mock consumers — here it is first-class via
 * `op`. Branch on operator/system BEFORE backend (operator rows have no
 * backend and must not render as Codex).
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

export interface IdentityWho extends AvatarPerson {
  kind?: "agent" | "system" | "human" | (string & {});
  backend?: string;
  name?: string;
  role?: string;
}

/**
 * Polymorphic inline identity chip (agent / system / human).
 * `sub` is a string prop (the mock hardcoded "agent specialist" /
 * "human · maintainer" — callers pass real copy; spec §7.7).
 */
function Identity({
  who,
  lg,
  sub,
}: {
  who?: IdentityWho | null;
  lg?: boolean;
  sub?: string;
}) {
  if (!who) {
    return (
      <span className="who-chip">
        <span className="avatar">?</span>
      </span>
    );
  }
  if (who.kind === "agent") {
    return (
      <span className="who-chip">
        <AgentGlyph backend={who.backend} lg={lg} />
        <span>
          <span className="nm">
            {who.name}
            {who.role ? " · " + who.role : ""}
          </span>
          {sub && <div className="sub">{sub}</div>}
        </span>
      </span>
    );
  }
  if (who.kind === "system") {
    return (
      <span className="who-chip">
        <span className="agent-glyph">
          <Icon name="shield" />
        </span>
        <span className="nm">{who.name}</span>
      </span>
    );
  }
  return (
    <span className="who-chip">
      <Avatar person={who} lg={lg} />
      <span>
        <span className="nm">{who.name}</span>
        {sub && <div className="sub">{sub}</div>}
      </span>
    </span>
  );
}
