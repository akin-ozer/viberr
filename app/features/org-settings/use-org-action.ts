import { useFetcher, type FetcherWithComponents } from "react-router";
import type { BoardImportPreview } from "~/server/org/board-import.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/**
 * Fetcher wrapper for org-settings actions: injects the CSRF token, posts
 * to the org-settings route, and (by default) toasts server-computed copy
 * — success `toast` or failure `error` (phase-5 pattern). Modals pass
 * `onResult` for custom handling (inline `.form-err`, close-on-success).
 */

/**
 * What the org-settings action hands back on success. `toast` is the
 * server-computed copy the default handler pushes; the rest are per-intent
 * payloads a panel reads beyond it. The credential pair: `invite-local` and
 * `user-reset-password` mint a local password that is shown ONCE, and
 * `invite-local` returns the new account's `email` with it (a reset is pressed
 * in that account's own edit modal, which already knows it).
 */
export interface OrgActionSuccess {
  ok: true;
  toast?: string;
  tempPassword?: string;
  email?: string;
  /** `mcp-oauth-start` (ruling 469): the authorization URL the admin opens,
   *  and the host of the server that asks. */
  authorizeUrl?: string;
  issuer?: string;
  /** `board-import-preview` (ruling 653): what importing the file would do. */
  boardImport?: BoardImportPreview;
  /** `board-import` (ruling 653): the new project, and what its repository
   *  probe found. */
  slug?: string;
  repoWarning?: string;
  repoNote?: string;
}

/** A refusal names the form field it is about when it is about one
 *  (`appErrorResponse`, ruling 514). */
export type OrgActionData = OrgActionSuccess | { ok: false; error: string; field?: string };

const ORG_SETTINGS_ACTION = "/org/settings";

export interface OrgAction {
  fetcher: FetcherWithComponents<OrgActionData>;
  submit: (fields: Record<string, string>) => void;
  busy: boolean;
}

export function useOrgAction(options?: {
  onResult?: (data: OrgActionData) => void;
}): OrgAction {
  const fetcher = useFetcher<OrgActionData>();
  const csrf = useCsrfToken();
  const push = useToast();
  useFetcherResult(fetcher, (d) => {
    if (options?.onResult) {
      options.onResult(d);
      return;
    }
    if (d.ok) {
      if (d.toast) push(d.toast);
    } else if (d.error) {
      // P13-D-10: the second shared toast helper — a failure must not render
      // the success tick (see `ToastKind`, app/ui/toast.tsx).
      push(d.error, "error");
    }
  });

  return {
    fetcher,
    submit: (fields) =>
      fetcher.submit(
        { _csrf: csrf, ...fields },
        { method: "post", action: ORG_SETTINGS_ACTION },
      ),
    busy: fetcher.state !== "idle",
  };
}
