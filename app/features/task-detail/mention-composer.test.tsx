// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { Timeline } from "./timeline";

/**
 * jsdom behavior test for the comment composer's @-mention autocomplete:
 * typing "@de" opens a dropdown listing "dev" with "de" highlighted;
 * ArrowDown+Enter inserts "@dev "; Escape closes; a bare "@" does not open.
 * The composer renders inside a route stub so its useFetcher/useSearchParams
 * hooks have a data router.
 */

afterEach(cleanup);

const MENTIONABLES: Mentionables = {
  agents: [{ handle: "dev", name: "dev", role: "developer", backend: "claude" }],
  users: [{ handle: "arda", name: "Arda Kaya", email: "arda@viberr.test" }],
  reserved: [
    { handle: "operator", label: "Operator" },
    { handle: "agent", label: "Primary specialist" },
    { handle: "claude", label: "Claude specialist" },
    { handle: "codex", label: "Codex specialist" },
  ],
};

function renderComposer() {
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <Timeline
            events={[]}
            hasMore={false}
            remaining={0}
            nextLimit={40}
            tlDefault="all"
            ask={0}
            mentionables={MENTIONABLES}
          />
        </ToastProvider>
      ),
      action: async () => ({ ok: true }),
    },
  ]);
  const utils = render(<Stub initialEntries={["/t"]} />);
  const ta = utils.container.querySelector("textarea") as HTMLTextAreaElement;
  return { ...utils, ta };
}

/** Type `value` into the textarea and place the caret at its end. */
function type(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, { target: { value } });
  ta.setSelectionRange(value.length, value.length);
  // The composer recomputes on keyUp (rAF from onChange is flaky in jsdom).
  fireEvent.keyUp(ta);
}

const listbox = () => document.querySelector('[role="listbox"]');

describe("comment composer @-mention autocomplete", () => {
  it("opens a dropdown listing matching agents when typing @de", async () => {
    const { ta } = renderComposer();
    type(ta, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    // "dev" is listed…
    const devRow = Array.from(options).find((o) =>
      o.textContent?.includes("dev"),
    )!;
    expect(devRow).toBeTruthy();
    // …with the typed "de" wrapped in a .mention highlight span.
    const hl = devRow.querySelector(".mention");
    expect(hl).toBeTruthy();
    expect(hl!.textContent!.toLowerCase()).toBe("de");
  });

  it("does not open on a bare @ (needs ≥1 char)", () => {
    const { ta } = renderComposer();
    type(ta, "@");
    expect(listbox()).toBeFalsy();
  });

  it("ArrowDown + Enter inserts the highlighted handle as @dev ", async () => {
    const { ta } = renderComposer();
    type(ta, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    // First row is active by default; select it with Enter.
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(ta.value).toBe("@dev "));
    // The menu closes after insertion.
    expect(listbox()).toBeFalsy();
  });

  it("ArrowDown moves the active row before selecting", async () => {
    const { ta } = renderComposer();
    // "@a" matches "arda" (user) and "agent"/"claude"(reserved substr) — a list.
    type(ta, "@a");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const before = document.querySelectorAll('[role="option"][aria-selected="true"]');
    expect(before).toHaveLength(1);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "Enter" });
    // Something was inserted (an @handle followed by a space).
    await waitFor(() => expect(/^@[\w-]+ $/.test(ta.value)).toBe(true));
  });

  it("Arrow navigation survives the caret keyUp refresh (no snap back to top)", async () => {
    const { ta } = renderComposer();
    type(ta, "@a"); // multi-item list (arda, agent, claude, …)
    await waitFor(() => expect(listbox()).toBeTruthy());
    const selectedIndex = () =>
      Array.from(document.querySelectorAll('[role="option"]')).findIndex(
        (o) => o.getAttribute("aria-selected") === "true",
      );
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    // The bug: every keyUp fires refresh(), which used to reset the highlight
    // to 0 even when the token is unchanged — snapping Arrow-nav back to top.
    fireEvent.keyUp(ta);
    expect(selectedIndex()).toBe(1);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyUp(ta);
    expect(selectedIndex()).toBe(2);
  });

  it("Escape closes the dropdown without inserting", async () => {
    const { ta } = renderComposer();
    type(ta, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    fireEvent.keyDown(ta, { key: "Escape" });
    await waitFor(() => expect(listbox()).toBeFalsy());
    expect(ta.value).toBe("@de"); // unchanged
  });

  it("clicking a row inserts its handle", async () => {
    const { ta } = renderComposer();
    type(ta, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const devRow = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.includes("dev"),
    ) as HTMLElement;
    fireEvent.click(devRow);
    await waitFor(() => expect(ta.value).toBe("@dev "));
  });

  it("marks the textarea as a combobox controlling the listbox", async () => {
    const { ta } = renderComposer();
    expect(ta.getAttribute("role")).toBe("combobox");
    type(ta, "@de");
    await waitFor(() => expect(ta.getAttribute("aria-expanded")).toBe("true"));
    const controls = ta.getAttribute("aria-controls")!;
    expect(document.getElementById(controls)).toBeTruthy();
    // aria-activedescendant points at an existing option.
    const activeId = ta.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(activeId)).toBeTruthy();
  });
});
