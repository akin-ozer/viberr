import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { IconTile } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";
import { asProjectRole, roleCan } from "~/shared/rbac";
import type { OwnerAction, TaskMemberView } from "./execution-profile";

/**
 * Release-ownership confirm dialog — 1:1 port of ReleaseConfirm (task.jsx,
 * spec §4.5). Packet-styled observed-state rows (Owner / Open now / After)
 * + hand-off-instead chips (candidates INCLUDE me here, me-first — clicking
 * my own chip performs a take-over instead of releasing to nobody).
 *
 * Port additions per ruling 295: rendered as a native <dialog> via useDialog,
 * which provides Escape + backdrop-click close, focus handling, and scroll
 * lock. Identity comparisons by user id (ruling 26(a)).
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
  // Ruling 287: a release or a hand-off leaves the way Cancel does
  // (`commit`); onCancel unmounts it after the exit.
  const { ref: panelRef, close, commit } = useDialog(onCancel);
  // Defensive: the dialog should only open when owned (mock guard kept).
  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const o = owner ?? {
    userId: me.id,
    name: me.name,
    initials: undefined,
    tone: undefined,
  };
  const mine = o.userId === me.id;
  // UI-41: only members who can actually HOLD the seat are offered. `setOwner`
  // rejects viewers (`own-task` is contributor+), and `OwnerControl` already
  // applies this filter — so clicking a viewer's chip here closed the dialog and
  // produced a toast saying ownership can only go to someone who can own tasks.
  const candidates = members
    .filter(
      (m) =>
        m.userId !== o.userId && roleCan(asProjectRole(m.role), "own-task"),
    )
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
        <IconTile tone="warn" icon="hand" lg />
        <div className="mh-main">
          <h2>Release ownership?</h2>
          <div className="mh-sub">
            <span className="key">{task.key}</span> · {task.title}
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
          <div className="obs">
            <span className="k">Owner</span>
            <span className="rel-owner">
              <Avatar person={o} size="xs" />
              <strong>{o.name}</strong>
              <span className="faint">
                {mine ? "· you" : ""}
              </span>
              {!mine && (
                <Pill kind="info" sm>
                  admin release
                </Pill>
              )}
            </span>
          </div>
          <OpenNowRow task={task} />
          <div className="obs">
            <span className="k">After</span>
            <span>
              Unowned: review &amp; acceptance stall until another member takes
              the seat
            </span>
          </div>
        </div>
        {candidates.length > 0 && (
          <div>
            <div className="rel-lbl">
              Hand off instead (keeps the boundary owned)
            </div>
            <div className="rel-row">
              {candidates.map((m) => {
                const isMe = m.userId === me.id;
                return (
                  <button
                    type="button"
                    className="handoff-chip"
                    key={m.userId}
                    // UI-41: chips stayed clickable while a hand-off was in
                    // flight, so a double-click fired two owner mutations.
                    disabled={busy}
                    onClick={() =>
                      commit(() => onOwner(isMe ? "take" : "assign", m))
                    }
                  >
                    <Avatar person={m.user} size="xs" />
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
            : "Admin release. Recorded as a typed event and in the audit trail."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            {mine ? "Keep ownership" : "Cancel"}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => commit(onConfirm)}
          >
            <Icon name="x" />
            {mine ? "Release" : "Release " + o.name.split(" ")[0]}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The dialog's "Open now" row: the open packet waiting on the owner, a pending
 * human decision, or agent work with no boundary waiting. A hook-free
 * component of its own (ruling 13(b), the split of `ReleaseConfirm` along the
 * task-page recipe) in the slot the row always held.
 */
function OpenNowRow({ task }: { task: TaskSummary }) {
  const packet = task.packet;
  return (
    <div className="obs">
      <span className="k">Open now</span>
      <span>
        {packet ? (
          <span className="rel-open">
            <Pill
              // Ruling 277 (B11): a decision waiting on a person is
              // info blue; amber is an agent's question.
              kind={packet.type === "blocked" ? "blocked" : packet.answerTo ? "input" : "info"}
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
          "Agent work in progress. No boundary is waiting"
        )}
      </span>
    </div>
  );
}
