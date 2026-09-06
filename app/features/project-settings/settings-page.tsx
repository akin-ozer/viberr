import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import {
  Accessibility,
  defaultPreset,
  Feedback,
  PointerActivationConstraints,
} from "@dnd-kit/dom";
import { z } from "zod";
import { Avatar } from "~/ui/avatar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useActionToast } from "~/ui/use-action-toast";
import {
  CredentialCard,
  CredentialManageActions,
} from "~/features/github/credential-card";
// The one shared "Escape or an outside press closes me" hook.
import { useDismiss } from "~/ui/use-dismiss";
import type { MembershipView } from "./membership.server";
import type { SettingsViewData } from "./settings-query.server";
import { stageLockReason } from "~/shared/workflow/stage-roles";
import {
  PROJECT_ROLES,
  roleCan,
  type ProjectRole,
  type RbacAction,
} from "~/shared/rbac";
import { countLabel } from "~/shared/text/plural";

/**
 * Project settings: project identity and workflow-stages editor
 * (rename / HTML5-DnD reorder / add / remove with triage+done locks),
 * members panel (invite/remove — roles live in Policy), repository &
 * credentials (shared CredentialCard + the real Grant-scope flow), danger
 * zone. All governed state comes from the loader; every mutation is a
 * route-action POST (no optimistic UI). Client-side guard toasts mirror
 * the mock; the server re-checks every guard.
 */

type ActionResult =
  | { ok: true; toast: string; stageId?: string }
  | { ok: false; error: string };

/** The route hands the viewer's project role through as a raw string. Decode it
 *  against the canonical list once, so every gate below reads a domain value
 *  instead of a hopeful cast — an unrecognized role holds nothing, which is
 *  what `roleCan` already answered for one. */
function asProjectRole(raw: string | null): ProjectRole | null {
  return PROJECT_ROLES.find((role) => role === raw) ?? null;
}

/**
 * The gate a panel here asks for its OWN action id. `roleCan` is the only
 * implementation the product ships and the default every caller gets — the
 * parameter exists so a caller can substitute a different one WITHOUT replacing
 * the module.
 *
 * E3 is why that seam is worth having: `edit-policy`, `manage-members` and
 * `grant-github-scope` are three DIFFERENT server guards that happen to resolve
 * to the same admin tier today. A check that only varies the ROLE therefore
 * cannot tell one id from another — which is exactly how a `myRole === "admin"`
 * literal survived on this page for so long. A gate that answers for exactly one
 * action id pins each panel to the id it really asks for; re-tier any of the
 * three and the pinning still holds.
 */
export type ProjectActionGate = (
  role: ProjectRole | null,
  action: RbacAction,
) => boolean;

/* F19-33: the panel-head counts and the trailing panel notes below used to be
   styled by two private consts here — `PANEL_COUNT_STYLE` (a byte copy of the
   sheet's `.fine`, app.css:230) and `POL_NOTE_STYLE` (a copy of
   `.pol-note.after` + `.pol-note.last`, app.css:3844-3846). github-view.tsx and
   policy-page.tsx each kept their own copies, and the note copies had already
   drifted three ways: .8rem here, .9rem in github-view, .85rem in the sheet.
   Hoisting the objects out of the JSX also slipped them past app.css.test.ts's
   `style={{…}}` scan, which is why the drift went unnoticed. Ruling 14: shared
   single implementations, never fork per surface. */

// Pass-19 UX audit #22: the invite inputs now carry visible labels, which makes
// the two form columns taller than the button. `.invite-row` is a grid, so its
// items stretch — bottom-align the button to the input line instead of letting
// it grow to label height. (Style here, not in app.css: one row, one rule.)
const INVITE_BTN_STYLE = { alignSelf: "end" } as const;

// ------------------------------------------------------------------ project

export function ProjectPanel({
  project,
  canManage,
  busy = false,
  onSave,
}: {
  project: SettingsViewData["project"];
  canManage: boolean;
  /** The identity write is in flight — the panel is still mounted on the OLD
   *  loader values until revalidation remounts it, so hold the Save control. */
  busy?: boolean;
  onSave: (fields: { name: string; prefix: string; description: string }) => void;
}) {
  // Revalidation resync (a save or an SSE-driven reload brings new values)
  // happens by remount: the render site keys this panel on the identity
  // fields, so state re-seeds from the loader instead of a sync effect.
  const [name, setName] = useState(project.name);
  const [prefix, setPrefix] = useState(project.prefix);
  const [desc, setDesc] = useState(project.description);

  /* U33-9 (pass 33, owner): these three fields used to carry
     `onBlur={saveIfDirty}` — the project name, the task prefix and the
     description committed themselves the moment focus left, with no control to
     press and nothing to confirm. The owner renamed a project by accident that
     way: typed into what they took for the stage-name field, clicked elsewhere,
     and the rename was governed state before they knew they had edited
     anything. The prefix is the worse of the two — every future task key and
     branch name is derived from it.

     The rest of the product does not work like that ("no optimistic UI for
     governed state", a confirm on every consequential act), so the trigger is
     now an explicit Save, live only while the fields differ from the loader,
     with Discard putting the loader's values back. The dirty test below is the
     SAME comparison the blur handler used, and the payload handed to `onSave`
     is unchanged — only what starts it moved. */
  const dirty =
    name.trim() !== project.name ||
    prefix !== project.prefix ||
    desc.trim() !== project.description;

  const discard = () => {
    setName(project.name);
    setPrefix(project.prefix);
    setDesc(project.description);
  };

  const save = () => {
    if (!dirty || busy) return; // only save when dirty (spec §7.2)
    onSave({ name, prefix, description: desc });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Project</h2>
      </div>
      {/* LV-F2: the same silent-disabled defect the Policy sheet fixed under
          P14-LV-08 — every field here is `disabled` for a role without the
          grant, but nothing said so, and `title` cannot open on a disabled
          control, so a contributor met a whole page of dead inputs with no
          explanation. State the reason where the reader can see it. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            {/* F20-16: name the REAL grant + tier. `edit-policy` is admin-only
                (rbac.ts) and its label is "Edit workflow & policy"; the old
                "Change project settings (project admin or maintainer)" invented a
                grant and wrongly promised maintainers. Matches the Policy page. */}
            Read-only. Editing project settings needs the{" "}
            <strong>Edit workflow &amp; policy</strong> grant (project admin).
          </span>
        </div>
      )}
      <div className="set-fields">
        <div className="field-row name-key">
          <div className="field">
            <label className="flabel" htmlFor="set-project-name">
              Project name
            </label>
            <input
              id="set-project-name"
              type="text"
              value={name}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="set-project-prefix">
              Task prefix
            </label>
            <input
              id="set-project-prefix"
              type="text"
              className="mono"
              value={prefix}
              disabled={!canManage}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 4))}
            />
          </div>
        </div>
        <div className="field">
          <label className="flabel" htmlFor="set-project-desc">
            Description
          </label>
          <textarea
            id="set-project-desc"
            rows={2}
            value={desc}
            disabled={!canManage}
            onChange={(e) => setDesc(e.target.value)}
          ></textarea>
        </div>
      </div>
      {/* U33-9: the explicit trigger the blur handler replaced. Withheld
          entirely without the grant — the fields above are already `disabled`
          there and the note names the grant, so a Save control would only offer
          a role an act it cannot perform. `.confirm-actions` is the sheet's
          existing commit/cancel row (app.css:2133): cancel first, primary last,
          same order as every confirm in the product. */}
      {canManage && (
        <div className="confirm-actions">
          <button
            type="button"
            className="btn ghost sm"
            disabled={!dirty || busy}
            onClick={discard}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!dirty || busy}
            onClick={save}
          >
            Save changes
          </button>
        </div>
      )}
      <div className="kv after-fields">
        <div className="kv-row">
          <span className="k">Task keys</span>
          <span className="v">
            {/* U33-9: reads the LOADER's prefix, not the draft above it. While
                the blur handler existed the two could not diverge; now they can,
                and a "Task keys" row is a statement about the project, not a
                preview of an uncommitted edit. Same rule as everywhere else on
                this page: no optimistic UI for governed state. */}
            <span className="mono">{project.prefix}-###</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Canonical task file</span>
          <span className="v">
            <Icon name="file" />
            <span className="mono">{project.taskFilePattern}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- stages

/**
 * Name-FIRST stage creation (2026-07-28 UX ruling). "Add stage" used to POST on
 * the click and commit a stage literally called "New stage" — a real workflow
 * stage, spliced into the governed transition chain, from one stray press. The
 * button now opens an inline field and nothing is written until a name is
 * committed; Escape or Cancel leaves the board untouched.
 */
function AddStageControl({ onAdd }: { onAdd: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  // Ruling 147: the commit stays enabled and an empty name is refused here.
  // Counted, not boolean: each refusal re-inserts the alert, because readers
  // announce an insertion, not a role flip on unchanged text.
  const [refused, setRefused] = useState(0);
  const errId = "stg-add-err";
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  const cancel = () => {
    setNaming(false);
    setName("");
    setRefused(0);
  };
  const commit = () => {
    const v = name.trim();
    // Ruling 147: the create primary stays enabled; an empty name is REFUSED
    // on the client with a sentence, not pre-empted by a dead button.
    if (!v) {
      setRefused((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    onAdd(v);
    cancel();
  };

  if (!naming) {
    return (
      <button
        type="button"
        className="btn ghost sm panel-act"
        onClick={() => setNaming(true)}
      >
        <Icon name="plus" />
        Add stage
      </button>
    );
  }
  return (
    <div className="stg-add spaced">
      <input
        ref={inputRef}
        className="stg-input"
        value={name}
        placeholder="Stage name"
        aria-label="New stage name"
        aria-invalid={refused > 0 || undefined}
        aria-describedby={refused > 0 ? errId : undefined}
        onChange={(e) => {
          setName(e.target.value);
          setRefused(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
      />
      <button type="button" className="btn ghost sm" onClick={cancel}>
        Cancel
      </button>
      <button type="button" className="btn primary sm" onClick={commit}>
        Add stage
      </button>
      {refused > 0 && (
        <span
          key={`stg-refused-${refused}`}
          id={errId}
          role="alert"
          className="stg-err"
        >
          Give the stage a name.
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ stage reorder
 *
 * ONE drag language (pass 16). The board migrated to dnd-kit on 2026-08-03
 * under a deliberate affordance ruling: the whole card is the drag surface and
 * there is NO grip handle. This list shipped the opposite — a hand-rolled
 * HTML5 `draggable` row with a visible `.stg-handle` grip — so the product
 * taught two contradictory gestures for the same verb. It is now the same
 * foundation, the same sensors, the same "nothing reorders client-side" rule,
 * and the same carve-out that keeps real controls inside the row clickable.
 */
const STAGE_SENSORS = [
  PointerSensor.configure({
    // The row contains a rename button, a Move menu and a remove ✕. Only those
    // opt out of dragging — everything else in the row lifts it, which is what
    // makes a grip unnecessary.
    preventActivation: (event: PointerEvent) => {
      const target = event.target;
      return (
        target instanceof Element &&
        Boolean(target.closest("button, input, select, textarea"))
      );
    },
    // Mouse: distance only, so a slow press on the row's name still clicks.
    // Touch: a short press, so scrolling the settings column is never hijacked.
    activationConstraints: (event: PointerEvent) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];

/* Same call as the board: the Accessibility plugin's role="button" wrapper
 * would nest the rename/move/remove controls inside an interactive element
 * (axe: nested-interactive, serious). Drag stays pointer-only and the
 * accessible path is the per-row Move menu below. */
const STAGE_PLUGINS = defaultPreset.plugins.filter(
  (plugin) => plugin !== Accessibility,
);

/** Sortable payload — the id of the row below this one, so a drop past a row's
 *  midpoint can resolve to "after it" without a global lookup (board parity). */
const stageDragDataSchema = z.object({ nextId: z.string().nullable() });
type StageDragData = z.infer<typeof stageDragDataSchema>;

/**
 * Resolve a finished stage drag — or a Move-menu pick — into the ordered id
 * list the `reorder-stages` action takes, or null when nothing should be
 * submitted. Pure, so the pinning and no-op rules are unit-testable without a
 * drag library; the direct counterpart of `board-dnd.ts:resolveBoardDrop`.
 *
 * `beforeId` names the stage the moved one should land immediately BEFORE
 * (null = the end of the list), exactly like the board's `beforeKey`.
 */
export function resolveStageOrder(
  stages: readonly { id: string }[],
  moveId: string,
  beforeId: string | null,
): string[] | null {
  const ids = stages.map((s) => s.id);
  if (!ids.includes(moveId)) return null;
  if (beforeId === moveId) return null;
  const rest = ids.filter((id) => id !== moveId);
  // A target that vanished under the drag (the list can change via SSE
  // revalidation) degrades to the end rather than submitting a reference the
  // server cannot place.
  const found = beforeId === null ? -1 : rest.indexOf(beforeId);
  const insertAt = beforeId === null || found < 0 ? rest.length : found;
  const next = [...rest.slice(0, insertAt), moveId, ...rest.slice(insertAt)];
  // Entry stays first, terminal stays last — pinned by CURRENT identity, not by
  // literal id, mirroring what the server re-applies on top of whatever we send.
  const entryId = ids[0];
  const terminalId = ids.length > 1 ? ids[ids.length - 1] : undefined;
  const pinned = [
    ...(entryId === undefined ? [] : [entryId]),
    ...next.filter((id) => id !== entryId && id !== terminalId),
    ...(terminalId === undefined ? [] : [terminalId]),
  ];
  if (pinned.every((id, i) => id === ids[i])) return null;
  return pinned;
}

/** The stages a member may actually reorder: everything between the pinned
 *  entry and terminal stages. */
function movableStages<T extends { id: string }>(stages: readonly T[]): T[] {
  return stages.length > 2 ? stages.slice(1, -1) : [];
}

/**
 * Every reorder this row can perform, as `{label, beforeId}` pairs. Empty when
 * the row cannot move, which is what hides the Move control.
 */
export function stageMoveOptions(
  stages: readonly { id: string; name: string }[],
  stageId: string,
): { label: string; beforeId: string | null }[] {
  const movable = movableStages(stages);
  const i = movable.findIndex((s) => s.id === stageId);
  if (i < 0 || movable.length < 2) return [];
  const out: { label: string; beforeId: string | null }[] = [];
  if (i > 0) {
    out.push({ label: "Move earlier", beforeId: movable[i - 1]!.id });
    if (i > 1) out.push({ label: "Move to first", beforeId: movable[0]!.id });
  }
  if (i < movable.length - 1) {
    // Land after my current neighbour: before whatever follows it.
    out.push({ label: "Move later", beforeId: movable[i + 2]?.id ?? null });
    if (i < movable.length - 2) out.push({ label: "Move to last", beforeId: null });
  }
  return out;
}

/**
 * The keyboard/AT path for stage reordering, modelled on `ui/stage-menu.tsx` —
 * the board's sanctioned non-drag path. Drag here is pointer-only for the same
 * reason it is on the board, and before this the stage order was reachable by
 * MOUSE ONLY: HTML5 drag events have no keyboard equivalent and no touch one,
 * so a keyboard user could rename and delete stages but never reorder them.
 *
 * Same contract as StageMenu: a real <button aria-haspopup="menu"> whose label
 * names the current position, `role="menu"` items, ↑/↓ wrapping, Home/End,
 * Escape closes and returns focus to the trigger, an outside press closes.
 */
function StageMoveMenu({
  stage,
  position,
  total,
  options,
  onMove,
}: {
  stage: { id: string; name: string };
  position: number;
  total: number;
  options: { label: string; beforeId: string | null }[];
  onMove: (beforeId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The one shared "Escape or an outside press closes me" hook.
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
        [],
    );

  // StageMenu's contract: opening moves focus into the first item so the arrow
  // keys have an anchor. Reads the ref inline so the effect has no stale-closure
  // dependency to declare.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [open]);

  const closeAndReturnFocus = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    if (all.length === 0) return;
    const i = all.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      // Keep the document-level listener from acting on the same press; focus
      // return is this menu's job, not the shared hook's.
      event.stopPropagation();
      closeAndReturnFocus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      all[i < 0 ? 0 : (i + 1) % all.length]!.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      all[i <= 0 ? all.length - 1 : i - 1]!.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      all[0]!.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      all[all.length - 1]!.focus();
    }
  };

  if (options.length === 0) return null;

  return (
    <div className="own-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={"own-btn" + (open ? " open" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${stage.name}, currently stage ${position} of ${total}`}
        title="Move this stage in the workflow order"
        onClick={() => setOpen(!open)}
      >
        Move
        <Icon name="chevron" />
      </button>
      {open && (
        <div
          ref={menuRef}
          // The menu is 258px wide and this trigger sits at the right edge of a
          // horizontally-clipped settings column, so it anchors right instead of
          // left — `.own-menu.to-right` in the sheet, which also moves the
          // entrance transform-origin with it (P16-UI-25).
          className="own-menu to-right"
          role="menu"
          aria-label={`Move ${stage.name}`}
          onKeyDown={onMenuKey}
        >
          <div className="own-lbl">Workflow order</div>
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                closeAndReturnFocus();
                onMove(option.beforeId);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StageRow({
  stage,
  index,
  taskCount,
  locked,
  canManage,
  editing,
  dragging,
  over,
  nextId,
  moveOptions,
  totalStages,
  onStartRename,
  onCommitName,
  onCancelRename,
  onMove,
  onRemove,
  entryId,
}: {
  stage: SettingsViewData["stages"][number];
  index: number;
  taskCount: number;
  locked: string | null;
  canManage: boolean;
  editing: boolean;
  dragging: boolean;
  over: boolean;
  nextId: string | null;
  moveOptions: { label: string; beforeId: string | null }[];
  totalStages: number;
  onStartRename: () => void;
  onCommitName: (raw: string) => void;
  onCancelRename: () => void;
  onMove: (beforeId: string | null) => void;
  onRemove: () => void;
  entryId: string | undefined;
}) {
  // Whole row is the drag surface. Optimistic sorting is OFF — this list never
  // reorders client-side; the `.over` insertion line shows the requested slot
  // and the server's answer, arriving by revalidation, is the only commit.
  const canDrag = canManage && !locked && !editing;
  const { ref } = useSortable<StageDragData>({
    id: stage.id,
    index,
    data: { nextId },
    disabled: !canDrag,
    plugins: (defaults) => [
      ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
      Feedback.configure({ feedback: "clone" }),
    ],
  });
  return (
    <div
      ref={ref}
      // `.draggable` is the grab-cursor hook, named to match the board's
      // `.card-wrap.draggable` (app.css:672-673) — the whole-row surface has no
      // grip, so the cursor is its only pointer affordance.
      className={
        "stg-row" +
        (canDrag ? " draggable" : "") +
        (dragging ? " dragging" : "") +
        (over ? " over" : "")
      }
    >
      {/* The grip is gone (it was the affordance the board deliberately
          rejected), but the slot stays so locked and unlocked rows still line
          up — and it is where the entry/terminal lock glyph lives. */}
      <span
        className="stg-handle off"
        title={locked ? `${stage.name} is fixed: ${locked}` : undefined}
      >
        {locked && <Icon name="lock" />}
      </span>
      <span className="sdot" style={{ background: stage.color }}></span>
      {editing ? (
        <input
          type="text"
          className="stg-input"
          aria-label={"Rename " + stage.name}
          defaultValue={stage.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onBlur={(e) => onCommitName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onCancelRename();
          }}
        />
      ) : (
        <button
          type="button"
          className="stg-name"
          title="Rename stage"
          disabled={!canManage}
          onClick={onStartRename}
        >
          {stage.name}
        </button>
      )}
      <span className="stg-count">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
      </span>
      {canManage && (
        <StageMoveMenu
          stage={stage}
          position={index + 1}
          total={totalStages}
          options={moveOptions}
          onMove={onMove}
        />
      )}
      <button
        type="button"
        className={"stg-x" + (locked ? " off" : "")}
        aria-label={"Remove " + stage.name}
        title={
          locked
            ? `${stage.name} is a required ${stage.id === entryId ? "entry" : "terminal"} stage and can't be removed`
            : "Remove stage"
        }
        // F10-22: entry/terminal stages are model-locked; the control is
        // truly disabled (not just greyed) so it never looks actionable.
        disabled={!canManage || Boolean(locked)}
        onClick={onRemove}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function StagesPanel({
  stages,
  counts,
  canManage,
  editingId,
  setEditingId,
  onRename,
  onReorder,
  onAdd,
  onRemove,
  onNavPolicy,
}: {
  stages: SettingsViewData["stages"];
  counts: Record<string, number>;
  canManage: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onRename: (stageId: string, name: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAdd: (name: string) => void;
  onRemove: (stageId: string) => void;
  onNavPolicy: () => void;
}) {
  const push = useToast();
  const [dragId, setDragId] = useState<string | null>(null);
  // The row the dragged stage would land immediately BEFORE (null = the end),
  // drawn as the `.stg-row.over` insertion line. Board parity: `beforeKey`.
  const [beforeId, setBeforeId] = useState<string | null>(null);
  // D6: removing a stage is a governance change that writes an audit row — it
  // was a single silent click while archiving a (reversible) task took a
  // three-row ceremony. Confirm it, naming the outcome.
  const [confirmRemove, setConfirmRemove] = useState<
    { id: string; name: string } | null
  >(null);

  const count = (id: string) => counts[id] ?? 0;
  const entryId = stages[0]?.id;

  const commitName = (s: { id: string; name: string }, raw: string) => {
    setEditingId(null);
    const v = raw.trim();
    if (!v || v === s.name) return;
    onRename(s.id, v);
  };

  const remove = (s: { id: string; name: string }) => {
    const locked = stageLockReason(s.id, stages);
    if (locked) {
      // D5: a refusal must not render the success tick.
      push(`${s.name} can't be removed: ${locked}`, "error");
      return;
    }
    const n = count(s.id);
    if (n > 0) {
      push(
        `Move ${n} ${n === 1 ? "task" : "tasks"} out of ${s.name} first`,
        "error",
      );
      return;
    }
    // D6: cleared the client-side guards — now confirm the governance change.
    setConfirmRemove({ id: s.id, name: s.name });
  };

  /** Drag and the Move menu land on the SAME governed submission. */
  const move = (moveId: string, before: string | null) => {
    const next = resolveStageOrder(stages, moveId, before);
    if (!next) return;
    onReorder(next);
  };

  // dnd-kit event flow, mirroring the board's: a row target proposes "insert
  // before that row"; onDragMove refines it against the pointer's vertical
  // midpoint (top half → before it, bottom half → before the next one).
  const onDragStart = (event: DragStartEvent) => {
    setDragId(String(event.operation.source?.id ?? "") || null);
    setBeforeId(null);
  };
  const onDragOver = (event: DragOverEvent) => {
    const target = event.operation.target;
    setBeforeId(target ? String(target.id) : null);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const target = event.operation.target;
    const element = target?.element;
    if (!target || !element) return;
    const rect = element.getBoundingClientRect();
    const id = String(target.id);
    const payload = stageDragDataSchema.safeParse(target.data);
    const nextId = payload.success ? payload.data.nextId : null;
    const before =
      event.operation.position.current.y < rect.top + rect.height / 2
        ? id
        : nextId;
    setBeforeId((prev) => (prev === before ? prev : before));
  };
  // Fires on drop AND on cancel (Escape, released outside the list). Nothing
  // commits client-side; a resolved drop submits the governed reorder and
  // revalidation applies the server's order.
  const onDragEnd = (event: DragEndEvent) => {
    const active = dragId;
    setDragId(null);
    setBeforeId(null);
    if (!active || event.canceled) return;
    move(active, beforeId);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="branch" />
        <h2>Workflow stages</h2>
        <span className="right sub fine">
          {countLabel(stages.length, "stage")}
        </span>
      </div>
      <DragDropProvider
        sensors={STAGE_SENSORS}
        plugins={STAGE_PLUGINS}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      >
        <div className="stg-list">
          {stages.map((s, i) => (
            <StageRow
              key={s.id}
              stage={s}
              index={i}
              taskCount={count(s.id)}
              locked={stageLockReason(s.id, stages)}
              canManage={canManage}
              editing={editingId === s.id}
              dragging={dragId === s.id}
              over={beforeId === s.id && dragId !== s.id}
              nextId={stages[i + 1]?.id ?? null}
              moveOptions={stageMoveOptions(stages, s.id)}
              totalStages={stages.length}
              entryId={entryId}
              onStartRename={() => setEditingId(s.id)}
              onCommitName={(raw) => commitName(s, raw)}
              onCancelRename={() => setEditingId(null)}
              onMove={(before) => move(s.id, before)}
              onRemove={() => remove(s)}
            />
          ))}
        </div>
      </DragDropProvider>
      {canManage && <AddStageControl onAdd={onAdd} />}
      {/* P13-D-1: this used to point at Policy for "who may move tasks between
          stages" as if transitions were authored there — Policy only flips the
          boundary ON an existing rule. The chain itself is maintained HERE, by
          these controls, so the note says what each surface actually does. */}
      {/* LV-F2: this note used to give drag/rename/add INSTRUCTIONS to every
          reader, including a role whose controls are all disabled — telling a
          contributor to do something the page will not let them do. Speak to
          the reader's actual authority. */}
      <div className="pol-note after last">
        <Icon name={canManage ? "shield" : "lock"} />
        <span>
          {canManage ? (
            <>
              Drag a row to reorder, or use its Move menu · click a name to rename.
              Adding or removing a stage re-wires the transition chain around it.
              The new hop inherits the boundary it replaced. Loosen or tighten a
              boundary in{" "}
              <button type="button" className="keybtn" onClick={onNavPolicy}>
                Policy → Workflow rules
              </button>
            </>
          ) : (
            <>
              {/* F20-16: real grant + tier (see the identity card note). */}
              Read-only. Editing the workflow stages needs the{" "}
              <strong>Edit workflow &amp; policy</strong> grant (project admin).
              Boundaries are shown in{" "}
              <button type="button" className="keybtn" onClick={onNavPolicy}>
                Policy → Workflow rules
              </button>
            </>
          )}
        </span>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          screenLabel="Stage removal dialog"
          title={`Remove the ${confirmRemove.name} stage?`}
          body={
            <>
              <strong>{confirmRemove.name}</strong> is deleted from this
              project&rsquo;s workflow and the transition chain re-wires around
              it. The change is recorded in the audit trail.
            </>
          }
          confirmLabel="Remove stage"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            onRemove(confirmRemove.id);
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ members

export function MembersPanel({
  members,
  meId,
  projectName,
  canManage,
  busy,
  onInvite,
  onRemove,
  onNavPolicy,
}: {
  members: MembershipView[];
  meId: string | null;
  projectName: string;
  canManage: boolean;
  busy: boolean;
  onInvite: (name: string, email: string) => void;
  onRemove: (member: MembershipView) => void;
  onNavPolicy: () => void;
}) {
  const push = useToast();
  const [nm, setNm] = useState("");
  const [em, setEm] = useState("");
  // D6: removing a person from a project writes a governance audit row and was a
  // single silent click. Confirm it, naming who leaves and what survives.
  const [confirmRemove, setConfirmRemove] = useState<MembershipView | null>(null);

  const invite = () => {
    const name = nm.trim();
    const email = em.trim().toLowerCase();
    if (!name || !email.includes("@")) {
      // D5: a refusal must not render the success tick.
      push("Enter a name and a valid email", "error");
      return;
    }
    if (members.some((m) => m.email.toLowerCase() === email)) {
      push(`${email} is already a member`, "error");
      return;
    }
    onInvite(name, email);
    setNm("");
    setEm("");
  };

  const remove = (m: MembershipView) => {
    if (m.userId === meId) {
      // D5: a refusal must not render the success tick.
      push(`You can't remove yourself from ${projectName}`, "error");
      return;
    }
    if (
      m.role === "admin" &&
      // UI-29: mirror the server's live-account guard. Counting file entries
      // let a ghost admin satisfy it client-side too.
      members.filter((x) => x.role === "admin" && !x.missing && !x.disabled)
        .length <= 1 &&
      !m.missing
    ) {
      // D5: a refusal must not render the success tick.
      push(
        `${m.name} is the only admin. Assign another admin in Policy first`,
        "error",
      );
      return;
    }
    // D6: guards cleared — confirm the governance change before it submits.
    setConfirmRemove(m);
  };

  // LV-04/UI-29: memberships whose org account was deleted are counted and
  // labelled separately — they are not active members, and the row exists so an
  // admin can SEE and REMOVE the stale entry.
  const stale = members.filter((m) => m.missing);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Members</h2>
        <span className="right sub fine">
          {members.length - stale.length} active
          {stale.length > 0
            ? ` · ${stale.length} removed account${stale.length === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      {/* LV-F2: same silent-disabled class as the Project + Stages panels. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only. Adding or removing project members needs the{" "}
            <strong>Manage members &amp; roles</strong> grant (project admin).
          </span>
        </div>
      )}
      <div className="member-list last">
        {members.map((m) => (
          <div className="member-row" key={m.userId}>
            <Avatar person={{ initials: m.initials, tone: m.tone }} />
            <span className="member-main">
              <div className="nm">
                {m.name}
                {m.userId === meId && <span className="you-tag">you</span>}
                {m.missing && (
                  <>
                    {" "}
                    <Pill kind="blocked" sm>
                      removed account
                    </Pill>
                  </>
                )}
                {!m.missing && m.disabled && (
                  <>
                    {" "}
                    <Pill kind="neutral" sm>
                      disabled
                    </Pill>
                  </>
                )}
              </div>
              <div className="em">
                {m.missing
                  ? "The org account was deleted. Remove this stale membership."
                  : m.email}
              </div>
            </span>
            {canManage && (
              <button
                type="button"
                className="stg-x"
                aria-label={"Remove " + m.name}
                title={
                  m.missing
                    ? "Remove this stale membership"
                    : "Remove member"
                }
                disabled={busy}
                onClick={() => remove(m)}
              >
                <Icon name="x" />
              </button>
            )}
          </div>
        ))}
      </div>
      {/* Pass-19 UX coherence audit, finding #22: these two inputs were bare —
          no `.flabel`, no `htmlFor`, their only name a placeholder that leaves
          the screen on the first keystroke. The org-level twin of this exact
          action labels every field (org-settings/users-panel.tsx: "Full name" /
          "Email" over inputs whose placeholders are the same strings), as do
          this page's own identity fields, so one invite form in the product
          disagreed with the rest. It matters most below 1300px, where
          `.invite-row` collapses to one column (app.css) and the two
          same-looking boxes stack — a 1280px laptop is inside that. Same
          in-house `.field` + `.flabel` idiom, no new visual language. */}
      {canManage && (
        <div className="invite-row">
          <div className="field">
            <label className="flabel" htmlFor="pm-invite-name">
              Full name<span className="req">*</span>
            </label>
            <input
              id="pm-invite-name"
              type="text"
              placeholder="Full name"
              value={nm}
              onChange={(e) => setNm(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="pm-invite-email">
              Email<span className="req">*</span>
            </label>
            <input
              id="pm-invite-email"
              type="text"
              placeholder="email@company.dev"
              value={em}
              onChange={(e) => setEm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") invite();
              }}
            />
          </div>
          <button
            type="button"
            className="btn sm"
            style={INVITE_BTN_STYLE}
            onClick={invite}
            disabled={busy}
          >
            <Icon name="send" />
            Invite
          </button>
        </div>
      )}
      <div className="pol-note after last">
        <Icon name="shield" />
        <span>
          New members join as Viewer. Roles are managed in{" "}
          <button type="button" className="keybtn" onClick={onNavPolicy}>
            Policy → Human access
          </button>
        </span>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          screenLabel="Member removal dialog"
          title={`Remove ${confirmRemove.name} from ${projectName}?`}
          body={
            confirmRemove.missing
              ? "This clears the stale membership left by a deleted org account. The audit history is untouched."
              : "They lose access to this project. Their comments and decisions stay in the audit history, and any task they own is released: the ownership seat reopens for another contributor to take."
          }
          confirmLabel="Remove member"
          busy={busy}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            onRemove(confirmRemove);
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------- repository & credentials

/**
 * Owner ruling 2026-07-26: the repository stays one-per-project and read-only —
 * this dialog is the explicit repair path for a repo misconfigured at creation
 * (wrong owner, wrong name, or both). The human TYPES the corrected target;
 * the server probes it with the bound credential and refuses misses. Nothing
 * is inferred and there is no automatic failover.
 */
function RepairRepoDialog({
  current,
  footprintTasks,
  hasCredential,
  busy,
  result,
  onCancel,
  onSubmit,
}: {
  current: string | null;
  footprintTasks: number;
  hasCredential: boolean;
  busy: boolean;
  result: { ok: boolean; error?: string } | undefined;
  onCancel: () => void;
  onSubmit: (repo: string, confirmFootprint: boolean) => void;
}) {
  const { ref, close } = useDialog(onCancel);
  const [repo, setRepo] = useState("");
  const [ack, setAck] = useState(false);
  const [sent, setSent] = useState(false);
  const repoRef = useRef<HTMLInputElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  // Ruling 147: the primary stays enabled; a refused submit names what is
  // missing, marks it and moves focus there. Counted so each refusal
  // re-inserts the alert.
  const [refused, setRefused] = useState(0);
  const missing: "repo" | "ack" | null =
    repo.trim().length <= 2 ? "repo" : footprintTasks > 0 && !ack ? "ack" : null;
  const error = sent && !busy && result && !result.ok ? result.error : null;
  const submit = () => {
    if (busy) return;
    if (missing) {
      setRefused((n) => n + 1);
      (missing === "repo" ? repoRef : ackRef).current?.focus();
      return;
    }
    setSent(true);
    onSubmit(repo, ack);
  };
  const flagged = refused > 0 ? missing : null;
  return (
    <dialog ref={ref} className="confirm-card" aria-label="Repair repository">
      <div className="confirm-icon">
        <Icon name="github" />
      </div>
      <h3>Repair repository</h3>
      <p>
        Currently <code className="mono">{current ?? "unset"}</code>. Enter the
        corrected <span className="mono">owner/name</span>. This is for the
        project that was misconfigured at creation, not for moving healthy work.
      </p>
      <div className="field">
        <input
          ref={repoRef}
          type="text"
          className="mono"
          value={repo}
          placeholder="owner/name"
          aria-label="Corrected repository, owner/name"
          aria-invalid={flagged === "repo" || undefined}
          aria-describedby={flagged === "repo" ? "repair-unmet" : undefined}
          onChange={(e) => setRepo(e.target.value)}
          data-autofocus=""
        />
      </div>
      <p className="repair-note">
        {hasCredential
          ? "The new repository is verified with the attached credential before anything changes. A repo the token can't see refuses the repair."
          : "No credential is attached, so the new repository can't be verified until one is."}
      </p>
      {footprintTasks > 0 && (
        <label
          className="cred-warn ack"
        >
          <input
            ref={ackRef}
            type="checkbox"
            checked={ack}
            aria-invalid={flagged === "ack" || undefined}
            aria-describedby={flagged === "ack" ? "repair-unmet" : undefined}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            {footprintTasks} task{footprintTasks === 1 ? "" : "s"} in this
            project carry branch/PR records against the current repository.
            They keep their history, but every future sync runs against the
            new one.
          </span>
        </label>
      )}
      {/* Pass-19 UX audit #20 named this slot too, but it is NOT silent: the
          repair rides `repoFetcher`, and `useActionToast(repoFetcher)` in
          SettingsPage already pushes the failure through the app's announcer
          with the error glyph. This div is the "also render it in place" half.
          Adding `role="alert"` here would announce the same refusal twice. */}
      {error && (
        <div className="cred-warn">
          <Icon name="alert" />
          {error}
        </div>
      )}
      {/* The client-side refusal has no toast, so this one IS the announcer. */}
      {flagged && (
        <div className="cred-warn" role="alert" id="repair-unmet" key={"refused-" + refused}>
          <Icon name="alert" />
          {flagged === "repo"
            ? "Enter the repository as owner/name."
            : "Confirm the note about the existing branch records first."}
        </div>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          aria-busy={busy}
          onClick={submit}
        >
          Repair repository
        </button>
      </div>
    </dialog>
  );
}

export function RepoPanel({
  repo,
  credential,
  canGrant,
  busy,
  credBusy,
  canRepair,
  footprintTasks,
  branchCleanup,
  repairBusy,
  repairResult,
  onRepair,
  onSetBranchCleanup,
  onGrantScope,
  onSetCredential,
  onClearCredential,
  onOpenTask,
}: {
  repo: string | null;
  credential: SettingsViewData["credential"];
  canGrant: boolean;
  busy: boolean;
  credBusy: boolean;
  /** `edit-policy` (admin) — the repo is project identity, one tier above the
   *  credential actions. */
  canRepair: boolean;
  footprintTasks: number;
  /** R15-6: delete the task branch on GitHub once its review PR merges. */
  branchCleanup: boolean;
  repairBusy: boolean;
  repairResult: { ok: boolean; toast?: string; error?: string } | undefined;
  onRepair: (repo: string, confirmFootprint: boolean) => void;
  onSetBranchCleanup: (enabled: boolean) => void;
  onGrantScope: () => void;
  onSetCredential: () => void;
  onClearCredential: () => void;
  onOpenTask: (taskKey: string) => void;
}) {
  const [repairing, setRepairing] = useState(false);
  // Close the dialog only when a repair SUCCEEDS — a probe refusal keeps it
  // open with the typed reason so the owner can correct the input.
  const settled = useRef<unknown>(repairResult);
  useEffect(() => {
    if (!repairResult || settled.current === repairResult) return;
    settled.current = repairResult;
    if (repairResult.ok) setRepairing(false);
  }, [repairResult]);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>Repository &amp; credentials</h2>
      </div>
      {/* UXA-3: LV-F2's lock note reached the Project, Stages and Members
          panels but not this one — yet its "delete the task branch on GitHub"
          checkbox is `disabled` for a role without the grant, with the sibling
          Repair control hidden entirely. Same silent-disabled defect; same
          remedy, naming the grant this panel actually needs. */}
      {!canRepair && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            {/* F20-16: real grant + tier (see the identity card note). */}
            Read-only. Repairing the repository binding and changing the
            after-merge branch policy need the{" "}
            <strong>Edit workflow &amp; policy</strong> grant (project admin).
          </span>
        </div>
      )}
      <div className="kv">
        <div className="kv-row">
          <span className="k">Default repository</span>
          <span className="v">
            <Icon name="github" />
            {repo ? (
              <span className="mono">{repo}</span>
            ) : (
              <span className="fine md dim">not set</span>
            )}
            {canRepair && (
              <button
                type="button"
                className="btn ghost sm repair-btn"
                onClick={() => setRepairing(true)}
                title="Fix a repository that was misconfigured at creation. The fix is verified against the attached credential before anything changes"
              >
                Repair…
              </button>
            )}
          </span>
        </div>
        {/* P13-D-5: a "Task-level override" toggle sat here, claiming "tasks may
            attach a different repo". Nothing ever wrote `task.repo` and no
            enforcement path read the flag, so the switch changed nothing in
            either direction. One project, one repository — stated plainly. */}
        <div className="kv-row">
          <span className="k">Task attachment</span>
          <span className="v plain">
            every task uses this repository
          </span>
        </div>
        {/* R15-6: merged task branches piled up on the repo (vib-1..4, 7, 9 were
            still there when the ruling landed). Default ON; the deletion itself
            still refuses the default branch and any branch with an open PR. */}
        <div className="kv-row">
          <span className="k">After merge</span>
          <span className="v light">
            <label
              className="branch-cleanup"
              style={{ cursor: canRepair ? "pointer" : "default" }}
            >
              <input
                type="checkbox"
                checked={branchCleanup}
                disabled={!canRepair || repairBusy}
                onChange={(e) => onSetBranchCleanup(e.target.checked)}
              />
              delete the task branch on GitHub
            </label>
          </span>
        </div>
      </div>

      {repairing && (
        <RepairRepoDialog
          current={repo}
          footprintTasks={footprintTasks}
          hasCredential={credential.source === "pat"}
          busy={repairBusy}
          result={repairResult}
          onCancel={() => setRepairing(false)}
          onSubmit={onRepair}
        />
      )}

      {/* F21-5 (R19-11 / owner ruling Q-V1, PAT half): the credential card is
          the project's token fingerprint, its scope verdicts and its
          rotate/remove controls. Every one of those actions gates on
          `grant-github-scope` server-side (this route's action), so the card is
          WITHDRAWN below that tier rather than rendered read-only — ruling 37's
          precedent, and byte-for-byte what /projects/:slug/github already does
          with the same component. The /github page fixed this in pass 19 and
          Settings did not, so a project Viewer read the masked tail here. The
          loader redacts the same fields it hides, so the withheld detail never
          reaches the browser at all. */}
      {canGrant ? (
        <CredentialCard
          credential={credential}
          onOpenTask={onOpenTask}
          warnActions={
            // "Grant scope" re-checks a credential — on the no-credential card
            // it can only no-op into a toast, so it doesn't render there.
            credential.source !== "none" ? (
              <button
                type="button"
                className="btn sm push"
                onClick={onGrantScope}
                disabled={busy}
                title="Re-check the credential's scopes against GitHub"
              >
                <Icon name="check" />
                Grant scope
              </button>
            ) : undefined
          }
          manageActions={
            <CredentialManageActions
              configured={credential.source === "pat"}
              canManage={canGrant}
              busy={credBusy}
              onSet={onSetCredential}
              onClear={onClearCredential}
            />
          }
        />
      ) : (
        <div className="pol-note after last">
          <Icon name="lock" />
          <span>
            Credential details need the <strong>Grant GitHub scope</strong>{" "}
            grant (project admin or maintainer). The project GitHub page still
            shows whether this repository is reachable.
          </span>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- danger zone

function DeleteProjectDialog({
  projectName,
  busy,
  onCancel,
  onConfirm,
}: {
  projectName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (confirmName: string) => void;
}) {
  const { ref: dialogRef, close } = useDialog(onCancel);
  const [confirmName, setConfirmName] = useState("");
  const matches = confirmName.trim() === projectName;
  return (
    // Native <dialog>: Escape, backdrop-click light-dismiss, scroll lock, and
    // focus restore come from useDialog + showModal(); role="alertdialog"
    // keeps the stronger semantics.
    <dialog
      className="confirm-card"
      role="alertdialog"
      aria-label="Delete project"
      ref={dialogRef}
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3>Delete {projectName}?</h3>
      <p>
        {/* A5 (pass 23): the server KEEPS the audit trail (it writes a fresh
            project.deleted row); the old copy claimed the logs went too. */}
        Removes tasks and timelines. The audit trail is kept. This cannot be
        undone. Type <strong>{projectName}</strong> to confirm.
      </p>
      <div className="field spaced">
        <input
          type="text"
          value={confirmName}
          autoFocus
          placeholder={projectName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!matches || busy}
          style={!matches ? { opacity: 0.5, pointerEvents: "none" } : undefined}
          onClick={() => onConfirm(confirmName)}
        >
          <Icon name="x" />
          Delete project
        </button>
      </div>
    </dialog>
  );
}

export function DangerZone({
  projectName,
  myRole,
  archived,
  busy,
  onArchive,
  onDelete,
  gate = roleCan,
}: {
  projectName: string;
  myRole: string | null;
  archived: boolean;
  busy: boolean;
  onArchive: (archived: boolean) => void;
  onDelete: (confirmName: string) => void;
  /** See `ProjectActionGate`. Defaults to the shared `roleCan`. */
  gate?: ProjectActionGate;
}) {
  const [confirming, setConfirming] = useState(false);
  // RU-3: archive AND delete both gate on the `edit-policy` action server-side
  // (settings-actions.server.ts → requireProjectAction(..., "edit-policy", ...)).
  // Mirror that exact ACTION_ROLES entry through `roleCan` instead of a raw
  // `=== "admin"` literal so the control's visibility can never drift from the
  // action the server actually checks — the same way `canGrant` already routes
  // through the shared helper. (`edit-policy` resolves to admin-only today, so
  // this is behavior-preserving; it stops being a hardcoded assumption.)
  const canManageLifecycle = gate(asProjectRole(myRole), "edit-policy");

  return (
    <div className="panel danger-panel">
      <div className="panel-head">
        <Icon name="alert" />
        <h2>Danger zone</h2>
      </div>
      {/* P14-LV-08: both buttons below were already `disabled` for a
          non-admin — and live, a contributor clicked them and got nothing at
          all: no dialog, no toast, no error, no audit row. `disabled` had no
          styling in app.css (fixed there), and the "why" was parked in a
          `title` that a disabled element can never show, because no pointer
          event reaches it. State the authority once, visibly, above the rows
          it governs. */}
      {!canManageLifecycle && (
        <p className="deny-note before">
          <Icon name="lock" />
          Archiving and deleting {projectName} need the{" "}
          <strong>Edit workflow &amp; policy</strong> grant. Ask a project
          admin.
        </p>
      )}
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">
            {archived ? `Restore ${projectName}` : `Archive ${projectName}`}
          </div>
          <div className="dd">
            {archived
              ? "This project is archived and hidden from the workspace. Restore it to make it active again."
              : "Hides the project from the workspace and moves it to the Home “Archived” section. Timelines are preserved and it can be restored anytime."}
          </div>
        </span>
        <button
          type="button"
          // Ruling 149: archiving is destructive, so it carries the danger
          // label beside "Delete project" instead of reading as a plain
          // secondary. Restore is a recovery action and stays neutral.
          className={"btn ghost sm" + (archived ? "" : " danger")}
          // F10-34: destructive project actions are project-admin only. A
          // viewer/maintainer must not see an actionable control; the server
          // still enforces edit-policy.
          disabled={busy || !canManageLifecycle}
          title={canManageLifecycle ? undefined : "Only a project admin can archive this project"}
          onClick={() => onArchive(!archived)}
        >
          {archived ? "Restore" : "Archive"}
        </button>
      </div>
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">Delete project</div>
          <div className="dd">
            Removes tasks and timelines. The audit trail is kept. This cannot be
            undone.
          </div>
        </span>
        <button
          type="button"
          className="btn danger sm"
          // F10-34: project-admin only; disabled for everyone else so the
          // typed-confirm dialog can never be opened without authority.
          disabled={busy || !canManageLifecycle}
          title={canManageLifecycle ? undefined : "Only a project admin can delete this project"}
          onClick={() => setConfirming(true)}
        >
          Delete project
        </button>
      </div>
      {confirming && (
        <DeleteProjectDialog
          projectName={projectName}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={(confirmName) => {
            setConfirming(false);
            onDelete(confirmName);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- page

export function SettingsPage({
  data,
  meId,
  myRole,
  gate = roleCan,
}: {
  data: SettingsViewData;
  meId: string | null;
  myRole: string | null;
  /** See `ProjectActionGate`. Defaults to the shared `roleCan`. */
  gate?: ProjectActionGate;
}) {
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  const identityFetcher = useFetcher<ActionResult>();
  const stageFetcher = useFetcher<ActionResult>();
  const memberFetcher = useFetcher<ActionResult>();
  const repoFetcher = useFetcher<ActionResult>();
  const credFetcher = useFetcher<ActionResult>();
  const dangerFetcher = useFetcher<ActionResult>();
  useActionToast(identityFetcher);
  useActionToast(stageFetcher);
  useActionToast(memberFetcher);
  useActionToast(repoFetcher);
  useActionToast(credFetcher);
  useActionToast(dangerFetcher);

  // E3: every panel gate names the RbacAction its OWN server mutation checks,
  // never a shared `myRole === "admin"` literal. Project identity, the stage
  // editor and the repo panel (repair + branch-cleanup) all reach
  // `requireProjectAction(..., "edit-policy", ...)` in settings-actions.server;
  // membership CRUD reaches `manage-members`; the credential/scope actions
  // reach `grant-github-scope` (project.github.tsx). `edit-policy` and
  // `manage-members` resolve to the same admin tier TODAY — which is exactly
  // why the literal survived and exactly why it can't stay: re-tier either one
  // and the panels that don't belong to it would have followed along.
  const role = asProjectRole(myRole);
  const canEditPolicy = gate(role, "edit-policy");
  const canManageMembers = gate(role, "manage-members");
  const canGrant = gate(role, "grant-github-scope");
  const slug = data.project.slug;

  // Stage rename edit-mode lives here so a fresh add-stage response can
  // drop the new row straight into edit mode (mock behavior).
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const autoEdited = useRef<unknown>(null);
  useEffect(() => {
    if (stageFetcher.state !== "idle" || !stageFetcher.data) return;
    if (autoEdited.current === stageFetcher.data) return;
    autoEdited.current = stageFetcher.data;
    if (stageFetcher.data.ok && stageFetcher.data.stageId) {
      setEditingStageId(stageFetcher.data.stageId);
    }
  }, [stageFetcher.state, stageFetcher.data]);

  const onNavPolicy = () => navigate(`/projects/${slug}/policy`);
  const onOpenTask = (taskKey: string) =>
    navigate(`/projects/${slug}/tasks/${taskKey}`);

  return (
    <div className="board-wrap" data-screen-label="Settings">
      <div className="board-head">
        <div>
          {/* R15-13: the project's own settings named the project only in the
              subtitle, while INSTANCE settings put "Viberr" in its heading.
              Scoped, so each heading answers "settings for what?" on its own. */}
          <h1>{data.project.name} · settings</h1>
          <div className="sub">Board configuration for this project</div>
        </div>
      </div>
      <div className="policy-wrap">
        <div className="policy-cols">
          <ProjectPanel
            // Remount (resetting the edit fields) whenever the loader's
            // identity fields change — replaces the old resync effect.
            key={`${data.project.name}\u0000${data.project.prefix}\u0000${data.project.description}`}
            project={data.project}
            canManage={canEditPolicy}
            busy={identityFetcher.state !== "idle"}
            onSave={(fields) =>
              identityFetcher.submit(
                { intent: "save-project", _csrf: csrf, ...fields },
                { method: "post" },
              )
            }
          />
          <StagesPanel
            stages={data.stages}
            counts={data.stageCounts}
            canManage={canEditPolicy}
            editingId={editingStageId}
            setEditingId={setEditingStageId}
            onRename={(stageId, name) =>
              stageFetcher.submit(
                { intent: "rename-stage", _csrf: csrf, stageId, name },
                { method: "post" },
              )
            }
            onReorder={(orderedIds) =>
              stageFetcher.submit(
                {
                  intent: "reorder-stages",
                  _csrf: csrf,
                  orderedIds: orderedIds.join(","),
                },
                { method: "post" },
              )
            }
            onAdd={(name) =>
              stageFetcher.submit(
                { intent: "add-stage", _csrf: csrf, name },
                { method: "post" },
              )
            }
            onRemove={(stageId) =>
              stageFetcher.submit(
                { intent: "remove-stage", _csrf: csrf, stageId },
                { method: "post" },
              )
            }
            onNavPolicy={onNavPolicy}
          />
        </div>
        <div className="policy-cols">
          <MembersPanel
            members={data.members}
            meId={meId}
            projectName={data.project.name}
            canManage={canManageMembers}
            busy={memberFetcher.state !== "idle"}
            onInvite={(name, email) =>
              memberFetcher.submit(
                { intent: "invite", _csrf: csrf, name, email },
                { method: "post" },
              )
            }
            onRemove={(member) =>
              memberFetcher.submit(
                { intent: "remove-member", _csrf: csrf, userId: member.userId },
                { method: "post" },
              )
            }
            onNavPolicy={onNavPolicy}
          />
          <RepoPanel
            repo={data.project.repo}
            credential={data.credential}
            canGrant={canGrant}
            busy={repoFetcher.state !== "idle"}
            credBusy={credFetcher.state !== "idle"}
            canRepair={canEditPolicy}
            footprintTasks={data.repoFootprintTasks}
            branchCleanup={data.branchCleanupOnMerge}
            repairBusy={repoFetcher.state !== "idle"}
            repairResult={repoFetcher.data}
            onRepair={(repoInput, confirmFootprint) => {
              const fields = {
                intent: "repair-repo",
                _csrf: csrf,
                repo: repoInput,
              };
              // Only a confirmed repair carries the field: the route reads it
              // as `confirmFootprint === "1"`, so it is sent or absent, never
              // blank.
              repoFetcher.submit(
                confirmFootprint ? { ...fields, confirmFootprint: "1" } : fields,
                { method: "post" },
              );
            }}
            onSetBranchCleanup={(enabled) =>
              repoFetcher.submit(
                {
                  intent: "set-branch-cleanup",
                  _csrf: csrf,
                  enabled: enabled ? "1" : "0",
                },
                { method: "post" },
              )
            }
            onGrantScope={() =>
              repoFetcher.submit(
                { intent: "grant-scope", _csrf: csrf },
                { method: "post" },
              )
            }
            onSetCredential={() =>
              credFetcher.submit(
                { intent: "set-credential", _csrf: csrf },
                { method: "post" },
              )
            }
            onClearCredential={() =>
              credFetcher.submit(
                { intent: "clear-credential", _csrf: csrf },
                { method: "post" },
              )
            }
            onOpenTask={onOpenTask}
          />
        </div>
        {/* Owner ruling (pass 18, Q-V1): a READ-ONLY viewer must not see the
            Danger zone at all. It used to render for every member with the
            buttons disabled and a "you need the grant" note — honest, but it
            showed a stakeholder a destructive surface they can never use, and
            named archive/delete as if they were on the table. Anyone who CAN
            act still sees it unchanged (the in-panel deny note stays for the
            in-between roles that hold some but not all lifecycle grants). */}
        {canEditPolicy && (
        <DangerZone
          projectName={data.project.name}
          myRole={myRole}
          gate={gate}
          archived={data.project.archived}
          busy={dangerFetcher.state !== "idle"}
          onArchive={(archived) =>
            dangerFetcher.submit(
              { intent: "archive-project", _csrf: csrf, archived: String(archived) },
              { method: "post" },
            )
          }
          onDelete={(confirmName) =>
            dangerFetcher.submit(
              { intent: "delete-project", _csrf: csrf, confirmName },
              { method: "post" },
            )
          }
        />
        )}
      </div>
    </div>
  );
}
