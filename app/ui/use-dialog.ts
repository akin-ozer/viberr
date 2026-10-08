import { useCallback, useEffect, useRef, useState } from "react";
import { pinLivePose } from "./live-pose";

/**
 * Dialog behavior required on EVERY dialog by orchestrator ruling 16, now on
 * a native <dialog> opened via showModal(): the browser supplies the focus
 * trap, initial focus, Escape (cancel event), top-layer stacking and the
 * ::backdrop scrim. This hook adds what the platform doesn't: body scroll
 * lock, backdrop-click close (the old `.confirm-scrim` affordance), focus
 * restore on unmount (to the opener, or its list row once it is disabled or
 * gone), keeping React's imperative autoFocus (showModal would otherwise move
 * focus off it), and an animated close — `close()`
 * marks the dialog with [data-closing] so CSS can play the exit transition
 * (a softer, shorter pop-center in reverse), then invokes onClose to unmount.
 *
 * Usage: const { ref, close, commit } = useDialog(onClose);
 *        <dialog className="modal-card" ref={ref}> … <button onClick={close}>
 *        … <button onClick={() => commit(onConfirm)}>
 * Escape and backdrop clicks route through the same animated close, and so
 * does a primary action (ruling 459): `commit(fn)` runs fn once, then plays
 * the exit Cancel plays, which calls onClose. So onClose runs after a confirm
 * too and must stay a pure state reset (`setX(null)`), never a revert or a
 * recorded cancellation; and the caller's fn must not unmount the dialog
 * itself, or the card vanishes in one frame. A close that navigates away or
 * hands off to another dialog stays instant on purpose (the caller unmounts
 * it). A caller with an inner layer (store-browser's new-folder row) passes
 * onDismissRequest: return true to consume the Escape/backdrop dismiss
 * without closing (no exit animation plays); explicit close() always closes.
 *
 * onClose also runs when the dialog unmounts mid-exit (a revalidation took
 * it away): the fallback timer is not cleared on unmount, because that call
 * settles a parent whose state still holds the dialog open. A close that
 * does more than reset state checks that its dialog is still mounted
 * (PageOverlay).
 */

export function useDialog(
  onClose: () => void,
  onDismissRequest?: () => boolean,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Interface review 2026-09-24 (acce-2): the element to restore focus to is
  // read at FIRST RENDER. By the time the effect below runs, React's commit-time
  // autoFocus has already moved focus to a field inside the dialog, so the
  // effect's read was that field — close "restored" focus to a removed node and
  // dropped keyboard users on <body>.
  const [opener] = useState<HTMLElement | null>(() =>
    "document" in globalThis && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const onCloseRef = useRef(onClose);
  const onDismissRef = useRef(onDismissRequest);
  useEffect(() => {
    onCloseRef.current = onClose;
    onDismissRef.current = onDismissRequest;
  });

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.dataset.closing !== undefined) return;
    // Closed mid-entrance, the exit starts from where the entrance got to
    // instead of not starting at all (live-pose.ts).
    const release = pinLivePose(dialog);
    dialog.dataset.closing = "";
    release();
    // The scrim is a ::backdrop, which takes no inline style: a fade-in still
    // running plays back from where it is instead.
    for (const animation of dialog.getAnimations?.({ subtree: true }) ?? []) {
      const effect = animation.effect;
      if (
        effect instanceof KeyframeEffect &&
        effect.pseudoElement === "::backdrop" &&
        animation.playState === "running"
      ) {
        animation.reverse();
      }
    }
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

  // The primary's close (ruling 459): run the commit once, then play the same
  // exit Cancel plays. [data-closing]'s pointer-events: none stops only the
  // pointer, so a second Enter on the still-focused button during the exit
  // would commit twice; it is dropped here.
  const commit = useCallback(
    (action: () => void) => {
      if (dialogRef.current?.dataset.closing !== undefined) return;
      action();
      close();
    },
    [close],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // The opener's list row, read while the opener is still on the page: one
    // the action has taken away by the time the dialog unmounts has no
    // ancestors left to find it from (the cleanup below).
    const row = opener?.closest<HTMLElement>("li[tabindex]");
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Initial focus, two paths: React's autoFocus has already focused a field
    // inside the dialog at commit time (showModal() would move focus off it,
    // so put it back), or a field opts in via [data-autofocus] and is focused
    // after showModal() — same first-field UX without an autoFocus prop.
    const preFocused = focused && dialog.contains(focused) ? focused : null;
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
      // A confirm's exit ends after its action (ruling 459), so the action
      // can have taken the opener away by now: disabled while the request it
      // started is in flight (a row's Undo), or off the page once the
      // revalidation has landed (the Undo replaced by "Undone by …"). Neither
      // takes focus, so the list row it sat in (`li` with tabIndex={-1}, a
      // reveal target) takes it instead of <body>, while that row is still on
      // the page. Only a row: a focusable region or landmark (Home's <main>,
      // the task page's .detail) would read the whole page out and send the
      // next Tab to its top, so an opener outside a row, or one whose row
      // went with it, still leaves focus on <body>.
      if (opener?.isConnected && !opener.matches(":disabled")) {
        opener.focus();
      } else if (row?.isConnected) {
        row.focus({ preventScroll: true });
      }
    };
  }, [close, opener]);

  return { ref: dialogRef, close, commit };
}
