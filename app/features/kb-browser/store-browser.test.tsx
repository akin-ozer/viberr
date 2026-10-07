// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { StoreBrowser } from "./store-browser";
import type { StoreNode } from "./tree";

/**
 * jsdom smokes for the StoreBrowser popup: tree rendering (dirs first,
 * top-level expanded), toolbar, inline new-folder flow, layered delete
 * confirm (native <dialog> `cancel` closes the TOPMOST layer only),
 * GitHub bar validation, and the intents posted to the org-settings action.
 */

afterEach(cleanup);

let lastForm: Record<string, string> | null = null;

/** The org-settings store reply this stub sends back, in the members the
 *  browser reads: the outcome, its toast/error copy, and a document read. */
interface StubActionReply {
  ok: boolean;
  toast?: string;
  error?: string;
  text?: string;
  truncated?: boolean;
  version?: string;
}

const TREE: StoreNode[] = [
  {
    type: "dir",
    name: "decisions",
    children: [
      { type: "file", name: "adr-001.md", sizeBytes: 4300, mtime: new Date().toISOString() },
    ],
  },
  { type: "file", name: "overview.md", sizeBytes: 9100, mtime: new Date().toISOString() },
];

/** A query answers a plain `HTMLElement`, but `.value` lives on the concrete
 *  control — so the node is CHECKED against its element class rather than
 *  asserted into it, and a wrong node fails here instead of further down. */
function control<T extends HTMLElement>(
  node: Element | null,
  kind: new () => T,
): T {
  if (!(node instanceof kind)) {
    throw new Error(`expected ${kind.name}, got ${node?.nodeName ?? "nothing"}`);
  }
  return node;
}

function renderBrowser(
  overrides: {
    tree?: StoreNode[];
    onClose?: () => void;
    /** Make the org-settings action fail, to exercise the failure toast. */
    actionResult?: StubActionReply;
    /** Per-intent canned responses (the editor reads AND writes); a promise
     *  holds the answer until the test settles it. */
    respond?: (intent: string) => StubActionReply | Promise<StubActionReply> | undefined;
  } = {},
) {
  lastForm = null;
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <StoreBrowser
            title="Architecture notes"
            subMono="store://kb/architecture-notes/ · re-index on change"
            metaTail="indexed just now"
            tree={overrides.tree ?? TREE}
            resource={{ kind: "kb", id: "kb1" }}
            onClose={overrides.onClose ?? (() => {})}
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        lastForm = {};
        for (const [k, v] of fd.entries()) {
          // A form entry is either text or an uploaded file; only the text
          // fields are what these assertions read back.
          if (!(v instanceof File)) lastForm[k] = v;
        }
        return (
          overrides.respond?.(lastForm.intent ?? "") ??
          overrides.actionResult ?? { ok: true, toast: "stub done" }
        );
      },
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

describe("StoreBrowser", () => {
  it("renders the tree (top-level dirs expanded), footer stats and def-note", () => {
    const { getByText } = renderBrowser();
    expect(document.querySelector('[aria-label="Files · Architecture notes"]')).toBeTruthy();
    expect(getByText("decisions")).toBeTruthy();
    expect(getByText("adr-001.md")).toBeTruthy(); // expanded by default
    expect(getByText("overview.md")).toBeTruthy();
    // P13-UI-20 residual: the mtime moved into its own live-updating child
    // component, so the size and the age are two nodes inside `.fm-meta`.
    expect(
      [...document.querySelectorAll(".fm-meta")].some(
        (m) => m.textContent === "4.2 KB · just now",
      ),
    ).toBe(true);
    expect(getByText("1 folder · 2 files · indexed just now")).toBeTruthy();
    expect(getByText(/This is the real folder on disk/)).toBeTruthy();
    expect(getByText("drag files or folders onto a folder to upload there")).toBeTruthy();
  });

  /**
   * U33-3 — the destination picker offered "/ (store root)", a place no action
   * in this dialog can write to. A StoreBrowser is opened on ONE resource and
   * every path is resolved against that resource's own folder
   * (`resolveStoreTarget` → kb dir / skill folder), so `[]` has always been the
   * RESOURCE root. The write was right; the label named the wrong thing.
   */
  it("the root destination names the browsed resource, not the store", async () => {
    const { getByText, getByLabelText } = renderBrowser();
    const dest = control(getByLabelText("Destination folder"), HTMLSelectElement);
    expect(dest.options[0]!.textContent).toBe("/ (Architecture notes root)");
    expect(dest.textContent).not.toContain("store root");

    // …and the destination it stands for is unchanged: picking a folder and
    // coming back to the root still writes into the resource root (`[]`).
    fireEvent.change(dest, { target: { value: "decisions" } });
    fireEvent.change(dest, { target: { value: "" } });
    fireEvent.click(getByText("New folder"));
    const input = getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "inbox" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "store-mkdir", path: "[]", name: "inbox" }),
    );
  });

  it("empty tree renders the empty state", () => {
    const { getByText } = renderBrowser({ tree: [] });
    expect(
      getByText("Empty. Drag files or folders here, upload, or import from GitHub."),
    ).toBeTruthy();
  });

  it("the new-folder row offers no activation it does not have", () => {
    const { getByText, getByLabelText } = renderBrowser();
    fireEvent.click(getByText("New folder"));
    // SAFETY: `.fm-row` is only ever a <div> in store-browser.tsx, and the
    // input is rendered inside one; the bound query cannot state that.
    const row = getByLabelText("New folder name").closest(".fm-row") as HTMLElement;
    // A real directory row earns its hand cursor and hover fill by carrying
    // a `.fm-open` button. This one is a text field in a row shell: clicking
    // it only blurs the input, which DISMISSES the half-typed name.
    expect(row.className).toContain("editing");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(row.querySelector(".fm-open")).toBeNull();
  });

  /**
   * Interface review 2026-09-24 (acce-32): the row was a `role="button"` div
   * with the Upload / New folder / Delete buttons nested inside it, so the
   * folder's accessible name ran on into "… Delete decisions" while activating
   * it only expanded the folder. The row is a plain element now; a native
   * button carries the activation and the row actions sit beside it.
   */
  it("a tree row's activation is a native button beside its actions, never around them", () => {
    const { container, getByRole, getByLabelText } = renderBrowser({
      tree: [
        ...TREE,
        { type: "file", name: "contract.pdf", sizeBytes: 900, mtime: new Date().toISOString() },
      ],
    });
    for (const row of container.querySelectorAll(".fm-row")) {
      expect(row.getAttribute("role")).toBeNull();
      expect(row.getAttribute("tabindex")).toBeNull();
      expect(row.querySelector('[role="button"] button, button button')).toBeNull();
    }
    const folder = getByRole("button", { name: /^decisions/ });
    expect(folder.className).toBe("fm-open");
    expect(folder.textContent).not.toMatch(/Upload|New folder|Delete/);
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    // The actions are the row's, not the button's.
    expect(folder.contains(getByLabelText("Delete decisions"))).toBe(false);
    expect(folder.parentElement?.querySelector(".rsrc-acts")).toBeTruthy();
    fireEvent.click(folder);
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    expect(getByLabelText("Open overview.md").tagName).toBe("BUTTON");
    // A file nothing can open keeps the row's face but offers no control.
    const pdf = container.querySelector(".fm-row.file:not(.openable) .fm-open");
    expect(pdf?.tagName).toBe("SPAN");
  });

  it("new-folder input commits on Enter with mkdir -p semantics", async () => {
    const { getByText, getByLabelText } = renderBrowser();
    fireEvent.click(getByText("New folder"));
    const input = getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "uploads/inbox" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-mkdir",
        kind: "kb",
        id: "kb1",
        path: "[]",
        name: "uploads/inbox",
      }),
    );
    await waitFor(() => expect(getByText("stub done")).toBeTruthy());
  });

  /**
   * Pass 16. Row actions used to live in `.fm-acts`, which is `opacity: 0`
   * until the row is hovered or something inside it is focused. `opacity: 0`
   * does NOT stop hit-testing, so on a touch device the Delete button was
   * invisible and still tappable — a tap near the right edge of a row could
   * destroy a file with nothing on screen to explain it. The reveal is gone:
   * the actions use the app's always-visible row-action wrapper.
   */
  it("row actions are always rendered, never hover-revealed", () => {
    const { container, getByLabelText } = renderBrowser();
    // The mouse-only reveal wrapper is gone everywhere in the tree…
    expect(container.querySelectorAll(".fm-acts")).toHaveLength(0);
    // …replaced by the shared always-visible one, on every row that has actions.
    expect(container.querySelectorAll(".rsrc-acts").length).toBeGreaterThan(0);
    // Every action is a real, labelled button — reachable by keyboard and touch
    // without a pointer ever hovering the row.
    for (const row of container.querySelectorAll(".fm-row")) {
      for (const act of row.querySelectorAll(".rsrc-acts button")) {
        expect(act.getAttribute("type")).toBe("button");
        expect(act.getAttribute("aria-label")).toBeTruthy();
      }
    }
    expect(getByLabelText("Delete overview.md")).toBeTruthy();
  });

  it("delete goes through the nested confirm; Escape closes only the top layer", async () => {
    let closed = 0;
    const { getByText, getByLabelText, getByRole, queryByRole } = renderBrowser({
      onClose: () => {
        closed += 1;
      },
    });
    fireEvent.click(getByLabelText("Delete overview.md"));
    expect(getByText("Delete “overview.md”?")).toBeTruthy();
    expect(
      getByText("The file is removed from the store. Agents lose it on their next context load."),
    ).toBeTruthy();
    // Ruling 458(f): the shared ConfirmDialog, named by its title and stacked
    // over the browser. Ruling 458(k): described by its body, which the
    // hand-written card pointed at an id nothing carried.
    const confirm = getByRole("alertdialog", { name: "Delete “overview.md”?" });
    expect(confirm.getAttribute("data-screen-label")).toBe("Store deletion dialog");
    expect(confirm.classList.contains("over-modal")).toBe(true);
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(
      "The file is removed from the store. Agents lose it on their next context load.",
    );

    // Escape on the topmost native <dialog> (the nested confirm) fires its
    // `cancel` event, which useDialog turns into onCancel — the confirm
    // closes, the browser itself stays open.
    fireEvent(
      document.querySelector("dialog.confirm-card")!,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    await waitFor(() => expect(queryByRole("alertdialog")).toBeNull());
    expect(closed).toBe(0);

    fireEvent.click(getByLabelText("Delete decisions"));
    expect(getByText("Delete “decisions” and its contents?")).toBeTruthy();
    expect(getByText(/1 file inside will be removed from the store/)).toBeTruthy();
    fireEvent.click(getByText("Delete folder"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-delete",
        path: JSON.stringify(["decisions"]),
      }),
    );

    // Escape with no layers → `cancel` lands on the browser card → closes.
    fireEvent(
      document.querySelector("dialog.modal-wide")!,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(closed).toBe(1);
  });

  it("GitHub bar validates empty input client-side and posts the import", async () => {
    const { getByText, getByLabelText } = renderBrowser();
    fireEvent.click(getByText("Add from GitHub"));
    fireEvent.click(getByText("Import"));
    expect(getByText(/Paste a GitHub link: a repo, or a folder like/)).toBeTruthy();
    expect(lastForm).toBeNull();

    // Named in its own right: the placeholder is an example that goes as
    // the person types.
    fireEvent.change(getByLabelText("GitHub repo or folder link"), {
      target: { value: "https://github.com/owner/repo/tree/main/docs" },
    });
    fireEvent.click(getByText("Import"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-import-github",
        url: "https://github.com/owner/repo/tree/main/docs",
        path: "[]",
      }),
    );
  });
});

/**
 * The editor cluster (owner ruling R14-4 — P14-KM-08 / UI-59 / UI-60 / UI-61).
 * Before it, authoring was create-only at the store ROOT, an existing doc could
 * not be opened at all, a same-named save silently destroyed the file, and the
 * editor closed before the server answered so a rejected save lost the draft.
 */
describe("StoreBrowser document editor", () => {
  it("writes into the SELECTED folder, not always the store root", async () => {
    const { getByText, getByLabelText, getByPlaceholderText } = renderBrowser();
    fireEvent.change(getByLabelText("Destination folder"), {
      target: { value: "decisions" },
    });
    fireEvent.click(getByText("New document"));
    fireEvent.change(getByPlaceholderText("file-name.md"), {
      target: { value: "adr-002" },
    });
    fireEvent.change(getByLabelText("Document contents"), {
      target: { value: "# ADR 2" },
    });
    fireEvent.click(getByText("Save document"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-write-doc",
        path: JSON.stringify(["decisions"]),
        name: "adr-002",
        body: "# ADR 2",
      }),
    );
    // A fresh name never carries the replace intent.
    expect(lastForm?.overwrite).toBeUndefined();
  });

  // A save reveals the folder the document was saved in, not the one the
  // "into" select names by then: a new draft keeps the folder it opened with
  // while the select moves on, and an opened document never sets the select at
  // all. Both folders start collapsed by hand, so the tree's state after the
  // save is the reveal's alone. CANARY: reveal the toolbar's destination on
  // save and `decisions` stays shut while `notes` springs open.
  it.each([
    {
      doc: "a new document, after the destination moved on",
      open: (view: ReturnType<typeof renderBrowser>) => {
        const dest = view.getByLabelText("Destination folder");
        fireEvent.change(dest, { target: { value: "decisions" } });
        fireEvent.click(view.getByText("New document"));
        fireEvent.change(dest, { target: { value: "notes" } });
        fireEvent.change(view.getByPlaceholderText("file-name.md"), {
          target: { value: "adr-002" },
        });
      },
    },
    {
      doc: "an opened document",
      open: async (view: ReturnType<typeof renderBrowser>) => {
        fireEvent.change(view.getByLabelText("Destination folder"), {
          target: { value: "notes" },
        });
        fireEvent.click(view.getByLabelText("Open adr-001.md"));
        await view.findByRole("region", { name: "Preview of adr-001.md" });
        fireEvent.click(view.getByRole("button", { name: "Raw" }));
      },
    },
  ])("saving $doc reveals the folder it was saved in", async ({ open }) => {
    const view = renderBrowser({
      tree: [...TREE, { type: "dir", name: "notes", children: [] }],
      respond: (intent) =>
        intent === "store-read-doc" ? { ok: true, text: "# ADR 1", truncated: false } : undefined,
    });
    await open(view);
    const decisions = view.getByRole("button", { name: /^decisions/ });
    const notes = view.getByRole("button", { name: /^notes/ });
    fireEvent.click(decisions);
    fireEvent.click(notes);
    expect(decisions.getAttribute("aria-expanded")).toBe("false");
    expect(notes.getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(view.getByLabelText("Document contents"), {
      target: { value: "# ADR, edited" },
    });
    fireEvent.click(view.getByText("Save document"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "store-write-doc", path: JSON.stringify(["decisions"]) }),
    );
    await view.findByText("stub done");
    expect(decisions.getAttribute("aria-expanded")).toBe("true");
    expect(notes.getAttribute("aria-expanded")).toBe("false");
  });

  it("ruling 149: the file name rides the shared .field chrome, and the raw text the card's (ruling 614)", () => {
    // Canary: unwrap the name and it paints in UA chrome inside a card whose
    // every other control wears the sheet's — the class this closes. Drop
    // `.doc-src` and the raw text does too, with no ring on the card around it.
    const { getByText, getByLabelText, getByPlaceholderText } = renderBrowser();
    fireEvent.click(getByText("New document"));
    const name = getByPlaceholderText("file-name.md");
    expect(name.closest(".field")).not.toBeNull();
    expect(getByText("File name").tagName).toBe("LABEL");
    const body = getByLabelText("Document contents");
    expect(body.classList.contains("doc-src")).toBe(true);
    expect(body.closest(".fm-doc")).not.toBeNull();
    // A label names each control: no aria-label overriding it.
    expect(name.getAttribute("aria-label")).toBeNull();
    expect(body.getAttribute("aria-label")).toBeNull();
  });

  it("the GitHub import lands in the selected folder too", async () => {
    const { getByText, getByLabelText, getByPlaceholderText } = renderBrowser();
    fireEvent.change(getByLabelText("Destination folder"), {
      target: { value: "decisions" },
    });
    fireEvent.click(getByText("Add from GitHub"));
    fireEvent.change(getByPlaceholderText("https://github.com/owner/repo/tree/main/docs"), {
      target: { value: "https://github.com/owner/repo" },
    });
    fireEvent.click(getByText("Import"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-import-github",
        path: JSON.stringify(["decisions"]),
      }),
    );
  });

  it("ruling 614: a markdown doc opens rendered, and Raw is its real text to edit", async () => {
    const { getByLabelText, getByRole, getByText, queryByLabelText, findByRole } =
      renderBrowser({
        respond: (intent) =>
          intent === "store-read-doc"
            ? { ok: true, text: "# Overview\n\nLOADED **text**", truncated: false, version: "0a1b2c3d4e5f" }
            : undefined,
      });
    fireEvent.click(getByLabelText("Open overview.md"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-read-doc",
        path: JSON.stringify(["overview.md"]),
      }),
    );
    // Rendered on arrival: the heading is a heading (level 3, under the
    // dialog's own h2), the bold is bold, and no textarea shows the markup.
    // CANARY: open an existing doc on `raw` and none of this renders.
    const preview = await findByRole("region", { name: "Preview of overview.md" });
    expect(within(preview).getByRole("heading", { level: 3, name: "Overview" })).toBeTruthy();
    expect(within(preview).getByText("text").tagName).toBe("STRONG");
    expect(queryByLabelText("Document contents")).toBeNull();
    expect(getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    // The name is the file's own — the editor edits it, it does not re-create it.
    expect(getByText("overview.md", { selector: ".doc-path .dp-name" })).toBeTruthy();
    // Ruling 147(d): nothing has changed, so there is nothing to save yet.
    const save = getByText("Save document").closest("button")!;
    expect(save.disabled).toBe(true);
    expect(getByText("Close")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Raw" }));
    const body = control(getByLabelText("Document contents"), HTMLTextAreaElement);
    expect(body.value).toBe("# Overview\n\nLOADED **text**");
    fireEvent.change(body, { target: { value: "# Overview\nEDITED" } });
    expect(getByText("Unsaved changes")).toBeTruthy();
    expect(save.disabled).toBe(false);
    // The draft, not the file, is what Preview renders.
    fireEvent.click(getByRole("button", { name: "Preview" }));
    expect(getByText("EDITED")).toBeTruthy();

    fireEvent.click(save);
    // Ruling 663: the save names the version the read returned, so the server
    // can refuse it once the file has changed. CANARY: stop sending it, and a
    // correction an agent merged while this editor was open is wiped.
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-write-doc",
        name: "overview.md",
        body: "# Overview\nEDITED",
        overwrite: "1",
        version: "0a1b2c3d4e5f",
      }),
    );
  });

  it("ruling 614: a doc that is not markdown opens on its raw text, with no Preview", async () => {
    const { getByLabelText, queryByRole } = renderBrowser({
      tree: [{ type: "file", name: "limits.yaml", sizeBytes: 9, mtime: new Date().toISOString() }],
      respond: (intent) =>
        intent === "store-read-doc" ? { ok: true, text: "max: 3\n", truncated: false } : undefined,
    });
    fireEvent.click(getByLabelText("Open limits.yaml"));
    const body = await waitFor(() =>
      control(getByLabelText("Document contents"), HTMLTextAreaElement),
    );
    expect(body.value).toBe("max: 3\n");
    expect(queryByRole("group", { name: "Document view" })).toBeNull();
  });

  it("ruling 614: a new document opens on its text, and Preview renders the draft", () => {
    // Nothing exists to render yet, so it opens raw. CANARY: open it on
    // `preview` and the text box this types into is not there.
    const { getByText, getByLabelText, getByRole } = renderBrowser();
    fireEvent.click(getByText("New document"));
    expect(getByRole("button", { name: "Raw" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(getByLabelText("Document contents"), {
      target: { value: "# Draft\n\n- one" },
    });
    fireEvent.click(getByRole("button", { name: "Preview" }));
    const preview = getByRole("region", { name: "Preview of the new document" });
    expect(within(preview).getByRole("heading", { level: 3, name: "Draft" })).toBeTruthy();
    expect(within(preview).getByRole("listitem").textContent).toBe("one");
  });

  it("a new document colliding with an existing file confirms before replacing", async () => {
    const { getByText, getByPlaceholderText, getByLabelText, getByRole, queryByRole } =
      renderBrowser();
    fireEvent.click(getByText("New document"));
    fireEvent.change(getByPlaceholderText("file-name.md"), {
      target: { value: "overview.md" },
    });
    fireEvent.change(getByLabelText("Document contents"), {
      target: { value: "CLOBBER" },
    });
    fireEvent.click(getByText("Save document"));

    // No write yet: the old editor posted straight through and the server
    // overwrote with the same "saved" toast.
    expect(lastForm).toBeNull();
    expect(getByText("Replace “overview.md”?")).toBeTruthy();
    // Ruling 458(f): the shared ConfirmDialog, named by its title and stacked
    // over the browser. Ruling 458(k): the overwrite warning still describes
    // it, as the hand-written card's `aria-describedby` did.
    const confirm = getByRole("alertdialog", { name: "Replace “overview.md”?" });
    expect(confirm.getAttribute("data-screen-label")).toBe("Replace document dialog");
    expect(confirm.classList.contains("over-modal")).toBe(true);
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toMatch(
      /Saving overwrites its contents/,
    );

    fireEvent(
      document.querySelector("dialog.confirm-card")!,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    await waitFor(() => expect(queryByRole("alertdialog")).toBeNull());
    expect(lastForm).toBeNull();
    // The draft survives the cancelled confirm.
    expect(
      control(getByLabelText("Document contents"), HTMLTextAreaElement).value,
    ).toBe("CLOBBER");

    fireEvent.click(getByText("Save document"));
    fireEvent.click(getByText("Replace document"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-write-doc",
        name: "overview.md",
        overwrite: "1",
      }),
    );
  });

  // A save's answer settles the draft it saved, not whatever the card holds
  // when it arrives (P14-UI-60: the typed body is the only copy). The stub
  // holds the save, and a document read, open while the person keeps the
  // draft, closes it, or opens another. CANARY: leave a refusal off the draft
  // it saved and the first row says nothing; settle the answer against the
  // open draft (drop the opening `openNew` or `openExisting` counts) and the
  // newer draft is closed under the person or wears the old save's error;
  // bring a refused draft back only into an empty card and a glance at another
  // document drops the only copy; drop the read's opening check, or the count
  // a draft brought back takes, and a read still in flight overwrites it;
  // toast the server's sentence, which can say "your text is still here", and
  // the last row repeats it over text that is gone.
  const REFUSED = "facts.md already exists. Open it to edit, or pick another name.";
  type View = ReturnType<typeof renderBrowser>;
  type HeldRead = PromiseWithResolvers<StubActionReply>;
  const typed = (view: View) =>
    control(view.getByLabelText("Document contents"), HTMLTextAreaElement).value;
  const startAnother = (text: string) => (view: View) => {
    // The open card is titled "New document" too: the toolbar's is the button.
    fireEvent.click(view.getByRole("button", { name: "New document" }));
    if (text) {
      fireEvent.change(view.getByLabelText("Document contents"), { target: { value: text } });
    }
  };
  const openOverview = async (view: View, read: HeldRead) => {
    fireEvent.click(view.getByLabelText("Open overview.md"));
    read.resolve({ ok: true, text: "# Overview\n\nOTHER FILE", truncated: false, version: "v2" });
    await view.findByRole("region", { name: "Preview of overview.md" });
  };
  const keptWithReason = async (view: View) => {
    await view.findByText(REFUSED);
    expect(typed(view)).toBe("THE ONLY COPY");
    expect(control(view.getByPlaceholderText("file-name.md"), HTMLInputElement).value).toBe(
      "facts.md",
    );
  };
  it.each([
    {
      answer: "a save refused while its draft is still open",
      settles: "keeps the typed body and says why (P14-UI-60)",
      meanwhile: () => {},
      reply: { ok: false, error: REFUSED },
      after: keptWithReason,
    },
    {
      answer: "a save that lands after New document",
      settles: "leaves that draft open",
      meanwhile: startAnother("SECOND DRAFT"),
      reply: { ok: true, toast: "facts.md saved · 13 bytes" },
      after: async (view: View) => {
        await view.findByText("facts.md saved · 13 bytes");
        expect(typed(view)).toBe("SECOND DRAFT");
      },
    },
    {
      answer: "a save that lands after another document opened",
      settles: "leaves that document open",
      meanwhile: openOverview,
      reply: { ok: true, toast: "facts.md saved · 13 bytes" },
      after: async (view: View) => {
        await view.findByText("facts.md saved · 13 bytes");
        expect(view.getByRole("region", { name: "Preview of overview.md" })).toBeTruthy();
      },
    },
    {
      answer: "a save refused after Escape closed its draft",
      settles: "brings the draft back and says why",
      meanwhile: (view: View) => {
        fireEvent(
          document.querySelector("dialog.modal-wide")!,
          new Event("cancel", { bubbles: false, cancelable: true }),
        );
        expect(view.queryByLabelText("Document contents")).toBeNull();
      },
      reply: { ok: false, error: REFUSED },
      after: keptWithReason,
    },
    {
      answer: "a save refused after an untouched New document",
      settles: "brings the draft back over it",
      meanwhile: startAnother(""),
      reply: { ok: false, error: REFUSED },
      after: keptWithReason,
    },
    {
      answer: "a save refused after another document opened untouched",
      settles: "brings the draft back over it",
      meanwhile: openOverview,
      reply: { ok: false, error: REFUSED },
      after: keptWithReason,
    },
    {
      answer: "a save refused while another document is still reading",
      settles: "brings the draft back, and the read does not fill it",
      meanwhile: (view: View) => {
        fireEvent.click(view.getByLabelText("Open overview.md"));
        expect(view.getByText("Loading document…")).toBeTruthy();
      },
      reply: { ok: false, error: REFUSED },
      after: async (view: View, read: HeldRead) => {
        await keptWithReason(view);
        read.resolve({ ok: true, text: "OTHER FILE", truncated: false, version: "v2" });
        // Save waits out a read in flight, so it posts once that read has
        // answered: what it posts is the draft as the read left it.
        lastForm = null;
        await waitFor(() => {
          fireEvent.click(view.getByText("Save document"));
          expect(lastForm?.intent).toBe("store-write-doc");
        });
        expect(lastForm).toMatchObject({ name: "facts.md", body: "THE ONLY COPY" });
      },
    },
    {
      answer: "a save refused while a draft with typing is open",
      settles: "says so in a toast, not on that draft, and claims no text was kept",
      meanwhile: startAnother("SECOND DRAFT"),
      reply: { ok: false, error: REFUSED },
      after: async (view: View) => {
        const told = await view.findByText(
          "facts.md was not saved, and its text could not be kept: another draft with changes was open.",
        );
        expect(told.closest(".toast")?.getAttribute("data-kind")).toBe("error");
        expect(document.body.textContent).not.toContain(REFUSED);
        expect(typed(view)).toBe("SECOND DRAFT");
      },
    },
  ])("$answer $settles", async ({ meanwhile, reply, after }) => {
    const held = Promise.withResolvers<StubActionReply>();
    const read: HeldRead = Promise.withResolvers<StubActionReply>();
    const view = renderBrowser({
      respond: (intent) =>
        intent === "store-write-doc"
          ? held.promise
          : intent === "store-read-doc"
            ? read.promise
            : undefined,
    });
    fireEvent.click(view.getByText("New document"));
    fireEvent.change(view.getByPlaceholderText("file-name.md"), {
      target: { value: "facts.md" },
    });
    fireEvent.change(view.getByLabelText("Document contents"), {
      target: { value: "THE ONLY COPY" },
    });
    fireEvent.click(view.getByText("Save document"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "store-write-doc", name: "facts.md" }),
    );
    await meanwhile(view, read);
    held.resolve(reply);
    await after(view, read);
  });

  // Ruling 147: an empty file name no longer kills the primary. Save stays
  // enabled, the click is refused with the sentence `writeStoreDoc` throws, and
  // nothing is submitted.
  it("ruling 147: a nameless draft is refused, not blocked", async () => {
    const { getByText, getByLabelText, getByPlaceholderText, queryByRole } =
      renderBrowser();
    fireEvent.click(getByText("New document"));
    fireEvent.change(getByLabelText("Document contents"), {
      target: { value: "# no name yet" },
    });
    const name = control(getByPlaceholderText("file-name.md"), HTMLInputElement);
    const save = getByText("Save document").closest("button")!;

    // Pristine: enabled, unmarked, nothing said.
    expect(save.disabled).toBe(false);
    expect(queryByRole("alert")).toBeNull();
    expect(name.getAttribute("aria-invalid")).toBeNull();

    fireEvent.click(save);
    expect(lastForm).toBeNull();
    const first = queryByRole("alert")!;
    expect(first.textContent).toContain("Give the document a file name.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(first.id);
    expect(document.activeElement).toBe(name);

    // Each refusal is a NEW element, so a repeat press is announced again.
    fireEvent.click(save);
    expect(lastForm).toBeNull();
    expect(queryByRole("alert")).not.toBe(first);

    // Naming it clears the mark and the save goes through.
    fireEvent.change(name, { target: { value: "facts.md" } });
    expect(queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-write-doc",
        name: "facts.md",
      }),
    );
  });

  it("ruling 147: a re-opened draft is pristine, never still accused", () => {
    const { getByText, queryByRole, getByPlaceholderText } = renderBrowser();
    fireEvent.click(getByText("New document"));
    fireEvent.click(getByText("Save document").closest("button")!);
    expect(queryByRole("alert")).toBeTruthy();
    fireEvent.click(getByText("Cancel"));
    fireEvent.click(getByText("New document"));
    expect(queryByRole("alert")).toBeNull();
    expect(
      getByPlaceholderText("file-name.md").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("a doc too large to load cannot be saved back over the original", async () => {
    const { getByLabelText, getByText } = renderBrowser({
      respond: (intent) =>
        intent === "store-read-doc"
          ? { ok: true, text: "first part only", truncated: true }
          : undefined,
    });
    fireEvent.click(getByLabelText("Open overview.md"));
    await waitFor(() =>
      expect(getByText(/larger than the editor can load/)).toBeTruthy(),
    );
    expect(getByText("Save document").closest("button")!.disabled).toBe(true);
  });
});

/**
 * P13-D-10: `useToast().push(text, kind?)` defaults to `"success"`, so this
 * hand-rolled handler rendered a failed store operation under the green tick.
 */
describe("StoreBrowser failure toast kind (P13-D-10)", () => {
  it("pushes a failed action as an error toast, not under the success tick", async () => {
    const { getByText, getByLabelText } = renderBrowser({
      actionResult: { ok: false, error: "Folder already exists." },
    });
    fireEvent.click(getByText("New folder"));
    const input = getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "uploads" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("Folder already exists.");
    expect(toast.getAttribute("data-kind")).toBe("error");
  });
});

/**
 * P13-UI-08 residual: an upload whose every path was dot-filtered submitted
 * nothing and said nothing — no request, no toast, no error. From the user's
 * side that is indistinguishable from a successful upload.
 */
describe("StoreBrowser upload that uploads nothing (P13-UI-08)", () => {
  const hidden = (name: string) => new File(["x"], name, { type: "text/plain" });

  it("says the drop was all hidden files instead of doing nothing", async () => {
    const { container } = renderBrowser();
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]:not([webkitdirectory])',
    )!;
    fireEvent.change(input, {
      target: { files: [hidden(".DS_Store"), hidden(".env")] },
    });
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    expect(document.querySelector(".toast")!.textContent).toContain(
      "Nothing uploaded: 2 hidden items skipped",
    );
    // Nothing was posted — the filter is client-side, and it stays that way.
    expect(lastForm).toBeNull();
  });
});
