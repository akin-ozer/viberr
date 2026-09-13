// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { rolesForAction } from "~/shared/rbac";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
} from "./execution-profile";
import type { TaskRunPrincipalView } from "./run-principal-view";

afterEach(cleanup);

/**
 * F19-11 — the human-owner cell described ownership as "open to any project
 * member" while the control rendered beside it, in the SAME cell, said "a
 * contributor or above can take it". `own-task` is admin/maintainer/contributor
 * (app/shared/rbac.ts) and a viewer IS a project member, so the first line
 * misdescribed the matrix — and a viewer saw both sentences at once.
 */

const deployedFixture: DeployedSpecialistView[] = [
  { id: "developer", name: "Developer", role: "Implementation", backend: "codex", model: "codex-large" },
];

/** An UNOWNED task — `owner: null` is the branch this finding lives in. The
 *  rest is a neutral projection row: nothing here is accepted/merged/archived,
 *  so the section renders its live controls. */
function unownedTask(): TaskSummary {
  return {
    key: "VIB-151",
    title: "Compress long-running task timelines",
    projectSlug: "viberr-core",
    stage: "impl",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "agent",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "healthy",
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: false,
    packet: null,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    repo: null,
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "Keep the console readable on long runs.",
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
  };
}

/** The same row, OWNED by the viewer — the fixture for anything that presses a
 *  run control, since ruling 127 refuses every run on a task with no owner to
 *  bill. */
function ownedTask(): TaskSummary {
  return {
    ...unownedTask(),
    owner: {
      kind: "human",
      userId: "u-arda",
      name: "Arda Kaya",
      initials: "AK",
      tone: "",
    },
  };
}

/** Ruling 127: the task owner whose accounts a run bills, both connected. The
 *  owner here is the VIEWER (`meId`), which is the ordinary case on a task
 *  somebody is working; the refusal tests below vary both halves. */
function connectedPrincipal(
  patch: Partial<TaskRunPrincipalView> = {},
): TaskRunPrincipalView {
  return {
    ownerUserId: "u-arda",
    ownerName: "Arda Kaya",
    claude: { available: true, detail: null },
    codex: { available: true, detail: null },
    ...patch,
  };
}

function renderExec(props: Partial<ComponentProps<typeof ExecutionProfile>> = {}) {
  return render(
    <MemoryRouter>
      <ExecutionProfile
        task={unownedTask()}
        meId="u-arda"
        myRole="admin"
        busy={false}
        onOwner={() => {}}
        deployedSpecialists={deployedFixture}
        stages={[]}
        workflow={[]}
        operatorBackend="claude"
        operatorAutonomy="supervised"
        runPrincipal={null}
        canRunAgents
        liveAgentRuns={[]}
        operatorRunActive={false}
        runBusy={false}
        onRunAgent={() => {}}
        releaseBusy={false}
        onReleaseAgent={() => {}}
        operatorBusy={false}
        onRunOperator={() => {}}
        schedules={[]}
        scheduleBusy={false}
        onCancelSchedule={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

// The unowned-eligibility line as the merged component actually ships it
// (execution-profile.tsx took Session B's file per RECONCILE §1.1). B words it
// "any contributor or above"; A's earlier copy said "a contributor or above".
// Both are TRUE against the RBAC matrix — `own-task` is admin/maintainer/
// contributor, viewer excluded (asserted directly below) — so F19-11's
// invariant (one eligibility line, matching the matrix, no contradicting
// sibling) holds under B's wording; the test tracks the shipped sentence.
const OWNERSHIP_COPY = "Unowned. Any contributor or above can take it";

describe("ExecutionProfile — unowned copy matches the RBAC matrix (F19-11)", () => {
  it("the matrix this copy claims: own-task excludes viewer", () => {
    // The copy says "a contributor or above". If the matrix ever widens
    // `own-task` to viewers (or narrows it past contributor), this test fails
    // FIRST and the sentence gets rewritten with it.
    const roles = rolesForAction("own-task");
    expect([...roles].sort()).toEqual(["admin", "contributor", "maintainer"]);
    expect(roles).not.toContain("viewer");
  });

  it("an unowned task never claims ownership is open to any project member", () => {
    const { container } = renderExec();
    expect(container.textContent).not.toContain("open to any project member");
  });

  it("admin: the eligibility line is stated once, next to the take affordance", () => {
    const { container, getAllByText } = renderExec({ myRole: "admin" });
    expect(getAllByText(OWNERSHIP_COPY)).toHaveLength(1);
    // The affordance itself is still offered to a role that holds `own-task`.
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Assign me"),
      ),
    ).toBe(true);
  });

  it("viewer: same single line, no take affordance, no contradicting sibling", () => {
    const { container, getAllByText } = renderExec({
      myRole: "viewer",
      canRunAgents: false,
    });
    expect(getAllByText(OWNERSHIP_COPY)).toHaveLength(1);
    // And it is the ONLY ownership sentence: the pre-fix render printed the
    // (wrong) cell copy AND the control's own sentence — two claims about who
    // may own, disagreeing, side by side in one cell.
    expect(getAllByText(/^Unowned/)).toHaveLength(1);
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Assign me"),
      ),
    ).toBe(false);
  });
});

/**
 * The operator run's steer input (pass 22). It is a SINGLE-LINE input, so Enter
 * submits (the search/chat convention) — deliberately NOT ⌘/Ctrl+Enter, which
 * the multi-line composer needs only because Enter is a newline there. The one
 * hazard is IME composition: an Enter that merely confirms a multibyte
 * candidate must not launch the billable operator run.
 */
describe("ruling 131(d): the run control on a held task", () => {
  const waits = () => ({
    ...ownedTask(),
    readiness: "blocked" as const,
    displayReadiness: "blocked" as const,
    waiting: "none" as const,
    blockedBy: [
      { ref: "goal-1 link 2", label: "goal-1 link 2", state: "open" as const, taskKey: null, goalId: "goal-1" },
      { ref: "JC-3", label: "JC-3", state: "done" as const, taskKey: "JC-3", goalId: null },
    ],
  });
  const runButton = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Run operator/.test(b.textContent ?? ""))!;

  it("renders the hold note as sub copy and leaves Run operator ENABLED (a manual run still answers a person)", () => {
    // Canary: pass the note through `blockedReason` and the button disables.
    const { container } = renderExec({ task: waits(), runPrincipal: connectedPrincipal() });
    const note = container.querySelector("[data-hold-note]")!;
    expect(note.textContent).toBe(
      "Waiting on other work (goal-1 link 2, JC-3). A manual run still answers you; the operator will not advance the task or dispatch delivery while it waits.",
    );
    expect(note.className).toContain("sub");
    expect(runButton(container).disabled).toBe(false);
  });

  it("an open packet keeps precedence: its reason renders and the button is disabled, the hold note is not shown", () => {
    const { container } = renderExec({
      task: {
        ...waits(),
        packet: { type: "blocked", kind: "Blocked decision", from: "operator", title: "t", body: "", observations: [], options: [] },
      },
      runPrincipal: connectedPrincipal(),
    });
    expect(container.querySelector("[data-hold-note]")).toBeNull();
    expect(container.textContent).toContain("Open decision. Resolve it before running the operator.");
    expect(runButton(container).disabled).toBe(true);
  });

  /**
   * Ruling 186 (pass 37, F37-2). The OPERATOR control stays enabled on a held
   * task — a manual run still answers a person. The AGENT control does not:
   * since ruling 186 the server refuses every dispatch onto a held task, so the
   * words before the click have to be the words the server answers with.
   */
  const agentRunButton = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "Run" && /agent/i.test(b.title),
    );

  it("ruling 186: the AGENT run control is disabled on a held task and says why", () => {
    const { container } = renderExec({
      task: waits(),
      runPrincipal: connectedPrincipal(),
    });
    const btn = agentRunButton(container);
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    // The server's own sentence, from the shared `holdRefusal`.
    expect(container.textContent).toContain(
      "waits on goal-1 link 2 and JC-3 and Viberr is holding it",
    );
    expect(container.textContent).toContain("running an agent on it is refused");
  });

  it("ruling 186: a task that waits on nothing leaves the agent control alone", () => {
    const { container } = renderExec({
      task: { ...waits(), blockedBy: [], readiness: "ready", displayReadiness: "ready" },
      runPrincipal: connectedPrincipal(),
    });
    expect(container.textContent).not.toContain("Viberr is holding it");
  });
});

describe("OperatorRunControl steer input — Enter submits, IME-guarded", () => {
  function renderWithRunSpy() {
    const calls: string[] = [];
    // Ruling 127: a run needs an owner to bill, so the steer tests run on an
    // OWNED task whose owner has connected both backends.
    const utils = renderExec({
      task: ownedTask(),
      runPrincipal: connectedPrincipal(),
      onRunOperator: (s) => calls.push(s),
    });
    // Both run controls carry an `.op-steer` input now (PromptInput is shared
    // with the agent prompt) — the aria-label is the operator one's identity.
    const input = utils.container.querySelector<HTMLInputElement>(
      'input[aria-label="Steer this operator run (optional)"]',
    )!;
    return { calls, input };
  }

  it("a bare Enter runs the operator with the trimmed steer text", () => {
    const { calls, input } = renderWithRunSpy();
    fireEvent.change(input, { target: { value: "  focus on the flaky test  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toEqual(["focus on the flaky test"]);
  });

  it("an Enter that only confirms an IME candidate does NOT launch the run (Chrome + Safari)", () => {
    const { calls, input } = renderWithRunSpy();
    fireEvent.change(input, { target: { value: "日本語" } });
    // Chrome/Firefox: the committing keydown carries isComposing = true.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // Safari/WebKit: compositionend fires FIRST, so isComposing is already
    // false and only the legacy keyCode 229 marks the composition commit.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(calls).toEqual([]);
    // A real Enter after composition ends still submits.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toEqual(["日本語"]);
  });
});

/**
 * F3 (owner ruling 2026-08-21) / F20-4: a real run can show an agent's model is
 * not runnable on the account (model_availability). Surface it BEFORE another
 * run is spent. The dispatch rework moved the warning to the two places a run
 * now starts or shows: the run control (on the SELECTED agent) and the
 * engaged-agents ledger rows (F28-P2-gated to the live deployment's backend).
 */
describe("model-unavailable warnings — run control + ledger rows", () => {
  const withDeveloper = (): TaskSummary => ({
    ...unownedTask(),
    specialist: {
      kind: "agent",
      profileId: "developer",
      backend: "codex",
      name: "Codex",
      role: "Implementation",
    },
  });
  const unavailNote = (container: HTMLElement) =>
    [...container.querySelectorAll(".deny-note")].find((n) =>
      /reported this model unavailable/.test(n.textContent ?? ""),
    );

  it("renders the provider's reason on the delivering engagement's ledger row", () => {
    const { container } = renderExec({
      task: withDeveloper(),
      deployedSpecialists: [
        {
          ...deployedFixture[0]!,
          id: "developer",
          backend: "codex",
          modelUnavailable: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      ],
    });
    const note = [...container.querySelectorAll(".rev-agent .deny-note")].find(
      (n) => /reported this model unavailable/.test(n.textContent ?? ""),
    );
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain("Codex reported this model unavailable");
    expect(note!.textContent).toContain("not supported when using Codex");
  });

  it("shows NO warning when the model is available (the common case)", () => {
    const { container } = renderExec({
      task: withDeveloper(),
      deployedSpecialists: [
        { ...deployedFixture[0]!, id: "developer", backend: "codex" },
      ],
    });
    expect(unavailNote(container)).toBeUndefined();
  });

  it("the run control warns on the SELECTED agent, before Run is pressed", () => {
    const { container } = renderExec({
      deployedSpecialists: [
        {
          ...deployedFixture[0]!,
          id: "developer",
          backend: "codex",
          modelUnavailable: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      ],
    });
    const control = container.querySelector(".agent-run")!;
    // Nothing selected yet → no warning to warn about.
    expect(control.querySelector(".deny-note")).toBeNull();
    fireEvent.focus(
      container.querySelector('input[aria-label="Choose an agent to run"]')!,
    );
    fireEvent.click(
      [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
        (o) => o.textContent?.includes("Developer"),
      )!,
    );
    const note = control.querySelector(".deny-note")!;
    expect(note.textContent).toContain("Codex reported this model unavailable");
    // Informs, does not block: the provider's own sentence + the way out.
    expect(note.textContent).toContain("Provider said:");
    expect(note.textContent).toContain("not supported when using Codex");
  });

  it("warns on a supporting (reviewer) ledger row too, not only the delivering one", () => {
    const task: TaskSummary = {
      ...withDeveloper(),
      reviewers: [
        {
          kind: "agent",
          profileId: "reviewer",
          backend: "claude",
          name: "Claude",
          role: "Review & validation",
        },
      ],
    };
    const { container } = renderExec({
      task,
      deployedSpecialists: [
        { ...deployedFixture[0]!, id: "developer", backend: "codex" },
        {
          ...deployedFixture[0]!,
          id: "reviewer",
          backend: "claude",
          role: "Review & validation",
          modelUnavailable:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      ],
    });
    const revNote = [...container.querySelectorAll(".rev-agent .deny-note")].find(
      (n) => /reported this model unavailable/.test(n.textContent ?? ""),
    );
    expect(revNote).toBeTruthy();
    expect(revNote!.textContent).toContain("not supported when using Codex");
  });
});

/**
 * Ruling 127 — every run control on this panel answers for the task OWNER.
 *
 * The panel used to take one deployment-wide `backendAvailable` boolean pair,
 * so a disabled Run could only ever say "the backend isn't configured on this
 * instance" — a sentence that named a credential nobody can set any more, and
 * a fix nobody on this page could perform. A run bills the owner's own
 * account, so the refusal names the person, and the two refusals are kept
 * apart: an UNOWNED task has nobody to bill (no backend switch fixes it), a
 * connected-less owner has an account that has not been connected yet.
 *
 * P11-41's "would fail fast" behaviour is unchanged: the run that would refuse
 * is refused HERE, before it is spent, and a SCHEDULED run stays available
 * (the owner can connect the backend, or the seat can change hands, before it
 * fires).
 */
describe("ruling 127: the run controls answer for the task owner", () => {
  const operatorRun = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLButtonElement>(".op-run > button")].find(
      (b) => /Run operator|Schedule/.test(b.textContent ?? ""),
    )!;
  const dispatchRun = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-run > button"),
    ].find((b) => /^(Run|Schedule)$/.test(b.textContent?.trim() ?? ""))!;
  const pickDeveloper = (container: HTMLElement) => {
    fireEvent.focus(
      container.querySelector('input[aria-label="Choose an agent to run"]')!,
    );
    fireEvent.click(
      [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
        (o) => o.textContent?.includes("Developer"),
      )!,
    );
  };

  it("an UNOWNED task refuses every run, and says who has to fix it", () => {
    const calls: string[] = [];
    const { container } = renderExec({
      runPrincipal: null,
      onRunOperator: (s) => calls.push(s),
    });
    expect(operatorRun(container).disabled).toBe(true);
    expect(container.textContent).toContain("Own this task to run agents");
    expect(container.textContent).toContain(
      "Agent runs use the task owner's accounts, and this task has none",
    );
    // The dispatch refuses the same way, once a pick makes a run possible.
    pickDeveloper(container);
    expect(dispatchRun(container).disabled).toBe(true);
    // And the row itself says it before the pick is made.
    fireEvent.focus(
      container.querySelector('input[aria-label="Choose an agent to run"]')!,
    );
    expect(
      [...container.querySelectorAll('[role="option"]')].some((o) =>
        o.textContent?.includes("no task owner"),
      ),
    ).toBe(true);
    // Nothing is claimed about a deployment credential: there is none.
    expect(container.textContent).not.toContain("on this instance");
    expect(container.textContent).not.toContain("environment");
  });

  it("names the OWNER when the viewer is somebody else, and points at their Profile", () => {
    const { container } = renderExec({
      task: ownedTask(),
      meId: "u-bea",
      operatorBackend: "codex",
      runPrincipal: connectedPrincipal({
        ownerName: "Ada Lovelace",
        codex: {
          available: false,
          detail: "Codex isn't connected. Connect it on your Profile → Agent accounts.",
        },
      }),
    });
    expect(operatorRun(container).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Codex isn't connected for Ada Lovelace, the task owner",
    );
    expect(container.textContent).toContain(
      "they can connect Codex on Profile → Agent accounts",
    );
    // Never the second-person sentence: "your Profile" is false advice for a
    // teammate who cannot connect somebody else's account.
    expect(container.textContent).not.toContain("on your Profile");
  });

  it("addresses the OWNER themselves in the store's own words (a wiped runtime volume)", () => {
    const wiped =
      "Your Codex sign-in file is missing from this server (the runtime volume was wiped). " +
      "Sign in again on your Profile → Agent accounts.";
    const { container } = renderExec({
      task: ownedTask(),
      meId: "u-arda",
      operatorBackend: "codex",
      runPrincipal: connectedPrincipal({
        codex: { available: false, detail: wiped },
      }),
    });
    expect(container.textContent).toContain(wiped);
    expect(container.textContent).toContain(
      "Runs on this task use your own account",
    );
  });

  it("refuses the run NOW but keeps SCHEDULING alive (the owner can connect it first)", () => {
    const { container } = renderExec({
      task: ownedTask(),
      operatorBackend: "codex",
      runPrincipal: connectedPrincipal({
        codex: { available: false, detail: null },
      }),
    });
    expect(operatorRun(container).disabled).toBe(true);
    fireEvent.change(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="When the operator run starts"]',
      )!,
      { target: { value: "60" } },
    );
    const later = operatorRun(container);
    expect(later.disabled).toBe(false);
    expect(later.textContent).toContain("Schedule");
  });

  it("a dispatch is judged on the PICKED agent's backend, not the operator's", () => {
    // The roster's Developer runs on Codex; the operator is on Claude. Claude
    // is connected and Codex is not, so the operator control runs and the
    // dispatch refuses — one panel, two different answers, both true.
    const { container } = renderExec({
      task: ownedTask(),
      meId: "u-bea",
      operatorBackend: "claude",
      runPrincipal: connectedPrincipal({
        ownerName: "Ada Lovelace",
        codex: { available: false, detail: null },
      }),
    });
    expect(operatorRun(container).disabled).toBe(false);
    pickDeveloper(container);
    expect(dispatchRun(container).disabled).toBe(true);
    expect(container.querySelector(".agent-run")!.textContent).toContain(
      "Codex isn't connected for Ada Lovelace",
    );
  });
});

/**
 * Pass 35 U35-7 (screenshot 65): the engaged-agent card said "running…" for an
 * engagement whose live run was still QUEUED behind the concurrency cap. The
 * word follows the run's lifecycle now. Canary: make `liveAgentRunLabel`
 * return "running…" for any live run and the queued assertion fails.
 */
describe("the engaged-agent card names the live run's lifecycle", () => {
  const engaged = (): TaskSummary => ({
    ...ownedTask(),
    specialist: {
      kind: "agent",
      profileId: "developer",
      backend: "codex",
      name: "Codex",
      role: "Implementation",
    },
  });
  const row = (container: HTMLElement) =>
    [...container.querySelectorAll(".rev-agent")].find((r) => r.textContent?.includes("Developer"))!;

  it("says queued for a queued live run", () => {
    const { container } = renderExec({
      task: engaged(),
      liveAgentRuns: [{ profileId: "developer", lifecycle: "queued" }],
    });
    const sub = row(container).querySelector(".sub")!.textContent!;
    expect(sub).toContain("· queued");
    expect(sub).not.toContain("running…");
  });

  it("says running… once the run executes, and running wins over a queued sibling", () => {
    const { container } = renderExec({
      task: engaged(),
      liveAgentRuns: [
        { profileId: "developer", lifecycle: "queued" },
        { profileId: "developer", lifecycle: "running" },
      ],
    });
    const sub = row(container).querySelector(".sub")!.textContent!;
    expect(sub).toContain("· running…");
    expect(sub).not.toContain("queued");
  });

  it("says nothing with no live run", () => {
    const { container } = renderExec({ task: engaged(), liveAgentRuns: [] });
    const sub = row(container).querySelector(".sub")!.textContent!;
    expect(sub).not.toContain("queued");
    expect(sub).not.toContain("running…");
  });
});
