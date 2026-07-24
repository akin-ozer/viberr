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
    // P13-D-10: this shared helper is the toast path for 11 fetchers (project
    // settings, GitHub, Policy) and it pushed EVERY message with the default
    // "success" kind — so a server `error` string rendered with the green tick.
    // Colour is not the differentiator (both kinds paint `var(--fg)`); the glyph
    // is the entire signal, which is why the wrong glyph is the whole defect.
    if (message) push(message, data.ok ? "success" : "error");
  }, [data, state, push]);
}
