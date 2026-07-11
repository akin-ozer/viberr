import { useState } from "react";
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
 * NOTE (spec §8.2): packet body + observation values render as PLAIN text —
 * mock behavior kept verbatim (backticked code like `pull_request:write`
 * shows literally).
 */
export function DecisionPacket({
  packet,
  busy,
  canResolve,
  onResolve,
  onAsk,
}: {
  packet: PacketRender;
  busy: boolean;
  /** Whether the viewer may RESOLVE this packet (admin|maintainer, or the task
   *  owner for non-completion options — M2). "Ask operator" stays open to all
   *  (commenting is app-wide). */
  canResolve: boolean;
  onResolve: (optionIndex: number) => void;
  onAsk: () => void;
}) {
  const p = packet;
  const [sel, setSel] = useState(() =>
    Math.max(0, p.options.findIndex((o) => o.rec)),
  );
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
          {p.body}
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

        <div className="packet-actions">
          {canResolve && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || p.options.length === 0}
              aria-busy={busy}
              onClick={() => onResolve(sel)}
            >
              <Icon name="check" />
              {p.options[sel] ? p.options[sel].t : "Confirm"}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onAsk}>
            <Icon name="message" />
            Ask operator
          </button>
        </div>
      </div>
    </div>
  );
}
