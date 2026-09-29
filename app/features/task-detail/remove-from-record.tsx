import { useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { useActionToast, type ActionResult } from "~/ui/use-action-toast";

/** What a person takes off a task's record (ruling 582): a file, posted to the
 *  route of the task that holds it, or a comment on this task, by its time. */
export type RemoveTarget = { name: string; action: string } | { at: string };

/**
 * Ruling 582: the confirm before a project admin takes a file, or a comment's
 * words, off a task's record, and the one fetcher that sends it. The part of
 * the page that stays mounted holds it (the attachment viewer's provider, the
 * timeline), so the answer lands after the dialog has gone.
 */
export function useRemoveFromRecord(): [ask: (target: RemoveTarget) => void, dialog: ReactNode] {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  const csrf = useCsrfToken();
  const [target, setTarget] = useState<RemoveTarget | null>(null);
  const [reason, setReason] = useState("");
  if (!target) return [setTarget, null];
  const file = "name" in target;
  const dialog = (
    <ConfirmDialog
      screenLabel={file ? "Remove file dialog" : "Remove comment dialog"}
      title={file ? `Remove ${target.name}?` : "Remove this comment's words?"}
      body={
        file
          ? "No agent or person can open it again. A timeline note says who removed it and why."
          : "Its words leave the task and its notifications. The entry keeps its author, time and files, and says who removed its words and why."
      }
      confirmLabel={file ? "Remove file" : "Remove words"}
      cancelLabel="Keep it"
      busy={fetcher.state !== "idle"}
      onCancel={() => {
        setTarget(null);
        setReason("");
      }}
      onConfirm={() => {
        const body = new FormData();
        body.set("_csrf", csrf);
        if (file) {
          body.set("intent", "remove-attachment");
          body.set("name", target.name);
        } else {
          body.set("intent", "remove-comment");
          body.set("at", target.at);
        }
        if (reason.trim()) body.set("reason", reason.trim());
        fetcher.submit(body, file ? { method: "post", action: target.action } : { method: "post" });
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
