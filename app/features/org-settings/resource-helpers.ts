import { useState } from "react";
import { formatRelative } from "~/shared/dates/format";
import { isMcpHealthStale } from "~/shared/freshness";
import { useToast } from "~/ui/toast";
import { useOrgAction, type OrgAction, type OrgActionData } from "./use-org-action";

/**
 * Shared plumbing for the Agent-resources surface, split out of
 * `resources-panel.tsx` (pass 16 — the file was 1471 lines and the single most
 * likely place for concurrent UI work to collide). Behaviour is unchanged;
 * these are the pieces the modals and the row panels both need.
 */

export function rel(iso: string | null): string {
  return iso ? formatRelative(iso) : "never";
}

/** P13-D-32: the "older than an hour reads as STALE" rule is interpretation,
 * which `architecture.md` forbids a UI component from owning — it now lives in
 * the shared freshness policy (server door:
 * `server/interpretation/freshness-policy.server.ts`) next to the identical
 * rule the GitHub reconcile chip applies. */
export const isStaleCheck = isMcpHealthStale;

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
