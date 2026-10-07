import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { StageColor } from "~/shared/workflow/stage-colors";
import { inFlightIntent } from "~/ui/in-flight";
import { useActionToast } from "~/ui/use-action-toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useRefusalShake } from "~/ui/use-refusal-shake";
import type { MembershipView } from "./membership.server";

/**
 * The project settings page's posts (ruling 695(e), the split of
 * `settings-page.tsx` along the task-page recipe), each with its fetcher and
 * its toast: the identity, the stage editor, the members, the repository, the
 * credential, the danger zone and the three whole-list saves. The page calls
 * them in the order its nine fetchers always registered, so each fetcher keeps
 * its key. Beside them, the Change repository dialog's form. No component
 * lives here, so the module is not a Fast Refresh boundary.
 */

/** A settings action's answer; an added stage names itself. */
export type ActionResult =
  | { ok: true; toast: string; stageId?: string }
  | { ok: false; error: string };

/** Project identity: the Project panel's Save. */
export function useIdentityPost(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    busy: fetcher.state !== "idle",
    save: (fields: { name: string; prefix: string; description: string }) =>
      fetcher.submit(
        { intent: "save-project", _csrf: csrf, ...fields },
        { method: "post" },
      ),
  };
}

/**
 * The stage editor's five posts, and the row in rename. Stage rename
 * edit-mode lives here, beside the fetcher, so a fresh add-stage response can
 * drop the new row straight into edit mode (mock behavior).
 */
export function useStageEditor(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  const [editingId, setEditingId] = useState<string | null>(null);
  useFetcherResult(fetcher, (d) => {
    if (d.ok && d.stageId) {
      setEditingId(d.stageId);
    }
  });
  return {
    editingId,
    setEditingId,
    rename: (stageId: string, name: string) =>
      fetcher.submit(
        { intent: "rename-stage", _csrf: csrf, stageId, name },
        { method: "post" },
      ),
    reorder: (orderedIds: string[]) =>
      fetcher.submit(
        {
          intent: "reorder-stages",
          _csrf: csrf,
          orderedIds: orderedIds.join(","),
        },
        { method: "post" },
      ),
    add: (name: string) =>
      fetcher.submit(
        { intent: "add-stage", _csrf: csrf, name },
        { method: "post" },
      ),
    remove: (stageId: string) =>
      fetcher.submit(
        { intent: "remove-stage", _csrf: csrf, stageId },
        { method: "post" },
      ),
    recolor: (stageId: string, color: StageColor) =>
      fetcher.submit(
        { intent: "recolor-stage", _csrf: csrf, stageId, color },
        { method: "post" },
      ),
  };
}

/** Membership: the invite and the removal, and whose removal is in flight. */
export function useMemberPosts(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    busy: fetcher.state !== "idle",
    removing:
      inFlightIntent(fetcher) === "remove-member"
        ? String(fetcher.formData?.get("userId") ?? "")
        : null,
    invite: (name: string, email: string) =>
      fetcher.submit(
        { intent: "invite", _csrf: csrf, name, email },
        { method: "post" },
      ),
    remove: (member: MembershipView) =>
      fetcher.submit(
        { intent: "remove-member", _csrf: csrf, userId: member.userId },
        { method: "post" },
      ),
  };
}

/**
 * The repository fetcher: the change, the removal, branch cleanup and the
 * scope re-check. Its answer is handed to the Repository panel, which closes
 * the Change dialog only on its own change's ok.
 */
export function useRepoPosts(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    busy: fetcher.state !== "idle",
    inFlight: inFlightIntent(fetcher),
    result: fetcher.data,
    change: (repoInput: string, confirmFootprint: boolean) => {
      const fields = {
        intent: "change-repo",
        _csrf: csrf,
        repo: repoInput,
      };
      // Only a confirmed change carries the field: the route reads it
      // as `confirmFootprint === "1"`, so it is sent or absent, never
      // blank.
      fetcher.submit(
        confirmFootprint ? { ...fields, confirmFootprint: "1" } : fields,
        { method: "post" },
      );
    },
    remove: () =>
      fetcher.submit({ intent: "remove-repo", _csrf: csrf }, { method: "post" }),
    setBranchCleanup: (enabled: boolean) =>
      fetcher.submit(
        {
          intent: "set-branch-cleanup",
          _csrf: csrf,
          enabled: enabled ? "1" : "0",
        },
        { method: "post" },
      ),
    grantScope: () =>
      fetcher.submit(
        { intent: "grant-scope", _csrf: csrf },
        { method: "post" },
      ),
  };
}

/** The credential fetcher: attach / re-attach and remove. */
export function useCredentialPosts(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    inFlight: inFlightIntent(fetcher),
    set: () =>
      fetcher.submit(
        { intent: "set-credential", _csrf: csrf },
        { method: "post" },
      ),
    clear: () =>
      fetcher.submit(
        { intent: "clear-credential", _csrf: csrf },
        { method: "post" },
      ),
  };
}

/** The danger zone: archive (or restore) and delete. */
export function useDangerPosts(csrf: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    busy: fetcher.state !== "idle",
    inFlight: inFlightIntent(fetcher),
    archive: (archived: boolean) =>
      fetcher.submit(
        { intent: "archive-project", _csrf: csrf, archived: String(archived) },
        { method: "post" },
      ),
    deleteProject: (confirmName: string) =>
      fetcher.submit(
        { intent: "delete-project", _csrf: csrf, confirmName },
        { method: "post" },
      ),
  };
}

/**
 * A panel that saves its whole list through one intent (the required
 * reviewers, the file leases, the gates): the rows travel as JSON in one
 * field, and the answer toasts like every other panel's.
 */
export function useListSave<Row>(csrf: string, intent: string, field: string) {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  return {
    busy: fetcher.state !== "idle",
    save: (rows: Row[]) =>
      fetcher.submit(
        {
          intent,
          _csrf: csrf,
          [field]: JSON.stringify(rows),
        },
        { method: "post" },
      ),
  };
}

/**
 * The Change repository dialog's form: the typed repository, the footprint
 * acknowledgement, what is still missing, the refusal count and the submit.
 * The dialog plays its exit once its change landed (`done`, ruling 459).
 */
export function useChangeRepoForm({
  footprintTasks,
  busy,
  result,
  done,
  onCancel,
  onSubmit,
}: {
  footprintTasks: number;
  busy: boolean;
  result: { ok: boolean; error?: string } | undefined;
  done: boolean;
  onCancel: () => void;
  onSubmit: (repo: string, confirmFootprint: boolean) => void;
}) {
  const { ref, close } = useDialog(onCancel);
  useEffect(() => {
    if (done) close();
  }, [done, close]);
  const [repo, setRepo] = useState("");
  const [ack, setAck] = useState(false);
  const [sent, setSent] = useState(false);
  const repoRef = useRef<HTMLInputElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  // Ruling 147: the primary stays enabled; a refused submit names what is
  // missing, marks it and moves focus there. Counted so each refusal
  // re-inserts the alert.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const missing: "repo" | "ack" | null =
    repo.trim().length <= 2 ? "repo" : footprintTasks > 0 && !ack ? "ack" : null;
  const error = sent && !busy && result && !result.ok ? result.error : null;
  const submit = () => {
    if (busy || done) return;
    if (missing) {
      setRefused((n) => n + 1);
      (missing === "repo" ? repoRef : ackRef).current?.focus();
      return;
    }
    setSent(true);
    onSubmit(repo, ack);
  };
  const flagged = refused > 0 ? missing : null;
  return {
    ref,
    close,
    repo,
    setRepo,
    ack,
    setAck,
    repoRef,
    ackRef,
    refused,
    refusalShake,
    error,
    flagged,
    submit,
  };
}
