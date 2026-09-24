// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";

/**
 * Two-phase toast dismissal: a pushed success toast lives 5000 ms, then carries
 * `.leaving` for 200 ms (CSS plays the exit fade, mirroring the `rise`
 * entrance path) before unmounting. An error toast has no timer at all.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Pusher() {
  const push = useToast();
  return (
    <button type="button" onClick={() => push("saved")}>
      push
    </button>
  );
}

/** Pushes a distinct message per click, so a capped-out toast is identifiable. */
function CountingPusher() {
  const push = useToast();
  const n = useRef(0);
  return (
    <button type="button" onClick={() => push("toast " + ++n.current)}>
      push
    </button>
  );
}

describe("toast lifecycle", () => {
  it("marks the toast .leaving at 5000 ms and unmounts it 200 ms later", () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    fireEvent.click(getByText("push"));

    const toast = () => container.querySelector(".toast");
    expect(toast()).not.toBeNull();
    expect(toast()!.classList.contains("leaving")).toBe(false);

    act(() => vi.advanceTimersByTime(4999));
    expect(toast()!.classList.contains("leaving")).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(toast()).not.toBeNull();
    expect(toast()!.classList.contains("leaving")).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(toast()).toBeNull();
  });

  it("keeps earlier toasts fading while new ones arrive", () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    fireEvent.click(getByText("push"));
    act(() => vi.advanceTimersByTime(5000));
    fireEvent.click(getByText("push"));

    const toasts = container.querySelectorAll(".toast");
    expect(toasts.length).toBe(2);
    expect(toasts[0].classList.contains("leaving")).toBe(true);
    expect(toasts[1].classList.contains("leaving")).toBe(false);

    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelectorAll(".toast").length).toBe(1);
  });
});

/** One button per kind, so a test can mix a timed success with an untimed error. */
function KindPusher() {
  const push = useToast();
  return (
    <>
      <button type="button" onClick={() => push("saved")}>
        push success
      </button>
      <button type="button" onClick={() => push("refused", "error")}>
        push error
      </button>
    </>
  );
}

/**
 * Interface review 2026-09-24 (acce-3). Every toast used to vanish after 2.6 s
 * whatever it said and whatever the pointer was doing; for most refusals the
 * toast is the only account of what went wrong.
 */
describe("toast timing and dismissal", () => {
  function renderKinds() {
    vi.useFakeTimers();
    const view = render(
      <ToastProvider>
        <KindPusher />
      </ToastProvider>,
    );
    const host = view.container.querySelector<HTMLElement>(".toast-wrap")!;
    const byKind = (kind: string) =>
      view.container.querySelector<HTMLElement>(`.toast[data-kind="${kind}"]`);
    return { ...view, host, byKind };
  }

  it("keeps an error toast until its Dismiss button is pressed", () => {
    const { getByText, byKind } = renderKinds();
    fireEvent.click(getByText("push error"));
    act(() => vi.advanceTimersByTime(60_000));
    const toast = byKind("error")!;
    expect(toast).not.toBeNull();
    expect(toast.classList.contains("leaving")).toBe(false);

    // The control is the toast's last child, named, and plays the same exit.
    const dismiss = toast.lastElementChild!;
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss.getAttribute("type")).toBe("button");
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
    fireEvent.click(dismiss);
    expect(byKind("error")!.classList.contains("leaving")).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(byKind("error")).toBeNull();
  });

  it("gives a success toast no Dismiss button", () => {
    const { getByText, byKind } = renderKinds();
    fireEvent.click(getByText("push success"));
    expect(byKind("success")!.querySelector("button")).toBeNull();
  });

  it("holds a success toast while the pointer is on the stack", () => {
    const { getByText, host, byKind } = renderKinds();
    fireEvent.click(getByText("push success"));
    act(() => vi.advanceTimersByTime(4000));
    fireEvent.pointerEnter(host);
    act(() => vi.advanceTimersByTime(20_000));
    expect(byKind("success")!.classList.contains("leaving")).toBe(false);

    // Leaving the stack gives it its full time again, not the 1 s it had left.
    fireEvent.pointerLeave(host);
    act(() => vi.advanceTimersByTime(4999));
    expect(byKind("success")!.classList.contains("leaving")).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(byKind("success")!.classList.contains("leaving")).toBe(true);
  });

  it("does not start a toast's timer while the stack is held", () => {
    const { getByText, host, byKind } = renderKinds();
    fireEvent.click(getByText("push error"));
    fireEvent.pointerEnter(host);
    fireEvent.click(getByText("push success"));
    act(() => vi.advanceTimersByTime(20_000));
    expect(byKind("success")!.classList.contains("leaving")).toBe(false);
  });

  it("holds a success toast while focus is inside the stack", () => {
    const { getByText, byKind } = renderKinds();
    fireEvent.click(getByText("push error"));
    fireEvent.click(getByText("push success"));
    const dismiss = byKind("error")!.querySelector("button")!;
    act(() => dismiss.focus());
    act(() => vi.advanceTimersByTime(20_000));
    expect(byKind("success")!.classList.contains("leaving")).toBe(false);

    act(() => getByText("push success").focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(byKind("success")!.classList.contains("leaving")).toBe(true);
  });

  it("releases the hold when the focused Dismiss button's toast is removed", () => {
    // No blur from a removed node reaches React, so without a re-read the
    // hold would stick and the success toast would never leave.
    const { getByText, byKind } = renderKinds();
    fireEvent.click(getByText("push success"));
    fireEvent.click(getByText("push error"));
    const dismiss = byKind("error")!.querySelector("button")!;
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    act(() => vi.advanceTimersByTime(200));
    expect(byKind("error")).toBeNull();

    act(() => vi.advanceTimersByTime(5000));
    expect(byKind("success")!.classList.contains("leaving")).toBe(true);
  });

  // Interface review 2026-09-24: a keyboard Dismiss used to drop focus on <body>.
  it("moves focus to the next error's Dismiss, then back to where it came from", () => {
    const { getByText, byKind } = renderKinds();
    const from = getByText("push error");
    fireEvent.click(from);
    fireEvent.click(from);
    const [first, second] = [
      ...document.querySelectorAll<HTMLButtonElement>('.toast[data-kind="error"] button'),
    ];
    act(() => from.focus());
    act(() => first!.focus());
    fireEvent.click(first!);
    expect(document.activeElement).toBe(second);
    fireEvent.click(second!);
    expect(document.activeElement).toBe(from);
    act(() => vi.advanceTimersByTime(400));
    expect(byKind("error")).toBeNull();
  });
});

/**
 * P16-UI-26. The host is the app's one `role="status"` announcer, and while a
 * modal <dialog> is open everything outside it is inert — so the live region is
 * not in the accessibility tree until `showPopover()` promotes it. Promoting it
 * in the same commit that inserts the toast means the region and its content
 * appear together, which is precisely what screen readers do not announce.
 */
describe("toast host live region", () => {
  /** Records popover calls together with how many children the host had at the
   *  moment of the call — the whole point is the ORDER of those two things. */
  function instrumentPopover() {
    const calls: string[] = [];
    const proto = HTMLElement.prototype;
    const original = { show: proto.showPopover, hide: proto.hidePopover };
    proto.showPopover = function (this: HTMLElement) {
      calls.push("show:" + this.childElementCount);
    };
    proto.hidePopover = function (this: HTMLElement) {
      calls.push("hide:" + this.childElementCount);
    };
    return {
      calls,
      restore() {
        proto.showPopover = original.show;
        proto.hidePopover = original.hide;
      },
    };
  }

  it("promotes the EMPTY region to the top layer before the toast lands", () => {
    const popover = instrumentPopover();
    try {
      const { container, getByText } = render(
        <ToastProvider>
          <Pusher />
        </ToastProvider>,
      );
      fireEvent.click(getByText("push"));
      // The promotion happens with ZERO children — that is the whole fix.
      expect(popover.calls).toEqual(["show:0"]);
      // The content arrives in a second commit, which act() has already flushed.
      expect(container.querySelectorAll(".toast").length).toBe(1);
    } finally {
      popover.restore();
    }
  });

  it("does not re-insert the region for later toasts in the same burst", () => {
    // Dropping the region out of the a11y tree and back mid-burst would cost
    // the very announcement it exists to make.
    const popover = instrumentPopover();
    try {
      const { getByText } = render(
        <ToastProvider>
          <Pusher />
        </ToastProvider>,
      );
      fireEvent.click(getByText("push"));
      fireEvent.click(getByText("push"));
      fireEvent.click(getByText("push"));
      expect(popover.calls).toEqual(["show:0"]);
    } finally {
      popover.restore();
    }
  });

  it("re-inserts itself above a dialog that opened since it was promoted", () => {
    // Top-layer order is INSERTION order (UI-34): a dialog opened after the
    // host was promoted paints — and inerts — over it.
    const popover = instrumentPopover();
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    try {
      const { getByText } = render(
        <ToastProvider>
          <Pusher />
        </ToastProvider>,
      );
      fireEvent.click(getByText("push"));
      expect(popover.calls).toEqual(["show:0"]);

      dialog.setAttribute("open", "");
      fireEvent.click(getByText("push"));
      expect(popover.calls).toEqual(["show:0", "hide:2", "show:2"]);
    } finally {
      popover.restore();
      dialog.remove();
    }
  });

  it("hides the host again once the stack drains, and re-arms on the next push", () => {
    const popover = instrumentPopover();
    try {
      vi.useFakeTimers();
      const { getByText } = render(
        <ToastProvider>
          <Pusher />
        </ToastProvider>,
      );
      fireEvent.click(getByText("push"));
      act(() => vi.advanceTimersByTime(5200));
      expect(popover.calls).toEqual(["show:0", "hide:0"]);
      // Re-armed from scratch, so the next burst gets the empty-region step
      // again rather than inheriting a stale top-layer slot.
      fireEvent.click(getByText("push"));
      expect(popover.calls).toEqual(["show:0", "hide:0", "show:0"]);
    } finally {
      popover.restore();
    }
  });

  it("announces only the toast that just landed", () => {
    // role="status" implies aria-atomic="true", which re-reads the whole stack
    // on every arrival — up to four messages for one event now that the stack
    // is capped at four.
    const { container } = render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    const host = container.querySelector(".toast-wrap")!;
    expect(host.getAttribute("role")).toBe("status");
    expect(host.getAttribute("aria-live")).toBe("polite");
    expect(host.getAttribute("aria-atomic")).toBe("false");
  });
});

/**
 * P16-UI-13. Everything else in the app caps its list; the toast stack did not,
 * so a burst grew it off the top of the viewport and the messages that
 * disappeared were the oldest — the first failure, which is the one that
 * explains the rest.
 */
describe("toast stack cap", () => {
  it("keeps at most four toasts, dropping the oldest", () => {
    vi.useFakeTimers();
    const { container, getByText } = render(
      <ToastProvider>
        <CountingPusher />
      </ToastProvider>,
    );
    for (let i = 0; i < 6; i++) fireEvent.click(getByText("push"));

    const texts = [...container.querySelectorAll(".toast")].map((t) => t.textContent);
    expect(texts).toEqual(["toast 3", "toast 4", "toast 5", "toast 6"]);
  });

  it("still plays the two-phase exit for a toast that times out normally", () => {
    // The cap must not short-circuit the leaving phase — a capped-out toast is
    // removed on the spot, but one that reaches its own 5000 ms timer still
    // fades for 200 ms first.
    vi.useFakeTimers();
    const { container, getByText } = render(
      <ToastProvider>
        <CountingPusher />
      </ToastProvider>,
    );
    for (let i = 0; i < 5; i++) fireEvent.click(getByText("push"));
    expect(container.querySelectorAll(".toast").length).toBe(4);

    act(() => vi.advanceTimersByTime(5000));
    const leaving = [...container.querySelectorAll(".toast")];
    expect(leaving.length).toBe(4);
    expect(leaving.every((t) => t.classList.contains("leaving"))).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("survives the dropped toast's own timers firing later", () => {
    // The capped-out toast keeps two armed timers; both address it by id, so
    // they must be harmless no-ops rather than clearing the wrong entry.
    vi.useFakeTimers();
    const { container, getByText } = render(
      <ToastProvider>
        <CountingPusher />
      </ToastProvider>,
    );
    fireEvent.click(getByText("push"));
    act(() => vi.advanceTimersByTime(100));
    for (let i = 0; i < 4; i++) fireEvent.click(getByText("push"));

    // "toast 1" is already gone; its timers land at 5000/5200 ms.
    act(() => vi.advanceTimersByTime(5000));
    const texts = [...container.querySelectorAll(".toast")].map((t) => t.textContent);
    expect(texts).toEqual(["toast 2", "toast 3", "toast 4", "toast 5"]);
  });
});
