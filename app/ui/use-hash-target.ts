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
 *
 * Ruling 523: the mark says where a link landed, so it lasts until the person
 * does something on the page. Their next press anywhere in the document (a
 * pointer on anything, the marked place included, or a key other than a lone
 * modifier) takes the hash out of the URL, in place and with no scroll: every
 * reader of the location lets go of the place at once, and a reload does not
 * bring the mark back. The press itself goes on to do what it does.
 *
 * Ruling 547: the place stays where the reveal put it while the page goes on
 * laying out around it (`holdInView`), until the person moves the page.
 * `reveal` returns the element it brought into view, or null when the page
 * cannot show one yet.
 */
export function useHashTarget(
  accepts: (id: string) => boolean,
  ready = true,
  reveal: (id: string) => HTMLElement | null = revealById,
): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const id = useHydrated() ? hashTarget(location.hash) : "";
  const claimed = id !== "" && accepts(id) ? id : null;
  const revealed = useRef<RevealedPlace | null>(null);
  const revealRef = useRef(reveal);
  useEffect(() => {
    revealRef.current = reveal;
  });
  useEffect(() => {
    if (!claimed || !ready) return;
    if (revealed.current?.key !== location.key) {
      const target = revealRef.current(claimed);
      if (!target) return;
      revealed.current = placeOf(target, location.key);
    }
    // Held again when the effect runs again for the same navigation (React's
    // StrictMode mounts it twice), unless the person has let go since.
    const place = revealed.current;
    return place.free ? undefined : holdInView(place);
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

function revealById(id: string): HTMLElement | null {
  const target = document.getElementById(id);
  if (target) revealTarget(target);
  return target;
}

/** Where a reveal left the place a navigation named: `at` px below the top of
 *  the box that scrolls it. `free` once the person has moved the page, or when
 *  nothing around it scrolls. */
interface RevealedPlace {
  key: string;
  target: HTMLElement;
  box: HTMLElement | null;
  at: number;
  free: boolean;
}

function placeOf(target: HTMLElement, key: string): RevealedPlace {
  const box = scrollingBox(target);
  return { key, target, box, at: box ? offsetIn(box, target) : 0, free: box === null };
}

function offsetIn(box: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

/** What the person does to move a page themselves. */
const MOVES = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Ruling 547: keep a revealed place `at` px below the top of the box that
 * scrolls it while the page goes on laying out around it. A task page that
 * mounts for the link (another task's) draws its long entries whole and folds
 * them only in the render after the one that revealed the place: on AWSC-2 the
 * reveal scrolled a page 11,842 px tall, the folds above the entry then took
 * 3,222 px out of it, and the entry sat 606 px over the top of the page column,
 * marked and out of sight. Whatever changes size in the box (a fold, a picture
 * loading, an event arriving above, a region drawn into it), the box scrolls by
 * what the place moved. The person's first wheel, touch, press or key lets go
 * for good. Returns the release, for the next navigation or the mark's end.
 */
function holdInView(place: RevealedPlace): () => void {
  const { target, box } = place;
  if (!box || !("ResizeObserver" in globalThis)) return () => {};
  const keep = () => {
    if (target.isConnected) box.scrollTop += offsetIn(box, target) - place.at;
  };
  const sizes = new ResizeObserver(keep);
  const watch = () => {
    sizes.observe(box);
    for (const child of box.children) sizes.observe(child);
  };
  watch();
  const drawn = new MutationObserver(() => {
    watch();
    keep();
  });
  drawn.observe(box, { childList: true });
  const off = new AbortController();
  const release = () => {
    sizes.disconnect();
    drawn.disconnect();
    off.abort();
  };
  const letGo = () => {
    place.free = true;
    release();
  };
  for (const type of MOVES) {
    document.addEventListener(type, letGo, { capture: true, passive: true, signal: off.signal });
  }
  return release;
}
