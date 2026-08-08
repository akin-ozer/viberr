import { useRef, useState, type ReactNode } from "react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

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

/** Ties the Confirm button to its visible refusal reason (E4). */
const BLOCK_REASON_ID = "pkt-block-reason";
const DENY_NOTE_STYLE = { marginTop: ".75rem" } as const;
/** `.btn:disabled` in the sheet is what dims a refused control; an
 *  `aria-disabled` button is not `:disabled`, so it carries the dim itself —
 *  the same inline treatment the blocked option radios below already use. */
const BLOCKED_BTN_STYLE = { opacity: 0.55, cursor: "not-allowed" } as const;

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

/**
 * What an `archive_task` resolution destroys, for the confirm below. The packet
 * render carries none of it (it is the operator's authored prose plus option
 * kinds), so the task page supplies it — the same way `ArchiveConfirm` is handed
 * `task` and `pendingRecommendations` for the Current-state Archive button.
 */
export interface PacketArchiveDisclosure {
  /** Task key, for the dialog's subject line. */
  taskKey: string;
  /** The task's delivery branch (`task.branch`) — null before any delivery. */
  branch: string | null;
  /** Pending operator recommendations this archive withdraws. */
  pendingRecommendations: number;
}

/**
 * UX19-9 — an `archive_task` packet option asks first, like its sibling does.
 *
 * Ruling 17 makes this packet the ONLY place in the product that deletes a
 * remote branch ("Remote-branch deletion exists only as that packet
 * resolution"), and ruling 20 (R15-1) / ruling 53 (R18-7) established the
 * standard the rest of this page already meets: a one-way write states what it
 * destroys and offers a way out, at EVERY entry point — never from a generic
 * button. The task page confirmed the *reversible* archive (`ArchiveConfirm`,
 * which enumerates the open decision and the pending recommendations it
 * withdraws) and not the irreversible one, which committed a permanent GitHub
 * branch deletion from a button whose whole promise is "Confirm decision" and
 * announced the outcome only afterwards, as a timeline note. That inverts the
 * app's own escalation of ceremony with destructiveness.
 *
 * It is a local dialog rather than a second `AcceptDisclosureProvider`: that
 * context exists because FOUR surfaces can reach `acceptCompletion` and were
 * drifting apart (F19-3/F19-7). Ruling 17 gives branch deletion exactly one
 * surface — this card — so there is nothing to keep in sync.
 */
function PacketArchiveConfirm({
  option,
  packetTitle,
  disclosure,
  busy,
  onCancel,
  onConfirm,
}: {
  option: PacketRender["options"][number];
  packetTitle: string;
  /** Absent when the page has not wired it: the dialog then names the branch
   *  generically and states no withdrawal it cannot verify. It never invents
   *  facts to fill the slots. */
  disclosure?: PacketArchiveDisclosure;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  const deletesBranch = option.deleteBranch === true;
  const branch = disclosure?.branch ?? null;
  const pending = disclosure?.pendingRecommendations ?? 0;
  const subject = disclosure?.taskKey ?? "this task";
  const withdrawn = [
    `the open “${packetTitle}” decision`,
    ...(pending > 0
      ? [
          `${pending} pending operator recommendation${
            pending === 1 ? "" : "s"
          }`,
        ]
      : []),
  ];
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={
        (deletesBranch ? "Archive and delete the branch for " : "Archive ") +
        subject
      }
      data-screen-label="Packet archive dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg warn">
          <Icon name={deletesBranch ? "alert" : "lock"} />
        </span>
        <div className="mh-main">
          <h2>
            {deletesBranch
              ? "Archive this task and delete its branch?"
              : "Archive this task?"}
          </h2>
          <div className="mh-sub">
            {disclosure ? (
              <>
                <span className="mono">{disclosure.taskKey}</span> ·{" "}
              </>
            ) : null}
            {option.t}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body tight">
        <div className="packet-obs flush">
          {/* The human pressed "Confirm decision" — a label that names no
              outcome. Say which decision option this dialog is about, the way
              the acceptance dialog names its own entry point (F19-7). */}
          <div className="obs">
            <span className="k">Decision</span>
            <span>“{option.t}” — confirming it archives {subject}.</span>
          </div>
          {deletesBranch && (
            <div className="obs warn">
              <span className="k">Deletes</span>
              <span>
                {branch ? (
                  <>
                    The remote branch <span className="mono">{branch}</span> on
                    GitHub,
                  </>
                ) : (
                  <>This task's remote branch on GitHub,</>
                )}{" "}
                and every commit that exists only there.{" "}
                <strong>Deleting it cannot be undone</strong> — restoring the
                task later does not bring the branch back.
              </span>
            </div>
          )}
          <div className="obs">
            <span className="k">After</span>
            <span>
              Off the board and out of the review queue. The task file, its
              timeline and its audit trail are kept exactly as they are — the
              archive itself is a disposition, not a delete, and a maintainer
              can restore it.
            </span>
          </div>
          <div className="obs">
            <span className="k">Withdrawn</span>
            <span>
              {withdrawn.join(" and ")} — restoring the task reopens the
              question.
            </span>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          {deletesBranch
            ? "The archive is reversible. Deleting the branch on GitHub is not."
            : "Recorded as a timeline note and an audit row."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Not yet
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={onConfirm}
          >
            <Icon name={deletesBranch ? "alert" : "lock"} />
            {deletesBranch
              ? branch
                ? `Archive & delete ${branch}`
                : "Archive & delete the branch"
              : `Archive ${subject}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function DecisionPacket({
  packet,
  busy,
  canResolve,
  canResolveCompletion,
  canEditGoal,
  canArchive,
  archiveDisclosure,
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
  /** UX19-9: what an `archive_task` resolution destroys, for its confirm. */
  archiveDisclosure?: PacketArchiveDisclosure;
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
  // UX19-9: the archive_task option index awaiting its confirm (null = none).
  const [pendingArchive, setPendingArchive] = useState<number | null>(null);
  const isBlocked = p.type === "blocked";

  // E4: the reason the Confirm button can't be pressed. It used to live ONLY in
  // `title` on a `disabled` button — the one place a browser guarantees nobody
  // will ever read it: no hover, no focus, and out of the a11y tree entirely.
  // The option radios in this same file already knew better (`aria-disabled`,
  // whose titles DO reach a pointer). So the button stays reachable via
  // `aria-disabled`, refuses the click itself, and the reason renders as the
  // `.deny-note` the sheet defines for exactly this — visible to a sighted
  // keyboard user and announced via `aria-describedby` to a screen reader.
  const selected = p.options[sel];
  // accept_completion is maintainer+ OR this task's own owner (R6-2, widened by
  // R14-2); anyone else gets a server 403, so block the button while it's
  // selected rather than let them click into one.
  const completionBlocked =
    selected?.kind === "accept_completion" && !canResolveCompletion;
  // UI-42: same treatment for `edit_goal` — `update-goal` is admin|maintainer,
  // so resolving it without that grant leaves the packet open with no way to
  // type the new goal.
  const selectedGoalBlocked = selected?.kind === "edit_goal" && !canEditGoal;
  const selectedArchiveBlocked =
    selected?.kind === "archive_task" && !canArchive;
  const blockReason = completionBlocked
    ? "Accepting completion is reserved for maintainers and this task's owner."
    : selectedGoalBlocked
      ? "Editing the goal is reserved for maintainers."
      : selectedArchiveBlocked
        ? "Archiving is reserved for maintainers and admins."
        : null;

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
          <strong className="from-name">{p.from}</strong>
        </span>
      </div>
      <div className="packet-body">
        <h2>{p.title}</h2>
        <p className="packet-lede">
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
          // The one input on the app's highest-stakes card wears the same
          // form language as every other input: `.field` + uppercase label +
          // hint (owner feedback 2026-07-26 — it was a bare textarea outside
          // `.field`, so none of the border/focus/typography tokens applied).
          <div className="field packet-note-field">
            <label className="flabel" htmlFor="pkt-note">
              Note for the operator
              <span className="fhint">
                optional · recorded on the decision, steers the follow-up
              </span>
            </label>
            <textarea
              id="pkt-note"
              className="packet-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. what to change before reopening"
              rows={2}
            />
          </div>
        )}

        {canResolve && blockReason && (
          <p className="deny-note" id={BLOCK_REASON_ID} style={DENY_NOTE_STYLE}>
            <Icon name="lock" />
            {blockReason}
          </p>
        )}

        <div className="packet-actions">
          {canResolve && (
            <button
              type="button"
              className="btn primary"
              // Only the transient/structural refusals are a real `disabled`:
              // they need no explanation and `aria-busy` already narrates the
              // first. A ROLE refusal stays focusable so its reason is
              // reachable.
              disabled={busy || p.options.length === 0}
              aria-disabled={blockReason !== null || undefined}
              aria-describedby={blockReason ? BLOCK_REASON_ID : undefined}
              aria-busy={busy}
              // F17-L8: the visible label stays concise (echoing a multi-line
              // option title overflowed the flex button — F-UI1), but the
              // accessible name states WHAT is being confirmed, so a screen-reader
              // user hears the chosen option, not a bare "Confirm decision".
              aria-label={
                selected ? `Confirm decision: ${selected.t}` : "Confirm decision"
              }
              style={blockReason ? BLOCKED_BTN_STYLE : undefined}
              onClick={() => {
                if (blockReason) return;
                // UX19-9: `archive_task` is the packet's one-way half — it
                // archives the task and, with `deleteBranch`, permanently
                // deletes the remote branch (ruling 17: the product's only
                // remote-branch deletion). Rulings 20/53 put a confirm on
                // every one-way write; this one committed from a generic
                // "Confirm decision" while the *reversible* Archive button
                // beside it asked first.
                if (selected?.kind === "archive_task") {
                  setPendingArchive(sel);
                  return;
                }
                onResolve(sel, note);
              }}
            >
              <Icon name="check" />
              {/* A concise, stable label — echoing the full (often multi-line)
                  option title here overflowed the flex button and rendered the
                  text overlapping itself (F-UI1). The chosen option is already
                  highlighted in the radiogroup above, and the accessible name
                  (aria-label) states the selection for non-visual users. */}
              Confirm decision
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onAsk}>
            <Icon name="message" />
            Ask operator
          </button>
        </div>
      </div>

      {pendingArchive !== null && p.options[pendingArchive] && (
        <PacketArchiveConfirm
          option={p.options[pendingArchive]!}
          packetTitle={p.title}
          {...(archiveDisclosure ? { disclosure: archiveDisclosure } : {})}
          busy={busy}
          onCancel={() => setPendingArchive(null)}
          onConfirm={() => {
            const index = pendingArchive;
            setPendingArchive(null);
            onResolve(index, note);
          }}
        />
      )}
    </div>
  );
}
