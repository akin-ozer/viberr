// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { Timeline } from "./timeline";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";

/**
 * jsdom behavior test for the comment composer's @-mention autocomplete:
 * typing "@de" opens a dropdown listing "dev" with "de" highlighted;
 * ArrowDown+Enter inserts "@dev "; Escape closes; a bare "@" does not open.
 * The composer renders inside a route stub so its useFetcher/useSearchParams
 * hooks have a data router.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    // Something was inserted: an @mention (a display name, which may contain
    // spaces like "@Arda Kaya") followed by a trailing space.
    await waitFor(() => expect(/^@.+ $/.test(ta.value)).toBe(true));
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

/* ------------------------------------------------------ UI-40 empty state */

/**
 * UI-40: `items` is the FILTERED view of an already-bounded slice, but the empty
 * copy was always "No activity yet — this task hasn't started its operator
 * loop." Picking the Comments tab on a task whose newest events are all typed
 * therefore declared the task had never run — with "Show older events · N more"
 * rendered directly below it.
 */
describe("Timeline empty state (UI-40)", () => {
  function renderTimeline(events: TimelineEventRender[], hasMore = false) {
    const Stub = createRoutesStub([
      {
        path: "/t",
        Component: () => (
          <ToastProvider>
            <Timeline
              events={events}
              hasMore={hasMore}
              remaining={hasMore ? 12 : 0}
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
    return render(<Stub initialEntries={["/t"]} />);
  }

  const typedEvent: TimelineEventRender = {
    id: 1,
    type: "transition",
    occurredAt: new Date().toISOString(),
    actor: { kind: "agent", name: "Operator" } as TimelineEventRender["actor"],
    title: null,
    text: "Moved to Review",
    toAgent: false,
    evidence: null,
  };

  it("says the task never started only when there are NO events at all", () => {
    const { getByText } = renderTimeline([]);
    expect(
      getByText(/No activity yet — this task hasn't started its operator loop\./),
    ).toBeTruthy();
  });

  it("blames the FILTER when the task has history but the tab matched nothing", () => {
    const { getByText, queryByText } = renderTimeline([typedEvent], true);
    fireEvent.click(getByText("Comments"));
    expect(queryByText(/hasn't started its operator loop/)).toBeNull();
    expect(getByText(/No comments in the loaded history/)).toBeTruthy();
    // The contradiction the old copy sat next to.
    expect(getByText(/Show older events/)).toBeTruthy();
  });
});

/**
 * P13-D-39: the composer's send hint was the literal `⌘↵ to send`, the last
 * user-visible `⌘` in `app/`, even though its own handler accepts
 * `metaKey || ctrlKey`. UI-55 had already established the rule and the helper
 * for exactly this — it just was not applied here.
 */
describe("comment composer send hint (P13-D-39)", () => {
  const hint = () =>
    [...document.querySelectorAll(".composer-foot span")].find((s) =>
      s.textContent?.includes("to send"),
    );

  it("shows ⌘↵ on a Mac", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    renderComposer();
    expect(hint()!.textContent).toBe("⌘↵ to send");
  });

  it("shows Ctrl ↵ on a keyboard that has no ⌘ key", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    renderComposer();
    expect(hint()!.textContent).toBe("Ctrl ↵ to send");
    // No hardcoded Mac glyph survives anywhere in the composer footer.
    expect(document.querySelector(".composer-foot")!.textContent).not.toContain("⌘");
  });
});
