import { useState } from "react";
import { useToast } from "~/ui/toast";
import { useOrgAction, type OrgAction, type OrgActionData } from "./use-org-action";

/**
 * Shared plumbing for the Agent-resources surface, split out of
 * `resources-panel.tsx` (pass 16 — the file was 1471 lines and the single most
 * likely place for concurrent UI work to collide). Behaviour is unchanged;
 * these are the pieces the modals and the row panels both need.
 */

/** Shared modal-close-with-inline-error fetcher wiring. */
export function useModalAction(onDone: (d: OrgActionData & { ok: true }) => void) {
  const [err, setErr] = useState<string | null>(null);
  const push = useToast();
  const action = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      onDone(d);
    },
  });
  return { action, err, setErr };
}

/** Busy-row tracking for spin icons (re-index / test connection). */
export function useBusyRow(action: OrgAction): [string | null, (id: string) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const settled = action.fetcher.state === "idle" && Boolean(action.fetcher.data);
  return [settled ? null : busyId, setBusyId];
}
