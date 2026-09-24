// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
    /** Per-intent canned responses (the editor reads AND writes). */
    respond?: (intent: string) => StubActionReply | undefined;
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
    // role="button", tabIndex and an activate handler. This one is a text
    // field in a row shell: clicking it only blurs the input, which DISMISSES
    // the half-typed name.
    expect(row.className).toContain("editing");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
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
    // Ruling 455(f): the shared ConfirmDialog, named by its title, stacked over
    // the browser, and no longer described by an id nothing carries.
    const confirm = getByRole("alertdialog", { name: "Delete “overview.md”?" });
    expect(confirm.getAttribute("data-screen-label")).toBe("Store deletion dialog");
    expect(confirm.classList.contains("over-modal")).toBe(true);
    expect(confirm.hasAttribute("aria-describedby")).toBe(false);

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
    const { getByText, getByPlaceholderText } = renderBrowser();
    fireEvent.click(getByText("Add from GitHub"));
    fireEvent.click(getByText("Import"));
    expect(getByText(/Paste a GitHub link: a repo, or a folder like/)).toBeTruthy();
    expect(lastForm).toBeNull();

    fireEvent.change(getByPlaceholderText("https://github.com/owner/repo/tree/main/docs"), {
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

  it("ruling 149: both typing controls ride the shared .field chrome", () => {
    // Canary: unwrap either control and it paints in UA chrome inside a card
    // whose every other control wears the sheet's — the class this closes.
    const { getByText, getByLabelText, getByPlaceholderText } = renderBrowser();
    fireEvent.click(getByText("New document"));
    const name = getByPlaceholderText("file-name.md");
    expect(name.closest(".field")).not.toBeNull();
    expect(getByText("File name").tagName).toBe("LABEL");
    const body = getByLabelText("Document contents");
    expect(body.closest(".field")).not.toBeNull();
    // The visible label IS the accessible name: no aria-label overriding it.
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

  it("clicking a text doc opens it in place with its real contents", async () => {
    const { getByLabelText, getByText } = renderBrowser({
      respond: (intent) =>
        intent === "store-read-doc"
          ? { ok: true, text: "# Overview\nLOADED", truncated: false }
          : undefined,
    });
    fireEvent.click(getByLabelText("Open overview.md"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-read-doc",
        path: JSON.stringify(["overview.md"]),
      }),
    );
    const body = control(getByLabelText("Document contents"), HTMLTextAreaElement);
    await waitFor(() => expect(body.value).toContain("LOADED"));
    // The name is the file's own — the editor edits it, it does not re-create it.
    expect(getByText("overview.md", { selector: ".fm-doc-path" })).toBeTruthy();

    fireEvent.change(body, { target: { value: "# Overview\nEDITED" } });
    fireEvent.click(getByText("Save document"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-write-doc",
        name: "overview.md",
        body: "# Overview\nEDITED",
        overwrite: "1",
      }),
    );
  });

  it("a non-text file offers no editor affordance", () => {
    const { queryByLabelText } = renderBrowser({
      tree: [
        { type: "file", name: "contract.pdf", sizeBytes: 900, mtime: new Date().toISOString() },
      ],
    });
    expect(queryByLabelText("Open contract.pdf")).toBeNull();
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
    // Ruling 455(f): the shared ConfirmDialog, named by its title and stacked
    // over the browser.
    const confirm = getByRole("alertdialog", { name: "Replace “overview.md”?" });
    expect(confirm.getAttribute("data-screen-label")).toBe("Replace document dialog");
    expect(confirm.classList.contains("over-modal")).toBe(true);

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

  it("P14-UI-60: a rejected save keeps the typed body and says why", async () => {
    const { getByText, getByPlaceholderText, getByLabelText } = renderBrowser({
      respond: (intent) =>
        intent === "store-write-doc"
          ? { ok: false, error: "facts.md already exists — open it to edit." }
          : undefined,
    });
    fireEvent.click(getByText("New document"));
    fireEvent.change(getByPlaceholderText("file-name.md"), {
      target: { value: "facts.md" },
    });
    fireEvent.change(getByLabelText("Document contents"), {
      target: { value: "THE ONLY COPY" },
    });
    fireEvent.click(getByText("Save document"));

    // The editor used to close optimistically, so the server's rejection
    // arrived after the draft had already been destroyed.
    await waitFor(() =>
      expect(getByText("facts.md already exists — open it to edit.")).toBeTruthy(),
    );
    expect(
      control(getByLabelText("Document contents"), HTMLTextAreaElement).value,
    ).toBe("THE ONLY COPY");
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
  it("renders the alert glyph, not the success tick, when the action fails", async () => {
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
    // `alert` is the triangle path; `check` is the tick.
    expect(toast.querySelector("svg.ico")!.innerHTML).toContain("M12 4l9 16H3z");
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
