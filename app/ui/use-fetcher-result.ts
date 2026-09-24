import { useEffect, useRef } from "react";

/**
 * Run a handler exactly once per settled fetcher result. The P11-40 family of
 * fixes moved client-computed toasts from submit time (a false success when
 * the POST fails) to result time — and each call site hand-rolled the same
 * idle-check + seen-ref dedupe effect. This hook IS that effect, shared: the
 * handler decides what a result means (success toast, error toast, optimistic
 * rollback); dedupe is by data identity. useActionToast, the path for
 * server-computed toasts, is built on it.
 */
export function useFetcherResult<T>(
  fetcher: { state: "idle" | "loading" | "submitting"; data?: T },
  onResult: (data: T) => void,
): void {
  const seen = useRef<unknown>(null);
  // Ref'd so a per-render handler identity neither re-fires the effect nor
  // closes over stale state (the repo's handled-ref fetcher pattern). Written
  // in an effect rather than during render to keep render pure; declared before
  // the settle effect so it runs first on the same commit and the handler is
  // current when a result is delivered.
  const handler = useRef(onResult);
  useEffect(() => {
    handler.current = onResult;
  });
  useEffect(() => {
    if (fetcher.state !== "idle" || fetcher.data == null) return;
    if (seen.current === fetcher.data) return;
    seen.current = fetcher.data;
    handler.current(fetcher.data);
  }, [fetcher.state, fetcher.data]);
}
