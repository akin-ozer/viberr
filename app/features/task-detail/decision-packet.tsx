import { useState, type ReactNode } from "react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";

/**
 * Decision packet card — 1:1 port of DecisionPacket (task.jsx, spec §4.2).
 * Rendered only when the task has an open packet. The primary button's
 * label is the SELECTED option's title; resolution dispatches by option
 * INDEX (the server re-reads the packet and dispatches on the option's
 * stable `kind` — ruling 7, never the English title).
 *
 * Port additions (sanctioned): arrow-key roving on the radiogroup
 * (spec §7 accessibility inventory), busy-disable while the resolve action
 * is in flight (no optimistic governed state).
 *
 * The packet body renders inline `code` spans (a real operator writes branch
 * names / scopes like `pull_request:write` inline) — the mock's plain-text-with-
 * visible-backticks was corrected so the model's markdown reads as intended.
 */

/** Render a string with `inline code` spans; everything else stays plain text. */
function renderInlineCode(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<code key={i++}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function DecisionPacket({
  packet,
  busy,
  canResolve,
  canResolveCompletion,
  onResolve,
  onAsk,
}: {
  packet: PacketRender;
  busy: boolean;
  /** Whether the viewer may RESOLVE this packet (admin|maintainer, or the task
   *  owner for non-completion options — M2). "Ask operator" stays open to all
   *  (commenting is app-wide). */
  canResolve: boolean;
  /** Whether the viewer may resolve the ACCEPT_COMPLETION option specifically —
   *  admin|maintainer only (the always-human Done authority). An owner-only
   *  viewer has canResolve but not this, so the button is blocked while that
   *  option is selected rather than 403ing on click (adversarial-review #15). */
  canResolveCompletion: boolean;
  onResolve: (optionIndex: number, note: string) => void;
  onAsk: () => void;
}) {
  const p = packet;
  const [sel, setSel] = useState(() =>
    Math.max(0, p.options.findIndex((o) => o.rec)),
  );
  // P11-71: optional free-text so a human can supply the input an option asks
  // for (e.g. "specify the expected behavior") instead of resolving with an
  // unstated reading. Recorded on the decision event.
  const [note, setNote] = useState("");
  const isBlocked = p.type === "blocked";

  const move = (delta: number) => {
    if (p.options.length === 0) return;
    setSel((s) => (s + delta + p.options.length) % p.options.length);
  };

  return (
    <div className={"packet " + (isBlocked ? "blocked" : "input")}>
      <div className="packet-top">
        <Pill kind={isBlocked ? "blocked" : "input"} dot>
          {p.kind}
        </Pill>
        <span className="from">
          from{" "}
          <span className="agent-glyph op">
            <Icon name="shield" />
          </span>{" "}
          <strong style={{ fontFamily: "var(--font-display)" }}>{p.from}</strong>
        </span>
      </div>
      <div className="packet-body">
        <h2>{p.title}</h2>
        <p
          style={{
            color: "var(--muted)",
            fontSize: ".92rem",
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          {renderInlineCode(p.body)}
        </p>

        <div className="packet-obs">
          {p.observations.map((o, i) => (
            <div className="obs" key={i}>
              <span className="k">{o.k}</span>
              <span>{o.code ? <code>{o.v}</code> : o.v}</span>
            </div>
          ))}
        </div>

        <div
          className="options"
          role="radiogroup"
          aria-label="Decision options"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            }
          }}
        >
          {p.options.map((o, i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={sel === i}
              className={
                "opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")
              }
              onClick={() => setSel(i)}
            >
              <span className="radio" />
              <span>
                <div className="ot">{o.t}</div>
                <div className="od">{o.d}</div>
              </span>
              {o.rec && (
                <span className="rec-tag">
                  <Pill kind="info" sm>
                    operator pick
                  </Pill>
                </span>
              )}
            </button>
          ))}
        </div>

        {canResolve && (
          <textarea
            className="packet-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the operator (optional) — e.g. the specific input this option asks for"
            rows={2}
            style={{ marginTop: "12px", width: "100%" }}
          />
        )}

        <div className="packet-actions">
          {(() => {
            const selected = p.options[sel];
            // The accept_completion option is admin|maintainer only; an
            // owner-only viewer can't resolve it (the server 403s), so block the
            // button while it's selected rather than let them click into a 403.
            const completionBlocked =
              selected?.kind === "accept_completion" && !canResolveCompletion;
            if (!canResolve) return null;
            return (
              <button
                type="button"
                className="btn primary"
                disabled={busy || p.options.length === 0 || completionBlocked}
                aria-busy={busy}
                title={
                  completionBlocked
                    ? "Accepting completion is reserved for maintainers"
                    : undefined
                }
                onClick={() => onResolve(sel, note)}
              >
                <Icon name="check" />
                {/* A concise, stable label — echoing the full (often multi-line)
                    option title here overflowed the flex button and rendered the
                    text overlapping itself (F-UI1). The chosen option is already
                    highlighted in the radiogroup above. */}
                Confirm decision
              </button>
            );
          })()}
          <button type="button" className="btn ghost" onClick={onAsk}>
            <Icon name="message" />
            Ask operator
          </button>
        </div>
      </div>
    </div>
  );
}
