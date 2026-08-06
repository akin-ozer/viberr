import { createContext, useContext, type ReactNode } from "react";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { prStatePill } from "~/features/github/github-pills";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

/**
 * The facts EVERY acceptance confirm states, assembled ONCE by the task page
 * and handed unchanged to each entry point (F19-3 / F19-7). One object, so no
 * acceptance surface can drift into disclosing a different set of facts than
 * the surface beside it — which is exactly how the recommendation card ended up
 * disclosing nothing at all.
 */
export interface AcceptDisclosure {
  task: TaskDetail;
  /** The delivered revision's head sha (task file), or null before delivery. */
  workRevisionSha: string | null;
  /** R17-2: a verified no-change completion — the branch is empty, no PR. */
  noChanges: boolean;
  /** The merge target — the project's default branch. */
  defaultBranch: string;
}

/** Which control the human actually pressed. Named in the dialog, because the
 *  merge is the same irreversible act whether it arrives as a recommendation
 *  the operator wrote or as a decision option on its packet (R15-1 / ruling
 *  53) — and the human needs to recognise the thing they just clicked. */
export type AcceptVia =
  | { kind: "recommendation"; title: string }
  | { kind: "decision"; title: string }
  /** F19-22: the Current-state Stage dropdown, moved to the terminal stage. The
   *  server has always routed a human's manual move into the terminal stage
   *  through the FULL acceptance contract (`transitionStage` calls
   *  `acceptCompletion`), so this menu item has always merged the PR — while
   *  reading like the plain stage change the same menu performs everywhere
   *  else. Ruling 53 fixed exactly this on the board's Move menu; the task
   *  page's own dropdown was the one left. */
  | { kind: "stage" };

interface AcceptDisclosureValue {
  disclosure: AcceptDisclosure;
  /** The refusal a DIRECT `acceptCompletion` would carry past — the loader's
   *  `acceptance.blockedReason`. Every acceptance writer reachable from inside
   *  this subtree (today: applying an `accept_completion` recommendation) runs
   *  that same call with that same `blockedPacket` derivation. */
  blockedReason: string | null;
}

const AcceptDisclosureContext = createContext<AcceptDisclosureValue | null>(
  null,
);

/**
 * Publishes the page's ONE acceptance disclosure to every acceptance surface
 * below it. The recommendation panel sits three components under the page and
 * owns its own fetcher (the pass-16 split), so threading these facts down as
 * props would give each layer the chance to assemble its own version of them —
 * the drift F19-3 is made of. A surface that can reach an acceptance writer
 * reads the facts from here or it does not confirm at all.
 */
export function AcceptDisclosureProvider({
  disclosure,
  blockedReason,
  children,
}: {
  disclosure: AcceptDisclosure;
  blockedReason: string | null;
  children: ReactNode;
}) {
  return (
    <AcceptDisclosureContext.Provider value={{ disclosure, blockedReason }}>
      {children}
    </AcceptDisclosureContext.Provider>
  );
}

/** Read the published disclosure. Throws rather than degrading: a surface that
 *  can merge a PR and has no facts to state must fail loudly at render, never
 *  fall through to an unconfirmed writer (F19-3). */
export function useAcceptDisclosure(): AcceptDisclosureValue {
  const value = useContext(AcceptDisclosureContext);
  if (!value) {
    throw new Error(
      "An acceptance surface must render inside <AcceptDisclosureProvider> — " +
        "accepting a completion merges the pull request, and the confirm has " +
        "nothing to state without the page's disclosure.",
    );
  }
  return value;
}

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
 *
 * F19-3/F19-7: this is the ONLY acceptance confirm on the task page. The
 * Accept button, the admin force-accept, an `accept_completion` recommendation
 * and an `accept_completion` packet option all open this one component with
 * the one `disclosure`, so the five sentences a human reads before a merge are
 * byte-identical whichever control they pressed.
 */
export function AcceptConfirm({
  disclosure,
  /** True when this confirms the audited admin FORCE-accept (DG-2). */
  force = false,
  /** The entry point, when it is not the Current-state Accept button. */
  via,
  /** The refusal this acceptance would carry past (null for a clean accept). */
  blockedReason,
  busy,
  onCancel,
  onConfirm,
}: {
  disclosure: AcceptDisclosure;
  force?: boolean;
  via?: AcceptVia;
  blockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { task, workRevisionSha, noChanges, defaultBranch } = disclosure;
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
              {/* F19-14: the canonical PR-state mapping (ruling 12), the same
                  one the GitHub bar behind this dialog uses. The raw enum
                  member printed "review" where every other surface in the
                  product says "in review", and the hardcoded neutral tone drew
                  a CLOSED, unmerged PR as grey chrome inside the dialog whose
                  button merges it. */}
              {task.pr ? (
                <>
                  <Pill kind={prStatePill(task.pr.state).kind} sm>
                    PR #{task.pr.number} · {prStatePill(task.pr.state).label}
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
          {/* The human clicked "Apply" on a card, or "Confirm decision" on a
              packet — neither word says "merge". Name what they pressed here so
              the dialog is recognisably about THAT control and not a stray
              modal (F19-3 / F19-7). */}
          {via && (
            <div className="obs">
              <span className="k">
                {via.kind === "recommendation"
                  ? "Recommendation"
                  : via.kind === "decision"
                    ? "Decision"
                    : "Stage move"}
              </span>
              <span>
                {via.kind === "stage" ? (
                  <>
                    Moving this task into <strong>{terminalName}</strong> is an
                    acceptance, not a plain stage change.
                  </>
                ) : (
                  <>“{via.title}” — confirming it accepts the completion.</>
                )}
              </span>
            </div>
          )}
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
