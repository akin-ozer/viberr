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

/**
 * Ruling 479(h): what a global agent profile's stored stage id says beside the
 * default workflow's stages. A template deployed onto a project with its own
 * stages keeps that project's ids (`build` on akinozer.com): the row printed
 * the raw id and the editor offered no chip for it at all, so Content Writer
 * looked eligible nowhere while it worked at `build`. One wording for the row
 * and the editor's chip.
 */
export const STAGE_OUTSIDE_DEFAULT = "not in the default workflow";

/** A stored stage id as the row prints it: the default stage's name, else the
 *  id with the sentence above. */
export function storedStageLabel(
  id: string,
  stages: readonly { id: string; name: string }[],
): string {
  const known = stages.find((s) => s.id === id);
  return known ? known.name : `${id} (${STAGE_OUTSIDE_DEFAULT})`;
}

/** Busy-row tracking for spin icons (re-index / test connection). */
export function useBusyRow(action: OrgAction): [string | null, (id: string) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const settled = action.fetcher.state === "idle" && Boolean(action.fetcher.data);
  return [settled ? null : busyId, setBusyId];
}
