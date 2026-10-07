import type { ReactNode } from "react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { Icon, type IconName } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import type { PacketArchiveDisclosure } from "./decision-packet";
import { archiveCeremonyCopy } from "./decision-packet-derive";

/**
 * The decision packet card's three ask-first ceremonies (ruling 689(e), the
 * split of `decision-packet.tsx` along the task-page recipe): archive (with or
 * without the remote branch), discard the local branch, and clear a branch
 * collision. The card draws the one whose kind the pending option is, in the
 * slot it always held, so at most one stands. The shared shell keeps the
 * `useDialog` it always owned.
 */

type PacketOption = PacketRender["options"][number];

/** What every ceremony is handed: the pending option, and the card's busy
 *  flag and exits. */
interface CeremonyProps {
  option: PacketOption;
  /** UX19-9: what the resolution destroys, when the page wired it. */
  disclosure: PacketArchiveDisclosure | undefined;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The shell the three ask-first ceremonies below share: an `alertdialog` with a
 * warn glyph and a close, a `packet-obs flush` body of what-happens rows, and a
 * foot of "Not yet" beside one danger commit.
 *
 * Rulings 20 (R15-1) and 53 (R18-7) hold every one-way write to ONE ceremony,
 * and the three that live on this card were three shell-for-shell copies of it:
 * a change to the shared half (the close affordance, the foot layout, the
 * alertdialog contract) landed on whichever copy was open at the time. Each
 * ceremony now supplies only what makes it different — its subject, its rows and
 * its wording — and the standard itself lives here once.
 */
function PacketDestructiveConfirm({
  ariaLabel,
  screenLabel,
  icon,
  heading,
  subhead,
  footHint,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  /** Accessible name of the dialog. */
  ariaLabel: string;
  /** `data-screen-label` — the handle the co-located tests select the dialog by. */
  screenLabel: string;
  /** Head glyph AND commit-button icon: one destructiveness cue, stated once. */
  icon: IconName;
  heading: string;
  /** Under the heading: the option title, sometimes prefixed with the task key. */
  subhead: ReactNode;
  footHint: string;
  /** The commit button's visible label, which must name the outcome. */
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** The `.obs` rows stating what this resolution does and does not touch. */
  children: ReactNode;
}) {
  // Ruling 459: the commit leaves the way Cancel does (`commit`); onCancel
  // unmounts it after the exit.
  const { ref: panelRef, close, commit } = useDialog(onCancel);
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={ariaLabel}
      data-screen-label={screenLabel}
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg warn">
          <Icon name={icon} />
        </span>
        <div className="mh-main">
          <h2>{heading}</h2>
          <div className="mh-sub">{subhead}</div>
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
        <div className="packet-obs flush">{children}</div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">{footHint}</span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Not yet
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => commit(onConfirm)}
          >
            <Icon name={icon} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
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
 * It is a local dialog rather than a second shared `AcceptConfirm`-style
 * ceremony (accept-confirm.tsx — F31-C8: an earlier revision of this comment
 * named an `AcceptDisclosureProvider` context that never shipped): the shared
 * ceremony exists because FOUR surfaces can reach `acceptCompletion` and were
 * drifting apart (F19-3/F19-7). Ruling 17 gives branch deletion exactly one
 * surface — this card — so there is nothing to keep in sync. It still wears the
 * `PacketDestructiveConfirm` shell above; local means "not routed through
 * accept-confirm.tsx", not "its own copy of the ceremony".
 *
 * Absent a disclosure (the page has not wired it), the dialog names the branch
 * generically and states no withdrawal it cannot verify (`archiveCeremonyCopy`).
 */
export function PacketArchiveConfirm({
  option,
  packetTitle,
  disclosure,
  busy,
  onCancel,
  onConfirm,
}: CeremonyProps & { packetTitle: string }) {
  const copy = archiveCeremonyCopy(option, packetTitle, disclosure);
  const { deletesBranch, branch, subject } = copy;
  return (
    <PacketDestructiveConfirm
      ariaLabel={copy.ariaLabel}
      screenLabel="Packet archive dialog"
      icon={copy.icon}
      heading={copy.heading}
      subhead={
        <>
          {disclosure ? (
            <>
              <span className="key">{disclosure.taskKey}</span> ·{" "}
            </>
          ) : null}
          {option.t}
        </>
      }
      footHint={copy.footHint}
      confirmLabel={copy.confirmLabel}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {/* The human pressed "Confirm decision" — a label that names no
          outcome. Say which decision option this dialog is about, the way
          the acceptance dialog names its own entry point (F19-7). */}
      <div className="obs">
        <span className="k">Decision</span>
        <span>Confirming “{option.t}” archives {subject}.</span>
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
            {disclosure?.foreignHead ? (
              <ForeignHeadClause branch={branch} foreignHead={disclosure.foreignHead} />
            ) : null}
            <strong>Deleting it cannot be undone.</strong> Restoring the task
            later does not bring the branch back.
          </span>
        </div>
      )}
      {/* C3 (pass 34, U34-8): this dialog reaches the same server refusal the
          collision ceremony does, and used to only INFER that no PR stands
          (from the operator's authoring rule). It says it outright now. */}
      {deletesBranch && <OpenPrRow openPr={disclosure?.openPr ?? null} ceremony="archive" />}
      <div className="obs">
        <span className="k">After</span>
        <span>
          Off the board and out of the review queue. The task file, its
          timeline and its audit trail are kept exactly as they are. The
          archive itself is a disposition, not a delete, and a maintainer can
          restore it.
        </span>
      </div>
      <div className="obs">
        <span className="k">Withdrawn</span>
        <span>
          {copy.withdrawn.join(" and ")}. Restoring brings the task back to a human; run the operator to reopen the decision.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}

/**
 * Ruling 161 (pass 35, U35-8): origin's copy of the branch carries commits this
 * task did not author (`PacketArchiveDisclosure.foreignHead`), and the
 * delete-branch dialog says so before the button, with the head sha and the
 * pull request standing on it when either is known. Only while a foreign
 * head is recorded.
 */
function ForeignHeadClause({
  branch,
  foreignHead,
}: {
  branch: string | null;
  foreignHead: NonNullable<PacketArchiveDisclosure["foreignHead"]>;
}) {
  return (
    <>
      Origin&rsquo;s{" "}
      <span className="mono">{branch ?? "branch"}</span> carries
      commits this task did not author
      {foreignHead.sha ? (
        <>
          {" "}
          (head{" "}
          <span className="mono">
            {foreignHead.sha.slice(0, 7)}
          </span>
          {foreignHead.prNumber !== null ? (
            <>
              , pull request{" "}
              <span className="mono">
                #{foreignHead.prNumber}
              </span>{" "}
              stands on it
            </>
          ) : null}
          )
        </>
      ) : foreignHead.prNumber !== null ? (
        <>
          {" "}
          (pull request{" "}
          <span className="mono">#{foreignHead.prNumber}</span>{" "}
          stands on it)
        </>
      ) : null}
      ; deleting it removes them too.{" "}
    </>
  );
}

/**
 * F20-6 (R20-2) — a `discard_branch` packet option deletes the task's LOCAL,
 * never-pushed workspace branch. It destroys commits, so it asks first, exactly
 * like its `archive_task` sibling above — but with a narrower promise: nothing
 * on GitHub changes (resolution refuses the moment the branch exists on the
 * remote, ruling 17). A local dialog for the same reason `PacketArchiveConfirm`
 * is one: this is the only surface that offers the discard.
 */
export function PacketDiscardConfirm({
  option,
  disclosure,
  busy,
  onCancel,
  onConfirm,
}: CeremonyProps) {
  // The task's workspace branch (`task.branch`), named when the page wired it.
  const branch = disclosure?.branch ?? null;
  return (
    <PacketDestructiveConfirm
      ariaLabel="Discard this task's workspace branch"
      screenLabel="Packet discard dialog"
      icon="alert"
      heading="Discard this task’s workspace branch?"
      subhead={option.t}
      footHint="Recorded as a timeline note and an audit row."
      confirmLabel={branch ? `Discard ${branch}` : "Discard the branch"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="obs">
        <span className="k">Decision</span>
        <span>Confirming &ldquo;{option.t}&rdquo; discards the branch.</span>
      </div>
      <div className="obs warn">
        <span className="k">Deletes</span>
        <span>
          The <strong>local</strong> workspace branch{" "}
          {branch ? (
            <span className="mono">{branch}</span>
          ) : (
            <>for this task</>
          )}{" "}
          and every commit that exists only there.{" "}
          <strong>This cannot be undone.</strong>
        </span>
      </div>
      <div className="obs">
        <span className="k">GitHub</span>
        <span>
          Nothing on GitHub changes: this branch was never pushed. (If it had
          been, the discard is refused and the archive option is the path.)
        </span>
      </div>
      {/* Ruling 161: a reported revision that never left the workspace goes
          with the branch. Its verdicts stay as history, and nothing is under
          review afterwards. */}
      <div className="obs">
        <span className="k">Review</span>
        <span>
          A revision the agent reported on this branch is retired with it: its
          verdicts stay on the record as history, and the task has no revision
          under review until an agent delivers again.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}

/**
 * C3 (pass 34, U34-8): what this task's OWN open pull request means for the
 * ceremony about to run, said BEFORE the button rather than after the click.
 * The two ceremonies reach different server rules, so they say different
 * things (pass 34 review found one sentence used for both, and it was wrong
 * on each): an ARCHIVE still archives and only keeps the branch, and a
 * COLLISION resolution is not a deletion at all under ruling 136(b) — it
 * pushes the delivered revision to that PR.
 */
function OpenPrRow({
  openPr,
  ceremony,
}: {
  openPr: number | null;
  ceremony: "archive" | "collision";
}) {
  if (openPr === null) return null;
  const pr = <span className="mono">#{openPr}</span>;
  return (
    <div className="obs warn" data-open-pr-warning="">
      <span className="k">
        {ceremony === "archive" ? "Branch kept" : "No deletion"}
      </span>
      {ceremony === "archive" ? (
        <span>
          This task&rsquo;s own pull request {pr} is still open, and Viberr never
          deletes a branch a pull request is open on. The task is still archived;
          the branch and {pr} stay exactly as they are. Merge or close {pr} on
          GitHub first if you want the branch gone too.
        </span>
      ) : (
        <span>
          The pull request on this branch, {pr}, is this task&rsquo;s OWN review
          pull request, so there is no stranger to clear: nothing is deleted and
          nothing is closed. Confirming pushes this task&rsquo;s delivered
          revision to {pr} and lifts the block; if the remote has diverged from
          it, the block stays and a person reconciles the history.
        </span>
      )}
    </div>
  );
}

/**
 * F31-6 — a `resolve_remote_collision` option asks first, like its destructive
 * siblings: it deletes a REMOTE ref (the stale branch squatting on this task's
 * branch name) and closes the unrelated PR recorded on it, then re-delivers
 * the task's local work. The rows spell out what is removed and — as
 * important — what is KEPT, because this ceremony exists to be the truthful
 * opposite of `discard_branch` (the local delivery survives).
 */
export function PacketCollisionConfirm({
  option,
  disclosure,
  busy,
  onCancel,
  onConfirm,
}: CeremonyProps) {
  // The task's branch name (`task.branch`), the ref being reclaimed.
  const branch = disclosure?.branch ?? null;
  // The unrelated PR recorded on that branch (R15-15), when known.
  const unownedPr = disclosure?.unownedPr ?? null;
  // C3: this task's own open PR, which refuses the deletion.
  const openPr = disclosure?.openPr ?? null;
  const branchLabel = branch ? (
    <span className="mono">{branch}</span>
  ) : (
    <>this task&rsquo;s branch</>
  );
  // C3 (pass 34, U34-8): with NO unowned PR recorded there is no stranger —
  // `resolveRemoteBranchCollision` deletes THIS task's own remote branch and
  // closes nothing. Describing that as "the unrelated one squatting on this
  // task's branch name" asked a person to confirm the deletion of their own
  // pushed branch under somebody else's description.
  const stranger = unownedPr !== null;
  return (
    <PacketDestructiveConfirm
      ariaLabel={
        stranger
          ? "Clear this task's branch collision"
          : "Delete this task's remote branch and redeliver"
      }
      screenLabel="Packet collision dialog"
      icon="alert"
      heading={stranger ? "Clear the branch collision?" : "Delete this task's remote branch?"}
      subhead={option.t}
      footHint="Recorded as timeline events and audit rows."
      confirmLabel={stranger ? "Clear collision & redeliver" : "Delete branch & redeliver"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="obs">
        <span className="k">Decision</span>
        <span>
          Confirming &ldquo;{option.t}&rdquo;{" "}
          {stranger
            ? "reclaims the branch name for this task."
            : "removes this task's own remote branch and pushes its local work again."}
        </span>
      </div>
      <div className="obs warn">
        <span className="k">Deletes</span>
        {stranger ? (
          <span>
            The stale branch {branchLabel} on GitHub, the unrelated one squatting
            on this task&rsquo;s branch name, and closes its pull request{" "}
            <span className="mono">#{unownedPr}</span>.{" "}
            <strong>Deleting the remote branch cannot be undone.</strong>
          </span>
        ) : (
          <span>
            This task&rsquo;s own remote branch {branchLabel} on GitHub. No
            unrelated pull request is recorded on it, so nothing of anyone
            else&rsquo;s is touched and no pull request is closed.{" "}
            <strong>Deleting the remote branch cannot be undone.</strong>
          </span>
        )}
      </div>
      <OpenPrRow openPr={openPr} ceremony="collision" />
      <div className="obs">
        <span className="k">Keeps</span>
        <span>
          This task&rsquo;s local delivery. After the {stranger ? "stale " : ""}
          ref is gone it is pushed fresh and the real review PR opens.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}
