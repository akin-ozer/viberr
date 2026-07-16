// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";

/**
 * Two-phase toast dismissal: a pushed toast lives 2600 ms, then carries
 * `.leaving` for 200 ms (CSS plays the exit fade, mirroring the `rise`
 * entrance path) before unmounting.
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

describe("toast lifecycle", () => {
  it("marks the toast .leaving at 2600 ms and unmounts it 200 ms later", () => {
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

    act(() => vi.advanceTimersByTime(2600));
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
    act(() => vi.advanceTimersByTime(2600));
    fireEvent.click(getByText("push"));

    const toasts = container.querySelectorAll(".toast");
    expect(toasts.length).toBe(2);
    expect(toasts[0].classList.contains("leaving")).toBe(true);
    expect(toasts[1].classList.contains("leaving")).toBe(false);

    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelectorAll(".toast").length).toBe(1);
  });
});
