import { useEffect, useRef } from "react";
import { useFetcher, type FetcherWithComponents } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { useToast } from "~/ui/toast";

/**
 * Fetcher wrapper for org-settings actions: injects the CSRF token, posts
 * to the org-settings route, and (by default) toasts server-computed copy
 * — success `toast` or failure `error` (phase-5 pattern). Modals pass
 * `onResult` for custom handling (inline `.cred-warn`, close-on-success).
 */

/**
 * What the org-settings action hands back on success. `toast` is the
 * server-computed copy the default handler pushes; the credential pair is the
 * one payload a panel reads beyond it — `user-invite` and `user-reset-password`
 * mint a local password that is shown ONCE, so the account it belongs to rides
 * along with it.
 */
export interface OrgActionSuccess {
  ok: true;
  toast?: string;
  tempPassword?: string;
  email?: string;
}

export type OrgActionData = OrgActionSuccess | { ok: false; error: string };

export const ORG_SETTINGS_ACTION = "/org/settings";

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
  const handled = useRef<unknown>(null);
  const onResultRef = useRef(options?.onResult);
  useEffect(() => {
    onResultRef.current = options?.onResult;
  });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (onResultRef.current) {
      onResultRef.current(d);
      return;
    }
    if (d.ok) {
      if (d.toast) push(d.toast);
    } else if (d.error) {
      // P13-D-10: the second shared toast helper — a failure must not render
      // the success tick (see `ToastKind`, app/ui/toast.tsx).
      push(d.error, "error");
    }
  }, [fetcher.state, fetcher.data, push]);

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
