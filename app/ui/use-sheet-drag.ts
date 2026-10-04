import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createVelocityTracker, project, rubberband, springAt, unrubberband, type Spring } from "./spring";

/**
 * A bottom sheet a finger can pull down to dismiss (ruling 454) — the
 * gesture Apple's "Designing Fluid Interfaces" is built around:
 *
 * - **Direct manipulation.** After a 10px slop the sheet tracks the pointer
 *   1:1 from where it was grabbed (the slop is taken out, so it never jumps).
 *   Pointer capture keeps the drag alive when the finger leaves the handle.
 * - **Rubber-banding.** Pulled up past its resting place the sheet follows
 *   less and less, and says "there is nothing more up here" instead of
 *   stopping dead.
 * - **Momentum projection.** At release, where the throw would carry the
 *   sheet decides the outcome, not where the finger happens to be: a short
 *   flick dismisses, and a long drag that is heading back up comes back.
 * - **Velocity handoff.** The settle is a spring that leaves at the finger's
 *   speed, so there is no seam between dragging and animating.
 * - **Interruptibility.** Grabbing the sheet while it settles, or while it is
 *   still entering, catches it where it is. Nothing waits for an animation.
 *
 * The sheet opts in from CSS: the hook moves it only while the sheet computes
 * `--sheet-draggable: 1`, so the same component can be a floating panel at
 * one width and a sheet at another without the script ever reading the
 * viewport (R19-12). Its drag handles carry `data-sheet-handle`; a control
 * inside a handle keeps its own tap.
 *
 * The motion is one custom property, `--sheet-drag`, set on `host` together
 * with `data-sheet-drag` while the sheet is off its resting place. The sheet
 * and anything riding it (the dock's perched button) read the same value, so
 * they move on one clock. `onDismiss` runs once the sheet has left; the
 * caller unmounts it without an exit of its own, and the hook clears `host`
 * when `open` turns false. A caller whose own close has an exit passes
 * `open` false as that exit starts, not once it unmounts (the dock passes
 * `open && !closing`): a settle left running under an exit the person then
 * takes back would snap the sheet onto the spring, or dismiss it anyway
 * (ruling 459).
 *
 * The sheet's entrance must be a TRANSITION that the caller's
 * `[data-sheet-drag]` rule switches off (`transition: none`), as the dock's
 * is (ruling 459). That is what holds a sheet caught mid-entrance at the
 * offset read here. A keyframe entrance would outrank the drag's transform
 * in the cascade and carry on under the finger.
 *
 * Reduced motion: the drag still follows the finger — that motion is the
 * person's own — but nothing slides after the release. A dismiss fades the
 * sheet out where it is. A return fades it out, puts it back and fades it in.
 */

/** Apple's drawer / sheet spring: a little give, because a throw preceded it. */
const SHEET_SPRING: Spring = { dampingRatio: 0.8, response: 0.3 };
/** Travel before a press becomes a drag, so a tap on a handle stays a tap. */
const SLOP = 10;
/** Rubber-band stiffness (UIScrollView's constant). */
const BAND = 0.55;
/** A control inside a handle keeps its tap: the drag never starts on one. */
const OWN_TAP = "button, a[href], input, textarea, select, [role='button']";

type Drag = {
  pointerId: number;
  startY: number;
  base: number;
  raw: number;
  offset: number;
  height: number;
  /** The sheet is under the finger (past the slop, or caught while moving). */
  committed: boolean;
  /** The finger itself travelled past the slop. */
  moved: boolean;
  /** Where the sheet was going when the finger caught it. */
  heading: Heading;
};

type Heading = "rest" | "away";

/** The sheet's live vertical translation — mid-entrance included. */
function liveTranslateY(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  const m3 = /^matrix3d\(([^)]*)\)$/.exec(transform);
  if (m3) return Number(m3[1]!.split(",")[13]) || 0;
  const m2 = /^matrix\(([^)]*)\)$/.exec(transform);
  return m2 ? Number(m2[1]!.split(",")[5]) || 0 : 0;
}

export function useSheetDrag({
  sheetRef,
  hostRef,
  open,
  onDismiss,
}: {
  sheetRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  open: boolean;
  onDismiss: () => void;
}): void {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  const drag = useRef<Drag | null>(null);
  const offset = useRef(0);
  const settling = useRef<number | null>(null);
  const heading = useRef<Heading>("rest");
  const fades = useRef<Animation[]>([]);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    const sheet = sheetRef.current;
    const host = hostRef.current;
    if (!open || !sheet || !host) return;
    const tracker = createVelocityTracker();

    const apply = (value: number) => {
      offset.current = value;
      host.style.setProperty("--sheet-drag", `${value}px`);
      host.dataset.sheetDrag = "";
    };
    const clear = () => {
      offset.current = 0;
      host.style.removeProperty("--sheet-drag");
      delete host.dataset.sheetDrag;
    };
    const stop = () => {
      if (settling.current !== null) cancelAnimationFrame(settling.current);
      settling.current = null;
      for (const fade of fades.current) fade.cancel();
      fades.current = [];
    };

    const settle = (from: number, to: number, velocity: number, dismiss: boolean) => {
      heading.current = dismiss ? "away" : "rest";
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const fadeOut = sheet.animate?.({ opacity: [1, 0] }, { duration: dismiss ? 120 : 80, easing: "ease", fill: "forwards" });
        const done = () => {
          if (!sheet.isConnected) return;
          if (dismiss) {
            onDismissRef.current();
            return;
          }
          clear();
          const fadeIn = sheet.animate?.({ opacity: [0, 1] }, { duration: 120, easing: "ease" });
          fadeOut?.cancel();
          fades.current = fadeIn ? [fadeIn] : [];
        };
        if (!fadeOut) {
          done();
          return;
        }
        fades.current = [fadeOut];
        fadeOut.finished.then(done, () => {});
        return;
      }
      const start = performance.now();
      const x0 = from - to;
      const step = () => {
        // The close's commit detaches the sheet before any effect runs; a
        // frame that lands in between must not write the drag back onto the
        // host the layout effect has just cleared (review, 2026-09-24).
        if (!sheet.isConnected) {
          settling.current = null;
          return;
        }
        const t = (performance.now() - start) / 1000;
        const x = springAt(SHEET_SPRING, x0, velocity, t);
        const speed = (springAt(SHEET_SPRING, x0, velocity, t + 1 / 60) - x) * 60;
        // A dismiss is over once the sheet is out of sight; a return once it
        // is at rest (under half a pixel off, barely moving) or a second in.
        const gone = dismiss && x >= 0;
        const resting = Math.abs(x) < 0.5 && Math.abs(speed) < 20;
        if (gone || resting || t > 1) {
          settling.current = null;
          heading.current = "rest";
          if (dismiss) {
            apply(to);
            onDismissRef.current();
          } else {
            clear();
          }
          return;
        }
        apply(to + x);
        settling.current = requestAnimationFrame(step);
      };
      settling.current = requestAnimationFrame(step);
    };

    const onMove = (event: PointerEvent) => {
      const d = drag.current;
      if (!d || event.pointerId !== d.pointerId) return;
      let dy = event.clientY - d.startY;
      if (!d.moved && Math.abs(dy) >= SLOP) {
        d.moved = true;
        if (!d.committed) {
          // Take the slop out, so the sheet leaves from under the finger
          // instead of jumping 10px to catch up with it. (A sheet caught
          // mid-flight is committed from the first frame and has nothing
          // to take out.)
          d.committed = true;
          d.startY = event.clientY;
          dy = 0;
        }
      }
      if (!d.committed) return;
      d.raw = d.base + dy;
      d.offset = d.raw < 0 ? rubberband(d.raw, d.height, BAND) : d.raw;
      apply(d.offset);
      tracker.push(0, event.clientY, performance.now());
    };

    const onEnd = (event: PointerEvent) => {
      const d = drag.current;
      if (!d || event.pointerId !== d.pointerId) return;
      drag.current = null;
      detach.current?.();
      if (!d.committed) return;
      // Caught mid-flight and let go without a drag, the sheet carries on to
      // where it was going: a tap on the handle while the sheet enters must
      // not throw it back out.
      if (!d.moved) {
        settle(d.offset, d.heading === "away" ? d.height : 0, 0, d.heading === "away");
        return;
      }
      // Past the top edge the sheet moves slower than the finger (the band's
      // slope), and the spring inherits the SHEET's speed, not the finger's.
      const follow =
        d.raw < 0 ? (BAND * d.height * d.height) / (d.height + BAND * Math.abs(d.raw)) ** 2 : 1;
      const velocity =
        event.type === "pointercancel" ? 0 : tracker.velocity(performance.now()).y * follow;
      const dismiss = d.offset > 0 && d.offset + project(velocity) > d.height / 2;
      settle(d.offset, dismiss ? d.height : 0, velocity, dismiss);
    };

    const onDown = (event: PointerEvent) => {
      if (drag.current || !event.isPrimary || event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      const handle = event.target.closest<HTMLElement>("[data-sheet-handle]");
      if (!handle || !sheet.contains(handle) || event.target.closest(OWN_TAP)) return;
      if (sheet.dataset.closing !== undefined) return;
      if (getComputedStyle(sheet).getPropertyValue("--sheet-draggable").trim() !== "1") return;
      // Where the sheet is NOW — settling, entering or at rest — is where the
      // finger takes it from.
      const moving = settling.current !== null || fades.current.length > 0;
      const base = moving ? offset.current : liveTranslateY(sheet);
      const wasHeading = moving ? heading.current : "rest";
      const height = sheet.offsetHeight;
      // Above its resting place the sheet stands where the rubber band DREW
      // it; the drag works in the finger's own travel, so a catch there starts
      // from the pull that drew it. Banding the drawn value again made the
      // caught sheet jump ~60px toward rest on the first move (review).
      const pull = base < 0 ? unrubberband(base, height, BAND) : base;
      stop();
      // A sheet still rising is held where the finger caught it by the
      // host's drag rule: its `transition: none` cancels the entrance (a
      // transition, ruling 459) at the offset written here, and nothing
      // replays after the release. Nothing is written on the sheet itself.
      if (base !== 0) apply(base);
      tracker.reset();
      tracker.push(0, event.clientY, performance.now());
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* a synthetic pointer has nothing to capture; the listeners still run */
      }
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
      detach.current = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        detach.current = null;
      };
      drag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        base: pull,
        raw: pull,
        offset: base,
        height,
        // Caught while moving, it is already a drag: the sheet holds under
        // the finger from the first frame.
        committed: base !== 0,
        moved: false,
        heading: wasHeading,
      };
    };

    sheet.addEventListener("pointerdown", onDown);
    return () => {
      sheet.removeEventListener("pointerdown", onDown);
      detach.current?.();
      drag.current = null;
      stop();
      clear();
    };
  }, [open, sheetRef, hostRef]);

  // Closed — by the gesture, the Close button or Escape — the host lets go
  // of the drag before the frame paints, so whatever rode the sheet returns
  // on its own transition, from where it was. The spring and the fades stop
  // in the SAME commit: the effect cleanup that also stops them is passive,
  // and a frame can run before it (a close from a transitionend commits at
  // default priority), which would write the drag back onto the host.
  useLayoutEffect(() => {
    if (open) return;
    if (settling.current !== null) cancelAnimationFrame(settling.current);
    settling.current = null;
    for (const fade of fades.current) fade.cancel();
    fades.current = [];
    detach.current?.();
    drag.current = null;
    heading.current = "rest";
    const host = hostRef.current;
    offset.current = 0;
    host?.style.removeProperty("--sheet-drag");
    if (host) delete host.dataset.sheetDrag;
  }, [open, hostRef]);
}
