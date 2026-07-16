import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";
import type { OwnerAction, TaskMemberView } from "./execution-profile";

/**
 * Release-ownership confirm dialog — 1:1 port of ReleaseConfirm (task.jsx,
 * spec §4.5). Packet-styled observed-state rows (Owner / Open now / After)
 * + hand-off-instead chips (candidates INCLUDE me here, me-first — clicking
 * my own chip performs a take-over instead of releasing to nobody).
 *
 * Port additions per ruling 16: rendered as a native <dialog> via useDialog,
 * which provides Escape + backdrop-click close, focus handling, and scroll
 * lock. Identity comparisons by user id (ruling 6).
 */
export function ReleaseConfirm({
  task,
  me,
  members,
  busy,
  onCancel,
  onConfirm,
  onOwner,
}: {
  task: TaskSummary;
  me: { id: string; name: string };
  members: TaskMemberView[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  // Defensive: the dialog should only open when owned (mock guard kept).
  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const o = owner ?? {
    userId: me.id,
    name: me.name,
    initials: undefined,
    tone: undefined,
  };
  const mine = o.userId === me.id;
  const packet = task.packet;
  const candidates = members
    .filter((m) => m.userId !== o.userId)
    .sort(
      (a, b) => (b.userId === me.id ? 1 : 0) - (a.userId === me.id ? 1 : 0),
    );

  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={"Release ownership of " + task.key}
      data-screen-label="Release ownership dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg warn">
          <Icon name="hand" />
        </span>
        <div className="mh-main">
          <h2>Release ownership?</h2>
          <div className="mh-sub">
            <span className="mono">{task.key}</span> · {task.title}
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
      <div className="modal-body" style={{ gap: "1.05rem" }}>
        <div className="packet-obs" style={{ margin: 0 }}>
          <div className="obs">
            <span className="k">Owner</span>
            <span className="rel-owner">
              <Avatar person={o} />
              <strong>{o.name}</strong>
              <span style={{ color: "var(--faint)" }}>
                {mine ? "· you" : ""}
              </span>
              {!mine && (
                <Pill kind="info" sm>
                  admin release
                </Pill>
              )}
            </span>
          </div>
          <div className="obs">
            <span className="k">Open now</span>
            <span>
              {packet ? (
                <span className="rel-open">
                  <Pill
                    kind={packet.type === "blocked" ? "blocked" : "input"}
                    sm
                    dot
                  >
                    {packet.kind}
                  </Pill>{" "}
                  waiting on the owner
                </span>
              ) : task.waiting === "human" ? (
                "A human decision is pending on this task"
              ) : (
                "Agent work in progress — no boundary is waiting"
              )}
            </span>
          </div>
          <div className="obs">
            <span className="k">After</span>
            <span>
              Unowned — review &amp; acceptance stall until another member takes
              the seat
            </span>
          </div>
        </div>
        {candidates.length > 0 && (
          <div>
            <div className="rel-lbl">
              Hand off instead — keeps the boundary owned
            </div>
            <div className="rel-row">
              {candidates.map((m) => {
                const isMe = m.userId === me.id;
                return (
                  <button
                    type="button"
                    className="handoff-chip"
                    key={m.userId}
                    onClick={() => {
                      onCancel();
                      onOwner(isMe ? "take" : "assign", m);
                    }}
                  >
                    <Avatar person={m.user} />
                    <span className="nm">
                      {m.user.name.split(" ")[0]}
                      {isMe ? " · you" : ""}
                    </span>
                    <span className="rl">{m.role}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          {mine
            ? "Recorded as a typed ownership event on the timeline."
            : "Admin release — recorded as a typed event and in the audit trail."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            {mine ? "Keep ownership" : "Cancel"}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={onConfirm}
          >
            <Icon name="x" />
            {mine ? "Release" : "Release " + o.name.split(" ")[0]}
          </button>
        </div>
      </div>
    </dialog>
  );
}
