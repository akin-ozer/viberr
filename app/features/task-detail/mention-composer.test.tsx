// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { useState } from "react";
import {
  $createParagraphNode,
  $getRoot,
  $isParagraphNode,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { Timeline } from "./timeline";
import { $setParagraphPlainText } from "./lexical-mention-plugin";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";

/**
 * jsdom behavior tests for the Lexical comment composer: the @-mention
 * autocomplete (open/filter/keyboard/click/Escape), live mention
 * wrapping/unwrapping, the plain-text submission contract (exact posted
 * bytes), failure draft retention, the success reset (including undo
 * history), and the Ask-operator prefill.
 *
 * The tests drive the REAL editor: text is set through editor updates (jsdom
 * cannot synthesize typing into contenteditable), keys fire as DOM keydown
 * events on the contenteditable (Lexical's own listeners dispatch the
 * commands), and every assertion reads the editor or the submitted form.
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

function renderComposer(
  opts: {
    action?: () => unknown | Promise<unknown>;
    onPosted?: (text: string) => void;
  } = {},
) {
  const Host = () => {
    const [ask, setAsk] = useState(0);
    return (
      <ToastProvider>
        <button data-testid="bump-ask" onClick={() => setAsk((a) => a + 1)}>
          bump ask
        </button>
        <Timeline
          events={[]}
          hasMore={false}
          remaining={0}
          nextLimit={40}
          tlDefault="all"
          ask={ask}
          mentionables={MENTIONABLES}
        />
      </ToastProvider>
    );
  };
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: Host,
      action: async ({ request }) => {
        const text = String((await request.formData()).get("text"));
        opts.onPosted?.(text);
        return opts.action ? await opts.action() : { ok: true };
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/t"]} />);
  const ce = utils.container.querySelector(
    '[contenteditable="true"]',
  ) as HTMLElement;
  const editor = (ce as unknown as { __lexicalEditor: LexicalEditor })
    .__lexicalEditor;
  expect(editor).toBeTruthy();
  return { ...utils, ce, editor };
}

/** Set the whole draft (caret at end) through a real editor update. Async:
 *  Lexical commits in a microtask, so the act must flush it before the test
 *  fires keys at the (otherwise still-empty) editor. */
async function setText(editor: LexicalEditor, text: string) {
  await act(async () => {
    editor.update(() => {
      const root = $getRoot();
      const first = root.getFirstChild();
      if ($isParagraphNode(first)) {
        $setParagraphPlainText(first, text);
        return;
      }
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      $setParagraphPlainText(paragraph, text);
    });
  });
}

function readText(editor: LexicalEditor): string {
  let out = "";
  editor.getEditorState().read(() => {
    out = $getRoot().getTextContent();
  });
  return out;
}

const listbox = () => document.querySelector('[role="listbox"]');

describe("comment composer @-mention autocomplete", () => {
  it("opens a dropdown listing matching agents when typing @de", async () => {
    const { editor } = renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    const devRow = Array.from(options).find((o) =>
      o.textContent?.includes("dev"),
    )!;
    expect(devRow).toBeTruthy();
    // …with the typed "de" wrapped in a .mention highlight span.
    const hl = devRow.querySelector(".mention");
    expect(hl).toBeTruthy();
    expect(hl!.textContent!.toLowerCase()).toBe("de");
  });

  it("does not open on a bare @ (needs ≥1 char)", async () => {
    const { editor } = renderComposer();
    await setText(editor, "@");
    await new Promise((r) => setTimeout(r, 50));
    expect(listbox()).toBeFalsy();
  });

  it("Enter inserts the highlighted handle as @dev and closes the menu", async () => {
    const { ce, editor } = renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    fireEvent.keyDown(ce, { key: "Enter" });
    await waitFor(() => expect(readText(editor)).toBe("@dev "));
    expect(listbox()).toBeFalsy();
  });

  it("ArrowDown moves the active row before selecting", async () => {
    const { ce, editor } = renderComposer();
    // "@a" matches several rows (arda, agent, claude…) — a list.
    await setText(editor, "@a");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const before = document.querySelectorAll('[role="option"][aria-selected="true"]');
    expect(before).toHaveLength(1);
    fireEvent.keyDown(ce, { key: "ArrowDown" });
    fireEvent.keyDown(ce, { key: "Enter" });
    // Something was inserted: an @mention (a display name, which may contain
    // spaces like "@Arda Kaya") followed by a trailing space.
    await waitFor(() => expect(/^@.+ $/.test(readText(editor))).toBe(true));
  });

  it("Arrow navigation survives caret-only refreshes (no snap back to top)", async () => {
    const { ce, editor } = renderComposer();
    await setText(editor, "@a");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const selectedIndex = () =>
      Array.from(document.querySelectorAll('[role="option"]')).findIndex(
        (o) => o.getAttribute("aria-selected") === "true",
      );
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(ce, { key: "ArrowDown" });
    // The regression this pins: every editor update re-runs refreshFrom; while
    // the token is unchanged the highlight must NOT reset to the top.
    act(() => editor.update(() => {}));
    await waitFor(() => expect(selectedIndex()).toBe(1));
    fireEvent.keyDown(ce, { key: "ArrowDown" });
    act(() => editor.update(() => {}));
    await waitFor(() => expect(selectedIndex()).toBe(2));
  });

  it("Escape closes the dropdown without inserting", async () => {
    const { ce, editor } = renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    fireEvent.keyDown(ce, { key: "Escape" });
    await waitFor(() => expect(listbox()).toBeFalsy());
    expect(readText(editor)).toBe("@de"); // unchanged
  });

  it("clicking a row inserts its handle", async () => {
    const { editor } = renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const devRow = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.includes("dev"),
    ) as HTMLElement;
    fireEvent.click(devRow);
    await waitFor(() => expect(readText(editor)).toBe("@dev "));
  });

  it("marks the input as a combobox controlling the listbox", async () => {
    const { ce, editor } = renderComposer();
    expect(ce.getAttribute("role")).toBe("combobox");
    await setText(editor, "@de");
    await waitFor(() => expect(ce.getAttribute("aria-expanded")).toBe("true"));
    const controls = ce.getAttribute("aria-controls")!;
    expect(document.getElementById(controls)).toBeTruthy();
    // aria-activedescendant points at an existing option.
    const activeId = ce.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(activeId)).toBeTruthy();
  });
});

describe("live mention highlighting (character-editable, exact matcher)", () => {
  it("wraps a known mention in a .mention span and unwraps it when edited away", async () => {
    const { container, editor } = renderComposer();
    await setText(editor, "ping @dev now");
    await waitFor(() => {
      const chip = container.querySelector(".composer-ce .mention");
      expect(chip).toBeTruthy();
      expect(chip!.textContent).toBe("@dev");
    });
    // Editing the mention's characters away unwraps it — no atomic entity.
    await setText(editor, "ping @dv now");
    await waitFor(() =>
      expect(container.querySelector(".composer-ce .mention")).toBeFalsy(),
    );
  });

  it("leaves unknown mentions as plain text", async () => {
    const { container, editor } = renderComposer();
    await setText(editor, "@nobody-known hello");
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".composer-ce .mention")).toBeFalsy();
    expect(readText(editor)).toBe("@nobody-known hello");
  });
});

describe("plain-text submission contract (exact posted bytes)", () => {
  const CASES: { raw: string; posted: string }[] = [
    { raw: "  hello \n", posted: "hello" },
    { raw: "hello\nworld", posted: "hello\nworld" },
    { raw: " @Arda Kaya, please check. ", posted: "@Arda Kaya, please check." },
    { raw: "@unknown\n@operator ", posted: "@unknown\n@operator" },
  ];

  for (const { raw, posted } of CASES) {
    it(`posts ${JSON.stringify(raw)} as ${JSON.stringify(posted)}`, async () => {
      const texts: string[] = [];
      const { ce, editor } = renderComposer({ onPosted: (t) => texts.push(t) });
      await setText(editor, raw);
      await waitFor(() => expect(readText(editor)).toBe(raw));
      fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
      await waitFor(() => expect(texts).toHaveLength(1));
      expect(texts[0]).toBe(posted);
    });
  }

  it("whitespace-only drafts do not submit", async () => {
    const texts: string[] = [];
    const { ce, editor } = renderComposer({ onPosted: (t) => texts.push(t) });
    await setText(editor, "   \n  ");
    fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(texts).toHaveLength(0);
  });

  it("Ctrl+Enter submits like ⌘+Enter", async () => {
    const texts: string[] = [];
    const { ce, editor } = renderComposer({ onPosted: (t) => texts.push(t) });
    await setText(editor, "ctrl works");
    fireEvent.keyDown(ce, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(texts).toEqual(["ctrl works"]));
  });
});

describe("submit outcomes", () => {
  it("success clears the draft AND the undo history (⌘Z cannot resurrect it)", async () => {
    const { ce, editor } = renderComposer();
    await setText(editor, "posted away");
    fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
    await waitFor(() => expect(readText(editor)).toBe(""));
    act(() => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(readText(editor)).toBe("");
  });

  it("failure keeps the draft as typed and shows the inline error", async () => {
    const { ce, editor, container } = renderComposer({
      action: () => ({ ok: false, error: "Comment rejected by policy." }),
    });
    await setText(editor, "keep me safe");
    fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Comment rejected by policy.",
      ),
    );
    expect(readText(editor)).toBe("keep me safe");
  });
});

describe("Ask operator prefill", () => {
  it("prefills only a blank draft with @operator and focuses the composer", async () => {
    const { editor, getByTestId } = renderComposer();
    fireEvent.click(getByTestId("bump-ask"));
    await waitFor(() => expect(readText(editor)).toBe("@operator "));
  });

  it("never overwrites a non-empty draft", async () => {
    const { editor, getByTestId } = renderComposer();
    await setText(editor, "half-written thought");
    fireEvent.click(getByTestId("bump-ask"));
    await new Promise((r) => setTimeout(r, 50));
    expect(readText(editor)).toBe("half-written thought");
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
