// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MembershipView } from "./membership.server";
import type { SettingsViewData } from "./settings-query.server";
import {
  DangerZone,
  MembersPanel,
  ProjectPanel,
  RepoPanel,
  StagesPanel,
} from "./settings-page";

afterEach(cleanup);

const PROJECT: SettingsViewData["project"] = {
  slug: "viberr-core",
  name: "Viberr Core",
  prefix: "VIB",
  description: "Core platform work.",
  repo: "akin-ozer/viberr",
  archived: false,
  taskFilePattern: "projects/viberr-core/tasks/<key>/task.md",
};

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "ready", name: "Ready", color: "#187574" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

const MEMBERS: MembershipView[] = [
  { userId: "u_arda", role: "admin", status: "active", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK", tone: "" },
  { userId: "u_elif", role: "admin", status: "active", name: "Elif Demir", email: "elif@viberr.dev", initials: "ED", tone: "rose" },
  { userId: "u_new", role: "viewer", status: "invited", name: "Yeni Kişi", email: "yeni@viberr.dev", initials: "YK", tone: "teal" },
];

// A REAL bound PAT carrying an open scope violation — the honest case that
// renders scope chips + the warn banner (the removed `policy_display`
// fabrication no longer produces a chip card for an unbound project).
const CREDENTIAL: SettingsViewData["credential"] = {
  configured: true,
  source: "pat",
  patId: "pat_seed_1",
  label: "viberr-bot · fine-grained PAT",
  masked: "github_pat_••••42af",
  lastValidatedAt: "2026-07-10T00:00:00.000Z",
  validation: null,
  requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
  scopes: [
    { id: "repo", ok: true, source: "header" },
    { id: "workflow", ok: true, source: "header" },
    { id: "read:org", ok: true, source: "header" },
    { id: "pull_request:write", ok: false, source: "violation", flaggedTaskKey: "VIB-142" },
  ],
  openViolations: [],
};

// The honest unconfigured state — a project with a credentialPolicy but no
// bound PAT lands here (no fabricated chip card).
const NO_CREDENTIAL: SettingsViewData["credential"] = {
  configured: false,
  source: "none",
  patId: null,
  label: null,
  masked: null,
  lastValidatedAt: null,
  validation: null,
  requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
  scopes: [],
  openViolations: [],
};

describe("ProjectPanel", () => {
  it("renders identity fields + the real store-relative task-file pattern, saves only when dirty", () => {
    const onSave = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <ProjectPanel project={PROJECT} canManage onSave={onSave} />,
    );
    expect(getByText("projects/viberr-core/tasks/<key>/task.md")).toBeTruthy();
    expect(getByText("VIB-###")).toBeTruthy();

    const nameInput = getByDisplayValue("Viberr Core");
    fireEvent.blur(nameInput);
    expect(onSave).not.toHaveBeenCalled(); // untouched → no save

    fireEvent.change(nameInput, { target: { value: "Viberr Core 2" } });
    fireEvent.blur(nameInput);
    expect(onSave).toHaveBeenCalledWith({
      name: "Viberr Core 2",
      prefix: "VIB",
      description: "Core platform work.",
    });
  });

  it("uppercases and clips the prefix to 4 chars", () => {
    const { getByDisplayValue } = render(
      <ProjectPanel project={PROJECT} canManage onSave={() => {}} />,
    );
    const prefix = getByDisplayValue("VIB") as HTMLInputElement;
    fireEvent.change(prefix, { target: { value: "corex" } });
    expect(prefix.value).toBe("CORE");
  });
});

describe("StagesPanel", () => {
  const base = {
    stages: STAGES,
    counts: { triage: 2, review: 2 },
    canManage: true,
    editingId: null,
    setEditingId: () => {},
    onReorder: () => {},
    onAdd: () => {},
    onNavPolicy: () => {},
  };

  it("renders rows with locks, counts and the add button", () => {
    const { container, getByText } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
    );
    expect(getByText("5 stages")).toBeTruthy();
    expect(container.querySelectorAll(".stg-row")).toHaveLength(5);
    // triage + done rows are locked (lock icon handle, dimmed remove).
    expect(container.querySelectorAll(".stg-handle.off")).toHaveLength(2);
    expect(container.querySelectorAll(".stg-x.off")).toHaveLength(2);
    expect(getByText("Add stage")).toBeTruthy();
    expect(getByText("Policy → Workflow rules")).toBeTruthy();
  });

  it("locked/non-empty removals stop client-side; empty unlocked ones dispatch", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={onRemove} />,
    );
    const removeButtons = container.querySelectorAll(".stg-x");
    fireEvent.click(removeButtons[0]!); // triage → locked
    fireEvent.click(removeButtons[3]!); // review → 2 tasks
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(removeButtons[1]!); // ready → empty, unlocked
    expect(onRemove).toHaveBeenCalledWith("ready");
  });

  it("rename commits on Enter via blur and cancels on Escape", () => {
    const onRename = vi.fn();
    const setEditingId = vi.fn();
    const { container } = render(
      <StagesPanel
        {...base}
        editingId="ready"
        setEditingId={setEditingId}
        onRename={onRename}
        onRemove={() => {}}
      />,
    );
    const input = container.querySelector(".stg-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "Groomed" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("ready", "Groomed");
    expect(setEditingId).toHaveBeenCalledWith(null);
  });

  it("hides mutating affordances for non-admins", () => {
    const { container, queryByText } = render(
      <StagesPanel {...base} canManage={false} onRename={() => {}} onRemove={() => {}} />,
    );
    expect(queryByText("Add stage")).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".stg-x")).every(
        (b) => (b as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
  });
});

describe("MembersPanel", () => {
  const base = {
    members: MEMBERS,
    meId: "u_arda",
    projectName: "Viberr Core",
    canManage: true,
    busy: false,
    onNavPolicy: () => {},
  };

  it("renders active/invited counts, the you-tag and the pending pill", () => {
    const { container, getByText } = render(
      <MembersPanel {...base} onInvite={() => {}} onRemove={() => {}} />,
    );
    expect(getByText("2 active · 1 invited")).toBeTruthy();
    expect(container.querySelector(".you-tag")).not.toBeNull();
    expect(getByText("invite pending")).toBeTruthy();
    expect(getByText("Policy → Human access")).toBeTruthy();
  });

  it("guards self-removal and last-admin client-side, dispatches otherwise", () => {
    const onRemove = vi.fn();
    const oneAdmin = MEMBERS.map((m) =>
      m.userId === "u_elif" ? { ...m, role: "viewer" as const } : m,
    );
    const { container } = render(
      <MembersPanel {...base} members={oneAdmin} onInvite={() => {}} onRemove={onRemove} />,
    );
    const removeButtons = container.querySelectorAll(".stg-x");
    fireEvent.click(removeButtons[0]!); // self
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(removeButtons[1]!); // elif, now a viewer → allowed
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("invite validates name+email then submits and clears the form", () => {
    const onInvite = vi.fn();
    const { getByPlaceholderText, getByText } = render(
      <MembersPanel {...base} onInvite={onInvite} onRemove={() => {}} />,
    );
    fireEvent.click(getByText("Invite"));
    expect(onInvite).not.toHaveBeenCalled(); // empty form → client toast only

    const nameInput = getByPlaceholderText("Full name") as HTMLInputElement;
    const emailInput = getByPlaceholderText("email@company.dev") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Deniz Şahin" } });
    fireEvent.change(emailInput, { target: { value: "Deniz@viberr.dev" } });
    fireEvent.keyDown(emailInput, { key: "Enter" }); // email field submits
    expect(onInvite).toHaveBeenCalledWith("Deniz Şahin", "deniz@viberr.dev");
    expect(nameInput.value).toBe("");
    expect(emailInput.value).toBe("");
  });

  it("hides invite + remove for non-admins", () => {
    const { container, queryByPlaceholderText } = render(
      <MembersPanel {...base} canManage={false} onInvite={() => {}} onRemove={() => {}} />,
    );
    expect(queryByPlaceholderText("Full name")).toBeNull();
    expect(container.querySelector(".stg-x")).toBeNull();
  });
});

describe("RepoPanel", () => {
  it("renders repo facts, the override toggle and the shared CredentialCard with Grant scope", () => {
    const onToggle = vi.fn();
    const onGrant = vi.fn();
    const onSet = vi.fn();
    const onOpenTask = vi.fn();
    const { container, getByText, queryByText } = render(
      <RepoPanel
        repo="akin-ozer/viberr"
        override
        credential={CREDENTIAL}
        canOverride
        canGrant
        busy={false}
        credBusy={false}
        onToggleOverride={onToggle}
        onGrantScope={onGrant}
        onSetCredential={onSet}
        onClearCredential={() => {}}
        onOpenTask={onOpenTask}
      />,
    );
    expect(getByText("akin-ozer/viberr")).toBeTruthy();
    expect(getByText("tasks may attach a different repo")).toBeTruthy();
    expect(getByText("1 · V1 limit")).toBeTruthy();
    // Shared cred-card: 4 chips, one missing, warn banner with keybtn.
    expect(container.querySelectorAll(".scope-chip")).toHaveLength(4);
    expect(container.querySelectorAll(".scope-chip.miss")).toHaveLength(1);
    expect(container.querySelector(".cred-warn")).not.toBeNull();
    fireEvent.click(getByText("VIB-142"));
    expect(onOpenTask).toHaveBeenCalledWith("VIB-142");
    fireEvent.click(getByText("Grant scope"));
    expect(onGrant).toHaveBeenCalled();

    // A bound PAT → Rotate (managed by `configured`, not the removed
    // policy_display source); no "Attach credential" affordance.
    expect(container.querySelector(".cred-manage")).not.toBeNull();
    expect(queryByText("Attach credential")).toBeNull();
    fireEvent.click(getByText("Rotate credential"));
    expect(onSet).toHaveBeenCalled();

    const toggle = container.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });

  it("unconfigured project (policy but no bound PAT) → honest connect card, no chips (honest empty slate)", () => {
    const onSet = vi.fn();
    const { container, getByText } = render(
      <RepoPanel
        repo="akin-ozer/viberr"
        override
        credential={NO_CREDENTIAL}
        canOverride
        canGrant
        busy={false}
        credBusy={false}
        onToggleOverride={() => {}}
        onGrantScope={() => {}}
        onSetCredential={onSet}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    // No fabricated scope chips and no green "granted" affirmation.
    expect(container.querySelector(".scope-chips")).toBeNull();
    expect(container.querySelector(".cred-ok")).toBeNull();
    expect(container.querySelector(".cred-name")!.textContent).toBe(
      "No credential configured",
    );
    // Only an Attach affordance (nothing bound to rotate/remove).
    fireEvent.click(getByText("Attach credential"));
    expect(onSet).toHaveBeenCalled();
  });

  it("a configured credential offers Rotate + a confirmed Remove (finding #13)", () => {
    const onSet = vi.fn();
    const onClear = vi.fn();
    const bound = {
      ...CREDENTIAL,
      configured: true,
      source: "pat" as const,
      scopes: CREDENTIAL.scopes.map((s) => ({ ...s, ok: true })),
    };
    const { container, getByText, queryByText } = render(
      <RepoPanel
        repo="akin-ozer/viberr"
        override={false}
        credential={bound}
        canOverride
        canGrant
        busy={false}
        credBusy={false}
        onToggleOverride={() => {}}
        onGrantScope={() => {}}
        onSetCredential={onSet}
        onClearCredential={onClear}
        onOpenTask={() => {}}
      />,
    );
    expect(queryByText("Attach credential")).toBeNull();
    fireEvent.click(getByText("Rotate credential"));
    expect(onSet).toHaveBeenCalled();

    // Remove goes through the confirm dialog, not straight to the action.
    fireEvent.click(getByText("Remove credential"));
    expect(onClear).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    fireEvent.click(getByText("Remove credential", { selector: "button.btn.danger" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("renders cred-ok when every scope is granted; non-managers get no manage row", () => {
    const allOk = {
      ...CREDENTIAL,
      scopes: CREDENTIAL.scopes.map((s) => ({ ...s, ok: true })),
    };
    const { container, getByText } = render(
      <RepoPanel
        repo="akin-ozer/viberr"
        override={false}
        credential={allOk}
        canOverride={false}
        canGrant={false}
        busy={false}
        credBusy={false}
        onToggleOverride={() => {}}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    expect(container.querySelector(".cred-ok")).not.toBeNull();
    expect(getByText("all tasks use the default")).toBeTruthy();
    // canGrant=false → no attach/rotate/remove affordances.
    expect(container.querySelector(".cred-manage")).toBeNull();
  });
});

describe("DangerZone", () => {
  it("admin delete flows through the typed-name confirmation", () => {
    const onDelete = vi.fn();
    const { container, getByPlaceholderText } = render(
      <DangerZone
        projectName="Viberr Core"
        myRole="admin"
        archived={false}
        busy={false}
        onArchive={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(container.querySelector(".dz-row .btn.danger")!);
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    const confirmButton = Array.from(
      container.querySelectorAll(".confirm-actions .btn.danger"),
    )[0] as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true); // name not typed yet

    fireEvent.change(getByPlaceholderText("Viberr Core"), {
      target: { value: "Viberr Core" },
    });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    expect(onDelete).toHaveBeenCalledWith("Viberr Core");
  });

  it("non-admins only get the deny toast path (no dialog)", () => {
    const { container } = render(
      <DangerZone
        projectName="Viberr Core"
        myRole="maintainer"
        archived={false}
        busy={false}
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );
    fireEvent.click(container.querySelector(".dz-row .btn.danger")!);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
