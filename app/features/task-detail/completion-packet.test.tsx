// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import type { TookCard } from "~/server/tasks/what-it-took.server";
import { ToastProvider } from "~/ui/toast";
import { CompletionPacket, type CompletionResult } from "./completion-packet";

afterEach(cleanup);

/**
 * Ruling 521: the completion packet as the person who accepts reads it. What
 * the loader ships is the route suite's and which verdict counts is the
 * server suite's; this suite owns what the card says about each reviewer, the
 * screenshots, and when the diff is read. Ruling 668: and what the card shows
 * as the result of an accepted task. Ruling 693: and how it prints what the
 * task took (the phrases themselves are the server suite's).
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

/** `result` set: the card of an accepted task, which has no diff to read.
 *  `took`: what the loader sent of what the task took, when it sent any. */
function renderPacket(
  v: CompletionView,
  result: CompletionResult | null = null,
  took: TookCard | null = null,
) {
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
            took={took}
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
            { name: "My-Estimate.json", caption: "The calculator import" },
            { name: "summary.md", caption: "" },
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
          files: [{ name: "summary.md", caption: "The estimate in prose" }],
        },
      }),
    );
    expect(screen.getByRole("heading", { level: 3, name: "Completion" })).toBeTruthy();
    expect(labels(container).slice(0, 3)).toEqual(["Files", "Considerations", "Reviewers"]);
    expect(screen.getByText("No reviewer is engaged on this task, and none has given a verdict.")).toBeTruthy();
  });
});

describe("ruling 693: the card says what the task took", () => {
  const TOOK: TookCard = {
    facts: ["4 runs, 35m of agent time", "$2.50, 2 runs reported no cost", "sent back 1 time by reviewers"],
    notes: [
      "1 run was cut by a restart; its time is not counted.",
      "Codex reports no cost, so 1 Codex run is not in the dollar figure.",
    ],
  };
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll(".cmp-k")].map((el) => el.textContent);

  it("ruling 693: the card prints what the task took under its own label, and what the figure misses beneath it", () => {
    // CANARY: (a) draw the label whenever `took` is set, though it holds no
    // fact and no note, and a card gains a heading over nothing; (b) drop the
    // notes' paragraphs and a figure with a run cut by a restart reads as
    // complete; (c) gate the block on `result` and the person accepting reads
    // less than the Result card will show.
    const offer = renderPacket(view(), null, TOOK);
    expect(labels(offer.container)).toEqual(["Reviewers", "What it took", "Changes"]);
    const line = screen.getByRole("heading", { level: 4, name: "What it took" }).nextElementSibling!;
    expect([...line.querySelectorAll(":scope > span:not(.cmp-sep)")].map((el) => el.textContent)).toEqual(
      TOOK.facts,
    );
    // A separator between two facts, and none a screen reader announces.
    const separators = [...line.querySelectorAll(".cmp-sep")];
    expect(separators).toHaveLength(2);
    expect(separators.every((el) => el.getAttribute("aria-hidden") === "true")).toBe(true);
    // Each sentence about what the figure misses is a line of its own, under
    // the facts.
    const first = line.nextElementSibling;
    expect([first, first?.nextElementSibling].map((el) => el?.matches("p.cmp-none") && el.textContent)).toEqual(
      TOOK.notes,
    );
    cleanup();

    // The accepted task's Result card keeps it.
    const result = renderPacket(view({ change: null }), { pr: null }, TOOK);
    expect(labels(result.container)).toEqual(["What it took"]);
    expect(screen.getByText("Codex reports no cost, so 1 Codex run is not in the dollar figure.")).toBeTruthy();
    cleanup();

    // No figure from the loader, or one with nothing to say: no heading.
    expect(labels(renderPacket(view()).container)).toEqual(["Reviewers", "Changes"]);
    cleanup();
    expect(labels(renderPacket(view(), null, { facts: [], notes: [] }).container)).toEqual([
      "Reviewers",
      "Changes",
    ]);
  });
});
