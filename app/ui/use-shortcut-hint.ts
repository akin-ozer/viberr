import { useEffect, useState } from "react";

/**
 * UI-55: the search boxes rendered a hardcoded "⌘K" although the handler
 * accepts Ctrl too, so every non-Mac user was shown a shortcut their keyboard
 * does not have.
 *
 * The platform is only knowable on the client, so SSR emits the Mac form (the
 * historical markup) and the first client effect corrects it — pair with
 * `suppressHydrationWarning` on the element rendering the label.
 *
 * P13-D-39: the key used to be baked in ("⌘K" / "Ctrl K"), which is why the
 * timeline comment composer — a ⌘/Ctrl+Enter shortcut, not ⌘K — still shipped
 * the literal `⌘↵`, the last user-visible `⌘` in `app/`. The key is a parameter
 * now; it defaults to "K" only so the two search boxes (owned elsewhere) keep
 * calling `useModifierHint()` with no argument.
 *
 * Spacing follows the platform convention the search boxes established: the Mac
 * glyph butts against the key ("⌘K"), the spelled-out modifier takes a space
 * ("Ctrl K").
 */
export function useModifierHint(key = "K"): string {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    // No navigator on the host ⇒ no platform to read, so the SSR default (the
    // Mac form) stands.
    if (!("navigator" in globalThis)) return;
    setMac(/mac|iphone|ipad|ipod/i.test(navigator.userAgent));
  }, []);
  return mac ? `⌘${key}` : `Ctrl ${key}`;
}
