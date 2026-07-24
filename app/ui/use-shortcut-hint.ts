import { useEffect, useState } from "react";

/**
 * UI-55: the search boxes rendered a hardcoded "⌘K" although the handler
 * accepts Ctrl too, so every non-Mac user was shown a shortcut their keyboard
 * does not have.
 *
 * The platform is only knowable on the client, so SSR emits the Mac form (the
 * historical markup) and the first client effect corrects it — pair with
 * `suppressHydrationWarning` on the element rendering the label.
 */
export function useModifierHint(): string {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setMac(/mac|iphone|ipad|ipod/i.test(navigator.userAgent));
  }, []);
  return mac ? "⌘K" : "Ctrl K";
}
