import type { ReactNode } from "react";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * Shared dialog chrome for every org-settings create/edit modal
 * (org-settings spec §4.5, markup verbatim) + the destructive confirm.
 * Port upgrades per ruling 16 / spec §7.6: Escape + focus trap + focus
 * restore via useDialog, scrim click closes, and the save button is REALLY
 * disabled (visuals kept: 0.55 opacity).
 */

export function MiniModal({
  icon,
  title,
  sub,
  onClose,
  canSave,
  saveLabel,
  onSave,
  footHint,
  children,
  screen,
}: {
  icon: ReactNode;
  title: string;
  sub?: string;
  onClose: () => void;
  canSave: boolean;
  saveLabel: string;
  onSave: () => void;
  footHint?: string;
  children: ReactNode;
  screen?: string;
}) {
  const ref = useDialog(onClose);
  return (
    <>
      <div className="confirm-scrim" onClick={onClose} aria-hidden="true"></div>
      <div
        ref={ref}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-screen-label={screen || title}
      >
        <div className="modal-head">
          <span className="conn-ico" style={{ width: 34, height: 34, borderRadius: 10 }}>
            {icon}
          </span>
          <span className="mh-main">
            <h2>{title}</h2>
            {sub && <div className="mh-sub">{sub}</div>}
          </span>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          {footHint && <span className="foot-hint mono">{footHint}</span>}
          <span className="foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onSave}
              disabled={!canSave}
              aria-disabled={!canSave}
              style={!canSave ? { opacity: 0.55 } : undefined}
            >
              {saveLabel}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

export function ConfirmDelete({
  what,
  detail,
  onCancel,
  onConfirm,
}: {
  what: string;
  detail: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useDialog(onCancel);
  return (
    <>
      <div className="confirm-scrim" onClick={onCancel} aria-hidden="true"></div>
      <div ref={ref} className="confirm-card" role="alertdialog" aria-modal="true" aria-label={`Remove ${what}?`}>
        <div className="confirm-icon">
          <Icon name="alert" />
        </div>
        <h3>Remove {what}?</h3>
        <p>{detail}</p>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Remove
          </button>
        </div>
      </div>
    </>
  );
}

/** Local pencil SVG (org-settings.jsx — not in the shared Icon set). */
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
