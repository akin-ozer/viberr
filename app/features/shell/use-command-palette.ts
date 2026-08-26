import { useEffect, useRef } from "react";

/**
 * ⌘K / Ctrl-K — the app's ONE palette binding.
 *
 * Inventory rough edge #8: the workspace topbar (`topbar.tsx`) and Home
 * (`home-page.tsx`) each carried their own copy of this effect. Same key, same
 * behaviour, two implementations free to drift — and a keyboard shortcut that
 * behaves differently depending on which surface you are standing on is worse
 * than no shortcut. Both surfaces call this hook now.
 *
 * It lives in its own module rather than next to `CommandPalette` because a
 * non-component export from a `.tsx` file drops that file out of Fast Refresh
 * (the same reason `app/ui/initials.ts` is split out of `avatar.tsx`).
 *
 * `onOpen` is held in a ref so an inline arrow at the call site does not
 * re-subscribe the window listener on every render.
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  // Kept current in an effect, not during render (render must stay pure); it is
  // read only from the deferred keydown handler below.
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Alt is excluded: ⌥⌘K / Ctrl-Alt-K are OS- and IDE-level combinations,
      // and swallowing them would be a surprise the palette never earned.
      if (event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      onOpenRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
