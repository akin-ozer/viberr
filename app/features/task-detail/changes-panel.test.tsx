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

/** One `review-notes` note as the intent receives it. */
const postedNotes = z.array(
  z.object({ path: z.string(), line: z.number(), side: z.enum(["new", "old"]), body: z.string() }),
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
    await screen.findByText("No notes yet. Select a line number to add one.");
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
    expect(screen.getByText("No notes yet. Select a line number to add one.")).toBeTruthy();
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
