// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { createRoutesStub } from "react-router";
import type {
  DeployedSpecialistView,
  LiveAgentRun,
} from "./execution-profile";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type {
  PacketOption,
  PacketOptionKind,
  PrRef,
  PrState,
  TaskSchedule,
} from "~/schemas/task-file.schema";
import type { PacketRender } from "~/shared/mapping/task.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import type { TaskChangesView } from "~/server/github/task-changes.server";
import { ToastProvider } from "~/ui/toast";
import { AcceptConfirm } from "./accept-confirm";
import { DecisionPacket } from "./decision-packet";
import type { RecommendationView } from "./operator-recommendations";
import { TaskDetailPage } from "./task-detail-page";
import type { RunView } from "~/features/runtime/runtime-types";
import { NO_RUN_CACHE } from "../../../test-support/run-view";
import { taskDetail } from "../../../test-support/task-detail";

/** Ruling 127: the task owner whose accounts a run bills, both backends
 *  connected — the ordinary case, so the run controls render live and these
 *  tests keep testing what they are about. The refusal states are covered in
 *  execution-profile.test.tsx. */
const CONNECTED_PRINCIPAL = {
  ownerUserId: "u-arda",
  ownerName: "Arda Kaya",
  claude: { available: true, detail: null },
  codex: { available: true, detail: null },
};

afterEach(cleanup);

/**
 * The two dispositions a human decides on the task page:
 *
 * - **P14-LV-06** — the review queue listed VM-4 under "Waiting on your
 *   acceptance (1 of 1)" while the page offered no acceptance affordance at all,
 *   because acceptance only ever rendered as an operator RECOMMENDATION and the
 *   divergence had withdrawn it. The only path left was the raw stage menu,
 *   which is a different governance act.
 * - **R14-3** — the task archive the closed-PR guidance has been naming since
 *   pass 13 ("Rework and reopen the PR, or archive the task") while no archive
 *   existed anywhere.
 */

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return taskDetail({
    waiting: "human",
    owner: { kind: "human", userId: "u-selin", name: "Selin Aksoy", initials: "SA", tone: "" },
    ...patch,
  });
}

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: true,
  atBoundary: true,
  blockedReason: null,
  blockedGates: [],
  blockedReasonViaPacket: null,
  canAccept: true,
  terminallyBlocked: false,
};

function renderPage(props: {
  acceptance?: Partial<AcceptanceAffordance>;
  archived?: boolean;
  myRole?: string;
  meId?: string;
  task?: Partial<TaskDetail>;
  canDeliver?: boolean;
  recommendations?: RecommendationView[];
  workRevisionSha?: string | null;
  schedules?: TaskSchedule[];
  runtime?: RunView[];
  deployedSpecialists?: DeployedSpecialistView[];
  liveAgentRuns?: LiveAgentRun[];
  /** Ruling 368: hold every action until the test answers it, so the
   *  in-flight state can be read. */
  held?: { reply: Promise<unknown> };
  /** U39-32 / ruling 449: base commits the branch lacked at the last compare. */
  baseBehindBy?: number | null;
  /** Ruling 484: the Changes panel's read. */
  changesUrl?: string | null;
  /** Ruling 484: what the reader reads at `changesUrl`. */
  changes?: TaskChangesView;
  /** Ruling 497: where the page opens (a notification's `#decision`). */
  entry?: string;
  /** Ruling 521: the completion packet as the loader read it. */
  completion?: CompletionView | null;
  /** Ruling 550: the task is delivered as the files saved on it. */
  filesDeliveredAt?: string | null;
}) {
  const submitted: Record<string, string>[] = [];
  // A revalidation that hands the mounted page a new read of the task.
  let revalidateWith: (task: Partial<TaskDetail>) => void = () => {};
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: function Page() {
        const [task, setTask] = useState(props.task ?? {});
        revalidateWith = setTask;
        return (
          <ToastProvider>
            <TaskDetailPage
              task={detail(task)}
              runtime={props.runtime ?? []}
              deployedSpecialists={props.deployedSpecialists ?? []}
              operatorBackend="claude"
              operatorAutonomy="supervised"
              runPrincipal={CONNECTED_PRINCIPAL}
              liveAgentRuns={props.liveAgentRuns ?? []}
              timelineHasMore={false}
              timelineRemaining={0}
              timelineNextLimit={50}
              tlDefault="all"
              members={[
                { userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
                { userId: "u-selin", role: "contributor", user: { name: "Selin Aksoy", initials: "SA", tone: "" } },
              ]}
              me={{ id: props.meId ?? "u-arda", name: "Arda Kaya" }}
              myRole={props.myRole ?? "admin"}
              mentionables={{ agents: [], users: [], reserved: [] }}
              recommendations={props.recommendations ?? []}
              schedules={props.schedules ?? []}
              archived={props.archived ?? false}
              acceptance={{ ...ACCEPTANCE, ...props.acceptance }}
              githubHost="https://github.com"
              workRevisionSha={props.workRevisionSha ?? null}
              canDeliver={props.canDeliver ?? false}
              baseBehindBy={props.baseBehindBy ?? null}
              changesUrl={props.changesUrl ?? null}
              completion={props.completion ?? null}
              filesDeliveredAt={props.filesDeliveredAt ?? null}
            />
          </ToastProvider>
        );
      },
      action: async ({ request }) => {
        const fd = await request.formData();
        const row: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
        submitted.push(row);
        if (props.held) await props.held.reply;
        return { ok: true, intent: row.intent, toast: "done" };
      },
    },
    ...(props.changesUrl && props.changes
      ? [{ path: props.changesUrl, loader: () => props.changes }]
      : []),
  ]);
  const utils = render(<Stub initialEntries={[props.entry ?? "/"]} />);
  const revalidate = (task: Partial<TaskDetail>) => act(() => revalidateWith(task));
  return { ...utils, submitted, revalidate };
}

/**
 * Ruling 484 (pass 40, F40-54): the Changes panel stands on the page while
 * the review PR is open and carries a delivered revision, and nowhere else: a
 * merged PR's review is over, and without a delivery there is nothing to read.
 */
describe("ruling 484: the task page offers the Changes panel for an open review PR", () => {
  const openPr: PrRef = { number: 3, state: "review", title: "Notes" };
  const heading = (container: HTMLElement) =>
    [...container.querySelectorAll(".panel-head h2")].some((h) => h.textContent === "Changes");

  it("renders for an open review PR carrying the delivered revision", () => {
    const { container } = renderPage({
      task: { pr: openPr },
      workRevisionSha: "5d1f0e2c0ffee",
      changesUrl: "/projects/viberr-core/tasks/VIB-151/changes",
    });
    expect(heading(container)).toBe(true);
  });

  it("stays away from a merged PR, a task with nothing delivered, and a render with no read", () => {
    for (const props of [
      { task: { pr: { ...openPr, state: "merged" as const } }, workRevisionSha: "5d1f0e2", changesUrl: "/c" },
      { task: { pr: openPr }, workRevisionSha: null, changesUrl: "/c" },
      { task: { pr: openPr }, workRevisionSha: "5d1f0e2", changesUrl: null },
    ]) {
      const { container, unmount } = renderPage(props);
      expect(heading(container)).toBe(false);
      unmount();
    }
  });
});

/**
 * Ruling 521: the completion packet stands where the task is offered for
 * acceptance, inside the decision that offers it or on its own card beside an
 * acceptance recommendation, and carries the page's one diff reader while it
 * shows.
 */
describe("ruling 521: the completion packet stands with the offer to accept", () => {
  const openPr: PrRef = { number: 3, state: "review", title: "Notes" };
  const COMPLETION: CompletionView = {
    subjectSha: "5d1f0e2",
    packet: {
      summary: "Long timelines fold their quiet stretches.",
      changes: "- **Timeline**: folds runs of quiet events.",
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
    verdicts: [
      { profileId: "reviewer", name: "Reviewer", result: "approve", reason: "", at: "2026-09-27T09:30:00.000Z", required: true, earlier: null },
    ],
    change: { files: 4, add: 260, del: 40, small: false },
    paths: null,
  };
  const decision: PacketRender = {
    type: "input",
    kind: "Completion report",
    from: "Operator",
    title: "VIB-151 ready to accept",
    body: "",
    observations: [],
    options: [
      { kind: "accept_completion", t: "Accept VIB-151", d: "", rec: true },
      { kind: "request_edit", t: "Ask for one more fix", d: "", rec: false },
    ],
  };
  const changesPanel = (container: HTMLElement) =>
    [...container.querySelectorAll(".panel-head h2")].some((h) => h.textContent === "Changes");

  it("sits inside the decision that offers acceptance, and the Changes panel gives way to its diff", () => {
    // CANARY: render the packet beside the decision rather than in it, or
    // drop `!completionDiff` from the Changes panel's condition, and the
    // page draws the change twice with two sets of unsent notes.
    const { container } = renderPage({
      task: { pr: openPr, packet: decision },
      workRevisionSha: "5d1f0e2c0ffee",
      changesUrl: "/projects/viberr-core/tasks/VIB-151/changes",
      completion: COMPLETION,
    });
    const card = container.querySelector<HTMLElement>(".detail-packet .packet")!;
    expect(card.querySelector(".cmp")).not.toBeNull();
    expect(card.querySelector(".cmp-verdict")?.textContent).toContain("ReviewerApproved");
    expect(findButton(card, "Show the diff")).toBeDefined();
    expect(changesPanel(container)).toBe(false);
  });

  it("F10-09: keeps its reader, the notes in it and the person's focus when the decision is replaced", async () => {
    // CANARY: key the page's DecisionPacket on its packet id again, or
    // re-seed the card by remounting it, and the replacement remounts the
    // reader closed with the unsent note gone, and focus falls to <body>.
    const { container, revalidate } = renderPage({
      task: { pr: openPr, packet: { ...decision, id: "pkt-a" } },
      workRevisionSha: "5d1f0e2c0ffee",
      changesUrl: "/projects/viberr-core/tasks/VIB-151/changes",
      changes: {
        ok: true,
        prNumber: 3,
        repo: "akin-ozer/viberr",
        headSha: "5d1f0e2c0ffee",
        files: [
          {
            path: "app/timeline.tsx",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1 +1,2 @@\n keep\n+fold",
            patchOmitted: null,
          },
        ],
        moreFiles: false,
        truncated: false,
        recipient: { name: "Developer", handle: "developer" },
      },
      completion: COMPLETION,
    });
    const card = within(container.querySelector<HTMLElement>(".detail-packet .packet")!);
    fireEvent.click(card.getByRole("button", { name: "Show the diff" }));
    // The reader's chunk loads, then its read goes through the router and
    // redraws the whole page, which can outrun the 1 s default wait on a
    // loaded runner.
    const line = { name: "Add a note on app/timeline.tsx line 2" };
    fireEvent.click(await card.findByRole("button", line, { timeout: 5_000 }));
    fireEvent.change(card.getByRole("textbox", { name: "Note on app/timeline.tsx line 2" }), {
      target: { value: "Name the quiet stretch." },
    });
    fireEvent.click(card.getByRole("button", { name: "Add note" }));
    const box = container.querySelector<HTMLTextAreaElement>("#pkt-note")!;
    box.focus();

    revalidate({ pr: openPr, packet: { ...decision, id: "pkt-b", title: "VIB-151 ready to accept again" } });
    expect(container.textContent).toContain("VIB-151 ready to accept again");
    expect(findButton(container, "Hide the diff")).toBeDefined();
    expect(container.querySelector(".chg-note")?.textContent).toContain("Name the quiet stretch.");
    expect(document.activeElement).toBe(box);
  });

  it("stands on its own card beside an acceptance recommendation or at the boundary once written, and nowhere else", () => {
    // CANARY: drop the recommendation arm of `completionShown` and the
    // supervised operator's offer reaches a person without its packet.
    const rec: RecommendationView = {
      id: "rec-1",
      kind: "accept_completion",
      label: "Accept the completion and close VIB-151",
      detail: "The reviewer approved the delivered revision.",
    };
    const unwritten: CompletionView = { ...COMPLETION, packet: null };
    const rows: [Parameters<typeof renderPage>[0], boolean][] = [
      [{ recommendations: [rec], acceptance: { atBoundary: false }, completion: COMPLETION }, true],
      [{ acceptance: { atBoundary: true }, completion: COMPLETION }, true],
      [{ acceptance: { atBoundary: true }, completion: unwritten }, false],
      [{ acceptance: { atBoundary: false }, completion: COMPLETION }, false],
    ];
    for (const [props, shown] of rows) {
      const { container, unmount } = renderPage(props);
      expect(container.querySelector(".detail-packet > .cmp-card > .cmp") !== null, JSON.stringify(props)).toBe(shown);
      unmount();
    }
  });

  it("ruling 668: stays on the accepted task as its result, in the archive too, with its pull request and no diff reader", () => {
    // CANARY: restore `!taskClosed` over the whole condition and the summary a
    // person accepted on is gone from the task the moment they accept it; key
    // the result on `taskClosed` and a task archived unfinished shows one.
    const merged: PrRef = { number: 3, state: "merged", title: "Notes" };
    const done = { stage: "done", displayReadiness: "merged" as const, pr: merged };
    const rows: [Parameters<typeof renderPage>[0], boolean][] = [
      [{ task: done, acceptance: { atBoundary: false }, completion: COMPLETION }, true],
      [{ task: done, archived: true, acceptance: { atBoundary: false }, completion: COMPLETION }, true],
      [{ task: done, acceptance: { atBoundary: false }, completion: { ...COMPLETION, packet: null } }, false],
      [{ archived: true, acceptance: { atBoundary: false }, completion: COMPLETION }, false],
      // Ruling 667: the project gave its repository up since. The pull
      // request's record stays on the result, with nowhere to link.
      [{ task: { ...done, repo: null }, acceptance: { atBoundary: false }, completion: COMPLETION }, true],
    ];
    for (const [props, shown] of rows) {
      const { container, unmount } = renderPage({
        ...props,
        workRevisionSha: "5d1f0e2c0ffee",
        changesUrl: "/projects/viberr-core/tasks/VIB-151/changes",
      });
      const card = container.querySelector<HTMLElement>(".detail-packet > .cmp-card > .cmp");
      expect(card !== null, JSON.stringify(props)).toBe(shown);
      if (card) {
        expect(card.querySelector(".cmp-title")?.textContent).toBe("Result");
        expect(card.querySelector<HTMLAnchorElement>(".cmp-stat a")?.href, JSON.stringify(props)).toBe(
          props.task?.repo === null ? undefined : "https://github.com/akin-ozer/viberr/pull/3",
        );
        expect(card.querySelector(".cmp-stat")?.textContent).toBe("PR #3merged·4 files changed+260−40");
        expect(findButton(card, "Show the diff")).toBeUndefined();
      }
      unmount();
    }
  });
});

/**
 * Ruling 667: a project with no repository is a board that delivers results,
 * so nothing on its task page promises a branch or names a repository.
 */
describe("ruling 667: a task on a project with no repository", () => {
  const githubPanel = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>(".detail-side .panel")].find(
      (panel) => panel.querySelector(".panel-head h2")?.textContent === "GitHub",
    )!;
  const repoRow = (container: HTMLElement) =>
    [...container.querySelectorAll(".kv-row .k")].find((k) => k.textContent === "Repo");

  it("says it is delivered as files before anyone is engaged, and shows no Repo row", () => {
    // CANARY: derive `filesDelivery` from the deliverer alone and a fresh
    // task on a board with no repository is promised a task-key branch; draw
    // the Repo row whatever `task.repo` is and it shows the GitHub mark
    // beside nothing.
    const none = renderPage({ task: { repo: null, branch: null } });
    expect(githubPanel(none.container).textContent).toBe(
      "GitHubNo branch. This task is delivered as the files saved on it.",
    );
    expect(repoRow(none.container)).toBeUndefined();
    none.unmount();

    const withRepo = renderPage({ task: { branch: null } });
    expect(githubPanel(withRepo.container).textContent).toContain("No branch yet.");
    expect(repoRow(withRepo.container)).toBeDefined();
  });
});

/**
 * Ruling 529: a question the work does not wait on says so. CALC-1's owner
 * read a decision packet as the thing the task was stuck on while an agent
 * kept working beside it.
 */
describe("ruling 529: a question asked while an agent works reads as not blocking", () => {
  const question: PacketRender = {
    type: "input",
    kind: "Decision required",
    from: "Operator",
    title: "Which estimate shape should the research recommend?",
    body: "",
    observations: [],
    options: [
      { kind: "request_edit", t: "Adopt B", d: "Descriptions may name servers and applications.", rec: true },
      { kind: "request_edit", t: "Adopt A", d: "One estimate per service.", rec: false },
    ],
  };

  it("takes the quiet surface and says so only beside a working agent, and never on a block", () => {
    // CANARY: drop either half of the page's `aside` condition and a block, or
    // a question the task does wait on, tells its owner the work goes on.
    const rows: [Partial<TaskDetail>, boolean][] = [
      [{ packet: question, waiting: "agent" }, true],
      [{ packet: question, waiting: "human" }, false],
      [{ packet: { ...question, type: "blocked", kind: "Blocked decision" }, waiting: "agent" }, false],
    ];
    for (const [task, aside] of rows) {
      const { container, unmount } = renderPage({ task });
      const card = container.querySelector<HTMLElement>(".detail-packet .packet")!;
      expect(card.hasAttribute("data-aside"), JSON.stringify(task)).toBe(aside);
      expect(card.querySelector(".packet-aside")?.textContent ?? null).toBe(
        aside ? "Not blocking: an agent keeps working while you decide." : null,
      );
      unmount();
    }
  });
});

/**
 * F10-09: the operator can replace an open packet, and the revalidation that
 * follows hands the mounted page the new packet in place of the old one.
 */
describe("F10-09: a replacement packet opens as a fresh card", () => {
  const first: PacketRender = {
    id: "pkt-first",
    type: "input",
    kind: "Decision required",
    from: "Operator",
    title: "Which estimate shape should the research recommend?",
    body: "",
    observations: [],
    options: [
      { kind: "request_edit", t: "Adopt B", d: "", rec: true },
      { kind: "request_edit", t: "Adopt A", d: "", rec: false },
    ],
  };
  const replacement: PacketRender = {
    ...first,
    id: "pkt-replacement",
    title: "Which backend should the follow-up run on?",
    options: [
      { kind: "request_edit", t: "Keep Claude", d: "", rec: true },
      { kind: "request_edit", t: "Switch to Codex", d: "", rec: false },
    ],
  };
  const checked = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.detail-packet [role="radio"]'))
      .filter((o) => o.getAttribute("aria-checked") === "true")
      .map((o) => o.textContent);

  it("keeps nothing the person chose or typed on the packet it replaced", () => {
    // CANARY: drop the card's re-seed on a new packet id (`seededFrom` in
    // decision-packet.tsx) and the replacement opens with the old card's
    // second choice selected (here "Switch to Codex", which nobody picked)
    // and its note typed.
    const { container, revalidate } = renderPage({ task: { packet: first } });
    fireEvent.click(findButton(container, "Adopt A")!);
    const note = container.querySelector<HTMLTextAreaElement>("#pkt-note")!;
    fireEvent.change(note, { target: { value: "One estimate per service." } });
    expect(checked(container)).toEqual([expect.stringContaining("Adopt A")]);

    revalidate({ packet: replacement });
    expect(container.textContent).toContain(replacement.title);
    expect(checked(container)).toEqual([expect.stringContaining("Keep Claude")]);
    expect(container.querySelector<HTMLTextAreaElement>("#pkt-note")!.value).toBe("");
  });
});

/** An action the test answers when it decides to (ruling 368). */
function heldAction() {
  let answer: () => void = () => {};
  const reply = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return { reply, answer: () => answer() };
}

const findButton = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );

describe("P14-LV-06: the acceptance affordance", () => {
  it("renders an Accept control naming the terminal stage; it CONFIRMS first, then submits accept-completion (F15-10)", async () => {
    const { container, submitted, getByText } = renderPage({});
    const btn = findButton(container, "Accept completion → Done");
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(false);
    fireEvent.click(btn!);
    // R15-1/F15-10: accepting merges — nothing submits until the confirm,
    // which states what merges (this task has no PR, so no merge line).
    expect(getByText("Accept this completion?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    fireEvent.click(findButton(container, "Accept → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("accept-completion");
  });

  it("the confirm names the PR, revision, verdict state and target branch (R15-1)", () => {
    const { container, getByText } = renderPage({
      task: {
        pr: { number: 117, state: "review", title: "[VIB-151] x" },
      },
      workRevisionSha: "abcdef1234567890",
    });
    fireEvent.click(findButton(container, "Accept completion → Done")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    );
    // F19-14: the canonical PR vocabulary, not the raw `pr.state` enum member —
    // this said "PR #117 · review" while the panel behind it said "in review".
    expect(dialog?.textContent).toContain("PR #117 · in review");
    expect(dialog?.textContent).toContain("main");
    expect(dialog?.textContent).toContain("abcdef123456");
    expect(getByText("Accept this completion?")).toBeTruthy();
    // The confirm button is explicit that accepting merges.
    expect(findButton(container, "Accept → Done & merge")).toBeDefined();
  });

  it("ruling 449: the Accept dialog's re-review first submits refresh-and-review, and accepts nothing", async () => {
    const { container, submitted } = renderPage({
      task: { pr: { number: 117, state: "review", title: "[VIB-151] x" } },
      workRevisionSha: "abcdef1234567890",
      baseBehindBy: 2,
    });
    fireEvent.click(findButton(container, "Accept completion → Done")!);
    // CANARY: stop passing `onRefreshFirst` from the page and the dialog has
    // no safe path to offer.
    fireEvent.click(findButton(container, "Update the branch and re-review first")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("refresh-and-review");
    expect(submitted.some((row) => row.intent === "accept-completion")).toBe(false);
  });

  it("the confirm does not promise a merge on a task with no pull request", () => {
    // Live (VAL-2): the dialog correctly said "No linked pull request — the
    // task closes without a merge" and offered "Accept → Done", while its
    // footer still read "Merging is one-way … the merge are recorded".
    const { container } = renderPage({});
    fireEvent.click(findButton(container, "Accept completion → Done")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    );
    expect(dialog?.textContent).toContain("Nothing is merged");
    expect(dialog?.textContent).not.toContain("Merging is one-way");
  });

  /**
   * Ruling 471: the page hands the dialog the loader's answer for the door
   * that was pressed: `acceptAnswersWith` for Accept, `forceAnswersWith` for
   * Force accept. Live on WEB-1 the Accept dialog said the recommended
   * "Accept WEB-1 and merge PR #1" decision "closes unanswered".
   */
  describe("ruling 471: the open-decision row follows the loader's answer for the pressed door", () => {
    const decision = (answers: Partial<Pick<PacketRender, "acceptAnswersWith" | "forceAnswersWith">>): PacketRender => ({
      type: "input",
      kind: "Completion report",
      from: "Operator",
      title: "VIB-151 ready to accept",
      body: "",
      observations: [],
      options: [
        { kind: "accept_completion", t: "Accept VIB-151", d: "", rec: true },
        { kind: "force_accept", t: "Force-accept VIB-151", d: "", rec: false },
      ],
      ...answers,
    });
    const dialogText = (container: HTMLElement) =>
      container.ownerDocument.querySelector('dialog[data-screen-label="Accept completion dialog"]')
        ?.textContent ?? "";

    it("Accept reads Answers with the plain door's option", () => {
      // CANARY: stop passing `answersWith` from the page and this reads
      // "Withdraws … closes unanswered".
      const { container } = renderPage({
        task: { packet: decision({ acceptAnswersWith: "Accept VIB-151", forceAnswersWith: "Force-accept VIB-151" }) },
      });
      fireEvent.click(findButton(container, "Accept completion → Done")!);
      const text = dialogText(container);
      expect(text).toContain('the open decision "VIB-151 ready to accept" with "Accept VIB-151"');
      expect(text).not.toContain("Withdraws");
    });

    it("Force accept reads Answers with the forced door's option, not the plain one", () => {
      // CANARY: read `acceptAnswersWith` on the force door and this names the
      // plain option.
      const { container } = renderPage({
        myRole: "admin",
        task: {
          blockReason: "A required reviewer can no longer record a verdict",
          packet: decision({ acceptAnswersWith: "Accept VIB-151", forceAnswersWith: "Force-accept VIB-151" }),
        },
        acceptance: {
          canAccept: false,
          blockedReason: "VIB-151's delivered revision has no approving verdict yet",
        },
      });
      fireEvent.click(findButton(container, "Force accept")!);
      const text = dialogText(container);
      expect(text).toContain('with "Force-accept VIB-151"');
      expect(text).not.toContain("Withdraws");
    });

    it("a door the loader gives no answer for keeps the Withdraws row", () => {
      const { container } = renderPage({
        task: { packet: decision({ forceAnswersWith: "Force-accept VIB-151" }) },
      });
      fireEvent.click(findButton(container, "Accept completion → Done")!);
      const text = dialogText(container);
      expect(text).toContain("Withdraws");
      expect(text).not.toContain("Answers");
    });
  });

  it("a contributor who OWNS the task gets it — R6-2/R14-2, not just maintainers", () => {
    // The live case: the queue counted this viewer, the page offered nothing.
    const { container } = renderPage({
      myRole: "contributor",
      meId: "u-selin",
    });
    expect(findButton(container, "Accept completion → Done")).toBeDefined();
  });

  it("blocked acceptance renders disabled WITH the server's reason in text", () => {
    const { container, getAllByText } = renderPage({
      acceptance: {
        canAccept: false,
        blockedReason:
          "PR #103 was closed on GitHub without merging — VIB-151 cannot be accepted.",
        // A closed PR is R16-3's TERMINAL block, and the server always sets both
        // together (`acceptanceTerminallyBlocked`). The fixture used to name the
        // closed-PR reason while leaving this false — a state no server response
        // can produce — which since UX19-2 would render the DG-2 override on a
        // rejected PR, the one place ruling R16-3 forbids it.
        terminallyBlocked: true,
      },
    });
    const btn = findButton(container, "Accept completion → Done")!;
    expect(btn.disabled).toBe(true);
    // P14-LV-08: the reason is TEXT — `title` never opens on a disabled control.
    // UX19-2: an admin sees it twice now (Current state + the GitHub panel's
    // escape hatch) — but it is the SAME sentence from the same source, which is
    // the whole point; the two panels used to name different gates.
    expect(getAllByText(/closed on GitHub without merging/).length).toBeGreaterThan(0);
  });

  it("no authority, or not at the boundary → no control at all (never inert)", () => {
    const noAuth = renderPage({ acceptance: { hasAuthority: false } });
    expect(findButton(noAuth.container, "Accept completion")).toBeUndefined();
    cleanup();
    const earlyStage = renderPage({
      acceptance: { atBoundary: false, canAccept: false },
    });
    expect(findButton(earlyStage.container, "Accept completion")).toBeUndefined();
  });

  it("F15-19: the refusal TEXT still renders off-boundary — a refusal is never silent", () => {
    // Fails on main: the whole acceptance block (button AND reason) was gated
    // on atBoundary, so an off-boundary refusal rendered nothing at all.
    const { container, getAllByText } = renderPage({
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet",
      },
    });
    expect(findButton(container, "Accept completion")).toBeUndefined();
    expect(getAllByText(/no approving verdict yet/).length).toBeGreaterThan(0);
  });

  it("C1: the refusal has ONE owner (Current state); the GitHub panel's override carries no duplicate", () => {
    // UX19-2 first made the two panels AGREE (both quoting the live refusal);
    // C1 found the fix had made them DUPLICATES — byte-identical sentences ~350px
    // apart. One owner now: the Current-state deny-note holds the sentence, and
    // the GitHub panel's admin override renders only its button, no reason line.
    // Canary: bring back the force-accept row's `.hint` "Acceptance is
    // blocked: …" paragraph and the duplicate returns here.
    const stageRefusal =
      "VIB-151 is at In Progress, not Review — a completion can only be accepted from the boundary the workflow puts before Done.";
    const { container } = renderPage({
      myRole: "admin",
      task: {
        blockReason: "VIB-151's delivered revision has no approving verdict yet.",
      },
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason: stageRefusal,
      },
    });
    // The force-accept row is now just the override button — no reason
    // paragraph. Ruling 511: it stands with the card's other actions.
    const forceAccept = container.querySelector(".pr-acts")!;
    expect(forceAccept.textContent).toContain("Force accept");
    expect(forceAccept.querySelector(".hint")).toBeNull();
    expect(forceAccept.textContent).not.toContain(stageRefusal);
    // The sentence lives once, in the Current-state deny-note.
    const denyNote = container.querySelector(".deny-note")!;
    expect(denyNote.textContent).toContain(stageRefusal);
    // And it is the live gate, never the projection's revision-only blockReason.
    expect(denyNote.textContent).not.toContain("no approving verdict yet");
  });

  it("R16-3: a closed PR frames the refusal as CLOSED and withdraws force-accept", () => {
    // Live (H10): the task carried a correct "PR #124 closed without merging —
    // choose recovery path" packet, while this box read "no approving verdict
    // yet — run a review for a verdict, or an admin can force-accept" AND an
    // admin's force button sat right under it. Running a review is not the path
    // when the PR is gone, and forcing past it would move the task to Done over
    // a rejection and stamp `accepted` on a PR GitHub has closed.
    // Canary: drop `!acceptanceTerminallyBlocked` from canForceAccept and the
    // Force accept button comes back.
    const { container, getByText } = renderPage({
      myRole: "admin",
      task: {
        blockReason: "PR #124 closed without merging",
        pr: { number: 124, state: "closed", title: "[VIB-151] x" },
        packet: {
          type: "input",
          kind: "Decision required",
          from: "Operator",
          title: "PR #124 closed without merging — choose recovery path",
          body: "Rework and reopen, or archive the task.",
          observations: [],
          options: [
            { kind: "custom", t: "Rework and reopen the PR", d: "", rec: true },
            { kind: "archive_task", t: "Archive the task", d: "", rec: false },
          ],
        },
      },
      acceptance: {
        canAccept: false,
        terminallyBlocked: true,
        blockedReason:
          "VIB-151's review PR was closed on GitHub without merging — it can't be accepted. Rework and reopen the PR, or archive the task.",
      },
    });
    expect(getByText(/closed on GitHub without merging/)).toBeTruthy();
    // The frame says decided, not "not yet".
    expect(getByText("Acceptance is closed.")).toBeTruthy();
    // …and points at the recovery decision rendered on the same screen.
    expect(getByText(/carries the recovery paths/)).toBeTruthy();
    // No override against a terminal GitHub fact, admin or not.
    expect(findButton(container, "Force accept")).toBeUndefined();
  });

  it("R16-3: force-accept still stands for a WEDGED process gate (the DG-2 case it exists for)", () => {
    const { container } = renderPage({
      myRole: "admin",
      task: { blockReason: "A required reviewer can no longer record a verdict" },
      acceptance: {
        canAccept: false,
        terminallyBlocked: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet",
      },
    });
    expect(findButton(container, "Force accept")).toBeDefined();
  });

  it("F19-42: the force-accept button is container-sized (`.btn.full`), so its honest label can wrap", () => {
    // Live defect: R19-5's off-boundary label ("Force accept (skips the
    // remaining stages and the review gate)") measured scrollWidth 351 against
    // clientWidth 299 and painted 52px outside the GitHub card, because the
    // base `.btn` rule is `white-space: nowrap`.
    //
    // `app.css.test.ts` pins the RULE (`.btn.full { white-space: normal }`).
    // Nothing pinned the CONSUMER, so dropping `full` from this className
    // re-opened the exact live defect with every test green (audit §2.4).
    // jsdom computes no layout, so the class IS the assertion — it is the one
    // thing that decides whether that rule ever reaches this button.
    //
    // Canary: remove `full` from `task-side-panels.tsx`'s force-accept
    // className and this goes red while the stylesheet test stays green.
    const { container } = renderPage({
      myRole: "admin",
      task: { blockReason: "A required reviewer can no longer record a verdict" },
      acceptance: {
        // Off-boundary — the arm that renders the LONG label that overflowed.
        atBoundary: false,
        canAccept: false,
        terminallyBlocked: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet",
      },
    });
    const force = findButton(container, "Force accept")!;
    expect(force).toBeDefined();
    // The label whose width caused the defect — a shorter one would not need
    // the override, so the two assertions belong together.
    expect(force.textContent).toContain(
      "skips the remaining stages and the review gate",
    );
    expect(
      Array.from(force.classList),
      "the wrapping override only applies to `.btn.full`; a content-sized force button overflows its panel",
    ).toContain("full");
    // Ruling 149: force-accept is destructive, and the confirm it opens
    // already commits in red — the trigger says so too.
    expect(Array.from(force.classList)).toContain("danger");
  });

  it("F15-11: an ARCHIVED task renders no Accept control and closed/disabled run controls", () => {
    const { container, queryByText } = renderPage({
      archived: true,
      task: { archived: true },
      acceptance: { atBoundary: true, canAccept: true },
    });
    // Fails on main: the Accept button and the run controls stayed live.
    expect(findButton(container, "Accept completion")).toBeUndefined();
    // Ruling 625: the operator's run control is withdrawn, not disabled.
    expect(findButton(container, "Run operator")).toBeUndefined();
    expect(queryByText("Task closed. Reopen it to run the operator.")).toBeTruthy();
    // The run-agent control withdraws itself with the closed copy rather than
    // offering to start runs on a task that is out of the flow.
    expect(queryByText("Task closed. Reopen it to run an agent.")).toBeTruthy();
  });
});

/**
 * Pass 19 — the acceptance-writer matrix. Five code paths end in "task Done +
 * a real GitHub merge"; ruling 20 (R15-1) says every one of them confirms first,
 * and ruling 42 (R17-1) says the confirm discloses the ACTUAL merge head when it
 * has drifted ahead of the reviewed revision. Three of the five never asked.
 */
describe("ruling 20 — every acceptance writer passes the confirm (pass 19)", () => {
  const acceptedPr = (patch: Partial<PrRef> = {}): PrRef => ({
    number: 147,
    state: "accepted",
    title: "[VIB-151] Compress timelines",
    ...patch,
  });

  it("F19-24: 'Complete merge' asks first, disclosing PR, target branch and the commits added since review", async () => {
    // The mandatory human half of EVERY full-autonomy operator acceptance
    // (R16-6) — and the one acceptance-family control that ran the real,
    // irreversible merge on a bare click, with the post-acceptance drift shown
    // nowhere. Canary: pass `onCompleteMerge` straight to GithubTrace again and
    // the click submits with `submitted` non-empty before any dialog exists.
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      workRevisionSha: "aaaaaaaaaaaabbbbbbbbbbbb",
      task: {
        pr: acceptedPr({
          revisionDrift: { headSha: "ccccccccccccdddddddddddd", authored: 2, baseRefresh: null },
        }),
      },
    });
    const btn = findButton(container, "Complete merge")!;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(submitted).toHaveLength(0);
    expect(getByText("Run the merge now?")).toBeTruthy();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).toContain("PR #147");
    expect(dialog.textContent).toContain("main");
    // R17-1: the head really being merged, and that it is not the reviewed one.
    expect(dialog.textContent).toContain("cccccccccccc");
    expect(dialog.textContent).toContain("2 authored commits since review merge unreviewed");
    fireEvent.click(findButton(container, "Merge PR #147")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("complete-merge");
  });

  it("F19-14: the ceremony renders the canonical PR-state label, never the raw internal token", () => {
    // "PR #147 accepted" is the projection's word; every other surface says
    // "merge pending" through the ONE prStatePill map (ruling 12).
    const { container } = renderPage({
      myRole: "admin",
      task: { pr: acceptedPr() },
    });
    fireEvent.click(findButton(container, "Complete merge")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).toContain("merge pending");
    expect(dialog.textContent).not.toContain("PR #147 · accepted");
  });

  it("F19-3: applying an accept_completion recommendation asks first, then still posts apply-recommendation", async () => {
    // Live-proven on VC-1: one Apply click merged an unreviewed head into main.
    // Canary: submit straight from onApplyRec and `submitted` fills on click 1.
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      task: { pr: acceptedPr({ state: "review" }) },
      recommendations: [
        {
          id: "rec-1",
          kind: "accept_completion",
          label: "Accept the completion and close VIB-151",
          detail: "The reviewer approved the delivered revision.",
        },
      ],
    });
    fireEvent.click(findButton(container, "Apply")!);
    expect(submitted).toHaveLength(0);
    expect(getByText("Apply this recommendation?")).toBeTruthy();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    // It names what the human clicked AND what that click merges.
    expect(dialog.textContent).toContain("Accept the completion and close VIB-151");
    expect(dialog.textContent).toContain("PR #147");
    expect(dialog.textContent).toContain("main");
    fireEvent.click(findButton(container, "Apply → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    // Still the apply path: it keeps the recommendation-applied audit row and
    // the owner-authority seam that `accept-completion` would skip.
    expect(submitted[0]!.intent).toBe("apply-recommendation");
    expect(submitted[0]!.recId).toBe("rec-1");
    // Ruling 88: and it carries this dialog's own echo of the three facts it
    // just stated. The server refuses the apply without it, so a submit that
    // dropped the fields would look identical here and fail live.
    expect(submitted[0]!.ackPr).toBe("review");
    expect(submitted[0]!.ackRevision).toBe("none"); // no delivered revision
    expect(submitted[0]!.ackVerdict).toBe("healthy");
  });

  it("F19-26: a plain TRANSITION recommendation whose target is the terminal stage confirms too — the gate is the target, not the kind", async () => {
    // "Move the task to Done" runs the full acceptance + real merge under a
    // label that never says accept or merge. Canary: gate on
    // `kind === "accept_completion"` alone and this one merges on one click.
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      task: { pr: acceptedPr({ state: "review" }) },
      recommendations: [
        {
          id: "rec-t",
          kind: "transition",
          toStageId: "done",
          label: "Move VIB-151 to Done",
          detail: "The work is ready to advance to Done.",
        },
      ],
    });
    fireEvent.click(findButton(container, "Apply")!);
    expect(submitted).toHaveLength(0);
    expect(getByText("Apply this recommendation?")).toBeTruthy();
    fireEvent.click(findButton(container, "Apply → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("apply-recommendation");
  });

  it("a recommendation that does NOT reach acceptance keeps its one-click Apply", async () => {
    const { container, submitted, queryByText } = renderPage({
      myRole: "admin",
      recommendations: [
        {
          id: "rec-mid",
          kind: "transition",
          toStageId: "review",
          label: "Move VIB-151 to Review",
          detail: "Delivery landed.",
        },
      ],
    });
    fireEvent.click(findButton(container, "Apply")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("apply-recommendation");
    expect(queryByText("Apply this recommendation?")).toBeNull();
  });

  const packetWith = (kind: PacketOptionKind): PacketRender => ({
    type: "input",
    kind: "Completion report",
    from: "Operator",
    title: "VIB-151 is ready for a decision",
    body: "The reviewer approved the delivered revision.",
    observations: [],
    options: [
      { kind, t: "Accept the completion and close it", d: "", rec: true },
      { kind: "request_edit", t: "Send it back for edits", d: "", rec: false },
    ],
  });

  it("F19-7: a packet's accept_completion option asks first — 'Confirm decision' is a selection, not a merge confirmation", async () => {
    // The button said "Confirm decision" and the card showed only the freeform
    // text the operator typed: no PR, no revision, no verdict, no merge target,
    // no "Not yet". Canary: resolve straight through and click 1 merges.
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      task: { pr: acceptedPr({ state: "review" }), packet: packetWith("accept_completion") },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    expect(submitted).toHaveLength(0);
    expect(getByText("Accept this completion?")).toBeTruthy();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).toContain("Accept the completion and close it");
    expect(dialog.textContent).toContain("PR #147");
    expect(dialog.textContent).toContain("main");
    fireEvent.click(findButton(container, "Accept → Done & merge")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(submitted[0]!.option).toBe("0");
    // Ruling 88: the resolution carries the ceremony's echo — the packet
    // identity the server pins says WHICH decision this is, not what the human
    // saw merging.
    expect(submitted[0]!.ackPr).toBe("review");
    expect(submitted[0]!.ackRevision).toBe("none");
    expect(submitted[0]!.ackVerdict).toBe("healthy");
  });

  /**
   * Ruling 164 (pass 35, F35-14): a `force_accept` option performs the admin
   * override, so it opens the same ceremony the Force accept button opens (the
   * force form: skipped stages, the bypassed refusal, the danger confirm) and
   * still travels as the packet resolution the server dispatches on.
   */
  it("ruling 164: a force_accept option opens the FORCE ceremony and resolves the packet with its echo", async () => {
    // Canary: route the option through the plain packet ceremony (or through no
    // ceremony at all) and the heading is "Accept this completion?", with an
    // echo-less POST the server refuses.
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      // Off the boundary and refused: the wedge a force-accept exists for.
      // The server computes BOTH: `blockedReason` folds in the open blocked
      // packet, `blockedReasonViaPacket` is the refusal a packet resolution
      // really meets (F19-7). A `force_accept` option is a packet resolution,
      // so the second one is the gate this ceremony bypasses.
      acceptance: {
        atBoundary: false,
        blockedReason: "The latest review requests changes.",
        blockedReasonViaPacket: "The latest review requests changes.",
      },
      task: {
        stage: "triage",
        validation: "failing",
        packet: {
          ...packetWith("force_accept"),
          options: [
            {
              kind: "force_accept",
              t: "Force-accept as admin without a fresh verdict",
              d: "",
              rec: true,
            },
            { kind: "request_edit", t: "Send it back for edits", d: "", rec: false },
          ],
        },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    expect(submitted).toHaveLength(0);
    expect(getByText("Force-accept this completion?")).toBeTruthy();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    // The option's own title is the subject, and the force form states what the
    // close jumps: the stages it skips and the refusal it bypasses.
    expect(dialog.textContent).toContain("Force-accept as admin without a fresh verdict");
    expect(dialog.textContent).toContain("Bypassing");
    expect(dialog.textContent).toContain("The latest review requests changes.");
    fireEvent.click(findButton(container, "Force-accept VIB-151")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    // The packet resolution, not the force-accept intent: the server resolves
    // the decision and runs the override behind it.
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(submitted[0]!.option).toBe("0");
    expect(submitted[0]!.ackVerdict).toBe("failing");
  });

  it("ruling 672: the repository question's answers are a project admin's on the page, and Confirm sends the repository typed", async () => {
    // CANARY: stop passing `canEditPolicy` to the card and an admin finds
    // both answers inert; pass it to everyone and a maintainer is handed a
    // Confirm the server refuses.
    const question: PacketRender = {
      type: "input",
      kind: "Decision required",
      from: "Operator",
      title: "Connect a repository to Viberr Core?",
      body: "VIB-151 changes the checkout page.",
      observations: [],
      options: [
        { kind: "connect_repository", t: "Connect a repository", d: "", rec: true, reply: true, repo: "acme/site" },
        { kind: "keep_without_repository", t: "Keep this board without one", d: "", rec: false },
      ],
    };
    const maintainer = renderPage({ myRole: "maintainer", task: { packet: question } });
    expect(maintainer.container.textContent).toContain("Both answers decide the board, so a project admin gives one.");
    fireEvent.click(findButton(maintainer.container, "Confirm decision")!);
    expect(maintainer.submitted).toHaveLength(0);
    // A maintainer is stranded on it as a contributor-owner is on a
    // maintainer's decision, so the page offers the way up.
    fireEvent.click(findButton(maintainer.container, "Send to a project admin")!);
    await waitFor(() => expect(maintainer.submitted).toHaveLength(1));
    expect(maintainer.submitted[0]!.intent).toBe("request-maintainer-decision");
    cleanup();

    const admin = renderPage({ myRole: "admin", task: { packet: question } });
    expect(admin.container.textContent).not.toContain("a project admin gives one");
    expect(findButton(admin.container, "Send to a project admin")).toBeUndefined();
    fireEvent.click(findButton(admin.container, "Confirm decision")!);
    await waitFor(() => expect(admin.submitted).toHaveLength(1));
    expect(admin.submitted[0]).toMatchObject({ intent: "resolve-packet", option: "0", note: "acme/site" });
  });

  /**
   * Pass-35 cluster review of ruling 164. A `force_accept` option is offered
   * FROM a blocked packet, and the resolution clears that packet BEFORE
   * `forceAcceptCompletion` runs, so the open-blocked-decision sentence is not
   * a gate this override bypasses. Both `task.blockReason` (the projection's
   * `validation_block_reason`) and `acceptance.blockedReason` fold it in, and
   * the ceremony read them: the "Bypassing" row named the decision the click
   * was answering and told the admin to resolve the packet the button
   * resolves, while `task.acceptance.forced` recorded something else, being
   * computed after the packet is gone.
   */
  it("ruling 164 + F19-7: the force ceremony never bypasses the packet it is resolving", async () => {
    // Canary: restore `task.blockReason ?? acceptance.blockedReason` for the
    // forced ceremony and the dialog quotes the open blocked decision.
    const openPacketSentence =
      "This task has an open blocked decision. Resolve the operator's packet before accepting it.";
    const { container } = renderPage({
      myRole: "admin",
      acceptance: {
        atBoundary: false,
        // What every gate says while the packet stands, the packet included.
        blockedReason: openPacketSentence,
        // What the packet RESOLUTION meets: the packet is what it clears.
        blockedReasonViaPacket: null,
      },
      task: {
        stage: "triage",
        validation: "failing",
        blockReason: openPacketSentence,
        packet: {
          ...packetWith("force_accept"),
          options: [
            {
              kind: "force_accept",
              t: "Force-accept as admin without a fresh verdict",
              d: "",
              rec: true,
            },
            { kind: "request_edit", t: "Send it back for edits", d: "", rec: false },
          ],
        },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    // Still the force ceremony, still naming the option.
    expect(dialog.textContent).toContain("Force-accept as admin without a fresh verdict");
    // But it neither quotes the packet gate nor tells the admin to resolve the
    // decision this very click resolves.
    expect(dialog.textContent).not.toContain("open blocked decision");
    expect(dialog.textContent).not.toContain("Bypassing");
  });

  /**
   * Live validation of ruling 164 (2026-09-07): the force ceremony opened from
   * a `force_accept` option still carried the Withdraws row, naming the very
   * packet the click answers and saying it "closes unanswered with the task".
   * The `task.acceptance.forced` audit row written by that same click reads
   * `withdrawnPacket: null` (the disclosure is built after the packet path has
   * cleared the packet), so the screen and the record disagreed — the class the
   * Bypassing row above was already fixed for. A packet resolution answers the
   * decision; only the direct doors withdraw one.
   */
  it("ruling 164: a packet resolution withdraws nothing, so the ceremony claims no withdrawal", async () => {
    // Canary: pass `task.packet?.title` unconditionally again and both halves
    // of this test go red — the force ceremony and the plain packet accept both
    // print "Withdraws" for the decision they resolve.
    const forced = renderPage({
      myRole: "admin",
      acceptance: {
        atBoundary: false,
        blockedReason: "The latest review requests changes.",
        blockedReasonViaPacket: "The latest review requests changes.",
      },
      task: {
        stage: "triage",
        validation: "failing",
        packet: {
          ...packetWith("force_accept"),
          title: "Continuity degraded, pick a recovery path",
          options: [
            {
              kind: "force_accept",
              t: "Force-accept as admin without a fresh verdict",
              d: "",
              rec: true,
            },
            { kind: "request_edit", t: "Send it back for edits", d: "", rec: false },
          ],
        },
      },
    });
    fireEvent.click(findButton(forced.container, "Confirm decision")!);
    const forcedDialog = forced.container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(forcedDialog.textContent).toContain("Force-accept this completion?");
    expect(forcedDialog.textContent).not.toContain("Withdraws");
    expect(forcedDialog.textContent).not.toContain("closes unanswered");
    forced.unmount();

    // The same rule on the plain `accept_completion` option: it, too, resolves
    // the packet it was offered on.
    const accepted = renderPage({
      myRole: "admin",
      task: {
        pr: acceptedPr({ state: "review" }),
        packet: {
          ...packetWith("accept_completion"),
          title: "Accept completion, or send back for one fix?",
        },
      },
    });
    fireEvent.click(findButton(accepted.container, "Confirm decision")!);
    const acceptDialog = accepted.container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(acceptDialog.textContent).toContain("Accept this completion?");
    expect(acceptDialog.textContent).not.toContain("Withdraws");
    accepted.unmount();

    // The DIRECT door still discloses it: the Accept button closes a standing
    // decision unanswered, and the row is the only warning a person gets.
    const direct = renderPage({
      myRole: "admin",
      task: {
        pr: acceptedPr({ state: "review" }),
        packet: {
          ...packetWith("redirect"),
          title: "Resume the rehydrated thread?",
        },
      },
    });
    fireEvent.click(findButton(direct.container, "Accept completion")!);
    const directDialog = direct.container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(directDialog.textContent).toContain("Withdraws");
    expect(directDialog.textContent).toContain("Resume the rehydrated thread?");
  });

  it("every OTHER packet option still resolves in one click — none of them writes to GitHub", async () => {
    const { container, submitted, queryByText } = renderPage({
      myRole: "admin",
      task: { packet: packetWith("redirect") },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(queryByText("Accept this completion?")).toBeNull();
    // Ruling 88's scope, on the client: a decision that accepts nothing sends
    // no acknowledgment, and the server asks it for none.
    expect(submitted[0]!.ackPr).toBeUndefined();
    expect(submitted[0]!.ackRevision).toBeUndefined();
    expect(submitted[0]!.ackVerdict).toBeUndefined();
  });

  it("F19-37: the Current-state stage menu's move into the LAST stage asks first — the sixth writer", async () => {
    // The matrix listed five writers; this one was found by probing a path the
    // list did not name. `intent: "transition"` into the terminal stage is read
    // by the server as an acceptance ("A HUMAN manually moving a task INTO the
    // final stage IS accepting completion" → acceptCompletion → the real merge),
    // and the BOARD's identical menu has confirmed since R18-7 — so the task
    // page was the last surface where moving a card to Done merged silently.
    // Canary: submit straight from `onTransition` and `submitted` fills on the
    // menu click, before any dialog exists.
    const { container, submitted, getByLabelText, getByRole, getByText } =
      renderPage({
        myRole: "admin",
        workRevisionSha: "aaaaaaaaaaaabbbbbbbbbbbb",
        task: { pr: acceptedPr({ state: "review" }) },
      });
    fireEvent.click(getByLabelText("Change stage (currently Review)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    expect(submitted).toHaveLength(0);
    // The heading names what the stage move IS, not what it was clicked as.
    expect(getByText("Moving to Done accepts this completion")).toBeTruthy();
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).toContain("Review → Done");
    expect(dialog.textContent).toContain("PR #147");
    expect(dialog.textContent).toContain("main");
    expect(dialog.textContent).toContain("aaaaaaaaaaaa");
    // The confirmed click keeps the server's own stage-move contract.
    fireEvent.click(findButton(container, "Move → Done & merge")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("transition");
    expect(submitted[0]!.to).toBe("done");
  });

  it("F19-37: a FORWARD move to another stage still goes in one click — only the last stage is an acceptance", async () => {
    const { submitted, getByLabelText, getByRole, queryByText } = renderPage({
      myRole: "admin",
      task: { stage: "triage" },
    });
    fireEvent.click(getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Review" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("transition");
    expect(submitted[0]!.to).toBe("review");
    expect(submitted[0]!.reason).toBeUndefined();
    expect(queryByText(/accepts this completion/)).toBeNull();
  });

  it("ruling 381: a BACKWARD move asks why first, and sends the answer with the move", async () => {
    // The seventh writer on this menu. A send-back is the strongest instruction
    // a human posts on a board and it used to be mute; the operator then
    // inferred the work from an older decision. Canary: submit straight from
    // `onTransition` and `submitted` fills on the menu click, with no reason.
    const { container, submitted, getByLabelText, getByRole, getByText } =
      renderPage({ myRole: "admin" });
    fireEvent.click(getByLabelText("Change stage (currently Review)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Triage" }));
    expect(submitted).toHaveLength(0);
    expect(getByText("Move back to Triage?")).toBeTruthy();
    // The head glyph points back, the way the move goes (better-ui review
    // 2026-09-24): it was the forward arrow. Canary: drop `r180`.
    const glyph = container.ownerDocument.querySelector("dialog .modal-head .agent-glyph .ico")!;
    expect(glyph.classList.contains("r180")).toBe(true);
    // It does not move until the reason exists.
    const confirm = findButton(container, "Move back")!;
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const why = container.ownerDocument.querySelector("dialog textarea")!;
    fireEvent.change(why, { target: { value: "  the retry path is unhandled  " } });
    fireEvent.click(findButton(container, "Move back")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("transition");
    expect(submitted[0]!.to).toBe("triage");
    expect(submitted[0]!.reason).toBe("the retry path is unhandled");
  });
});

/**
 * F19-10 — the "Complete merge" affordance was hidden from the contributor-owner
 * the SERVER authorizes.
 *
 * `completeTaskMerge` gates on `requireAcceptCompletion(…, "complete a PR
 * merge")` → `ownerException`: the task's own human owner passes whatever their
 * project role, as long as they still hold `own-task` (ruling 22 / R14-2 / FR37
 * — the owner is the acceptance authority ON THEIR OWN TASK, and completing a
 * merge-pending acceptance is part of that same authority). The client asked
 * `roleCan(myRole, "accept-completion")` instead — admin|maintainer only — so a
 * contributor who accepted their own task and got "accepted (merge pending)"
 * (GitHub unreachable, or R16-6's full-autonomy operator half) was shown no way
 * to finish it. The task stranded until a maintainer happened to visit, while
 * the server would have merged it on their click.
 *
 * The fix reads the server's OWN answer — `acceptance.hasAuthority` from
 * `acceptanceStanding`, which computes the identical predicate
 * (`roleCan(role, "accept-completion") || (owner && roleCan(role, "own-task"))`)
 * and keeps it across the terminal-stage early return that every merge-pending
 * task lands in (acceptance stamps `stage = doneStageId` + `pr.state:
 * accepted`).
 */
describe("F19-10: merge-pending is finishable by the owner the server authorizes", () => {
  const mergePending = {
    // The state acceptance leaves behind when the merge could not run: Done
    // stage, PR stamped accepted. `atBoundary`/`canAccept` are false because the
    // task is already terminal — `hasAuthority` is the only live answer left.
    acceptance: {
      hasAuthority: true,
      atBoundary: false,
      canAccept: false,
      blockedReason: null,
      terminallyBlocked: false,
    },
    task: {
      stage: "done",
      displayReadiness: "accepted",
      pr: {
        number: 147,
        state: "accepted",
        title: "[VIB-151] Compress timelines",
      },
    },
  } satisfies { acceptance: Partial<AcceptanceAffordance>; task: Partial<TaskDetail> };

  it("a CONTRIBUTOR who owns the task is offered the merge — and it still asks first", async () => {
    // Canary: put `roleCan(myRole, "accept-completion")` back in
    // `useRunControls` and this contributor loses the control entirely.
    const { container, submitted, getByText } = renderPage({
      ...mergePending,
      myRole: "contributor",
      meId: "u-selin", // the task's owner in `detail()`
    });
    const btn = findButton(container, "Complete merge");
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    // F19-24's ceremony is unchanged by the widened gate: still no bare-click
    // merge, for the owner any more than for an admin.
    expect(submitted).toHaveLength(0);
    expect(getByText("Run the merge now?")).toBeTruthy();
    fireEvent.click(findButton(container, "Merge PR #147")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("complete-merge");
  });

  it("a contributor who does NOT own it gets no merge control", () => {
    // `hasAuthority` is false for exactly this viewer server-side, so the
    // affordance is absent rather than inert — the client never widens past the
    // server's answer, it only stops narrowing past it.
    const { container } = renderPage({
      ...mergePending,
      acceptance: { ...mergePending.acceptance, hasAuthority: false },
      myRole: "contributor",
      meId: "u-nobody",
    });
    expect(findButton(container, "Complete merge")).toBeUndefined();
  });

  it("a maintainer who owns nothing here keeps the merge control (no narrowing)", () => {
    const { container } = renderPage({
      ...mergePending,
      myRole: "maintainer",
      meId: "u-arda",
    });
    expect(findButton(container, "Complete merge")).toBeDefined();
  });
});

/**
 * R19-5 — force-accept MAY skip the remaining stages AND the review gate. The
 * owner ruled the skip legal (the server does NOT refuse off-boundary) and the
 * SILENCE about it the defect: the affordance says it skips, and the confirm
 * says exactly WHAT.
 */
describe("R19-5: the force-accept confirm enumerates what the jump skips", () => {
  const FOUR_STAGES = [
    { id: "triage", name: "Triage", color: "slate" },
    { id: "impl", name: "In Progress", color: "amber" },
    { id: "review", name: "Review", color: "blue" },
    { id: "done", name: "Done", color: "green" },
  ];
  const openForceConfirm = (props: Parameters<typeof renderPage>[0]) => {
    const r = renderPage(props);
    fireEvent.click(findButton(r.container, "Force accept")!);
    return {
      ...r,
      dialog: r.container.ownerDocument.querySelector(
        'dialog[data-screen-label="Accept completion dialog"]',
      )!,
    };
  };

  it("lists the skipped stages by name, in order, plus the review gate", () => {
    // Canary: drop the `skipsStages` row and the dialog goes back to naming only
    // the gate it bypasses — the stages it jumps stay invisible.
    const { dialog } = openForceConfirm({
      myRole: "admin",
      task: {
        stage: "triage",
        stages: FOUR_STAGES,
        workflow: [],
        pr: { number: 147, state: "review", title: "x" },
      },
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason:
          "VIB-151 is at Triage, not Review — a completion can only be accepted from the boundary the workflow puts before Done.",
      },
    });
    expect(dialog.textContent).toContain("In Progress → Review");
    expect(dialog.textContent).toContain("review gate");
    expect(dialog.textContent).toContain("VIB-151 goes straight to Done");
    expect(dialog.textContent).toContain("the pull request merges");
    // The refusal it overrides is still quoted, and still framed as a bypass.
    expect(dialog.textContent).toContain("Bypassing");
  });

  it("names the review gate alone when there is no stage in between", () => {
    const { dialog } = openForceConfirm({
      myRole: "admin",
      task: { stage: "review", stages: FOUR_STAGES },
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet.",
      },
    });
    expect(dialog.textContent).toContain("The review gate");
    expect(dialog.textContent).not.toContain("In Progress →");
  });

  it("says nothing about skipping when the task stands AT the boundary", () => {
    // atBoundary means the only thing force bypasses is the verdict gate itself;
    // a "Skips: …" row here would invent stages that are not being jumped.
    const { dialog } = openForceConfirm({
      myRole: "admin",
      acceptance: {
        atBoundary: true,
        canAccept: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet.",
      },
    });
    expect(dialog.textContent).not.toContain("Skips");
    expect(dialog.textContent).toContain("Bypassing");
  });

  it("the plain accept path never claims a skip, boundary or not", () => {
    // Off-boundary WITHOUT force is a server refusal, not a jump — the dialog
    // says "Blocked", and promising a skip would promise a power nobody has.
    // The `complete-merge` mode is the sharpest case and the reason this went
    // wrong: `acceptanceStanding` returns the `denied` shape (which
    // carries `atBoundary: false`) for a task ALREADY at the terminal stage,
    // and a merge-pending task is exactly that — so a bare `!atBoundary` made
    // every "Complete merge" confirm announce that a task already at Done
    // "goes straight to Done", on the dialog authorizing the real merge.
    const { container } = renderPage({
      myRole: "admin",
      task: { pr: { number: 147, state: "accepted", title: "x" } },
      acceptance: { atBoundary: false, canAccept: false, blockedReason: "not yet" },
    });
    fireEvent.click(findButton(container, "Complete merge")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).not.toContain("Skips");
    expect(dialog.textContent).not.toContain("goes straight to Done");
  });

  it("an OFF-boundary stage move into the terminal stage claims NO skip — the server refuses it", () => {
    // This test asserted the OPPOSITE one round ago, and the assertion was
    // false. A manual move into the LAST stage is routed by `transitionStage`
    // into `acceptCompletion` WITHOUT `force`, so `acceptanceStageBlockedReason`
    // refuses any off-boundary stage with a 409 and the task never moves — see
    // the standing server test `app/server/tasks/acceptance-graph.server.test.ts`
    // → "refuses a manual board move from Triage straight to Done". `atBoundary`
    // is that exact predicate, so `stage-move && !atBoundary` was false in 100%
    // of the cases it fired, and it printed "goes straight to Done" directly
    // beside the "Blocked" row quoting the refusal that contradicts it.
    const { container, getByLabelText, getByRole } = renderPage({
      myRole: "admin",
      task: {
        stage: "triage",
        stages: FOUR_STAGES,
        workflow: [],
        pr: { number: 147, state: "review", title: "x" },
      },
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason:
          "VIB-151 is at Triage, not Review — a completion can only be accepted from the boundary the workflow puts before Done.",
      },
    });
    fireEvent.click(getByLabelText("Change stage (currently Triage)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).not.toContain("Skips");
    expect(dialog.textContent).not.toContain("goes straight to Done");
    expect(dialog.textContent).not.toContain("In Progress → Review");
    // What it says instead: the standing refusal, framed as a block. Only
    // force-accept may call a refusal something it is "Bypassing".
    expect(dialog.textContent).toContain("Blocked");
    expect(dialog.textContent).toContain("not Review");
    expect(dialog.textContent).not.toContain("Bypassing");
  });

  it("a stage move that starts AT the boundary claims no skip", () => {
    // Review → Done is the boundary move the workflow already expects; there is
    // nothing in between, so a "Skips" row would invent a jump.
    const { container, getByLabelText, getByRole } = renderPage({
      myRole: "admin",
      task: { stage: "review", stages: FOUR_STAGES },
      acceptance: { atBoundary: true, canAccept: true },
    });
    fireEvent.click(getByLabelText("Change stage (currently Review)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Done" }));
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    expect(dialog.textContent).toContain("Moving to Done accepts this completion");
    expect(dialog.textContent).not.toContain("Skips");
  });
});

describe("R15-2 safety net (b): the manual delivery control", () => {
  it("renders for a viewer with delivery authority when no live PR stands, and submits deliver-review", async () => {
    const { container, submitted } = renderPage({ canDeliver: true });
    const btn = findButton(container, "Deliver branch & open PR");
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("deliver-review");
  });

  it("ruling 647: offers no delivery for a task delivered as the files saved on it", () => {
    // CANARY: hand the panel `onDeliver` whatever the delivery is, and every
    // estimate on the AWS board offers to push a branch and open a PR again.
    const { container } = renderPage({ canDeliver: true, filesDeliveredAt: "2026-10-03T19:15:48.581Z" });
    expect(findButton(container, "Deliver branch & open PR")).toBeUndefined();
  });

  it("ruling 134(c): offers the push control when the open PR does not carry the delivered revision, and it submits deliver-review", async () => {
    // Canary: revert the visibility condition to "no live PR" and the button
    // is gone while PR #9 is open.
    const rev = "9".repeat(40);
    const { container, submitted } = renderPage({
      canDeliver: true,
      task: {
        workRevisionSha: rev,
        pr: {
          number: 9, state: "review", title: "x", headSha: "1".repeat(40),
          unpushedRevision: { revisionSha: rev, prHeadSha: "1".repeat(40), relation: "behind" },
        },
      },
    });
    const btn = findButton(container, "Push 9999999 to PR #9");
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(false);
    expect(container.textContent).toContain("Unpushed");
    expect(container.textContent).toContain("is not on PR #9");
    fireEvent.click(btn!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("deliver-review");
  });

  it("ruling 134(c): hides the push control when the recorded record is stale", () => {
    // Canary: drop the revision comparison in `unpushedRevisionOf`.
    const { container } = renderPage({
      canDeliver: true,
      task: {
        workRevisionSha: "7".repeat(40),
        pr: {
          number: 9, state: "review", title: "x", headSha: "1".repeat(40),
          unpushedRevision: { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" },
        },
      },
    });
    expect(findButton(container, "Push 9999999 to PR #9")).toBeUndefined();
    expect(findButton(container, "Deliver branch & open PR")).toBeUndefined();
    expect(container.textContent).not.toContain("Unpushed");
  });

  it("ruling 134(c): a diverged relation renders the row and a DISABLED control naming the refusal", () => {
    // Canary: render the primary (enabled) control for `diverged`.
    const rev = "9".repeat(40);
    const { container } = renderPage({
      canDeliver: true,
      task: {
        workRevisionSha: rev,
        pr: {
          number: 9, state: "review", title: "x", headSha: "1".repeat(40),
          unpushedRevision: { revisionSha: rev, prHeadSha: "1".repeat(40), relation: "diverged" },
        },
      },
    });
    const btn = findButton(container, "Push 9999999 to PR #9");
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(true);
    expect(btn!.title).toContain("refused as non-fast-forward");
    expect(container.textContent).toContain("Unpushed");
  });

  // Ruling 134(c): the record's journey through the REAL projection (write the
  // task file, run the workspace reconcile, rebuild, load the detail, evaluate
  // the exact expression this panel renders from) is proven in
  // app/server/projections/task-detail-unpushed.server.test.ts, a node-env
  // test: the server modules it drives do not run under this file's jsdom.

  it("hides once a live PR stands, and entirely without delivery authority", () => {
    const withPr = renderPage({
      canDeliver: true,
      task: { pr: { number: 9, state: "review", title: "x" } },
    });
    expect(findButton(withPr.container, "Deliver branch & open PR")).toBeUndefined();
    cleanup();
    const noAuthority = renderPage({ canDeliver: false });
    expect(
      findButton(noAuthority.container, "Deliver branch & open PR"),
    ).toBeUndefined();
  });
});

describe("R14-3: the task archive", () => {
  it("maintainer+ gets Archive; it confirms first, then submits archive-task", async () => {
    const { container, submitted, getByText } = renderPage({ myRole: "maintainer" });
    const btn = findButton(container, "Archive task")!;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    // The confirm states what archiving costs before anything is written.
    expect(getByText("Archive this task?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    fireEvent.click(findButton(container, "Archive VIB-151")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("archive-task");
  });

  it("U36-1 (pass 36): with something to withdraw, the Withdrawn row says restore brings a human back, not the question", () => {
    // Canary: put "Restoring the task reopens the question" back in
    // archive-confirm.tsx.
    const { container } = renderPage({
      myRole: "maintainer",
      recommendations: [
        {
          id: "rec_1",
          kind: "transition",
          label: "Move the task to Review",
          detail: "Clean review.",
          toStageId: "review",
        },
      ],
    });
    fireEvent.click(findButton(container, "Archive task")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Archive task dialog"]',
    )!;
    expect(dialog.textContent).toContain("1 pending operator recommendation");
    expect(dialog.textContent).not.toContain("reopens the question");
    expect(dialog.textContent).toContain("Restoring brings the task back to a human");
  });

  it("C14: the Withdrawn row names its scope, not a blanket 'nothing is pending'", () => {
    // The row surveys the open packet + pending recommendations only; on a task
    // with neither it claimed "Nothing is pending on this task right now", which
    // over-reached a live run streaming behind the dialog. Narrowed to scope.
    const { container } = renderPage({ myRole: "maintainer" });
    fireEvent.click(findButton(container, "Archive task")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Archive task dialog"]',
    )!;
    expect(dialog.textContent).toContain(
      "No open decision or pending recommendation to withdraw",
    );
    expect(dialog.textContent).not.toContain(
      "Nothing is pending on this task right now",
    );
  });

  it("F19-36: the archive confirm names the PR state in the product's vocabulary, not the raw token", () => {
    // It printed "PR #147 accepted" / "PR #147 review" — the internal tokens —
    // on a dialog deciding a disposition. Second site of F19-14's defect.
    //
    // The first version of this test asserted `not.toContain("PR #147
    // accepted")` — the PRE-fix string, separator and all. The fix added a
    // ` · ` separator, so the likeliest regression (swapping `prPill.label`
    // back to `task.pr.state` and leaving the layout alone) renders
    // "PR #147 · accepted" and walks straight past that negative (audit §2.4).
    // The pill's WHOLE text is pinned instead, so any substitution flips it.
    //
    // Canary: render `{task.pr.state}` in place of `{prPill.label}` in
    // archive-confirm.tsx and the exact-text assertion goes red.
    const { container } = renderPage({
      myRole: "maintainer",
      task: {
        pr: { number: 147, state: "accepted", title: "x" },
      },
    });
    fireEvent.click(findButton(container, "Archive task")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Archive task dialog"]',
    )!;
    const prPill = Array.from(dialog.querySelectorAll(".pill")).find((p) =>
      p.textContent?.includes("PR #147"),
    );
    expect(prPill, "the archive confirm states the PR the task carries").toBeDefined();
    expect(prPill!.textContent).toBe("PR #147 · merge pending");
    // …and the raw token reaches the dialog nowhere, with or without the
    // separator the fix introduced.
    expect(dialog.textContent).not.toMatch(/PR #147\s*(·\s*)?accepted/);
  });

  it("ruling 149: Archive wears the danger label; Restore, a recovery, does not", () => {
    // The archive ceremony already commits in red (`ArchiveConfirm`). jsdom
    // computes no colour, so the class IS the assertion: it is the only thing
    // that decides whether `.btn.ghost.danger` ever reaches this trigger.
    //
    // Canary: drop the ternary in `task-side-panels.tsx` and one arm goes red.
    const live = renderPage({ myRole: "maintainer" });
    expect(
      Array.from(findButton(live.container, "Archive task")!.classList),
    ).toContain("danger");
    cleanup();

    const restored = renderPage({ archived: true, myRole: "maintainer" });
    expect(
      Array.from(findButton(restored.container, "Restore from archive")!.classList),
      "restoring is a recovery, not a destruction",
    ).not.toContain("danger");
  });

  it("a contributor never sees the control (archive is board-management authority)", () => {
    const { container } = renderPage({ myRole: "contributor", meId: "u-selin" });
    expect(findButton(container, "Archive task")).toBeUndefined();
  });

  it("an archived task says so and offers Restore, which submits without a dialog", async () => {
    const { container, submitted, getAllByText } = renderPage({
      archived: true,
      myRole: "maintainer",
    });
    expect(getAllByText("archived").length).toBeGreaterThan(0);
    fireEvent.click(findButton(container, "Restore from archive")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("restore-task");
  });

  it("an archived task offers no acceptance — it is out of the flow", () => {
    const { container } = renderPage({ archived: true });
    expect(findButton(container, "Accept completion")).toBeUndefined();
  });
});

const ACCEPT_DIALOG = 'dialog[data-screen-label="Accept completion dialog"]';
const acceptDialog = (container: HTMLElement) =>
  container.ownerDocument.querySelector(ACCEPT_DIALOG);

/** Let any submission a click STARTED land before asserting that none did.
 *  Without this the "nothing was written" assertions pass on an unguarded
 *  click too, because the fetcher POST has not resolved yet when the next
 *  statement runs — the assertion would read green while the PR merged. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const PR_147: PrRef = {
  number: 147,
  state: "review",
  title: "[VIB-151] Compress long-running task timelines",
};

/**
 * F19-7 — resolving a packet option whose kind is `accept_completion` merges
 * the review PR from the card's generic "Confirm decision" button. There IS a
 * select-then-confirm step, but it discloses nothing: no PR number, no
 * delivered revision, no verdict, no merge target, no "merging is one-way",
 * and no "Not yet".
 */
describe("F19-7: a packet accept_completion option discloses the merge", () => {
  const acceptPacket = (options: PacketOption[]): PacketRender => ({
    type: "input",
    kind: "input required",
    from: "Operator",
    title: "VIB-151 is ready to accept",
    body: "The delivered revision carries an approving verdict.",
    observations: [],
    options,
  });

  it("Confirm decision opens the acceptance dialog, then resolves the packet", async () => {
    const { container, submitted } = renderPage({
      task: {
        pr: PR_147,
        packet: acceptPacket([
          {
            kind: "accept_completion",
            t: "Accept the completion and close it",
            d: "Merge the PR and move to Done.",
            rec: true,
          },
        ]),
      },
      workRevisionSha: "abcdef1234567890",
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    // Canary: point `onResolve` straight at `submitResolve` and this fails —
    // the PR merges from a button that promised only "Confirm decision".
    await settle();
    expect(submitted).toHaveLength(0);
    const dialog = acceptDialog(container);
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("PR #147 · in review");
    expect(dialog!.textContent).toContain("main");
    expect(dialog!.textContent).toContain("abcdef123456");
    expect(dialog!.textContent).toContain("Merging is one-way");
    expect(findButton(container, "Not yet")).toBeDefined();
    fireEvent.click(findButton(container, "Accept → Done & merge")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(submitted[0]!.option).toBe("0");
  });

  it("a non-acceptance option still resolves from the card in one step", async () => {
    const { container, submitted } = renderPage({
      task: {
        packet: acceptPacket([
          {
            kind: "request_edit",
            t: "Send it back for edits",
            d: "The operator reopens the work.",
            rec: true,
          },
        ]),
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(acceptDialog(container)).toBeNull();
  });

  it("names the refusal the PACKET path would hit, not the open-packet one", async () => {
    // `resolvePacket` evaluates the contract with `blockedPacket: false` — the
    // open packet is what this resolution clears. Printing `blockedReason` here
    // would report a bypass the server never performs, and bury the real
    // missing signal underneath it.
    const { container } = renderPage({
      task: {
        pr: PR_147,
        packet: acceptPacket([
          {
            kind: "accept_completion",
            t: "Accept the completion and close it",
            d: "Merge the PR and move to Done.",
            rec: true,
          },
        ]),
      },
      acceptance: {
        canAccept: false,
        blockedReason:
          "This task has an open blocked decision — resolve the operator's packet before accepting it.",
        blockedReasonViaPacket:
          "VIB-151's delivered revision has no approving verdict yet.",
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const dialog = acceptDialog(container);
    expect(dialog!.textContent).toContain("no approving verdict yet");
    expect(dialog!.textContent).not.toContain("open blocked decision");
  });
});

/**
 * F19-14 — the accept dialog printed the raw `pr.state` enum member in a
 * hardcoded neutral pill, so it said "review" where every sibling surface says
 * "in review", and drew a CLOSED, unmerged PR as grey chrome inside the dialog
 * whose button merges it.
 */
describe("F19-14: the accept dialog speaks the product's PR vocabulary", () => {
  const renderConfirm = (state: PrState) =>
    render(
      <AcceptConfirm
        task={detail({
          pr: { number: 147, state, title: "[VIB-151] x" },
        })}
        workRevisionSha="abcdef1234567890"
        noChanges={false}
        defaultBranch="main"
        ceremony={{ mode: "accept" }}
        blockedReason={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

  it("renders the canonical prStatePill label and tone, not the raw enum member", () => {
    const inReview = renderConfirm("review");
    const reviewPill = [
      ...inReview.container.querySelectorAll(".pill"),
    ].find((p) => p.textContent?.includes("PR #147"))!;
    expect(reviewPill.textContent).toBe("PR #147 · in review");
    expect(reviewPill.className).toContain("info");
    expect(reviewPill.className).not.toContain("neutral");
    cleanup();
    const closed = renderConfirm("closed");
    const closedPill = [...closed.container.querySelectorAll(".pill")].find((p) =>
      p.textContent?.includes("PR #147"),
    )!;
    expect(closedPill.textContent).toBe("PR #147 · closed");
    // A PR GitHub closed without merging is a risk, not chrome.
    expect(closedPill.className).toContain("risk");
  });

  it("so does the archive confirm — the closed PR that usually causes the archive", () => {
    const { container } = renderPage({
      myRole: "maintainer",
      task: {
        pr: { number: 124, state: "closed", title: "[VIB-151] x" },
      },
    });
    fireEvent.click(findButton(container, "Archive task")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Archive task dialog"]',
    )!;
    const pill = [...dialog.querySelectorAll(".pill")].find((p) =>
      p.textContent?.includes("PR #124"),
    )!;
    expect(pill.textContent).toBe("PR #124 · closed");
    expect(pill.className).toContain("risk");
  });
});

/**
 * UX19-9 — the packet's `archive_task` option, and above all its
 * `deleteBranch: true` variant, resolved straight to the server from the card's
 * generic "Confirm decision" button. Ruling 17 makes that resolution the only
 * remote-branch deletion the product has ("Remote-branch deletion exists only
 * as that packet resolution"); rulings 20 (R15-1) and 53 (R18-7) put a confirm
 * that states the consequence on every one-way write, and pass 19 closed the
 * last four gaps in that family. This one inverted the app's own ceremony: the
 * REVERSIBLE archive (the Current-state button) opened `ArchiveConfirm` and
 * enumerated what it withdraws, while the irreversible one — the same archive
 * PLUS a permanent GitHub branch delete carrying the only copy of the rejected
 * work — committed from a bare click and announced itself afterwards, as a
 * timeline note.
 */
describe("UX19-9: a packet archive_task option states what it destroys", () => {
  const ARCHIVE_DISCLOSURE = {
    taskKey: "VIB-151",
    branch: "vib-151",
    pendingRecommendations: 2,
    unownedPr: null,
    foreignHead: null,
    openPr: null,
  };

  const archivePacket = (deleteBranch: boolean): PacketRender => {
    const option: PacketOption = {
      kind: "archive_task",
      t: deleteBranch ? "Archive and delete the branch" : "Archive the task",
      d: "Discards the rejected work entirely.",
      rec: true,
    };
    // The plain-archive variant must carry NO `deleteBranch` key at all — the
    // absence is what the "claims no branch deletion" case reads.
    if (deleteBranch) option.deleteBranch = true;
    return {
      type: "blocked",
      kind: "blocked decision",
      from: "Operator",
      title: "PR #147 was closed without merging — pick a recovery path",
      body: "The pull request was closed on GitHub without merging.",
      observations: [],
      options: [option],
    };
  };

  it("A11Y-7 (pass 32): each option radio is named by its title", () => {
    const { getByRole } = renderPacket(false, undefined, () => {});
    // The live tree tool announced "radio, 1 of 2" with no text; the
    // computed accessible name is the option title, pinned here.
    expect(getByRole("radio", { name: /Archive the task/ })).toBeTruthy();
    expect(getByRole("radio", { name: /Write your own directive/ })).toBeTruthy();
  });

  const archiveDialog = (container: HTMLElement) =>
    container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet archive dialog"]',
    );

  /** The card on its own, so the disclosure the page supplies can be asserted
   *  (the branch name and the withdrawn recommendations live on the task, not
   *  on the packet render). */
  const renderPacket = (
    deleteBranch: boolean,
    disclosure: typeof ARCHIVE_DISCLOSURE | undefined,
    onResolve: (index: number, note: string) => void,
  ) => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <DecisionPacket
              packet={archivePacket(deleteBranch)}
              busy={false}
              canResolve
              canResolveCompletion
              canEditGoal
              canArchive
              {...(disclosure ? { archiveDisclosure: disclosure } : {})}
              onResolveCustom={() => {}} onResolve={onResolve}
              onAsk={() => {}}
            />
          </ToastProvider>
        ),
      },
    ]);
    return render(<Stub initialEntries={["/"]} />);
  };

  it("Confirm decision opens a dialog instead of posting the deletion", async () => {
    const { container, submitted } = renderPage({
      task: { packet: archivePacket(true) },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    // Canary: drop the `archive_task` branch from the button's onClick and
    // this fails — the remote branch is deleted on the first click, as it was.
    await settle();
    expect(submitted).toHaveLength(0);
    expect(archiveDialog(container)).toBeTruthy();
    expect(findButton(container, "Not yet")).toBeDefined();
  });

  it("U36-1 (pass 36): the Withdrawn row promises what restore does — a human, not a reopened question", () => {
    // Restore sets `waiting: human` and writes "run the operator to reopen the
    // decision"; the packet's options are gone with the archive, so nothing
    // can reopen the SAME question. The dialog said "Restoring the task
    // reopens the question" — the server and the dialog made opposite
    // promises. Canary: put the old sentence back.
    const { container } = renderPacket(true, ARCHIVE_DISCLOSURE, () => {});
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = archiveDialog(container)!.textContent!;
    expect(text).not.toContain("reopens the question");
    expect(text).toContain("Restoring brings the task back to a human");
    expect(text).toContain("run the operator to reopen the decision");
  });

  it("names the branch, says the deletion cannot be undone, and lists what the archive withdraws", () => {
    const { container } = renderPacket(true, ARCHIVE_DISCLOSURE, () => {});
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = archiveDialog(container)!.textContent!;
    expect(text).toContain("vib-151");
    expect(text).toContain("cannot be undone");
    // The withdrawal `ArchiveConfirm` states on the reversible path and this
    // one disclosed nowhere.
    expect(text).toContain("2 pending operator recommendations");
    expect(text).toContain(
      "PR #147 was closed without merging — pick a recovery path",
    );
    // The button names the outcome, unlike "Confirm decision".
    expect(findButton(container, "Archive & delete vib-151")).toBeDefined();
  });

  it("confirming resolves the packet by index, with the note", async () => {
    const { container, submitted } = renderPage({
      task: { packet: archivePacket(true) },
    });
    fireEvent.change(container.querySelector("#pkt-note")!, {
      target: { value: "closed as won't fix" },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    // The page wires `archiveDisclosure`, so the dialog names the REAL branch
    // (`vib-151`) rather than the generic "the branch" fallback a bare
    // `DecisionPacket` render falls back to — that wiring is the fix, so the
    // page-level assertion has to name the branch too.
    fireEvent.click(findButton(container, "Archive & delete vib-151")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(submitted[0]!.option).toBe("0");
    expect(submitted[0]!.note).toBe("closed as won't fix");
  });

  it("the plain archive option confirms too, and claims no branch deletion", () => {
    const { container } = renderPacket(false, ARCHIVE_DISCLOSURE, () => {});
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = archiveDialog(container)!.textContent!;
    expect(text).toContain("Archive this task?");
    expect(text).not.toContain("cannot be undone");
    expect(text).not.toContain("vib-151");
  });

  it("dismissing writes nothing", async () => {
    const onResolve = vi.fn();
    const { container } = renderPacket(true, ARCHIVE_DISCLOSURE, onResolve);
    fireEvent.click(findButton(container, "Confirm decision")!);
    fireEvent.click(findButton(container, "Not yet")!);
    await settle();
    expect(onResolve).not.toHaveBeenCalled();
    expect(archiveDialog(container)).toBeNull();
  });

  it("a non-archive option still resolves from the card in one step", async () => {
    const { container, submitted } = renderPage({
      task: {
        packet: {
          ...archivePacket(true),
          options: [
            {
              kind: "custom",
              t: "Rework and reopen the PR",
              d: "Send it back to the delivering agent.",
              rec: true,
            },
          ],
        },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(archiveDialog(container)).toBeNull();
  });
});

/**
 * V1 — the `resolve_remote_collision` ceremony's "and closes its pull request
 * #N" clause was unreachable in the product. `PacketArchiveDisclosure.unownedPr`
 * was optional, and the ONE production producer (this page) built the
 * disclosure as an object literal carrying the other three fields and skipping
 * that one, so the card only ever saw `undefined` and the clause rendered
 * nowhere but in a component test that passed the number by hand. The number
 * was on `task.unownedPr` the whole time, beside the branch the same literal
 * already read.
 *
 * So these render the PAGE, not the card: the defect was the WIRING, and a test
 * that supplies the disclosure itself cannot see it. The field is required now,
 * which is what keeps the next literal from skipping it silently.
 */
describe("V1: the page hands the collision ceremony the unowned PR", () => {
  const collisionPacket: PacketRender = {
    type: "blocked",
    kind: "blocked decision",
    from: "Operator",
    title: "The remote vib-151 is not this task's work",
    body: "An unrelated branch is squatting on this task's branch name.",
    observations: [],
    options: [
      {
        kind: "resolve_remote_collision",
        t: "Delete the stale remote branch, then redeliver",
        d: "Reclaims the branch name for this task.",
        rec: true,
      },
    ],
  };

  const collisionDialog = (container: HTMLElement) =>
    container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet collision dialog"]',
    );

  it("names the pull request the resolution closes, read off the task", () => {
    const { container } = renderPage({
      task: { packet: collisionPacket, unownedPr: 232 },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = collisionDialog(container)!.textContent!;
    // Canary: drop `unownedPr: task.unownedPr` from the page's
    // `archiveDisclosure` literal and both of these go red, which is exactly
    // the state that shipped.
    expect(text).toContain("closes its pull request");
    expect(text).toContain("#232");
    // The deletes/keeps split it sits inside is still intact.
    expect(text).toContain("vib-151");
    expect(text).toContain("cannot be undone");
    expect(text).toContain("local delivery");
  });

  it("claims no pull-request closure when the task records none", () => {
    const { container } = renderPage({
      task: { packet: collisionPacket, unownedPr: null },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = collisionDialog(container)!.textContent!;
    expect(text).not.toContain("closes its pull request");
    expect(text).not.toContain("#");
    expect(text).toContain("vib-151");
  });

  it("confirming resolves the packet by index, with the note", async () => {
    const { container, submitted } = renderPage({
      task: { packet: collisionPacket, unownedPr: 232 },
    });
    fireEvent.change(container.querySelector("#pkt-note")!, {
      target: { value: "the stale ref is from the old vib-5 experiment" },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    expect(submitted).toHaveLength(0);
    fireEvent.click(findButton(container, "Clear collision & redeliver")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("resolve-packet");
    expect(submitted[0]!.option).toBe("0");
    expect(submitted[0]!.note).toBe(
      "the stale ref is from the old vib-5 experiment",
    );
  });
});

/**
 * UXA-6 lineage, closed by the dynamic-dispatch rework: the four slot-shaped
 * recommendation kinds (assign/run × specialist/reviewer) collapsed into ONE
 * `run_agent` — the vocabulary split UXA-6 kept patching cannot recur because
 * there is one chip. The chip names the ACT ("Run agent"); the card's label
 * names the agent the operator picked.
 */
describe("the run recommendation chip: one collapsed run_agent kind", () => {
  it("chips a run_agent card 'Run agent', with the operator's label and prompt detail", () => {
    const { container } = renderPage({
      recommendations: [
        {
          id: "r-run",
          kind: "run_agent",
          profileId: "developer",
          prompt: "Fix the lint debt first",
          // The strings operatorDispatchAgent's recommend arm writes.
          label: "Run Developer",
          detail:
            "Developer fits what the current stage needs; a maintainer starts the run.",
        },
      ],
    });
    const chip = container.querySelector(".op-rec-kind")!;
    // Canary: bring any per-slot KIND_LABEL back and this is what fails.
    expect(chip.textContent).toContain("Run agent");
    expect(chip.textContent).not.toContain("Run specialist");
    expect(chip.textContent).not.toContain("Run reviewer");
    expect(container.querySelector(".op-rec-title")!.textContent).toBe(
      "Run Developer",
    );
  });
});

/**
 * Who may run an agent by hand is the PAGE's answer (`roleCan(myRole,
 * "run-agents")`); the panel only renders it. So on the real page a run-agents
 * holder is offered the manual path beside the empty Engaged agents ledger, and
 * anyone else is told the tier instead of shown a control.
 */
describe("the manual run is offered to run-agents holders only", () => {
  const developer: DeployedSpecialistView = {
    id: "developer",
    name: "Developer",
    role: "Implementation",
    backend: "claude",
    model: "claude-sonnet",
    capabilities: { delivery: true, verdict: false, askHuman: true, browser: false },
  };
  const engagementsCell = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>(".profile-cell")).find((cell) =>
      cell.querySelector(".val.revs"),
    )!;
  const picker = (container: HTMLElement) =>
    container.querySelector('input[aria-label="Choose an agent to run"]');

  it("the empty ledger names the operator as the dispatcher — and the manual control only for run-agents holders", () => {
    const withRun = renderPage({ myRole: "admin", deployedSpecialists: [developer] });
    expect(picker(withRun.container)).not.toBeNull();
    expect(engagementsCell(withRun.container).textContent).toContain(
      "None yet. The operator picks who runs at each stage, or run one yourself above.",
    );
    cleanup();
    const withoutRun = renderPage({ myRole: "contributor", deployedSpecialists: [developer] });
    expect(picker(withoutRun.container)).toBeNull();
    expect(engagementsCell(withoutRun.container).textContent).toContain(
      "None yet. The operator picks who runs at each stage.",
    );
    expect(engagementsCell(withoutRun.container).textContent).not.toContain(
      "run one yourself",
    );
    // Below the tier, the run-an-agent cell states the rule instead of a control.
    expect(withoutRun.container.textContent).toContain(
      "The operator dispatches agents as the task moves. Running one by hand needs the run-agents tier.",
    );
  });
});

/**
 * D6 — confirmation coverage. Six consequential single-click actions had no
 * confirm while a reversible archive took a three-row ceremony; release-ownership
 * was already ceremonied (ReleaseConfirm). These three had none: cancelling a
 * queued re-run, dismissing an operator recommendation, interrupting a live run.
 * Each now confirms first, naming the outcome, before anything submits.
 * (Remove-stage and remove-member are covered in settings-page.test.tsx.)
 */
describe("D6: consequential actions confirm before they act", () => {
  const runningRun = (): RunView => ({
    id: "primary",
    serverRunId: "run_1",
    role: "Primary specialist",
    kind: "primary",
    who: { kind: "agent", backend: "claude", name: "Claude Code", role: "Developer" },
    backend: "claude",
    sdk: "Claude Agent SDK",
    model: "claude-sonnet-4-5",
    profileId: "developer",
    exportable: false,
    sid: "51d8f0e2",
    state: "running",
    lifecycle: "running",
    interruptedBy: null,
    phase: "Running validation sweep",
    step: "Bash · npm test",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finished: null,
    turns: 1,
    tokens: 0,
    tokensEstimated: false,
    cache: NO_RUN_CACHE,
    lines: [],
    raw: [],
    lineCount: 0,
    logWindow: { totalLines: 0, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: 0 },
  });

  it("cancelling a scheduled run confirms, then posts cancel-schedule", async () => {
    // The schedule row lives INSIDE the run control since the dynamic-dispatch
    // rework — same D6 ceremony, new home.
    const { container, submitted, getByText, queryByText } = renderPage({
      myRole: "admin",
      schedules: [
        {
          id: "s-1",
          action: "run-operator",
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          profileId: null,
          prompt: "",
          createdBy: "u-selin",
          createdByLabel: "Selin",
          createdAt: "2026-07-01T09:00:00.000Z",
          status: "pending",
          firedAt: null,
          claimedAt: null,
          retries: 0,
        },
      ],
    });
    // The row's Cancel opens a confirm — nothing submits yet.
    fireEvent.click(getByText("Cancel", { selector: "button.sched-cancel" }));
    expect(getByText("Cancel this scheduled run?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    // Canary: wire the row button straight to submit and this dialog never shows.
    expect(queryByText(/scheduled by Selin/)).toBeTruthy();
    fireEvent.click(findButton(container, "Cancel run")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!).toMatchObject({ intent: "cancel-schedule", scheduleId: "s-1" });
  });

  it("dismissing a recommendation confirms, then posts dismiss-recommendation", async () => {
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      recommendations: [
        {
          id: "rec-d",
          kind: "delivery",
          label: "Deliver the branch and open a PR",
          detail: "The work looks ready to push.",
        },
      ],
    });
    fireEvent.click(findButton(container, "Dismiss")!);
    // Confirms first — the harmless-looking dismiss withdraws a governed decision.
    expect(getByText("Dismiss this recommendation?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    const dismissCommit = findButton(container, "Dismiss recommendation")!;
    // Rulings 149 and 150: the red commit belongs to the controls that take
    // something away. A dismissal is recorded on the timeline and the operator
    // may raise it again, so this one commits primary — like the neutral
    // trigger that opened it. Canary: drop `tone="primary"` and the shared
    // default is red.
    expect(dismissCommit.className).toBe("btn primary");
    fireEvent.click(dismissCommit);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("dismiss-recommendation");
    expect(submitted[0]!.recId).toBe("rec-d");
  });

  it("interrupting a live run confirms, then posts run-interrupt", async () => {
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      runtime: [runningRun()],
    });
    const trigger = findButton(container, "Interrupt")!;
    // Ruling 150: the stop discards the work in flight, so BOTH ends of the
    // action wear ruling 149's red — the shared `LiveRunPanel` trigger and the
    // commit below, which keeps the confirm's `danger` default. Canary: drop
    // `danger` from the trigger's class, or pass `tone="primary"` to the
    // dialog, and one of the two assertions fails.
    expect(trigger.className).toBe("btn ghost sm danger");
    fireEvent.click(trigger);
    // The button opens a confirm; the run keeps going until it is confirmed.
    expect(getByText("Interrupt this run?")).toBeTruthy();
    // Ruling 272 (F37-104): the body used to promise that uncommitted work is
    // lost, and an interrupt never touches the workspace — `cloneRepo`'s reuse
    // path hands the NEXT run that same checkout, fast-forwarding only a tree
    // that is clean. CANARY: restore "Anything it has not already committed or
    // delivered is lost" and both assertions below fail.
    expect(getByText(/stay in the task's workspace exactly as it left them/)).toBeTruthy();
    expect(container.textContent).not.toContain("is lost");
    expect(submitted).toHaveLength(0);
    const interruptCommit = findButton(container, "Interrupt run")!;
    expect(interruptCommit.className).toBe("btn danger");
    fireEvent.click(interruptCommit);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("run-interrupt");
    expect(submitted[0]!.runId).toBe("run_1");
  });
});

/**
 * U7 — D2's other half — and U35-2 (pass 35).
 *
 * UX spec §Breakpoint Strategy: *"the task detail's side-by-side regions stack,
 * preserving reading order: current state, latest packet, next action, then the
 * timeline."* Reading order is SOURCE order — it is what a screen reader
 * announces and what Tab walks. Pass 20 lifted the side column at 1100px with
 * `order: -1` and left the DOM alone, recording the departure in a CSS comment
 * that cited this very sentence as its authority; below that width a sighted
 * keyboard user then saw "Accept completion → Done" at the top of the page and
 * reached it LAST, after every timeline entry (WCAG 2.2 SC 1.3.2 / 2.4.3).
 *
 * U7 answered by putting the side column first, but the task's name, its goal
 * and the open decision packet lived in the main column, so a 390px viewport
 * stacked the GitHub card, Current state, Details and Permissions ABOVE the
 * title (y=1659 on KNC-6) and the question the packet asked (y=2070). The page
 * is four regions now: `.detail-head` (title and goal), `.detail-packet` (the
 * open packet — owner, 2026-09-08: its own region so the desktop paint can put
 * it at the top of the main column with the side column beside it), then
 * `.detail-side` (the GitHub trace, then Current state with the next action,
 * then Details — ruling 170 put GitHub at the top right beside the goal, and
 * the DOM says the same), then
 * `.detail-main` (runs and the timeline); placed by grid cell in app.css, so the
 * desktop paint keeps two columns while one order serves both. This asserts the
 * order and its CONTENT — a swap that moved empty divs would pass on order
 * alone. Canary: swap the JSX regions back and the order assert is red.
 */
/**
 * Ruling 497: a decision's notification opens the decision itself: the open
 * packet at `#decision`, the pending recommendation cards at
 * `#recommendations`. The page marks the region and focuses it; the G7
 * focus on `.detail` does not take it back.
 *
 * Canaries: drop `data-targeted` from either region and nothing marks it; let
 * the G7 effect focus `.detail` unconditionally and the event, which the
 * timeline (a child, whose effects run first) focused, loses its focus.
 */
describe("ruling 497: a decision's notification opens the decision", () => {
  it("marks and focuses the open packet at #decision, and the cards at #recommendations", async () => {
    const { container } = renderPage({
      entry: "/#decision",
      task: {
        packet: {
          type: "input",
          kind: "Decision required",
          from: "Operator",
          title: "Which spec wins?",
          body: "The goal and the merged spec disagree.",
          observations: [],
          options: [
            { kind: "edit_goal", t: "Align the goal", d: "", rec: true },
            { kind: "redirect", t: "Redirect", d: "", rec: false },
          ],
        },
      },
    });
    const packet = container.querySelector(".detail-packet")!;
    await waitFor(() => expect(packet.hasAttribute("data-targeted")).toBe(true));
    expect(packet.id).toBe("decision");
    // The mark is drawn by the render, the focus by the effect after it.
    await waitFor(() => expect(document.activeElement).toBe(packet));
    cleanup();

    const { container: page } = renderPage({
      entry: "/#recommendations",
      recommendations: [
        { id: "rec-1", kind: "run_agent", label: "Run the Developer", detail: "Ready for work." },
      ],
    });
    const cards = page.querySelector(".op-recs")!;
    await waitFor(() => expect(cards.hasAttribute("data-targeted")).toBe(true));
    expect(cards.id).toBe("recommendations");
    await waitFor(() => expect(document.activeElement).toBe(cards));
    expect(page.querySelector(".detail-packet")).toBeNull();
  });

  it("keeps the focus on a timeline event a notification opened", async () => {
    const at = "2026-09-26T07:00:00.123Z";
    const { container } = renderPage({
      entry: `/#event-${at}`,
      task: {
        timeline: [
          {
            id: 7,
            type: "quality",
            occurredAt: at,
            actor: { kind: "agent", backend: "claude", name: "Fact Checker", role: "Fact Checker" },
            title: "Approval noted, waiting on Fact Checker",
            text: "Site Reviewer approved.",
            toAgent: false,
            evidence: null,
            attachments: null,
          },
        ],
      },
    });
    const event = container.querySelector(".tl-item")!;
    await waitFor(() => expect(event.hasAttribute("data-targeted")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(event));
  });
});

/**
 * Ruling 547: a decision's link names its packet (`#decision-<id>`), and the
 * page opens the card only for that packet. A link to a place the page no
 * longer shows (a decision answered or withdrawn, recommendations applied or
 * dismissed) lands on the timeline, where what became of it is recorded,
 * marked and focused; it used to move nothing, and hand the focus back to the
 * bell (live on AWSC-2, 2026-09-28).
 */
describe("ruling 547: a region link lands where the page still shows it", () => {
  const OPEN = {
    id: "pkt_open",
    type: "input" as const,
    kind: "Agent question",
    from: "Workflow Researcher",
    title: "Approve the Mapping-stage hours and pricing baseline?",
    body: "",
    observations: [],
    options: [{ kind: "custom" as const, t: "Adopt proposed policy", d: "", rec: true }],
  };

  // CANARY: drop the timeline from `regionPlace` and the four rows after the
  // first mark nothing, which is what a click on them did before.
  it.each([
    ["the packet it names", "/#decision-pkt_open", OPEN, ".detail-packet"],
    // CANARY: open the card for any link that names a packet and a row about
    // an answered question rings the next one.
    ["the timeline, for a packet closed since", "/#decision-pkt_gone", OPEN, "#timeline"],
    ["the timeline, with no packet open", "/#decision-pkt_gone", null, "#timeline"],
    ["the timeline, for a row written before ruling 547", "/#decision", null, "#timeline"],
    ["the timeline, with no recommendation pending", "/#recommendations", null, "#timeline"],
  ])("%s", async (_place, entry, packet, landsOn) => {
    const { container } = renderPage({ entry, task: { packet } });
    const place = container.querySelector(landsOn)!;
    await waitFor(() => expect(place.hasAttribute("data-targeted")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(place));
    expect(container.querySelectorAll("[data-targeted]")).toHaveLength(1);
  });
});

describe("U7 / U35-2: the task detail's reading order matches its stacking rule", () => {
  it("puts the title and the open packet first, current state next, the timeline last in the DOM", () => {
    const { container } = renderPage({
      task: {
        packet: {
          type: "blocked",
          kind: "Blocked decision",
          from: "Operator",
          title: "Which spec wins?",
          body: "The goal and the merged spec disagree.",
          observations: [],
          options: [
            { kind: "edit_goal", t: "Align the goal", d: "", rec: true },
            { kind: "redirect", t: "Redirect", d: "", rec: false },
          ],
        },
      },
    });
    const detail = container.querySelector(".detail")!;
    const regions = Array.from(detail.children)
      .map((el) => el.className)
      .filter((c) => c.startsWith("detail-"));
    expect(regions).toEqual(["detail-head", "detail-packet", "detail-side", "detail-main"]);

    const head = detail.querySelector(".detail-head")!;
    const packetRegion = detail.querySelector(".detail-packet")!;
    const side = detail.querySelector(".detail-side")!;
    const main = detail.querySelector(".detail-main")!;
    // The head carries the task's name; the packet region carries the decision
    // it asks for — and nothing else, so the grid can place it alone.
    expect(head.querySelector(".task-hero h1")?.textContent).toBe("Compress long-running task timelines");
    expect(head.querySelector(".packet")).toBeNull();
    expect(packetRegion.querySelector(".packet")).not.toBeNull();
    expect(packetRegion.children).toHaveLength(1);
    expect(packetRegion.textContent).toContain("Which spec wins?");
    expect(main.querySelector(".packet")).toBeNull();
    // …the head precedes the packet, the packet precedes the side rail, and
    // the side rail precedes the main column.
    expect(head.compareDocumentPosition(packetRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(packetRegion.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(side.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The consequential action really is in the region that comes second…
    expect(side.textContent).toContain("Accept completion → Done");
    expect(main.textContent).not.toContain("Accept completion → Done");
    // …the GitHub trace leads it (ruling 170: top right, beside the goal) and
    // Current state comes second, so the desktop paint and the DOM agree…
    expect(side.children[0].textContent).toMatch(/GitHub|no PR|PR #/);
    expect(side.children[0].textContent).not.toContain("Accept completion → Done");
    expect(side.children[1].textContent).toContain("Accept completion → Done");
    // …and the timeline really is in the region that follows both.
    expect(main.querySelector(".tl-list, .timeline, .tl-wrap")).not.toBeNull();
  });
});

/**
 * C3 (pass 34, U34-8): the collision confirm describes the branch it is
 * actually about, and both remote-branch ceremonies warn about the refusal
 * `deleteTaskRemoteBranch` will hand back. Live: JC-6 at 10:33:06Z and JC-3 at
 * 11:47:48Z were both confirmed and both refused, with the dialog promising
 * the deletion of a stranger's branch.
 */
describe("C3: the collision confirm describes the right branch, and warns before the refusal", () => {
  const collisionPacket: PacketRender = {
    type: "blocked",
    kind: "blocked decision",
    from: "Operator",
    title: "The remote vib-151 is not this task's work",
    body: "The push was refused.",
    observations: [],
    options: [
      {
        kind: "resolve_remote_collision",
        t: "Delete the stale remote branch, then redeliver",
        d: "Reclaims the branch name for this task.",
        rec: true,
      },
    ],
  };
  const dialogText = (container: HTMLElement) =>
    container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet collision dialog"]',
    )!.textContent!;

  it("with NO unowned PR it describes THIS task's own remote branch, never a stranger", () => {
    // Canary: restore the single shape — the person is told they are deleting
    // "the unrelated one squatting on this task's branch name", which is their
    // own pushed branch.
    const { container } = renderPage({ task: { packet: collisionPacket, unownedPr: null } });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = dialogText(container);
    expect(text).toContain("This task’s own remote branch");
    expect(text).toContain("vib-151");
    expect(text).toContain("No unrelated pull request is recorded on it");
    expect(text).not.toContain("squatting");
    expect(text).not.toContain("stale branch");
    expect(text).toContain("cannot be undone");
    expect(text).toContain("local delivery");
    expect(findButton(container, "Delete branch & redeliver")).toBeTruthy();
  });

  it("with an unowned PR it still names the stranger and closes its PR", () => {
    // Canary: make the no-collision branch unconditional.
    const { container } = renderPage({ task: { packet: collisionPacket, unownedPr: 232 } });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = dialogText(container);
    expect(text).toContain("squatting");
    expect(text).toContain("#232");
    expect(findButton(container, "Clear collision & redeliver")).toBeTruthy();
  });

  it("an OPEN pull request of this task's own says what the ceremony really does, read off the task", () => {
    // Canary: hardcode `openPr: null` in the page's archiveDisclosure literal
    // (or drop the row) — the person is told nothing about the PR the
    // ceremony is actually about.
    // Pass 34 review: the row used to promise a refusal, which ruling 136(b)
    // replaced with a real delivery to that same PR.
    const { container } = renderPage({
      task: {
        packet: collisionPacket,
        unownedPr: null,
        foreignHead: null,
        pr: { number: 77, state: "review", title: "VIB-151 work" },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const text = dialogText(container);
    expect(text).toContain("#77");
    expect(text).toContain("this task’s OWN review pull request");
    expect(text).toContain("pushes this task’s delivered revision");
    expect(text).not.toContain("confirming now is refused and nothing changes");
  });

  it("a MERGED pull request is no refusal, so no warning is shown", () => {
    const { container } = renderPage({
      task: {
        packet: collisionPacket,
        unownedPr: null,
        foreignHead: null,
        pr: { number: 77, state: "merged", title: "VIB-151 work" },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    expect(dialogText(container)).not.toContain("never deletes a branch a pull request is open on");
  });
});

/**
 * Pass 34 review: the archive dialog's open-PR row used to promise "confirming
 * now is refused and nothing changes" while the archive always runs — only the
 * branch deletion is refused.
 */
describe("C3: the archive dialog's open-PR row tells the truth about what still happens", () => {
  const archivePacket: PacketRender = {
    type: "blocked",
    kind: "blocked decision",
    from: "Operator",
    title: "The PR was closed without merging",
    body: "",
    observations: [],
    options: [
      {
        kind: "archive_task",
        t: "Archive the task and delete its branch",
        d: "The work is abandoned.",
        rec: true,
        deleteBranch: true,
      },
    ],
  };

  it("says the task is still archived and only the branch is kept", () => {
    // Canary: use one sentence for both ceremonies again — the archive dialog
    // then claims nothing changes, and the task is archived anyway.
    const { container } = renderPage({
      task: {
        packet: archivePacket,
        branch: "vib-151",
        pr: { number: 91, state: "review", title: "VIB-151 work" },
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Packet archive dialog"]',
    )!;
    expect(dialog.textContent).toContain("#91");
    expect(dialog.textContent).toContain("The task is still archived");
    expect(dialog.textContent).not.toContain("confirming now is refused and nothing changes");
  });
});

/**
 * Ruling 368: the card whose request is in flight shows it on the button that
 * started it — the loader spinning where the glyph was, a label naming the
 * work — while the sibling control only waits. The accept confirm has closed
 * by then, and a card that merely dimmed read as refused. Canary: pass
 * `inFlight={null}` from the page and the busy label never appears.
 */
describe("ruling 368: a recommendation's request in flight", () => {
  const card = (kind: RecommendationView["kind"]): RecommendationView => {
    const rec: RecommendationView = {
      id: "rec-1",
      kind,
      label: kind === "accept_completion" ? "Accept completion and move VIB-151 to Done" : "Run the Developer",
      detail: "The review is clean.",
    };
    if (kind === "run_agent") {
      rec.profileId = "developer";
      rec.prompt = "Build it.";
    }
    return rec;
  };

  it("an accepted recommendation's Apply reads 'Accepting…' with the spinner until the server answers", async () => {
    const held = heldAction();
    const { container, submitted } = renderPage({
      myRole: "admin",
      task: { pr: { number: 147, state: "review", title: "[VIB-151] Compress timelines" } },
      recommendations: [card("accept_completion")],
      held,
    });
    const apply = findButton(container, "Apply")!;
    // Ruling 459: the check and the loader share one cell (GlyphSwap) and
    // trade on `data-copied`; at rest the check shows.
    const cell = apply.querySelector(".copy-glyph")!;
    expect(cell.hasAttribute("data-copied")).toBe(false);
    fireEvent.click(apply);
    fireEvent.click(findButton(container, "Apply → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const busy = findButton(container, "Accepting…")!;
    await waitFor(() => expect(busy.getAttribute("aria-busy")).toBe("true"));
    expect(busy.disabled).toBe(true);
    // The same button and cell: the spinning loader traded in for the check.
    expect(busy).toBe(apply);
    expect(cell.getAttribute("data-copied")).toBe("true");
    expect(cell.lastElementChild!.matches("svg.ico.spin")).toBe(true);
    expect(busy.getAttribute("title")).toBe("Accepting the completion; the merge follows when GitHub is reachable");
    // The sibling waits without claiming to be the one working.
    const dismiss = findButton(container, "Dismiss")!;
    expect(dismiss.disabled).toBe(true);
    expect(dismiss.getAttribute("aria-busy")).not.toBe("true");
    expect(dismiss.querySelector("svg.ico.spin")).toBeNull();

    await act(async () => {
      held.answer();
    });
    await waitFor(() => expect(findButton(container, "Apply")!.getAttribute("aria-busy")).not.toBe("true"));
    expect(findButton(container, "Accepting…")).toBeUndefined();
    expect(findButton(container, "Apply")!.querySelector(".copy-glyph")!.hasAttribute("data-copied")).toBe(false);
  });

  it("a plain recommendation reads 'Applying…', and a dismissal 'Dismissing…' on its own button", async () => {
    const held = heldAction();
    const { container, submitted } = renderPage({
      myRole: "admin",
      recommendations: [card("run_agent")],
      held,
    });
    fireEvent.click(findButton(container, "Apply")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    await waitFor(() => expect(findButton(container, "Applying…")!.getAttribute("aria-busy")).toBe("true"));
    await act(async () => {
      held.answer();
    });
    await waitFor(() => expect(findButton(container, "Applying…")).toBeUndefined());

    const held2 = heldAction();
    const second = renderPage({ myRole: "admin", recommendations: [card("run_agent")], held: held2 });
    fireEvent.click(findButton(second.container, "Dismiss")!);
    // D6: the dismissal confirms first.
    fireEvent.click(second.getByText("Dismiss recommendation"));
    await waitFor(() => expect(second.submitted).toHaveLength(1));
    const dismissing = findButton(second.container, "Dismissing…")!;
    await waitFor(() => expect(dismissing.getAttribute("aria-busy")).toBe("true"));
    expect(dismissing.querySelector("svg.ico.spin")).not.toBeNull();
    expect(findButton(second.container, "Apply")!.getAttribute("aria-busy")).not.toBe("true");
    await act(async () => {
      held2.answer();
    });
  });
});

/**
 * Ruling 368 across the task page: each request shows itself on the button that
 * started it, read off its own fetcher, and a control that merely waits claims
 * nothing. These go through the real fetchers and the page's own wiring.
 */
describe("ruling 368: the task page's requests in flight", () => {
  it("a Schedule click reads Scheduling…, not Running…", async () => {
    // Canary: map every run-operator request to "run" in task-main-sections.tsx
    // (`runKind`) and this reads Starting… for a schedule, as it read Running….
    const held = heldAction();
    const { container, submitted, getByLabelText } = renderPage({ myRole: "admin", held });
    fireEvent.change(getByLabelText("When the operator run starts"), {
      target: { value: "5" },
    });
    fireEvent.click(findButton(container, "Schedule")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("schedule-action");
    const busy = findButton(container, "Scheduling…")!;
    await waitFor(() => expect(busy.getAttribute("aria-busy")).toBe("true"));
    expect(busy.disabled).toBe(true);
    expect(busy.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    expect(findButton(container, "Running…")).toBeUndefined();
    await act(async () => {
      held.answer();
    });
  });

  it("an archive reads Archiving…, and Accept waits without reading Accepting…", async () => {
    // Canary: fold `dispositionBusy` back into the Accept label in
    // task-side-panels.tsx, which is what made it read "Accepting · merging…".
    const held = heldAction();
    const { container, submitted } = renderPage({ myRole: "admin", held });
    fireEvent.click(findButton(container, "Archive task")!);
    fireEvent.click(findButton(container, "Archive VIB-151")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const archiving = findButton(container, "Archiving…")!;
    await waitFor(() => expect(archiving.getAttribute("aria-busy")).toBe("true"));
    expect(archiving.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    const accept = findButton(container, "Accept completion → Done")!;
    expect(accept.disabled).toBe(true);
    expect(accept.hasAttribute("aria-busy")).toBe(false);
    expect(findButton(container, "Accepting")).toBeUndefined();
    await act(async () => {
      held.answer();
    });
  });

  it("an acceptance reads Accepting… on Accept", async () => {
    const held = heldAction();
    const { container, submitted } = renderPage({ myRole: "admin", held });
    fireEvent.click(findButton(container, "Accept completion → Done")!);
    fireEvent.click(findButton(container, "Accept → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const accepting = findButton(container, "Accepting…")!;
    await waitFor(() => expect(accepting.getAttribute("aria-busy")).toBe("true"));
    expect(accepting.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    // Archive only waits.
    expect(findButton(container, "Archive task")!.hasAttribute("aria-busy")).toBe(false);
    await act(async () => {
      held.answer();
    });
  });

  it("a details save reads Saving… on the property that started it, busy, the loader spinning", async () => {
    // Ruling 501: a Details property is its own control, so its trigger is
    // the button that started the save. Canary: drop `aria-busy` from the
    // property trigger in task-details-panel.tsx.
    const held = heldAction();
    const { container, submitted } = renderPage({ myRole: "admin", held });
    const priority = container.querySelector<HTMLButtonElement>('[data-prop="priority"] .prop-btn')!;
    fireEvent.click(priority);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[role="menu"] [data-priority="high"]')!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    await waitFor(() => expect(priority.getAttribute("aria-busy")).toBe("true"));
    expect(priority.textContent).toBe("Saving…");
    expect(priority.querySelector("svg.ico.spin")).not.toBeNull();
    // Its siblings only wait: nothing else claims the work.
    const labels = container.querySelector<HTMLButtonElement>('[data-prop="labels"] .prop-btn')!;
    expect(labels.hasAttribute("aria-busy")).toBe(false);
    await act(async () => {
      held.answer();
    });
  });

  it("a merge reads Merging… on Complete merge", async () => {
    const held = heldAction();
    const { container, submitted } = renderPage({
      myRole: "admin",
      task: { pr: { number: 147, state: "accepted", title: "[VIB-151] Compress timelines" } },
      held,
    });
    fireEvent.click(findButton(container, "Complete merge")!);
    fireEvent.click(findButton(container, "Merge PR #147")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const merging = findButton(container, "Merging…")!;
    await waitFor(() => expect(merging.getAttribute("aria-busy")).toBe("true"));
    expect(merging.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    await act(async () => {
      held.answer();
    });
  });
});
