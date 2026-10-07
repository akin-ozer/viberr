// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Calendar, fromISODate, toISODate } from "./calendar";

afterEach(cleanup);

describe("calendar date helpers", () => {
  it("round-trips YYYY-MM-DD through a LOCAL date (no UTC roll)", () => {
    const d = fromISODate("2026-08-23")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August
    expect(d.getDate()).toBe(23);
    expect(toISODate(d)).toBe("2026-08-23");
  });

  it("rejects malformed / impossible dates", () => {
    expect(fromISODate("2026-02-31")).toBeNull();
    expect(fromISODate("nope")).toBeNull();
    expect(fromISODate(null)).toBeNull();
  });
});

describe("Calendar", () => {
  it("renders a 6×7 grid with weekday headers and the month caption", () => {
    const { container, getByText } = render(
      <Calendar selected="2026-08-23" onSelect={() => {}} today="2026-08-23" />,
    );
    expect(getByText("August 2026")).toBeTruthy();
    expect(container.querySelectorAll("th")).toHaveLength(7);
    expect(container.querySelectorAll(".cal-day")).toHaveLength(42);
  });

  it("marks today and the selected day", () => {
    const { container } = render(
      <Calendar selected="2026-08-10" onSelect={() => {}} today="2026-08-23" />,
    );
    const sel = container.querySelector('.cal-day.sel[data-iso="2026-08-10"]');
    const today = container.querySelector('.cal-day.today[data-iso="2026-08-23"]');
    expect(sel).toBeTruthy();
    // On the gridcell, which supports it; a button ignores `aria-selected`.
    expect(sel!.closest('[role="gridcell"]')!.getAttribute("aria-selected")).toBe("true");
    expect(sel!.hasAttribute("aria-selected")).toBe(false);
    expect(today).toBeTruthy();
  });

  it("emits the clicked day as YYYY-MM-DD", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Calendar selected={null} onSelect={onSelect} today="2026-08-23" />,
    );
    fireEvent.click(container.querySelector('.cal-day[data-iso="2026-08-15"]')!);
    expect(onSelect).toHaveBeenCalledWith("2026-08-15");
  });

  it("navigates months with the prev/next controls", () => {
    const { container, getByText, getByLabelText } = render(
      <Calendar selected={null} onSelect={() => {}} today="2026-08-23" />,
    );
    fireEvent.click(getByLabelText("Go to next month"));
    expect(getByText("September 2026")).toBeTruthy();
    fireEvent.click(getByLabelText("Go to previous month"));
    fireEvent.click(getByLabelText("Go to previous month"));
    expect(getByText("July 2026")).toBeTruthy();
    // outside days from adjacent months are muted.
    expect(container.querySelector(".cal-day.out")).toBeTruthy();
  });

  it("ArrowRight then Enter selects the next day", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Calendar selected="2026-08-23" onSelect={onSelect} today="2026-08-23" />,
    );
    const grid = container.querySelector('[role="grid"]')!;
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("2026-08-24");
  });
});
