import { useRef, useState, type ReactNode } from "react";
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
/**
 * LV-09: packet observations are written by the operator, which serializes an
 * absent value as the literal string "null" — a blocked packet printed
 * `OWNER null` at the human it was asking for a decision. Render the empty
 * cases as English; anything else passes through verbatim.
 */
/**
 * P13: the operator authors observation KEYS itself, and it writes machine-ish
 * ones (`prompt_agent error`, `open packet`). The row uppercases them, so a
 * live packet rendered "PROMPT_AGENT ERROR" at a human. Underscores become
 * spaces; the CSS still does the uppercasing.
 */
export function observationLabel(key: string): string {
  return key.replace(/_/g, " ").trim();
}

export function observationValue(key: string, value: string): string {
  const empty =
    value.trim() === "" ||
    value.trim().toLowerCase() === "null" ||
    value.trim().toLowerCase() === "undefined" ||
    value.trim().toLowerCase() === "none";
  if (!empty) return value;
  return /owner|assignee/i.test(key) ? "unassigned" : "—";
}

export function DecisionPacket({
  packet,
  busy,
  canResolve,
  canResolveCompletion,
  canEditGoal,
  canArchive,
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
   *  admin|maintainer, or this task's own human owner (R6-2, widened by R14-2).
   *  A viewer with canResolve but not this (e.g. a packet addressed to someone
   *  else's task) has the button blocked while that option is selected rather
   *  than 403ing on click (adversarial-review #15). */
  canResolveCompletion: boolean;
  /** UI-42: whether the viewer may actually EDIT the goal. `edit_goal` is
   *  offered to any packet resolver (which includes the task owner), but
   *  `update-goal` is admin|maintainer — so a contributor-owner picked "a human
   *  refines the task goal", got "type the new goal", and found no editor and no
   *  Edit button, with the packet open forever. */
  canEditGoal: boolean;
  /** Whether the viewer holds `approve-transition` — the R14-3 archive tier an
   *  `archive_task` option re-checks server-side. Same block-with-reason
   *  treatment as the two flags above. */
  canArchive: boolean;
  onResolve: (optionIndex: number, note: string) => void;
  onAsk: () => void;
}) {
  const p = packet;
  const [sel, setSel] = useState(() =>
    Math.max(0, p.options.findIndex((o) => o.rec)),
  );
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // P11-71: optional free-text so a human can supply the input an option asks
  // for (e.g. "specify the expected behavior") instead of resolving with an
  // unstated reading. Recorded on the decision event.
  const [note, setNote] = useState("");
  const isBlocked = p.type === "blocked";

  // UI-44: roving tabindex + real focus movement. Every `role="radio"` used to
  // stay tabbable and the arrow handler only changed `sel`, so DOM focus stayed
  // on the previously focused radio while `aria-checked` moved elsewhere — a
  // screen-reader user got no feedback from the app's highest-stakes control,
  // and Tab walked every option.
  const move = (delta: number) => {
    if (p.options.length === 0) return;
    setSel((s) => {
      const next = (s + delta + p.options.length) % p.options.length;
      requestAnimationFrame(() => optionRefs.current[next]?.focus());
      return next;
    });
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
          {p.observations.map((o, i) => {
            const value = observationValue(o.k, o.v);
            return (
              <div className="obs" key={i}>
                <span className="k">{observationLabel(o.k)}</span>
                <span>{o.code ? <code>{value}</code> : value}</span>
              </div>
            );
          })}
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
          {p.options.map((o, i) => {
            // UI-42: an option the viewer cannot carry out is disabled and says
            // why, instead of recording a decision that dead-ends.
            const goalBlocked = o.kind === "edit_goal" && !canEditGoal;
            // archive_task re-checks `approve-transition` server-side (R14-3):
            // same honest block for a resolver below that tier (LV-08 — no
            // control that only exists to 403).
            const archiveBlocked = o.kind === "archive_task" && !canArchive;
            const blocked = goalBlocked || archiveBlocked;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                aria-checked={sel === i}
                aria-disabled={blocked || undefined}
                tabIndex={sel === i ? 0 : -1}
                className={
                  "opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")
                }
                style={blocked ? { opacity: 0.55 } : undefined}
                title={
                  goalBlocked
                    ? "Editing the goal is reserved for maintainers — ask one to refine it"
                    : archiveBlocked
                      ? "Archiving is reserved for maintainers and admins"
                      : undefined
                }
                onClick={() => {
                  if (blocked) return;
                  setSel(i);
                }}
              >
                <span className="radio" />
                <span>
                  <div className="ot">{o.t}</div>
                  <div className="od">
                    {o.d}
                    {goalBlocked
                      ? " · your role can't edit the goal — a maintainer must"
                      : ""}
                    {archiveBlocked
                      ? " · your role can't archive — a maintainer must"
                      : ""}
                  </div>
                </span>
                {/* The destructive half of archive_task is loud: this option
                    doesn't just file the task away, it deletes the remote
                    branch. */}
                {o.kind === "archive_task" && o.deleteBranch && (
                  <span className="rec-tag">
                    <Pill kind="blocked" sm>
                      deletes branch
                    </Pill>
                  </span>
                )}
                {o.rec && (
                  <span className="rec-tag">
                    <Pill kind="info" sm>
                      operator pick
                    </Pill>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {canResolve && (
          <textarea
            className="packet-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note for the operator (optional) — e.g. the specific input this option asks for"
            rows={2}
          />
        )}

        <div className="packet-actions">
          {(() => {
            const selected = p.options[sel];
            // accept_completion is maintainer+ OR this task's own owner (R6-2,
            // widened by R14-2); anyone else gets a server 403, so block the
            // button while it's selected rather than let them click into one.
            const completionBlocked =
              selected?.kind === "accept_completion" && !canResolveCompletion;
            // UI-42: same treatment for `edit_goal` — `update-goal` is
            // admin|maintainer, so resolving it without that grant leaves the
            // packet open with no way to type the new goal.
            const goalBlocked = selected?.kind === "edit_goal" && !canEditGoal;
            const archiveBlocked =
              selected?.kind === "archive_task" && !canArchive;
            if (!canResolve) return null;
            return (
              <button
                type="button"
                className="btn primary"
                disabled={
                  busy ||
                  p.options.length === 0 ||
                  completionBlocked ||
                  goalBlocked ||
                  archiveBlocked
                }
                aria-busy={busy}
                title={
                  completionBlocked
                    ? "Accepting completion is reserved for maintainers and this task's owner"
                    : goalBlocked
                      ? "Editing the goal is reserved for maintainers"
                      : archiveBlocked
                        ? "Archiving is reserved for maintainers and admins"
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
