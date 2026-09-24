// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSheetDrag } from "./use-sheet-drag";

/**
 * Ruling 454: the dock's bottom sheet under a finger. jsdom lays nothing out,
 * so the sheet's height is stubbed (600px, halfway at 300) and the clocks are
 * fake: a pointer move is a real event at a controlled time, and a spring
 * frame is a real requestAnimationFrame callback.
 */

const HEIGHT = 600;

function Harness({
  open,
  onDismiss,
  onClosedLayout,
}: {
  open: boolean;
  onDismiss: () => void;
  /** Runs in the close's layout phase, after the hook's own layout effect. */
  onClosedLayout?: (host: HTMLElement) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  useSheetDrag({ sheetRef: sheet, hostRef: host, open, onDismiss });
  useLayoutEffect(() => {
    if (!open && host.current) onClosedLayout?.(host.current);
  }, [open, onClosedLayout]);
  return (
    <div ref={host} data-testid="host">
      {open && (
        <section ref={sheet} data-testid="sheet">
          <div data-sheet-handle data-testid="grabber" />
          <header data-sheet-handle data-testid="head">
            <span>Controller</span>
            <button type="button">Close</button>
          </header>
          <p>body</p>
        </section>
      )}
    </div>
  );
}

let reduceMotion = false;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"],
  });
  reduceMotion = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query }),
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(HEIGHT);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup({ sheet = true } = {}) {
  const onDismiss = vi.fn();
  const view = render(<Harness open onDismiss={onDismiss} />);
  const host = view.getByTestId("host");
  const sheetEl = view.getByTestId("sheet");
  // The 720px block's flag. Without it the panel is the floating one.
  if (sheet) sheetEl.style.setProperty("--sheet-draggable", "1");
  return { ...view, onDismiss, host, sheetEl };
}

/** A pointer event at `y`, `ms` after the previous one. */
function pointer(el: Element, type: string, y: number, ms = 0) {
  act(() => {
    vi.advanceTimersByTime(ms);
    el.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientY: y, bubbles: true }),
    );
  });
}

/** A drag down (or up) in 16ms steps of `step` px, not released. */
function pull(el: Element, from: number, to: number, step: number) {
  pointer(el, "pointerdown", from);
  const dir = Math.sign(to - from);
  for (let y = from + dir * step; dir > 0 ? y <= to : y >= to; y += dir * step) {
    pointer(el, "pointermove", y, 16);
  }
}

const drag = (host: HTMLElement) => {
  const value = host.style.getPropertyValue("--sheet-drag");
  return value === "" ? null : Number.parseFloat(value);
};

const runFrames = (ms = 1200) => act(() => vi.advanceTimersByTime(ms));

describe("useSheetDrag", () => {
  it("holds still inside the slop, then follows the finger 1:1 from under it", () => {
    const { host, getByTestId } = setup();
    const head = getByTestId("head");
    pointer(head, "pointerdown", 100);
    pointer(head, "pointermove", 106, 16);
    expect(host.dataset.sheetDrag).toBeUndefined();
    // Past the slop the drag starts where the finger is: no 10px catch-up.
    pointer(head, "pointermove", 112, 16);
    expect(drag(host)).toBe(0);
    pointer(head, "pointermove", 212, 16);
    expect(drag(host)).toBe(100);
    expect(host.dataset.sheetDrag).toBe("");
  });

  it("a slow release short of halfway springs back and lets go of the host", () => {
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 350, 25);
    // The finger rests before letting go: no throw.
    pointer(head, "pointerup", 350, 200);
    runFrames();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(host.dataset.sheetDrag).toBeUndefined();
    expect(drag(host)).toBeNull();
  });

  it("a release past halfway dismisses once the sheet is out of sight", () => {
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 480, 20);
    pointer(head, "pointerup", 480, 200);
    // Mid-flight: still on its way, not dismissed yet.
    act(() => vi.advanceTimersByTime(48));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(drag(host)!).toBeGreaterThan(360);
    // CANARY: wait for the spring to settle before dismissing — out of sight
    // at ~210ms, it would idle to ~400ms.
    act(() => vi.advanceTimersByTime(192));
    expect(onDismiss, "dismissed the frame it is out of sight").toHaveBeenCalledTimes(1);
    runFrames();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // It is held off screen until the caller unmounts it.
    expect(drag(host)).toBe(HEIGHT);
  });

  it("a flick dismisses from a short pull: the throw's projection decides, not the position", () => {
    const { onDismiss, getByTestId } = setup();
    const grabber = getByTestId("grabber");
    // 20px per 16ms is 1250px/s; the sheet ends 60px down (the first 20px
    // step is the slop).
    pull(grabber, 100, 180, 20);
    pointer(grabber, "pointerup", 180, 4);
    runFrames();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a long pull on its way back up comes back", () => {
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 540, 20); // 420px down, past halfway...
    for (let y = 520; y >= 440; y -= 20) pointer(head, "pointermove", y, 16); // ...heading up at 1250px/s
    pointer(head, "pointerup", 440, 4);
    runFrames();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(drag(host)).toBeNull();
  });

  it("pulled up past its resting place it follows less and less", () => {
    const { host, getByTestId } = setup();
    const head = getByTestId("head");
    pointer(head, "pointerdown", 400);
    pointer(head, "pointermove", 388, 16); // commits; the slop comes out
    pointer(head, "pointermove", 288, 16);
    const first = drag(host)!;
    expect(first).toBeLessThan(0);
    expect(first).toBeGreaterThan(-100);
    pointer(head, "pointermove", 188, 16);
    const second = drag(host)! - first;
    expect(second).toBeGreaterThan(-100);
    expect(Math.abs(second)).toBeLessThan(Math.abs(first));
  });

  it("a control inside a handle keeps its tap: no drag starts on it", () => {
    const { host, getByRole } = setup();
    const close = getByRole("button", { name: "Close" });
    pull(close, 100, 300, 20);
    expect(host.dataset.sheetDrag).toBeUndefined();
  });

  it("only a handle drags, and only a sheet: the floating panel never moves", () => {
    const body = setup();
    pull(body.getByText("body"), 100, 300, 20);
    expect(body.host.dataset.sheetDrag).toBeUndefined();
    body.unmount();
    const floating = setup({ sheet: false });
    pull(floating.getByTestId("head"), 100, 300, 20);
    expect(floating.host.dataset.sheetDrag).toBeUndefined();
  });

  it("grabbing a settling sheet catches it where it is, and stops the spring", () => {
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 350, 25);
    pointer(head, "pointerup", 350, 200);
    act(() => vi.advanceTimersByTime(64));
    const caught = drag(host)!;
    expect(caught).toBeGreaterThan(0);
    expect(caught).toBeLessThan(240);
    pointer(head, "pointerdown", 300);
    act(() => vi.advanceTimersByTime(500));
    // Held under the finger: the spring no longer moves it.
    expect(drag(host)).toBe(caught);
    // And it follows from there, 1:1, with no slop to take out.
    pointer(head, "pointermove", 320, 16);
    expect(drag(host)).toBe(caught + 20);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("caught mid-entrance and let go without a drag, it finishes opening", () => {
    const { host, onDismiss, sheetEl, getByTestId } = setup();
    // The entrance keyframe, 400px from home — past halfway.
    sheetEl.style.transform = "matrix(1, 0, 0, 1, 0, 400)";
    const head = getByTestId("head");
    pointer(head, "pointerdown", 500);
    expect(drag(host)).toBe(400);
    expect(sheetEl.style.animation).toBe("none");
    pointer(head, "pointerup", 500, 100);
    runFrames();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(drag(host)).toBeNull();
  });

  it("under reduced motion nothing slides after the release: a dismiss leaves from where it is", () => {
    reduceMotion = true;
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 480, 20);
    pointer(head, "pointerup", 480, 200);
    // jsdom has no WAAPI, so the fade completes at once; no spring frame ran.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Where the finger left it (the first 20px step took the slop out).
    expect(drag(host)).toBe(360);
  });

  it("closing lets go of the host in the layout phase, before the frame paints", () => {
    // CANARY: make the hook's closing effect a passive useEffect — RTL's act
    // flushes it before an assertion outside, so only a layout-phase read
    // tells the two apart.
    const { host, rerender, getByTestId, onDismiss } = setup();
    pull(getByTestId("head"), 100, 300, 20);
    expect(host.dataset.sheetDrag).toBe("");
    let atLayout: string | undefined = "not read";
    rerender(
      <Harness open={false} onDismiss={onDismiss} onClosedLayout={(h) => (atLayout = h.dataset.sheetDrag)} />,
    );
    expect(atLayout).toBeUndefined();
    expect(host.dataset.sheetDrag).toBeUndefined();
    expect(drag(host)).toBeNull();
  });

  it("a spring frame that lands between the close and the effect cleanup cannot put the drag back", () => {
    // Review 2026-09-24: a close from a transitionend commits at default
    // priority, so passive effects (the only place the spring was stopped)
    // can run a frame late. The frame here runs inside the close's layout
    // phase, right after the hook's layout effect.
    // CANARY: drop BOTH defenses — the rAF cancel in the hook's closing
    // layout effect and `step`'s bail on a detached sheet. Either alone holds.
    const { host, rerender, getByTestId, onDismiss } = setup();
    const head = getByTestId("head");
    pull(head, 100, 350, 25);
    pointer(head, "pointerup", 350, 200);
    act(() => vi.advanceTimersByTime(48));
    expect(drag(host)!).toBeGreaterThan(0);
    let afterFrame: string | undefined = "not read";
    rerender(
      <Harness
        open={false}
        onDismiss={onDismiss}
        onClosedLayout={(h) => {
          vi.advanceTimersByTime(32);
          afterFrame = h.dataset.sheetDrag;
        }}
      />,
    );
    expect(afterFrame).toBeUndefined();
    runFrames();
    expect(host.dataset.sheetDrag).toBeUndefined();
    expect(drag(host)).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("re-grabbed above its resting place, the sheet stays where it was caught", () => {
    // Review 2026-09-24: the drawn (banded) offset was taken for the finger's
    // pull and banded again, so the caught sheet jumped ~60px toward rest.
    // CANARY: drop the `unrubberband` in onDown.
    const { host, getByTestId } = setup();
    const head = getByTestId("head");
    pointer(head, "pointerdown", 400);
    pointer(head, "pointermove", 388, 16);
    pointer(head, "pointermove", 88, 16); // 300px up, drawn at about -129px
    pointer(head, "pointerup", 88, 200);
    act(() => vi.advanceTimersByTime(16));
    const caught = drag(host)!;
    expect(caught).toBeLessThan(-100);
    pointer(head, "pointerdown", 88);
    pointer(head, "pointermove", 87, 16);
    // One pixel of finger is under a pixel of sheet (the band's slope).
    expect(Math.abs(drag(host)! - caught)).toBeLessThan(1);
    expect(drag(host)!).toBeLessThan(caught);
  });

  it("the settle leaves at the finger's speed", () => {
    // CANARY: hand the spring 0 instead of the release velocity.
    const { host, getByTestId } = setup();
    const grabber = getByTestId("grabber");
    pull(grabber, 100, 180, 20);
    pointer(grabber, "pointerup", 180, 4);
    act(() => vi.advanceTimersByTime(16));
    // At 1250px/s one frame is ~20px on top of the spring's own pull.
    expect(drag(host)! - 60, "the spring leaves at the finger's speed").toBeGreaterThan(20);
  });

  it("caught while it leaves and let go without a drag, it carries on out", () => {
    // CANARY: take the catch's heading as always "rest".
    const { onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 480, 20);
    pointer(head, "pointerup", 480, 200);
    act(() => vi.advanceTimersByTime(48));
    expect(onDismiss).not.toHaveBeenCalled();
    pointer(head, "pointerdown", 300);
    pointer(head, "pointerup", 300, 50);
    runFrames();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion a return fades back to rest and lets go of the host", () => {
    // CANARY: drop the `clear()` from the reduced-motion return.
    reduceMotion = true;
    const { host, onDismiss, getByTestId } = setup();
    const head = getByTestId("head");
    pull(head, 100, 300, 20);
    pointer(head, "pointerup", 300, 200);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(drag(host)).toBeNull();
    expect(host.dataset.sheetDrag).toBeUndefined();
  });
});
