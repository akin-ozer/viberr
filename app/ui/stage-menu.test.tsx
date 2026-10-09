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
  { id: "triage", name: "Triage", color: "gray" },
  { id: "ready", name: "Ready", color: "emerald" },
  { id: "in-progress", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
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
  // SAFETY: the only element carrying this label is StageMenu's own
  // `<button type="button" className="stage-menu-btn">` trigger (stage-menu.tsx);
  // the bound query cannot be told that element type, so it is stated here.
  return view.getByLabelText("Change stage (currently Ready)") as HTMLButtonElement;
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
  return document.activeElement!.textContent!.trim();
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
    // SAFETY: every `menuitemradio` in this menu is a `<button>` — StageMenu
    // renders one per stage and gives the current one `disabled` (stage-menu.tsx).
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
    expect(trigger(view).disabled).toBe(true);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("the trigger names the current stage for screen readers", () => {
    const view = renderMenu({ currentStageId: "done" });
    expect(view.getByLabelText("Change stage (currently Done)")).toBeTruthy();
  });

  it("ruling 291: a stage the project no longer lists is named, in one wording", () => {
    const view = renderMenu({ currentStageId: "ghost" });
    // The visible label was a "−" (a cleared control) while the accessible name
    // said "unknown", so the name did not contain the label. Both now say the
    // same words the board row, task page and archive dialog use.
    const btn = view.getByLabelText("Change stage (currently unknown stage)");
    expect(btn.querySelector(".sm-name")!.textContent).toBe("unknown stage");
  });
});

/**
 * P16-UI-12 — the hand-rolled "Escape or an outside press closes me" effect was
 * replaced by the shared `useDismiss` hook. The three behaviours it carried are
 * asserted here because the conversion is exactly the kind of change that looks
 * like a no-op and is not: this popover is PORTALED to <body>, so the trigger is
 * outside the hook's own ref, and it is FIXED-positioned from the trigger's
 * rect, so it has to close when anything scrolls.
 */
describe("StageMenu dismissal (shared useDismiss)", () => {
  it("an outside press closes it", () => {
    const view = renderMenu();
    openMenu(view);
    fireEvent.mouseDown(document.body);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("a press on the TRIGGER does not dismiss-then-reopen", () => {
    // The popover is portaled to <body>, so without `also: [btnRef]` the
    // trigger counts as "outside" and the toggle would fight the dismiss.
    const view = renderMenu();
    openMenu(view);
    fireEvent.mouseDown(trigger(view));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("a press inside the menu does not close it", () => {
    const view = renderMenu();
    const menu = openMenu(view);
    fireEvent.mouseDown(menu.querySelector(".sm-head")!);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("a scroll ANYWHERE closes it — the position is a stale rect otherwise", () => {
    // capture:true, because the board column scrolls, not the window.
    const view = renderMenu();
    openMenu(view);
    fireEvent.scroll(document.body);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("the Escape that closes it is consumed, so an enclosing dialog does not cancel too", () => {
    const view = renderMenu();
    openMenu(view);
    // fireEvent returns dispatchEvent's answer: false when the default was prevented.
    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("subscribes nothing while closed", () => {
    const add = vi.spyOn(document, "addEventListener");
    const view = renderMenu();
    expect(
      add.mock.calls.filter(([type]) => type === "mousedown" || type === "keydown"),
    ).toEqual([]);
    openMenu(view);
    expect(
      add.mock.calls.filter(([type]) => type === "mousedown" || type === "keydown")
        .length,
    ).toBe(2);
    add.mockRestore();
  });
});

/**
 * Interface review 2026-09-24 (layo-8) — the menu always opened downward with
 * no vertical clamp, so a trigger near the viewport's bottom put stages
 * off-screen, and scrolling them back closes the menu. jsdom has no layout, so
 * the trigger's rect, the menu's height and the viewport are stated.
 */
describe("StageMenu placement (layo-8)", () => {
  const MENU_HEIGHT = 178;

  function placeAt(triggerTop: number, viewportHeight = 768) {
    vi.stubGlobal("innerHeight", viewportHeight);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(MENU_HEIGHT);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 400, y: triggerTop, width: 24, height: 24 }),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens below the trigger when the menu fits there", () => {
    placeAt(100);
    const menu = openMenu(renderMenu());
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(menu.style.top).toBe("130px");
    expect(menu.style.maxHeight).toBe("");
  });

  it("opens above the trigger when there is no room below", () => {
    // The last list row on a desktop: 44px under the trigger, 700 above it.
    placeAt(700);
    const menu = openMenu(renderMenu());
    expect(menu.getAttribute("data-side")).toBe("top");
    expect(menu.style.top).toBe(`${700 - 6 - MENU_HEIGHT}px`);
    expect(menu.style.maxHeight).toBe("");
    // Focus still lands on the first selectable stage, now on-screen.
    expect(activeName()).toBe("Triage");
  });

  it("ruling 309(a): a property row's menu hangs from the trigger's left edge, a card's from its right", () => {
    // CANARY: drop the `align` arm and the task page's menu opens 166px left
    // of its trigger, over the row's label.
    placeAt(100);
    expect(openMenu(renderMenu({ align: "start" })).style.left).toBe("400px");
    cleanup();
    // The board card's trigger ends the card's head: the menu's right edge
    // meets the trigger's (the 24px trigger, the menu's 190px floor).
    expect(openMenu(renderMenu()).style.left).toBe(`${400 + 24 - 190}px`);
  });

  it("clamps into the viewport and caps its height when neither side fits", () => {
    // A 300px-tall viewport with the trigger mid-way: 122px below, 126 above.
    placeAt(140, 300);
    const menu = openMenu(renderMenu());
    expect(menu.getAttribute("data-side")).toBe("top");
    expect(menu.style.top).toBe("8px");
    // Its bottom edge stops 6px above the trigger; the list scrolls inside.
    expect(menu.style.maxHeight).toBe(`${140 - 6 - 8}px`);
  });
});

/**
 * Interface review 2026-09-24 (acce-17) — a card's slot within its lane could
 * be set only by dragging. The board card passes `onReorder`, and the menu then
 * offers Move up / Move down after the stages, walked by the same keys.
 */
describe("StageMenu reorder items (acce-17)", () => {
  it("renders none unless the caller asks (task detail passes nothing)", () => {
    const view = renderMenu();
    openMenu(view);
    expect(view.queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "Move down" })).toBeNull();
  });

  it("follows the stages, skips a disabled edge, and focus still opens on a stage", () => {
    const onReorder = vi.fn();
    const view = renderMenu({ onReorder, canMoveUp: false, canMoveDown: true });
    const menu = openMenu(view);

    // SAFETY: StageMenu renders both reorder items as `<button role="menuitem">`.
    const up = view.getByRole("menuitem", { name: "Move up" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(enabledNames(menu)).toEqual([
      "Triage",
      "In Progress",
      "Review",
      "Done",
      "Move down",
    ]);
    expect(activeName()).toBe("Triage");

    fireEvent.keyDown(menu, { key: "End" });
    expect(activeName()).toBe("Move down");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeName()).toBe("Done");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Wraps from the last item back to the first stage.
    expect(activeName()).toBe("Triage");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("a nudge reports its direction, closes, and returns focus to the trigger", () => {
    const onReorder = vi.fn();
    const view = renderMenu({ onReorder, canMoveUp: true, canMoveDown: false });
    openMenu(view);

    fireEvent.click(view.getByRole("menuitem", { name: "Move up" }));

    expect(onReorder).toHaveBeenCalledExactlyOnceWith(-1);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
  });
});
