import { useState } from "react";
import { Outlet } from "react-router";
import { CommandPalette } from "~/features/shell/command-palette";
import { useCommandPaletteShortcut } from "~/features/shell/use-command-palette";

/**
 * F20-30 — the ⌘K palette, made app-wide.
 *
 * `home-page.tsx` calls ⌘K "ONE shortcut app-wide", but the hook was mounted
 * only by Home and the workspace `Topbar`. `/profile`, `/notifications` and
 * `/org/settings` render OUTSIDE the workspace layout (they are top-level
 * PageOverlay routes), so on those three the shortcut — and any search
 * affordance at all — simply was not there: a viewer had to navigate back to a
 * shell first.
 *
 * This pathless layout wraps exactly those orphan routes, so ⌘K opens the same
 * palette there that it does everywhere else. The palette is a native <dialog>
 * (`showModal`) and stacks in the top layer above the PageOverlay underneath,
 * and the shortcut listens on `window`, which the overlay's `useDialog` never
 * intercepts — so it works while an overlay is open.
 *
 * It deliberately does NOT wrap Home or the workspace: both mount the shortcut
 * themselves, so nothing double-registers.
 */
export default function PaletteShell() {
  const [palette, setPalette] = useState(false);
  useCommandPaletteShortcut(() => setPalette(true));
  return (
    <>
      <Outlet />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </>
  );
}
