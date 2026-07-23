// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StageMenu, type StageOption } from "./stage-menu";

/**
 * F10-25 — dragging a card between columns is POINTER-ONLY, so the stage menu
 * is the sole way a keyboard user can move a task. That makes its ARIA menu
 * contract load-bearing, not decoration: focus must land inside the menu on
 * open, roving Arrow/Home/End must skip the disabled current stage, and Escape
 * must both close the menu and RETURN focus to the trigger (otherwise the user
 * is silently dumped at the top of the document and loses their place).
 *
 * Enter/Space activation is deliberately not asserted here — these are real
 * `<button>`s, so activation is the browser's native default action rather
 * than app code.
 */

afterEach(cleanup);

const STAGES: StageOption[] = [
  { id: "triage", name: "Triage", color: "#888" },
  { id: "ready", name: "Ready", color: "#3c8" },
  { id: "in-progress", name: "In Progress", color: "#86f" },
  { id: "review", name: "Review", color: "#58f" },
  { id: "done", name: "Done", color: "#3a7" },
];

/** Render with `ready` current, so the disabled item sits mid-list. */
function renderMenu(overrides: Partial<Parameters<typeof StageMenu>[0]> = {}) {
  const onSelect = vi.fn();
  const view = render(
    <StageMenu
      stages={STAGES}
      currentStageId="ready"
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { ...view, onSelect };
}

function trigger(view: ReturnType<typeof renderMenu>) {
  return view.getByLabelText("Change stage (currently Ready)");
}

function openMenu(view: ReturnType<typeof renderMenu>) {
  fireEvent.click(trigger(view));
  return document.querySelector<HTMLDivElement>('[role="menu"]')!;
}

/** Enabled items only — the order roving focus actually walks. */
function enabledNames(menu: HTMLElement): string[] {
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>("button.sm-item:not([disabled])"),
  ).map((b) => b.textContent!.trim());
}

function activeName(): string {
  return (document.activeElement as HTMLElement).textContent!.trim();
}

describe("StageMenu keyboard contract (F10-25)", () => {
  it("opens with focus on the first selectable stage and disables the current one", () => {
    const view = renderMenu();
    expect(trigger(view).getAttribute("aria-expanded")).toBe("false");

    const menu = openMenu(view);
    expect(trigger(view).getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("aria-label")).toBe("Move to stage");

    // The current stage is present but not selectable — you cannot "move" to
    // where you already are.
    const current = view.getByRole("menuitemradio", {
      name: /Ready/,
    }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(enabledNames(menu)).toEqual([
      "Triage",
      "In Progress",
      "Review",
      "Done",
    ]);

    // Focus is inside the menu, so Arrow navigation has an anchor.
    expect(activeName()).toBe("Triage");
  });

  it("ArrowDown/ArrowUp rove and wrap, skipping the disabled current stage", () => {
    const view = renderMenu();
    const menu = openMenu(view);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Skips "Ready" (disabled) entirely rather than parking on it.
    expect(activeName()).toBe("In Progress");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeName()).toBe("Review");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeName()).toBe("In Progress");

    // Wrap backwards off the top.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeName()).toBe("Triage");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeName()).toBe("Done");

    // Wrap forwards off the bottom.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeName()).toBe("Triage");
  });

  it("Home/End jump to the first and last selectable stages", () => {
    const view = renderMenu();
    const menu = openMenu(view);

    fireEvent.keyDown(menu, { key: "End" });
    expect(activeName()).toBe("Done");

    fireEvent.keyDown(menu, { key: "Home" });
    expect(activeName()).toBe("Triage");
  });

  it("Escape closes the menu AND returns focus to the trigger", () => {
    const view = renderMenu();
    const menu = openMenu(view);
    expect(activeName()).toBe("Triage");

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger(view).getAttribute("aria-expanded")).toBe("false");
    // The keyboard user keeps their place instead of landing on <body>.
    expect(document.activeElement).toBe(trigger(view));
  });

  it("picking a stage reports it, closes, and returns focus to the trigger", () => {
    const view = renderMenu();
    openMenu(view);

    fireEvent.click(view.getByRole("menuitemradio", { name: /In Progress/ }));

    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith("in-progress");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
  });

  it("a busy menu does not open (no stage moves while one is in flight)", () => {
    const view = renderMenu({ busy: true });
    fireEvent.click(trigger(view));

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect((trigger(view) as HTMLButtonElement).disabled).toBe(true);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("the trigger names the current stage for screen readers", () => {
    const view = renderMenu({ currentStageId: "done" });
    expect(view.getByLabelText("Change stage (currently Done)")).toBeTruthy();
  });
});
