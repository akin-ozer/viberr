// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
import { AcceptConfirm } from "./accept-confirm";
import type { RecommendationView } from "./operator-recommendations";
import { TaskDetailPage } from "./task-detail-page";

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
