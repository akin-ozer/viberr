import type { TaskDetail } from "~/server/projections/task-query.server";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

/**
 * R15-1/F15-10 — accept-completion confirm.
 *
 * Accepting a completion MERGES the review PR into the default branch — a
 * one-way write to the shared repository that used to fire on a bare click
 * (removing a credential asked first; merging to main did not). The dialog
 * states exactly what merges — PR number, the delivered revision (head sha),
 * the verdict state, and the target branch — plus any missing signal the
 * acceptance would carry past (force-accept). Same useDialog contract as
 * ArchiveConfirm / ReleaseConfirm.
 */
export function AcceptConfirm({
  task,
  workRevisionSha,
  noChanges = false,
  defaultBranch,
  /** True when this confirms the audited admin FORCE-accept (DG-2). */
  force = false,
  /** The refusal a force-accept bypasses (null for a clean accept). */
  blockedReason,
  busy,
  onCancel,
  onConfirm,
}: {
  task: TaskDetail;
  /** The delivered revision's head sha (task file), or null before delivery. */
  workRevisionSha: string | null;
  /** R17-2: a verified no-change completion — the branch is empty, no PR. */
  noChanges?: boolean;
  /** The merge target — the project's default branch. */
  defaultBranch: string;
  force?: boolean;
  blockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref: panelRef, close } = useDialog(onCancel);
  const terminalName =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.name : "Done";
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={(force ? "Force-accept " : "Accept ") + task.key}
      data-screen-label="Accept completion dialog"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className={"agent-glyph lg" + (force ? " warn" : "")}>
          <Icon name={force ? "shield" : "check"} />
        </span>
        <div className="mh-main">
          <h2>{force ? "Force-accept this completion?" : "Accept this completion?"}</h2>
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
            <span className="k">Merges</span>
            <span>
              {task.pr ? (
                <>
                  <Pill kind="neutral" sm>
                    PR #{task.pr.number} · {task.pr.state}
                  </Pill>{" "}
                  into <span className="mono">{defaultBranch}</span>
                </>
              ) : noChanges ? (
                <>
                  Nothing — <strong>completed with no changes</strong>. The
                  branch is empty, so there is no pull request to merge.
                </>
              ) : (
                <>No linked pull request — the task closes without a merge.</>
              )}
            </span>
          </div>
          <div className="obs">
            <span className="k">Revision</span>
            <span>
              {workRevisionSha ? (
                <span className="mono">{workRevisionSha.slice(0, 12)}</span>
              ) : (
                "No delivered revision recorded."
              )}
            </span>
          </div>
          {/* R17-1 (F17-L12): the PR head moved AHEAD of the reviewed revision
              since the review — accepting still merges an ahead head, but the
              human must see that those extra commits ship unreviewed and that
              the merge head is NOT the revision pinned above. */}
          {task.pr?.revisionDrift && (
            <div className="obs warn">
              <span className="k">Merge head</span>
              <span>
                <span className="mono">
                  {task.pr.revisionDrift.headSha.slice(0, 12)}
                </span>{" "}
                — {task.pr.revisionDrift.aheadBy} commit
                {task.pr.revisionDrift.aheadBy === 1 ? "" : "s"} added since
                review; they merge unreviewed.
              </span>
            </div>
          )}
          <div className="obs">
            <span className="k">Verdict</span>
            <span>
              <ValidationPill value={task.validation} />
            </span>
          </div>
          {blockedReason && (
            <div className="obs">
              <span className="k">Bypassing</span>
              <span>{blockedReason}</span>
            </div>
          )}
        </div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          {force
            ? "Admin override — the bypassed gate is recorded to the audit log."
            : task.pr
              ? "Merging is one-way. The completion event and the merge are recorded on the timeline."
              : "The completion event is recorded on the timeline. Nothing is merged — this task has no pull request."}
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Not yet
          </button>
          <button
            type="button"
            className={"btn " + (force ? "danger" : "primary")}
            disabled={busy}
            onClick={onConfirm}
          >
            <Icon name={force ? "shield" : "check"} />
            {force
              ? `Force-accept ${task.key}`
              : `Accept → ${terminalName}${task.pr ? " & merge" : ""}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
