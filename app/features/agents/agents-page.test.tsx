// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { createRoutesStub, useSearchParams } from "react-router";
import {
  deploymentDot,
  type AgentDeploymentView,
  type AgentProfileView,
  type LibraryProfileView,
} from "./agent-types";
import type { ResCatalogGroup } from "./capability-catalog";
import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";
import { CapabilityMatrixModal } from "./capability-matrix-modal";
import {
  CreateProfileModal,
  type ProfileFormPayload,
} from "./create-profile-modal";
import {
  AgentsPage,
  LibraryPicker,
  LiveRoster,
  ProfileDetail,
  type BackendHealthMap,
} from "./agents-page";
import { ToastProvider } from "~/ui/toast";
import { capabilityById } from "~/shared/capabilities";
import type { ProjectRole } from "~/shared/rbac";
import { TRANSITION_TO_DONE_EXCEPTION } from "~/features/policy/policy-data";

afterEach(cleanup);

/**
 * F19-12 lineage, re-anchored by the dynamic-dispatch rework (ruling 98): the
 * capability LABEL is rendered copy (capability matrix, profile detail panel,
 * policy page), and the id is the persisted key — now `dispatch-agents`, the
 * collapsed assign/summon pair. Read the label from the REAL catalog so this
 * fixture can never drift from what the app renders, and pin the string
 * itself inside the matrix test below: reverting `app/shared/capabilities.ts`
 * to the retired slot vocabulary turns that assertion red.
 */
const DISPATCH_AGENTS_LABEL = capabilityById("dispatch-agents")!.label;

/** Curated-ish catalogs the stub's /resources/model-catalog loader returns. */
const CLAUDE_CATALOG: ModelCatalog = {
  models: [
    { value: "sonnet", displayName: "Claude Sonnet", description: "Balanced.", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { value: "opus", displayName: "Claude Opus", description: "Most capable.", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultModel: "sonnet",
  defaultEffort: "high",
};
const CODEX_CATALOG: ModelCatalog = {
  models: [
    { value: "gpt-5-codex", displayName: "GPT-5 Codex", description: "Coding.", supportsEffort: true, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  defaultModel: "gpt-5-codex",
  defaultEffort: "medium",
};

/** Render CreateProfileModal inside a route stub so its useFetcher for the
 * model catalog has a data router + a loader to hit. */
function renderModal(props: {
  initial: AgentProfileView | null;
  error?: string | null;
  onSubmit?: (p: ProfileFormPayload) => void;
  onClose?: () => void;
  resourceCatalog?: ResCatalogGroup[];
  /** Ruling 127: the VIEWER's own connections. Omitted = not probed. */
  viewerConnected?: Record<"codex" | "claude", boolean>;
}): RenderResult {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <CreateProfileModal
          initial={props.initial}
          stages={STAGES}
          projectName="Viberr Core"
          busy={false}
          error={props.error ?? null}
          onClose={props.onClose ?? (() => {})}
          onSubmit={props.onSubmit ?? (() => {})}
          {...(props.resourceCatalog
            ? { resourceCatalog: props.resourceCatalog }
            : {})}
          {...(props.viewerConnected
            ? { viewerConnected: props.viewerConnected }
            : {})}
        />
      ),
    },
    {
      path: "/resources/model-catalog",
      loader: ({ request }) => {
        const backend = new URL(request.url).searchParams.get("backend");
        return { data: backend === "codex" ? CODEX_CATALOG : CLAUDE_CATALOG };
      },
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "ready", name: "Ready", color: "teal" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

/** R14-1: eligibility resolves declared ids against the board BY ROLE too, so
 *  every stage surface needs the board's edges, not just its stage list. */
const WORKFLOW = [
  { from: "triage", to: "ready" },
  { from: "ready", to: "impl" },
  { from: "impl", to: "review" },
  { from: "review", to: "done" },
];

/** The legacy 3-stage board of P14-WL-01 (`Lightweight Lab`): none of the
 *  governed template's stage ids exist here, which is exactly the case R14-1
 *  resolves by role. */
const LIGHTWEIGHT_BOARD = [
  { id: "todo", name: "To do", color: "slate" },
  { id: "doing", name: "Doing", color: "violet" },
  { id: "done", name: "Done", color: "green" },
];
const LIGHTWEIGHT_WORKFLOW = [
  { from: "todo", to: "doing" },
  { from: "doing", to: "done" },
];

function mkProfile(patch: Partial<AgentProfileView>): AgentProfileView {
  return {
    fingerprint: "fp-fixture",
    id: "developer",
    kind: "specialist",
    name: "Developer",
    role: "Implementation",
    icon: "branch",
    backends: ["codex", "claude"],
    model: "codex-large · claude-sonnet",
    modelLabel: "GPT-5.5",
    modelKnown: false,
    effort: "",
    // F17: the phantom-workspace literal is gone from the seed; the fixture
    // must not keep teaching it (see agent-catalog.server.test.ts).
    scope: "Global base",
    // OBS-7: the default fixture is a deployment that still tracks its global
    // base; the fork case sets this explicitly.
    customized: false,
    // Ruling 156: the grants signal beside it; the drift case sets it.
    templateDrift: null,
    desc: "Implements stage work on the task-key branch.",
    definition: "",
    stages: ["ready", "impl"],
    spanAll: false,
    actions: {
      direct: ["Create the task-key branch", "Commit & push to the branch"],
      recommend: ["Move the task to Review"],
      forbidden: ["Merge a pull request", "Transition a task to Done"],
    },
    capabilities: [
      { capabilityId: "create-task-branch", mode: "direct" },
      { capabilityId: "commit-push-branch", mode: "direct" },
      { capabilityId: "move-task-to-review", mode: "recommend" },
      { capabilityId: "merge-pull-request", mode: "human" },
      { capabilityId: "transition-to-done", mode: "human" },
    ],
    extras: [],
    resources: { skills: ["repo-write"], mcps: ["github"], kb: [] },
    source: "template",
    ...patch,
  };
}

function mkDeployment(patch: Partial<AgentDeploymentView>): AgentDeploymentView {
  return {
    profileId: "developer",
    role: "Developer",
    backend: "codex",
    engagement: "primary",
    taskKey: "VIB-142",
    taskTitle: "Attach execution workspace to task runtime",
    status: "waiting on human",
    running: false,
    taskWaiting: "human",
    ...patch,
  };
}

describe("ProfileDetail", () => {
  it("renders hero, stage chips, cap columns, resources and deployments", () => {
    const onOpen = vi.fn();
    const { container, getByText } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[mkDeployment({})]}
        projectName="Viberr Core"
        canManage
        onOpen={onOpen}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(getByText("Developer")).toBeTruthy();
    expect(getByText("2 of 5 stages")).toBeTruthy();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(2);
    expect(container.querySelectorAll(".cap-col")).toHaveLength(3);
    expect(getByText("Acts directly")).toBeTruthy();
    expect(getByText("Human-only")).toBeTruthy();
    // The default deployment is `running: false` (waiting on human), so the hero
    // reports it as ENGAGED, not running — the fix for the false "running on N".
    expect(getByText("idle · engaged on 1 task")).toBeTruthy();
    // Deployment row navigates by task key.
    fireEvent.click(container.querySelector(".deploy-row")!);
    expect(onOpen).toHaveBeenCalledWith("VIB-142");
  });

  it("hero says 'running on N tasks' only for deployments with a LIVE run", () => {
    // Two engagements, one actually running. The count reflects the live run,
    // not the two idle engagements (the old code counted every task key).
    const { getByText, queryByText } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[
          mkDeployment({ taskKey: "VIB-142", running: true }),
          mkDeployment({ taskKey: "VIB-143", running: false }),
        ]}
        projectName="Viberr Core"
        canManage
        onOpen={vi.fn()}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(getByText("running on 1 task")).toBeTruthy();
    expect(queryByText(/engaged on/)).toBeNull();
  });

  /**
   * OBS-4 (live): a SUPERVISED operator moved Triage→Ready and Ready→In
   * Progress itself while this card listed "Stage transitions" flatly under
   * RECOMMENDS ONLY. Both are true — the mode governs the boundaries the
   * workflow GATES, and an auto-advance boundary has no approval to recommend
   * into — so the column is a simplification that reads as a promise. The card
   * qualifies it where the qualifier applies: the operator's recommend column.
   */
  it("OBS-4: the operator card qualifies a recommend-only Stage transitions row", () => {
    const note = (a: Parameters<typeof mkProfile>[0]) =>
      render(
        <ProfileDetail
          a={mkProfile(a)}
          stages={STAGES}
          workflow={WORKFLOW}
          insts={[]}
          projectName="Viberr Core"
          canManage
          onOpen={() => {}}
          onDelete={() => {}}
          onEdit={() => {}}
        />,
      ).container.textContent ?? "";

    const operatorActions = {
      direct: ["Assign the delivering agent"],
      recommend: ["Stage transitions"],
      forbidden: ["Transition a task to Done"],
    };
    const qualified = note({ kind: "operator", name: "Operator", role: "Orchestration", actions: operatorActions });
    // Non-vacuity: the row this note is about really is in the column.
    expect(qualified).toContain("Stage transitions");
    expect(qualified).toContain("is a recommendation at the boundaries this project gates");
    expect(qualified).toContain("Auto-advance");
    cleanup();

    // The same operator with the grant DIRECT has nothing to qualify.
    const direct = note({
      kind: "operator",
      name: "Operator",
      role: "Orchestration",
      actions: { ...operatorActions, direct: ["Stage transitions"], recommend: [] },
    });
    expect(direct).toContain("Stage transitions");
    expect(direct).not.toContain("is a recommendation at the boundaries");
    cleanup();

    // A specialist never holds the capability, so its card never says this.
    expect(note({ actions: operatorActions })).not.toContain(
      "is a recommendation at the boundaries",
    );
  });

  /**
   * OBS-7 (live): Developer, deployed from the global base and then edited in
   * the project, kept the flat "Global base" scope line — while the edit modal
   * promises the save "keeps its own copy and stops tracking the global". The
   * header carries BOTH facts now: where the profile came from, and that this
   * project's copy has diverged. An untracked profile is untouched.
   */
  it("OBS-7: a forked global profile says it is customized; an untouched one does not", () => {
    const scopeLine = (a: Parameters<typeof mkProfile>[0]) =>
      render(
        <ProfileDetail
          a={mkProfile(a)}
          stages={STAGES}
          workflow={WORKFLOW}
          insts={[]}
          projectName="Viberr Core"
          canManage
          onOpen={() => {}}
          onDelete={() => {}}
          onEdit={() => {}}
        />,
      ).container.querySelector(".ag-scope")!.textContent;

    expect(scopeLine({ scope: "Global base", customized: false })).toBe(
      "Global base",
    );
    cleanup();
    expect(scopeLine({ scope: "Global base", customized: true })).toBe(
      "Global base · customized for Viberr Core",
    );
    cleanup();
    // A profile created in the project already names it — nothing is appended.
    expect(
      scopeLine({ scope: "Created in Viberr Core", customized: false }),
    ).toBe("Created in Viberr Core");
  });

  /**
   * Ruling 156 (pass 35, F35-7): a library deploy COPIES the template's grants,
   * and a run mounts that copy, so a template grant never reached this project
   * while the card read "MCP servers: None" with no divergence marker. The
   * card names the exact difference under each list and on the scope line;
   * only an org admin gets the button (owner, Q35-8). Canary: drop the `drift`
   * prop from the MCP `ResGroup`.
   */
  it("ruling 156: a copy whose grants differ says so, and only an org admin gets the button", () => {
    const templateDrift = {
      missing: { skills: [], mcps: ["context7"], kb: [] },
      extra: { skills: ["k8s-notes"], mcps: [], kb: [] },
      templateResources: { skills: [], mcps: ["context7"], kb: [] },
    };
    const onSync = vi.fn();
    const detail = (canSyncTemplate: boolean) => (
      <ProfileDetail
        a={mkProfile({
          templateDrift,
          resources: { skills: ["k8s-notes"], mcps: [], kb: [] },
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        canSyncTemplate={canSyncTemplate}
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
        onSyncResources={onSync}
      />
    );
    const { container, getByText } = render(detail(true));
    expect(container.querySelector(".ag-scope")!.textContent).toBe(
      "Global base · grants differ from the template",
    );
    expect(
      getByText("Differs from the template: context7 is granted there, not here."),
    ).toBeTruthy();
    expect(
      getByText("Differs from the template: k8s-notes is granted here, not on the template."),
    ).toBeTruthy();
    fireEvent.click(getByText("Use the template's grants"));
    expect(onSync).toHaveBeenCalledTimes(1);
    cleanup();

    // A project admin who is not an org admin: the marker, never the button.
    const { queryByText, container: again } = render(detail(false));
    expect(queryByText("Use the template's grants")).toBeNull();
    expect(again.querySelector(".ag-scope")!.textContent).toContain(
      "grants differ from the template",
    );
    cleanup();

    // A copy that matches its template says nothing about grants.
    const { container: clean, queryByText: none } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        canSyncTemplate
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(clean.querySelector(".ag-scope")!.textContent).toBe("Global base");
    expect(none(/Differs from the template/)).toBeNull();
    expect(none("Use the template's grants")).toBeNull();
  });

  it("ruling 156: the page's button submits sync-profile-resources with the record it rendered", async () => {
    let posted: Record<string, string> | null = null;
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[
                mkProfile({
                  fingerprint: "fp-live",
                  templateDrift: {
                    missing: { skills: [], mcps: ["context7"], kb: [] },
                    extra: { skills: [], mcps: [], kb: [] },
                    templateResources: { skills: [], mcps: ["context7"], kb: [] },
                  },
                }),
              ]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
              viewerIsOrgAdmin
            />
          </ToastProvider>
        ),
        action: async ({ request }) => {
          const fd = await request.formData();
          posted = {};
          for (const [k, v] of fd.entries()) posted[k] = String(v);
          return { ok: true, toast: "stub done", profileId: "developer" };
        },
      },
    ]);
    const { getByText } = render(
      <Stub initialEntries={["/projects/viberr-core/agents?profile=developer"]} />,
    );
    fireEvent.click(getByText("Use the template's grants"));
    await waitFor(() =>
      expect(posted).toMatchObject({
        intent: "sync-profile-resources",
        profileId: "developer",
        fingerprint: "fp-live",
      }),
    );
  });

  /**
   * F15-05/F15-06 (live): admins read this panel as policy truth. A profile
   * created with nothing granted showed a full ACTS DIRECTLY column — "Approve
   * the review", "Request changes", "Post quality-flag events" and the rest of
   * the advisory catalog — plus a context resource nobody picked. The columns
   * now render GOVERNED policy only (the partition the matrix draws), and
   * advisory guidance says what it is.
   */
  it("says 'advisory on Codex' once on the row where both reasons apply", () => {
    // The repo-write row satisfies BOTH hint conditions on a Codex profile —
    // the Claude-only-enforcement one and ruling 185's carve-out — and each
    // used to render its own span, so the row read "Execute code or write to
    // the repo · advisory on Codex · advisory on Codex". Same four words twice,
    // with the only difference buried in a tooltip nobody opens. The card makes
    // each claim ONCE (F15-09).
    //
    // Canary: restore the two separate `{claudeOnly && …}{carveOut && …}` spans.
    const { container } = render(
      <ProfileDetail
        a={mkProfile({
          id: "codex-dev",
          name: "Codex developer",
          role: "Implementation",
          backends: ["codex"],
          model: "gpt-5-codex",
          actions: {
            direct: [],
            recommend: [],
            forbidden: ["Execute code or write to the repo"],
            off: [],
          },
          capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: "off" }],
          resources: { skills: [], mcps: [], kb: [] },
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    const row = [...container.querySelectorAll(".cap-item")].find((el) =>
      (el.textContent ?? "").includes("Execute code or write to the repo"),
    );
    expect(row).toBeTruthy();
    expect(row!.querySelectorAll(".fhint")).toHaveLength(1);
    // And the one that survives is the SPECIFIC one: it says why the
    // withholding is advisory on this runtime, not merely that it is.
    expect(row!.querySelector(".fhint")!.getAttribute("title")).toContain(
      "ruling 185",
    );
  });

  it("a fresh minimal profile claims no verdict authority and no skills", () => {
    const { container, getByText, queryByText } = render(
      <ProfileDetail
        a={mkProfile({
          id: "docs-writer",
          name: "Docs writer",
          role: "Docs",
          // What the honest derivation yields for a newly created profile: the
          // governed toggles withheld, advisory guidance at its catalog default.
          actions: {
            direct: [
              "Read the repository & diff",
              "Read the task & repository",
            ],
            recommend: [],
            forbidden: [
              "Merge a pull request",
              "Transition a task to Done",
              "Change project policy",
            ],
            off: [
              "Execute code or write to the repo",
              "Report a validation verdict",
              "Approve the review",
              "Request changes",
              "Post quality-flag events",
            ],
          },
          capabilities: [
            { capabilityId: "execute-code-or-write-repo", mode: "off" },
            { capabilityId: "report-validation-verdict", mode: "off" },
          ],
          resources: { skills: [], mcps: [], kb: [] },
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    // No verdict authority anywhere in the capability columns.
    const cols = container.querySelector(".cap-cols")!;
    expect(cols.textContent).not.toContain("Approve the review");
    expect(cols.textContent).not.toContain("Request changes");
    expect(cols.textContent).not.toContain("Post quality-flag events");
    // Advisory guidance is segregated and labelled, never "Acts directly".
    expect(
      container.querySelector(".cap-col.direct")!.textContent,
    ).not.toContain("Read the repository & diff");
    // R15-12: collapsed into its own labelled group rather than disclosed
    // inline above the binding grants — but still IN the DOM and still counted,
    // because hiding it was the option that was rejected.
    const advisory = container.querySelector(".cap-advisory")!;
    expect(advisory).toBeTruthy();
    expect(advisory.querySelector("summary")!.textContent).toContain(
      "Advisory only",
    );
    expect(getByText(/Nothing in the runtime enforces them/)).toBeTruthy();
    // …and it keeps each label's MODE. Concatenating the three buckets made an
    // advisory capability an admin set to human-only read exactly like one left
    // at "acts directly" — the same disagreement class F15-05 was filed for,
    // one level quieter (the matrix still tells them apart).
    const advisoryLine = advisory.textContent!;
    expect(advisoryLine).toContain("Read the repository & diff (acts directly)");
    // The structural human-only locks still render as such.
    expect(
      container.querySelector(".cap-col.forbidden")!.textContent,
    ).toContain("Merge a pull request");
    // D32-8 (pass 32): the empty RECOMMENDS ONLY bucket says "None" under its
    // header instead of rendering a header over nothing.
    expect(container.querySelector(".cap-col.recommend")!.textContent).toContain("None");
    // Nothing was granted as a context resource — all three groups say None.
    expect(container.querySelectorAll(".res-group").length).toBe(3);
    expect(queryByText("reviewer-expertise")).toBeNull();
    expect(container.querySelectorAll(".res-chip").length).toBe(0);
  });

  it("the advisory line keeps each label's mode instead of flattening them", () => {
    const { container } = render(
      <ProfileDetail
        a={mkProfile({
          id: "docs-writer",
          name: "Docs writer",
          role: "Docs",
          actions: {
            direct: ["Read the repository & diff"],
            recommend: [],
            // An advisory capability the admin explicitly reserved for humans:
            // it used to read identically to the `direct` one above.
            forbidden: ["Approve the review"],
            off: [],
          },
          capabilities: [],
          resources: { skills: [], mcps: [], kb: [] },
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    // R15-12: one <li> per capability now, so the mode travels with its own
    // label instead of riding a single joined sentence.
    const items = [
      ...container.querySelectorAll(".cap-advisory-body li"),
    ].map((li) => li.textContent!);
    expect(items).toContain("Read the repository & diff (acts directly)");
    expect(items).toContain("Approve the review (human-only)");
    // Collapsed by DEFAULT — the whole point is that it stops competing with
    // the grants that actually bind. Canary: add `open` to the <details>.
    expect(
      container.querySelector(".cap-advisory")!.hasAttribute("open"),
    ).toBe(false);
    // The count is visible without expanding, so nothing looks omitted.
    expect(container.querySelector(".cap-advisory summary")!.textContent).toContain(
      "Advisory only · 2 lines",
    );
  });

  it("operator: no Delete button, real backend + autonomy cells, lifecycle hint", () => {
    const { container, getByText, queryByText } = render(
      <ProfileDetail
        a={mkProfile({
          id: "operator",
          kind: "operator",
          name: "Operator",
          role: "Task coordinator",
          icon: "shield",
          spanAll: true,
          backends: ["claude", "codex"],
          autonomy: "supervised",
          model: "claude-sonnet-4-5",
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(queryByText("Delete")).toBeNull();
    expect(getByText("Edit profile")).toBeTruthy();
    expect(getByText("active across the whole lifecycle")).toBeTruthy();
    // The operator now shows its real backends + autonomy (not a placeholder).
    expect(getByText("Claude")).toBeTruthy();
    expect(getByText("Supervised")).toBeTruthy();
    expect(container.querySelector(".agent-glyph.op")).not.toBeNull();
    expect(getByText("idle · available")).toBeTruthy();
    expect(
      getByText(
        "Not currently engaged on any task. This profile is approved and available for assignment.",
      ),
    ).toBeTruthy();
  });

  it("delete flows through the inline alertdialog confirm", () => {
    const onDelete = vi.fn();
    const { container, getByText } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[mkDeployment({})]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={onDelete}
        onEdit={() => {}}
      />,
    );
    fireEvent.click(getByText("Delete"));
    // Ruling 455(f): the shared ConfirmDialog, named by its title, with the
    // confirm button's glyph kept.
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Delete the Developer profile?");
    expect(dialog.getAttribute("data-screen-label")).toBe("Profile deletion dialog");
    expect(getByText("Delete the Developer profile?")).toBeTruthy();
    expect(getByText("1 active task")).toBeTruthy();
    expect(getByText("Delete profile").closest("button")!.querySelector("svg")).not.toBeNull();
    fireEvent.click(getByText("Delete profile"));
    expect(onDelete).toHaveBeenCalledWith("developer");
  });

  // P13-LV-02 — the eligible-stage panel used to contradict itself: it ignored
  // `spanAll` (the Operator's header said "active across the whole lifecycle"
  // while every chip rendered struck through), counted stage ids the board
  // doesn't have (a profile with stale grants read "5 of 4 stages"), and gave
  // no clue at all when NONE of a profile's stages exist on this board.
  it("LV-02: spanAll lights every chip and the counter never exceeds the board", () => {
    const { container, getByText } = render(
      <ProfileDetail
        a={mkProfile({ id: "operator", kind: "operator", spanAll: true })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(getByText("active across the whole lifecycle")).toBeTruthy();
    // Every board stage is eligible — none struck through.
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(
      STAGES.length,
    );
    expect(container.querySelectorAll(".stage-chip.off")).toHaveLength(0);
  });

  it("R14-1: a declared id that no stage here fills BY ROLE resolves onto this board", () => {
    // The Lightweight board (P14-WL-01): ids `todo/doing/done`, so the
    // governed `ready`/`impl` grants match no id at all. Before R14-1 the panel
    // read "0 of 3 stages" with every chip struck through and the profile was
    // unassignable; `impl` names the WORK role, and this board's work stage is
    // `doing` (its entry stage `todo` fills work too on a board this short).
    const { container, getByText, queryByText } = render(
      <ProfileDetail
        a={mkProfile({ stages: ["ready", "impl"] })}
        stages={LIGHTWEIGHT_BOARD}
        workflow={LIGHTWEIGHT_WORKFLOW}
        insts={[]}
        projectName="Lightweight Lab"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(getByText("2 of 3 stages")).toBeTruthy();
    expect(queryByText("0 of 3 stages")).toBeNull();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(2);
    // `impl` resolved by role, so it is NOT a dead grant …
    expect(queryByText("impl · not on this board")).toBeNull();
    // … while `ready` — a role no stage on this 3-stage board fills — is.
    expect(getByText("ready · not on this board")).toBeTruthy();
  });

  it("R14-1: a declaration that lands nowhere leaves the profile eligible everywhere", () => {
    const { container, getByText } = render(
      <ProfileDetail
        // Neither id is a stage here and neither names a known role, so the
        // declaration says nothing about this workflow. Rule 3: unrestricted —
        // silently disabling every agent is the failure we actually observed.
        a={mkProfile({ stages: ["spec-review", "handoff"] })}
        stages={LIGHTWEIGHT_BOARD}
        workflow={LIGHTWEIGHT_WORKFLOW}
        insts={[]}
        projectName="Lightweight Lab"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(
      getByText("declared stages don't exist here · eligible everywhere"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(3);
    expect(getByText(/The declaration says nothing here/)).toBeTruthy();
  });

  it("LV-02: a profile that declares no stages is unrestricted, not ineligible", () => {
    const { container, getByText } = render(
      <ProfileDetail
        a={mkProfile({ stages: [] })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    // Mirrors specialistEligibleForStage: no declared stages = eligible
    // everywhere (the guard treats it that way, so the panel must too).
    expect(getByText("no stage restriction · eligible everywhere")).toBeTruthy();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(
      STAGES.length,
    );
  });

  /**
   * Ruling 133 (F34-16): the panel said WHERE ("2 of 5 stages") and never what
   * the where gates. Live, a human read the count as "this agent can act at
   * these stages", picked "Have the delivering agent resolve the conflict" on
   * a task at Review, and watched the dispatcher refuse it — while a human
   * @mention of the same agent at the same stage ran it. Eligibility gates
   * NEW engagements; the delivering engagement acts on its task at any stage;
   * a supporting one stays stage-scoped. The panel now says so, in two parts.
   */
  const RULE = /Eligibility decides where this profile may be newly engaged\. Once it delivers a task it may be prompted on that task at any stage\./;
  const SCOPING = /A supporting or reviewing engagement runs only at the stages above\./;

  function renderEligibility(a: AgentProfileView, board = STAGES, workflow = WORKFLOW) {
    return render(
      <ProfileDetail
        a={a}
        stages={board}
        workflow={workflow}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    ).container.querySelector(".stage-chips")!.parentElement!.textContent!;
  }

  it("ruling 133: a restricted profile's panel states the rule AND the scoping clause", () => {
    // Canary: delete the paragraph.
    const text = renderEligibility(mkProfile({ stages: ["ready", "impl"] }));
    expect(text).toContain("2 of 5 stages");
    expect(text).toMatch(RULE);
    expect(text).toMatch(SCOPING);
  });

  it("ruling 133: an UNRESTRICTED profile states the rule but never names a scope it does not have", () => {
    // Canary: render the paragraph unconditionally. "The stages above" would
    // name a scope for a profile that has none here — a new copy lie, and one
    // that contradicts the R14-1 note beside it.
    for (const [label, text] of [
      ["spanAll", renderEligibility(mkProfile({ id: "operator", kind: "operator", spanAll: true }))],
      ["stages: []", renderEligibility(mkProfile({ stages: [] }))],
      [
        "resolves to nothing (R14-1 rule 3)",
        renderEligibility(
          mkProfile({ stages: ["spec-review", "handoff"] }),
          LIGHTWEIGHT_BOARD,
          LIGHTWEIGHT_WORKFLOW,
        ),
      ],
    ] as const) {
      expect(text, label).toMatch(RULE);
      expect(text, label).not.toMatch(SCOPING);
    }
  });

  it("hides manage affordances for non-admins", () => {
    const { queryByText } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage={false}
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(queryByText("Delete")).toBeNull();
    expect(queryByText("Edit profile")).toBeNull();
  });
});

describe("ProfileDetail resource chips (P14-KM-11)", () => {
  const withGrants = (): AgentProfileView => ({
    ...mkProfile({}),
    resources: { skills: ["writer-skill"], mcps: ["vm-memory"], kb: [] },
  });

  it("marks a grant the store no longer holds as MISSING, not healthy", () => {
    // Live: renaming an org MCP orphaned every grant to it, and this panel kept
    // painting a normal chip while the run exposed zero tools under that name.
    const { container, getByText } = render(
      <ProfileDetail
        a={withGrants()}
        stages={STAGES}
        workflow={WORKFLOW}
        resourceCatalog={[
          { group: "Skills", key: "skills", mono: true, items: [{ id: "writer-skill", def: false }] },
          { group: "MCP servers", key: "mcps", mono: true, items: [{ id: "everything-http", def: false }] },
          { group: "Knowledge bases", key: "kb", mono: true, items: [] },
        ]}
        insts={[]}
        projectName="P"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    const missing = container.querySelectorAll(".res-chip.missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.textContent).toContain("vm-memory");
    expect(getByText("writer-skill").closest(".res-chip")!.className).not.toContain("missing");
  });

  it("ruling 239: says the rulings KB reaches this profile, EVEN when the profile grants it too", () => {
    // The first version of this note only rendered when the profile did NOT
    // grant the KB, which is backwards for the case that actually exists on a
    // live board: every profile granted it, so the note never appeared and the
    // chip was left implying that removing the grant would stop the agent
    // reading it. It would not. CANARY: restore the
    // `!a.resources.kb.includes(rulingsKb)` condition and this fails.
    const granted: AgentProfileView = {
      ...mkProfile({}),
      resources: { skills: [], mcps: [], kb: ["team-rulings"] },
    };
    const { getByText } = render(
      <ProfileDetail
        a={granted}
        stages={STAGES}
        workflow={WORKFLOW}
        rulingsKb="team-rulings"
        insts={[]}
        projectName="P"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(
      getByText(/Removing the grant here would not stop this profile reading it/),
    ).toBeTruthy();
  });

  it("says nothing about rulings when the project names no rulings KB", () => {
    // The overwhelming majority of projects. CANARY: render the note
    // unconditionally and every project grows a paragraph about a KB it has not
    // got, naming an empty store directory.
    const { queryByText } = render(
      <ProfileDetail
        a={withGrants()}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="P"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(queryByText(/the project's rulings/)).toBeNull();
  });

  it("marks nothing when the catalog is unknown — never invents a missing state", () => {
    const { container } = render(
      <ProfileDetail
        a={withGrants()}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="P"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(container.querySelectorAll(".res-chip.missing")).toHaveLength(0);
  });
});

describe("LiveRoster", () => {
  it("sorts by task key then operator→primary→reviewer and renders backends", () => {
    const rows = [
      mkDeployment({ taskKey: "VIB-2", engagement: "reviewer", role: "Reviewer", backend: "claude", status: "on call" }),
      mkDeployment({ taskKey: "VIB-1", engagement: "primary", status: "working" }),
      mkDeployment({ taskKey: "VIB-1", engagement: "operator", profileId: "operator", role: "Operator", backend: null, status: "coordinating" }),
    ];
    const onOpen = vi.fn();
    const { container } = render(<LiveRoster deployments={rows} onOpen={onOpen} />);
    const rendered = Array.from(container.querySelectorAll(".live-row"));
    expect(rendered).toHaveLength(3);
    // F10-20: the "Profile" column shows the profile IDENTITY (operator → "Operator").
    expect(rendered[0]!.querySelector(".live-name")!.textContent).toBe("Operator");
    expect(rendered[0]!.querySelector(".live-be")!.textContent).toBe("orchestration");
    expect(rendered[1]!.querySelector(".live-be")!.textContent).toBe("Codex");
    expect(rendered[2]!.querySelector(".live-be")!.textContent).toBe("Claude");
    // Engagement is human-facing, not the internal primary/reviewer literals.
    expect(rendered[1]!.textContent).toContain("delivering");
    expect(rendered[2]!.textContent).toContain("supporting");
    expect(rendered[1]!.textContent).not.toContain("primary");
    fireEvent.click(rendered[2]!);
    expect(onOpen).toHaveBeenCalledWith("VIB-2");
  });

  it("renders the added empty state when nothing is engaged", () => {
    const { getByText } = render(<LiveRoster deployments={[]} onOpen={() => {}} />);
    // D8: the empty state now orients the reader; the label is its opening.
    expect(getByText(/No agents are currently engaged/)).toBeTruthy();
  });

  // P13-UI-27 residual: an id with no profile used to be printed raw, which
  // reads as a name and hides what actually happened — the engagement outlived
  // its profile. The row now NAMES that condition and keeps the id in the
  // tooltip, where it is diagnostic rather than decorative.
  it("P11-42: resolves a display name from nameById; an unresolved id names the condition", () => {
    const rows = [
      mkDeployment({ taskKey: "VIB-1", engagement: "primary", profileId: "docs-writer", status: "working" }),
      mkDeployment({ taskKey: "VIB-2", engagement: "reviewer", profileId: "orphan", status: "on call" }),
    ];
    const { container } = render(
      <LiveRoster
        deployments={rows}
        onOpen={() => {}}
        nameById={{ "docs-writer": "Docs Writer" }}
      />,
    );
    const cells = Array.from(container.querySelectorAll(".live-name"));
    const names = cells.map((n) => n.textContent);
    expect(names).toContain("Docs Writer"); // resolved
    expect(names).toContain("profile no longer here");
    expect(names).not.toContain("orphan"); // never the bare id as a name
    expect(names).not.toContain("docs-writer"); // never the raw slug when mapped
    expect(
      cells.find((n) => n.textContent === "profile no longer here")!.getAttribute("title"),
    ).toContain("orphan");
  });
});

describe("CapabilityMatrixModal", () => {
  it("renders catalog groups + Other actions, and closes on Escape (ruling 16)", () => {
    const onClose = vi.fn();
    const profiles = [
      mkProfile({
        id: "operator",
        kind: "operator",
        name: "Operator",
        icon: "shield",
        actions: {
          direct: [DISPATCH_AGENTS_LABEL],
          recommend: [],
          forbidden: ["Change project policy"],
        },
      }),
      mkProfile({}),
    ];
    const { container, getByText, getAllByText } = render(
      <CapabilityMatrixModal
        profiles={profiles}
        projectName="Viberr Core"
        onClose={onClose}
      />,
    );
    expect(getByText("Capability matrix")).toBeTruthy();
    // Substring match: the subheader now also carries the honest-enforcement
    // note (F10-01/03) so the text node is no longer exactly this sentence.
    expect(
      getByText(/Every profile's permissions for each action in Viberr Core\./),
    ).toBeTruthy();
    expect(getByText("Repository & execution")).toBeTruthy();
    // "Human-only" appears both as a group header and as the mode
    // legend label (CAP_META.forbidden), so match at least one.
    expect(getAllByText("Human-only").length).toBeGreaterThan(0);
    // Off-catalog actions (operator coordination + the pruned advisory review
    // caps a seed profile still carries) land in "Other actions".
    expect(getByText("Other actions")).toBeTruthy();
    // Ruling 98: the exact rendered label, pinned against the shipped
    // vocabulary (the one dispatch verb).
    expect(DISPATCH_AGENTS_LABEL).toBe("Select & run agents");
    expect(getByText(DISPATCH_AGENTS_LABEL)).toBeTruthy();
    expect(container.textContent).not.toMatch(/primary specialist/i);
    // Cell modes render as mx-cell classes with accessible titles.
    expect(container.querySelectorAll(".mx-cell.human").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".mx-cell.off").length).toBeGreaterThan(0);

    // Escape on a native modal <dialog> fires the `cancel` event, which
    // useDialog turns into onClose.
    fireEvent(
      container.querySelector("dialog")!,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  // Store icons are free-form frontmatter text. storeIcon must keep the exact
  // fallback the Icon component always applied: unknown names draw "dot".
  it("renders the dot fallback glyph for an unknown store icon", () => {
    const { container } = render(
      <CapabilityMatrixModal
        profiles={[
          mkProfile({ id: "a", name: "A", icon: "no-such-glyph" }),
          mkProfile({ id: "b", name: "B", icon: "shield" }),
        ]}
        projectName="Viberr Core"
        onClose={() => {}}
      />,
    );
    const glyphs = [...container.querySelectorAll(".mx-col .agent-glyph svg")];
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.innerHTML).toContain('<circle cx="12" cy="12" r="4">');
    expect(glyphs[1]!.innerHTML).toContain("M12 3l7 3");
  });

  // P14-LV-03: live, the same MCP server answered `get-annotated-message` on
  // Claude and `get_annotated_message` on Codex, and Claude listed one tool
  // Codex never saw. The parity note covered only the SERVER segment, so it
  // implied a tool name written into a persona would survive both backends.
  it("states that MCP TOOL names, not just server names, differ per backend", () => {
    const { getByText, container } = render(
      <CapabilityMatrixModal
        profiles={[mkProfile({})]}
        projectName="Viberr Core"
        onClose={() => {}}
      />,
    );
    expect(getByText("MCP tool names differ per backend.")).toBeTruthy();
    const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toContain("mcp__everything-http__get-annotated-message");
    expect(codes).toContain("mcp__everything_http__get_annotated_message");
  });

  /**
   * F19-16 / ruling 51 (R18-5) — the Claude-native vs Codex-injected skills
   * asymmetry is canon *because it is disclosed*: "Codex keeps prompt-text
   * injection — the asymmetry is disclosed, not silent". It was disclosed in
   * code comments and in this ledger only; the runtime-differences section this
   * modal ships for exactly that purpose never named it, so an admin granting a
   * long skill could learn about the Codex clipping only by comparing two runs.
   */
  it("discloses that granted skills are SDK-native on Claude and prompt-injected on Codex", () => {
    const { getByText, container } = render(
      <CapabilityMatrixModal
        profiles={[mkProfile({})]}
        projectName="Viberr Core"
        onClose={() => {}}
      />,
    );
    expect(getByText("Granted skills arrive differently.")).toBeTruthy();
    const notes = container.querySelector(".mx-notes")!.textContent!;
    // The Claude leg: installed for the SDK, loaded on invoke, uncapped.
    expect(notes).toContain("loads the full");
    expect(notes).toContain("no length cap");
    // The Codex leg named as prompt text, with the real shared budget
    // (SKILL_INJECTION_BUDGET = 24_000) and the clipping consequence.
    expect(notes).toContain("pasted into the prompt");
    expect(notes).toContain("24,000-character budget");
    expect(notes).toContain("clipped");
    // And the honest exception: a Claude run that can't mount them (no
    // checkout, or another live run holding the workspace catalog) gets the
    // Codex treatment — so the Claude leg is not read as a guarantee.
    expect(notes).toContain("falls back to the same prompt text");
  });
});

describe("CreateProfileModal", () => {
  it("ruling 133: the Eligible stages hint says the stages gate NEW engagements", () => {
    // Canary: restore "stages this profile may work in" — the pre-ruling rule,
    // which a delivering engagement no longer obeys on its own task.
    const { getByText, queryByText } = renderModal({ initial: null });
    expect(getByText("stages where this profile may be newly engaged")).toBeTruthy();
    expect(queryByText("stages this profile may work in")).toBeNull();
  });

  it("B1: a Codex-pinned profile tags claude-only grants as advisory on Codex", () => {
    const { container, queryAllByText } = renderModal({
      initial: mkProfile({
        backends: ["codex"],
        model: "gpt-5-codex",
        capabilities: [
          // create-task-branch + commit-push-branch are CLAUDE-ONLY enforced.
          { capabilityId: "create-task-branch", mode: "direct" },
          { capabilityId: "commit-push-branch", mode: "direct" },
        ],
      }),
    });
    // Expand every capability group so the collapsed rows render.
    for (const head of container.querySelectorAll("button.cap-mghead")) {
      fireEvent.click(head);
    }
    // The withholding is advisory on Codex — the editor says so at the point the
    // grant is made, mirroring the matrix's Claude-enforced tag.
    expect(queryAllByText("advisory on Codex").length).toBeGreaterThan(0);
  });

  it("B1: a Claude-pinned profile shows no advisory-on-Codex tag (it IS enforced)", () => {
    const { container, queryAllByText } = renderModal({
      initial: mkProfile({
        backends: ["claude"],
        model: "claude-sonnet",
        capabilities: [{ capabilityId: "create-task-branch", mode: "direct" }],
      }),
    });
    for (const head of container.querySelectorAll("button.cap-mghead")) {
      fireEvent.click(head);
    }
    expect(queryAllByText("advisory on Codex")).toHaveLength(0);
    expect(queryAllByText("inert on Codex")).toHaveLength(0);
  });

  it("D5: a failed model-catalog load offers a retry instead of deadlocking Save", async () => {
    // The model-catalog loader settles with NO data (a 500/transport failure the
    // curated-fallback endpoint normally prevents). Save must not sit held with
    // an empty picker and no way out.
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <CreateProfileModal
            initial={mkProfile({ backends: ["codex"], model: "" })}
            stages={STAGES}
            projectName="Viberr Core"
            busy={false}
            error={null}
            onClose={() => {}}
            onSubmit={() => {}}
          />
        ),
      },
      { path: "/resources/model-catalog", loader: () => ({ data: null }) },
    ]);
    const { findByText, getByText } = render(<Stub initialEntries={["/"]} />);
    // The retry affordance appears, and the footer says the load failed rather
    // than telling the user to "pick a model" over an empty picker.
    await findByText("Retry");
    expect(getByText(/Couldn't load the models available on/)).toBeTruthy();
  });

  it("create mode: validation hint until required fields are set, then submits the payload", async () => {
    const onSubmit = vi.fn();
    const { container, getByText, getByPlaceholderText } = renderModal({
      initial: null,
      onSubmit,
    });
    expect(
      getByText(
        "Name, role, one execution backend, and at least one stage are required.",
      ),
    ).toBeTruthy();

    fireEvent.change(getByPlaceholderText("e.g. Migrations"), {
      target: { value: "Migrations" },
    });
    fireEvent.change(getByPlaceholderText("e.g. Schema changes"), {
      target: { value: "Schema changes" },
    });
    fireEvent.click(getByText("Codex"));
    fireEvent.click(getByText("Ready"));
    // F21-13: every required field is set, but the backend's model list has not
    // answered yet — the form is NOT ready and the hint says which half is
    // missing (it used to read "Ready to add" over an empty model).
    expect(
      getByText(/Loading the models available on Codex/),
    ).toBeTruthy();

    // The catalog fetch resolves the codex default model + effort.
    await waitFor(() =>
      expect(
        container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')
          ?.value,
      ).toBe("gpt-5-codex"),
    );
    expect(getByText("Ready to add to Viberr Core.")).toBeTruthy();
    await waitFor(() =>
      expect(
        container.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')
          ?.value,
      ).toBe("medium"),
    );

    fireEvent.click(getByText("Create profile"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload).toMatchObject({
      name: "Migrations",
      role: "Schema changes",
      backend: "codex",
      stages: ["ready"],
      model: "gpt-5-codex",
      effort: "medium",
    });
    // Catalog defaults seed the caps record.
    expect(payload.caps["merge-pull-request"]).toBe("human");
    // A fresh profile starts with NO resources pre-granted (RES_DEFAULTS empty).
    expect(payload.resources.skills).toEqual([]);
    expect(container.querySelector(".cap-matrix")).not.toBeNull();
  });

  it("surfaces dangling resource grants (deleted KBs) as removable 'missing' chips, count stays sane", () => {
    // The live 'viberr' repro: the profile grants 2 KBs but the store offers 0
    // — the old render was "2 of 0" with the two grants INVISIBLE (no chip to
    // click) and thus un-removable.
    const onSubmit = vi.fn();
    const { container, getByText, getAllByTitle } = renderModal({
      onSubmit,
      initial: mkProfile({
        resources: {
          skills: ["developer-expertise"],
          mcps: [],
          kb: ["architecture-notes", "api-contracts"],
        },
      }),
      resourceCatalog: [
        {
          group: "Skills",
          key: "skills",
          mono: true,
          items: [{ id: "developer-expertise", def: false }],
        },
        { group: "MCP servers", key: "mcps", mono: true, items: [] },
        // The store has ZERO knowledge bases — both grants dangle.
        { group: "Knowledge bases", key: "kb", mono: false, items: [] },
      ],
    });

    // Count is "2 of 2" (selected of shown), never the nonsensical "2 of 0".
    // Shown in the group header even while collapsed.
    expect(getByText("2 of 2")).toBeTruthy();

    // Expand the Knowledge bases group to reveal the grants.
    fireEvent.click(getByText("Knowledge bases"));
    // Both dangling ids now render AS chips, flagged missing + removable.
    const ghosts = getAllByTitle(
      "No longer in the store. Click to remove this grant",
    );
    expect(ghosts).toHaveLength(2);
    expect(container.querySelectorAll(".pick-chip.missing")).toHaveLength(2);

    // Clicking a ghost removes the grant; submitting proves it's gone.
    fireEvent.click(getByText("architecture-notes"));
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].resources.kb).toEqual(["api-contracts"]);
  });

  it("shows Model + Effort dropdowns populated from the catalog for the selected backend", async () => {
    const { container, getByText } = renderModal({ initial: null });
    // Before a backend is picked the model select is disabled.
    const modelSel = () =>
      container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    expect(modelSel().disabled).toBe(true);

    fireEvent.click(getByText("Claude"));
    // The claude catalog loads → sonnet/opus options + high default effort.
    await waitFor(() => expect(modelSel().value).toBe("sonnet"));
    const modelValues = Array.from(modelSel().options).map((o) => o.value);
    expect(modelValues).toEqual(["sonnet", "opus"]);
    const effortSel = () =>
      container.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')!;
    await waitFor(() => expect(effortSel().value).toBe("high"));
    expect(Array.from(effortSel().options).map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  /**
   * F21-13 (live) — Edit Developer (Codex · gpt-5.6-terra) → click "Claude
   * Code" → the model select reads "loading available models…" while Save stays
   * ENABLED → the save lands `backends: [claude]` next to a Codex model id, and
   * the run silently substitutes a Claude model. The editor now clears the
   * model on the switch and holds Save until the new backend's catalog answers,
   * so the incoherent pair has no window to be submitted in.
   */
  it("F21-13: a backend switch clears the model, holds Save, and remaps to the new backend's default", async () => {
    const onSubmit = vi.fn();
    const { container, getByText } = renderModal({
      initial: mkProfile({
        backends: ["codex"],
        model: "gpt-5-codex",
        effort: "medium",
      }),
      onSubmit,
    });
    const modelSel = () =>
      container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    const save = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent?.includes("Save changes"),
      )!;
    // Control: the stored Codex model resolves and the profile is saveable.
    await waitFor(() => expect(modelSel().value).toBe("gpt-5-codex"));
    expect(save().disabled).toBe(false);

    fireEvent.click(getByText("Claude"));
    // The Codex id is gone on the click — not "still shown but about to change".
    expect(modelSel().value).toBe("");
    // Ruling 147: the hold is ENFORCED by submit's refusal guard, never by a
    // disabled (or aria-disabled) button, so the explain-on-click state stays
    // reachable and the click puts focus on the empty model picker.
    expect(save().disabled).toBe(false);
    expect(save().getAttribute("aria-disabled")).toBeNull();
    expect(getByText(/Loading the models available on Claude/)).toBeTruthy();
    // The exact race: a save inside the window submits nothing at all.
    fireEvent.click(save());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getByText(/Loading the models available on Claude/).getAttribute("role")).toBe(
      "alert",
    );
    // The picker is disabled while the catalog loads, so there is nothing to
    // focus yet; the alert is the whole announcement.
    expect(modelSel().disabled).toBe(true);

    // The claude catalog answers → its default model + effort, Save released.
    await waitFor(() => expect(modelSel().value).toBe("sonnet"));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      backend: "claude",
      model: "sonnet",
      // The Codex effort ("medium") went with the Codex model — the pair the
      // new backend answers with is the one that gets saved.
      effort: "high",
    });
  });

  /**
   * OBS-12 (live): with `stage-transitions: direct` left on the deployment, a
   * SUPERVISED operator transitioned approval boundaries directly — the display
   * was right, the help text was not. "supervised recommends at approval
   * boundaries" reads as a guarantee of the setting; it is a ceiling, and the
   * rows below it decide per action.
   */
  it("OBS-12: the autonomy help says the capability rows can override the setting", () => {
    const { getByText, container } = renderModal({
      initial: mkProfile({
        id: "operator",
        kind: "operator",
        name: "Operator",
        role: "Orchestration",
        autonomy: "supervised",
      }),
    });
    // Non-vacuity: the operator-only autonomy control is on screen.
    expect(container.textContent).toContain("Default autonomy");
    expect(
      getByText(/capability rows may override this per action/),
    ).toBeTruthy();
  });

  it("R7-5 — a specialist cap row offers 3 honest modes (Acts directly/Human-only/Off), no Recommend", () => {
    // Create mode ⇒ a specialist profile: the picker collapses to 3 modes.
    const { container } = renderModal({ initial: null });
    const seg = container.querySelector(".cap-seg")!;
    const labels = Array.from(seg.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Acts directly", "Human-only", "Off"]);
    // `recommend` is operator-only and never shown to a specialist.
    expect(container.querySelector(".cap-matrix")!.textContent).not.toContain(
      "Recommends only",
    );
    expect(
      container.querySelector(".cap-seg button.recommend"),
    ).toBeNull();
  });

  it("R7-5 — the operator cap row keeps all 4 modes incl. Recommend", () => {
    const { container } = renderModal({
      initial: mkProfile({
        id: "operator",
        kind: "operator",
        name: "Operator",
        icon: "shield",
        backends: ["claude"],
        stages: ["triage"],
        capabilities: [
          { capabilityId: "assign-primary-specialist", mode: "direct" },
        ],
      }),
    });
    const seg = container.querySelector(".cap-seg")!;
    const labels = Array.from(seg.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Acts directly", "Recommends only", "Human-only", "Off"]);
    expect(container.querySelector(".cap-seg button.recommend")).not.toBeNull();
  });

  /** Owner ruling 2026-08-20 — browser→egress coupling in the editor. The live
   * failure shape: an admin granted "Drive a live web browser", left "Search &
   * fetch from the web" off, and got run after run honestly reporting "browser
   * not mounted" against a matrix that said Allowed (`resolveBrowserMcp`
   * refuses the pair in disagreement). The editor now makes the disagreement
   * inexpressible: granting the browser flips egress with it, and the egress
   * row pins (disabled, reason in its accessible name) while the browser stays
   * Allowed. */
  it("granting the browser flips web egress with it and pins the row", () => {
    const { container, getByText } = renderModal({ initial: null });
    fireEvent.click(getByText("Collaboration"));
    const rowFor = (label: string) =>
      container.querySelector<HTMLElement>(
        `[role="radiogroup"][aria-label^="Policy for ${label}"]`,
      )!;
    const modeBtn = (row: HTMLElement, label: string) =>
      Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      )!;

    // Default state: browser off, egress row free — withhold egress
    // EXPLICITLY first, so the flip below is load-bearing (the create-mode
    // default for egress is already Allowed, which would mask a dead
    // coupling).
    const egressBefore = rowFor("Search & fetch from the web");
    expect(modeBtn(egressBefore, "Acts directly").disabled).toBe(false);
    fireEvent.click(modeBtn(egressBefore, "Off"));
    expect(modeBtn(egressBefore, "Off").getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(modeBtn(rowFor("Drive a live web browser"), "Acts directly"));

    const egress = rowFor("Search & fetch from the web");
    expect(egress.getAttribute("aria-label")).toContain(
      "required by Drive a live web browser",
    );
    expect(modeBtn(egress, "Acts directly").getAttribute("aria-checked")).toBe(
      "true",
    );
    // SAFETY: the radiogroup renders only <button> children (the rowModes
    // map above), so every match is an HTMLButtonElement.
    for (const b of egress.querySelectorAll<HTMLButtonElement>("button")) {
      expect(b.disabled).toBe(true);
    }
    // P14: the reason a disabled row won't move is RENDERED, visible copy —
    // not only the aria-label (which a sighted admin never sees) or a title
    // (which never opens on a disabled control).
    expect(
      egress.closest(".cap-mrow")!.querySelector(".cap-mnote")!.textContent,
    ).toContain("the browser is web egress");

    // Releasing the browser releases the row (the value stays Allowed — the
    // admin can then withhold egress explicitly).
    fireEvent.click(modeBtn(rowFor("Drive a live web browser"), "Off"));
    const released = rowFor("Search & fetch from the web");
    expect(released.getAttribute("aria-label")).not.toContain("required by");
    // …and the pinned-reason copy is gone with it.
    expect(released.closest(".cap-mrow")!.querySelector(".cap-mnote")).toBeNull();
    expect(modeBtn(released, "Acts directly").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(modeBtn(released, "Off").disabled).toBe(false);
  });

  it("a stored pre-rule contradiction (browser on, egress off) seeds coupled", () => {
    // The save layer repairs the pair on the next write, so the editor shows
    // what that write will persist (F19 UX-13 round-trip honesty).
    const { container, getByText } = renderModal({
      initial: mkProfile({
        capabilities: [
          { capabilityId: "use-browser", mode: "direct" },
          { capabilityId: "use-web-search-fetch", mode: "off" },
        ],
      }),
    });
    fireEvent.click(getByText("Collaboration"));
    const egress = container.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label^="Policy for Search & fetch from the web"]',
    )!;
    expect(egress.getAttribute("aria-label")).toContain(
      "required by Drive a live web browser",
    );
    expect(
      Array.from(egress.querySelectorAll("button"))
        .find((b) => b.textContent === "Acts directly")!
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("edit mode: seeds model + effort from the profile", async () => {
    const { container, getByText, getByDisplayValue } = renderModal({
      initial: mkProfile({ backends: ["claude"], model: "opus", effort: "max" }),
      error: "Only project admins can change agent capability policy.",
    });
    expect(getByText("Edit Developer")).toBeTruthy();
    expect(getByDisplayValue("Developer")).toBeTruthy();
    expect(getByText("Save changes")).toBeTruthy();
    expect(
      getByText("Only project admins can change agent capability policy."),
    ).toBeTruthy();
    // Seeded picks survive the catalog load (opus is in the claude catalog).
    await waitFor(() =>
      expect(
        container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!
          .value,
      ).toBe("opus"),
    );
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')!
        .value,
    ).toBe("max");
  });

  /**
   * UXA-4 — the capability control is the most consequential setting in the
   * product (it decides what an agent may do on its own), and its state lived
   * in a CSS class only. The IDENTICAL control on the Policy sheet (the
   * workflow-boundary seg) has always been a proper radiogroup; this one was
   * never brought along, so a screen-reader user could not read the policy
   * they were setting.
   */
  it("the Direct/Recommend/Human/Off control is a real radiogroup with checked state", () => {
    const { container } = renderModal({ initial: null });
    const seg = container.querySelector('.cap-seg[role="radiogroup"]');
    expect(seg).toBeTruthy();
    expect(seg!.getAttribute("aria-label")).toMatch(/^Policy for /);
    const radios = [...seg!.querySelectorAll('[role="radio"]')];
    expect(radios.length).toBeGreaterThan(1);
    // Exactly one option is checked, and it is the one wearing the `on` class.
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.className).toContain("on");
  });

  /**
   * F19-5 — the context-resource chips (skills / MCP servers / KBs) are the one
   * chip group in this file that never reported its pressed state: the grant
   * lived in the `on` class and a check glyph, so a screen reader announced a
   * granted KB exactly like an ungranted one. Backend (`BackendField`), autonomy
   * (`AutonomyField`) and stage (`StagesField`) chips have carried
   * `aria-pressed` since G5/UXA-4.
   */
  it("resource grant chips report their granted state (aria-pressed), missing grants included", () => {
    const { container, getByText } = renderModal({
      initial: mkProfile({
        resources: { skills: ["repo-write"], mcps: [], kb: ["retired-kb"] },
      }),
      resourceCatalog: [
        {
          group: "Skills",
          key: "skills",
          mono: true,
          items: [
            { id: "repo-write", def: false },
            { id: "release-notes", def: false },
          ],
        },
        { group: "MCP servers", key: "mcps", mono: true, items: [] },
        // `retired-kb` is granted but no longer in the store → a dangling chip.
        { group: "Knowledge bases", key: "kb", mono: false, items: [] },
      ],
    });

    // The first resource group ("Skills") is expanded on mount.
    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>(".cap-mbody .pick-chip"),
    ];
    const chipFor = (id: string) => chips.find((c) => c.textContent === id)!;
    // The granted skill reports pressed; the ungranted one reports the
    // attribute with "false" — present, not absent, so the toggle is readable.
    expect(chipFor("repo-write").getAttribute("aria-pressed")).toBe("true");
    expect(chipFor("release-notes").getAttribute("aria-pressed")).toBe("false");
    expect(chipFor("repo-write").className).toContain("on");

    // A dangling grant IS a grant (clicking it removes one) — it reports pressed.
    fireEvent.click(getByText("Knowledge bases"));
    const ghost = container.querySelector<HTMLButtonElement>(".pick-chip.missing")!;
    expect(ghost.textContent).toBe("retired-kb");
    expect(ghost.getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * F19-35 — the collapsible group headers (`cap-mghead`) carried expanded vs
   * collapsed in the `open` CSS class alone: the chevron rotates and a screen
   * reader learns nothing. Both matrices use the same header, so both are
   * pinned here.
   */
  it("capability + resource group headers report expanded/collapsed (aria-expanded)", () => {
    const { container, getByText } = renderModal({
      initial: null,
      resourceCatalog: [
        {
          group: "Skills",
          key: "skills",
          mono: true,
          items: [{ id: "repo-write", def: false }],
        },
      ],
    });
    const heads = () => [...container.querySelectorAll(".cap-mghead")];
    expect(heads().length).toBeGreaterThan(2);
    // Every header reports its state — none may be missing the attribute, and
    // it always agrees with the `open` class the CSS used to carry alone.
    const agrees = () =>
      heads().every(
        (h) =>
          h.getAttribute("aria-expanded") ===
          String(h.classList.contains("open")),
      );
    expect(agrees()).toBe(true);
    // Mount state: the first capability group and the first resource group are
    // the expanded ones, so both values are actually exercised.
    expect(
      heads().map((h) => h.getAttribute("aria-expanded")),
    ).toContain("true");
    expect(
      heads().map((h) => h.getAttribute("aria-expanded")),
    ).toContain("false");

    // A collapsed capability group flips to expanded on click.
    const collapsed = heads().find(
      (h) => h.getAttribute("aria-expanded") === "false",
    )!;
    const label = collapsed.querySelector(".cap-mglabel")!.textContent!;
    fireEvent.click(collapsed);
    const reFind = () =>
      heads().find(
        (h) => h.querySelector(".cap-mglabel")!.textContent === label,
      )!;
    expect(reFind().getAttribute("aria-expanded")).toBe("true");
    expect(agrees()).toBe(true);

    // The resource-group header is the same control and collapses the same way.
    const resHead = () =>
      getByText("Skills").closest<HTMLButtonElement>(".cap-mghead")!;
    expect(resHead().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(resHead());
    expect(resHead().getAttribute("aria-expanded")).toBe("false");
    expect(agrees()).toBe(true);
  });

  /**
   * F19 UX-13 — a control that accepts input and discards it.
   *
   * `agent-profile-actions.server.ts` coerces every id in
   * `ALWAYS_HUMAN_CAPABILITY_IDS` to `human` "whatever the submitted form says"
   * (`grantsFor` on edit, `createModalGrants` on create). The picker offered
   * Allowed/Human-only/Off on those three rows anyway: an admin set "Merge a
   * pull request" to Allowed, got a success toast, reopened the profile and
   * found Human-only again. The Policy page draws the same class of invariant
   * with the locked variant of this exact control (`.cap-seg.locked`,
   * `WorkflowRules`' boundary group in policy-page.tsx); the modal never
   * applied it.
   */
  it("UX-13 — the always-human rows render locked, and the invariant is stated", () => {
    const { container, getByText } = renderModal({ initial: null });
    // The always-human group is the LAST accordion and starts collapsed.
    fireEvent.click(getByText("Reserved for humans"));
    const seg = container.querySelector<HTMLElement>(
      '[aria-label^="Policy for Merge a pull request"]',
    )!;
    expect(seg).toBeTruthy();
    expect(seg.className).toContain("locked");
    const radios = [...seg.querySelectorAll("button")];
    expect(radios.map((b) => b.disabled)).toEqual([true, true, true]);
    // The lock is named, not left to the group heading + a greyed control.
    expect(
      getByText(/They stay reserved for humans on every profile/),
    ).toBeTruthy();
    // And "Acts directly" no longer takes a click whose result the server discards:
    // the row stays Human-only, which is what a save would store.
    fireEvent.click(seg.querySelector("button.direct")!);
    expect(
      seg.querySelector("button.human")!.getAttribute("aria-checked"),
    ).toBe("true");
  });

  /**
   * F19 UX-13, second half — `report-validation-verdict` is an explicit-`direct`
   * -or-nothing grant: `grantsFor` in agent-profile-actions.server.ts (create
   * path `createModalGrants`) persists `direct` iff the form said `direct` and
   * `off` for every other value. Offering "Human-only" therefore stored a mode
   * in a DIFFERENT bucket than the admin picked (`capabilitiesToActionLabels`
   * counts `human` separately from `off`), with no notice anywhere.
   */
  it("UX-13 — the verdict row offers only the modes the save layer can store", () => {
    const { container, getByText } = renderModal({
      initial: mkProfile({
        capabilities: [
          // A stored `human` the save layer rewrites to `off` on the next save.
          { capabilityId: "report-validation-verdict", mode: "human" },
        ],
      }),
    });
    fireEvent.click(getByText("Collaboration"));
    const seg = container.querySelector<HTMLElement>(
      '[aria-label="Policy for Report a validation verdict"]',
    )!;
    expect(seg).toBeTruthy();
    expect([...seg.querySelectorAll("button")].map((b) => b.textContent)).toEqual(
      ["Acts directly", "Off"],
    );
    // Seeded to what the next save actually stores, not to the discarded mode.
    expect(seg.querySelector("button.off")!.getAttribute("aria-checked")).toBe(
      "true",
    );
    // Its siblings keep all three specialist modes — this is a per-row rule.
    const sibling = container.querySelector<HTMLElement>(
      '[aria-label="Policy for Ask the human a question"]',
    )!;
    expect([...sibling.querySelectorAll("button")].map((b) => b.textContent)).toEqual(
      ["Acts directly", "Human-only", "Off"],
    );
  });

  /**
   * BUG (pass 23, owner ruling 2026-08-22 — web egress ON by default): editing a
   * profile seeded every ABSENT toggle to Off. `use-web-search-fetch` ships
   * absent on the base Developer/Reviewer, but the runtime leaves WebFetch/
   * WebSearch ON for an absent grant — so the row read "Off" while the agent
   * could still reach the web, and saving then PERSISTED that phantom Off,
   * silently withholding egress the admin never touched. The editor now seeds
   * each absent toggle to the mode the runtime uses for a missing grant.
   */
  it("edit mode: an absent web-egress grant seeds Allowed, not Off", () => {
    const { container, getByText } = renderModal({
      initial: mkProfile({
        capabilities: [
          // Neither web egress nor repo-write is granted here.
          { capabilityId: "create-task-branch", mode: "direct" },
        ],
      }),
    });
    fireEvent.click(getByText("Collaboration"));
    const checkedMode = (label: string) => {
      const row = container.querySelector<HTMLElement>(
        `[role="radiogroup"][aria-label^="Policy for ${label}"]`,
      )!;
      return Array.from(row.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-checked") === "true",
      )?.textContent;
    };
    // Non-grant-required, catalog default `direct` → the runtime leaves WebFetch
    // on for an absent grant, so the editor seeds Allowed (was Off — the bug).
    expect(checkedMode("Search & fetch from the web")).toBe("Acts directly");
    // A GRANT-REQUIRED capability (the verdict) stays Off when absent — the
    // runtime withholds it, preserving the F10-07/F10-14 verdict-safety invariant.
    expect(checkedMode("Report a validation verdict")).toBe("Off");
  });

  /**
   * F19 UX-19 — UXA-4 gave this control the radiogroup ROLE and stopped there.
   * A radiogroup promises arrow-key traversal (then the `rovingRadioKeyDown`
   * helper, retired by ruling 166), which UXA-7 wired into the twins on the
   * Policy sheet (`HumanAccess`'s role group and `WorkflowRules`' boundary group
   * in policy-page.tsx) and never into this one: ←/→ did nothing, and every
   * radio was its own tab stop (15 instead of 5 for an expanded Collaboration
   * group).
   */
  it("UX-19 — the capability radiogroup traverses with arrow keys on one tab stop", async () => {
    const { container } = renderModal({ initial: null });
    const seg = container.querySelector<HTMLElement>('.cap-seg[role="radiogroup"]')!;
    const radios = [...seg.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios).toHaveLength(3);
    // Ruling 166 moved the roving wiring to Radix (`app/ui/radio-seg.tsx`), and
    // the one-tab-stop guarantee is now expressed the other way round: the GROUP
    // carries the tab stop and delegates entry focus to the checked option,
    // rather than the checked radio holding `tabindex=0` itself. Either way the
    // group is one stop, which is what UX-19 was about — 15 tab stops became 5.
    expect(seg.getAttribute("tabindex")).toBe("0");
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);
    // Keys are handled on the focused OPTION, which is where a browser raises
    // them; the retired helper listened on the group by delegation. Radix moves
    // focus in a `setTimeout`, so each assertion waits a tick rather than
    // reading the DOM synchronously.
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));
    fireEvent.keyDown(radios[1]!, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));
    // The ends still wrap (Radix `loop`, on by default).
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(radios[2]));
    // Home/End are NEW: the retired hand-rolled helper handled the four arrows
    // and nothing else, so a keyboard user could not jump to either end. RTL is
    // new too — the helper hard-coded ArrowLeft as "previous", which is
    // backwards in a right-to-left document.
    fireEvent.keyDown(radios[2]!, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));
    fireEvent.keyDown(radios[0]!, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(radios[2]));
  });

  /**
   * F19 UX-21 — the two `cap-mghead` accordions were the only custom-button
   * disclosures in the app that never reported their state: it lived in the
   * chevron's CSS rotation alone. Every group after the first starts COLLAPSED,
   * so reaching any capability outside "Repository & execution" means operating
   * a control whose state a screen reader cannot read.
   */
  it("UX-21 — both accordions report expanded/collapsed state", () => {
    const { container } = renderModal({
      initial: null,
      resourceCatalog: [
        { group: "Skills", key: "skills", mono: true, items: [{ id: "repo-write", def: false }] },
        { group: "MCP servers", key: "mcps", mono: true, items: [] },
      ],
    });
    const heads = () => [...container.querySelectorAll(".cap-mghead")];
    // Capability groups + resource groups — every one of them reports.
    expect(heads().length).toBeGreaterThan(3);
    expect(heads().every((h) => h.hasAttribute("aria-expanded"))).toBe(true);
    // The first group of each section is open and points at its own body.
    const first = heads()[0]!;
    expect(first.getAttribute("aria-expanded")).toBe("true");
    const body = container.querySelector(".cap-mbody")!;
    expect(body.id).not.toBe("");
    expect(first.getAttribute("aria-controls")).toBe(body.id);
    // A collapsed header has no body to point at, and never a dangling id.
    const collapsedIdx = heads().findIndex(
      (h) => h.getAttribute("aria-expanded") === "false",
    );
    expect(collapsedIdx).toBeGreaterThan(0);
    expect(heads()[collapsedIdx]!.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(heads()[collapsedIdx]!);
    expect(heads()[collapsedIdx]!.getAttribute("aria-expanded")).toBe("true");
  });

  /**
   * F19 UX-23 — the collapsed summary printed bare digits ("3 2 1") whose only
   * key was the dot colour, while the identical strip on the Policy page names
   * every mode (`.pcap-counts` in policy-page.tsx's `AgentCapability`). Zero
   * counts render nothing, so position did not disambiguate either. The words
   * now come from the SAME mode list the expanded segment uses for this profile
   * kind, so one vocabulary covers both views.
   */
  it("UX-23 — the collapsed capability summary names each mode, not just its dot", () => {
    const { container } = renderModal({ initial: null });
    const head = [...container.querySelectorAll(".cap-mghead")].find((h) =>
      h.textContent!.startsWith("Reserved for humans"),
    )!;
    // All three always-human caps seed `human` — and the count says so, using
    // the specialist segment's own word for that mode.
    expect(head.textContent).toContain("3 Human-only");
    // No count anywhere in the modal is a bare digit.
    const counts = [...container.querySelectorAll(".cap-msum .cs")];
    expect(counts.length).toBeGreaterThan(1);
    counts.forEach((c) =>
      expect(c.textContent!.trim()).toMatch(/^\d+ [A-Za-z]/),
    );
    // The withheld swatch matches the capability matrix legend's "Not granted"
    // dot (`.d.off`); the modal used to draw a `.d.none` grey no legend shows.
    expect(container.querySelector(".cap-msum .d.none")).toBeNull();
    expect(container.querySelector(".cap-msum .d.off")).not.toBeNull();
  });
});

describe("P13-AP-07 — the edit modal states that saving FORKS a library profile", () => {
  /**
   * `updateAgentProfile` writes a COMPLETE definition snapshot onto the
   * project's deployment, and every field of it wins over the org template
   * afterwards — so the first project-level edit permanently detaches this
   * project from later org-level renames, stage changes, resource changes and
   * persona fixes. The snapshot model is deliberate; the COPY was the lie
   * ("changes apply on next run" / "changes apply to future assignments"),
   * so the editor now says what saving actually does.
   */
  it("a template-sourced profile is told it forks, in the header and the confirm hint", () => {
    const { getByText } = renderModal({
      initial: mkProfile({ source: "template" }),
    });
    expect(
      getByText(
        "Saving forks this profile for Viberr Core: it keeps its own copy and stops tracking later changes to the global profile.",
      ),
    ).toBeTruthy();
    expect(
      getByText("Ready to save: this forks Developer for Viberr Core."),
    ).toBeTruthy();
  });

  it("A11Y-9 (pass 32): every collapsible section header is a named, state-carrying button", () => {
    const { container } = renderModal({
      initial: mkProfile({ source: "project", name: "Migrations" }),
    });
    const heads = [...container.querySelectorAll<HTMLButtonElement>("button.cap-mghead")];
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      // Named by the group label it contains; the live tree tool reported
      // these unnamed, so the computed name is what this pins.
      expect(head.textContent!.trim().length).toBeGreaterThan(0);
      expect(head.getAttribute("aria-expanded")).toMatch(/^(true|false)$/);
    }
  });

  it("a project-created profile has nothing to fork and says so plainly", () => {
    const { getByText, queryByText } = renderModal({
      initial: mkProfile({ source: "project", name: "Migrations" }),
    });
    expect(
      getByText("Update this project's copy. Changes apply from the next run."),
    ).toBeTruthy();
    expect(queryByText(/forks/)).toBeNull();
  });

  it("create mode never claims a fork", () => {
    const { getByText, queryByText } = renderModal({ initial: null });
    expect(
      getByText("A reusable agent the operator can assign to tasks."),
    ).toBeTruthy();
    expect(queryByText(/forks/)).toBeNull();
  });
});

/**
 * P13-UI-52 residual: the form is single-select and the save writes exactly one
 * backend, so editing ANYTHING on a seeded two-backend profile silently dropped
 * the second — the roster reported the loss afterwards, the editor never
 * mentioned it.
 */
describe("P13-UI-52 — the editor states the backend narrowing before the save", () => {
  it("warns which backend a save will drop", () => {
    // mkProfile's Developer declares both backends; the form seeds the first.
    const { getByText } = renderModal({ initial: mkProfile({}) });
    expect(getByText(/Saving pins this profile to one backend/)).toBeTruthy();
    expect(getByText(/Claude will be dropped/)).toBeTruthy();
  });

  it("says nothing when the profile already declares exactly one", () => {
    const { queryByText } = renderModal({
      initial: mkProfile({ backends: ["codex"] }),
    });
    expect(queryByText(/Saving pins this profile to one backend/)).toBeNull();
  });

  it("says nothing in create mode — there is nothing to narrow", () => {
    const { queryByText } = renderModal({ initial: null });
    expect(queryByText(/Saving pins this profile to one backend/)).toBeNull();
  });
});

/**
 * Ruling 127 (live): the editor inherited RU-2's rule "disable a backend that
 * cannot run", which used to mean "not configured on this deployment". Since a
 * run bills the TASK OWNER, the author's own credential decides nothing about
 * whether this profile runs, and gating on it made a FRESH INSTANCE unable to
 * create any profile at all: nobody has connected anything, so both chips were
 * dead, Save was held forever on "one execution backend ... required", and the
 * only explanation lived in a `title` on a disabled button, which no browser
 * opens (the same P14 rule the policy rows follow).
 */
describe("ruling 127 — the editor advises about the viewer's account, it does not gate on it", () => {
  const NOTHING_CONNECTED = { claude: false, codex: false } as const;

  it("a viewer who has connected neither backend can still author a profile", async () => {
    const onSubmit = vi.fn();
    const { container, getByText, getByPlaceholderText } = renderModal({
      initial: null,
      onSubmit,
      viewerConnected: { ...NOTHING_CONNECTED },
    });
    // Neither chip is dead: authoring is not running.
    const chips = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".pick-chips .pick-chip"),
    ).filter((b) => b.textContent === "Codex" || b.textContent === "Claude");
    expect(chips).toHaveLength(2);
    expect(chips.map((b) => b.disabled)).toEqual([false, false]);

    fireEvent.change(getByPlaceholderText("e.g. Migrations"), {
      target: { value: "Migrations" },
    });
    fireEvent.change(getByPlaceholderText("e.g. Schema changes"), {
      target: { value: "Schema changes" },
    });
    fireEvent.click(getByText("Codex"));
    fireEvent.click(getByText("Ready"));
    await waitFor(() => expect(getByText("Ready to add to Viberr Core.")).toBeTruthy());
    fireEvent.click(getByText("Create profile"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ backend: "codex" });
  });

  it("states the consequence as RENDERED copy, naming where the viewer connects it", () => {
    const { container, getByText } = renderModal({
      initial: null,
      viewerConnected: { ...NOTHING_CONNECTED },
    });
    // Nothing is said before a backend is picked: there is no consequence yet.
    expect(container.querySelector(".field .def-note")).toBeNull();

    fireEvent.click(getByText("Claude"));
    const note = container.querySelector(".field .def-note")!;
    expect(note.textContent).toContain("You haven't connected Claude.");
    // It is advice, not a refusal: the profile still runs for the people whose
    // tasks it is dispatched on.
    expect(note.textContent).toContain("runs use the task owner's account");
    expect(note.textContent).toContain("Profile → Agent accounts");
    // No environment variable to set, and no instance-level claim: ruling 127
    // left neither.
    expect(container.textContent).not.toContain("on this instance");
    expect(container.textContent).not.toContain("VIBERR_CLAUDE_USE_CLI_AUTH");
  });

  it("says nothing when the viewer has connected the backend they picked", () => {
    const { container, getByText } = renderModal({
      initial: null,
      viewerConnected: { claude: true, codex: false },
    });
    fireEvent.click(getByText("Claude"));
    expect(container.querySelector(".field .def-note")).toBeNull();
    // …and speaks again for the one they have not.
    fireEvent.click(getByText("Codex"));
    expect(container.querySelector(".field .def-note")!.textContent).toContain(
      "You haven't connected Codex.",
    );
  });

  it("claims nothing at all when connections were not probed", () => {
    const { container, getByText } = renderModal({ initial: null });
    fireEvent.click(getByText("Claude"));
    expect(container.querySelector(".field .def-note")).toBeNull();
  });
});

describe("LibraryPicker (owner ruling 1 / AP-05)", () => {
  const TEMPLATES: LibraryProfileView[] = [
    {
      id: "security-reviewer",
      name: "Security reviewer",
      role: "Security",
      desc: "Reviews IAM, secrets handling and supply-chain risk.",
      backends: ["claude"],
      stages: ["review"],
      spanAll: false,
      resources: { skills: [], mcps: [], kb: [] },
    },
  ];

  it("lists undeployed templates and adds the picked one by id", () => {
    const onAdd = vi.fn();
    const { getByText, getByRole } = render(
      <LibraryPicker
        library={TEMPLATES}
        stages={STAGES}
        workflow={WORKFLOW}
        projectName="Viberr Core"
        busy={false}
        onClose={() => {}}
        onAdd={onAdd}
      />,
    );
    expect(getByText("Security reviewer")).toBeTruthy();
    expect(
      getByText("Reviews IAM, secrets handling and supply-chain risk."),
    ).toBeTruthy();
    expect(getByText("1 stage here")).toBeTruthy();
    // A11Y-5 (pass 32): the row is a button NAMED by its content; the live
    // tree tool reported it unnamed.
    expect(getByRole("button", { name: /Security reviewer/ })).toBeTruthy();
    fireEvent.click(getByText("Security reviewer"));
    expect(onAdd).toHaveBeenCalledWith("security-reviewer");
  });

  // P14-UI-63: the pill printed the TEMPLATE's own stage count, so this row
  // promised "1 stage" on a board that has no `review` stage at all — and the
  // roster contradicted it one click later. The count is now what the profile
  // will actually be eligible for HERE.
  it("counts the stages the template resolves to on THIS board, not its own", () => {
    const { getByText, queryByText } = render(
      <LibraryPicker
        library={TEMPLATES}
        stages={LIGHTWEIGHT_BOARD}
        workflow={LIGHTWEIGHT_WORKFLOW}
        projectName="Lightweight Lab"
        busy={false}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    // `review` names the REVIEW role; this 3-stage board fills it with `doing`.
    expect(getByText("1 stage here")).toBeTruthy();
    expect(queryByText("1 stage")).toBeNull();
  });

  it("says 'every stage here' when the declaration means nothing on this board", () => {
    const { getByText } = render(
      <LibraryPicker
        library={[{ ...TEMPLATES[0]!, stages: ["spec-review"] }]}
        stages={LIGHTWEIGHT_BOARD}
        workflow={LIGHTWEIGHT_WORKFLOW}
        projectName="Lightweight Lab"
        busy={false}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    // Rule 3 (R14-1) — unrestricted rather than eligible for nothing, and the
    // pill says the same thing the roster will say after the deploy.
    expect(getByText("every stage here")).toBeTruthy();
  });

  it("says so when every global profile is already deployed", () => {
    const { getByText } = render(
      <LibraryPicker
        library={[]}
        stages={STAGES}
        workflow={WORKFLOW}
        projectName="Viberr Core"
        busy={false}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(getByText(/Every global profile is already deployed here/)).toBeTruthy();
  });
});

/**
 * P13-D-10: the page's hand-rolled result handler pushed the server's error
 * string with `push`'s default `"success"` kind, so a rejected deploy rendered
 * under the green tick. (The create/edit modals route their errors inline, so
 * the toast branch only fires for the non-modal mutations — deploy-from-library
 * is one.)
 */
describe("AgentsPage failure toast kind (P13-D-10)", () => {
  /** The failure half of what the route's mutations answer with — the branch
   *  whose toast kind is on trial here. */
  type FailedActionResult = { ok: false; error: string };

  function renderPage(actionResult: FailedActionResult) {
    const Stub = createRoutesStub([
      {
        path: "/projects/viberr-core/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[mkProfile({})]}
              library={[
                {
                  id: "reviewer",
                  name: "Reviewer",
                  role: "Review",
                  desc: "Reviews the branch.",
                  backends: ["claude"],
                  stages: ["review"],
                  spanAll: false,
                  resources: { skills: [], mcps: [], kb: [] },
                },
              ]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
            />
          </ToastProvider>
        ),
        action: async () => actionResult,
      },
    ]);
    return render(<Stub initialEntries={["/projects/viberr-core/agents"]} />);
  }

  it("renders the alert glyph, not the success tick, when a deploy fails", async () => {
    const { getAllByText, getByText } = renderPage({
      ok: false,
      error: "That template no longer exists.",
    });
    fireEvent.click(getAllByText(/Add from library/)[0]!);
    fireEvent.click(getByText("Reviewer").closest("button")!);
    await waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    const toast = document.querySelector(".toast")!;
    expect(toast.textContent).toContain("That template no longer exists.");
    // `alert` is the triangle path; `check` is the tick.
    expect(toast.querySelector("svg.ico")!.innerHTML).toContain("M12 4l9 16H3z");
  });
});

/**
 * F16 (live): a Codex-backed profile whose backend could not run read "idle ·
 * available" on this page, while the task-level Execution profile panel one
 * click away disagreed. Availability is two claims — nothing is running it,
 * AND a run could start — and only the first was ever checked here.
 *
 * Ruling 127 makes the second claim person-shaped: a run bills the task
 * owner's own account, so what this page answers is whether the VIEWER has
 * connected the backend (they are who presses Run on the tasks they own),
 * alongside how many project members have.
 */
describe("F16: the roster tells the truth about backend connections", () => {
  const HEALTHY: BackendHealthMap = {
    codex: {
      backend: "codex" as const,
      viewerConnected: true,
      membersConnected: 3,
      membersTotal: 7,
    },
    claude: {
      backend: "claude" as const,
      viewerConnected: true,
      membersConnected: 5,
      membersTotal: 7,
    },
  };
  const NO_CODEX: BackendHealthMap = {
    ...HEALTHY,
    codex: {
      backend: "codex" as const,
      viewerConnected: false,
      membersConnected: 2,
      membersTotal: 7,
    },
  };

  const renderDetail = (backendHealth?: BackendHealthMap) =>
    render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        {...(backendHealth ? { backendHealth } : {})}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );

  it("still says 'idle · available' when the viewer has the backend connected", () => {
    const { getByText, queryByText } = renderDetail(HEALTHY);
    expect(getByText("idle · available")).toBeTruthy();
    expect(queryByText(/not connected/)).toBeNull();
  });

  it("states WHOSE account a run spends, and how many members could (ruling 127)", () => {
    // The runtime row's old answer was a deployment claim. This page is not on
    // a task, so it cannot name the person a run will bill — it states the
    // RULE, and the one instance-level number that survives per-person
    // credentials: how many of this project's members have connected it.
    const { container } = renderDetail(HEALTHY);
    // `mkProfile` runs Codex first — "a run uses the first".
    expect(container.textContent).toContain(
      "Runs use the task owner's Codex account · 3 of 7 members connected",
    );
    // Nothing claims the deployment holds a credential: it holds none.
    expect(container.textContent).not.toContain("on this instance");
    expect(container.textContent).not.toContain("configured");
  });

  it("says it on a profile whose backend the viewer HAS not connected too, with that backend's own count", () => {
    const { container } = renderDetail(NO_CODEX);
    expect(container.textContent).toContain(
      "Runs use the task owner's Codex account · 2 of 7 members connected",
    );
  });

  it("says the VIEWER has not connected it, instead of claiming availability", () => {
    const { container, getByText, queryByText } = renderDetail(NO_CODEX);
    // `mkProfile` runs Codex first — "a run uses the first".
    expect(queryByText("idle · available")).toBeNull();
    expect(getByText("idle · Codex not connected")).toBeTruthy();
    // The backend chip mirrors the task-level panel's wording…
    expect(container.querySelector(".be-chip .model-sub")!.textContent).toContain(
      "not connected",
    );
    // …and the actionable sentence is on screen, addressed to the person and
    // naming where they fix it — no environment variable, because ruling 127
    // left none to set.
    expect(container.textContent).toContain("Profile → Agent accounts");
    expect(container.textContent).toContain("2 of 7 project members");
    expect(container.textContent).not.toContain("VIBERR_CODEX_USE_CLI_AUTH");
    // The empty-deployments copy stops calling it assignable.
    expect(container.textContent).toContain("would be refused");
  });

  it("claims nothing either way when connections were not probed", () => {
    const { getByText, queryByText } = renderDetail(undefined);
    expect(getByText("idle · available")).toBeTruthy();
    expect(queryByText(/not connected/)).toBeNull();
  });

  it("flags the unusable profile in the roster list too", () => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[mkProfile({})]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
              backendHealth={NO_CODEX}
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/agents"]} />,
    );
    // The row badge stops saying the flat "idle" and carries the reason.
    expect(container.querySelector(".profile-list .ag-idle")).toBeNull();
    const badge = container.querySelector(".profile-list .model-sub")!;
    // Ruling 127: the hover sentence names the person's own remedy, not a
    // deployment file path — there is no instance credential to point at.
    expect(badge.getAttribute("title")).toContain("Profile → Agent accounts");
    expect(badge.textContent).toContain("no runtime");
  });
});

/**
 * UXA-15 — Policy and project Settings both explain their read-only state to a
 * role without the grant. Agents hides New profile / Add from library / Edit /
 * Delete outright and said nothing, so a contributor saw a roster they could
 * not touch and no reason why.
 */
describe("UXA-15: the Agents page explains its read-only state", () => {
  const renderAs = (myRole: ProjectRole) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[mkProfile({})]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole={myRole}
            />
          </ToastProvider>
        ),
      },
    ]);
    return render(<Stub initialEntries={["/projects/viberr-core/agents"]} />);
  };

  it("a contributor is told which grant is missing, named as the Policy matrix names it (F20-16)", () => {
    const { container } = renderAs("contributor");
    expect(container.textContent).toContain("Read-only");
    // F20-16: the REAL grant label (the Policy matrix's `manage-agents` row) and
    // the REAL tier — admin only. The old copy invented "Manage agents … (project
    // admin or maintainer)", telling a maintainer they held a grant this page refuses.
    expect(container.textContent).toContain("Manage agent profiles");
    expect(container.textContent).toContain("project admin");
    expect(container.textContent).not.toContain("or maintainer");
    // The management affordances really are absent — the note explains that.
    expect(container.textContent).not.toContain("Add from library");
  });

  it("an admin sees no read-only note", () => {
    const { container } = renderAs("admin");
    expect(container.textContent).not.toContain("Read-only");
  });
});

/**
 * UX19-11 — the delete-profile confirm is the last guardrail before an
 * irreversible policy change, and it stated the opposite of the ruling that
 * decides the outcome. "Those threads keep running until the operator reassigns
 * them" promised continuity twice over: ruling 26 (R15-7) makes every
 * subsequent run of an unresolvable profile fully conservative — no delivery,
 * no comments, no ask-human, no evidence — and `deleteAgentProfile` queues no
 * operator run, writes no task timeline event and sends no notification, so
 * nothing initiates the reassignment the sentence names.
 */
describe("UX19-11: the delete-profile confirm states R15-7's real outcome", () => {
  const renderConfirm = (insts: AgentDeploymentView[]) => {
    const utils = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={insts}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    fireEvent.click(utils.getByText("Delete"));
    return utils.container.querySelector('[role="alertdialog"]')!;
  };

  it("does not promise that engaged threads keep running, or that the operator reassigns them", () => {
    const dialog = renderConfirm([mkDeployment({})]);
    // Canary: restore the old sentence and both of these fail.
    expect(dialog.textContent).not.toContain("keep running");
    expect(dialog.textContent).not.toContain("until the operator reassigns");
  });

  it("names what ruling 26 actually withholds, and whose job the recovery is", () => {
    const dialog = renderConfirm([
      mkDeployment({}),
      mkDeployment({ taskKey: "VIB-151" }),
    ]);
    expect(dialog.textContent).toContain("2 active tasks");
    expect(dialog.textContent).toContain("stay on the tasks");
    expect(dialog.textContent).toContain(
      "can't deliver, comment, ask a question or attach evidence",
    );
    // The human's next step, named — the copy used to hand it to the operator.
    expect(dialog.textContent).toContain("assigns a replacement");
  });

  it("an unengaged profile still gets the short, true sentence", () => {
    const dialog = renderConfirm([]);
    expect(dialog.textContent).toContain("The global base definition is unaffected.");
    expect(dialog.textContent).not.toContain("stay on the tasks");
  });
});

/**
 * F20-9 / D1 second half — the operator card sat "Accept completion into Done"
 * under a granted bucket while "Transition a task to Done" sat under RESERVED
 * FOR HUMANS, with no reconciliation. The Policy page carries exactly the note
 * that resolves this; the Agents card now borrows the SAME canonical constant so
 * the two surfaces cannot drift.
 */
describe("F20-9: the operator card carries the Transition-to-Done exception note", () => {
  const renderDetail = (a: AgentProfileView) =>
    render(
      <ProfileDetail
        a={a}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );

  it("renders the imported Policy-page exception copy on the operator card", () => {
    const { container } = renderDetail(
      mkProfile({
        id: "operator",
        kind: "operator",
        name: "Operator",
        icon: "shield",
        autonomy: "supervised",
        actions: {
          direct: [],
          recommend: ["Accept completion into Done"],
          forbidden: ["Transition a task to Done", "Change project policy"],
        },
        capabilities: [],
      }),
    );
    const note = container.querySelector(".cap-exception")!;
    expect(note).toBeTruthy();
    expect(note.textContent).toContain("Transition a task to Done");
    // The exact exported constant, never a restated paraphrase (single source).
    expect(note.textContent).toContain(TRANSITION_TO_DONE_EXCEPTION);
  });

  it("does NOT render the operator-only note on a specialist card", () => {
    // The Developer's forbidden bucket includes "Transition a task to Done", but
    // the exception is the OPERATOR's — a specialist can never do it.
    const { container } = renderDetail(mkProfile({}));
    expect(container.querySelector(".cap-exception")).toBeNull();
  });
});

/**
 * R20-3 / F20-4 — a profile pinned to (or falling back to) a model a real run
 * proved this account can't use renders a badge with the provider's own
 * sentence, instead of a value that would 400 at the SDK.
 */
describe("F20-4: the model cell flags a provider-refused model", () => {
  it("shows an 'unavailable' badge carrying the provider reason", () => {
    const { getByText } = render(
      <ProfileDetail
        a={mkProfile({
          backends: ["codex"],
          model: "gpt-5.6-sol",
          modelLabel: "GPT-5.6 Sol",
          modelKnown: true,
          modelUnavailable: {
            reason:
              "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
            markedAt: "2026-08-15T00:00:00.000Z",
          },
        })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    const badge = getByText("unavailable");
    expect(badge).toBeTruthy();
    expect(badge.closest(".model-sub")!.getAttribute("title")).toContain(
      "not supported",
    );
  });

  it("shows no unavailable badge when the model is not marked", () => {
    const { queryByText } = render(
      <ProfileDetail
        a={mkProfile({ backends: ["codex"], modelKnown: true })}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(queryByText("unavailable")).toBeNull();
  });
});

/**
 * C10 — the run/engagement status pills went through a shared mapper for the
 * KIND but rendered the raw `d.status` text as the label. Routing both call
 * sites through `DeploymentStatusPill` centralizes the vocabulary AND restores
 * the article the board carries ("waiting on a human"), while the server-derived
 * status VALUE is unchanged.
 */
describe("C10: deployment status renders through the shared pill mapper", () => {
  it("the live roster reads 'waiting on a human', not the article-less raw status", () => {
    const { container } = render(
      <LiveRoster
        deployments={[mkDeployment({ status: "waiting on human" })]}
        onOpen={() => {}}
      />,
    );
    expect(container.textContent).toContain("waiting on a human");
    // The article-less raw form is gone from the rendered label.
    expect(container.textContent).not.toContain("waiting on human");
  });

  it("the profile-detail deployment row uses the same pill", () => {
    const { container } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
        workflow={WORKFLOW}
        insts={[mkDeployment({ status: "waiting on human" })]}
        projectName="Viberr Core"
        canManage
        onOpen={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />,
    );
    const pill = container.querySelector(".deploy-row .pill")!;
    expect(pill.textContent).toContain("waiting on a human");
  });
});

/**
 * C11 — the task surface settled on "delivering agent" (UXA-6 / FR14), but the
 * Agents page still called the group "Specialist profiles" with a "New
 * specialist profile" button: three names for one object one click apart. The
 * page drops the retired vocabulary and records the profile-vs-engagement split.
 */
describe("C11: the Agents page drops the retired 'specialist profile' vocabulary", () => {
  it("names the group 'Agent profiles' and records the delivering/supporting split", () => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[
                mkProfile({ id: "operator", kind: "operator", name: "Operator" }),
                mkProfile({}),
              ]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/agents"]} />,
    );
    expect(container.textContent).toContain("Agent profiles");
    // The delivering/supporting engagement split is stated on the page.
    expect(container.textContent).toContain("delivering agent");
    // None of the three retired phrasings survive.
    expect(container.textContent).not.toContain("Specialist profiles");
    expect(container.textContent).not.toContain("New specialist profile");
  });
});

/**
 * F20-4 (client half) — the model picker offers a model a real run proved this
 * account can't use, but disables it and explains why, so an admin can't re-pin
 * a profile to a value that would 400 at the SDK.
 */
describe("CreateProfileModal — a provider-refused model is disabled + explained", () => {
  const UNAVAILABLE_CODEX: ModelCatalog = {
    models: [
      {
        value: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        description: "Workhorse.",
        supportsEffort: true,
        efforts: ["low", "medium", "high", "xhigh"],
      },
      {
        value: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Flagship.",
        supportsEffort: true,
        efforts: ["low", "medium", "high", "xhigh"],
        unavailable: {
          reason:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
          markedAt: "2026-08-15T00:00:00.000Z",
        },
      },
    ],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultModel: "gpt-5.6-terra",
    defaultEffort: "medium",
  };

  it("disables the marked option and, when it is the seeded model, names the reason", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <CreateProfileModal
            initial={mkProfile({
              backends: ["codex"],
              model: "gpt-5.6-sol",
              effort: "high",
            })}
            stages={STAGES}
            projectName="Viberr Core"
            busy={false}
            error={null}
            onClose={() => {}}
            onSubmit={() => {}}
          />
        ),
      },
      {
        path: "/resources/model-catalog",
        loader: () => ({ data: UNAVAILABLE_CODEX }),
      },
    ]);
    const { container } = render(<Stub initialEntries={["/"]} />);

    // The Sol option loads disabled, with the refusal on its label.
    await waitFor(() => {
      const opt = [...container.querySelectorAll("option")].find(
        (o) => o.value === "gpt-5.6-sol",
      );
      expect(opt?.disabled).toBe(true);
      expect(opt?.textContent).toContain("unavailable for this account");
    });
    // The seeded model is the refused one, so the reason line renders in full.
    const err = container.querySelector(".fhint.err")!;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("not supported");
    expect(err.textContent).toContain("Pick another model.");
  });
});

/**
 * Pass 34 review — the effort re-seed and the effort select must read the SAME
 * list. The re-seed judged the stored tier against the backend-wide list while
 * the select renders the selected model's own (narrower) list, so a stored
 * `max` on a model that stops at `high` stood as the picker's value with no
 * option to match, and the save would refuse it by name (ruling 139).
 */
describe("CreateProfileModal — a tier the selected model does not offer is re-seeded", () => {
  const NARROWING: ModelCatalog = {
    models: [
      {
        value: "haiku",
        displayName: "Claude Haiku",
        description: "Fast.",
        supportsEffort: true,
        efforts: ["low", "medium"],
      },
      {
        value: "opus",
        displayName: "Claude Opus",
        description: "Most capable.",
        supportsEffort: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultModel: "opus",
    defaultEffort: "high",
  };

  function mount(initial: AgentProfileView) {
    const onSubmit = vi.fn();
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <CreateProfileModal
            initial={initial}
            stages={STAGES}
            projectName="Viberr Core"
            busy={false}
            error={null}
            onClose={() => {}}
            onSubmit={onSubmit}
          />
        ),
      },
      { path: "/resources/model-catalog", loader: () => ({ data: NARROWING }) },
    ]);
    const view = render(<Stub initialEntries={["/"]} />);
    const effortSelect = () =>
      view.container.querySelector<HTMLSelectElement>("select[aria-label='Effort']")!;
    return { ...view, onSubmit, effortSelect };
  }

  it("saves a tier the model actually offers, never the one it never showed", async () => {
    // Canary: point seedEffort back at `catalog.efforts` — `max` is on the
    // backend-wide list, so it survives the re-seed and is SAVED even though
    // the picker only ever showed low/medium (the browser renders the first
    // option for an unmatched value, so the screen looks fine and the stored
    // value is the one ruling 139's save refuses).
    const { onSubmit, effortSelect, getByText } = mount(
      mkProfile({ backends: ["claude"], model: "haiku", effort: "max" }),
    );
    await waitFor(() => {
      expect([...effortSelect().options].map((o) => o.value)).toEqual(["low", "medium"]);
    });
    // The clamp is an effect on the catalog answer: let its state update
    // commit before submitting, or the click reads the render before it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The catalog default (`high`) is not on offer either, so the first tier
    // the model does offer is what stands and what gets saved.
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("keeps the catalog default when the selected model does offer it", async () => {
    const { onSubmit, effortSelect, getByText } = mount(
      mkProfile({ backends: ["claude"], model: "opus", effort: "" }),
    );
    await waitFor(() => expect(effortSelect().value).toBe("high"));
    // The clamp is an effect on the catalog answer: let its state update
    // commit before submitting, or the click reads the render before it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ model: "opus", effort: "high" });
  });

  it("clamps the pick when the person SWITCHES to a model with fewer tiers", async () => {
    // Canary: delete the [model] effect — the editor keeps `max` while the
    // picker shows low/medium and saves it.
    const { onSubmit, effortSelect, container, getByText } = mount(
      mkProfile({ backends: ["claude"], model: "opus", effort: "max" }),
    );
    await waitFor(() => expect(effortSelect().value).toBe("max"));
    const modelSelect = container.querySelector<HTMLSelectElement>("select[aria-label='Model']")!;
    fireEvent.change(modelSelect, { target: { value: "haiku" } });
    await waitFor(() => {
      expect([...effortSelect().options].map((o) => o.value)).toEqual(["low", "medium"]);
    });
    // The clamp is an effect on the catalog answer: let its state update
    // commit before submitting, or the click reads the render before it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ model: "haiku", effort: "low" });
  });
});

/**
 * D33-2 — `docs/ui/surfaces.md` §4 states the screen-label contract as
 * universal ("every top-level surface and dialog carries data-screen-label so
 * tests and agents can address it by name"), and these two dialogs carried
 * none: a sweep that addresses surfaces by name could not see the capability
 * matrix or the profile editor at all.
 */
describe("D33-2: the agents dialogs carry a data-screen-label", () => {
  it("the capability matrix names itself", () => {
    const { container } = render(
      <CapabilityMatrixModal
        profiles={[mkProfile({})]}
        projectName="Viberr Core"
        onClose={() => {}}
      />,
    );
    const dialog = container.querySelector("dialog")!;
    expect(dialog.getAttribute("data-screen-label")).toBe("Capability matrix modal");
  });

  it("the profile editor names itself with ONE stable label in both modes", () => {
    const label = "Agent profile modal";
    const created = renderModal({ initial: null });
    const createDialog = created.container.querySelector("dialog")!;
    expect(createDialog.getAttribute("data-screen-label")).toBe(label);
    // The accessible name stays mode-dependent (a reader wants to know which
    // profile they opened); the screen label is the surface's stable name, so
    // one string addresses the create and the edit case alike.
    expect(createDialog.getAttribute("aria-label")).toBe("New agent profile");
    cleanup();

    const edited = renderModal({ initial: mkProfile({}) });
    const editDialog = edited.container.querySelector("dialog")!;
    expect(editDialog.getAttribute("data-screen-label")).toBe(label);
    expect(editDialog.getAttribute("aria-label")).toBe("Edit profile");
  });
});

/**
 * U33-5 — selecting a roster entry and pressing "Edit profile" without a pause
 * opened the editor for the profile selected BEFORE it, and saving from that
 * form wrote its grants onto that other profile (confirmed live in project.md).
 * The selection lives in the URL, and `setSearchParams` is a navigation:
 * `useSearchParams` keeps returning the committed location until the router
 * lands, so for a beat the detail pane — and the profile object its Edit button
 * hands the editor — was still the previous one. A silent misbinding onto
 * governance data has to be impossible, not merely unlikely, so the pick is
 * recorded synchronously and the URL follows.
 */
describe("U33-5: Edit profile opens the profile the roster just selected", () => {
  const OPERATOR = mkProfile({
    id: "operator",
    kind: "operator",
    name: "Operator",
    role: "Orchestration",
    icon: "shield",
  });
  const DEVELOPER = mkProfile({ id: "developer", name: "Developer" });

  /** The COMMITTED `?profile=` — the stub router is in memory, so the query
   *  the page navigated to is readable only from inside it. */
  function SelProbe() {
    const [params] = useSearchParams();
    return <p data-testid="url-profile">{params.get("profile") ?? ""}</p>;
  }

  /**
   * The real `/projects/:slug/agents` has a LOADER, so a `?profile=`
   * navigation is a `.data` round-trip the router must finish before the new
   * location commits — the gap the two clicks fell into. A stub with no loader
   * lands the navigation inside the click and reproduces nothing, so this one
   * holds every navigation after the first until the test lets it land.
   *
   * It hands back a SETTLED page, and the awaited act() below is what settles
   * it. These tests used to open with `await waitFor(… hero is "Operator")`,
   * and a waitFor returns on a RENDER: RTL turns the act environment off while
   * it polls, so the commit it sees leaves that commit's passive effects still
   * queued on React's scheduler. One of them is this page's own `[urlSel]`
   * effect — the one that drops a pending pick once the URL is the authority
   * again. React flushes it inside the next act(), which is the ROSTER CLICK's,
   * where it lands after that click's `setPendingSel` and clears the very pick
   * the test is about: the page falls back to the committed `?profile=`, and
   * the editor opens "Edit Operator". That is the 2026-09-15 full-suite
   * failure, and it is timing-only — the effect usually flushes inside the
   * trailing setTimeout(0) of RTL's own async wrapper, which is why the file
   * alone never showed it.
   *
   * An awaited act() has no such gap: the act environment stays ON, so the
   * loader landing, the commit it causes and that commit's effects all run
   * inside it, and every read after it is a plain synchronous one (the recipe
   * e0953f7f settled on for the dock poll test). Measured by holding React's
   * scheduler callback back — what a loaded machine does to it — the waitFor
   * shape failed this test and the one below it on every run at a 40 ms hold,
   * and this shape passed at 40 ms and 200 ms alike.
   */
  async function renderPage() {
    let opened = false;
    let land = () => {};
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/agents",
        loader: (): null | Promise<null> => {
          if (!opened) {
            opened = true;
            return null;
          }
          return new Promise<null>((resolve) => {
            land = () => resolve(null);
          });
        },
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[OPERATOR, DEVELOPER]}
              deployments={[]}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
            />
            <SelProbe />
          </ToastProvider>
        ),
      },
      {
        path: "/resources/model-catalog",
        loader: () => ({ data: CLAUDE_CATALOG }),
      },
    ]);
    const view = render(<Stub initialEntries={["/projects/viberr-core/agents"]} />);
    await act(async () => {});
    return { ...view, land: () => land() };
  }

  /** The roster row for a profile, by the name it renders. */
  const rosterItem = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll(".profile-list .ag-item")].find(
      (el) => el.querySelector(".nm")?.textContent === name,
    )!;

  it("clicking a roster entry and Edit in the same beat edits THAT profile", async () => {
    // `waitFor` does NOT mean the mount settled: RTL turns the act environment
    // OFF while it polls, so the page's own opening navigation could still be
    // in flight when the two clicks below fire — and then the HELD navigation
    // is that one rather than the Developer click's, and `url-profile` is not
    // "" for the reason this test means. It passed alone and failed about one
    // full-suite run in twenty, under load. Settling here fixes the PRECONDITION
    // and changes nothing about what is under test: the two clicks still fire
    // in the same beat, with no wait between them.
    await act(async () => {});
    const { container, getByText, getByTestId } = await renderPage();
    // The page opens on the operator (the `?profile=` default) — and reading
    // that synchronously is the point: the page is settled, not merely
    // rendered, so nothing of the mount is left to land between the clicks.
    expect(container.querySelector(".ag-hero-name")!.textContent).toBe("Operator");

    // No wait between the two clicks — the live sequence that misfired. The
    // navigation the first click started is still in flight…
    fireEvent.click(rosterItem(container, "Developer"));
    fireEvent.click(getByText("Edit profile"));
    expect(getByTestId("url-profile").textContent).toBe("");

    // …and the editor is nevertheless bound to the profile that was clicked,
    // not to the one the committed URL still names.
    const dialog = document.querySelector(
      'dialog[data-screen-label="Agent profile modal"]',
    )!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Edit Developer");
  });

  it("the roster highlight and the detail pane move on the same click", async () => {
    const { container } = await renderPage();
    expect(container.querySelector(".ag-hero-name")!.textContent).toBe("Operator");
    fireEvent.click(rosterItem(container, "Developer"));
    expect(container.querySelector(".ag-hero-name")!.textContent).toBe("Developer");
    expect(rosterItem(container, "Developer").className).toContain("on");
    expect(rosterItem(container, "Operator").className).not.toContain("on");
  });

  it("the pick still reaches the URL, so the selection stays linkable", async () => {
    const { container, getByTestId, land } = await renderPage();
    // The synchronous pick is a shortcut PAST the pending navigation, never
    // instead of it: P13-UI-58 put the selection in the URL so it is linkable
    // and survives a reload, and that has to keep happening.
    expect(container.querySelector(".ag-hero-name")!.textContent).toBe("Operator");
    fireEvent.click(rosterItem(container, "Developer"));
    land();
    await waitFor(() =>
      expect(getByTestId("url-profile").textContent).toBe("developer"),
    );
    // …and once the URL is the authority again the pane has not drifted.
    expect(container.querySelector(".ag-hero-name")!.textContent).toBe("Developer");
  });
});


/**
 * F34-5 — the Agents page's "working" claims were read from the task's
 * `waiting` flag: the projection called a deliverer "working" whenever the
 * task was agent-waiting, the stat counted that word, and the pill's pulse
 * OR-ed the word in beside the real `running` bit. Live, the card read "5
 * agent threads in a working state" with ONE run alive. The projection now
 * derives the word from the run row (agent-deployments.server.test.ts); this
 * side pins that the page reads the run, not the word, and that the waiting
 * stat kept counting task-level waiting (correction d) with a label that says
 * whose waiting it is.
 */
describe("F34-5: the Agents stats and the pulse read runs, not the waiting flag", () => {
  /** A one-page roster the OLD arithmetic and the new one disagree on. */
  const ROSTER: AgentDeploymentView[] = [
    // VIB-1: operator AND deliverer both live — the operator is running
    // (status "coordinating"), which the old `status === "working"` count
    // never counted.
    mkDeployment({ taskKey: "VIB-1", engagement: "operator", profileId: "operator", role: "Operator", backend: null, status: "coordinating", running: true, taskWaiting: "agent" }),
    mkDeployment({ taskKey: "VIB-1", engagement: "primary", status: "working", running: true, taskWaiting: "agent" }),
    // VIB-2: a queued run — admitted, no slot yet, NOT in flight.
    mkDeployment({ taskKey: "VIB-2", engagement: "primary", status: "queued", running: false, taskWaiting: "agent" }),
    // VIB-3 waits on a human while its reviewer runs: the reviewer says
    // "working" and must still count as an engagement on a task waiting on a
    // human (correction d).
    mkDeployment({ taskKey: "VIB-3", engagement: "primary", status: "waiting on human", running: false, taskWaiting: "human" }),
    mkDeployment({ taskKey: "VIB-3", engagement: "reviewer", role: "Reviewer", status: "working", running: true, taskWaiting: "human" }),
    // VIB-4: an operator holding a packet.
    mkDeployment({ taskKey: "VIB-4", engagement: "operator", profileId: "operator", role: "Operator", backend: null, status: "packet open", running: false, taskWaiting: "human" }),
  ];

  /** label → rendered number, for the four `.ag-stat` cells. */
  function renderStats() {
    const Stub = createRoutesStub([
      {
        path: "/projects/viberr-core/agents",
        Component: () => (
          <ToastProvider>
            <AgentsPage
              profiles={[mkProfile({})]}
              library={[]}
              deployments={ROSTER}
              stages={STAGES}
              workflow={WORKFLOW}
              projectSlug="viberr-core"
              projectName="Viberr Core"
              myRole="admin"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(<Stub initialEntries={["/projects/viberr-core/agents"]} />);
    const stats = new Map<string, string>();
    for (const stat of container.querySelectorAll(".ag-stat")) {
      stats.set(stat.querySelector(".l")!.textContent!, stat.querySelector(".n")!.textContent!);
    }
    return stats;
  }

  it("the 'run in flight' stat counts d.running; the waiting stat counts the TASK's flag", () => {
    // Canary: restore the status clauses (`status === "working"` for the first,
    // `"waiting on human" || "packet open"` for the second) — the old sums are
    // 2 and 2 for this roster.
    const stats = renderStats();
    expect(stats.get("agent threads with a run in flight")).toBe("3");
    expect(stats.get("agent threads waiting on a human")).toBe("3");
    // Non-vacuity: the two labels this pins really are the rendered ones, so
    // a renamed label fails here rather than passing by absence.
    expect(stats.size).toBe(4);
    expect(stats.get("tasks with a live operator")).toBe("2");
  });

  it("deploymentDot pulses for a live run and for nothing else", () => {
    // Canary: restore the status clauses (`d.status === "working" ||
    // d.status === "coordinating" || d.running`) and the first case pulses.
    expect(deploymentDot(mkDeployment({ status: "working", running: false }))).toBe(false);
    expect(deploymentDot(mkDeployment({ status: "coordinating", running: false }))).toBe(false);
    expect(deploymentDot(mkDeployment({ status: "on call", running: true }))).toBe(true);
    expect(deploymentDot(mkDeployment({ status: "queued", running: false }))).toBe(false);
  });
});

/** Ruling 139: the editor never offers a tier it cannot save. */
describe("CreateProfileModal effort seeding (ruling 139)", () => {
  it("a profile whose stored effort is out of the backend's list shows the backend default and submits it", async () => {
    // Canary: restore the preserved `<option value={effort}>` (the stale tier
    // stays selected and is submitted).
    const onSubmit = vi.fn();
    const { container, findByLabelText, getByText } = renderModal({
      initial: mkProfile({ backends: ["claude"], model: "sonnet", effort: "ultra" }),
      onSubmit,
    });
    // SAFETY: the modal renders its Effort control as a <select>, which is
    // what the label resolves to.
    const select = (await findByLabelText("Effort")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("high"));
    expect([...select.options].map((o) => o.value)).not.toContain("ultra");
    expect(container.querySelector("option[value=ultra]")).toBeNull();
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].effort).toBe("high");
  });
});

/** B5 (pass 34, U34-3): the editor submits the record it was opened on. */
describe("CreateProfileModal fingerprint (B5)", () => {
  it("an EDIT carries the deployment's fingerprint back to the server", () => {
    // Canary: drop the hidden field — the server then refuses every save
    // (the create half, which must carry none, is pinned on the route).
    const onSubmit = vi.fn();
    const { getByText } = renderModal({
      initial: mkProfile({ fingerprint: "fp-opened-on" }),
      onSubmit,
    });
    fireEvent.click(getByText("Save changes"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].fingerprint).toBe("fp-opened-on");
  });
});
