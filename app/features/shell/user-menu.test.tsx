// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
