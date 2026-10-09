import { useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { useActionToast, type ActionResult } from "~/ui/use-action-toast";

/** The file a person takes off a task's record (ruling 80), posted to the
 *  route of the task that holds it. */
export interface RemoveTarget {
  name: string;
  action: string;
}

/**
 * Ruling 80: the confirm before a project admin takes a file off a task's
 * record, and the one fetcher that sends it. The attachment viewer's provider
 * holds it, which stays mounted, so the answer lands after the dialog has gone.
 * Ruling 133 gave a comment's words to the operator; no person removes them.
 */
export function useRemoveFromRecord(): [ask: (target: RemoveTarget) => void, dialog: ReactNode] {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  const csrf = useCsrfToken();
  const [target, setTarget] = useState<RemoveTarget | null>(null);
  const [reason, setReason] = useState("");
  if (!target) return [setTarget, null];
  const dialog = (
    <ConfirmDialog
      screenLabel="Remove file dialog"
      title={`Remove ${target.name}?`}
      body="No agent or person can open it again. A timeline note says who removed it and why."
      confirmLabel="Remove file"
      cancelLabel="Keep it"
      busy={fetcher.state !== "idle"}
      onCancel={() => {
        setTarget(null);
        setReason("");
      }}
      onConfirm={() => {
        const body = new FormData();
        body.set("_csrf", csrf);
        body.set("intent", "remove-attachment");
        body.set("name", target.name);
        if (reason.trim()) body.set("reason", reason.trim());
        fetcher.submit(body, { method: "post", action: target.action });
      }}
    >
      <label className="field confirm-reason">
        <span className="flabel">Why (optional)</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
    </ConfirmDialog>
  );
  return [setTarget, dialog];
}
