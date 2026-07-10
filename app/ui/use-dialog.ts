import { useEffect, useRef, type RefObject } from "react";

/**
 * Dialog behavior required on EVERY dialog by orchestrator ruling 16, now on
 * a native <dialog> opened via showModal(): the browser supplies the focus
 * trap, initial focus, Escape (cancel event), top-layer stacking and the
 * ::backdrop scrim. This hook adds what the platform doesn't: body scroll
 * lock, backdrop-click close (the old `.confirm-scrim` affordance), focus
 * restore on unmount, and keeping React's imperative autoFocus (showModal
 * would otherwise move focus off it).
 *
 * Usage: const ref = useDialog(onClose); <dialog className="modal-card" ref={ref}>
 */

export function useDialog(onClose: () => void): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // React's autoFocus has already focused a field inside the dialog at
    // commit time; showModal() would move focus off it, so put it back.
    const preFocused =
      previouslyFocused && dialog.contains(previouslyFocused)
        ? previouslyFocused
        : null;
    if (!dialog.open) dialog.showModal();
    preFocused?.focus();

    // Escape fires `cancel`; suppress the native close so React state stays
    // the source of truth (the caller unmounts the dialog).
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    // Backdrop clicks land on the <dialog> element itself with coordinates
    // outside the card box; clicks on the card's own padding also target the
    // dialog but sit inside the rect — only the former dismisses.
    const onClick = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onClick);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return dialogRef;
}
