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
import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";
import { CapabilityMatrixModal } from "./capability-matrix-modal";
import {
  CreateProfileModal,
  type ProfileFormPayload,
} from "./create-profile-modal";
import { LiveRoster, ProfileDetail } from "./agents-page";

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
    scope: "Global base · customized for Viberr Core",
    desc: "Implements stage work on the task-key branch.",
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

  it("hides manage affordances for non-admins", () => {
    const { queryByText } = render(
      <ProfileDetail
        a={mkProfile({})}
        stages={STAGES}
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
    expect(rendered[0]!.querySelector(".live-role")!.textContent).toBe("Operator");
    expect(rendered[0]!.querySelector(".live-be")!.textContent).toBe("orchestration");
    expect(rendered[1]!.querySelector(".live-be")!.textContent).toBe("Codex");
    expect(rendered[2]!.querySelector(".live-be")!.textContent).toBe("Claude Code");
    fireEvent.click(rendered[2]!);
    expect(onOpen).toHaveBeenCalledWith("VIB-2");
  });

  it("renders the added empty state when nothing is engaged", () => {
    const { getByText } = render(<LiveRoster deployments={[]} onOpen={() => {}} />);
    expect(getByText("No agents are currently engaged.")).toBeTruthy();
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
    const { container, getByText } = render(
      <CapabilityMatrixModal
        profiles={profiles}
        projectName="Viberr Core"
        onClose={onClose}
      />,
    );
    expect(getByText("Capability matrix")).toBeTruthy();
    expect(
      getByText("Every profile's permissions for each action in Viberr Core."),
    ).toBeTruthy();
    expect(getByText("Repository & execution")).toBeTruthy();
    expect(getByText("Workflow & approvals")).toBeTruthy();
    // Off-catalog operator action lands in "Other actions".
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
