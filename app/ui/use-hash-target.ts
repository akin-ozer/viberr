import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { hashTarget } from "~/shared/page-anchors";
import { useHydrated } from "./local-time";

/**
 * Ruling 419(h), shared by ruling 497: bring `target` to the top of the nearest
 * box that scrolls it (the rail on a desktop, the page column on a phone), and
 * focus `focusable` without scrolling again. `scrollIntoView` would move every
 * scrolling ancestor, the document included, which the shell never lets a
 * person scroll back.
 */
export function revealTarget(target: HTMLElement, focusable: HTMLElement | null = target): void {
  let box = target.parentElement;
  while (
    box &&
    !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))
  ) {
    box = box.parentElement;
  }
  if (box) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
  focusable?.focus({ preventScroll: true });
}

/**
 * Ruling 497: the element a URL's hash names, when `accepts` claims that id,
 * revealed once for each navigation that names it, a click on a link to the
 * place already on screen included (a new location carrying the same hash).
 * Returns the claimed id, which the page marks (`data-targeted`); null when the
 * hash names nothing this caller claims.
 *
 * `ready` is false while the page cannot show the element yet (the timeline
 * is still loading the older events it is among); the reveal waits for it.
 * `reveal` defaults to scrolling the element with that id into view.
 *
 * The hash is read only once the page has hydrated (`useHashTarget` itself
 * returns null until then): a browser never sends it to the server, so a
 * document load of a link (a refresh, a pasted URL, the router's reload after
 * a deploy) rendered no mark on the server, and hydration does not patch an
 * attribute the client would have drawn.
 *
 * Ruling 523: the mark says where a link landed, so it lasts until the person
 * does something on the page. Their next press anywhere in the document (a
 * pointer on anything, the marked place included, or a key other than a lone
 * modifier) takes the hash out of the URL, in place and with no scroll: every
 * reader of the location lets go of the place at once, and a reload does not
 * bring the mark back. The press itself goes on to do what it does.
 */
export function useHashTarget(
  accepts: (id: string) => boolean,
  ready = true,
  reveal: (id: string) => boolean = revealById,
): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const id = useHydrated() ? hashTarget(location.hash) : "";
  const claimed = id !== "" && accepts(id) ? id : null;
  const revealedFor = useRef<string | null>(null);
  const revealRef = useRef(reveal);
  useEffect(() => {
    revealRef.current = reveal;
  });
  useEffect(() => {
    if (!claimed || !ready || revealedFor.current === location.key) return;
    if (revealRef.current(claimed)) revealedFor.current = location.key;
  }, [claimed, ready, location.key]);
  useEffect(() => {
    if (!claimed) return;
    const leave = (event: Event) => {
      // A key that is itself a held modifier (a shortcut on its way, a switch
      // to another app) or one held down from before is not the person acting.
      if (event instanceof KeyboardEvent && (event.repeat || event.getModifierState(event.key))) return;
      void navigate(location.pathname + location.search, {
        replace: true,
        preventScrollReset: true,
        state: location.state,
      });
    };
    // Capture: a control that stops its own event still ends the mark.
    const off = new AbortController();
    document.addEventListener("pointerdown", leave, { capture: true, signal: off.signal });
    document.addEventListener("keydown", leave, { capture: true, signal: off.signal });
    return () => off.abort();
  }, [claimed, location, navigate]);
  return claimed;
}

function revealById(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  revealTarget(target);
  return true;
}
