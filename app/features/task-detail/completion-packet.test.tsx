// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import { ToastProvider } from "~/ui/toast";
import { CompletionPacket, type CompletionResult } from "./completion-packet";

afterEach(cleanup);

/**
 * Ruling 521: the completion packet as the person who accepts reads it. What
 * the loader ships is the route suite's and which verdict counts is the
 * server suite's; this suite owns what the card says about each reviewer, the
 * screenshots, and when the diff is read. Ruling 668: and what the card shows
 * as the result of an accepted task.
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
      considerations: null,
      assumptions: null,
      gaps: null,
      files: [],
      hiddenFiles: 0,
      screenshots: [],
      hiddenScreenshots: 0,
      at: "2026-09-27T10:00:00.000Z",
      staleFor: null,
    },
    verdicts: [],
    change: { files: 1, add: 12, del: 3, small: true },
    paths: null,
    ...patch,
  };
}

/** `result` set: the card of an accepted task, which has no diff to read. */
function renderPacket(v: CompletionView, result: CompletionResult | null = null) {
  const reads: string[] = [];
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <CompletionPacket
            view={v}
            attachmentsBase="/t/attachments"
            standalone={result !== null}
            result={result}
            diff={
              result
                ? null
                : {
                    url: "/t/changes",
                    githubHost: "https://github.com",
                    prNumber: 318,
                    revisionSha: HEAD,
                    delivererName: "Developer",
                  }
            }
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
      "9 files changed+412−87·Over 200 lines, so this is Operator's summary",
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

describe("ruling 668: the card is the task's result once it is accepted", () => {
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll(".cmp-k")].map((el) => el.textContent);

  it("shows a files delivery's result: Operator's notes under their labels, and each result file with what it is", () => {
    // CANARY: draw a note whose text is null and every result carries three
    // empty headings; drop the file rows and the result has no output on it.
    const { container } = renderPacket(
      view({
        subjectSha: null,
        change: null,
        packet: {
          ...view().packet!,
          summary: "The estimate comes to $2,126.77 a month.",
          assumptions: "730 hours a month.",
          gaps: "Nobody gave data transfer figures.",
          files: [
            { name: "My-Estimate.json", caption: "The calculator import", page: null },
            { name: "summary.md", caption: "", page: null },
          ],
          hiddenFiles: 1,
        },
        verdicts: [
          { profileId: "judge", name: "Estimate Judge", result: "approve", reason: "", at: "2026-10-06T09:00:00.000Z", required: true, earlier: null },
          { profileId: "qa", name: "QA", result: "pending", reason: "", at: null, required: true, earlier: null },
        ],
      }),
      { pr: null },
    );
    expect(screen.getByRole("heading", { level: 2, name: "Result" })).toBeTruthy();
    // Considerations has nothing to say, so it has no heading; with no
    // revision and no pull request there is no Changes section either.
    expect(labels(container)).toEqual(["Files", "Assumptions", "Gaps", "Reviewers"]);
    const file = screen.getByRole("link", { name: /My-Estimate\.json/ });
    expect(file.getAttribute("href")).toBe("/t/attachments/My-Estimate.json");
    expect(file.querySelector(".cmp-file-ext")?.textContent).toBe("json");
    expect(within(file).getByText("The calculator import")).toBeTruthy();
    expect(screen.getByRole("link", { name: /summary\.md/ }).querySelector(".cmp-file-what")).toBeNull();
    expect(screen.getByText(/^1 result file Operator named is not shown/)).toBeTruthy();
    expect(screen.getByText("Nobody gave data transfer figures.")).toBeTruthy();
    // Nobody is still owed a verdict on an accepted task.
    expect(verdictRow(container, "Estimate Judge")).toBeTruthy();
    expect(verdictRow(container, "QA")).toBeUndefined();
  });

  it("shows a revision's result as its pull request, the change's size and the paths it changed, with no diff to read", () => {
    // CANARY: keep the offer's "Over 200 lines" note or its diff reader on the
    // result and an accepted task promises a diff that is one press away.
    const { container, reads } = renderPacket(
      view({
        packet: { ...view().packet!, changes: "- **Policy gate**: refuses a second repository." },
        change: { files: 9, add: 412, del: 87, small: false },
        paths: { shown: ["app/server/attach-policy.ts", "docs/domain/github-delivery.md"], more: 7, truncated: false },
      }),
      { pr: { number: 318, url: "https://github.com/akin-ozer/viberr/pull/318", merged: true } },
    );
    expect(labels(container)).toEqual(["Changes"]);
    expect(container.querySelector(".cmp-stat")?.textContent).toBe("PR #318merged·9 files changed+412−87");
    expect(screen.getByRole("link", { name: "PR #318" }).getAttribute("href")).toBe(
      "https://github.com/akin-ozer/viberr/pull/318",
    );
    expect(screen.getByText("Policy gate")).toBeTruthy();
    expect([...container.querySelectorAll(".cmp-paths li")].map((li) => li.textContent)).toEqual([
      "app/server/attach-policy.ts",
      "docs/domain/github-delivery.md",
    ]);
    expect(screen.getByText("And 7 more paths. The pull request lists every file.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /the diff/ })).toBeNull();
    expect(reads).toEqual([]);
  });

  it("a result file that is a page shows its desktop and phone pictures beside its row, and the reason when there is none", () => {
    // Ruling 691. CANARY: remove the `f.page` block from the Files list and a
    // delivered page is a file row again, judged from its source.
    const at = "2026-10-07T12:00:09.412Z";
    renderPacket(
      view({
        subjectSha: null,
        change: null,
        packet: {
          ...view().packet!,
          files: [
            {
              name: "post.html",
              caption: "The launch post",
              page: {
                shots: [
                  { view: "desktop", name: "post.html.capture-desktop.png", at, cut: false },
                  { view: "phone", name: "post.html.capture-phone.png", at, cut: true },
                ],
                note: null,
              },
            },
            { name: "notes.md", caption: "", page: { shots: [], note: "the render ran past 25 seconds" } },
            { name: "figures.csv", caption: "", page: null },
          ],
        },
      }),
      { pr: null },
    );
    const row = (name: string) => screen.getByText(name, { selector: ".cmp-file-name" }).closest("li")!;
    const post = row("post.html");
    // Each picture opens from its own tile, and its link carries when it was
    // made: a rework replaces the picture under the same name.
    const desktop = within(post).getByRole("link", { name: "Open the desktop picture of post.html" });
    expect(desktop.getAttribute("href")).toBe(
      "/t/attachments/post.html.capture-desktop.png?v=2026-10-07T12%3A00%3A09.412Z",
    );
    expect(desktop.querySelector("img")?.getAttribute("src")).toBe(desktop.getAttribute("href"));
    expect(within(post).getByRole("link", { name: "Open the phone picture of post.html" })).toBeTruthy();
    expect([...post.querySelectorAll(".cmp-caption")].map((el) => el.textContent)).toEqual([
      "Desktop, 1280 px wide",
      "Phone, 390 px wide, the top of a longer page",
    ]);
    // The source still opens from the row.
    expect(post.querySelector("a.cmp-file")?.getAttribute("href")).toBe("/t/attachments/post.html");
    // A page with no picture says why; a file that is not a page says nothing.
    const notes = row("notes.md");
    expect(within(notes).getByText("No picture of this page: the render ran past 25 seconds")).toBeTruthy();
    expect(notes.querySelector(".cmp-shots")).toBeNull();
    expect(row("figures.csv").querySelector(".cmp-shots, .cmp-none")).toBeNull();
  });

  it("offers the same notes and files before the acceptance, under the offer's own title", () => {
    // CANARY: gate the notes or the files on `result` and the person who
    // accepts reads less than the result they are accepting.
    const { container } = renderPacket(
      view({
        subjectSha: null,
        change: null,
        packet: {
          ...view().packet!,
          considerations: "Reserved pricing was not applied.",
          files: [{ name: "summary.md", caption: "The estimate in prose", page: null }],
        },
      }),
    );
    expect(screen.getByRole("heading", { level: 3, name: "Completion" })).toBeTruthy();
    expect(labels(container).slice(0, 3)).toEqual(["Files", "Considerations", "Reviewers"]);
    expect(screen.getByText("No reviewer is engaged on this task, and none has given a verdict.")).toBeTruthy();
  });
});
