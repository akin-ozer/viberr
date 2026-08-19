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
import { ScheduledActions } from "./task-main-sections";
import type { RunView } from "~/features/runtime/runtime-types";

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
            deployedSpecialists={[]}
            operatorBackend="claude"
          operatorAutonomy="supervised"
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

  it("F15-11: an ARCHIVED task renders no Accept control, no schedule form, and disabled run controls", () => {
    const { container, queryByText } = renderPage({
      archived: true,
      task: { archived: true },
      acceptance: { atBoundary: true, canAccept: true },
    });
    // Fails on main: the Accept button and the schedule form stayed live.
    expect(findButton(container, "Accept completion")).toBeUndefined();
    expect(queryByText("Schedule operator re-run")).toBeNull();
    const runOperator = findButton(container, "Run operator");
    expect(runOperator?.disabled).toBe(true);
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
 * read as silently inconsistent. C8 — Scheduled re-runs collapses below the
 * Execution profile.
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
      "Open decision — resolve it before running the operator.",
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

describe("C8: Scheduled re-runs collapses below the Execution profile", () => {
  const schedule = (id: string): TaskSchedule => ({
    id,
    action: "run-operator",
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    backend: "claude",
    autonomy: "supervised",
    note: "",
    createdBy: "u-arda",
    createdByLabel: "Arda",
    createdAt: "2026-07-01T09:00:00.000Z",
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
  });

  it("shows a one-line disclosure (not the form) when nothing is scheduled", () => {
    const { container, getByText, queryByText } = renderPage({ myRole: "admin" });
    // The four-control form is not rendered up-front any more…
    expect(queryByText("Schedule operator re-run")).toBeNull();
    // …only a one-line disclosure, which opens the form on click.
    const disclosure = findButton(container, "Schedule a re-run")!;
    expect(disclosure).toBeDefined();
    fireEvent.click(disclosure);
    expect(getByText("Schedule operator re-run")).toBeTruthy();
  });

  it("renders the panel expanded when a schedule already exists", () => {
    const { getByText, queryByText } = renderPage({
      myRole: "admin",
      schedules: [schedule("s-1")],
    });
    // Something to show → the panel is expanded, no disclosure step.
    expect(getByText("Scheduled re-runs")).toBeTruthy();
    expect(queryByText("Schedule a re-run")).toBeNull();
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
              configuredAutonomy="supervised"
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

/** Every callback `renderExec` records, so a test can assert what the cell invoked. */
interface RecordedExecCalls {
  owner: string[];
  assignSpecialist: string[];
  runSpecialist: string[];
  assignReviewer: string[];
  runReviewer: string[];
  removeReviewer: string[];
}

function renderExec(opts: {
  task?: Partial<TaskDetail>;
  deployedSpecialists?: DeployedSpecialistView[];
} = {}) {
  const calls: RecordedExecCalls = {
    owner: [],
    assignSpecialist: [],
    runSpecialist: [],
    assignReviewer: [],
    runReviewer: [],
    removeReviewer: [],
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
          operatorAutonomy="supervised"
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
  Array.from(container.querySelectorAll<HTMLElement>(".profile-cell")).find((cell) =>
    cell.querySelector(".val.revs"),
  )!;

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
      },
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
      },
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
    const cell = Array.from(
      container.querySelectorAll<HTMLElement>(".profile-cell"),
    ).find((c) => c.querySelector(".lbl")?.textContent === "Delivering agent")!;
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
    const cell = Array.from(
      container.querySelectorAll<HTMLElement>(".profile-cell"),
    ).find((c) => c.querySelector(".lbl")?.textContent === "Delivering agent")!;
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

  it("cancelling a scheduled re-run confirms, then posts cancel-schedule", async () => {
    const submitted: Record<string, string>[] = [];
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <ScheduledActions
              schedules={[
                {
                  id: "s-1",
                  action: "run-operator",
                  dueAt: new Date(Date.now() + 3_600_000).toISOString(),
                  backend: "claude",
                  autonomy: "supervised",
                  note: "",
                  createdBy: "u-selin",
                  createdByLabel: "Selin",
                  createdAt: "2026-07-01T09:00:00.000Z",
                  status: "pending",
                  firedAt: null,
                  claimedAt: null,
                  retries: 0,
                },
              ]}
              canRunAgents
              taskClosed={false}
              configuredAutonomy="supervised"
              backendAvailable={{ claude: true, codex: true }}
            />
          </ToastProvider>
        ),
        action: async ({ request }: { request: Request }) => {
          const fd = await request.formData();
          const row: Record<string, string> = {};
          for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
          submitted.push(row);
          return { ok: true };
        },
      },
    ]);
    const { getByText, queryByText } = render(<Stub initialEntries={["/"]} />);
    // The row's Cancel opens a confirm — nothing submits yet.
    fireEvent.click(getByText("Cancel", { selector: "button.sched-cancel" }));
    expect(getByText("Cancel this scheduled re-run?")).toBeTruthy();
    expect(submitted).toHaveLength(0);
    // Canary: wire the row button straight to submit and this dialog never shows.
    expect(queryByText(/scheduled by Selin/)).toBeTruthy();
    fireEvent.click(getByText("Cancel re-run", { selector: "button.btn.danger" }));
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
