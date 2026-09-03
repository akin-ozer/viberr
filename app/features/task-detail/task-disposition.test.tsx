// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, createRoutesStub } from "react-router";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
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

/** Ruling 121: the task owner whose accounts a run bills, both backends
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
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "human",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
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
    changed: null,
    unownedPr: null,
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
    lastActivityAt: null,
    quiet: false,
    ...patch,
  };
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
  schedules?: TaskSchedule[];
  runtime?: RunView[];
  deployedSpecialists?: DeployedSpecialistView[];
  activeAgentProfileIds?: string[];
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
            activeAgentProfileIds={props.activeAgentProfileIds ?? []}
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
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        const row: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
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
          revisionDrift: { headSha: "ccccccccccccdddddddddddd", aheadBy: 2 },
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
    expect(dialog.textContent).toContain("2 commits added since review");
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

  it("F19-37: a move to any OTHER stage still goes in one click — only the last stage is an acceptance", async () => {
    const { submitted, getByLabelText, getByRole, queryByText } = renderPage({
      myRole: "admin",
    });
    fireEvent.click(getByLabelText("Change stage (currently Review)"));
    fireEvent.click(getByRole("menuitemradio", { name: "Triage" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("transition");
    expect(submitted[0]!.to).toBe("triage");
    expect(queryByText(/accepts this completion/)).toBeNull();
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
    { id: "triage", name: "Triage", color: "#a5a8b5" },
    { id: "impl", name: "In Progress", color: "#f0a202" },
    { id: "review", name: "Review", color: "#5b76fe" },
    { id: "done", name: "Done", color: "#00b473" },
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

  it("N20-17: a closed task's disabled button notes that @operator still runs it", () => {
    const { container } = renderPage({
      myRole: "admin",
      task: { displayReadiness: "accepted", stage: "done" },
    });
    const runOperator = findButton(container, "Run operator")!;
    expect(runOperator.disabled).toBe(true);
    expect(container.textContent).toContain("Mentioning");
    expect(container.textContent).toContain("still runs it");
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
    expect(getByText("You own this task, so you can accept it → Done")).toBeTruthy();
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
      cell.querySelector('input[aria-label="Tell the agent what this run should do (optional)"]')!,
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
  activeAgentProfileIds?: string[];
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
        operatorBackend="claude"
        operatorAutonomy="supervised"
        runPrincipal={CONNECTED_PRINCIPAL}
        canRunAgents={opts.canRunAgents ?? true}
        activeAgentProfileIds={opts.activeAgentProfileIds ?? []}
        operatorRunActive={false}
        runBusy={false}
        onRunAgent={(profileId, prompt, delayMinutes) =>
          calls.runAgent.push({ profileId, prompt, delayMinutes })
        }
        releaseBusy={false}
        onReleaseAgent={(id) => calls.releaseAgent.push(id)}
        operatorBusy={false}
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
      activeAgentProfileIds: ["developer"],
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
    const { container, input } = open();
    fireEvent.change(input, { target: { value: "sen" } });
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(1);
    expect(options[0]!.querySelector("mark.mention-match")!.textContent).toBe("Sen");
    fireEvent.click(options[0]!);
    expect(input.value).toBe("Senior reviewer");
    // Editing the text invalidates the pick — the selection is a row pick,
    // never free text, so Run disarms until a row is chosen again.
    fireEvent.change(input, { target: { value: "Senior review" } });
    expect(
      container.querySelector<HTMLButtonElement>(".agent-run button.btn")!.disabled,
    ).toBe(true);
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
    fireEvent.click(findButton(container, "Dismiss recommendation")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("dismiss-recommendation");
    expect(submitted[0]!.recId).toBe("rec-d");
  });

  it("interrupting a live run confirms, then posts run-interrupt", async () => {
    const { container, submitted, getByText } = renderPage({
      myRole: "admin",
      runtime: [runningRun()],
    });
    fireEvent.click(findButton(container, "Interrupt")!);
    // The button opens a confirm; the run keeps going until it is confirmed.
    expect(getByText("Interrupt this run?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    fireEvent.click(findButton(container, "Interrupt run")!);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.intent).toBe("run-interrupt");
    expect(submitted[0]!.runId).toBe("run_1");
  });
});

/**
 * U7 — D2's other half.
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
 * The columns are ordered in the markup now and placed by grid cell in app.css,
 * so the desktop paint is unchanged while one order serves both. This asserts
 * the order and its CONTENT — a swap that moved empty divs would pass on order
 * alone.
 */
describe("U7: the task detail's reading order matches its stacking rule", () => {
  it("puts the current-state / acceptance column ahead of the timeline in the DOM", () => {
    const { container } = renderPage({});
    const detail = container.querySelector(".detail")!;
    const columns = Array.from(detail.children)
      .map((el) => el.className)
      .filter((c) => c === "detail-main" || c === "detail-side");
    expect(columns).toEqual(["detail-side", "detail-main"]);

    const side = detail.querySelector(".detail-side")!;
    const main = detail.querySelector(".detail-main")!;
    // The consequential action really is in the column that comes first…
    expect(side.textContent).toContain("Accept completion → Done");
    expect(main.textContent).not.toContain("Accept completion → Done");
    // …and the timeline really is in the one that follows it.
    expect(main.querySelector(".tl-list, .timeline, .tl-wrap")).not.toBeNull();
  });
});
