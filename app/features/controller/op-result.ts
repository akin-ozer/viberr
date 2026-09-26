import type { useFetcher } from "react-router";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/** What the controller routes' actions answer. */
export interface ActionResult {
  ok: boolean;
  error?: string;
  toast?: string;
  conversationId?: string;
}

/**
 * Toasts an interrupt or knowledge-base undo result once: the server's
 * `toast` (tinted by `ok`), else a failure's `error`. The run strip and the
 * Knowledge base panel answer through it.
 */
export function useOpResultToast(fetcher: ReturnType<typeof useFetcher<ActionResult>>) {
  const push = useToast();
  useFetcherResult(fetcher, (d) => {
    if (d.toast) push(d.toast, d.ok ? "success" : "error");
    else if (!d.ok && d.error) push(d.error, "error");
  });
}
