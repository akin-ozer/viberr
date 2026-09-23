// @vitest-environment jsdom
import { Profiler, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import {
  $createParagraphNode,
  $getRoot,
  $isParagraphNode,
  type LexicalEditor,
} from "lexical";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createRenderCounter } from "../../../test-support/render-counter";
import { $setParagraphPlainText } from "./lexical-mention-plugin";
import { Timeline } from "./timeline";

/**
 * Ruling 454 (CS-7): what typing costs. The draft lives in a ref, so a plain
 * keystroke renders nothing above the editor, and that is the property pinned
 * here: a draft lifted into page state would re-render the whole timeline on
 * every key. Inside an @token the menu re-renders (its filter changed), but the
 * editor's change listener must not be torn down and registered again, and a
 * selection update that leaves the caret where it was must render nothing. A
 * revalidation that brings the same directory back must not re-render the
 * editor either.
 *
 * Fixture: the real Timeline (ten comments) with the real, lazily loaded
 * Lexical editor, text set through editor updates (jsdom cannot synthesize
 * typing into a contenteditable), inside a Profiler; listener registrations
 * counted on the live editor.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MENTIONABLES: Mentionables = {
  agents: [{ handle: "dev", name: "dev", role: "developer", backend: "claude" }],
  users: [{ handle: "arda", name: "Arda Kaya", email: "arda@viberr.test" }],
  reserved: [{ handle: "operator", label: "Operator" }],
};

const EVENTS: TimelineEventRender[] = Array.from({ length: 10 }, (_, i) => ({
  id: 500 + i,
  type: "comment",
  occurredAt: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString(),
  actor: { kind: "human", userId: "u-arda", name: "Arda Kaya", initials: "AK", tone: "" },
  title: null,
  text: `Comment ${i} for @dev.`,
  toAgent: false,
  evidence: null,
  attachments: null,
}));

interface LexicalHost extends HTMLElement {
  __lexicalEditor: LexicalEditor;
}

async function mountComposer() {
  const counter = createRenderCounter();
  let revalidate: () => void = () => {};
  const Host = () => {
    const [data, setData] = useState(() => ({ events: EVENTS, mentionables: MENTIONABLES }));
    revalidate = () => setData((d) => structuredClone(d));
    return (
      <ToastProvider>
        <Timeline
          events={data.events}
          hasMore={false}
          remaining={0}
          nextLimit={40}
          tlDefault="all"
          ask={0}
          mentionables={data.mentionables}
        />
      </ToastProvider>
    );
  };
  const Stub = createRoutesStub([
    { path: "/t", Component: Host, action: async () => ({ ok: true }) },
  ]);
  const view = render(
    <Profiler id="composer" onRender={counter.onRender}>
      <Stub initialEntries={["/t"]} />
    </Profiler>,
  );
  fireEvent.pointerDown(view.container.querySelector(".composer-ce")!);
  const host = await waitFor(() => {
    const el = view.container.querySelector<LexicalHost>("[data-lexical-editor]");
    if (!el) throw new Error("the editor has not replaced the stand-in yet");
    return el;
  });
  const editor = host.__lexicalEditor;
  const registrations = vi.spyOn(editor, "registerUpdateListener");
  counter.attach(view.container);
  return { ...view, editor, counter, registrations, revalidate: () => revalidate() };
}

/** Sets the whole draft, caret at the end, as one editor update. */
async function type(editor: LexicalEditor, text: string) {
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

describe("composer renders per keystroke (ruling 454)", () => {
  it("a plain keystroke renders nothing", async () => {
    const view = await mountComposer();
    await type(view.editor, "Looks good");
    view.counter.reset();
    view.registrations.mockClear();
    await type(view.editor, "Looks good!");
    expectWithinBudget("render:composer.renders-per-plain-keystroke", view.counter.total());
    expect(view.registrations).not.toHaveBeenCalled();
  });

  it("a keystroke inside an @token re-renders the editor once and keeps its listener", async () => {
    const view = await mountComposer();
    await type(view.editor, "ping @ar");
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    view.counter.reset();
    view.registrations.mockClear();
    await type(view.editor, "ping @ard");
    // The menu still offers the match.
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain("Arda Kaya");
    expectWithinBudget(
      "render:composer.editor-renders-per-token-keystroke",
      view.counter.renders("CommentEditor"),
    );
    expectWithinBudget(
      "render:composer.listener-registrations-per-token-keystroke",
      view.registrations.mock.calls.length,
    );
  });

  it("a selection update that leaves the caret in place renders nothing", async () => {
    const view = await mountComposer();
    await type(view.editor, "ping @ar");
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    view.counter.reset();
    await act(async () => {
      view.editor.update(() => {
        $getRoot().selectEnd();
      });
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expectWithinBudget("render:composer.renders-per-same-caret-selection", view.counter.total());
  });

  it("a revalidation with the same directory does not re-render the editor", async () => {
    const view = await mountComposer();
    await type(view.editor, "Draft in progress");
    view.counter.reset();
    view.registrations.mockClear();
    await act(async () => view.revalidate());
    // The draft is untouched.
    let text = "";
    view.editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
    });
    expect(text).toBe("Draft in progress");
    expectWithinBudget(
      "render:composer.editor-renders-per-noop-revalidation",
      view.counter.renders("CommentEditor"),
    );
    expect(view.registrations).not.toHaveBeenCalled();
  });
});
