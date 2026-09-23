// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { $getRoot, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { ToastProvider } from "~/ui/toast";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { staticPackagesOf } from "../../../test-support/static-imports";
import { Timeline } from "./timeline";

/**
 * Ruling 454 (owner, 2026-09-24): the Lexical comment editor is lazy. Until
 * it arrives the timeline shows a stand-in with the editor's own markup, and
 * whatever was typed there moves into the editor with the caret at the end.
 */

afterEach(cleanup);

const MENTIONABLES: Mentionables = {
  agents: [{ handle: "dev", name: "dev", role: "developer", backend: "claude" }],
  users: [],
  reserved: [{ handle: "operator", label: "Operator" }],
};

interface LexicalHost extends HTMLElement {
  __lexicalEditor: LexicalEditor;
}

function mount(onPosted: (text: string) => void = () => {}) {
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <button type="button">elsewhere</button>
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
      action: async ({ request }) => {
        onPosted(String((await request.formData()).get("text")));
        return { ok: true };
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/t"]} />);
  const standIn = utils.container.querySelector<HTMLElement>(".composer-ce")!;
  expect(standIn.hasAttribute("data-lexical-editor"), "the first render is the stand-in").toBe(false);
  return { ...utils, standIn };
}

function editorIn(container: HTMLElement): Promise<LexicalHost> {
  return waitFor(() => {
    const host = container.querySelector<LexicalHost>("[data-lexical-editor]");
    if (!host) throw new Error("the editor has not replaced the stand-in yet");
    return host;
  });
}

/** Types into the stand-in the way the browser does: text, then `input`. */
function typeInto(standIn: HTMLElement, text: string) {
  standIn.textContent = text;
  fireEvent.input(standIn);
}

/** The composer's outer markup: every element directly in `.composer-input`,
 *  with the attributes that decide its box, its look and its name. */
function composerMarkup(container: HTMLElement) {
  const input = container.querySelector(".composer-input")!;
  return [...input.children].map((el) => ({
    tag: el.tagName,
    className: el.className,
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    expanded: el.getAttribute("aria-expanded"),
    autocomplete: el.getAttribute("aria-autocomplete"),
    hidden: el.getAttribute("aria-hidden"),
    spellcheck: el.getAttribute("spellcheck"),
    editable: el.hasAttribute("contenteditable"),
    // The hint's copy; the editable's content is the draft, not markup.
    text: el.hasAttribute("contenteditable") ? null : el.textContent,
  }));
}

describe("the comment composer's stand-in (ruling 454)", () => {
  it("wears the editor's own markup, so nothing moves when the editor arrives", async () => {
    const { container, standIn } = mount();
    const before = composerMarkup(container);
    fireEvent.pointerDown(standIn);
    await editorIn(container);
    expect(composerMarkup(container)).toEqual(before);
    expect(before.map((el) => el.className)).toEqual(["composer-ce", "composer-placeholder"]);
  });

  it("carries a focused draft into the editor, caret at the end", async () => {
    const { container, standIn } = mount();
    standIn.focus();
    typeInto(standIn, "ping @dev");
    // The hint goes as soon as there is text, as the editor's does.
    expect(container.querySelector(".composer-placeholder")).toBeNull();
    const host = await editorIn(container);
    const editor = host.__lexicalEditor;
    await waitFor(() => expect(host.querySelector(".mention")?.textContent).toBe("@dev"));
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe("ping @dev");
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.isCollapsed()).toBe(true);
      if (!$isRangeSelection(selection)) return;
      const anchor = selection.anchor.getNode();
      expect(anchor.getTextContent()).toBe("@dev");
      expect(selection.anchor.offset).toBe("@dev".length);
      expect(anchor.getNextSibling()).toBeNull();
    });
    // The page's caret moved with it: the DOM selection sits in the editor.
    expect(host.contains(document.getSelection()!.anchorNode)).toBe(true);
  });

  it("carries a draft typed before the person moved on without taking the focus back", async () => {
    const { container, standIn, getByText } = mount();
    typeInto(standIn, "half a thought");
    const elsewhere = getByText("elsewhere");
    elsewhere.focus();
    // No press on the stand-in: the idle load swaps the editor in.
    const host = await editorIn(container);
    await waitFor(() => expect(host.textContent).toBe("half a thought"));
    expect(document.activeElement).toBe(elsewhere);
    host.__lexicalEditor.getEditorState().read(() => {
      expect($getSelection()).toBeNull();
    });
  });

  it("sends what was typed before the editor arrived", async () => {
    const posted: string[] = [];
    const { standIn } = mount((text) => posted.push(text));
    typeInto(standIn, "  quick note ");
    fireEvent.keyDown(standIn, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(posted).toEqual(["quick note"]));
  });
});

describe("the task route ships without Lexical (ruling 454)", () => {
  it("reaches no Lexical package through a static import", () => {
    const packages = [...staticPackagesOf("app/routes/project.task.tsx")];
    expect(packages.filter((p) => p === "lexical" || p.startsWith("@lexical/"))).toEqual([]);
  });

  it("the walk does see Lexical where it is imported statically", () => {
    expect(staticPackagesOf("app/features/task-detail/comment-composer.tsx").has("lexical")).toBe(true);
  });
});
