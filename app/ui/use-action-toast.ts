import { useEffect, useRef } from "react";
import type { FetcherWithComponents } from "react-router";
import { useToast } from "./toast";

type ActionResult =
  | { ok: true; toast?: string }
  | { ok: false; error?: string };

export function useActionToast<T extends ActionResult>(
  fetcher: FetcherWithComponents<T>,
): void {
  const push = useToast();
  const handled = useRef<unknown>(null);
  const { data, state } = fetcher;
  useEffect(() => {
    if (state !== "idle" || !data || handled.current === data) return;
    handled.current = data;
    const message = data.ok ? data.toast : data.error;
    if (message) push(message);
  }, [data, state, push]);
}
