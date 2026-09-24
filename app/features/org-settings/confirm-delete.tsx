import { ConfirmDialog } from "~/ui/confirm-dialog";

/**
 * The org-settings removal confirm. It lives apart from `mini-modal.tsx`
 * because the profile page imports `MiniModal` and never this: while they
 * shared a module, /profile also loaded the shared `ConfirmDialog` this builds
 * on, which it never renders (ruling 457: bytes a closure ships and never
 * runs).
 */
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
