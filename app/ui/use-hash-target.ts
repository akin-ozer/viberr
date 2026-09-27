import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
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
  const box = scrollingBox(target);
  if (box) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
  focusable?.focus({ preventScroll: true });
}

/** The nearest box that scrolls `el`: the rail on a desktop, the page column
 *  on a phone. Null when nothing around it scrolls. */
export function scrollingBox(el: HTMLElement): HTMLElement | null {
  let box = el.parentElement;
  while (
    box &&
    !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))
  ) {
    box = box.parentElement;
  }
  return box;
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
 */
export function useHashTarget(
  accepts: (id: string) => boolean,
  ready = true,
  reveal: (id: string) => boolean = revealById,
): string | null {
  const location = useLocation();
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
  return claimed;
}

function revealById(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  revealTarget(target);
  return true;
}
