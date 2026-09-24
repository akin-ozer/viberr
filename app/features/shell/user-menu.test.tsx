// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { staticPackagesOf } from "../../../test-support/static-imports";
import { UserMenu } from "./user-menu";

/**
 * Ruling 454: pages ship the account menu's trigger only; the Radix menu
 * (ruling 166) is fetched on intent or on the first press. The trigger must
 * look and read the same as the one it stands in for, a press that beats the
 * fetch must still open the menu, and the keyboard contract Radix gives
 * (focus on the first item, arrows, Escape back to the trigger) must hold
 * from the very first open.
 */

afterEach(cleanup);

function mount() {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <UserMenu
            user={{
              id: "u",
              name: "Arda Kaya",
              email: "arda@viberr.dev",
              role: "admin",
              avatarTone: "",
            }}
            theme="system"
          />
        </ToastProvider>
      ),
    },
    { path: "/prefs/theme", action: () => ({ ok: true, theme: "light" }) },
  ]);
  const view = render(<Stub initialEntries={["/"]} />);
  const plain = view.container.querySelector<HTMLButtonElement>(".home-user")!;
  // Radix stamps `data-state` on its trigger; the first render never has it.
  expect(plain.hasAttribute("data-state"), "the first render is the plain trigger").toBe(false);
  return { ...view, plain };
}

const radixTrigger = (container: HTMLElement) =>
  waitFor(() => {
    const trigger = container.querySelector<HTMLButtonElement>(".home-user[data-state]");
    if (!trigger) throw new Error("the menu module has not arrived yet");
    return trigger;
  });

/** What decides the trigger's box, look and name. */
function triggerMarkup(trigger: HTMLElement) {
  return {
    tag: trigger.tagName,
    type: trigger.getAttribute("type"),
    className: trigger.className,
    label: trigger.getAttribute("aria-label"),
    haspopup: trigger.getAttribute("aria-haspopup"),
    expanded: trigger.getAttribute("aria-expanded"),
    content: trigger.innerHTML,
  };
}

describe("the account menu's trigger (ruling 454)", () => {
  it("is the Radix trigger's twin, and hovering it brings the menu in closed", async () => {
    const { container, plain } = mount();
    const before = triggerMarkup(plain);
    fireEvent.pointerEnter(plain);
    const trigger = await radixTrigger(container);
    expect(triggerMarkup(trigger)).toEqual(before);
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // From here on every interaction is Radix's own: a press opens at once.
    fireEvent.pointerDown(trigger, { button: 0 });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("opens from the keyboard before the menu arrives, focus on the first item", async () => {
    const { container, plain } = mount();
    fireEvent.keyDown(plain, { key: "Enter" });
    const first = await waitFor(() => {
      const item = container.querySelector<HTMLElement>('[role="menuitem"]');
      if (!item) throw new Error("the menu has not opened yet");
      return item;
    });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.textContent).toContain("Profile");
    // Radix's arrows work from that first open (it moves focus on a timer)…
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Switch theme"));
    // …and Escape closes it with the focus back on the trigger.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector(".home-user")),
    );
  });

  it("keeps the focus a Tab put on it when the Radix trigger replaces it", async () => {
    const { container, plain } = mount();
    plain.focus();
    const trigger = await radixTrigger(container);
    expect(trigger).not.toBe(plain);
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

/**
 * Review finding UM-PENDING-OPEN: a press that beats the menu's chunk opens
 * the menu when the chunk lands, and before this nothing could take that
 * press back. Escape, a second press, or moving on (focus or a press
 * elsewhere) now cancel it, so a late menu never opens on its own and pulls
 * the focus away from wherever the person went.
 *
 * Each test mounts a fresh copy of the module (`vi.resetModules`), so its
 * chunk is really still on the way: nothing below awaits before the pending
 * press is cancelled, and an `import()` cannot settle inside synchronous code.
 */
describe("a press before the menu arrives can be taken back (ruling 454)", () => {
  async function mountFresh() {
    vi.resetModules();
    const { UserMenu: FreshMenu } = await import("./user-menu");
    // The menu reads the toast context of the same (fresh) module registry.
    const { ToastProvider: FreshToasts } = await import("~/ui/toast");
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <FreshToasts>
            <input aria-label="Search" />
            <p>Page text</p>
            <FreshMenu
              user={{ id: "u", name: "Arda Kaya", email: "arda@viberr.dev", role: "admin", avatarTone: "" }}
              theme="system"
            />
          </FreshToasts>
        ),
      },
    ]);
    const view = render(<Stub initialEntries={["/"]} />);
    const plain = view.container.querySelector<HTMLButtonElement>(".home-user")!;
    expect(plain.hasAttribute("data-state"), "the first render is the plain trigger").toBe(false);
    const search = view.container.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
    const text = view.getByText("Page text");
    return { ...view, plain, search, text };
  }

  /** Waits for the menu's chunk: the Radix trigger has replaced the plain one. */
  async function arrived(container: HTMLElement) {
    const trigger = await radixTrigger(container);
    // Radix's own open and focus-on-open run in effects after that commit.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    return trigger;
  }

  it("Escape takes back a keyboard open", async () => {
    const { container, plain } = await mountFresh();
    act(() => plain.focus());
    fireEvent.keyDown(plain, { key: "Enter" });
    expect(plain.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(plain, { key: "Escape" });
    expect(plain.getAttribute("aria-expanded")).toBe("false");
    const trigger = await arrived(container);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // The focus the Tab put on the trigger is still on the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it("a second press takes back the first", async () => {
    const { container, plain } = await mountFresh();
    fireEvent.pointerDown(plain, { button: 0 });
    expect(plain.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(plain, { button: 0 });
    expect(plain.getAttribute("aria-expanded")).toBe("false");
    await arrived(container);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("moving the focus on takes back a keyboard open", async () => {
    const { container, plain, search } = await mountFresh();
    act(() => plain.focus());
    fireEvent.keyDown(plain, { key: "Enter" });
    act(() => search.focus());
    expect(plain.getAttribute("aria-expanded")).toBe("false");
    await arrived(container);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it("a press into the search takes back a pointer open", async () => {
    const { container, plain, search } = await mountFresh();
    fireEvent.pointerDown(plain, { button: 0 });
    // A click: the press, then the focus it gives.
    fireEvent.pointerDown(search, { button: 0 });
    fireEvent.mouseDown(search, { button: 0 });
    act(() => search.focus());
    expect(plain.getAttribute("aria-expanded")).toBe("false");
    await arrived(container);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // The keystrokes that follow go to the search, not to menu typeahead.
    expect(document.activeElement).toBe(search);
  });

  it("a press on the page takes back a pointer open, though it moves no focus", async () => {
    const { container, plain, text } = await mountFresh();
    fireEvent.pointerDown(plain, { button: 0 });
    fireEvent.pointerDown(text, { button: 0 });
    fireEvent.mouseDown(text, { button: 0 });
    expect(plain.getAttribute("aria-expanded")).toBe("false");
    await arrived(container);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("a press left alone still opens the menu when it arrives", async () => {
    const { container, plain } = await mountFresh();
    fireEvent.pointerDown(plain, { button: 0 });
    await arrived(container);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe("Home and the workspace ship without Radix (ruling 454)", () => {
  it("reaches no radix-ui through a static import", () => {
    for (const route of ["app/routes/_index.tsx", "app/routes/project.tsx"]) {
      expect(staticPackagesOf(route).has("radix-ui"), route).toBe(false);
    }
  });

  it("the walk does see Radix where it is imported statically", () => {
    expect(staticPackagesOf("app/features/shell/user-menu-panel.tsx").has("radix-ui")).toBe(true);
  });
});
