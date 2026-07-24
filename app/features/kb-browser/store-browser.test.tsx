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

function renderBrowser(
  overrides: {
    tree?: StoreNode[];
    onClose?: () => void;
    /** Make the org-settings action fail, to exercise the failure toast. */
    actionResult?: Record<string, unknown>;
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
          if (typeof v === "string") lastForm[k] = v;
        }
        return overrides.actionResult ?? { ok: true, toast: "stub done" };
      },
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

describe("StoreBrowser", () => {
  it("renders the tree (top-level dirs expanded), footer stats and def-note", () => {
    const { getByText } = renderBrowser();
    expect(document.querySelector('[aria-label="Files — Architecture notes"]')).toBeTruthy();
    expect(getByText("decisions")).toBeTruthy();
    expect(getByText("adr-001.md")).toBeTruthy(); // expanded by default
    expect(getByText("overview.md")).toBeTruthy();
    expect(getByText("4.2 KB · just now")).toBeTruthy();
    expect(getByText("1 folder · 2 files · indexed just now")).toBeTruthy();
    expect(getByText(/This is the real folder on disk/)).toBeTruthy();
    expect(getByText("drag files or folders onto a folder to upload there")).toBeTruthy();
  });

  it("empty tree renders the empty state", () => {
    const { getByText } = renderBrowser({ tree: [] });
    expect(
      getByText("Empty — drag files or folders here, upload, or import from GitHub."),
    ).toBeTruthy();
  });

  it("new-folder input commits on Enter with mkdir -p semantics", async () => {
    const { getByText, getByLabelText } = renderBrowser();
    fireEvent.click(getByText("New folder"));
    const input = getByLabelText("New folder name") as HTMLInputElement;
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

  it("delete goes through the nested confirm; Escape closes only the top layer", async () => {
    let closed = 0;
    const { getByText, getByLabelText, queryByRole } = renderBrowser({
      onClose: () => {
        closed += 1;
      },
    });
    fireEvent.click(getByLabelText("Delete overview.md"));
    expect(getByText("Delete “overview.md”?")).toBeTruthy();
    expect(
      getByText("The file is removed from the store. Agents lose it on their next context load."),
    ).toBeTruthy();

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
    expect(getByText(/Paste a GitHub link — a repo, or a folder like/)).toBeTruthy();
    expect(lastForm).toBeNull();

    fireEvent.change(getByPlaceholderText("https://github.com/owner/repo/tree/main/docs"), {
      target: { value: "https://github.com/owner/repo/tree/main/docs" },
    });
    fireEvent.click(getByText("Import"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "store-import-github",
        url: "https://github.com/owner/repo/tree/main/docs",
      }),
    );
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
    const input = getByLabelText("New folder name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "uploads" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("Folder already exists.");
    // `alert` is the triangle path; `check` is the tick.
    expect(toast.querySelector("svg.ico")!.innerHTML).toContain("M12 4l9 16H3z");
  });
});
