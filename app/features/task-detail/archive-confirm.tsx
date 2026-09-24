import type { TaskDetail } from "~/server/projections/task-query.server";
import { prStatePill } from "~/features/github/github-pills";
import { countLabel } from "~/shared/text/plural";
import { stageLabel } from "~/shared/workflow/stage-roles";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

/**
 * R14-3 — archive confirm.
 *
 * Archiving is a terminal disposition, not a delete: the task file, its whole
 * timeline and its audit rows survive, the card leaves the board's default view
 * and the review queue, and a maintainer can restore it. What it DOES destroy is
 * the pending question — the open packet and every pending recommendation are
 * withdrawn, because nothing waits on abandoned work — so the dialog states that
 * before the click, the way `ReleaseConfirm` states what a release costs.
 */
export function ArchiveConfirm({
  task,
  pendingRecommendations,
  busy,
  onCancel,
  onConfirm,
}: {
  task: TaskDetail;
  /** Pending operator recommendations the archive withdraws (loader-supplied —
   *  they live in the task file, not the projection). */
  pendingRecommendations: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  // Ruling 148: the same words as the stage menu and the board row, and never
  // the raw internal id (the F19-36 defect below, second axis).
  const stageName = stageLabel(task.stages.find((s) => s.id === task.stage));
  // F19-36: this printed the raw internal state token — "PR #12 accepted" for a
  // PR that is really merge-pending, "PR #12 review" for one in review — while
  // every other surface renders the canonical label from the ONE PR-state map
  // (ruling 12). Same defect as F19-14 at accept-confirm.tsx, second site.
  const prPill = task.pr ? prStatePill(task.pr.state) : null;
  // What archiving withdraws, named exactly — the server writes the same list
  // into the archive note on the timeline.
  const withdrawn = [
    ...(task.packet ? [`the open “${task.packet.title}” decision`] : []),
    ...(pendingRecommendations > 0
      ? [countLabel(pendingRecommendations, "pending operator recommendation")]
      : []),
  ];

  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={"Archive " + task.key}
      data-screen-label="Archive task dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg warn">
          <Icon name="lock" />
        </span>
        <div className="mh-main">
          <h2>Archive this task?</h2>
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
      <div className="modal-body tight">
        <div className="packet-obs flush">
          <div className="obs">
            <span className="k">Now</span>
            <span>
              At <strong>{stageName}</strong>
              {task.pr && prPill ? (
                <>
                  {" "}
                  ·{" "}
                  <Pill kind={prPill.kind} sm>
                    PR #{task.pr.number} · {prPill.label}
                  </Pill>
                </>
              ) : null}
            </span>
          </div>
          <div className="obs">
            <span className="k">After</span>
            <span>
              Off the board and out of the review queue. The task file, its
              timeline and its audit trail are kept exactly as they are. This is
              a disposition, not a delete.
            </span>
          </div>
          <div className="obs">
            <span className="k">Withdrawn</span>
            <span>
              {withdrawn.length > 0
                ? `${withdrawn.join(" and ")}. Restoring brings the task back to a human; run the operator to reopen the decision.`
                : // C14: this row surveys the open packet + pending
                  // recommendations only — it said "Nothing is pending on this
                  // task right now" while a live run streamed behind the dialog.
                  // Narrow the claim to what it actually looks at.
                  "No open decision or pending recommendation to withdraw."}
            </span>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          Recorded as a timeline note and an audit row. A maintainer can restore
          it from this page.
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Keep on the board
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={onConfirm}
          >
            <Icon name="lock" />
            Archive {task.key}
          </button>
        </div>
      </div>
    </dialog>
  );
}
