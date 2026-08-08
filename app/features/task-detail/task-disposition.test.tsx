// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { ToastProvider } from "~/ui/toast";
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
  workRevisionSha?: string;
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
            canDeliver={props.canDeliver ?? false}
            workRevisionSha={props.workRevisionSha ?? null}
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
    });
    fireEvent.click(findButton(container, "Accept completion → Done")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    );
    expect(dialog?.textContent).toContain("PR #117");
    expect(dialog?.textContent).toContain("main");
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

  it("UX19-2: the GitHub panel and Current state quote the SAME refusal — no two-gate contradiction", () => {
    // Live: "Acceptance is blocked: …no approving verdict yet…" (projection
    // column, revision dimension only) sat one panel above "Not acceptable
    // yet — at In Progress, not Review" (live gate, stage first). Canary: read
    // `task.blockReason` in GithubTrace again and the two sentences diverge.
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
    const hatch = container.querySelector(".force-accept .hint")!;
    const denyNote = container.querySelector(".deny-note")!;
    expect(hatch.textContent).toContain(stageRefusal);
    expect(denyNote.textContent).toContain(stageRefusal);
    expect(hatch.textContent).not.toContain("no approving verdict yet");
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

/**
 * Pass 19 — the acceptance-writer matrix. Five code paths end in "task Done +
 * a real GitHub merge"; ruling 20 (R15-1) says every one of them confirms first,
 * and ruling 42 (R17-1) says the confirm discloses the ACTUAL merge head when it
 * has drifted ahead of the reviewed revision. Three of the five never asked.
 */
describe("ruling 20 — every acceptance writer passes the confirm (pass 19)", () => {
  const acceptedPr = (patch: Record<string, unknown> = {}) =>
    ({
      number: 147,
      state: "accepted",
      title: "[VIB-151] Compress timelines",
      ...patch,
    }) as unknown as TaskDetail["pr"];

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

  const packetWith = (kind: string) =>
    ({
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
    }) as unknown as TaskDetail["packet"];

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
      displayReadiness: "accepted" as const,
      pr: {
        number: 147,
        state: "accepted",
        title: "[VIB-151] Compress timelines",
      } as unknown as TaskDetail["pr"],
    },
  };

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
        pr: { number: 147, state: "review", title: "x" } as TaskDetail["pr"],
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
      task: { pr: { number: 147, state: "accepted", title: "x" } as TaskDetail["pr"] },
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
        pr: { number: 147, state: "review", title: "x" } as TaskDetail["pr"],
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

  it("F19-36: the archive confirm names the PR state in the product's vocabulary, not the raw token", () => {
    // It printed "PR #147 accepted" / "PR #147 review" — the internal tokens —
    // on a dialog deciding a disposition. Second site of F19-14's defect.
    // Canary: print `task.pr.state` again and both assertions flip.
    const { container } = renderPage({
      myRole: "maintainer",
      task: {
        pr: { number: 147, state: "accepted", title: "x" } as TaskDetail["pr"],
      },
    });
    fireEvent.click(findButton(container, "Archive task")!);
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Archive task dialog"]',
    )!;
    expect(dialog.textContent).toContain("merge pending");
    expect(dialog.textContent).not.toContain("PR #147 accepted");
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
