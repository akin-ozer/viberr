// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { z } from "zod";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import { ToastProvider } from "~/ui/toast";
import { ChangesPanel } from "./changes-slot";

afterEach(cleanup);

/**
 * Ruling 484 (pass 40, F40-54): the task page's Changes panel. A person saw
 * `Diff N files · +a −d` and nothing to read, and "approve each note in review"
 * could only happen on GitHub, where a rejected note never reached the agent.
 * The panel reads the delivered revision's patches and sends line notes to
 * the deliverer as ONE comment through the task's `review-notes` intent.
 */

const HEAD = "5d1f0e2c0ffee000000000000000000000000000";

const VIEW: TaskChangesView = {
  ok: true,
  prNumber: 3,
  repo: "akin-ozer/website",
  headSha: HEAD,
  files: [
    {
      path: "notes/one.md",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1,2 +1,3 @@\n-old line\n+new line\n+second\n keep",
      patchOmitted: null,
    },
    {
      path: "data/big.json",
      status: "modified",
      additions: 900,
      deletions: 0,
      patch: null,
      patchOmitted: "budget",
    },
    {
      path: "logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      patch: null,
      patchOmitted: "none-from-github",
    },
  ],
  moreFiles: false,
  truncated: true,
  recipient: { name: "Content Writer", handle: "content-writer" },
};

const BIG_FILE: TaskChangesView = {
  ...VIEW,
  files: [
    {
      path: "data/big.json",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+{}",
      patchOmitted: null,
    },
  ],
  truncated: false,
};

/** One `review-notes` note as the intent receives it; a note on several
 *  lines also names its first line and that line's side (ruling 509). */
const postedNotes = z.array(
  z.strictObject({
    path: z.string(),
    line: z.number(),
    side: z.enum(["new", "old"]),
    startLine: z.number().optional(),
    startSide: z.enum(["new", "old"]).optional(),
    body: z.string(),
  }),
);

function renderPanel(opts: { view?: TaskChangesView; revisionSha?: string } = {}) {
  const posted: { intent: string; headSha: string; notes: string }[] = [];
  const reads: string[] = [];
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <ChangesPanel
            url="/t/changes"
            githubHost="https://github.com"
            prNumber={3}
            revisionSha={opts.revisionSha ?? HEAD}
            delivererName="Content Writer"
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        posted.push({
          intent: String(fd.get("intent")),
          headSha: String(fd.get("headSha")),
          notes: String(fd.get("notes")),
        });
        return { ok: true, toast: "1 note sent · @Content Writer is picking it up" };
      },
    },
    {
      path: "/t/changes",
      loader: ({ request }) => {
        const url = new URL(request.url);
        reads.push(url.search);
        return url.searchParams.get("path") ? BIG_FILE : (opts.view ?? VIEW);
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/t"]} />);
  return { ...utils, posted, reads };
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
  await screen.findByText("notes/one.md");
}

describe("ruling 484: the Changes panel", () => {
  it("ships closed and reads nothing from GitHub until a person opens it", async () => {
    const { reads } = renderPanel();
    expect(screen.getByRole("heading", { name: "Changes" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(reads).toHaveLength(0);
    await open();
    expect(reads).toEqual([""]);
    expect(screen.getByRole("button", { name: "Hide changes" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("numbers each line as the file has it, and a line's number is its note button", async () => {
    renderPanel();
    await open();
    for (const name of [
      "Add a note on notes/one.md line 1, removed",
      "Add a note on notes/one.md line 1",
      "Add a note on notes/one.md line 2",
      "Add a note on notes/one.md line 3",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // The two files without a patch say why, never read as "changed nothing".
    expect(screen.getByText(/larger than one read carries/)).toBeTruthy();
    expect(screen.getByText(/a binary file, or one too large/)).toBeTruthy();
  });

  it("sends every note as ONE review-notes post bound to the revision read, then clears them", async () => {
    const { posted } = renderPanel();
    await open();
    const lineTwo = screen.getByRole("button", { name: "Add a note on notes/one.md line 2" });
    fireEvent.click(lineTwo);
    const box = screen.getByRole("textbox", { name: "Note on notes/one.md line 2" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Cut this line." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    // The editor closes, the note stays under its line, and focus goes back.
    expect(screen.getByText("Cut this line.")).toBeTruthy();
    expect(document.activeElement).toBe(lineTwo);

    fireEvent.click(screen.getByRole("button", { name: "Add a note on notes/one.md line 1, removed" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note on notes/one.md line 1, removed" }), {
      target: { value: "Keep it." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByText("2 notes for @Content Writer, sent as one comment.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send to @Content Writer" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.intent).toBe("review-notes");
    expect(posted[0]!.headSha).toBe(HEAD);
    expect(postedNotes.parse(JSON.parse(posted[0]!.notes))).toEqual([
      { path: "notes/one.md", line: 2, side: "new", body: "Cut this line." },
      { path: "notes/one.md", line: 1, side: "old", body: "Keep it." },
    ]);
    await screen.findByText("No notes yet. Select a line number to add one, or drag across several.");
    expect(await screen.findByText("1 note sent · @Content Writer is picking it up")).toBeTruthy();
  });

  it("Escape closes the editor without a note and hands focus back", async () => {
    renderPanel();
    await open();
    const lineOne = screen.getByRole("button", { name: "Add a note on notes/one.md line 1" });
    fireEvent.click(lineOne);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(lineOne);
    expect(screen.getByText("No notes yet. Select a line number to add one, or drag across several.")).toBeTruthy();
  });

  it("keeps unsent notes while the panel is hidden", async () => {
    renderPanel();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a note on notes/one.md line 3" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep me." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByText("Keep me.")).toBeTruthy();
  });

  it("loads a file the first read left out for size, by its path", async () => {
    const { reads } = renderPanel();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Load this file" }));
    await screen.findByRole("button", { name: "Add a note on data/big.json line 1" });
    expect(reads).toEqual(["", "?path=data%2Fbig.json"]);
  });

  it("offers no note on a revision that is no longer the delivered one, and says so", async () => {
    const { container } = renderPanel({ revisionSha: "9".repeat(40) });
    await open();
    expect(container.querySelector(".chg-stale")?.textContent).toContain(
      "A new revision, 9999999, was delivered after these changes were read.",
    );
    expect(screen.queryByRole("button", { name: /Add a note/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Read the new revision" })).toBeTruthy();
  });

  it("offers no note when no deployed agent delivers the task", async () => {
    renderPanel({ view: { ...VIEW, recipient: null } });
    await open();
    expect(screen.getByText(/No deployed agent delivers this task/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add a note/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send to/ })).toBeNull();
  });

  it("says why it could not read, as an alert with a retry", async () => {
    const { reads } = renderPanel({ view: { ok: false, reason: "PR #3 is at 0bad000, not the delivered revision 5d1f0e2." } });
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not the delivered revision 5d1f0e2");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads).toHaveLength(2));
  });
});

/**
 * Ruling 509: a note may cover several lines of one hunk. The owner reviewed a
 * runbook paragraph by paragraph and could only note one line at a time. The
 * VIEW's `notes/one.md` hunk draws, in order: removed line 1, new lines 1 and
 * 2 (added), new line 3 (context).
 */
describe("ruling 509: a note on several lines", () => {
  const num = (name: string) => screen.getByRole("button", { name });
  const selectedRows = (container: HTMLElement) =>
    [...container.querySelectorAll(".chg-row[data-sel]")].map(
      (row) => row.querySelector(".chg-num")?.textContent,
    );

  it("shift-click stretches the open note to another line, and the note is sent with its first line", async () => {
    const { container, posted } = renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 1"));
    fireEvent.click(num("Add a note on notes/one.md line 3"), { shiftKey: true });
    const box = screen.getByRole("textbox", { name: "Note on notes/one.md lines 1 to 3" });
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("placeholder")).toBe("What should change on these lines?");
    expect(selectedRows(container)).toEqual(["1", "2", "3"]);
    fireEvent.change(box, { target: { value: "Merge these into one sentence." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    // The note sits under its last line, names its lines, and each of them
    // is now the button that opens it.
    const note = container.querySelector(".chg-note")!;
    expect(note.textContent).toContain("Lines 1 to 3");
    expect(note.textContent).toContain("Merge these into one sentence.");
    expect(screen.getAllByRole("button", { name: "Edit the note on notes/one.md lines 1 to 3" })).toHaveLength(3);
    expect(container.querySelectorAll(".chg-row[data-noted]")).toHaveLength(3);
    // Focus goes back to the number pressed last.
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "Edit the note on notes/one.md lines 1 to 3" })[2],
    );

    fireEvent.click(screen.getByRole("button", { name: "Send to @Content Writer" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(postedNotes.parse(JSON.parse(posted[0]!.notes))).toEqual([
      {
        path: "notes/one.md",
        line: 3,
        side: "new",
        startLine: 1,
        startSide: "new",
        body: "Merge these into one sentence.",
      },
    ]);
  });

  it("names both ends of a range that runs from a removed line to an added one", async () => {
    const { posted } = renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 1, removed"));
    fireEvent.click(num("Add a note on notes/one.md line 2"), { shiftKey: true });
    const box = screen.getByRole("textbox", { name: "Note on notes/one.md removed line 1 to line 2" });
    fireEvent.change(box, { target: { value: "The old wording was clearer." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(screen.getByText("Removed line 1 to line 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to @Content Writer" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(postedNotes.parse(JSON.parse(posted[0]!.notes))).toEqual([
      {
        path: "notes/one.md",
        line: 2,
        side: "new",
        startLine: 1,
        startSide: "old",
        body: "The old wording was clearer.",
      },
    ]);
  });

  it("a mouse drag across the numbers opens a note on the lines it crossed, and Escape drops it", async () => {
    const { container } = renderPanel();
    await open();
    fireEvent.pointerDown(num("Add a note on notes/one.md line 1"), { pointerType: "mouse", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 3"));
    // The lines light up while the button is held; nothing opens yet.
    expect(selectedRows(container)).toEqual(["1", "2", "3"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(selectedRows(container)).toEqual([]);
    fireEvent.pointerUp(window);
    expect(screen.queryByRole("textbox")).toBeNull();

    // Upward this time: the note still reads first line to last.
    fireEvent.pointerDown(num("Add a note on notes/one.md line 3"), { pointerType: "mouse", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 2"));
    fireEvent.pointerUp(window);
    const box = screen.getByRole("textbox", { name: "Note on notes/one.md lines 2 to 3" });
    expect(document.activeElement).toBe(box);
  });

  it("a touch on the numbers starts no drag, so the page scrolls", async () => {
    const { container } = renderPanel();
    await open();
    fireEvent.pointerDown(num("Add a note on notes/one.md line 1"), { pointerType: "touch", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 3"));
    expect(selectedRows(container)).toEqual([]);
  });

  it("a drag from a line of the open note re-ranges it and keeps what was typed", async () => {
    renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 1"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a thought" } });
    fireEvent.pointerDown(num("Add a note on notes/one.md line 1"), { pointerType: "mouse", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 3"));
    fireEvent.pointerUp(window);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note on notes/one.md lines 1 to 3" });
    expect(box.value).toBe("Half a thought");
  });

  // CANARY: re-range the note a drag began on whatever happened since
  // (`setDraft({ ...draft, … })` in moveDraft) and the release brings back the
  // note just saved or cancelled, or replaces the one just opened; set
  // `opener` for a note no longer open and closing the new one sends focus to
  // the number the drag began on.
  it.each([
    {
      what: "saves the note (Ctrl+Enter)",
      key: () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true }),
      editor: null,
      focused: "Edit the note on notes/one.md line 1",
    },
    {
      what: "cancels it",
      key: () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
      editor: null,
      focused: "Add a note on notes/one.md line 1",
    },
    {
      what: "opens another line's note",
      key: () => fireEvent.click(num("Add a note on notes/one.md line 1, removed")),
      editor: "Note on notes/one.md line 1, removed",
      focused: "Add a note on notes/one.md line 1, removed",
    },
  ])("a key that $what during a drag of the open note stays done when the drag is let go", async ({ key, editor, focused }) => {
    renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 1"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half a thought" } });
    fireEvent.pointerDown(num("Add a note on notes/one.md line 1"), { pointerType: "mouse", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 3"));
    key();
    fireEvent.pointerUp(window);
    expect(screen.queryByRole("textbox")?.getAttribute("aria-label") ?? null).toBe(editor);
    // Escape closes an editor still open, and focus is on the number that opened it.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(num(focused));
  });

  it("a range stops before a line that has its own note, and a line carries one note", async () => {
    const { container } = renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 2"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this line." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    fireEvent.click(num("Add a note on notes/one.md line 1"));
    fireEvent.click(num("Add a note on notes/one.md line 3"), { shiftKey: true });
    expect(screen.getByRole("textbox", { name: "Note on notes/one.md line 1" })).toBeTruthy();
    expect(selectedRows(container)).toEqual(["1"]);

    // Dragged up across the noted line and released there: the note stays on
    // the line the drag could reach.
    fireEvent.pointerDown(num("Add a note on notes/one.md line 3"), { pointerType: "mouse", button: 0 });
    fireEvent.pointerOver(num("Add a note on notes/one.md line 1"));
    fireEvent.pointerUp(num("Add a note on notes/one.md line 1"));
    expect(screen.getByRole("textbox", { name: "Note on notes/one.md line 3" })).toBeTruthy();
  });

  it("pressing any line of a note opens it, and saving a new range rewrites that note", async () => {
    renderPanel();
    await open();
    fireEvent.click(num("Add a note on notes/one.md line 1"));
    fireEvent.click(num("Add a note on notes/one.md line 3"), { shiftKey: true });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too long." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    const middle = screen.getAllByRole("button", { name: "Edit the note on notes/one.md lines 1 to 3" })[1]!;
    fireEvent.click(middle);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note on notes/one.md lines 1 to 3" });
    expect(box.value).toBe("Too long.");
    // Shift-click from the note's first line narrows it to two lines.
    fireEvent.click(middle, { shiftKey: true });
    expect(screen.getByRole("textbox", { name: "Note on notes/one.md lines 1 to 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(screen.getByText("1 note for @Content Writer, sent as one comment.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Edit the note on notes/one.md lines 1 to 2" })).toHaveLength(2);
    expect(num("Add a note on notes/one.md line 3")).toBeTruthy();
  });
});
