// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDismiss, type DismissOptions } from "./use-dismiss";

afterEach(() => cleanup());

function Harness({
  options,
  onDismiss,
}: {
  options?: DismissOptions;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const ref = useDismiss<HTMLDivElement>(open, () => {
    setOpen(false);
    onDismiss?.();
  }, options);
  return (
    <div>
      <button type="button" data-testid="outside">
        outside
      </button>
      {open && (
        <div ref={ref} data-testid="pop">
          <button type="button" data-testid="inside">
            inside
          </button>
        </div>
      )}
    </div>
  );
}

/** Trigger rendered OUTSIDE the popover element — the portaled-menu shape. */
function DetachedHarness() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false), {
    also: [triggerRef],
  });
  return (
    <div>
      <button type="button" ref={triggerRef} data-testid="trigger">
        trigger
      </button>
      <button type="button" data-testid="outside">
        outside
      </button>
      {open && <div ref={ref} data-testid="pop" />}
    </div>
  );
}

describe("useDismiss", () => {
  it("closes on a press outside and stays open for a press inside", () => {
    const r = render(<Harness />);
    fireEvent.mouseDown(r.getByTestId("inside"));
    expect(r.queryByTestId("pop")).not.toBeNull();
    fireEvent.mouseDown(r.getByTestId("outside"));
    expect(r.queryByTestId("pop")).toBeNull();
  });

  it("closes on Escape and ignores every other key", () => {
    const r = render(<Harness />);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(r.queryByTestId("pop")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(r.queryByTestId("pop")).toBeNull();
  });

  it("outside:false keeps an outside press from closing but keeps Escape", () => {
    const r = render(<Harness options={{ outside: false }} />);
    fireEvent.mouseDown(r.getByTestId("outside"));
    expect(r.queryByTestId("pop")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(r.queryByTestId("pop")).toBeNull();
  });

  it("focus:true also closes when the focus moves outside, and not when it moves inside", () => {
    const plain = render(<Harness />);
    fireEvent.focusIn(plain.getByTestId("outside"));
    expect(plain.queryByTestId("pop"), "off by default").not.toBeNull();
    cleanup();

    const r = render(<Harness options={{ focus: true }} />);
    fireEvent.focusIn(r.getByTestId("inside"));
    expect(r.queryByTestId("pop")).not.toBeNull();
    fireEvent.focusIn(r.getByTestId("outside"));
    expect(r.queryByTestId("pop")).toBeNull();
  });

  it("`also` refs count as inside, so pressing a detached trigger does not close", () => {
    const r = render(<DetachedHarness />);
    fireEvent.mouseDown(r.getByTestId("trigger"));
    expect(r.queryByTestId("pop")).not.toBeNull();
    fireEvent.mouseDown(r.getByTestId("outside"));
    expect(r.queryByTestId("pop")).toBeNull();
  });

  it("onReflow closes on a scroll in any container and on resize; off by default", () => {
    const plain = render(<Harness />);
    fireEvent(plain.getByTestId("inside"), new Event("scroll"));
    fireEvent(window, new Event("resize"));
    expect(plain.queryByTestId("pop")).not.toBeNull();
    cleanup();

    // A non-bubbling scroll on a nested element: only a capture-phase window
    // listener sees it, which is the case StageMenu's column scroll needs.
    const scrolled = render(<Harness options={{ onReflow: true }} />);
    fireEvent(scrolled.getByTestId("inside"), new Event("scroll"));
    expect(scrolled.queryByTestId("pop")).toBeNull();
    cleanup();

    const resized = render(<Harness options={{ onReflow: true }} />);
    fireEvent(window, new Event("resize"));
    expect(resized.queryByTestId("pop")).toBeNull();
  });

  it("subscribes nothing while closed and unsubscribes everything on unmount", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    try {
      const r = render(<Harness options={{ onReflow: true }} />);
      const added = add.mock.calls.filter(
        ([type]) => type === "mousedown" || type === "keydown",
      ).length;
      expect(added).toBe(2);
      // Closing the popover must tear the listeners down, not just hide it.
      fireEvent.keyDown(document, { key: "Escape" });
      const removed = remove.mock.calls.filter(
        ([type]) => type === "mousedown" || type === "keydown",
      ).length;
      expect(removed).toBe(2);
      // …and no new subscription while closed.
      expect(
        add.mock.calls.filter(
          ([type]) => type === "mousedown" || type === "keydown",
        ).length,
      ).toBe(2);
      r.unmount();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
