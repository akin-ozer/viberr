// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DueDatePill, LabelChips, PriorityFlag } from "./task-meta";

/**
 * The shared task-metadata renderers (priority flag, label chips, due-date
 * pill). The overdue branch reads the viewer's local clock, so each pill test
 * that depends on it freezes `Date` on the day it names.
 */

afterEach(cleanup);

describe("PriorityFlag", () => {
  it("renders nothing for the default `normal`", () => {
    const { container } = render(<PriorityFlag priority="normal" />);
    expect(container.textContent).toBe("");
  });

  it("labels low / high / urgent", () => {
    for (const [p, label] of [
      ["low", "low"],
      ["high", "high"],
      ["urgent", "urgent"],
    ] as const) {
      const { container } = render(<PriorityFlag priority={p} />);
      expect(container.textContent).toContain(label);
      cleanup();
    }
  });
});

describe("LabelChips", () => {
  it("renders nothing for an empty set", () => {
    const { container } = render(<LabelChips labels={[]} />);
    expect(container.textContent).toBe("");
  });

  it("caps the visible chips and folds the rest into +N", () => {
    const { container } = render(
      <LabelChips labels={["a", "b", "c", "d", "e"]} max={3} />,
    );
    const chips = container.querySelectorAll(".label-chip");
    // 3 shown + 1 "+2" overflow chip.
    expect(chips).toHaveLength(4);
    expect(container.textContent).toContain("+2");
  });

  it("names the folded labels in the accessibility tree, not only in `title`", () => {
    // Phase 1 (2026-09-08): "+2" on its own tells a screen-reader user that two
    // labels exist and never which ones. `title` on a role-less span is not a
    // dependable accessible name and is unreachable by touch and keyboard, so
    // the folded set is also carried in a visually-hidden span. `title` stays —
    // it is the sighted pointer user's hover, a different audience.
    const { container } = render(
      <LabelChips labels={["alpha", "beta", "gamma", "delta", "epsilon"]} max={3} />,
    );
    const more = container.querySelector(".label-chip.more");
    expect(more).toBeTruthy();
    expect(more!.getAttribute("title")).toBe("delta, epsilon");
    const announced = more!.querySelector(".vh");
    expect(announced, "the folded labels must reach the a11y tree").toBeTruthy();
    expect(announced!.textContent).toBe("delta, epsilon");
    // The shown labels stay out of the hidden list — it names the fold, not
    // the whole set, so nothing is announced twice.
    expect(announced!.textContent).not.toContain("alpha");
  });
});

describe("DueDatePill", () => {
  /** The viewer's clock on `iso` (`YYYY-MM-DD`), at local noon. */
  function onDay(iso: string) {
    const [y, m, d] = iso.split("-").map(Number);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(y!, m! - 1, d!, 12));
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing without a due date", () => {
    const { container } = render(<DueDatePill dueDate={null} />);
    expect(container.textContent).toBe("");
  });

  it("is neutral and reads `due` when not overdue", () => {
    onDay("2026-09-01");
    const { container } = render(<DueDatePill dueDate="2026-09-10" />);
    expect(container.textContent).toContain("due Sep 10");
    expect(container.querySelector(".pill.blocked")).toBeNull();
  });

  it("is red and reads `overdue` past the date", () => {
    onDay("2026-09-01");
    const { container } = render(<DueDatePill dueDate="2026-08-20" />);
    expect(container.textContent).toContain("overdue");
    expect(container.querySelector(".pill.blocked")).not.toBeNull();
  });

  it("reads `due` on the day itself — today is not overdue", () => {
    onDay("2026-08-23");
    const { container } = render(<DueDatePill dueDate="2026-08-23" />);
    expect(container.textContent).toContain("due Aug 23");
    expect(container.querySelector(".pill.blocked")).toBeNull();
  });

  it("prints an unpadded day, and a date it cannot read as written", () => {
    onDay("2025-12-01");
    const { container, rerender } = render(<DueDatePill dueDate="2026-01-01" />);
    expect(container.textContent).toContain("due Jan 1");
    rerender(<DueDatePill dueDate="garbage" />);
    expect(container.textContent).toContain("due garbage");
  });
});
