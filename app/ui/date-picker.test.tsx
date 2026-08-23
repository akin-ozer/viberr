// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DatePicker } from "./date-picker";

afterEach(cleanup);

function Harness({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div>
      <DatePicker value={value} onChange={setValue} />
      <output data-testid="value">{value ?? "none"}</output>
    </div>
  );
}

const trigger = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".datepick-trigger")!;
const popover = () => document.querySelector(".datepick-pop");

describe("DatePicker", () => {
  it("shows a placeholder when empty and the formatted date when set", () => {
    const empty = render(<DatePicker value={null} onChange={() => {}} />);
    expect(trigger(empty.container).textContent).toContain("Pick a date");
    cleanup();
    const set = render(<DatePicker value="2026-08-30" onChange={() => {}} />);
    expect(trigger(set.container).textContent).toContain("Aug 30, 2026");
  });

  it("opens the calendar popover on click and picks a day", () => {
    const { container, getByTestId } = render(<Harness initial="2026-08-10" />);
    expect(popover()).toBeNull();
    fireEvent.click(trigger(container));
    expect(popover()).toBeTruthy();
    // Pick the 15th from the portaled calendar.
    fireEvent.click(popover()!.querySelector('.cal-day[data-iso="2026-08-15"]')!);
    expect(getByTestId("value").textContent).toBe("2026-08-15");
    // Selecting closes the popover.
    expect(popover()).toBeNull();
  });

  it("Escape closes the popover without changing the value", () => {
    const { container, getByTestId } = render(<Harness initial="2026-08-10" />);
    fireEvent.click(trigger(container));
    fireEvent.keyDown(popover()!, { key: "Escape" });
    expect(popover()).toBeNull();
    expect(getByTestId("value").textContent).toBe("2026-08-10");
  });

  it("the clear button resets to null", () => {
    const { getByLabelText, getByTestId } = render(<Harness initial="2026-08-10" />);
    fireEvent.click(getByLabelText("Clear date"));
    expect(getByTestId("value").textContent).toBe("none");
  });

  it("an outside press dismisses the popover", () => {
    const { container } = render(<Harness />);
    fireEvent.click(trigger(container));
    expect(popover()).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(popover()).toBeNull();
  });
});
