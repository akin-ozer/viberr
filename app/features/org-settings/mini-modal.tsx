import { useState, type ReactNode } from "react";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * Shared dialog chrome for every org-settings create/edit modal
 * (org-settings spec §4.5) + the destructive confirm, on a native <dialog>.
 * Ruling 16 / spec §7.6 behaviors — Escape, focus trap, focus restore,
 * backdrop-click close — come from showModal() + useDialog.
 *
 * Ruling 147: the save button stays enabled until the request starts. A save
 * attempted on an incomplete form is REFUSED here: the unmet-requirements
 * line is re-inserted as an alert and focus moves to the first empty control
 * (or wherever the caller's `focusUnmet` says). A hard-disabled primary gave
 * the click no feedback and dropped out of the tab order; `busy` alone
 * disables, painted by the sheet's aria-busy rule.
 */

/** The first empty text-like control inside the dialog, else its first control. */
function firstUnmetControl(dialog: HTMLDialogElement | null): HTMLElement | null {
  if (!dialog) return null;
  const controls = [
    ...dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      ".modal-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), .modal-body textarea:not([disabled]), .modal-body select:not([disabled])",
    ),
  ];
  return controls.find((c) => c.value.trim() === "") ?? controls[0] ?? null;
}

export function MiniModal({
  icon,
  title,
  sub,
  onClose,
  canSave,
  busy = false,
  saveLabel,
  onSave,
  footHint,
  unmetHint,
  focusUnmet,
  children,
  screen,
}: {
  icon: ReactNode;
  title: string;
  sub?: string;
  onClose: () => void;
  /** The form is complete. Validity only: `busy` is its own prop. */
  canSave: boolean;
  /** A save is in flight: the one state that disables the primary. */
  busy?: boolean;
  saveLabel: string;
  onSave: () => void;
  footHint?: string;
  /** UXA-9: what is still missing while `canSave` is false. */
  unmetHint?: string;
  /** Where a refused save puts focus; defaults to the first empty control. */
  focusUnmet?: () => void;
  children: ReactNode;
  screen?: string;
}) {
  const { ref, close } = useDialog(onClose);
  // Counted, not boolean: each refusal re-inserts the alert, because readers
  // announce an alert's insertion, not a role flip on unchanged text.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const save = () => {
    if (busy) return;
    if (!canSave) {
      setRefused((n) => n + 1);
      if (focusUnmet) focusUnmet();
      else firstUnmetControl(ref.current)?.focus();
      return;
    }
    onSave();
  };
  return (
    <dialog
      ref={ref}
      className="modal-card"
      aria-label={title}
      data-screen-label={screen || title}
    >
      <div className="modal-head">
        <span className="conn-ico">
          {icon}
        </span>
        <span className="mh-main">
          <h2>{title}</h2>
          {sub && <div className="mh-sub">{sub}</div>}
        </span>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <div className="modal-foot">
        {footHint && <span className="foot-hint mono">{footHint}</span>}
        {/* UXA-9: the disabled Save dimmed to .55 and said nothing — and a
            disabled control cannot explain itself through `title`, so the
            reader was left hunting for the unmet requirement. Every caller
            marks its required inputs with `*`, so this names the rule they all
            share; `unmetHint` lets a caller be more specific. */}
        {!canSave && (
          <span
            key={refused ? "alert-" + refused : "hint"}
            className={refused ? "foot-hint err" + (refusalShake.shake ? " refused" : "") : "fine xs dim"}
            onAnimationEnd={refused ? refusalShake.onAnimationEnd : undefined}
            role={refused ? "alert" : undefined}
          >
            {unmetHint ?? "Fill the required fields (*) to continue."}
          </span>
        )}
        <span className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {saveLabel}
          </button>
        </span>
      </div>
    </dialog>
  );
}

/** Local pencil SVG (org-settings.jsx). Ruling 458(f) moves it onto the shared
 *  `Icon` / `ICON_PATHS`; the move waits on ruling 457, since `ICON_PATHS`
 *  ships in the shell chunk every page loads (ruling 458's 2026-09-24 note). */
export function EditIco() {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z" />
      <path d="M13.5 7.5l3 3" />
    </svg>
  );
}
