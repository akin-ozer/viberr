// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { AgentDeploymentView, AgentProfileView } from "./agent-types";
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

afterEach(cleanup);

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
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "ready", name: "Ready", color: "#187574" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
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
  { id: "todo", name: "To do", color: "#a5a8b5" },
  { id: "doing", name: "Doing", color: "#7b61ff" },
  { id: "done", name: "Done", color: "#00b473" },
];
const LIGHTWEIGHT_WORKFLOW = [
  { from: "todo", to: "doing" },
  { from: "doing", to: "done" },
];

function mkProfile(patch: Partial<AgentProfileView>): AgentProfileView {
  return {
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
    expect(getByText("Reserved for humans")).toBeTruthy();
    // Deployment row navigates by task key.
    expect(getByText("running on 1 task")).toBeTruthy();
    fireEvent.click(container.querySelector(".deploy-row")!);
    expect(onOpen).toHaveBeenCalledWith("VIB-142");
  });

  /**
   * F15-05/F15-06 (live): admins read this panel as policy truth. A profile
   * created with nothing granted showed a full ACTS DIRECTLY column — "Approve
   * the review", "Request changes", "Post quality-flag events" and the rest of
   * the advisory catalog — plus a context resource nobody picked. The columns
   * now render GOVERNED policy only (the partition the matrix draws), and
   * advisory guidance says what it is.
   */
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
    expect(items).toContain("Approve the review (reserved for humans)");
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
    expect(getByText("Claude Code")).toBeTruthy();
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
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(getByText("Delete the Developer profile?")).toBeTruthy();
    expect(getByText("1 active task")).toBeTruthy();
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
      getByText("declared stages don't exist here — eligible everywhere"),
    ).toBeTruthy();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(3);
    expect(getByText(/the declaration says nothing here/)).toBeTruthy();
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
    expect(getByText("no stage restriction — eligible everywhere")).toBeTruthy();
    expect(container.querySelectorAll(".stage-chip.elig")).toHaveLength(
      STAGES.length,
    );
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
      mkDeployment({ taskKey: "VIB-2", engagement: "reviewer", role: "Reviewer", backend: "claude", status: "anchored · on call" }),
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
    expect(rendered[2]!.querySelector(".live-be")!.textContent).toBe("Claude Code");
    // Engagement is human-facing, not the internal primary/reviewer literals.
    expect(rendered[1]!.textContent).toContain("delivering");
    expect(rendered[2]!.textContent).toContain("supporting");
    expect(rendered[1]!.textContent).not.toContain("primary");
    fireEvent.click(rendered[2]!);
    expect(onOpen).toHaveBeenCalledWith("VIB-2");
  });

  it("renders the added empty state when nothing is engaged", () => {
    const { getByText } = render(<LiveRoster deployments={[]} onOpen={() => {}} />);
    expect(getByText("No agents are currently engaged.")).toBeTruthy();
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
          direct: ["Assign the primary specialist"],
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
    // "Reserved for humans" appears both as a group header and as the mode
    // legend label (CAP_META.forbidden), so match at least one.
    expect(getAllByText("Reserved for humans").length).toBeGreaterThan(0);
    // Off-catalog actions (operator coordination + the pruned advisory review
    // caps a seed profile still carries) land in "Other actions".
    expect(getByText("Other actions")).toBeTruthy();
    expect(getByText("Assign the primary specialist")).toBeTruthy();
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
});

describe("CreateProfileModal", () => {
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
    expect(getByText("Ready to add to Viberr Core.")).toBeTruthy();

    // The catalog fetch resolves the codex default model + effort.
    await waitFor(() =>
      expect(
        (container.querySelector('select[aria-label="Model"]') as HTMLSelectElement)
          ?.value,
      ).toBe("gpt-5-codex"),
    );
    await waitFor(() =>
      expect(
        (container.querySelector('select[aria-label="Effort"]') as HTMLSelectElement)
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
      "No longer in the store — click to remove this grant",
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
      container.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    expect(modelSel().disabled).toBe(true);

    fireEvent.click(getByText("Claude Code"));
    // The claude catalog loads → sonnet/opus options + high default effort.
    await waitFor(() => expect(modelSel().value).toBe("sonnet"));
    const modelValues = Array.from(modelSel().options).map((o) => o.value);
    expect(modelValues).toEqual(["sonnet", "opus"]);
    const effortSel = () =>
      container.querySelector('select[aria-label="Effort"]') as HTMLSelectElement;
    await waitFor(() => expect(effortSel().value).toBe("high"));
    expect(Array.from(effortSel().options).map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("R7-5 — a specialist cap row offers 3 honest modes (Allowed/Human-only/Off), no Recommend", () => {
    // Create mode ⇒ a specialist profile: the picker collapses to 3 modes.
    const { container } = renderModal({ initial: null });
    const seg = container.querySelector(".cap-seg")!;
    const labels = Array.from(seg.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Allowed", "Human-only", "Off"]);
    // `recommend` is operator-only and never shown to a specialist.
    expect(container.querySelector(".cap-matrix")!.textContent).not.toContain(
      "Recommend",
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
    expect(labels).toEqual(["Direct", "Recommend", "Human", "Off"]);
    expect(container.querySelector(".cap-seg button.recommend")).not.toBeNull();
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
        (container.querySelector('select[aria-label="Model"]') as HTMLSelectElement)
          .value,
      ).toBe("opus"),
    );
    expect(
      (container.querySelector('select[aria-label="Effort"]') as HTMLSelectElement)
        .value,
    ).toBe("max");
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
      getByText("Ready to save — this forks Developer for Viberr Core."),
    ).toBeTruthy();
  });

  it("a project-created profile has nothing to fork and says so plainly", () => {
    const { getByText, queryByText } = renderModal({
      initial: mkProfile({ source: "project", name: "Migrations" }),
    });
    expect(
      getByText("Update this project's copy — changes apply to future assignments."),
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
    expect(getByText(/Claude Code will be dropped/)).toBeTruthy();
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

describe("LibraryPicker (owner ruling 1 / AP-05)", () => {
  const TEMPLATES = [
    {
      id: "security-reviewer",
      name: "Security reviewer",
      role: "Security",
      desc: "Reviews IAM, secrets handling and supply-chain risk.",
      backends: ["claude"] as ("codex" | "claude")[],
      stages: ["review"],
      spanAll: false,
      resources: { skills: [], mcps: [], kb: [] },
    },
  ];

  it("lists undeployed templates and adds the picked one by id", () => {
    const onAdd = vi.fn();
    const { getByText } = render(
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
  function renderPage(actionResult: Record<string, unknown>) {
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
 * F16 (live): a Codex-backed profile on an instance with no Codex credential
 * read "idle · available" on this page, while the task-level Execution profile
 * panel one click away read "Codex — not configured". Availability is two
 * claims — nothing is running it, AND a run could start — and only the first
 * was ever checked here. The health comes from `backendCredentialHealth`, the
 * same probe the run service reads.
 */
describe("F16: the roster tells the truth about backend credentials", () => {
  // The REAL shape `backendCredentialHealth()` returns, not a happy-path
  // narrowing of it — `verification` is a 4-way union and `detail` carries the
  // actionable sentence exactly when something is wrong.
  const HEALTHY: BackendHealthMap = {
    codex: {
      backend: "codex" as const,
      available: true,
      verification: "credential" as const,
      detail: null,
    },
    claude: {
      backend: "claude" as const,
      available: true,
      verification: "credential" as const,
      detail: null,
    },
  };
  const NO_CODEX: BackendHealthMap = {
    ...HEALTHY,
    codex: {
      backend: "codex" as const,
      available: false,
      verification: "none" as const,
      detail:
        "VIBERR_CODEX_USE_CLI_AUTH=1 is set, but the Codex CLI login file is missing at `/home/.codex/auth.json`.",
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

  it("still says 'idle · available' when the backend really is configured", () => {
    const { getByText, queryByText } = renderDetail(HEALTHY);
    expect(getByText("idle · available")).toBeTruthy();
    expect(queryByText(/not configured/)).toBeNull();
  });

  it("names the missing credential instead of claiming availability", () => {
    const { container, getByText, queryByText } = renderDetail(NO_CODEX);
    // `mkProfile` runs Codex first — "a run uses the first".
    expect(queryByText("idle · available")).toBeNull();
    expect(getByText("idle · Codex not configured")).toBeTruthy();
    // The backend chip mirrors the task-level panel's wording…
    expect(container.querySelector(".be-chip .model-sub")!.textContent).toContain(
      "not configured",
    );
    // …and the actionable detail is the registry's own sentence, on screen,
    // not buried in a tooltip.
    expect(container.textContent).toContain("auth.json");
    // The empty-deployments copy stops calling it assignable.
    expect(container.textContent).toContain(
      "assigning it would produce a refused run",
    );
  });

  it("claims nothing either way when health was not probed", () => {
    const { getByText, queryByText } = renderDetail(undefined);
    expect(getByText("idle · available")).toBeTruthy();
    expect(queryByText(/not configured/)).toBeNull();
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
    expect(badge.getAttribute("title")).toContain("auth.json");
    expect(badge.textContent).toContain("no runtime");
  });
});
