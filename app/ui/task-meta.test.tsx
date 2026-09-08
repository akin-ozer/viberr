// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  DueDatePill,
  LabelChips,
  PriorityFlag,
  formatDueDate,
  hasVisibleMeta,
  isOverdue,
} from "./task-meta";

/**
 * The shared task-metadata renderers (priority flag, label chips, due-date
 * pill) and their pure helpers. The overdue branch is time-dependent, so every
 * pill test passes an explicit `today` — the component only reaches for the
 * viewer's local clock when no `today` is given (see DueDatePill's hydration note).
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
  it("renders nothing without a due date", () => {
    const { container } = render(<DueDatePill dueDate={null} today="2026-09-01" />);
    expect(container.textContent).toBe("");
  });

  it("is neutral and reads `due` when not overdue", () => {
    const { container } = render(
      <DueDatePill dueDate="2026-09-10" today="2026-09-01" />,
    );
    expect(container.textContent).toContain("due Sep 10");
    expect(container.querySelector(".pill.blocked")).toBeNull();
  });

  it("is red and reads `overdue` past the date", () => {
    const { container } = render(
      <DueDatePill dueDate="2026-08-20" today="2026-09-01" />,
    );
    expect(container.textContent).toContain("overdue");
    expect(container.querySelector(".pill.blocked")).not.toBeNull();
  });
});

describe("pure helpers", () => {
  it("formatDueDate renders a fixed Mon D vocabulary, tolerating garbage", () => {
    expect(formatDueDate("2026-08-23")).toBe("Aug 23");
    expect(formatDueDate("2026-01-01")).toBe("Jan 1");
    expect(formatDueDate("garbage")).toBe("garbage");
  });

  it("isOverdue compares plain dates lexically", () => {
    expect(isOverdue("2026-08-20", "2026-08-23")).toBe(true);
    expect(isOverdue("2026-08-23", "2026-08-23")).toBe(false); // today is not overdue
    expect(isOverdue("2026-08-25", "2026-08-23")).toBe(false);
    expect(isOverdue(null, "2026-08-23")).toBe(false);
  });

  it("hasVisibleMeta is true only for non-default metadata", () => {
    expect(hasVisibleMeta({ priority: "normal", labels: [], dueDate: null })).toBe(
      false,
    );
    expect(hasVisibleMeta({ priority: "high", labels: [], dueDate: null })).toBe(
      true,
    );
    expect(hasVisibleMeta({ priority: "normal", labels: ["x"], dueDate: null })).toBe(
      true,
    );
    expect(
      hasVisibleMeta({ priority: "normal", labels: [], dueDate: "2026-09-01" }),
    ).toBe(true);
  });
});
