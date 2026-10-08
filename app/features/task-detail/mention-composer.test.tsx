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
  SKIP_DOM_SELECTION_TAG,
  type LexicalEditor,
} from "lexical";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { Timeline } from "./timeline";
import { $setParagraphPlainText } from "./lexical-mention-plugin";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { TaskRunPrincipalView } from "./run-principal-view";

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
    { handle: "agent", label: "Delivering agent" }, // F19-12 vocabulary
    { handle: "claude", label: "Claude specialist" },
    { handle: "codex", label: "Codex specialist" },
  ],
};

/** What the stubbed comment action answers: the composer reads `ok` and, on a
 *  refusal, renders `error` in its inline alert. */
interface ComposerActionReply {
  ok: boolean;
  error?: string;
}

interface ComposerOptions {
  /** Replace the stub action's reply (default `{ ok: true }`). */
  action?: () => ComposerActionReply | Promise<ComposerActionReply>;
  onPosted?: (text: string) => void;
  /** Ruling 127: the task's run principal, which the `@claude` / `@codex` rows
   *  answer from. Undefined (the default) claims nothing either way. */
  runPrincipal?: TaskRunPrincipalView | null;
}

/** Lexical stamps the live editor onto its contenteditable host element, and
 *  that handle is how these tests drive the REAL editor (jsdom cannot
 *  synthesize typing into a contenteditable). */
interface LexicalHost extends HTMLElement {
  __lexicalEditor: LexicalEditor;
}

async function renderComposer(opts: ComposerOptions = {}) {
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
          {...("runPrincipal" in opts
            ? { runPrincipal: opts.runPrincipal ?? null }
            : {})}
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
  // Ruling 457: the editor is lazy and every mount starts as its stand-in.
  // Pressing the stand-in fetches it at once instead of on the idle callback.
  const standIn = utils.container.querySelector(".composer-ce");
  if (!standIn) throw new Error("renderComposer: no composer rendered");
  fireEvent.pointerDown(standIn);
  const ce = await waitFor(() => {
    const host = utils.container.querySelector<LexicalHost>("[data-lexical-editor]");
    if (!host) throw new Error("the editor has not replaced the stand-in yet");
    return host;
  });
  const editor = ce.__lexicalEditor;
  expect(editor).toBeTruthy();
  return { ...utils, ce, editor };
}

/** Set the whole draft (caret at end) through a real editor update. Async:
 *  Lexical commits in a microtask, so the act must flush it before the test
 *  fires keys at the (otherwise still-empty) editor. The update skips the DOM
 *  selection: jsdom has no layout, and one Lexical writes comes back through a
 *  queued selectionchange that, on a loaded machine, re-read the caret as 0
 *  and closed the @menu mid-test. */
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
    }, { tag: SKIP_DOM_SELECTION_TAG });
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

/**
 * Ruling 127 — `@claude` / `@codex` name a RUNTIME, and a mention that engages
 * one starts a run on the TASK OWNER's account. The menu therefore cannot go
 * on offering the handle as if the instance held a credential: the row says
 * whose account it would bill and whether that account can pay, in the same
 * words the run controls use. The row stays OFFERED (a comment posts either
 * way, and hiding the handle would leave the human guessing why `@codex` does
 * nothing) — B-AG2 already established that a suggestion must not promise a
 * target the resolver refuses, and this is the honest half of that promise.
 */
describe("ruling 127: the backend handles name whose account they would bill", () => {
  const rowFor = (handle: string) =>
    Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      o.querySelector(".ri-sub")?.textContent?.startsWith(`@${handle} `),
    );

  it("marks the backend the task owner has not connected, and leaves the other alone", async () => {
    const { editor } = await renderComposer({
      runPrincipal: {
        ownerUserId: "u-ada",
        ownerName: "Ada Lovelace",
        claude: { available: true, detail: null },
        codex: { available: false, detail: null },
      },
    });
    await setText(editor, "@c");
    // Wait for the rows this test reads, not just the listbox: the list can
    // mount a render before its "@c" options do (the lazy editor, ruling 457,
    // moves that render later under a loaded suite).
    await waitFor(() => expect(rowFor("codex") && rowFor("claude")).toBeTruthy());
    expect(rowFor("codex")!.textContent).toContain(
      "Codex not connected for Ada Lovelace",
    );
    expect(rowFor("claude")!.textContent).not.toContain("not connected");
    // No deployment credential is named: there is none to name.
    expect(listbox()!.textContent).not.toContain("on this instance");
  });

  it("an UNOWNED task marks both handles: there is nobody to bill", async () => {
    const { editor } = await renderComposer({ runPrincipal: null });
    await setText(editor, "@c");
    // Wait for the rows this test reads, not just the listbox: the list can
    // mount a render before its "@c" options do (the lazy editor, ruling 457,
    // moves that render later under a loaded suite).
    await waitFor(() => expect(rowFor("codex") && rowFor("claude")).toBeTruthy());
    expect(rowFor("codex")!.textContent).toContain("no task owner");
    expect(rowFor("claude")!.textContent).toContain("no task owner");
  });

  it("claims nothing when no principal is supplied (a surface with no task)", async () => {
    const { editor } = await renderComposer();
    await setText(editor, "@c");
    // Wait for the rows this test reads, not just the listbox: the list can
    // mount a render before its "@c" options do (the lazy editor, ruling 457,
    // moves that render later under a loaded suite).
    await waitFor(() => expect(rowFor("codex") && rowFor("claude")).toBeTruthy());
    expect(rowFor("codex")!.textContent).not.toContain("not connected");
    expect(rowFor("codex")!.textContent).not.toContain("no task owner");
  });
});

describe("comment composer @-mention autocomplete", () => {
  it("opens a dropdown listing matching agents when typing @de", async () => {
    const { editor } = await renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    const devRow = Array.from(options).find((o) =>
      o.textContent?.includes("dev"),
    )!;
    expect(devRow).toBeTruthy();
    // …with the typed "de" marked as a SEARCH HIT, not as a mention chip. The
    // two are different claims: `.mention` is the real-mention class and now
    // carries a screen-reader "mention " prefix, so an arbitrary matched
    // substring in this dropdown must not borrow it.
    expect(devRow.querySelector(".mention")).toBeNull();
    const hl = devRow.querySelector("mark.mention-match");
    expect(hl).toBeTruthy();
    expect(hl!.textContent!.toLowerCase()).toBe("de");
  });

  it("does not open on a bare @ (needs ≥1 char)", async () => {
    const { editor } = await renderComposer();
    await setText(editor, "@");
    await new Promise((r) => setTimeout(r, 50));
    expect(listbox()).toBeFalsy();
  });

  it("Enter inserts the highlighted handle as @dev and closes the menu", async () => {
    const { ce, editor } = await renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    fireEvent.keyDown(ce, { key: "Enter" });
    await waitFor(() => expect(readText(editor)).toBe("@dev "));
    expect(listbox()).toBeFalsy();
  });

  it("ArrowDown moves the active row before selecting", async () => {
    const { ce, editor } = await renderComposer();
    // "@a" matches several rows (arda, agent, claude…) — a list.
    await setText(editor, "@a");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const before = document.querySelectorAll('[role="option"][aria-selected="true"]');
    expect(before).toHaveLength(1);
    fireEvent.keyDown(ce, { key: "ArrowDown" });
    fireEvent.keyDown(ce, { key: "Enter" });
    // The rows read agent, Arda Kaya, operator, claude: the arrow armed the
    // second, and Enter inserts its display name. CANARY: let `pickActive`
    // take the first row and "@agent " goes in.
    await waitFor(() => expect(readText(editor)).toBe("@Arda Kaya "));
  });

  it("Arrow navigation survives caret-only refreshes (no snap back to top)", async () => {
    const { ce, editor } = await renderComposer();
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
    const { ce, editor } = await renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    fireEvent.keyDown(ce, { key: "Escape" });
    await waitFor(() => expect(listbox()).toBeFalsy());
    expect(readText(editor)).toBe("@de"); // unchanged
  });

  it("clicking a row inserts its handle", async () => {
    const { editor } = await renderComposer();
    await setText(editor, "@de");
    await waitFor(() => expect(listbox()).toBeTruthy());
    const devRow = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.includes("dev"),
    );
    fireEvent.click(devRow!);
    await waitFor(() => expect(readText(editor)).toBe("@dev "));
  });

  it("marks the input as a combobox controlling the listbox", async () => {
    const { ce, editor } = await renderComposer();
    expect(ce.getAttribute("role")).toBe("combobox");
    expect(ce.getAttribute("aria-expanded")).toBe("false");
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
    const { container, editor } = await renderComposer();
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
    const { container, editor } = await renderComposer();
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
      const { ce, editor } = await renderComposer({ onPosted: (t) => texts.push(t) });
      await setText(editor, raw);
      await waitFor(() => expect(readText(editor)).toBe(raw));
      fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
      await waitFor(() => expect(texts).toHaveLength(1));
      expect(texts[0]).toBe(posted);
    });
  }

  it("whitespace-only drafts do not submit", async () => {
    const texts: string[] = [];
    const { ce, editor } = await renderComposer({ onPosted: (t) => texts.push(t) });
    await setText(editor, "   \n  ");
    fireEvent.keyDown(ce, { key: "Enter", metaKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(texts).toHaveLength(0);
  });

  it("Ctrl+Enter submits like ⌘+Enter", async () => {
    const texts: string[] = [];
    const { ce, editor } = await renderComposer({ onPosted: (t) => texts.push(t) });
    await setText(editor, "ctrl works");
    fireEvent.keyDown(ce, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(texts).toEqual(["ctrl works"]));
  });
});

describe("submit outcomes", () => {
  it("success clears the draft AND the undo history (⌘Z cannot resurrect it)", async () => {
    const { ce, editor } = await renderComposer();
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
    const { ce, editor, container } = await renderComposer({
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
    const { editor, getByTestId } = await renderComposer();
    fireEvent.click(getByTestId("bump-ask"));
    await waitFor(() => expect(readText(editor)).toBe("@operator "));
  });

  it("never overwrites a non-empty draft", async () => {
    const { editor, getByTestId } = await renderComposer();
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
  function renderTimeline(
    events: TimelineEventRender[],
    hasMore = false,
    runLive = false,
  ) {
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
              runLive={runLive}
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
    actor: { kind: "agent", name: "Operator" },
    title: null,
    text: "Moved to Review",
    toAgent: false,
    evidence: null,
    attachments: null,
  };

  it("blames the FILTER when the task has history but the tab matched nothing", () => {
    const { getByText, queryByText } = renderTimeline([typedEvent], true);
    fireEvent.click(getByText("Comments"));
    expect(queryByText(/hasn't started its operator loop/)).toBeNull();
    expect(getByText(/No comments in the loaded history/)).toBeTruthy();
    // The contradiction the old copy sat next to.
    expect(getByText(/Show older events/)).toBeTruthy();
  });

  /**
   * U33-1 — the SECOND way this empty state lied, on the freshest task there
   * is. Zero events is the honest input, so the UI-40 fix above (which keys off
   * `events.length`) cannot help: seconds after creation the Live-run strip on
   * this same page reads "Preparing workspace · Cloning akin-ozer/viberr · 13%"
   * while the timeline underneath declared the loop had never started. Ruling
   * 87(b) exists so a healthy pre-run phase is distinguishable from a wedged
   * one; the copy undid half of it on the same screen.
   */
  it("U33-1: a LIVE run means the loop HAS started, not that it never did", () => {
    const { getByText, queryByText } = renderTimeline([], false, true);
    expect(queryByText(/hasn't started its operator loop/)).toBeNull();
    expect(
      getByText(
        /The loop has started\. Its first events land here as the live run above reports in\./,
      ),
    ).toBeTruthy();
  });

  it("U33-1: with NO live run the original 'hasn't started' copy is the honest one", () => {
    const { getByText, queryByText } = renderTimeline([], false, false);
    expect(queryByText(/The loop has started/)).toBeNull();
    expect(
      getByText(/No activity yet\. This task hasn't started its operator loop\./),
    ).toBeTruthy();
  });

  it("U33-1 leaves the two FILTERED empty states alone (UI-40)", () => {
    // A live run says nothing about why the active tab matched nothing — the
    // filter copy stays exactly as UI-40 wrote it.
    const { getByText, queryByText } = renderTimeline([typedEvent], true, true);
    fireEvent.click(getByText("Comments"));
    expect(getByText(/No comments in the loaded history/)).toBeTruthy();
    expect(queryByText(/The loop has started/)).toBeNull();
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
      s.textContent?.includes("sends"),
    );

  it("shows ⌘↵ on a Mac", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    await renderComposer();
    expect(hint()!.textContent).toBe("⌘↵ sends");
  });

  it("shows Ctrl ↵ on a keyboard that has no ⌘ key", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    await renderComposer();
    expect(hint()!.textContent).toBe("Ctrl ↵ sends");
    // No hardcoded Mac glyph survives anywhere in the composer footer.
    expect(document.querySelector(".composer-foot")!.textContent).not.toContain("⌘");
  });
});
