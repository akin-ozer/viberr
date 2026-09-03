import type { ReactNode } from "react";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * Shared dialog chrome for every org-settings create/edit modal
 * (org-settings spec §4.5) + the destructive confirm, on a native <dialog>.
 * Ruling 16 / spec §7.6 behaviors — Escape, focus trap, focus restore,
 * backdrop-click close — come from showModal() + useDialog; the save button
 * is REALLY disabled (visuals kept: 0.55 opacity).
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
  unmetHint,
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
  /** UXA-9: what is still missing while `canSave` is false. */
  unmetHint?: string;
  children: ReactNode;
  screen?: string;
}) {
  const { ref, close } = useDialog(onClose);
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
          <span className="fine xs dim">
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
            onClick={onSave}
            disabled={!canSave}
            aria-disabled={!canSave}
            style={!canSave ? { opacity: 0.55 } : undefined}
          >
            {saveLabel}
          </button>
        </span>
      </div>
    </dialog>
  );
}

export function ConfirmDelete({
  what,
  detail,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  what: string;
  detail: string;
  /** C6: the confirm button named a bare "Remove" — the only destructive
   *  guardrail in org-settings whose button did not name what it removes,
   *  against the hand-written ceremonies that say "Archive VIB-4". Each caller
   *  now passes the outcome ("Remove MCP server"); the blast radius stays in
   *  `detail` (resources-panel already counts the grants that drop). */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Delegates to the shared consequence-confirm (D6) so org-settings and the
  // task/project confirmation sites share one grammar and one chrome.
  return (
    <ConfirmDialog
      screenLabel="Resource removal dialog"
      title={`Remove ${what}?`}
      body={detail}
      confirmLabel={confirmLabel ?? `Remove ${what}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
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
