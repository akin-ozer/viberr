import { useEffect, useRef, type RefObject } from "react";

/**
 * "Escape or a press outside closes me" — the one implementation.
 *
 * Seven near-identical copies of this effect shipped across the app (UI
 * inventory §8 rough edge 12): `shell/user-menu.tsx`, `shell/top-bell.tsx`,
 * `ui/stage-menu.tsx`, three menus in `task-detail/execution-profile.tsx` and
 * `runtime/runs-panels.tsx`'s AgentPicker. They disagreed on details that are
 * not design choices — `document` vs `window` for the key listener, whether an
 * outside press closes at all, whether the trigger counts as inside — so the
 * same gesture behaved differently depending on which menu was open. All seven
 * are converted; the options below are the union of what they needed.
 *
 * What the platform does NOT give us here, and why this is not `useDialog`:
 * these are inline popovers anchored to a trigger, not modal `<dialog>`s. They
 * must not trap focus, must not take the top layer, and must not scroll-lock
 * the body — so there is no native `cancel` event to hang Escape on.
 */

export interface DismissOptions {
  /**
   * Extra elements that count as "inside". Needed when the popover is portaled
   * away from its trigger (StageMenu) or rendered as a sibling of it, so a
   * press on the trigger does not dismiss-then-reopen.
   */
  also?: readonly RefObject<HTMLElement | null>[];
  /**
   * Close on scroll (capture) and resize. For popovers positioned from a
   * trigger's bounding rect, which go stale the moment anything moves.
   * Default `false`.
   */
  onReflow?: boolean;
  /**
   * Whether an outside press dismisses. Default `true`. The account menu and
   * the notification bell deliberately stay open until Escape or an explicit
   * action, so they pass `false`.
   */
  outside?: boolean;
}

/**
 * Returns the ref to put on the popover's outermost element (the one that
 * contains both the trigger and the panel, when they are nested).
 *
 * Nothing is subscribed while `open` is false, so a page full of closed menus
 * costs no listeners.
 */
export function useDismiss<T extends HTMLElement = HTMLElement>(
  open: boolean,
  onDismiss: () => void,
  options?: DismissOptions,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Held in a ref so an inline arrow callback (the common call shape) does not
  // resubscribe the listeners on every render of the host component.
  const dismissRef = useRef(onDismiss);

  const outside = options?.outside ?? true;
  const onReflow = options?.onReflow ?? false;
  // Also held in a ref: the natural call shape is an inline array literal, and
  // a fresh identity per render would tear down and re-add the listeners on
  // every keystroke of whatever else lives in the host component.
  const alsoRef = useRef(options?.also);

  // Kept current in an effect rather than during render (which must stay pure);
  // both are read only from the deferred event handlers below.
  useEffect(() => {
    dismissRef.current = onDismiss;
    alsoRef.current = options?.also;
  });

  useEffect(() => {
    if (!open) return;
    const dismiss = () => dismissRef.current();

    // `mousedown`, not `click`: a click fires after the press has already moved
    // focus and, for a menu whose items unmount on selection, can land on
    // whatever slid under the cursor.
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (alsoRef.current?.some((r) => r.current?.contains(target))) return;
      dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consumed: the Escape closed THIS popover, so an enclosing <dialog>
      // must not cancel on it too, and the controller dock's page-level
      // Escape skips it (interface review 2026-09-24, acce-15 / acce-14).
      event.preventDefault();
      dismiss();
    };
    const onMove = (event: Event) => {
      // A scroll INSIDE the popover (a height-capped list, or focus() bringing
      // an item into view) moves nothing the popover is positioned from.
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      dismiss();
    };

    // `document` for both: `window` receives the same bubbled events, but a
    // listener on `document` is what the outside-press test actually needs
    // (a press on the page, not on the window chrome), and using one target
    // for both halves keeps the removal symmetric.
    if (outside) document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    if (onReflow) {
      // capture:true so a scroll inside any container — not just the window —
      // closes a popover positioned from a stale rect.
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
    }
    return () => {
      if (outside) document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      if (onReflow) {
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      }
    };
  }, [open, outside, onReflow]);

  return ref;
}
