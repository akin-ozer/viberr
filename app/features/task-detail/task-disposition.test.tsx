// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, createRoutesStub } from "react-router";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
} from "./execution-profile";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
import { AcceptConfirm } from "./accept-confirm";
import { DecisionPacket } from "./decision-packet";
import type { RecommendationView } from "./operator-recommendations";
import { TaskDetailPage } from "./task-detail-page";
import { ScheduledActions } from "./task-main-sections";

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

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "in_review",
    displayReadiness: "in_review",
    waiting: "human",
    urgent: false,
    validation: "healthy",
    blockReason: null,
    owner: { kind: "human", userId: "u-selin", name: "Selin Aksoy", initials: "SA", tone: "" },
    specialist: null,
    reviewers: [],
    operator: null,
    branch: "vib-151",
    repo: "akin-ozer/viberr",
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    changed: null,
    goal: "Keep the timeline readable on long tasks.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
    timeline: [],
    diagnostics: [],
    stages: STAGES,
    ...patch,
  } as unknown as TaskDetail;
}

const ACCEPTANCE: AcceptanceAffordance = {
  hasAuthority: true,
  atBoundary: true,
  blockedReason: null,
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
}) {
  const submitted: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailPage
            task={detail(props.task ?? {})}
            runtime={[]}
            deployedSpecialists={[]}
            operatorBackend="claude"
            backendAvailable={{ claude: true, codex: true }}
            deliveringActive={false}
            activeReviewerIds={[]}
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
            schedules={[]}
            archived={props.archived ?? false}
            acceptance={{ ...ACCEPTANCE, ...(props.acceptance ?? {}) }}
            githubHost="https://github.com"
            workRevisionSha={props.workRevisionSha ?? null}
            canDeliver={props.canDeliver ?? false}
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        const row: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (typeof v === "string") row[k] = v;
        submitted.push(row);
        return { ok: true, intent: row.intent, toast: "done" };
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/"]} />);
  return { ...utils, submitted };
}

const findButton = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

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
        pr: { number: 117, state: "review", title: "[VIB-151] x" } as TaskDetail["pr"],
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

  it("a contributor who OWNS the task gets it — R6-2/R14-2, not just maintainers", () => {
    // The live case: the queue counted this viewer, the page offered nothing.
    const { container } = renderPage({
      myRole: "contributor",
      meId: "u-selin",
    });
    expect(findButton(container, "Accept completion → Done")).toBeDefined();
  });

  it("blocked acceptance renders disabled WITH the server's reason in text", () => {
    const { container, getByText } = renderPage({
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
    expect(getByText(/closed on GitHub without merging/)).toBeTruthy();
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
    const { container, getByText } = renderPage({
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason: "VIB-151's delivered revision has no approving verdict yet",
      },
    });
    expect(findButton(container, "Accept completion")).toBeUndefined();
    expect(getByText(/no approving verdict yet/)).toBeTruthy();
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
        pr: { number: 124, state: "closed", title: "[VIB-151] x" } as TaskDetail["pr"],
        packet: {
          type: "input",
          kind: "Decision required",
          from: "Operator",
          title: "PR #124 closed without merging — choose recovery path",
          body: "Rework and reopen, or archive the task.",
          observations: [],
          options: [
            { kind: "custom", title: "Rework and reopen the PR", detail: "", rec: true },
            { kind: "archive_task", title: "Archive the task", detail: "" },
          ],
        } as unknown as TaskDetail["packet"],
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

  it("F15-11: an ARCHIVED task renders no Accept control, no schedule form, and disabled run controls", () => {
    const { container, queryByText } = renderPage({
      archived: true,
      task: { archived: true } as Partial<TaskDetail>,
      acceptance: { atBoundary: true, canAccept: true },
    });
    // Fails on main: the Accept button and the schedule form stayed live.
    expect(findButton(container, "Accept completion")).toBeUndefined();
    expect(queryByText("Schedule operator re-run")).toBeNull();
    const runOperator = findButton(container, "Run operator");
    expect(runOperator?.disabled).toBe(true);
  });
});

describe("R15-2 safety net (b): the manual delivery control", () => {
  it("renders for a viewer with delivery authority when no live PR stands, and submits deliver-review", async () => {
    const { container, submitted, getByText } = renderPage({ canDeliver: true });
    const btn = findButton(container, "Deliver branch & open PR");
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("deliver-review");
    expect(getByText).toBeTruthy();
  });

  it("hides once a live PR stands, and entirely without delivery authority", () => {
    const withPr = renderPage({
      canDeliver: true,
      task: { pr: { number: 9, state: "review", title: "x" } as TaskDetail["pr"] },
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

describe("P14-GV-04: the Permissions panel tells the owner the truth", () => {
  it("names the owner's acceptance authority instead of 'maintainer or admin only'", () => {
    const { container, getByText } = renderPage({
      myRole: "contributor",
      meId: "u-selin",
    });
    expect(getByText("You own this task — you can accept it → Done")).toBeTruthy();
    // The row used to read "Maintainer or admin only" while the server let this
    // very user accept — the "Run agents" row below it still says that, and for
    // a contributor it is true.
    const acceptRow = [...container.querySelectorAll(".policy-line")].find((r) =>
      r.textContent?.startsWith("Accept completion"),
    )!;
    expect(acceptRow.textContent).not.toContain("Maintainer or admin only");
  });

  it("still refuses a contributor who does NOT own it", () => {
    const { getByText } = renderPage({
      myRole: "contributor",
      meId: "u-baris",
    });
    expect(getByText("Maintainer, admin, or the task's own owner")).toBeTruthy();
  });

  it("E1: the Comments row states membership, not 'Every registered user'", () => {
    // Verified live this pass: a signed-in NON-member gets 404 on this page and
    // on the comment POST. The row was a hardcoded string promising the
    // opposite, on the one panel whose entire job is stating what the server
    // enforces. Canary: restore the literal and this fails on both assertions.
    const { container } = renderPage({ myRole: "viewer", meId: "u-elif" });
    const commentRow = [...container.querySelectorAll(".policy-line")].find((r) =>
      r.textContent?.startsWith("Comments"),
    )!;
    expect(commentRow.textContent).not.toContain("Every registered user");
    // A viewer IS a member and holds `comment`, so it reads as permitted…
    expect(commentRow.textContent).toContain("every project member");
  });

  it("E3: the ownership row reads the release-any grant, not a hardcoded admin literal", () => {
    const asAdmin = renderPage({ myRole: "admin", meId: "u-arda" });
    const adminRow = [...asAdmin.container.querySelectorAll(".policy-line")].find(
      (r) => r.textContent?.startsWith("Task ownership"),
    )!;
    expect(adminRow.textContent).toContain("you can release anyone");
    cleanup();
    const asMaintainer = renderPage({ myRole: "maintainer", meId: "u-murat" });
    const maintRow = [
      ...asMaintainer.container.querySelectorAll(".policy-line"),
    ].find((r) => r.textContent?.startsWith("Task ownership"))!;
    expect(maintRow.textContent).toContain("your own seat");
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

const PR_147 = {
  number: 147,
  state: "review",
  title: "[VIB-151] Compress long-running task timelines",
} as TaskDetail["pr"];

/**
 * F19-3 — live-reproduced on VC-1: applying the operator's `accept_completion`
 * recommendation merged PR #147 and moved the task to Done from ONE click on
 * "Apply", with no dialog anywhere in the path. Ruling 20 (R15-1) requires
 * EVERY acceptance to state what merges first; ruling 53 extended it to the
 * board drag and the keyboard Move menu. The recommendation card was the entry
 * point nobody counted.
 */
describe("F19-3: applying an accept_completion recommendation asks first", () => {
  const ACCEPT_REC: RecommendationView = {
    id: "r1",
    kind: "accept_completion",
    label: "Accept the completion and close it",
    detail: "The delivering agent's revision is approved.",
  };

  it("opens the shared confirm naming the PR, revision and target — nothing submits until it is confirmed", async () => {
    const { container, submitted } = renderPage({
      task: { pr: PR_147 },
      workRevisionSha: "abcdef1234567890",
      recommendations: [ACCEPT_REC],
    });
    fireEvent.click(findButton(container, "Apply")!);
    // Canary: call `onApply(rec.id)` unconditionally in `onApplyClick` and this
    // is where it fails — the merge posts on the first click, as it did live.
    await settle();
    expect(submitted).toHaveLength(0);
    const dialog = acceptDialog(container);
    expect(dialog).toBeTruthy();
    // The SAME facts the Accept button's confirm states — one component, one
    // disclosure object.
    expect(dialog!.textContent).toContain("PR #147 · in review");
    expect(dialog!.textContent).toContain("main");
    expect(dialog!.textContent).toContain("abcdef123456");
    // …plus the control the human actually pressed, which said only "Apply".
    expect(dialog!.textContent).toContain("Accept the completion and close it");
    fireEvent.click(findButton(container, "Accept → Done & merge")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("apply-recommendation");
    expect(submitted[0]!.recId).toBe("r1");
  });

  it("a non-acceptance recommendation still applies in one click", async () => {
    // The dialog belongs to the writer that merges, not to the panel: an
    // assign/transition recommendation must not grow a merge confirm.
    const { container, submitted } = renderPage({
      recommendations: [
        {
          id: "r2",
          kind: "transition",
          toStageId: "review",
          label: "Move to Review",
          detail: "",
        },
      ],
    });
    fireEvent.click(findButton(container, "Apply")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("apply-recommendation");
    expect(acceptDialog(container)).toBeNull();
  });
});

/**
 * F19-7 — resolving a packet option whose kind is `accept_completion` merges
 * the review PR from the card's generic "Confirm decision" button. There IS a
 * select-then-confirm step, but it discloses nothing: no PR number, no
 * delivered revision, no verdict, no merge target, no "merging is one-way",
 * and no "Not yet".
 */
describe("F19-7: a packet accept_completion option discloses the merge", () => {
  const acceptPacket = (
    options: Array<{ kind: string; t: string; d: string; rec?: boolean }>,
  ) =>
    ({
      type: "input",
      kind: "input required",
      from: "Operator",
      title: "VIB-151 is ready to accept",
      body: "The delivered revision carries an approving verdict.",
      observations: [],
      options,
    }) as unknown as TaskDetail["packet"];

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
 * F19-10 — "Complete merge" fronts `completeTaskMerge`, whose
 * `requireAcceptCompletion` carries the R6-2 owner exception, but the UI gate
 * asked for `accept-completion` (admin|maintainer). A contributor-owner who had
 * just accepted their own task was shown "accepted · merge pending" with no way
 * to finish it.
 */
describe("F19-10: Complete merge follows the server's authority", () => {
  const MERGE_PENDING = {
    pr: { number: 147, state: "accepted", title: "[VIB-151] x" } as TaskDetail["pr"],
  };

  it("renders for the contributor-owner the server authorizes, and submits complete-merge", async () => {
    const { container, submitted } = renderPage({
      myRole: "contributor",
      meId: "u-selin",
      task: MERGE_PENDING,
      // The task is already at the terminal stage, so `hasAuthority` is all the
      // affordance resolves to — exactly what the server re-checks.
      acceptance: { hasAuthority: true, atBoundary: false, canAccept: false },
    });
    const btn = findButton(container, "Complete merge");
    // Canary: restore `roleCan(myRole, "accept-completion")` as the gate and
    // this is undefined — contributor holds no such row in ACTION_ROLES.
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("complete-merge");
  });

  it("stays hidden when the viewer holds no acceptance authority", () => {
    const { container } = renderPage({
      myRole: "viewer",
      meId: "u-elif",
      task: MERGE_PENDING,
      acceptance: { hasAuthority: false, atBoundary: false, canAccept: false },
    });
    expect(findButton(container, "Complete merge")).toBeUndefined();
  });
});

/**
 * F19-14 — the accept dialog printed the raw `pr.state` enum member in a
 * hardcoded neutral pill, so it said "review" where every sibling surface says
 * "in review", and drew a CLOSED, unmerged PR as grey chrome inside the dialog
 * whose button merges it.
 */
describe("F19-14: the accept dialog speaks the product's PR vocabulary", () => {
  const renderConfirm = (state: string) =>
    render(
      <AcceptConfirm
        disclosure={{
          task: detail({
            pr: { number: 147, state, title: "[VIB-151] x" } as TaskDetail["pr"],
          }),
          workRevisionSha: "abcdef1234567890",
          noChanges: false,
          defaultBranch: "main",
        }}
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
        pr: { number: 124, state: "closed", title: "[VIB-151] x" } as TaskDetail["pr"],
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
 * F19-22 — the Current-state Stage dropdown, moved to the terminal stage.
 *
 * On the server a human's manual move into the terminal stage IS an acceptance:
 * `transitionStage` hands it straight to `acceptCompletion`, which merges the
 * PR. So this menu item has always merged — from the same control that performs
 * an ordinary stage change for every other row, with no dialog and no mention
 * of a merge. Ruling 53 fixed precisely this on the board's Move menu; the task
 * page's own dropdown was the one left, and it is the closest control to the
 * acceptance the dialog exists to disclose.
 */
describe("F19-22: moving to the terminal stage from the dropdown asks first", () => {
  const openStageMenu = (container: HTMLElement) => {
    const trigger = container.querySelector(
      "button.stage-menu-btn",
    ) as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger!);
  };
  /** The menu is portaled to document.body, so it is not under `container`. */
  const stageItem = (container: HTMLElement, name: string) =>
    Array.from(
      container.ownerDocument.querySelectorAll(".stage-menu-pop .sm-item"),
    ).find((b) => b.textContent?.trim().startsWith(name)) as
      | HTMLButtonElement
      | undefined;

  it("opens the acceptance confirm instead of posting a bare transition", async () => {
    const { container, submitted } = renderPage({
      task: { pr: PR_147, stage: "review" },
      workRevisionSha: "abcdef1234567890",
    });
    openStageMenu(container);
    fireEvent.click(stageItem(container, "Done")!);
    // Canary: drop the terminal branch in `onTransition` and this fails — the
    // move posts `intent: "transition"`, which merges server-side.
    await settle();
    expect(submitted).toHaveLength(0);
    const dialog = acceptDialog(container);
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("PR #147 · in review");
    expect(dialog!.textContent).toContain("abcdef123456");
    // It names itself as the stage move it is, not as a stray modal.
    expect(dialog!.textContent).toContain("acceptance, not a plain stage change");
    fireEvent.click(findButton(container, "Accept → Done & merge")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("accept-completion");
  });

  it("a NON-terminal stage still moves in one click", async () => {
    // The confirm belongs to the acceptance, not to the menu: every other row
    // must keep posting a plain transition.
    const { container, submitted } = renderPage({
      task: { pr: PR_147, stage: "triage" },
    });
    openStageMenu(container);
    fireEvent.click(stageItem(container, "Review")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("transition");
    expect(submitted[0]!.to).toBe("review");
    expect(acceptDialog(container)).toBeNull();
  });
});

/**
 * UX19-2 — live on VC-1 at In Progress, two panels one above the other said
 * opposite things about the same task. The GitHub trace read `task.blockReason`
 * ("no approving verdict yet — run a review for a verdict, or an admin can
 * force-accept") and offered the override; the Current-state panel beside it
 * read the acceptance affordance ("VC-1 is at In Progress, not Review …").
 * Both came from the server — `blockReason` carries only the REVISION dimension
 * of the gate by design, and this panel never applied the stage filter its
 * producer assumed consumers would. Running a review would not have unblocked
 * anything: the task had stages left to cross.
 */
describe("UX19-2: the two acceptance panels name one gate", () => {
  const OFF_BOUNDARY =
    "VIB-151 is at In Progress, not Review — a completion can only be accepted from the boundary the workflow puts before Done. Move the task through the workflow first.";

  it("off the boundary, the GitHub panel offers no override and states no second reason", () => {
    const { container } = renderPage({
      task: { pr: PR_147, blockReason: "No approving verdict yet." },
      acceptance: {
        atBoundary: false,
        canAccept: false,
        blockedReason: OFF_BOUNDARY,
      },
    });
    // Canary: restore `task.blockReason` as the panel's source and this fails —
    // the verdict sentence reappears beside the stage one.
    expect(container.textContent).not.toContain("No approving verdict yet.");
    expect(
      findButton(container, "Force accept (override review gate)"),
    ).toBeUndefined();
    // …and the refusal is still SAID, once, by the panel that owns it (F15-19).
    expect(container.textContent).toContain("not Review");
  });

  it("at the boundary, a genuine wedge still gets the DG-2 override", () => {
    const { container } = renderPage({
      task: { pr: PR_147 },
      acceptance: {
        atBoundary: true,
        canAccept: false,
        blockedReason: "No approving verdict yet.",
      },
    });
    expect(
      findButton(container, "Force accept (override review gate)"),
    ).toBeDefined();
  });

  it("R16-3: a closed PR is terminal, so the override is withheld at the boundary too", () => {
    const { container } = renderPage({
      task: { pr: { ...PR_147, state: "closed" } as TaskDetail["pr"] },
      acceptance: {
        atBoundary: true,
        canAccept: false,
        terminallyBlocked: true,
        blockedReason:
          "PR #147 was closed on GitHub without merging — VIB-151 cannot be accepted.",
      },
    });
    expect(
      findButton(container, "Force accept (override review gate)"),
    ).toBeUndefined();
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
  };

  const archivePacket = (deleteBranch: boolean) =>
    ({
      type: "blocked",
      kind: "blocked decision",
      from: "Operator",
      title: "PR #147 was closed without merging — pick a recovery path",
      body: "The pull request was closed on GitHub without merging.",
      observations: [],
      options: [
        {
          kind: "archive_task",
          t: deleteBranch
            ? "Archive and delete the branch"
            : "Archive the task",
          d: "Discards the rejected work entirely.",
          rec: true,
          ...(deleteBranch ? { deleteBranch: true } : {}),
        },
      ],
    }) as unknown as TaskDetail["packet"];

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
              packet={archivePacket(deleteBranch)!}
              busy={false}
              canResolve
              canResolveCompletion
              canEditGoal
              canArchive
              {...(disclosure ? { archiveDisclosure: disclosure } : {})}
              onResolve={onResolve}
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
          ...archivePacket(true)!,
          options: [
            {
              kind: "custom",
              t: "Rework and reopen the PR",
              d: "Send it back to the delivering agent.",
              rec: true,
            },
          ],
        } as unknown as TaskDetail["packet"],
      },
    });
    fireEvent.click(findButton(container, "Confirm decision")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(archiveDialog(container)).toBeNull();
  });
});

/**
 * UX19-10 — "Scheduled re-runs" listed both backends unconditionally and
 * defaulted to Claude Code, while `OperatorRunControl` one panel down disables
 * an unconfigured backend, labels it "— not configured" and re-defaults away
 * from it. On a Codex-only instance the two operator pickers on one screen
 * therefore defaulted to DIFFERENT backends, and the schedule form's default
 * was the one that cannot run: the failure was the path of least resistance,
 * not a misclick. A schedule fires unattended, so the refusal `selectAdapter`
 * would issue at run time arrives hours later as a blocked packet a human has
 * to clear.
 */
describe("UX19-10: the schedule picker honours backend availability", () => {
  const renderSchedule = (backendAvailable: {
    claude: boolean;
    codex: boolean;
  }) => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <ScheduledActions
              schedules={[]}
              canRunAgents
              taskClosed={false}
              backendAvailable={backendAvailable}
            />
          </ToastProvider>
        ),
        action: async () => ({ ok: true }),
      },
    ]);
    return render(<Stub initialEntries={["/"]} />);
  };

  const backendSelect = (container: HTMLElement) =>
    container.querySelector<HTMLSelectElement>(
      '[data-testid="scheduled-actions"] select[name="backend"]',
    )!;

  it("disables the unconfigured backend and says why", () => {
    const { container } = renderSchedule({ claude: true, codex: false });
    const options = [...backendSelect(container).options];
    const codex = options.find((o) => o.value === "codex")!;
    // Canary: drop `disabled`/the suffix and this fails — the picker offers a
    // backend the deployment has no credential for.
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain("not configured");
    expect(options.find((o) => o.value === "claude")!.disabled).toBe(false);
  });

  it("defaults to a configured backend instead of a hardcoded Claude Code", () => {
    const { container } = renderSchedule({ claude: false, codex: true });
    // The exact fallback `OperatorRunControl` applies (P11-41), so the two
    // pickers on one screen no longer disagree about what will run.
    expect(backendSelect(container).value).toBe("codex");
  });

  it("leaves both live when both are configured", () => {
    const { container } = renderSchedule({ claude: true, codex: true });
    const options = [...backendSelect(container).options];
    expect(options.every((o) => !o.disabled)).toBe(true);
    expect(backendSelect(container).value).toBe("claude");
  });
});

/* ------------------------------------------- execution profile · pass-19 UX */

/**
 * The Execution profile panel, rendered on its own. These four blocks are about
 * the cell's own vocabulary, disclosure and keyboard contract — none of which
 * the page-level fixture above can express (it carries no engagements).
 */

const EXEC_MEMBERS = [
  { userId: "u-arda", role: "admin", user: { name: "Arda Kaya", initials: "AK", tone: "" } },
  { userId: "u-selin", role: "contributor", user: { name: "Selin Aksoy", initials: "SA", tone: "" } },
];

/** An engagement as the task file stores it — profileId, backend, role. */
const engagement = (
  profileId: string,
  role: string,
  backend: "claude" | "codex" = "claude",
) =>
  ({
    kind: "agent",
    profileId,
    backend,
    role,
    name: backend === "claude" ? "Claude Code" : "Codex",
  }) as unknown as NonNullable<TaskDetail["specialist"]>;

/** A deployed profile as the loader ships it. */
const deployedAgent = (
  id: string,
  name: string,
  role: string,
  verdict: boolean,
): DeployedSpecialistView => ({
  id,
  name,
  role,
  backend: "claude",
  model: "claude-sonnet",
  capabilities: { delivery: true, verdict, askHuman: true },
});

function renderExec(opts: {
  task?: Partial<TaskDetail>;
  deployedSpecialists?: DeployedSpecialistView[];
} = {}) {
  const calls = {
    owner: [] as string[],
    assignSpecialist: [] as string[],
    runSpecialist: [] as string[],
    assignReviewer: [] as string[],
    runReviewer: [] as string[],
    removeReviewer: [] as string[],
  };
  const utils = render(
    <MemoryRouter>
      <ExecutionProfile
        task={detail(opts.task ?? {})}
        meId="u-arda"
        myRole="admin"
        members={EXEC_MEMBERS}
        busy={false}
        onOwner={(action) => calls.owner.push(action)}
        onRelease={() => calls.owner.push("release")}
        deployedSpecialists={opts.deployedSpecialists ?? []}
        operatorBackend="claude"
        backendAvailable={{ claude: true, codex: true }}
        canRunAgents
        deliveringActive={false}
        activeReviewerIds={[]}
        operatorRunActive={false}
        runBusy={false}
        onAssignSpecialist={(id) => calls.assignSpecialist.push(id)}
        onRunSpecialist={() => calls.runSpecialist.push("run")}
        reviewerBusy={false}
        onAssignReviewer={(id) => calls.assignReviewer.push(id)}
        onRunReviewer={(id) => calls.runReviewer.push(id)}
        onRemoveReviewer={(id) => calls.removeReviewer.push(id)}
        operatorBusy={false}
        onRunOperator={() => {}}
      />
    </MemoryRouter>,
  );
  return { ...utils, calls };
}

/** A popover trigger by its visible label (`.own-btn` / `.rev-add`). */
const popoverTrigger = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(".own-btn, .rev-add")).find(
    (b) => b.textContent?.includes(label),
  );

const engagementsCell = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".profile-cell")).find((cell) =>
    cell.querySelector(".val.revs"),
  ) as HTMLElement;

/**
 * UXA-6 residual (pass-19 UX coherence audit, finding 2) — UXA-6 renamed the
 * `assign_specialist` chip to "Delivering agent" and left `run_specialist`
 * saying "Run specialist", so on a project whose operator holds
 * `assign-primary-specialist: recommend` one card named one actor twice, in two
 * registers: the chip said "specialist" and the operator's own title, three
 * pixels away, said "delivering agent".
 */
describe("UXA-6 residual: the run recommendation chip names the delivering agent", () => {
  const RUN_REC: RecommendationView = {
    id: "r-run",
    kind: "run_specialist",
    // The strings the operator actually writes (operator-actions.server.ts:1814).
    label: "Start the delivering agent's run",
    detail: "The specialist is ready to work this task; a maintainer starts the run.",
  };

  it("chips it 'Run delivering agent' — the actor its own title names", () => {
    const { container } = renderPage({ recommendations: [RUN_REC] });
    const chip = container.querySelector(".op-rec-kind")!;
    // Canary: put `run_specialist: "Run specialist"` back in KIND_LABEL and this
    // is the assertion that fails.
    expect(chip.textContent).toContain("Run delivering agent");
    expect(chip.textContent).not.toContain("Run specialist");
    // The chip and the title are one actor, so the card still reads as one card.
    expect(container.querySelector(".op-rec-title")!.textContent).toContain(
      "delivering agent",
    );
  });

  it("leaves the reviewer chip alone — it already matched its role name", () => {
    const { container } = renderPage({
      recommendations: [
        { id: "r-rev", kind: "run_reviewer", label: "Start the reviewer's run", detail: "" },
      ],
    });
    expect(container.querySelector(".op-rec-kind")!.textContent).toContain(
      "Run reviewer",
    );
  });
});

/**
 * UX19-4 — UC-13 flipped the cell heading to "Supporting agents" when nothing
 * engaged holds a verdict grant and stopped at the heading: the controls inside
 * kept saying "reviewer", and the add menu's empty state said "All deployed
 * agents are already reviewing." under a heading asserting they are not. Since
 * the verdict grant is off by default, that is what a fresh install shows the
 * first time anyone engages a second agent.
 */
describe("UX19-4: the engagements cell speaks ONE vocabulary", () => {
  const docs = deployedAgent("docs", "Docs agent", "Documentation", false);
  const perf = deployedAgent("perf", "Perf agent", "Performance", false);
  const senior = deployedAgent("senior", "Senior reviewer", "Code review", true);

  it("a supporting cell offers engagement verbs, not reviewer verbs", () => {
    const { container } = renderExec({
      task: { reviewers: [engagement("docs", "Documentation")] },
      deployedSpecialists: [docs, perf],
    });
    const cell = engagementsCell(container);
    expect(cell.querySelector(".lbl")!.textContent).toBe("Supporting agents");
    // Canary: pass the reviewer vocabulary unconditionally into ReviewerControl
    // and every assertion below fails while the heading keeps saying otherwise.
    expect(popoverTrigger(container, "Engage agent")).toBeDefined();
    expect(popoverTrigger(container, "Engage reviewer")).toBeUndefined();
    expect(cell.querySelector(".rev-x")!.getAttribute("aria-label")).toBe(
      "Release Documentation agent",
    );
    expect(cell.querySelector(".rev-x")!.getAttribute("title")).toBe("Release agent");
    fireEvent.click(popoverTrigger(container, "Engage agent")!);
    expect(container.querySelector('[aria-label="Engage an agent"]')).not.toBeNull();
    expect(cell.textContent).not.toMatch(/review/i);
  });

  it("the add menu's empty state no longer contradicts the heading it sits under", () => {
    // One deployed agent, and it is the one engaged — the sharpest string in the
    // cell: it said these engagements are supporting, AND that all deployed
    // agents are already reviewing, in the same box.
    const { container } = renderExec({
      task: { reviewers: [engagement("docs", "Documentation")] },
      deployedSpecialists: [docs],
    });
    fireEvent.click(popoverTrigger(container, "Engage agent")!);
    const panel = container.querySelector('[aria-label="Engage an agent"]')!;
    expect(panel.textContent).toContain("All deployed agents are already engaged.");
    expect(panel.textContent).not.toContain("already reviewing");
  });

  it("one verdict-holding engagement keeps the whole cell on reviewer vocabulary", () => {
    const { container } = renderExec({
      task: {
        reviewers: [
          engagement("docs", "Documentation"),
          engagement("senior", "Code review"),
        ],
      },
      deployedSpecialists: [docs, senior],
    });
    const cell = engagementsCell(container);
    expect(cell.querySelector(".lbl")!.textContent).toBe("Reviewing agents");
    expect(popoverTrigger(container, "Engage reviewer")).toBeDefined();
    expect(
      Array.from(cell.querySelectorAll(".rev-x")).map((x) =>
        x.getAttribute("aria-label"),
      ),
    ).toEqual(["Release Documentation reviewer", "Release Code review reviewer"]);
  });

  it("the closed-task note takes the same vocabulary as the heading", () => {
    const supporting = renderExec({
      task: {
        reviewers: [engagement("docs", "Documentation")],
        displayReadiness: "merged",
      } as Partial<TaskDetail>,
      deployedSpecialists: [docs, perf],
    });
    expect(engagementsCell(supporting.container).textContent).toContain(
      "Task closed — no new engagements.",
    );
    cleanup();
    const reviewing = renderExec({
      task: {
        reviewers: [engagement("senior", "Code review")],
        displayReadiness: "merged",
      } as Partial<TaskDetail>,
      deployedSpecialists: [senior],
    });
    expect(engagementsCell(reviewing.container).textContent).toContain(
      "Task closed — no new reviewer engagements.",
    );
  });
});

/**
 * UX19-12 — an engagement can outlive its profile (deleted, or re-deployed on
 * another project). The Agents live table names that state ("profile no longer
 * here", agents-page.tsx:927); task detail silently substituted the engagement's
 * ROLE for the missing name and kept a live "Run" button, whose run takes the
 * fully-withheld posture of R15-7 (ruling 26): it streams and produces no
 * branch, PR, comment or verdict. One state, two renderings — and the wrong one
 * on the surface where the action lives.
 */
describe("UX19-12: an engagement whose profile is gone says so, and cannot be run", () => {
  const GONE_NOTE = /Not deployed on this project any more/;

  it("delivering row: names the state, states the consequence, kills Run", () => {
    const { container } = renderExec({
      task: { specialist: engagement("dev-2f1c", "Implementation", "codex") },
      deployedSpecialists: [deployedAgent("other", "Other agent", "Docs", false)],
    });
    const cell = Array.from(container.querySelectorAll(".profile-cell")).find(
      (c) => c.querySelector(".lbl")?.textContent === "Delivering agent",
    ) as HTMLElement;
    // Canary: restore the `?? fallback` role substitution in `agentNameOf` and
    // the name line reads "Implementation" — the role, printed twice.
    expect(cell.querySelector(".nm")!.textContent).toBe("profile no longer here");
    expect(cell.textContent).toMatch(GONE_NOTE);
    expect(cell.textContent).toContain("no branch, PR, comment or verdict");
    const run = cell.querySelector<HTMLButtonElement>(".btn.primary")!;
    // Canary: drop `|| spGhost` from the disabled expression and this fails —
    // the button that delivers nothing goes live again.
    expect(run.disabled).toBe(true);
  });

  it("reviewer row: same disclosure, and the release control stays live", () => {
    const { container, calls } = renderExec({
      task: { reviewers: [engagement("rev-9a", "Code review")] },
      deployedSpecialists: [],
    });
    const row = container.querySelector(".rev-agent")!;
    expect(row.querySelector(".nm")!.textContent).toBe("profile no longer here");
    expect(row.textContent).toMatch(GONE_NOTE);
    expect(row.textContent).toContain("no verdict, comment or evidence");
    expect(row.querySelector<HTMLButtonElement>(".btn.primary")!.disabled).toBe(true);
    // Letting go of a dead engagement is the recovery — it must not be disabled
    // alongside the run.
    const release = row.querySelector<HTMLButtonElement>(".rev-x")!;
    expect(release.disabled).toBe(false);
    fireEvent.click(release);
    expect(calls.removeReviewer).toEqual(["rev-9a"]);
  });

  it("a deployed profile still reads as itself, with a live Run", () => {
    const { container, calls } = renderExec({
      task: { specialist: engagement("developer", "Implementation", "codex") },
      deployedSpecialists: [
        deployedAgent("developer", "Developer", "Implementation", false),
      ],
    });
    const cell = Array.from(container.querySelectorAll(".profile-cell")).find(
      (c) => c.querySelector(".lbl")?.textContent === "Delivering agent",
    ) as HTMLElement;
    expect(cell.querySelector(".nm")!.textContent).toBe("Developer");
    expect(cell.textContent).not.toMatch(GONE_NOTE);
    const run = cell.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    expect(calls.runSpecialist).toEqual(["run"]);
  });
});

/**
 * UX19-18 — "Manage", "Assign delivering agent" and "Engage reviewer" declared
 * `role="menu"` with `role="menuitem"` children and implemented none of the
 * keyboard contract those roles promise: a screen reader announced a menu whose
 * Up/Down did nothing, and Escape (or picking an item) unmounted the focused
 * element with no restoration, dropping the keyboard user at <body> mid-
 * workflow. UI-45 settled this shape for the account menu by DROPPING the roles
 * and managing focus; these three follow it.
 */
describe("UX19-18: the three popovers keep the keyboard promises they make", () => {
  const DEPLOYED = [
    deployedAgent("developer", "Developer", "Implementation", false),
    deployedAgent("senior", "Senior reviewer", "Code review", true),
  ];
  // Owner is Selin, viewer is Arda (admin) → all three popovers render.
  const openAll = () => renderExec({ deployedSpecialists: DEPLOYED });

  const menus: [name: string, trigger: string, panel: string, item: string][] = [
    ["ownership", "Manage", "Manage task ownership", "Take over ownership"],
    [
      "delivering agent",
      "Assign delivering agent",
      "Assign a delivering agent",
      "Developer",
    ],
    ["reviewer", "Engage reviewer", "Engage a reviewer", "Developer"],
  ];

  for (const [name, trigger, panel, item] of menus) {
    const open = () => {
      const view = openAll();
      const btn = popoverTrigger(view.container, trigger)!;
      expect(btn).toBeDefined();
      fireEvent.click(btn);
      const el = view.container.querySelector<HTMLElement>(`[aria-label="${panel}"]`)!;
      expect(el).not.toBeNull();
      return { ...view, btn, panel: el };
    };

    it(`${name}: declares no ARIA menu contract it does not implement`, () => {
      const { container, panel: el } = open();
      // Canary: put role="menu"/role="menuitem" back and this fails — the roles
      // promise Arrow/Home/End traversal that no code here provides.
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(container.querySelector('[role="menuitem"]')).toBeNull();
      // What it does implement instead: a named, focusable panel in Tab order
      // after its trigger.
      expect(el.getAttribute("tabindex")).toBe("-1");
      expect(popoverTrigger(container, trigger)!.getAttribute("aria-expanded")).toBe(
        "true",
      );
    });

    it(`${name}: moves focus into the panel on open`, () => {
      const { panel: el } = open();
      expect(document.activeElement).toBe(el);
    });

    it(`${name}: Escape closes it AND returns focus to the trigger`, () => {
      const { container, btn, panel: el } = open();
      fireEvent.keyDown(el, { key: "Escape" });
      expect(container.querySelector(`[aria-label="${panel}"]`)).toBeNull();
      // Canary: drop `closeAndReturnFocus` for a bare `setOpen(false)` and focus
      // falls back to <body> — the keyboard user is dumped at the top of the
      // document mid-workflow (F10-25's rule).
      expect(document.activeElement).toBe(btn);
    });

    it(`${name}: picking an item returns focus to the trigger`, () => {
      const { container, btn, panel: el } = open();
      const target = Array.from(el.querySelectorAll<HTMLButtonElement>(".menu-item")).find(
        (b) => b.textContent?.includes(item),
      )!;
      expect(target).toBeDefined();
      fireEvent.click(target);
      expect(container.querySelector(`[aria-label="${panel}"]`)).toBeNull();
      expect(document.activeElement).toBe(btn);
    });
  }
});
