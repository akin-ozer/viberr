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
  type ProjectActionGate,
} from "./settings-page";
import { roleCan, type ProjectRole, type RbacAction } from "~/shared/rbac";

/**
 * E3: `edit-policy`, `manage-members` and `grant-github-scope` are three
 * DIFFERENT server guards that happen to overlap in tier today (the first two
 * are both admin-only). A test that asserts "admin sees it, viewer doesn't"
 * therefore passes with the wrong action id wired in — the exact reason the
 * page carried a `myRole === "admin"` literal for so long.
 *
 * `grantOnly` builds a real `ProjectActionGate` that answers true for exactly
 * ONE action id, handed to the page through its own `gate` prop. That is the
 * seam the page ships (default: the shared `roleCan`), so no module is replaced
 * and every other test in this file still sees production behaviour without
 * having to reset anything.
 */
const grantOnly =
  (granted: RbacAction): ProjectActionGate =>
  (_role, action) =>
    action === granted;

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
    // SAFETY: the prefix field is the `<input>` ProjectPanel renders for
    // `project.prefix`; RTL's bound queries are typed `HTMLElement` for every
    // element kind, so the input-only `value` read below needs the narrowing.
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
      Array.from(
        container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        ),
      ).every((f) => f.disabled),
    ).toBe(true);
    // …and now it says why. F20-16: the honest grant name + tier.
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("Edit workflow & policy");
    expect(container.textContent).toContain("project admin");
    expect(container.textContent).not.toContain("Change project settings");
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
    // SAFETY: "Remove <stage>" is the aria-label StagesPanel puts on the
    // `<button class="stg-x">` remove control, and only on that control — RTL's
    // bound queries type every hit as `HTMLElement`.
    const entry = getByLabelText("Remove Triage") as HTMLButtonElement;
    // SAFETY: the terminal stage's remove control, same label contract.
    const terminal = getByLabelText("Remove Done") as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(terminal.disabled).toBe(true);
    // The lock is explained, not just implied by the dimming.
    expect(entry.title).toContain("can't be removed");
    expect(terminal.title).toContain("can't be removed");

    // A middle stage stays actionable for a manager (the client-side non-empty
    // guard lives in the handler, not in `disabled`).
    // SAFETY: same remove-control label as above, for a middle stage.
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
    fireEvent.click(removeButtons[1]!); // ready → empty, unlocked → opens confirm
    // D6: an empty unlocked stage now confirms before it dispatches (governance
    // change, audit row). The click opens the confirm; onRemove fires on OK.
    expect(onRemove).not.toHaveBeenCalled();
    const confirm = container.querySelector("dialog.confirm-card")!;
    expect(confirm.textContent).toContain("Remove the Ready stage?");
    fireEvent.click(confirm.querySelector("button.btn.danger")!);
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
    const input = container.querySelector<HTMLInputElement>(".stg-input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "Groomed" } });
    fireEvent.blur(input!);
    expect(onRename).toHaveBeenCalledWith("ready", "Groomed");
    expect(setEditingId).toHaveBeenCalledWith(null);
  });

  it("hides mutating affordances for non-admins", () => {
    const { container, queryByText } = render(
      <StagesPanel {...base} canManage={false} onRename={() => {}} onRemove={() => {}} />,
    );
    expect(queryByText("Add stage")).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".stg-x")).every(
        (b) => b.disabled,
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
    // F20-16: the honest grant name + tier.
    expect(container.textContent).toContain("Edit workflow & policy");
    expect(container.textContent).not.toContain("Change project settings");
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
      // SAFETY: "Move <stage> — currently stage N of M" is the aria-label of
      // the row's `<button>` menu trigger; the test needs the element identity
      // back as a focus target, which RTL hands over as a bare `HTMLElement`.
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
    fireEvent.click(removeButtons[1]!); // elif, now a viewer → opens confirm
    // D6: removing a member confirms before it dispatches.
    expect(onRemove).not.toHaveBeenCalled();
    const confirm = container.querySelector("dialog.confirm-card")!;
    expect(confirm.textContent).toContain("Remove");
    fireEvent.click(confirm.querySelector("button.btn.danger")!);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("invite validates name+email then submits and clears the form", () => {
    const onInvite = vi.fn();
    const { getByPlaceholderText, getByText } = render(
      <MembersPanel {...base} onInvite={onInvite} onRemove={() => {}} />,
    );
    fireEvent.click(getByText("Invite"));
    expect(onInvite).not.toHaveBeenCalled(); // empty form → client toast only

    // SAFETY: both placeholders belong to the invite row's two `<input>`s —
    // MembersPanel renders no other node carrying them — so the `value` reads
    // after the submit are sound on RTL's `HTMLElement`-typed hits.
    const nameInput = getByPlaceholderText("Full name") as HTMLInputElement;
    // SAFETY: the invite row's second `<input>`, per the same contract.
    const emailInput = getByPlaceholderText(
      "email@company.dev",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Deniz Şahin" } });
    fireEvent.change(emailInput, { target: { value: "Deniz@viberr.dev" } });
    fireEvent.keyDown(emailInput, { key: "Enter" }); // email field submits
    expect(onInvite).toHaveBeenCalledWith("Deniz Şahin", "deniz@viberr.dev");
    expect(nameInput.value).toBe("");
    expect(emailInput.value).toBe("");
  });

  /**
   * Pass-19 UX coherence audit, finding #22 (a11y).
   *
   * This was the only invite form in the product without persistent field
   * labels: two bare `<input>`s whose sole name was a placeholder that leaves
   * the screen on the first keystroke. The org-level twin of the very same
   * action (`org-settings/users-panel.tsx`) labels "Full name" and "Email" over
   * inputs carrying those identical placeholders, and this page's own identity
   * fields use the same `.field` + `.flabel` idiom. It bites hardest under
   * 1300px, where `.invite-row` collapses to one column and the two
   * same-looking boxes stack.
   */
  it("#22: both invite fields keep a real label, not just a vanishing placeholder", () => {
    const { container, getByLabelText } = render(
      <MembersPanel {...base} onInvite={() => {}} onRemove={() => {}} />,
    );
    const inputs = [
      ...container.querySelectorAll<HTMLInputElement>(".invite-row input"),
    ];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.id).not.toBe("");
      const label = container.querySelector(`label[for="${input.id}"]`);
      expect(label).not.toBeNull();
      expect(label!.textContent!.trim()).not.toBe("");
    }

    // The whole point: the name is still on screen once the field is filled.
    // SAFETY: the two labels asserted above are `<label for>`-bound to the
    // invite row's `<input>`s, which is what makes `.id` and `fireEvent.change`
    // below meaningful; RTL types the hits as `HTMLElement`.
    const name = getByLabelText(/Full name/) as HTMLInputElement;
    // SAFETY: the invite row's email `<input>`, per the same label binding.
    const email = getByLabelText(/Email/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Deniz Şahin" } });
    fireEvent.change(email, { target: { value: "deniz@viberr.dev" } });
    expect(
      container.querySelector(`label[for="${name.id}"]`)!.textContent,
    ).toContain("Full name");
    expect(
      container.querySelector(`label[for="${email.id}"]`)!.textContent,
    ).toContain("Email");
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

  /**
   * F21-5 (live, Selin) — this panel rendered the credential card to EVERY
   * member: the token's label, its masked tail and its per-scope verdicts, with
   * only the manage row withheld below `grant-github-scope`. /github closed the
   * same leak in pass 19 (R19-11, owner ruling Q-V1) by withdrawing the card
   * outright; the two surfaces render the SAME component from the SAME fact, so
   * they now answer the same way. The old assertion pinned the leak — it
   * asserted `.cred-ok` at `canGrant={false}` — which is why 19 passes went by
   * with the card in a viewer's DOM.
   */
  it("F21-5: the credential card renders under the grant and is WITHDRAWN without it", () => {
    const allOk = {
      ...CREDENTIAL,
      scopes: CREDENTIAL.scopes.map((s) => ({ ...s, ok: true })),
    };
    const panel = (canGrant: boolean) =>
      render(
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
          canGrant={canGrant}
          busy={false}
          credBusy={false}
          onGrantScope={() => {}}
          onSetCredential={() => {}}
          onClearCredential={() => {}}
          onOpenTask={() => {}}
        />,
      );

    // With the grant: the card, its all-scopes-proven footer and the manage row.
    const granted = panel(true);
    expect(granted.container.querySelector(".cred-ok")).not.toBeNull();
    expect(granted.container.querySelector(".cred-manage")).not.toBeNull();
    expect(granted.container.textContent).toContain(CREDENTIAL.masked);
    cleanup();

    // Without it: no card at all — no tail, no label, no scope chips — and the
    // gap is explained rather than blank.
    const withheld = panel(false);
    expect(withheld.container.querySelector(".cred-card")).toBeNull();
    expect(withheld.container.querySelector(".cred-manage")).toBeNull();
    expect(withheld.container.querySelector(".scope-chip")).toBeNull();
    expect(withheld.container.textContent).not.toContain(CREDENTIAL.masked);
    expect(withheld.container.textContent).not.toContain(CREDENTIAL.label);
    expect(withheld.container.textContent).toContain("Grant GitHub scope");
    // …and the rest of the panel really did render, so the absences above are
    // the gate rather than a blank component.
    expect(withheld.getByText("every task uses this repository")).toBeTruthy();
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
      container.querySelectorAll<HTMLButtonElement>(".confirm-actions .btn.danger"),
    )[0]!;
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
    const viewerArchive = viewer.querySelector<HTMLButtonElement>(
      ".dz-row .btn.ghost",
    )!;
    const viewerDelete = viewer.querySelector<HTMLButtonElement>(
      ".dz-row .btn.danger",
    )!;
    expect(viewerArchive.disabled).toBe(true);
    expect(viewerDelete.disabled).toBe(true);
    // The denial is explained rather than left as unexplained dimming.
    expect(viewerArchive.title).toContain("project admin");
    expect(viewerDelete.title).toContain("project admin");

    cleanup();

    const admin = dz("admin");
    expect(
      admin.querySelector<HTMLButtonElement>(".dz-row .btn.ghost")!.disabled,
    ).toBe(false);
    expect(
      admin.querySelector<HTMLButtonElement>(".dz-row .btn.danger")!.disabled,
    ).toBe(false);
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
      const archive = container.querySelector<HTMLButtonElement>(
        ".dz-row .btn.ghost",
      )!;
      const del = container.querySelector<HTMLButtonElement>(
        ".dz-row .btn.danger",
      )!;
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

  /** Always an admin — the ROLE is held constant on purpose, so what the page
   *  renders can only be explained by the ACTION id each panel asks the gate
   *  for. */
  function renderPage(gate: ProjectActionGate) {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <SettingsPage data={DATA} meId="u_arda" myRole="admin" gate={gate} />
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
      identity: !container.querySelector<HTMLInputElement>("#set-project-name")!
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

  /**
   * Q-V1 (owner ruling, pass 18) shipped with no test — the one gap pass 19's
   * doc verification called out. A read-only member must not see the Danger
   * zone AT ALL: it used to render for every member with the buttons disabled,
   * which showed a stakeholder a destructive surface they can never use and
   * named archive/delete as if they were on the table. The gate is
   * `edit-policy` — the same id the archive/delete server guards check — so
   * drive it with a `grantOnly` gate like every other panel gate here.
   */
  it("Q-V1: the Danger zone renders only under edit-policy — any other grant hides it entirely", () => {
    const withoutGrant = renderPage(grantOnly("manage-members"));
    expect(withoutGrant.container.textContent).not.toContain("Danger zone");
    cleanup();

    const withGrant = renderPage(grantOnly("edit-policy"));
    expect(withGrant.container.textContent).toContain("Danger zone");
  });

  it("grants ONLY edit-policy → identity, stages and repo repair; members and credentials stay shut", () => {
    const { container } = renderPage(grantOnly("edit-policy"));
    expect(affordances(container)).toEqual({
      identity: true,
      stages: true,
      members: false,
      repoRepair: true,
      credential: false,
    });
  });

  it("grants ONLY manage-members → the members panel, and nothing else", () => {
    const { container } = renderPage(grantOnly("manage-members"));
    expect(affordances(container)).toEqual({
      identity: false,
      stages: false,
      members: true,
      repoRepair: false,
      credential: false,
    });
  });

  it("grants ONLY grant-github-scope → the credential row, and nothing else", () => {
    const { container } = renderPage(grantOnly("grant-github-scope"));
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
    const shut = renderPage(
      grantOnly("manage-members"),
    ).container.querySelector<HTMLInputElement>(
      '.kv-row input[type="checkbox"]',
    )!;
    expect(shut.disabled).toBe(true);
    cleanup();

    const open = renderPage(
      grantOnly("edit-policy"),
    ).container.querySelector<HTMLInputElement>(
      '.kv-row input[type="checkbox"]',
    )!;
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
    // F21-5: the Repository panel above is present — and this is the assertion
    // that used to stop there, which is exactly how the credential card kept
    // rendering to a Viewer underneath it. The panel stays; the token does not.
    expect(container.querySelector(".cred-card")).toBeNull();
    expect(container.textContent).not.toContain(CREDENTIAL.masked);
    expect(container.textContent).not.toContain(CREDENTIAL.label);
    expect(container.querySelector(".scope-chip")).toBeNull();
    expect(container.textContent).toContain("Grant GitHub scope");
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
    const archive = container.querySelector<HTMLButtonElement>(
      ".dz-row .btn.ghost",
    )!;
    const del = container.querySelector<HTMLButtonElement>(
      ".dz-row .btn.danger",
    )!;
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
