// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { MembershipView } from "./membership.server";
import type { SettingsViewData } from "./settings-query.server";
import {
  DangerZone,
  MembersPanel,
  ProjectPanel,
  RepoPanel,
  SettingsPage,
  StagesPanel,
  resolveStageOrder,
  stageMoveOptions,
} from "./settings-page";
import { roleCan, type ProjectRole } from "~/shared/rbac";

/**
 * E3: `edit-policy`, `manage-members` and `grant-github-scope` are three
 * DIFFERENT server guards that happen to overlap in tier today (the first two
 * are both admin-only). A test that asserts "admin sees it, viewer doesn't"
 * therefore passes with the wrong action id wired in — the exact reason the
 * page carried a `myRole === "admin"` literal for so long. `grantOnly` makes
 * `roleCan` answer for exactly ONE action id, so each panel's gate is pinned to
 * the id it actually asks for and no other. Left null it delegates to the real
 * implementation, so every other test in this file sees production behaviour.
 */
const { grantOnly } = vi.hoisted(() => ({
  grantOnly: { action: null as string | null },
}));
vi.mock("~/shared/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/shared/rbac")>();
  return {
    ...actual,
    roleCan: (role: ProjectRole | null | undefined, action: string) =>
      grantOnly.action === null
        ? actual.roleCan(role, action as Parameters<typeof actual.roleCan>[1])
        : action === grantOnly.action,
  };
});

afterEach(() => {
  grantOnly.action = null;
  cleanup();
});

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
  { userId: "u_arda", role: "admin", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK", tone: "", missing: false, disabled: false },
  { userId: "u_elif", role: "admin", name: "Elif Demir", email: "elif@viberr.dev", initials: "ED", tone: "rose", missing: false, disabled: false },
  { userId: "u_new", role: "viewer", name: "Yeni Kişi", email: "yeni@viberr.dev", initials: "YK", tone: "teal", missing: false, disabled: false },
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

  // LV-F2: every field is disabled without the grant, but a disabled input
  // cannot explain itself — a contributor met a page of dead fields in silence
  // (the defect the Policy sheet already fixed under P14-LV-08).
  it("explains the read-only state to a role without the grant", () => {
    const { container } = render(
      <ProjectPanel project={PROJECT} canManage={false} onSave={() => {}} />,
    );
    // Still inert…
    expect(
      Array.from(container.querySelectorAll("input, textarea")).every(
        (f) => (f as HTMLInputElement).disabled,
      ),
    ).toBe(true);
    // …and now it says why.
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Change project settings");
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
    // triage + done rows are locked: only they draw a glyph in the handle slot
    // (the lock), and only their remove control is dimmed. The slot itself is
    // on every row so locked and unlocked rows stay aligned.
    expect(container.querySelectorAll(".stg-handle")).toHaveLength(5);
    expect(container.querySelectorAll(".stg-handle .ico")).toHaveLength(2);
    expect(container.querySelectorAll(".stg-x.off")).toHaveLength(2);
    expect(getByText("Add stage")).toBeTruthy();
    expect(getByText("Policy → Workflow rules")).toBeTruthy();
  });

  // F10-22: `.off` is only paint. A model-locked stage can NEVER be removed, so
  // the control must carry the `disabled` property too — a button that looks
  // clickable and silently no-ops lies to the user about what the model allows.
  it("entry/terminal remove buttons are truly disabled, middle stages are not", () => {
    const { container, getByLabelText } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
    );
    const entry = getByLabelText("Remove Triage") as HTMLButtonElement;
    const terminal = getByLabelText("Remove Done") as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(terminal.disabled).toBe(true);
    // The lock is explained, not just implied by the dimming.
    expect(entry.title).toContain("can't be removed");
    expect(terminal.title).toContain("can't be removed");

    // A middle stage stays actionable for a manager (the client-side non-empty
    // guard lives in the handler, not in `disabled`).
    const middle = getByLabelText("Remove Ready") as HTMLButtonElement;
    expect(middle.disabled).toBe(false);
    expect(container.querySelectorAll(".stg-x:disabled")).toHaveLength(2);
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
    // No Move control either — reordering is a manage action.
    expect(container.querySelectorAll(".own-btn")).toHaveLength(0);
  });

  // LV-F2: disabling the controls is only half the job — the P14-LV-08 lesson
  // from the Policy sheet is that a disabled control cannot explain itself
  // (`title` never opens on one), so the page must SAY why it is inert.
  it("tells a non-admin WHY the stages are inert, and stops giving drag/rename instructions", () => {
    const { container } = render(
      <StagesPanel {...base} canManage={false} onRename={() => {}} onRemove={() => {}} />,
    );
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Change project settings");
    // The manage-only how-to must not be shown to someone who cannot do it.
    expect(container.textContent).not.toContain("Drag a row to reorder");
  });

  // ONE drag language (pass 16): the board deliberately drags the whole card
  // with NO grip, and this list shipped the opposite affordance on a hand-rolled
  // HTML5 implementation. Both are now dnd-kit, whole-row, gripless.
  it("has no grip handle and no HTML5 draggable rows", () => {
    const { container } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
    );
    // The rejected affordance: a grip icon, and `draggable` on the row itself.
    expect(container.querySelector(".stg-handle .ico + .ico")).toBeNull();
    expect(container.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(container.querySelectorAll('[title="Drag to reorder"]')).toHaveLength(
      0,
    );
  });

  describe("Move menu — the keyboard/AT reorder path", () => {
    it("offers only the moves a row can make, and never for a pinned stage", () => {
      const { queryByLabelText, getByLabelText } = render(
        <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
      );
      // Entry and terminal are pinned by the model — no Move control at all.
      expect(queryByLabelText(/^Move Triage/)).toBeNull();
      expect(queryByLabelText(/^Move Done/)).toBeNull();
      // The label names the current position, like StageMenu's does.
      expect(
        getByLabelText("Move Ready — currently stage 2 of 5"),
      ).toBeTruthy();

      // First movable row: forward moves only.
      fireEvent.click(getByLabelText("Move Ready — currently stage 2 of 5"));
      const labels = Array.from(
        document.querySelectorAll('[role="menuitem"]'),
      ).map((n) => n.textContent);
      expect(labels).toEqual(["Move later", "Move to last"]);
    });

    it("picking a move submits the full ordered id list", () => {
      const onReorder = vi.fn();
      const { getByLabelText, getByText } = render(
        <StagesPanel
          {...base}
          onReorder={onReorder}
          onRename={() => {}}
          onRemove={() => {}}
        />,
      );
      fireEvent.click(getByLabelText("Move Review — currently stage 4 of 5"));
      fireEvent.click(getByText("Move to first"));
      // Review hops to the front of the MOVABLE window; triage/done stay pinned.
      expect(onReorder).toHaveBeenCalledWith([
        "triage",
        "review",
        "ready",
        "impl",
        "done",
      ]);
    });

    it("arrow keys wrap, Home/End jump, Escape closes and returns focus", () => {
      const { getByLabelText } = render(
        <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
      );
      const trigger = getByLabelText(
        "Move In Progress — currently stage 3 of 5",
      ) as HTMLButtonElement;
      fireEvent.click(trigger);
      const menu = document.querySelector('[role="menu"]')!;
      const items = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      );
      expect(items.length).toBeGreaterThan(1);
      // Focus lands on the first item on open.
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(document.activeElement).toBe(items[items.length - 1]);
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: "End" });
      expect(document.activeElement).toBe(items[items.length - 1]);
      fireEvent.keyDown(menu, { key: "Home" });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: "Escape" });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it("an outside press closes it (the shared dismiss hook)", () => {
      const { getByLabelText } = render(
        <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
      );
      fireEvent.click(getByLabelText("Move Ready — currently stage 2 of 5"));
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      fireEvent.mouseDown(document.body);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });
  });
});

describe("resolveStageOrder", () => {
  const ids = STAGES;

  it("inserts before the named stage and returns the whole order", () => {
    expect(resolveStageOrder(ids, "review", "ready")).toEqual([
      "triage",
      "review",
      "ready",
      "impl",
      "done",
    ]);
  });

  it("null beforeId lands at the end of the MOVABLE window", () => {
    expect(resolveStageOrder(ids, "ready", null)).toEqual([
      "triage",
      "impl",
      "review",
      "ready",
      "done",
    ]);
  });

  it("pins entry first and terminal last by current identity", () => {
    // Asking to drop a stage before the entry, or the entry itself anywhere,
    // cannot move the pinned rows.
    expect(resolveStageOrder(ids, "review", "triage")).toEqual([
      "triage",
      "review",
      "ready",
      "impl",
      "done",
    ]);
    expect(resolveStageOrder(ids, "triage", "review")).toBeNull();
  });

  it("returns null for every no-op instead of posting a pointless reorder", () => {
    expect(resolveStageOrder(ids, "ready", "ready")).toBeNull(); // onto itself
    expect(resolveStageOrder(ids, "ready", "impl")).toBeNull(); // already there
    expect(resolveStageOrder(ids, "ghost", "ready")).toBeNull(); // unknown stage
  });

  it("degrades a vanished target to the end rather than referencing it", () => {
    expect(resolveStageOrder(ids, "ready", "gone")).toEqual([
      "triage",
      "impl",
      "review",
      "ready",
      "done",
    ]);
  });
});

describe("stageMoveOptions", () => {
  it("gives a pinned stage nothing to do", () => {
    expect(stageMoveOptions(STAGES, "triage")).toEqual([]);
    expect(stageMoveOptions(STAGES, "done")).toEqual([]);
  });

  it("omits the direction a row is already at the end of", () => {
    expect(stageMoveOptions(STAGES, "ready").map((o) => o.label)).toEqual([
      "Move later",
      "Move to last",
    ]);
    expect(stageMoveOptions(STAGES, "review").map((o) => o.label)).toEqual([
      "Move earlier",
      "Move to first",
    ]);
    expect(stageMoveOptions(STAGES, "impl").map((o) => o.label)).toEqual([
      "Move earlier",
      "Move later",
    ]);
  });

  it("a two-stage board has nothing movable at all", () => {
    expect(stageMoveOptions(STAGES.slice(0, 2), "ready")).toEqual([]);
  });

  it("every option resolves to a real reorder", () => {
    for (const stage of STAGES) {
      for (const option of stageMoveOptions(STAGES, stage.id)) {
        expect(resolveStageOrder(STAGES, stage.id, option.beforeId)).not.toBeNull();
      }
    }
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

  it("renders the active count, the you-tag and the policy link", () => {
    const { container, getByText } = render(
      <MembersPanel {...base} onInvite={() => {}} onRemove={() => {}} />,
    );
    expect(getByText("3 active")).toBeTruthy();
    expect(container.querySelector(".you-tag")).not.toBeNull();
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

  // LV-F2: an empty panel with the controls simply gone is as mute as a
  // disabled one — say which grant is missing.
  it("tells a non-admin why membership cannot be edited here", () => {
    const { container } = render(
      <MembersPanel {...base} canManage={false} onInvite={() => {}} onRemove={() => {}} />,
    );
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Manage members & roles");
  });
});

/* F19-33: both panels below styled their head count with a private
   `PANEL_COUNT_STYLE` (a byte copy of `.fine`, app.css:230) and their trailing
   note with a private `POL_NOTE_STYLE` (a copy of `.pol-note.after` +
   `.pol-note.last`, app.css:3844-3846). github-view.tsx and policy-page.tsx kept
   their own copies of the same two objects, and the note copies had already
   drifted three ways — .8rem here, .9rem in github-view, .85rem in the sheet.
   app.css.test.ts holds the structural gate (no style object, hoisted or inline,
   may restate a utility rule); these assert what this surface renders.
   Ruling 14: shared single implementations, never fork per surface. */
describe("settings panels take count + note styling from the sheet (F19-33)", () => {
  const expectSheetStyled = (container: HTMLElement) => {
    const count = container.querySelector(".panel-head .right")!;
    expect(count.className.split(/\s+/)).toEqual(["right", "sub", "fine"]);
    expect(count.getAttribute("style")).toBeNull();
    const note = container.querySelector(".pol-note")!;
    expect(note.className.split(/\s+/)).toEqual(["pol-note", "after", "last"]);
    expect(note.getAttribute("style")).toBeNull();
  };

  it("Workflow stages", () => {
    const { container } = render(
      <StagesPanel
        stages={STAGES}
        counts={{ triage: 2 }}
        canManage
        editingId={null}
        setEditingId={() => {}}
        onReorder={() => {}}
        onAdd={() => {}}
        onNavPolicy={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />,
    );
    expectSheetStyled(container);
  });

  it("Members", () => {
    const { container } = render(
      <MembersPanel
        members={MEMBERS}
        meId="u_arda"
        projectName="Viberr Core"
        canManage
        busy={false}
        onNavPolicy={() => {}}
        onInvite={() => {}}
        onRemove={() => {}}
      />,
    );
    expectSheetStyled(container);
  });
});

describe("RepoPanel", () => {
  it("renders repo facts and the shared CredentialCard with Grant scope", () => {
    const onGrant = vi.fn();
    const onSet = vi.fn();
    const onOpenTask = vi.fn();
    const { container, getByText, queryByText } = render(
      <RepoPanel
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={CREDENTIAL}
        canGrant
        busy={false}
        credBusy={false}
        onGrantScope={onGrant}
        onSetCredential={onSet}
        onClearCredential={() => {}}
        onOpenTask={onOpenTask}
      />,
    );
    expect(getByText("akin-ozer/viberr")).toBeTruthy();
    // P13-D-5: honest copy — the "Task-level override" toggle claiming "tasks
    // may attach a different repo" is gone along with the feature it advertised
    // (no writer ever set `task.repo`; the flag gated nothing).
    expect(getByText("every task uses this repository")).toBeTruthy();
    expect(queryByText("1 · V1 limit")).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
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
  });

  it("unconfigured project (policy but no bound PAT) → honest connect card, no chips (honest empty slate)", () => {
    const onSet = vi.fn();
    const { container, getByText } = render(
      <RepoPanel
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={NO_CREDENTIAL}
        canGrant
        busy={false}
        credBusy={false}
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

  /**
   * R15-6 (owner ruling 2026-07-28): merged task branches accumulated on the
   * repo, so post-merge cleanup became a per-project setting — default ON,
   * admin-tier (`edit-policy`), stated on the repository panel rather than
   * hidden in a doc.
   */
  it("R15-6: the after-merge branch-cleanup toggle reflects and submits the policy", () => {
    const onSetBranchCleanup = vi.fn();
    const { container, getByText } = render(
      <RepoPanel
        canRepair
        branchCleanup
        onSetBranchCleanup={onSetBranchCleanup}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={CREDENTIAL}
        canGrant
        busy={false}
        credBusy={false}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    // Fails on main: no such control existed anywhere in project settings.
    expect(getByText("After merge")).toBeTruthy();
    const box = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onSetBranchCleanup).toHaveBeenCalledWith(false);
  });

  it("R15-6: a non-admin sees the policy but cannot change it", () => {
    const onSetBranchCleanup = vi.fn();
    const { container } = render(
      <RepoPanel
        canRepair={false}
        branchCleanup={false}
        onSetBranchCleanup={onSetBranchCleanup}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={CREDENTIAL}
        canGrant={false}
        busy={false}
        credBusy={false}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    const box = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
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
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={bound}
        canGrant
        busy={false}
        credBusy={false}
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
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={0}
        repairBusy={false}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={allOk}
        canGrant={false}
        busy={false}
        credBusy={false}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    expect(container.querySelector(".cred-ok")).not.toBeNull();
    expect(getByText("every task uses this repository")).toBeTruthy();
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

  // F10-34: destructive project actions are admin-only. Greying the buttons is
  // not enough — a viewer who can still press them gets a control that looks
  // actionable and then silently does nothing (or leans on the server to say
  // no). Both Archive and Delete must be genuinely `disabled`.
  it("a viewer gets both danger-zone controls truly disabled; an admin gets them enabled", () => {
    const dz = (myRole: string) =>
      render(
        <DangerZone
          projectName="Viberr Core"
          myRole={myRole}
          archived={false}
          busy={false}
          onArchive={() => {}}
          onDelete={() => {}}
        />,
      ).container;

    const viewer = dz("viewer");
    const viewerArchive = viewer.querySelector(".dz-row .btn.ghost") as HTMLButtonElement;
    const viewerDelete = viewer.querySelector(".dz-row .btn.danger") as HTMLButtonElement;
    expect(viewerArchive.disabled).toBe(true);
    expect(viewerDelete.disabled).toBe(true);
    // The denial is explained rather than left as unexplained dimming.
    expect(viewerArchive.title).toContain("project admin");
    expect(viewerDelete.title).toContain("project admin");

    cleanup();

    const admin = dz("admin");
    expect((admin.querySelector(".dz-row .btn.ghost") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((admin.querySelector(".dz-row .btn.danger") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // RU-3: the danger-zone gate must track the SAME ACTION_ROLES entry the server
  // enforces (`edit-policy`, via requireProjectAction in settings-actions.server),
  // not a parallel `=== "admin"` literal that can silently drift from it. Driving
  // the expectation off `roleCan` fails if the gate is ever re-hardcoded or if
  // `edit-policy`'s role set changes without the control following.
  it("gates both danger-zone controls on roleCan(edit-policy), the server's action", () => {
    const roles: ProjectRole[] = ["admin", "maintainer", "contributor", "viewer"];
    for (const role of roles) {
      const { container } = render(
        <DangerZone
          projectName="Viberr Core"
          myRole={role}
          archived={false}
          busy={false}
          onArchive={() => {}}
          onDelete={() => {}}
        />,
      );
      const expectedEnabled = roleCan(role, "edit-policy");
      const archive = container.querySelector(".dz-row .btn.ghost") as HTMLButtonElement;
      const del = container.querySelector(".dz-row .btn.danger") as HTMLButtonElement;
      expect(archive.disabled).toBe(!expectedEnabled);
      expect(del.disabled).toBe(!expectedEnabled);
      cleanup();
    }
  });
});

// E3: the page's panel gates must name the action ids the SERVER guards name —
// `edit-policy` for project identity / stages / repo repair + branch cleanup
// (settings-actions.server.ts `requireProjectAction`), `manage-members` for
// invite + remove (same file), `grant-github-scope` for the credential row
// (routes/project.github.tsx). Two of the three resolve to admin-only today, so
// these drive `roleCan` one action at a time: a panel wired to the wrong id
// goes dark while its neighbour lights up, which no role-tier assertion could
// ever catch.
describe("SettingsPage — each panel gates on the action its own server guard checks", () => {
  const DATA: SettingsViewData = {
    project: PROJECT,
    stages: STAGES,
    stageCounts: { triage: 2, review: 2 },
    members: MEMBERS,
    credential: CREDENTIAL,
    repoFootprintTasks: 0,
    branchCleanupOnMerge: true,
  };

  function renderPage() {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <SettingsPage data={DATA} meId="u_arda" myRole="admin" />
        ),
      },
    ]);
    return render(<Stub initialEntries={["/"]} />);
  }

  /** What each panel offers a manager, keyed off DOM the panels own alone. */
  function affordances(container: HTMLElement) {
    return {
      // ProjectPanel: identity inputs are present either way, enabled only for
      // a manager — so read the property, not presence.
      identity: !(container.querySelector("#set-project-name") as HTMLInputElement)
        .disabled,
      stages: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Add stage",
        ),
      ),
      members: container.querySelector('input[placeholder="Full name"]') !== null,
      repoRepair: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Repair…",
        ),
      ),
      credential: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Grant scope",
        ),
      ),
    };
  }

  it("grants ONLY edit-policy → identity, stages and repo repair; members and credentials stay shut", () => {
    grantOnly.action = "edit-policy";
    const { container } = renderPage();
    expect(affordances(container)).toEqual({
      identity: true,
      stages: true,
      members: false,
      repoRepair: true,
      credential: false,
    });
  });

  it("grants ONLY manage-members → the members panel, and nothing else", () => {
    grantOnly.action = "manage-members";
    const { container } = renderPage();
    expect(affordances(container)).toEqual({
      identity: false,
      stages: false,
      members: true,
      repoRepair: false,
      credential: false,
    });
  });

  it("grants ONLY grant-github-scope → the credential row, and nothing else", () => {
    grantOnly.action = "grant-github-scope";
    const { container } = renderPage();
    expect(affordances(container)).toEqual({
      identity: false,
      stages: false,
      members: false,
      repoRepair: false,
      credential: true,
    });
  });

  // The branch-cleanup toggle rides `edit-policy` too (setBranchCleanup checks
  // it), and it is the one repo control that renders for everybody — so its
  // reason to be disabled has to track the same id, not the repair button's
  // mere presence.
  it("the after-merge branch-cleanup toggle follows edit-policy, not manage-members", () => {
    grantOnly.action = "manage-members";
    const shut = renderPage().container.querySelector(
      '.kv-row input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(shut.disabled).toBe(true);
    cleanup();

    grantOnly.action = "edit-policy";
    const open = renderPage().container.querySelector(
      '.kv-row input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(open.disabled).toBe(false);
  });
});

// N19-5 / owner ruling Q-V1: a read-only viewer — and any member without the
// lifecycle grant — must not SEE the Danger zone at all, not merely find its
// buttons disabled. Showing a stakeholder a destructive surface they can never
// use names archive/delete as if they were on the table.
//
// The gate that implements the ruling lives on the PAGE
// (`{canEditPolicy && <DangerZone …>}` in SettingsPage), which is exactly why
// the two `DangerZone` tests above cannot defend it: they mount the panel
// directly, i.e. past the gate, so they keep passing with the gate deleted. The
// only other full-page render in this file hardcodes `myRole="admin"`, the one
// role for which the gate is a no-op. So these render the REAL page per role.
// The admin case is what makes the absences mean something: it proves the panel
// exists and is reachable, so "not rendered" is a gate and not a dead feature.
describe("SettingsPage — the Danger zone is withheld from members who cannot act on it", () => {
  const DATA: SettingsViewData = {
    project: PROJECT,
    stages: STAGES,
    stageCounts: { triage: 2, review: 2 },
    members: MEMBERS,
    credential: CREDENTIAL,
    repoFootprintTasks: 0,
    branchCleanupOnMerge: true,
  };

  function renderPageAs(myRole: ProjectRole) {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => <SettingsPage data={DATA} meId="u_arda" myRole={myRole} />,
      },
    ]);
    return render(<Stub initialEntries={["/"]} />).container;
  }

  /** The panel's own heading — the thing a member either sees or doesn't. */
  const dangerHeading = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent?.trim() === "Danger zone",
    ) ?? null;

  /** A page that failed to render would also be missing the heading. */
  const pageRendered = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("h2")).map((h) => h.textContent?.trim());

  it("a read-only viewer gets no Danger zone — heading, panel and copy all absent", () => {
    // Guard the premise: if `edit-policy` is ever re-tiered to include viewers
    // this test would silently become vacuous, so state what it assumes.
    expect(roleCan("viewer", "edit-policy")).toBe(false);

    const container = renderPageAs("viewer");
    expect(dangerHeading(container)).toBeNull();
    expect(container.querySelector(".danger-panel")).toBeNull();
    // Nothing leaks the destructive vocabulary by another route.
    expect(container.textContent).not.toContain("Delete project");
    expect(container.textContent).not.toContain("Archive Viberr Core");
    // …and the rest of the page really did render, so the absence above is the
    // gate doing its job rather than a blank component tree.
    expect(pageRendered(container)).toEqual([
      "Project",
      "Workflow stages",
      "Members",
      "Repository & credentials",
    ]);
  });

  it("a contributor — full task authority, no project lifecycle — gets none either", () => {
    expect(roleCan("contributor", "edit-policy")).toBe(false);

    const container = renderPageAs("contributor");
    expect(dangerHeading(container)).toBeNull();
    expect(container.querySelector(".danger-panel")).toBeNull();
    expect(container.textContent).not.toContain("Delete project");
  });

  it("an admin still gets it, with both controls live", () => {
    const container = renderPageAs("admin");
    expect(dangerHeading(container)).not.toBeNull();
    expect(container.querySelector(".danger-panel")).not.toBeNull();
    const archive = container.querySelector(".dz-row .btn.ghost") as HTMLButtonElement;
    const del = container.querySelector(".dz-row .btn.danger") as HTMLButtonElement;
    expect(archive.disabled).toBe(false);
    expect(del.disabled).toBe(false);
  });

  // The gate and the panel's own control gate must ask the SAME question. If
  // `edit-policy`'s role set ever changes, the render gate has to follow it —
  // a role that renders the panel but finds it dead is the pre-ruling state.
  it("rendering tracks roleCan(edit-policy) for every project role", () => {
    const roles: ProjectRole[] = ["admin", "maintainer", "contributor", "viewer"];
    for (const role of roles) {
      const container = renderPageAs(role);
      expect({ role, danger: dangerHeading(container) !== null }).toEqual({
        role,
        danger: roleCan(role, "edit-policy"),
      });
      cleanup();
    }
  });
});
