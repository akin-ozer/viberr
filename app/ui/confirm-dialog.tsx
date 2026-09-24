import type { ReactNode } from "react";
import { Icon, type IconName } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * D6 — the shared consequence-confirm.
 *
 * The product's confirmation coverage was uneven rather than tiered: accept,
 * force-accept, archive, delete-project and remove-org-resource each carried a
 * ceremony, while removing a person or a stage, cancelling a queued re-run,
 * dismissing a recommendation and interrupting a live run were all one silent
 * click. The hand-written ceremonies (`ArchiveConfirm`, `ReleaseConfirm`,
 * `AcceptConfirm`) share an excellent shape — a `.confirm-card` / `.modal-card`
 * `role="alertdialog"`, an outcome-naming confirm button and an opt-out phrased
 * as a decision. This is the *light* member of that family for the single-line
 * "are you sure" confirms that do not need labelled observation rows: one home,
 * one grammar, an outcome-naming `confirmLabel` (never a bare "Remove"), reusing
 * the existing `.confirm-card` chrome and `useDialog` behaviors (Escape,
 * backdrop-click close, focus trap, focus restore). `org-settings`' `ConfirmDelete`
 * delegates here (C6); the D6 sites render it directly.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  icon = "alert",
  busy = false,
  screenLabel,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  body: ReactNode;
  /** Ruling 419(c): a field the decision carries, such as the optional reason a
   *  goal cancel records on the chain's history. Rendered under the body, so
   *  the consequence is read before anything is typed. */
  children?: ReactNode;
  /** Names the outcome, the way the hand-written dialogs do ("Remove stage",
   *  "Interrupt run") — never a bare verb the reader has to pair with the head. */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  icon?: IconName;
  /** Disables the confirm while its mutation is in flight (double-submit guard). */
  busy?: boolean;
  /** Pass-33 D33-2: the `data-screen-label` every other dialog in the product
   *  carries. `docs/ui/surfaces.md §4` states the contract as universal — "Every
   *  top-level surface and dialog carries `data-screen-label` so tests and agents
   *  can address it by name" — and this shared confirm, which backs the stage
   *  removal, the schedule cancel, the resource and credential deletions and the
   *  project delete, was the one family with no name. Required, so a new call
   *  site cannot quietly rejoin the gap. */
  screenLabel: string;
  /** Unmounts the dialog: after Cancel, and after a confirm's exit too. */
  onCancel: () => void;
  /** The mutation only. The dialog closes itself afterwards (ruling 459). */
  onConfirm: () => void;
}) {
  // Ruling 459: the confirm leaves the way Cancel does. `commit` runs
  // onConfirm, then the animated close, which calls onCancel to unmount, so a
  // caller's onConfirm does not clear its own state (onCancel does that).
  const { ref, close, commit } = useDialog(onCancel);
  return (
    // role="alertdialog" on a native <dialog> keeps the stronger semantics.
    <dialog
      ref={ref}
      className="confirm-card"
      role="alertdialog"
      aria-label={title}
      data-screen-label={screenLabel}
    >
      {/* Interface review 2026-09-24 (colo-7): the icon wash follows the tone —
          the coral danger wash above a blue primary commit said "destructive"
          about a decision that takes nothing away. */}
      <div className={"confirm-icon " + tone}>
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {children}
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={"btn " + tone}
          disabled={busy}
          aria-disabled={busy}
          onClick={() => commit(onConfirm)}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
