// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { MembershipView } from "./membership.server";
import type { SettingsViewData } from "./settings-query.server";
import {
  DangerZone,
  FileLeasesPanel,
  MembersPanel,
  ProjectPanel,
  RepoPanel,
  RequiredReviewersPanel,
  SettingsPage,
  StagesPanel,
  resolveStageOrder,
  stageMoveOptions,
  type ProjectActionGate,
} from "./settings-page";
import { roleCan, type ProjectRole, type RbacAction } from "~/shared/rbac";
import type { RequiredReviewerView } from "~/server/tasks/required-reviewers.server";

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
  { id: "triage", name: "Triage", color: "slate" },
  { id: "ready", name: "Ready", color: "teal" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
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
  advisories: [],
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
  advisories: [],
};

describe("ProjectPanel", () => {
  it("renders identity fields + the real store-relative task-file pattern", () => {
    const { getByText } = render(
      <ProjectPanel project={PROJECT} canManage onSave={() => {}} />,
    );
    expect(getByText("projects/viberr-core/tasks/<key>/task.md")).toBeTruthy();
    expect(getByText("VIB-###")).toBeTruthy();
  });

  /**
   * U33-9 (pass 33, owner). The three governed identity fields carried
   * `onBlur={saveIfDirty}`: leaving the field WAS the commit. The owner renamed
   * a project by accident — typed into what they took for the stage-name field,
   * clicked away, and the rename was already governed state. The task prefix is
   * the more consequential of the two, since every future task key and branch
   * name derives from it, and the rest of the product refuses exactly this
   * shape ("no optimistic UI for governed state").
   *
   * Blur must now be inert and the Save button must be the only trigger. The
   * old test asserted the opposite — it pinned the auto-save — so it is gone
   * rather than extended.
   */
  it("U33-9: blur no longer commits — Save is the only trigger, and only while dirty", () => {
    const onSave = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <ProjectPanel project={PROJECT} canManage onSave={onSave} />,
    );

    // SAFETY: "Save changes"/"Discard" are the ProjectPanel action row's two
    // `<button>`s and nothing else on the panel carries those strings; the
    // `.disabled` reads below need the element kind RTL types as HTMLElement.
    const save = getByText("Save changes") as HTMLButtonElement;
    // SAFETY: the same action row's cancel control, per the same contract.
    const discard = getByText("Discard") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing edited yet
    expect(discard.disabled).toBe(true);

    const nameInput = getByDisplayValue("Viberr Core");
    fireEvent.change(nameInput, { target: { value: "Viberr Core 2" } });
    // The edit that used to persist itself the instant focus left.
    fireEvent.blur(nameInput);
    expect(onSave).not.toHaveBeenCalled();

    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    // Same action intent, same payload — only the trigger moved.
    expect(onSave).toHaveBeenCalledWith({
      name: "Viberr Core 2",
      prefix: "VIB",
      description: "Core platform work.",
    });
  });

  // The prefix and the description are governed by the same rule as the name:
  // neither may reach the server because focus moved on.
  it("U33-9: the prefix and the description do not commit on blur either", () => {
    const onSave = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ProjectPanel project={PROJECT} canManage onSave={onSave} />,
    );
    const prefix = getByDisplayValue("VIB");
    fireEvent.change(prefix, { target: { value: "core" } });
    fireEvent.blur(prefix);
    const desc = getByDisplayValue("Core platform work.");
    fireEvent.change(desc, { target: { value: "Platform work." } });
    fireEvent.blur(desc);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(getByText("Save changes"));
    expect(onSave).toHaveBeenCalledWith({
      name: "Viberr Core",
      prefix: "CORE",
      description: "Platform work.",
    });
  });

  // U33-9: the way out of an accidental edit. Discard puts the loader's values
  // back and the pair goes inert again — the panel is clean, not merely unsent.
  it("U33-9: Discard restores the loader values and re-disables the pair", () => {
    const onSave = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ProjectPanel project={PROJECT} canManage onSave={onSave} />,
    );
    fireEvent.change(getByDisplayValue("Viberr Core"), {
      target: { value: "Oops" },
    });
    fireEvent.change(getByDisplayValue("VIB"), { target: { value: "OOPS" } });
    fireEvent.click(getByText("Discard"));

    expect(getByDisplayValue("Viberr Core")).toBeTruthy();
    expect(getByDisplayValue("VIB")).toBeTruthy();
    // SAFETY: the action row's Save control, per the contract asserted above.
    expect((getByText("Save changes") as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  // U33-9: an identity write already in flight holds the control — the panel
  // still shows the OLD loader values until revalidation remounts it, so a
  // second press would resubmit the same governed rename.
  // Ruling 368: and Save shows it is saving (busy, the loader, "Saving…")
  // instead of the .45 refused step; Discard only waits.
  // Canary: drop `aria-busy` from Save in settings-page.tsx.
  it("U33-9 / ruling 368: an in-flight save holds both controls and Save says it is saving", () => {
    const onSave = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ProjectPanel project={PROJECT} canManage busy onSave={onSave} />,
    );
    fireEvent.change(getByDisplayValue("Viberr Core"), {
      target: { value: "Viberr Core 2" },
    });
    const save = getByText("Saving…").closest("button")!;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-busy")).toBe("true");
    expect(save.querySelector("svg.ico.spin")).not.toBeNull();
    // SAFETY: the same row's Discard control, per that same contract.
    const discard = getByText("Discard") as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    expect(discard.hasAttribute("aria-busy")).toBe(false);
  });

  // U33-9: the "Task keys" row states what this project's keys ARE. While the
  // blur handler existed it could not disagree with the server; now it can, so
  // it reads the loader's prefix rather than the draft in the field above it.
  it("U33-9: the task-key row shows the saved prefix, not the unsaved draft", () => {
    const { getByDisplayValue, getByText, queryByText } = render(
      <ProjectPanel project={PROJECT} canManage onSave={() => {}} />,
    );
    fireEvent.change(getByDisplayValue("VIB"), { target: { value: "core" } });
    expect(queryByText("CORE-###")).toBeNull();
    expect(getByText("VIB-###")).toBeTruthy();
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
    const { container, queryByText } = render(
      <ProjectPanel project={PROJECT} canManage={false} onSave={() => {}} />,
    );
    // U33-9: the read-only case renders exactly as it did before the explicit
    // Save landed — dead fields plus the grant note, and no commit control to
    // offer a role that cannot use it.
    expect(queryByText("Save changes")).toBeNull();
    expect(queryByText("Discard")).toBeNull();
    expect(container.querySelector(".confirm-actions")).toBeNull();
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
    onRecolor: () => {},
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

  // acce-5 (interface review 2026-09-24): `title` never opens for keyboard,
  // touch or a screen reader, and never on the disabled ✕ at all — so the lock
  // reason is also real text: a `.vh` sentence in the locked row's handle, and
  // a visible line in the manager's note.
  it("says why the entry/terminal stages are locked, outside the title", () => {
    const { container } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
    );
    const reasons = Array.from(
      container.querySelectorAll(".stg-handle .vh"),
      (el) => el.textContent,
    );
    expect(reasons).toEqual([
      "Triage is fixed: it's the entry point. It can't be moved or removed.",
      "Done is fixed: human acceptance stays terminal. It can't be moved or removed.",
    ]);
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "Triage (the entry point) and Done (human acceptance) are fixed.",
    );
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

  // Ruling 147: the inline commit stays enabled and refuses an empty name in
  // rendered copy, instead of going dead and dropping out of the tab order.
  it("ruling 147: the inline Add stage refuses an empty name instead of disabling", () => {
    const onAdd = vi.fn();
    const { container, getByText } = render(
      <StagesPanel
        {...base}
        onAdd={onAdd}
        onRename={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(getByText("Add stage"));
    const input = container.querySelector<HTMLInputElement>(".stg-input")!;
    // Once the field is open, "Add stage" names the inner commit button.
    const commit = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".stg-add button"),
    ).find((b) => b.textContent?.trim() === "Add stage")!;

    // A pristine field is never accused, and the commit is NOT disabled.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(commit.disabled).toBe(false);
    expect(commit.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(commit);
    expect(onAdd).not.toHaveBeenCalled();
    const first = container.querySelector('[role="alert"]')!;
    expect(first.textContent).toBe("Give the stage a name.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("stg-add-err");
    expect(first.id).toBe("stg-add-err");
    expect(document.activeElement).toBe(input);

    // Enter refuses the same way, and each refusal inserts a NEW element.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBe(first);

    // Typing clears the mark; a named stage still commits and closes the row.
    fireEvent.change(input, { target: { value: " QA " } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(commit);
    expect(onAdd).toHaveBeenCalledWith("QA");
    // The row is closed: the field is gone and the trigger is back.
    expect(container.querySelector(".stg-add .stg-input")).toBeNull();
    expect(getByText("Add stage").closest(".stg-add")).not.toBeNull();
  });

  it("ruling 147: Escape after a refusal leaves no alert behind", () => {
    const { container, getByText } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} />,
    );
    fireEvent.click(getByText("Add stage"));
    const input = container.querySelector<HTMLInputElement>(".stg-input")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(getByText("Add stage"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
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

  // Ruling 364: the row's dot is the colour picker — a button carrying the
  // stage's preset NAME (the sheet paints it; nothing inline), opening the
  // twenty swatches; a pick reports the preset and closes the menu.
  it("ruling 364: the dot opens the twenty-swatch menu and a pick reports the preset", () => {
    const onRecolor = vi.fn();
    const { container } = render(
      <StagesPanel {...base} onRename={() => {}} onRemove={() => {}} onRecolor={onRecolor} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".stg-row .stg-swatch")!;
    expect(trigger.dataset.stageColor).toBe(STAGES[0]!.color);
    expect(trigger.style.background).toBe("");
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    const swatches = container.querySelectorAll(".swatch-menu .swatch");
    expect(swatches).toHaveLength(20);
    expect(
      container.querySelector('.swatch[aria-checked="true"]')!.getAttribute("data-stage-color"),
    ).toBe(STAGES[0]!.color);
    fireEvent.click(container.querySelector('.swatch[data-stage-color="rose"]')!);
    expect(onRecolor).toHaveBeenCalledWith(STAGES[0]!.id, "rose");
    expect(container.querySelector(".swatch-menu")).toBeNull();
  });

  it("ruling 364: a non-admin sees the colour but cannot open the menu", () => {
    const { container } = render(
      <StagesPanel {...base} canManage={false} onRename={() => {}} onRemove={() => {}} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".stg-row .stg-swatch")!;
    expect(trigger.dataset.stageColor).toBe(STAGES[0]!.color);
    expect(trigger.disabled).toBe(true);
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
        getByLabelText("Move Ready, currently stage 2 of 5"),
      ).toBeTruthy();

      // First movable row: forward moves only.
      fireEvent.click(getByLabelText("Move Ready, currently stage 2 of 5"));
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
      fireEvent.click(getByLabelText("Move Review, currently stage 4 of 5"));
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
        "Move In Progress, currently stage 3 of 5",
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
      fireEvent.click(getByLabelText("Move Ready, currently stage 2 of 5"));
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

  it("only the row whose removal is in flight reads busy; the others wait (ruling 368 over 459)", () => {
    // Canary: put `aria-busy={busy || undefined}` back on the row's ✕ and
    // every row claims the removal.
    const { container, rerender } = render(
      <MembersPanel {...base} busy removing="u_elif" onInvite={() => {}} onRemove={() => {}} />,
    );
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".member-row .stg-x")];
    expect(rows).toHaveLength(MEMBERS.length);
    const elif = MEMBERS.findIndex((m) => m.userId === "u_elif");
    rows.forEach((b, i) => {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-busy")).toBe(i === elif ? "true" : null);
    });
    // An invite in flight: every ✕ waits, none claims it.
    rerender(<MembersPanel {...base} busy onInvite={() => {}} onRemove={() => {}} />);
    for (const b of container.querySelectorAll(".member-row .stg-x")) {
      expect(b.hasAttribute("aria-busy")).toBe(false);
    }
  });

  /**
   * Ruling 148(b): the invite form is no longer served under the member list —
   * "Add member" in the panel head opens the shared `MiniModal`. Ruling 147
   * lives in that modal: the primary stays ENABLED on an incomplete form and a
   * click refuses in a fresh alert with the first unmet field marked and
   * focused, where the row could only raise a toast.
   */
  it("invite is a head button that opens a modal; an empty submit is refused, not dead", () => {
    const onInvite = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <MembersPanel {...base} onInvite={onInvite} onRemove={() => {}} />,
    );
    // Nothing is served inline any more.
    expect(container.querySelector("dialog.modal-card")).toBeNull();
    expect(container.querySelector("#pm-invite-name")).toBeNull();

    fireEvent.click(getByText("Add member"));
    const modal = container.querySelector("dialog.modal-card")!;
    expect(modal).not.toBeNull();
    // SAFETY: the modal's own primary — `MiniModal` renders exactly one
    // `.btn.primary` in its foot, so this is the Add member commit.
    const save = modal.querySelector("button.btn.primary") as HTMLButtonElement;
    // Ruling 147(a): only a request in flight disables it.
    expect(save.disabled).toBe(false);
    // Ruling 147(c): a pristine form is never accused.
    expect(modal.querySelector("[aria-invalid]")).toBeNull();

    fireEvent.click(save);
    expect(onInvite).not.toHaveBeenCalled();
    const alert = modal.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Enter a name and a valid email");
    // SAFETY: the two labelled `<input>`s inside the modal, bound by `htmlFor`.
    const nameInput = getByLabelText(/Full name/) as HTMLInputElement;
    // SAFETY: the modal's email `<input>`, per the same label binding.
    const emailInput = getByLabelText(/Email/) as HTMLInputElement;
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(nameInput);

    fireEvent.change(nameInput, { target: { value: "Deniz Şahin" } });
    // The mark clears as the field is answered; the email is still unmet.
    expect(nameInput.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
    expect(onInvite).not.toHaveBeenCalled();
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(emailInput);

    fireEvent.change(emailInput, { target: { value: "Deniz@viberr.dev" } });
    fireEvent.click(save);
    expect(onInvite).toHaveBeenCalledWith("Deniz Şahin", "deniz@viberr.dev");
  });

  it("refuses an address that already belongs to a member, without dispatching", () => {
    const onInvite = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <MembersPanel {...base} onInvite={onInvite} onRemove={() => {}} />,
    );
    fireEvent.click(getByText("Add member"));
    fireEvent.change(getByLabelText(/Full name/), {
      target: { value: "Arda Kaya" },
    });
    fireEvent.change(getByLabelText(/Email/), {
      target: { value: "ARDA@viberr.dev" },
    });
    // SAFETY: `MiniModal`'s single foot primary, as above.
    const save = container.querySelector(
      "dialog.modal-card button.btn.primary",
    ) as HTMLButtonElement;
    fireEvent.click(save);
    expect(onInvite).not.toHaveBeenCalled();
    // The modal stays open on a refusal, so the address can be corrected.
    const dialog = container.querySelector("dialog.modal-card")!;
    // …and the refusal is answered INSIDE it. A toast would paint under the
    // backdrop and its live region is inert while the dialog is open, so the
    // sentence, the mark and the focus all live in the modal. Canary: push the
    // sentence to the toast host again and nothing here is reachable.
    const alert = dialog.querySelector('.form-err[role="alert"]')!;
    expect(alert.textContent).toContain("arda@viberr.dev is already a member");
    // SAFETY: the modal's email `<input>`, bound by `htmlFor`.
    const emailInput = getByLabelText(/Email/) as HTMLInputElement;
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(emailInput.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(emailInput);
    // Editing the address clears the refusal, so the next one is announced as a
    // fresh insertion rather than a role flip on unchanged text (ruling 147(b)).
    fireEvent.change(emailInput, { target: { value: "arda@viberr.de" } });
    expect(dialog.querySelector('.form-err[role="alert"]')).toBeNull();
  });

  /**
   * Pass-19 UX coherence audit, finding #22 (a11y).
   *
   * This was the only invite form in the product without persistent field
   * labels: two bare `<input>`s whose sole name was a placeholder that leaves
   * the screen on the first keystroke. The org-level twin of the very same
   * action (`org-settings/users-panel.tsx`) labels "Full name" and "Email" over
   * inputs carrying those identical placeholders, and this page's own identity
   * fields use the same `.field` + `.flabel` idiom. The form moved into a modal
   * with ruling 148(b); the labels are what makes it readable there too.
   */
  it("#22: both invite fields keep a real label, not just a vanishing placeholder", () => {
    const { container, getByLabelText, getByText } = render(
      <MembersPanel {...base} onInvite={() => {}} onRemove={() => {}} />,
    );
    fireEvent.click(getByText("Add member"));
    const inputs = [
      ...container.querySelectorAll<HTMLInputElement>(
        "dialog.modal-card .field input",
      ),
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
    const { container, queryByText } = render(
      <MembersPanel {...base} canManage={false} onInvite={() => {}} onRemove={() => {}} />,
    );
    // Ruling 148(b): the form is behind a head button now, so the assertion has
    // to be that the BUTTON is gone — a placeholder query would pass for free.
    expect(queryByText("Add member")).toBeNull();
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
   `PANEL_COUNT_STYLE` (a byte copy of `.fine`) and their trailing note with a
   private `POL_NOTE_STYLE` (a copy of `.pol-note.after` + `.pol-note.last`).
   github-view.tsx and policy-page.tsx kept their own copies of the same two
   objects, and the note copies had already drifted three ways — .8rem here,
   .9rem in github-view, .85rem in the sheet.
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
        onRecolor={() => {}}
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
  it("renders repo facts and the shared CredentialCard with Re-check scopes", () => {
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
        inFlight={null}
        credInFlight={null}
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
    expect(queryByText("1 · V1 limit")).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    // Shared cred-card: 4 chips, one missing, warn banner with keybtn.
    expect(container.querySelectorAll(".scope-chip")).toHaveLength(4);
    expect(container.querySelectorAll(".scope-chip.miss")).toHaveLength(1);
    expect(container.querySelector(".cred-warn")).not.toBeNull();
    fireEvent.click(getByText("VIB-142"));
    expect(onOpenTask).toHaveBeenCalledWith("VIB-142");
    fireEvent.click(getByText("Re-check scopes"));
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
        inFlight={null}
        credInFlight={null}
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
        inFlight={null}
        credInFlight={null}
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
        inFlight={null}
        credInFlight={null}
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
        inFlight={null}
        credInFlight={null}
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
    fireEvent.click(
      getByText("Remove credential", {
        selector: ".confirm-actions button.btn.danger",
      }),
    );
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
          inFlight={null}
          credInFlight={null}
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
    expect(withheld.container.textContent).toContain("Manage the GitHub credential");
    // …and the rest of the panel really did render, so the absences above are
    // the gate rather than a blank component.
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
    fireEvent.click(container.querySelector(".dz-row .btn.danger:not(.ghost)")!);
    // Ruling 458(l): the one dialog in the family that had no screen label.
    expect(
      container.querySelector('[role="alertdialog"]')!.getAttribute("data-screen-label"),
    ).toBe("Delete project dialog");

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

  it("ruling 149: Archive wears the danger label beside Delete; Restore does not", () => {
    // Both lifecycle triggers in this panel are destructive, so both read as
    // one kind of control. jsdom computes no colour, so the class is the
    // assertion — canary: drop the ternary in `settings-page.tsx`.
    const live = render(
      <DangerZone
        projectName="Viberr Core"
        myRole="admin"
        archived={false}
        busy={false}
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );
    const archive = live.container.querySelector<HTMLButtonElement>(
      ".dz-row .btn.ghost",
    )!;
    expect(archive.textContent).toContain("Archive");
    expect(Array.from(archive.classList)).toContain("danger");
    // …and the solid danger button is still the delete trigger.
    expect(
      live.container.querySelector(".dz-row .btn.danger:not(.ghost)")!.textContent,
    ).toContain("Delete project");
    cleanup();

    const archivedPanel = render(
      <DangerZone
        projectName="Viberr Core"
        myRole="admin"
        archived
        busy={false}
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );
    const restore = archivedPanel.container.querySelector<HTMLButtonElement>(
      ".dz-row .btn.ghost",
    )!;
    expect(restore.textContent).toContain("Restore");
    expect(
      Array.from(restore.classList),
      "restoring is a recovery, not a destruction",
    ).not.toContain("danger");
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
    fireEvent.click(container.querySelector(".dz-row .btn.danger:not(.ghost)")!);
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
      ".dz-row .btn.danger:not(.ghost)",
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
      admin.querySelector<HTMLButtonElement>(".dz-row .btn.danger:not(.ghost)")!.disabled,
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
        ".dz-row .btn.danger:not(.ghost)",
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
    requiredReviewers: [],
    fileLeases: [],
    leaseCandidates: [],
    reviewerCandidates: [{ id: "reviewer", name: "Code Reviewer" }],
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
      // Ruling 148(b): the invite form lives behind "Add member" in the panel
      // head now, so the head button is the affordance to read.
      members: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Add member",
        ),
      ),
      repoRepair: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Repair…",
        ),
      ),
      credential: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Re-check scopes",
        ),
      ),
      // Ruling 178: the required-reviewer table rides `edit-policy`
      // (setRequiredReviewers checks it) — its Add rule button is the affordance.
      requiredReviewers: Boolean(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Add rule",
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
      requiredReviewers: true,
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
      requiredReviewers: false,
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
      requiredReviewers: false,
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
    requiredReviewers: [],
    fileLeases: [],
    leaseCandidates: [],
    reviewerCandidates: [{ id: "reviewer", name: "Code Reviewer" }],
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
      // Ruling 178: rendered read-only for a viewer (the rules as text).
      "Required reviewers",
      // Ruling 396: likewise. A viewer still needs to know who owns a file
      // before it touches one, and the write controls are the part withheld.
      "File leases",
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
    expect(container.textContent).toContain("Manage the GitHub credential");
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
      ".dz-row .btn.danger:not(.ghost)",
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

/**
 * Ruling 147: the repair dialog's primary stays enabled; a refused submit
 * names what is missing, marks it and moves focus there.
 */
describe("RepairRepoDialog refuses instead of disabling", () => {
  const openDialog = (footprintTasks: number) => {
    const onRepair = vi.fn();
    const utils = render(
      <RepoPanel
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={footprintTasks}
        repairBusy={false}
        repairResult={undefined}
        onRepair={onRepair}
        repo="akin-ozer/viberr"
        credential={CREDENTIAL}
        canGrant
        inFlight={null}
        credInFlight={null}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );
    fireEvent.click(utils.getByText("Repair…"));
    const primary = [...document.querySelectorAll("button")].find(
      (b) => b.textContent!.trim() === "Repair repository",
    )!;
    return { ...utils, onRepair, primary };
  };

  it("an empty repository field is refused, marked and focused", () => {
    const { onRepair, primary } = openDialog(0);
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    const repo = document.querySelector<HTMLInputElement>(
      'input[aria-label="Corrected repository, owner/name"]',
    )!;
    expect(repo.getAttribute("aria-invalid")).toBe("true");
    expect(repo.getAttribute("aria-describedby")).toBe("repair-unmet");
    expect(document.getElementById("repair-unmet")!.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(repo);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("an unconfirmed footprint note is the next refusal, on the checkbox", () => {
    const { onRepair, primary } = openDialog(3);
    const repo = document.querySelector<HTMLInputElement>(
      'input[aria-label="Corrected repository, owner/name"]',
    )!;
    fireEvent.change(repo, { target: { value: "akin-ozer/other" } });
    fireEvent.click(primary);
    const ack = document.querySelector<HTMLInputElement>(
      'dialog[aria-label="Repair repository"] input[type="checkbox"]',
    )!;
    expect(ack.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(ack);
    expect(onRepair).not.toHaveBeenCalled();
    fireEvent.click(ack);
    fireEvent.click(primary);
    expect(onRepair).toHaveBeenCalledWith("akin-ozer/other", true);
  });

  it("the footprint note's verb agrees with its count", () => {
    const note = () =>
      document
        .querySelector('dialog[aria-label="Repair repository"] input[type="checkbox"]')!
        .closest("label")!.textContent;
    openDialog(1);
    expect(note()).toBe(
      "1 task in this project carries branch/PR records against the current repository. They keep their history, but every future sync runs against the new one.",
    );
    cleanup();
    openDialog(3);
    expect(note()).toBe(
      "3 tasks in this project carry branch/PR records against the current repository. They keep their history, but every future sync runs against the new one.",
    );
  });
});

/**
 * Ruling 178 (pass 36, G36-3): the project's required reviewers are edited on
 * Settings as a small table — a non-terminal stage and a deployed
 * verdict-capable agent per row — and saved WHOLE through one intent, the
 * same writer and validation the controller's `set_required_reviewers` uses.
 */
describe("RequiredReviewersPanel (ruling 178)", () => {
  const RULES: RequiredReviewerView[] = [
    { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" },
  ];
  const CANDIDATES = [
    { id: "reviewer", name: "Code Reviewer" },
    { id: "qa-bot", name: "QA Bot" },
  ];

  it("adds a rule from the stage and agent pickers and saves the whole list; Save is inert until something changed", () => {
    const onSave = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <RequiredReviewersPanel
        rules={RULES}
        stages={STAGES}
        candidates={CANDIDATES}
        canManage
        busy={false}
        onSave={onSave}
      />,
    );
    expect(getByText("Required reviewers")).toBeTruthy();
    const save = getByText("Save").closest("button")!;
    expect(save.disabled).toBe(true);
    // The existing rule renders as pickers holding its values.
    // SAFETY: the panel renders each rule's stage and reviewer pickers as
    // <select> elements carrying exactly these aria-labels.
    const [stagePicker, reviewerPicker] = [
      getByLabelText("Rule 1 stage") as HTMLSelectElement,
      getByLabelText("Rule 1 reviewer") as HTMLSelectElement,
    ];
    expect(stagePicker.value).toBe("review");
    expect(reviewerPicker.value).toBe("reviewer");
    // The terminal stage is never offered.
    const stageOptions = Array.from(stagePicker.options).map((o) => o.value);
    expect(stageOptions).toEqual(["triage", "ready", "impl", "review"]);

    fireEvent.click(getByText("Add rule"));
    fireEvent.change(getByLabelText("Rule 2 stage"), { target: { value: "impl" } });
    fireEvent.change(getByLabelText("Rule 2 reviewer"), { target: { value: "qa-bot" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([
      { stageId: "review", profileId: "reviewer" },
      { stageId: "impl", profileId: "qa-bot" },
    ]);
    // Removing the only original row and saving sends the empty list (a clear).
    fireEvent.click(container.querySelectorAll('button[aria-label^="Remove rule"]')[0]!);
    fireEvent.click(container.querySelectorAll('button[aria-label^="Remove rule"]')[0]!);
    fireEvent.click(getByText("Save").closest("button")!);
    expect(onSave).toHaveBeenLastCalledWith([]);
  });

  it("reads only for a role without edit-policy: the rules as text, no pickers, no Save", () => {
    const { container, getByText } = render(
      <RequiredReviewersPanel
        rules={RULES}
        stages={STAGES}
        candidates={CANDIDATES}
        canManage={false}
        busy={false}
        onSave={() => {}}
      />,
    );
    expect(getByText("Code Reviewer")).toBeTruthy();
    expect(getByText("Reviews at Review")).toBeTruthy();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Read-only");
  });

  it("says when no deployed agent can report a verdict, and offers no Add rule then", () => {
    const { container } = render(
      <RequiredReviewersPanel
        rules={[]}
        stages={STAGES}
        candidates={[]}
        canManage
        busy={false}
        onSave={() => {}}
      />,
    );
    expect(container.textContent).toContain("No deployed agent can report a validation verdict");
    const add = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Add rule",
    );
    expect(add).toBeUndefined();
  });
});

/**
 * Ruling 396 (F39-23): file leases, on a page a person can open.
 *
 * Ruling 245 built leases and gave them no human surface. They were written by
 * one controller tool, read by another, injected into every specialist's
 * prompt, and enforced at delivery — `push-workspace` refuses the push and says
 * "clear the lease once AX-9 has landed", with nowhere to do it. Live on the
 * ax-clone board the controller wrote into the project knowledge base every
 * agent reads: "Current leases are on the project's settings page." There was
 * no such panel.
 */
describe("FileLeasesPanel (ruling 396)", () => {
  const LEASES = [
    {
      paths: ["go.mod", "go.sum"],
      taskKey: "AX-9",
      taskTitle: "Persistent store",
      reason: "AX-9 pins the module graph until it merges",
      spent: false,
    },
    {
      paths: ["Makefile"],
      taskKey: "AX-1",
      taskTitle: "Repo skeleton",
      reason: "AX-1 owns the gate harness",
      spent: true,
    },
  ];
  const CANDIDATES = [
    { key: "AX-9", title: "Persistent store" },
    { key: "AX-1", title: "Repo skeleton" },
  ];

  it("shows the paths, the holder and the reason a refusal will quote", () => {
    const { container } = render(
      <FileLeasesPanel
        leases={LEASES}
        candidates={CANDIDATES}
        canManage={false}
        busy={false}
        onSave={() => {}}
      />,
    );
    const panel = container.querySelector('[data-panel="file-leases"]')!;
    // CANARY: this whole panel is the finding. Before ruling 396 nothing in
    // app/features or app/routes read a lease at all.
    expect(panel.textContent).toContain("go.mod go.sum");
    expect(panel.textContent).toContain("AX-9");
    expect(panel.textContent).toContain("AX-9 pins the module graph until it merges");
    // Ruling 245(b): a spent lease is still a declared row, and says so.
    expect(panel.textContent).toContain("holder finished; binds nobody");
    // A reader without the grant still learns who owns the file.
    expect(panel.textContent).toContain("Read-only");
  });

  it("saves the whole list, splitting a typed path line into globs", () => {
    const saved: { paths: string[]; taskKey: string; reason: string }[][] = [];
    const { container, getByLabelText, getByText } = render(
      <FileLeasesPanel
        leases={[]}
        candidates={CANDIDATES}
        canManage
        busy={false}
        onSave={(l) => saved.push(l)}
      />,
    );
    fireEvent.click(getByText("Add lease"));
    fireEvent.change(getByLabelText("Lease 1 paths"), {
      target: { value: "  go.mod,  make/**  go.sum go.mod " },
    });
    fireEvent.change(getByLabelText("Lease 1 reason"), { target: { value: " pins it " } });
    fireEvent.click(getByText("Save"));
    expect(saved).toHaveLength(1);
    // De-duplicated, trimmed, and split on commas AND whitespace, because a
    // person typing a path list will use either.
    expect(saved[0]).toEqual([
      { paths: ["go.mod", "make/**", "go.sum"], taskKey: "AX-9", reason: "pins it" },
    ]);
    expect(container.querySelector('[data-lease-row="0"]')).not.toBeNull();
  });

  it("clears exactly the spent leases and keeps the binding one", () => {
    const saved: { paths: string[]; taskKey: string; reason: string }[][] = [];
    const { getByText } = render(
      <FileLeasesPanel
        leases={LEASES}
        candidates={CANDIDATES}
        canManage
        busy={false}
        onSave={(l) => saved.push(l)}
      />,
    );
    // The note names them before the button offers to.
    expect(getByText(/1 lease held by a task that has finished/)).toBeTruthy();
    fireEvent.click(getByText("Clear finished"));
    expect(saved[0]).toEqual([
      {
        paths: ["go.mod", "go.sum"],
        taskKey: "AX-9",
        reason: "AX-9 pins the module graph until it merges",
      },
    ]);
  });

  it("keeps a holder that is not on this board in the picker rather than rewriting it", () => {
    const { getByLabelText } = render(
      <FileLeasesPanel
        leases={[{ paths: ["x"], taskKey: "AX-404", taskTitle: null, reason: "", spent: false }]}
        candidates={CANDIDATES}
        canManage
        busy={false}
        onSave={() => {}}
      />,
    );
    // SAFETY: `Lease 1 holder` is the aria-label the panel puts on its
    // `<select>`, so the node this query returns is that element.
    const select = getByLabelText("Lease 1 holder") as HTMLSelectElement;
    expect(select.value).toBe("AX-404");
    expect(select.textContent).toContain("not on this board");
  });
});

/**
 * Ruling 368 on project Settings: the repository fetcher carries the repair,
 * the branch-cleanup switch and the scope re-check, and the credential fetcher
 * carries attach/rotate and remove, so every one of those buttons went to the
 * .45 refused step for any of them with its resting label. The one that sent
 * the request now shows it; the rest only wait.
 * Canary: pass `inFlight={null}` to RepoPanel from SettingsPage and the page
 * never says Checking… (this renders the panel, so drop `aria-busy` on
 * Re-check scopes instead).
 */
describe("ruling 368: Settings' requests in flight", () => {
  const repoPanel = (inFlight: string | null, credInFlight: string | null) =>
    render(
      <RepoPanel
        canRepair
        branchCleanup
        onSetBranchCleanup={() => {}}
        footprintTasks={0}
        repairBusy={inFlight !== null}
        repairResult={undefined}
        onRepair={() => {}}
        repo="akin-ozer/viberr"
        credential={CREDENTIAL}
        canGrant
        inFlight={inFlight}
        credInFlight={credInFlight}
        onGrantScope={() => {}}
        onSetCredential={() => {}}
        onClearCredential={() => {}}
        onOpenTask={() => {}}
      />,
    );

  it("a scope re-check in flight reads Checking…, busy, the loader spinning", () => {
    const { getByText } = repoPanel("grant-scope", null);
    const b = getByText("Checking…").closest("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(b.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
  });

  it("a branch-cleanup write in flight leaves Re-check waiting, claiming nothing", () => {
    const { getByText } = repoPanel("set-branch-cleanup", null);
    const b = getByText("Re-check scopes").closest("button")!;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
  });

  it("a rotation in flight reads Rotating… on the credential row", () => {
    const { getByText } = repoPanel(null, "set-credential");
    const b = getByText("Rotating…").closest("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    // Re-check rides the other fetcher and is untouched by this one.
    expect(getByText("Re-check scopes").closest("button")!.disabled).toBe(false);
  });

  it("an archive in flight reads Archiving…, and Delete project only waits", () => {
    const { container } = render(
      <DangerZone
        projectName="Viberr Core"
        myRole="admin"
        archived={false}
        busy
        inFlight="archive-project"
        onArchive={() => {}}
        onDelete={() => {}}
      />,
    );
    const archive = container.querySelector<HTMLButtonElement>(".dz-row .btn.ghost")!;
    expect(archive.textContent).toBe("Archiving…");
    expect(archive.getAttribute("aria-busy")).toBe("true");
    const del = container.querySelector<HTMLButtonElement>(".dz-row .btn.danger:not(.ghost)")!;
    expect(del.textContent).toBe("Delete project");
    expect(del.disabled).toBe(true);
    expect(del.hasAttribute("aria-busy")).toBe(false);
  });
});
