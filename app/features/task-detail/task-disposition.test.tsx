// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, createRoutesStub } from "react-router";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type LiveAgentRun,
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
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
import { AcceptConfirm } from "./accept-confirm";
import { DecisionPacket } from "./decision-packet";
import type { RecommendationView } from "./operator-recommendations";
import { TaskDetailPage } from "./task-detail-page";
import type { RunView } from "~/features/runtime/runtime-types";
import { NO_RUN_CACHE } from "~/features/runtime/runtime-types";

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

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "human",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "healthy",
    continuity: null,
    blockReason: null,
    // The BOARD's own boundary predicate — nothing the task page renders reads
    // it, so it stays neutral and the `acceptance` prop remains the single
    // answer these tests vary.
    atAcceptanceBoundary: false,
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
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
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
    workflow: [],
    lastActivityAt: null,
    quiet: false,
    ...patch,
  };
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
}) {
  const submitted: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailPage
            task={detail(props.task ?? {})}
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
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        const row: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
        submitted.push(row);
        if (props.held) await props.held.reply;
        return { ok: true, intent: row.intent, toast: "done" };
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/"]} />);
  return { ...utils, submitted };
}

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
    // Canary: bring back the `.force-accept .hint` "Acceptance is blocked: …"
    // paragraph and the duplicate returns here.
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
    // The force-accept row is now just the override button — no reason paragraph.
    const forceAccept = container.querySelector(".force-accept")!;
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
    const runOperator = findButton(container, "Run operator");
    expect(runOperator?.disabled).toBe(true);
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
 * `resolveAcceptanceAffordance`, which computes the identical predicate
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
    // wrong: `resolveAcceptanceAffordance` returns the `denied` shape (which
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
    const { container, submitted, getByText } = renderPage({ canDeliver: true });
    const btn = findButton(container, "Deliver branch & open PR");
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("deliver-review");
    expect(getByText).toBeTruthy();
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

/**
 * F20-5 (R20-1) — the server refuses a MANUAL operator run while a decision
 * packet is open (coordination is paused by the packet). The button must say so
 * instead of offering a paid no-op. N20-17 — a closed task's disabled button
 * notes that mentioning @operator still runs it, so the two run paths do not
 * read as silently inconsistent. (C8's separate "Scheduled re-runs" panel is
 * gone — scheduling lives inside the run controls now, pinned below.)
 */
describe("F20-5 / N20-17: the operator run control's honest off-states", () => {
  const openPacket: PacketRender = {
    type: "input",
    kind: "Decision required",
    from: "Operator",
    title: "VIB-151 needs a decision",
    body: "Choose a path.",
    observations: [],
    options: [{ kind: "custom", t: "Rework and re-run", d: "", rec: true }],
  };

  it("F20-5: an open packet disables Run operator with the resolve-first reason", () => {
    const { container } = renderPage({ myRole: "admin", task: { packet: openPacket } });
    const runOperator = findButton(container, "Run operator")!;
    expect(runOperator).toBeDefined();
    // Canary: drop the `packetOpen` blockedReason wiring and the button goes
    // live while the server refuses the run as a paid no-op.
    expect(runOperator.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Open decision. Resolve it before running the operator.",
    );
  });

  it("ruling 177 (was N20-17): a closed task's disabled button no longer advertises the @operator side door", () => {
    // N20-17 disclosed that an @operator comment still ran the operator on a
    // closed task; ruling 177 closed that door, so the disclosure would lie.
    // Canary: put the "Mentioning @operator … still runs it" sentence back.
    const { container } = renderPage({
      myRole: "admin",
      task: { displayReadiness: "accepted", stage: "done" },
    });
    const runOperator = findButton(container, "Run operator")!;
    expect(runOperator.disabled).toBe(true);
    expect(container.textContent).toContain("Task closed. Reopen it to run the operator.");
    expect(container.textContent).not.toContain("still runs it");
  });
});

/**
 * C8's successor (dynamic-dispatch rework 2026-08-29): the standalone
 * "Scheduled re-runs" panel and its "Schedule a re-run" disclosure are DELETED.
 * Scheduling is baked into the two run controls — a pending entry lists under
 * the control that created it ("no additional button", owner directive).
 */
describe("scheduling lives inside the run controls — no separate panel", () => {
  const schedule = (id: string, patch: Partial<TaskSchedule> = {}): TaskSchedule => ({
    id,
    action: "run-operator",
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    profileId: null,
    prompt: "",
    createdBy: "u-arda",
    createdByLabel: "Arda",
    createdAt: "2026-07-01T09:00:00.000Z",
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
    ...patch,
  });

  it("no scheduled-actions panel or disclosure exists, even with a pending entry", () => {
    const { container, queryByText } = renderPage({
      myRole: "admin",
      schedules: [schedule("s-1")],
    });
    // Canary: re-add the ScheduledActions panel and these go red.
    expect(queryByText("Scheduled re-runs")).toBeNull();
    expect(queryByText("Schedule a re-run")).toBeNull();
    expect(container.querySelector('[data-testid="scheduled-actions"]')).toBeNull();
  });

  it("a pending operator re-run lists under the OPERATOR control, with Cancel", () => {
    const { container } = renderPage({
      myRole: "admin",
      schedules: [schedule("s-1", { prompt: "re-check the PR" })],
    });
    // The operator control's own list — not the agent control's.
    const opRun = container.querySelector(".op-run:not(.agent-run)")!;
    const row = opRun.querySelector(".sched-list .sched-row")!;
    expect(row.textContent).toContain("operator re-run");
    expect(row.textContent).toContain("re-check the PR");
    expect(row.textContent).toContain("by Arda");
    expect(row.querySelector("button.sched-cancel")).not.toBeNull();
    expect(container.querySelector(".agent-run .sched-list")).toBeNull();
  });

  it("a pending agent run lists under the RUN-AN-AGENT control, named by its live deployment", () => {
    const { container } = renderPage({
      myRole: "admin",
      deployedSpecialists: [
        deployedAgent("developer", "Developer", "Implementation", false),
      ],
      schedules: [
        schedule("s-a", { action: "run-agent", profileId: "developer", prompt: "fix the lint debt" }),
      ],
    });
    const row = container.querySelector(".agent-run .sched-list .sched-row")!;
    // R22 kept: the entry pins the profile ID only — the row resolves the name
    // from the LIVE deployment, and no backend/autonomy is stored to show.
    expect(row.textContent).toContain("Developer run");
    expect(row.textContent).toContain("fix the lint debt");
    expect(
      container.querySelector(".op-run:not(.agent-run) .sched-list"),
    ).toBeNull();
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
 * UX19-10 / R22, carried into the reworked controls — a run (or a schedule,
 * which is the same control deferred) pins NO backend and NO autonomy. The
 * operator control DISPLAYS its profile's backend; both controls offer only a
 * prompt and the baked-in DelayPicker, and a deferred delay turns the same
 * button into "Schedule". A schedule fires unattended, so the fired run
 * resolves the LIVE deployed profile — nothing here to freeze hours earlier.
 */
describe("R22: the run controls carry no backend/autonomy pickers — prompt + DelayPicker only", () => {
  it("operator control: backend is displayed (not picked), the when-picker offers the five delays", () => {
    const { container, calls } = renderExec();
    const op = container.querySelector(".op-run:not(.agent-run)")!;
    // Canary: re-add either picker and these go red.
    expect(op.querySelector('select[name="backend"]')).toBeNull();
    expect(op.querySelector('select[name="autonomy"]')).toBeNull();
    expect(op.querySelector(".op-backend")!.textContent).toBe("Claude");
    const when = op.querySelector<HTMLSelectElement>(
      'select[aria-label="When the operator run starts"]',
    )!;
    expect(
      Array.from(when.querySelectorAll("option")).map((o) => o.textContent),
    ).toEqual(["Now", "in 5 min", "in 1 hour", "in 6 hours", "in 24 hours"]);
    // A picked delay flips the button to "Schedule" and defers the SAME run.
    fireEvent.change(when, { target: { value: "1440" } });
    const btn = op.querySelector<HTMLButtonElement>("button.btn")!;
    expect(btn.textContent).toContain("Schedule");
    fireEvent.click(btn);
    expect(calls.runOperator).toEqual([{ steer: "", delayMinutes: 1440 }]);
  });

  it("agent control: AgentSelect + prompt + when-picker; a picked delay schedules the same dispatch", () => {
    const { container, calls } = renderExec({
      deployedSpecialists: [
        deployedAgent("developer", "Developer", "Implementation", false),
      ],
    });
    const cell = container.querySelector<HTMLElement>(".agent-run")!;
    expect(cell.querySelector('select[name="backend"]')).toBeNull();
    expect(cell.querySelector('select[name="autonomy"]')).toBeNull();
    // Pick the agent, type the prompt, defer an hour — one button does it all.
    fireEvent.focus(cell.querySelector('input[role="combobox"]')!);
    fireEvent.click(
      Array.from(cell.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
        (o) => o.textContent?.includes("Developer"),
      )!,
    );
    fireEvent.change(
      cell.querySelector('input[aria-label="Prompt for this agent run (optional)"]')!,
      { target: { value: "fix the lint debt" } },
    );
    const when = cell.querySelector<HTMLSelectElement>(
      'select[aria-label="When the agent run starts"]',
    )!;
    fireEvent.change(when, { target: { value: "60" } });
    const btn = cell.querySelector<HTMLButtonElement>("button.btn")!;
    expect(btn.textContent).toContain("Schedule");
    fireEvent.click(btn);
    expect(calls.runAgent).toEqual([
      { profileId: "developer", prompt: "fix the lint debt", delayMinutes: 60 },
    ]);
  });
});

/* -------------------------------- execution profile · dynamic-dispatch UX */

/**
 * The Execution profile panel, rendered on its own. These blocks are about the
 * panel's own vocabulary, disclosure and keyboard contract — none of which the
 * page-level fixture above can express (it carries no engagements).
 */

/** An engagement as the task file stores it — profileId, backend, role. */
const engagement = (
  profileId: string,
  role: string,
  backend: "claude" | "codex" = "claude",
): NonNullable<TaskDetail["specialist"]> => ({
  kind: "agent",
  profileId,
  backend,
  role,
  name: backend === "claude" ? "Claude Code" : "Codex",
});

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
  capabilities: { delivery: true, verdict, askHuman: true, browser: false },
});

/** Every callback `renderExec` records, so a test can assert what the panel
 *  invoked (one run/release/operator/cancel surface since the rework). */
interface RecordedExecCalls {
  owner: string[];
  runAgent: { profileId: string; prompt: string; delayMinutes: number | null }[];
  releaseAgent: string[];
  runOperator: { steer: string; delayMinutes: number | null }[];
  cancelSchedule: string[];
}

function renderExec(opts: {
  task?: Partial<TaskDetail>;
  deployedSpecialists?: DeployedSpecialistView[];
  liveAgentRuns?: LiveAgentRun[];
  schedules?: TaskSchedule[];
  canRunAgents?: boolean;
} = {}) {
  const calls: RecordedExecCalls = {
    owner: [],
    runAgent: [],
    releaseAgent: [],
    runOperator: [],
    cancelSchedule: [],
  };
  const utils = render(
    <MemoryRouter>
      <ExecutionProfile
        task={detail(opts.task ?? {})}
        meId="u-arda"
        myRole="admin"
        busy={false}
        onOwner={(action) => calls.owner.push(action)}
        deployedSpecialists={opts.deployedSpecialists ?? []}
        stages={[]}
        workflow={[]}
        operatorBackend="claude"
        operatorAutonomy="supervised"
        runPrincipal={CONNECTED_PRINCIPAL}
        canRunAgents={opts.canRunAgents ?? true}
        liveAgentRuns={opts.liveAgentRuns ?? []}
        operatorRunActive={false}
        runInFlight={null}
        onRunAgent={(profileId, prompt, delayMinutes) =>
          calls.runAgent.push({ profileId, prompt, delayMinutes })
        }
        releaseBusy={false}
        onReleaseAgent={(id) => calls.releaseAgent.push(id)}
        operatorInFlight={null}
        onRunOperator={(steer, delayMinutes) =>
          calls.runOperator.push({ steer, delayMinutes })
        }
        schedules={opts.schedules ?? []}
        scheduleBusy={false}
        onCancelSchedule={(id) => calls.cancelSchedule.push(id)}
      />
    </MemoryRouter>,
  );
  return { ...utils, calls };
}

const engagementsCell = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".profile-cell")).find((cell) =>
    cell.querySelector(".val.revs"),
  )!;

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
 * UX19-4's successor — the whole role-conditional vocabulary machinery
 * (`reviewingAgentsLabel` / `engagementVocabulary`, the heading flips, the
 * engage popovers) is DELETED with the slot cells. What replaced it is one
 * "Engaged agents" LEDGER whose claims are per ROW: "delivers" on the
 * delivering engagement, "gates acceptance" only where a verdict snapshot makes
 * it true (UC-13/F21-6's rule, kept), "running…" only on a live run.
 */
describe("the Engaged agents ledger marks authority per row", () => {
  const docs = deployedAgent("docs", "Docs agent", "Documentation", false);
  const senior = deployedAgent("senior", "Senior reviewer", "Code review", true);
  const dev = deployedAgent("developer", "Developer", "Implementation", false);

  const rowFor = (container: HTMLElement, name: string) =>
    Array.from(
      engagementsCell(container).querySelectorAll<HTMLElement>(".rev-agent"),
    ).find((r) => r.querySelector(".nm")!.textContent === name)!;

  it("one heading, three honest marks: delivers / gates acceptance / neither", () => {
    const { container } = renderExec({
      task: {
        specialist: engagement("developer", "Implementation", "codex"),
        reviewers: [
          engagement("senior", "Code review"),
          engagement("docs", "Documentation"),
        ],
      },
      deployedSpecialists: [dev, senior, docs],
    });
    const cell = engagementsCell(container);
    expect(cell.querySelector(".lbl")!.textContent).toBe("Engaged agents");
    // The delivering row owns branch/PR — and only it says so.
    expect(rowFor(container, "Developer").querySelector(".sub")!.textContent).toContain(
      "· delivers",
    );
    // "gates acceptance" is a claim about verdict AUTHORITY (F21-6): true of
    // the verdict-holding supporting engagement, absent from the verdict-less
    // one. Canary: mark it unconditionally and the Docs row assertion fails.
    expect(rowFor(container, "Senior reviewer").querySelector(".sub")!.textContent).toContain(
      "· gates acceptance",
    );
    const docsSub = rowFor(container, "Docs agent").querySelector(".sub")!.textContent!;
    expect(docsSub).not.toContain("gates acceptance");
    expect(docsSub).not.toContain("delivers");
  });

  it("a live run marks its row 'running…' and blocks a duplicate Now-run of that profile", () => {
    const { container } = renderExec({
      task: { specialist: engagement("developer", "Implementation") },
      deployedSpecialists: [dev],
      liveAgentRuns: [{ profileId: "developer", lifecycle: "running" }],
    });
    expect(rowFor(container, "Developer").querySelector(".sub")!.textContent).toContain(
      "· running…",
    );
    // The selector's row says it too, and picking it leaves Run disabled while
    // the delay is "Now" — no second concurrent run of one profile by hand.
    fireEvent.focus(container.querySelector('input[role="combobox"]')!);
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(option.textContent).toContain("running");
    fireEvent.click(option);
    expect(
      container.querySelector<HTMLButtonElement>(".agent-run button.btn")!.disabled,
    ).toBe(true);
  });

  it("the empty ledger names the operator as the dispatcher — and the manual control only for run-agents holders", () => {
    const withRun = renderExec();
    expect(engagementsCell(withRun.container).textContent).toContain(
      "None yet. The operator picks who runs at each stage, or run one yourself above.",
    );
    cleanup();
    const withoutRun = renderExec({ canRunAgents: false });
    expect(engagementsCell(withoutRun.container).textContent).toContain(
      "None yet. The operator picks who runs at each stage.",
    );
    // Below the tier, the run-an-agent cell states the rule instead of a control.
    expect(withoutRun.container.textContent).toContain(
      "The operator dispatches agents as the task moves. Running one by hand needs the run-agents tier.",
    );
  });
});

/**
 * UX19-12, reworked — an engagement can still outlive its profile (deleted, or
 * re-deployed on another project), and the ledger row that holds it names the
 * state in the Agents live table's own words plus the recovery. What changed is
 * HOW a ghost cannot be run: the per-row Run buttons are gone, and the run
 * control's selector is built from the DEPLOYED roster alone — a ghost is
 * structurally unpickable, not merely disabled.
 */
describe("UX19-12: a ghost engagement says so in the ledger and is unpickable in the selector", () => {
  // Hunt 2026-08-29: the recovery is PER POSTURE — the supporting note offers
  // the release the row actually renders; the delivering note must not tell
  // the human to use a control that row deliberately withholds.
  const GONE_SUPPORTING_NOTE =
    "Not deployed on this project any more. Release it, or re-deploy the profile on the Agents page.";
  const GONE_DELIVERING_NOTE =
    "Not deployed on this project any more. Re-deploy the profile on the Agents page, or hand delivery to another agent.";

  it("supporting ghost row: names the state, and the release recovery stays live", () => {
    const { container, calls } = renderExec({
      task: { reviewers: [engagement("rev-9a", "Code review")] },
      deployedSpecialists: [],
    });
    const row = container.querySelector(".rev-agent")!;
    // Canary: restore a `?? role` name substitution and this reads "Code
    // review" — the role, printed twice.
    expect(row.querySelector(".nm")!.textContent).toBe("profile no longer here");
    expect(row.textContent).toContain(GONE_SUPPORTING_NOTE);
    // Letting go of a dead engagement is the recovery the note names.
    const release = row.querySelector<HTMLButtonElement>(".rev-x")!;
    expect(release.disabled).toBe(false);
    fireEvent.click(release);
    expect(calls.releaseAgent).toEqual(["rev-9a"]);
  });

  it("delivering ghost row: its OWN recovery copy (no release control to point at), and no release", () => {
    const { container } = renderExec({
      task: { specialist: engagement("dev-2f1c", "Implementation", "codex") },
      deployedSpecialists: [deployedAgent("other", "Other agent", "Docs", false)],
    });
    const row = engagementsCell(container).querySelector(".rev-agent")!;
    expect(row.querySelector(".nm")!.textContent).toBe("profile no longer here");
    expect(row.textContent).toContain(GONE_DELIVERING_NOTE);
    // Canary: collapse the two notes back into one and this row tells the
    // human to "Release it" beside a deliberately-withheld ✕.
    expect(row.textContent).not.toContain("Release it");
    expect(row.querySelector(".rev-x")).toBeNull();
  });

  it("the run selector offers only DEPLOYED agents — the ghost cannot be picked", () => {
    const { container } = renderExec({
      task: { specialist: engagement("dev-2f1c", "Implementation", "codex") },
      deployedSpecialists: [deployedAgent("other", "Other agent", "Docs", false)],
    });
    fireEvent.focus(container.querySelector('input[role="combobox"]')!);
    const menu = container.querySelector(".agent-select-menu")!;
    // Canary: build the selector from the engagement roster and the ghost's
    // id shows up here as a pickable row again.
    expect(
      Array.from(menu.querySelectorAll('[role="option"] .ri-nm')).map(
        (n) => n.textContent,
      ),
    ).toEqual(["Other agent"]);
    expect(menu.textContent).not.toContain("dev-2f1c");
    expect(menu.textContent).not.toContain("profile no longer here");
  });
});

/**
 * UX19-18's successor — the assign/engage popovers (and the menu-role audit
 * they needed) left with the slot cells. The ONE picker that replaced them is
 * the AgentSelect combobox: a real `role="combobox"` + `role="listbox"` pair
 * whose keyboard contract is implemented, not merely declared. This block IS
 * that contract.
 */
describe("the AgentSelect combobox keeps the keyboard promises it makes", () => {
  const DEPLOYED = [
    deployedAgent("developer", "Developer", "Implementation", false),
    deployedAgent("senior", "Senior reviewer", "Code review", true),
  ];
  const open = () => {
    const view = renderExec({ deployedSpecialists: DEPLOYED });
    const input = view.container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    fireEvent.focus(input);
    return { ...view, input };
  };

  it("declares the combobox contract and opens on focus with the whole roster", () => {
    const { container, input } = open();
    expect(input.getAttribute("aria-label")).toBe("Choose an agent to run");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const menu = container.querySelector('.agent-select-menu[role="listbox"]')!;
    expect(menu).not.toBeNull();
    // No sigil, no minimum query — the full deployed roster IS the point.
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(2);
    // Hunt 2026-08-29: a bare focus-open is UNARMED — no active option, no
    // aria-activedescendant — so tabbing through the control can commit
    // nothing. Arrowing arms row 0 and wires the descendant.
    expect(menu.querySelector('[aria-selected="true"]')).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      menu.querySelector('[aria-selected="true"]')!.id,
    );
  });

  it("ArrowDown arms then moves the active option; Enter picks it, fills the input with the NAME and arms Run", () => {
    const { container, input, calls } = open();
    // First arrow ARMS row 0 (hunt 2026-08-29); the second moves to row 1.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // Picking closes the menu and settles the selection as the display name.
    expect(container.querySelector(".agent-select-menu")).toBeNull();
    expect(input.value).toBe("Senior reviewer");
    const run = container.querySelector<HTMLButtonElement>(".agent-run button.btn")!;
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    // The id is what the dispatch submits — never the free text.
    expect(calls.runAgent).toEqual([
      { profileId: "senior", prompt: "", delayMinutes: null },
    ]);
  });

  it("typing filters with match highlighting; typing over a settled pick clears the selection", () => {
    const { container, input, calls } = open();
    fireEvent.change(input, { target: { value: "sen" } });
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(1);
    expect(options[0]!.querySelector("mark.mention-match")!.textContent).toBe("Sen");
    fireEvent.click(options[0]!);
    expect(input.value).toBe("Senior reviewer");
    // Editing the text invalidates the pick — the selection is a row pick,
    // never free text. Ruling 147 keeps the start enabled, so the proof is that
    // it now submits NOTHING until a row is chosen again.
    fireEvent.change(input, { target: { value: "Senior review" } });
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".agent-run button.btn")!,
    );
    expect(calls.runAgent).toEqual([]);
  });

  it("Escape closes the menu without picking; blur closes it too", () => {
    const { container, input, calls } = open();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector(".agent-select-menu")).toBeNull();
    fireEvent.focus(input);
    expect(container.querySelector(".agent-select-menu")).not.toBeNull();
    fireEvent.blur(input);
    expect(container.querySelector(".agent-select-menu")).toBeNull();
    expect(calls.runAgent).toEqual([]);
  });

  it("rows disclose what the pick commits to: role · backend plus capability marks", () => {
    const { container } = open();
    const subs = Array.from(
      container.querySelectorAll('[role="option"] .ri-sub'),
    ).map((s) => s.textContent);
    expect(subs[0]).toBe("Implementation · Claude");
    // Choosing an agent commits a paid run, so authority marks live on the row.
    expect(subs[1]).toContain("Code review · Claude");
    expect(subs[1]).toContain("gates acceptance");
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
    expect(apply.querySelector("svg.ico.spin")).toBeNull();
    fireEvent.click(apply);
    fireEvent.click(findButton(container, "Apply → Done")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const busy = findButton(container, "Accepting…")!;
    await waitFor(() => expect(busy.getAttribute("aria-busy")).toBe("true"));
    expect(busy.disabled).toBe(true);
    expect(busy.querySelectorAll("svg.ico")).toHaveLength(1);
    expect(busy.querySelector("svg.ico.spin")).not.toBeNull();
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
    expect(findButton(container, "Apply")!.querySelector("svg.ico.spin")).toBeNull();
  });

  it("a plain recommendation reads 'Applying…', and a dismissal 'Dismissing…' on its own button", async () => {
    const held = heldAction();
    const { container, submitted, getByText } = renderPage({
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
    void getByText;
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
    expect(busy.querySelector("svg.ico.spin")).not.toBeNull();
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
    expect(archiving.querySelector("svg.ico.spin")).not.toBeNull();
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
    expect(accepting.querySelector("svg.ico.spin")).not.toBeNull();
    // Archive only waits.
    expect(findButton(container, "Archive task")!.hasAttribute("aria-busy")).toBe(false);
    await act(async () => {
      held.answer();
    });
  });

  it("a details save reads Saving…, busy, the loader spinning", async () => {
    // Canary: drop `aria-busy` from the details form's Save in task-side-panels.tsx.
    const held = heldAction();
    const { container, submitted } = renderPage({ myRole: "admin", held });
    fireEvent.click(findButton(container, "Edit details")!);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".meta-edit-actions button[type=submit]")!,
    );
    await waitFor(() => expect(submitted).toHaveLength(1));
    const saving = findButton(container, "Saving…")!;
    await waitFor(() => expect(saving.getAttribute("aria-busy")).toBe("true"));
    expect(saving.disabled).toBe(true);
    expect(saving.querySelector("svg.ico.spin")).not.toBeNull();
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
    expect(merging.querySelector("svg.ico.spin")).not.toBeNull();
    await act(async () => {
      held.answer();
    });
  });
});
