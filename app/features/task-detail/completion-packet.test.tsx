// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import { ToastProvider } from "~/ui/toast";
import { CompletionPacket } from "./completion-packet";

afterEach(cleanup);

/**
 * Ruling 521: the completion packet as the person who accepts reads it. What
 * the loader ships is the route suite's and which verdict counts is the
 * server suite's; this suite owns what the card says about each reviewer, the
 * screenshots, and when the diff is read.
 */

const HEAD = "a".repeat(40);

const DIFF: TaskChangesView = {
  ok: true,
  prNumber: 318,
  repo: "akin-ozer/viberr",
  headSha: HEAD,
  files: [
    {
      path: "app/server/attach-policy.ts",
      status: "modified",
      additions: 12,
      deletions: 3,
      patch: "@@ -1,2 +1,2 @@\n-const repos = [];\n+const repo = null;\n keep",
      patchOmitted: null,
    },
  ],
  moreFiles: false,
  truncated: false,
  recipient: { name: "Developer", handle: "developer" },
};

function view(patch: Partial<CompletionView> = {}): CompletionView {
  return {
    subjectSha: "aaaaaaa",
    packet: {
      summary: "A task attaches one repository and records its branch first.",
      changes: null,
      screenshots: [],
      hiddenScreenshots: 0,
      at: "2026-09-27T10:00:00.000Z",
      staleFor: null,
    },
    verdicts: [],
    change: { files: 1, add: 12, del: 3, small: true },
    ...patch,
  };
}

function renderPacket(v: CompletionView) {
  const reads: string[] = [];
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <CompletionPacket
            view={v}
            attachmentsBase="/t/attachments"
            diff={{
              url: "/t/changes",
              githubHost: "https://github.com",
              prNumber: 318,
              revisionSha: HEAD,
              delivererName: "Developer",
            }}
          />
        </ToastProvider>
      ),
    },
    {
      path: "/t/changes",
      loader: ({ request }) => {
        reads.push(new URL(request.url).search);
        return DIFF;
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/t"]} />);
  return { ...utils, reads };
}

const verdictRow = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>(".cmp-verdict")].find(
    (row) => row.querySelector("strong")?.textContent === name,
  )!;

describe("ruling 521: the completion packet", () => {
  it("says where each reviewer stands on the work under review, and shows a verdict on earlier work as stale", () => {
    // CANARY: draw `row.earlier` as the row's verdict and QA reads
    // "Approved" for a revision it never saw.
    const { container } = renderPacket(
      view({
        verdicts: [
          { profileId: "reviewer", name: "Code Reviewer", result: "approve", reason: "The gate refuses a second repository.", at: "2026-09-27T09:30:00.000Z", required: true, earlier: null },
          { profileId: "qa", name: "QA", result: "pending", reason: "", at: null, required: true, earlier: { result: "approve", sha: "bbbbbbb", at: "2026-09-27T08:00:00.000Z" } },
          { profileId: "security", name: "Security", result: "request_changes", reason: "Log the refused repository.", at: "2026-09-27T09:40:00.000Z", required: false, earlier: null },
        ],
      }),
    );
    const reviewer = within(verdictRow(container, "Code Reviewer"));
    expect(reviewer.getByText("Approved")).toBeTruthy();
    expect(reviewer.getByText("The gate refuses a second repository.")).toBeTruthy();
    const qa = verdictRow(container, "QA");
    expect(within(qa).getByText("No verdict on aaaaaaa yet")).toBeTruthy();
    expect(qa.querySelector(".cmp-earlier")?.textContent).toMatch(
      /^StaleApproved on bbbbbbb .+, before the work under review was delivered\.$/,
    );
    expect(qa.textContent).not.toContain("not required");
    const security = within(verdictRow(container, "Security"));
    expect(security.getByText("Requested changes")).toBeTruthy();
    expect(security.getByText("not required")).toBeTruthy();
  });

  it("opens a small change whole and reads it as the card mounts; a large one shows Operator's summary and reads nothing until pressed", async () => {
    // CANARY: pass `defaultOpen` whatever the size and a 499-line change is
    // read from GitHub every time the page is opened.
    const small = renderPacket(view());
    expect(await screen.findByText("app/server/attach-policy.ts")).toBeTruthy();
    expect(small.reads).toEqual([""]);
    expect(screen.getByRole("button", { name: "Hide the diff" }).getAttribute("aria-expanded")).toBe("true");
    small.unmount();

    const large = renderPacket(
      view({
        packet: { ...view().packet!, changes: "- **Policy gate**: refuses a second repository." },
        change: { files: 9, add: 412, del: 87, small: false },
      }),
    );
    expect(large.container.querySelector(".cmp-stat")?.textContent).toBe(
      "9 files changed+412−87Over 200 lines, so this is Operator's summary",
    );
    expect(screen.getByText("Policy gate")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the diff" }).getAttribute("aria-expanded")).toBe("false");
    expect(large.reads).toEqual([]);
  });

  it("shows the screenshots Operator picked with their captions, and says when its summary describes earlier work or is missing", () => {
    // CANARY: drop `staleFor` from the card and a summary of the revision a
    // rework replaced reads as a summary of what is up for acceptance.
    const { container, unmount } = renderPacket(
      view({
        packet: {
          ...view().packet!,
          screenshots: [{ name: "attach-dialog.png", caption: "The attach dialog" }],
          hiddenScreenshots: 1,
          staleFor: "bbbbbbb",
        },
      }),
    );
    const shot = screen.getByRole("link", { name: "Open screenshot attach-dialog.png" });
    expect(shot.getAttribute("href")).toBe("/t/attachments/attach-dialog.png");
    expect(within(shot).getByText("The attach dialog")).toBeTruthy();
    expect(screen.getByText(/^1 screenshot Operator picked is not shown/)).toBeTruthy();
    expect(container.querySelector(".cmp-stale")?.textContent).toBe(
      "Operator wrote this for earlier work (bbbbbbb), before aaaaaaa was delivered.",
    );
    unmount();

    renderPacket(view({ packet: null }));
    expect(
      screen.getByText(
        "Operator has not summarized this work yet. The verdicts and the change below are current.",
      ),
    ).toBeTruthy();
  });
});
