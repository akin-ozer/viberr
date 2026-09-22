import { useState } from "react";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * Ruling 381 (F39-8): a manual move BACKWARD says why.
 *
 * A stage move is one of the strongest signals a person sends on a board, and
 * it used to be mute: the event read "moved AX-9 from Review to Verify" and
 * nothing else, while the operator's own playbook told it to read the human's
 * reason and act on it. Live in pass 39 a send-back carried a specific
 * instruction, there was no field to put it in, and the operator inferred the
 * work from an older decision and dispatched the wrong thing.
 *
 * ONE dialog, shared by the task page's stage menu and the board's drag, so the
 * same act asks the same question from either door (the fork this repo keeps
 * finding: see `AcceptOnBoardConfirm`, which was collapsed onto the shared
 * `AcceptConfirm` for the same reason). Forward moves never see it.
 */
export function MoveBackConfirm({
  taskKey,
  taskTitle,
  fromStageName,
  toStageName,
  busy,
  onCancel,
  onConfirm,
}: {
  taskKey: string;
  taskTitle: string;
  fromStageName: string;
  toStageName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const { ref, close } = useDialog(onCancel);
  const ready = reason.trim().length > 0;
  return (
    <dialog
      className="modal-card"
      role="alertdialog"
      aria-label={`Move ${taskKey} back to ${toStageName}`}
      data-screen-label="Move back dialog"
      ref={ref}
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="arrow" />
        </span>
        <div className="mh-main">
          <h2>Move back to {toStageName}?</h2>
          <div className="mh-sub">
            <span className="mono">{taskKey}</span> · {taskTitle}
          </div>
        </div>
      </div>
      <div className="modal-body">
        <p className="sub">
          It leaves {fromStageName}. The operator reads this to decide what to do
          next, so say what should change before it comes back.
        </p>
        <div className="field">
          <label className="flabel" htmlFor="move-back-reason">
            Why
          </label>
          <textarea
            id="move-back-reason"
            rows={3}
            autoFocus
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. the gate does not run the race test the rulings require. Add it."
          />
        </div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          It goes on the transition entry, where the operator reads it.
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!ready || busy}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? "Moving…" : "Move back"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
