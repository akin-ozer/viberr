import { useCallback, useEffect, useRef } from "react";

/**
 * Dialog behavior required on EVERY dialog by orchestrator ruling 16, now on
 * a native <dialog> opened via showModal(): the browser supplies the focus
 * trap, initial focus, Escape (cancel event), top-layer stacking and the
 * ::backdrop scrim. This hook adds what the platform doesn't: body scroll
 * lock, backdrop-click close (the old `.confirm-scrim` affordance), focus
 * restore on unmount, keeping React's imperative autoFocus (showModal
 * would otherwise move focus off it), and an animated close — `close()`
 * marks the dialog with [data-closing] so CSS can play the exit transition
 * (reverse of pop-center), then invokes onClose to unmount.
 *
 * Usage: const { ref, close } = useDialog(onClose);
 *        <dialog className="modal-card" ref={ref}> … <button onClick={close}>
 * Escape and backdrop clicks route through the same animated close. A caller
 * with an inner layer (store-browser's new-folder row) passes
 * onDismissRequest: return true to consume the Escape/backdrop dismiss
 * without closing (no exit animation plays); explicit close() always closes.
 */

export function useDialog(
  onClose: () => void,
  onDismissRequest?: () => boolean,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const onDismissRef = useRef(onDismissRequest);
  useEffect(() => {
    onCloseRef.current = onClose;
    onDismissRef.current = onDismissRequest;
  });

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.dataset.closing !== undefined) return;
    dialog.dataset.closing = "";
    // dialog[data-closing]'s transition-duration, read after the attribute
    // lands: 0/NaN in jsdom (no stylesheet), or ~0 where the sheet's
    // reduced-motion rules apply — both mean close synchronously.
    const seconds = parseFloat(getComputedStyle(dialog).transitionDuration);
    if (!(seconds > 0.02)) {
      onCloseRef.current();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog.removeEventListener("transitionend", onTransitionEnd);
      clearTimeout(fallback);
      onCloseRef.current();
    };
    // Only the dialog's own transition counts — transitionend BUBBLES, and a
    // descendant's (e.g. the pressed Cancel button's transform) would end the
    // close mid-fade.
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === dialog) finish();
    };
    dialog.addEventListener("transitionend", onTransitionEnd);
    // Fallback in case transitionend never fires (display:none ancestor …).
    const fallback = setTimeout(finish, seconds * 1000 + 50);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Initial focus, two paths: React's autoFocus has already focused a field
    // inside the dialog at commit time (showModal() would move focus off it,
    // so put it back), or a field opts in via [data-autofocus] and is focused
    // after showModal() — same first-field UX without an autoFocus prop.
    const preFocused =
      previouslyFocused && dialog.contains(previouslyFocused)
        ? previouslyFocused
        : null;
    const initial =
      preFocused ?? dialog.querySelector<HTMLElement>("[data-autofocus]");
    if (!dialog.open) dialog.showModal();
    initial?.focus();

    // Escape fires `cancel`; suppress the native close so React state stays
    // the source of truth (the caller unmounts the dialog after the exit
    // transition).
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (onDismissRef.current?.()) return;
      close();
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
      if (!inside) {
        if (onDismissRef.current?.()) return;
        close();
      }
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
  }, [close]);

  return { ref: dialogRef, close };
}
