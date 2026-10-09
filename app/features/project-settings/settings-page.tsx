import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { STAGE_COLORS, type StageColor } from "~/shared/workflow/stage-colors";
import {
  DragDropProvider,
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
} from "@dnd-kit/dom";
import { z } from "zod";
import { Avatar } from "~/ui/avatar";
import { DRAG_SENSORS } from "~/ui/drag-sensors";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  CredentialCard,
  CredentialManageActions,
} from "~/features/github/credential-card";
import { replaceTokenHref } from "~/features/github/replace-token-href";
// Ruling 323: the invite form is a button that opens THIS shared modal —
// the same chrome (and the same ruling 288 refusal) as every org-settings
// create modal, including the org-level twin of this very action.
import { MiniModal } from "~/features/org-settings/mini-modal";
// The one shared "Escape or an outside press closes me" hook.
import { useDismiss } from "~/ui/use-dismiss";
import type { MembershipView } from "./membership.server";
import type { FileLeaseView, SettingsViewData } from "./settings-query.server";
import {
  useChangeRepoForm,
  useCredentialPosts,
  useDangerPosts,
  useIdentityPost,
  useListSave,
  useMemberPosts,
  useRepoPosts,
  useStageEditor,
} from "./settings-page-actions";
import { resolveStageOrder, stageMoveOptions } from "./stage-order";
import {
  GATE_COMMAND_MAX_CHARS,
  GATE_DEFAULT_TIMEOUT_SECONDS,
  GATE_MAX_TIMEOUT_SECONDS,
  GATE_NAME_MAX_CHARS,
  PROJECT_GATES_MAX,
  type ProjectGate,
} from "~/schemas/project-file.schema";
import type { RequiredReviewerView } from "~/server/tasks/required-reviewers.server";
import { isTerminalStage, stageLockReason, stageName } from "~/shared/workflow/stage-roles";
import { asProjectRole, roleCan } from "~/shared/rbac";
import { countLabel } from "~/shared/text/plural";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * Project settings: project identity and workflow-stages editor
 * (rename / HTML5-DnD reorder / add / remove with triage+done locks),
 * members panel (invite/remove — roles live in Policy), repository &
 * credentials (shared CredentialCard + the real Re-check scopes flow), danger
 * zone. All governed state comes from the loader; every mutation is a
 * route-action POST (no optimistic UI). Client-side guard toasts mirror
 * the mock; the server re-checks every guard.
 */

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
            // Design pass 2026-09-08: two rows held ~61px against a 22.5px line
            // box, so the third line of every real description was sliced in
            // half. Four whole line boxes; `.set-fields textarea` pins the same
            // floor so a resize cannot go below it.
            rows={4}
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
          existing commit/cancel row: cancel first, primary last, same order
          as every confirm in the product. */}
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
          {/* Ruling 288: `dirty` stays a gate; ruling 286: the save in
              flight shows itself here, Discard only waits. */}
          <button
            type="button"
            className="btn primary sm"
            disabled={!dirty || busy}
            aria-busy={busy || undefined}
            onClick={save}
          >
            {busy ? (
              <>
                <Icon name="loader" className="spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
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
            {/* Ruling 280: a task key is a name, not code, so its pattern is
                set in the body face like every key (the prefix field too). */}
            {project.prefix}-###
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
  // Ruling 288: the commit stays enabled and an empty name is refused here.
  // Counted, not boolean: each refusal re-inserts the alert, because readers
  // announce an insertion, not a role flip on unchanged text.
  const [refused, setRefused] = useState(0);
  // Ruling 284: the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
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
    // Ruling 288: the create primary stays enabled; an empty name is REFUSED
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
    // Design pass 2026-09-08: the trigger sits in the same row the field
    // replaces it with, at its natural width. It was a full-width `.panel-act`
    // bar — the one panel on the page whose "add" was a bar rather than a
    // button, beside Members' head-placed "Add member".
    return (
      <div className="stg-add spaced">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setNaming(true)}
        >
          <Icon name="plus" />
          Add stage
        </button>
      </div>
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
          className={"stg-err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
        >
          Give the stage a name.
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ stage reorder
 *
 * ONE drag language (pass 16): the board's foundation, its sensors
 * (`DRAG_SENSORS`), its "nothing reorders client-side" rule and its carve-out
 * that keeps real controls inside the row clickable. The hand-rolled HTML5
 * `draggable` row with a `.stg-handle` grip it replaced taught the opposite
 * gesture for the same verb.
 */

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

/**
 * Ruling 279: the stage's dot IS the colour picker. A real button (the dot,
 * with the app-wide focus ring) opens the twenty presets as a 5×4 grid of
 * swatches — `role="menu"` of `menuitemradio`s, the arrows walk the grid,
 * Escape closes and returns focus, an outside press closes. Picking submits
 * the governed `recolor-stage` action; the file, the board, the home meter
 * and every dot follow from the one stored name.
 */
const SWATCH_COLUMNS = 5;

function StageColorMenu({
  stage,
  disabled,
  onPick,
}: {
  stage: { id: string; name: string; color: string };
  disabled: boolean;
  onPick: (color: StageColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const swatches = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(".swatch") ?? []);
  // Opening lands focus on the current colour, so the arrows walk from it.
  useEffect(() => {
    if (!open) return;
    (
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menuRef.current?.querySelector<HTMLButtonElement>(".swatch")
    )?.focus();
  }, [open]);
  const closeAndReturnFocus = () => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const all = swatches();
    if (all.length === 0) return;
    const i = all.findIndex((item) => item === document.activeElement);
    const step = (delta: number) => {
      event.preventDefault();
      all[(i + delta + all.length) % all.length]!.focus();
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndReturnFocus();
    } else if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowDown") step(SWATCH_COLUMNS);
    else if (event.key === "ArrowUp") step(-SWATCH_COLUMNS);
    else if (event.key === "Home") {
      event.preventDefault();
      all[0]!.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      all[all.length - 1]!.focus();
    }
  };
  return (
    <div className="stg-color-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={"stg-swatch" + (open ? " open" : "")}
        data-stage-color={stage.color}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Colour of ${stage.name}: ${stage.color}. Change colour`}
        title="Change colour"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div
          ref={menuRef}
          className="own-menu swatch-menu"
          role="menu"
          aria-label={`Colour for ${stage.name}`}
          onKeyDown={onMenuKey}
        >
          {STAGE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={color === stage.color}
              className="swatch"
              data-stage-color={color}
              aria-label={color}
              title={color}
              onClick={() => {
                closeAndReturnFocus();
                if (color !== stage.color) onPick(color);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A stage row's class (ruling 13(b) took it out of `StageRow`): the
 *  grab cursor while it can drag, the lifted row while it does, and the
 *  insertion line where the dragged row would land. */
function stageRowClass(canDrag: boolean, dragging: boolean, over: boolean): string {
  return (
    "stg-row" +
    (canDrag ? " draggable" : "") +
    (dragging ? " dragging" : "") +
    (over ? " over" : "")
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
  onRecolor,
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
  onRecolor: (color: StageColor) => void;
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
      // `.card-wrap.draggable` — the whole-row surface has no grip, so the
      // cursor is its only pointer affordance.
      className={stageRowClass(canDrag, dragging, over)}
    >
      {/* The grip is gone (it was the affordance the board deliberately
          rejected), but the slot stays so locked and unlocked rows still line
          up — and it is where the entry/terminal lock glyph lives. */}
      <span
        className="stg-handle off"
        title={locked ? `${stage.name} is fixed: ${locked}` : undefined}
      >
        {locked && <Icon name="lock" />}
        {/* Interface review 2026-09-24 (acce-5): the title is a mouse extra —
            it never opens for keyboard, touch or a screen reader, and the
            disabled remove ✕ below can show nothing at all. */}
        {locked && (
          <span className="vh">
            {stage.name} is fixed: {locked}. It can't be moved or removed.
          </span>
        )}
      </span>
      <StageColorMenu stage={stage} disabled={!canManage} onPick={onRecolor} />
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
  onRecolor,
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
  onRecolor: (stageId: string, color: StageColor) => void;
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
        `Move ${countLabel(n, "task")} out of ${s.name} first`,
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
        sensors={DRAG_SENSORS}
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
              onRecolor={(color) => onRecolor(s.id, color)}
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
              {/* acce-5: the lock's reason, visibly — `title` never opens on
                  the disabled remove ✕ or for touch. */}
              {stages.length > 1 &&
                ` ${stages[0]!.name} (the entry point) and ${stages.at(-1)!.name} (human acceptance) are fixed.`}{" "}
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
          onConfirm={() => onRemove(confirmRemove.id)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------- required reviewers

/** One row of the required-reviewer table as the form holds it. */
interface RequiredReviewerDraft {
  stageId: string;
  profileId: string;
}

const draftKey = (rows: readonly RequiredReviewerDraft[]) =>
  JSON.stringify(rows.map((r) => [r.stageId, r.profileId]));

/**
 * Ruling 89 (pass 36, G36-3): the project's required reviewers, edited as a
 * small table — a non-terminal stage and a deployed verdict-capable agent per
 * row — and saved WHOLE through one intent (`set-required-reviewers`), the
 * same writer and validation the controller's `set_required_reviewers` uses.
 * Lives beside the stage editor because a rule names a stage. A role without
 * `edit-policy` reads the rules as text (ruling 27's withdrawn-not-disabled
 * precedent, the same shape the guardrail rows take); the server enforces
 * regardless. Remounted by the page (`key`) whenever the loader's rules
 * change, so a saved list never fights a stale draft.
 */
export function RequiredReviewersPanel({
  rules,
  stages,
  candidates,
  canManage,
  busy,
  onSave,
}: {
  rules: RequiredReviewerView[];
  stages: { id: string; name: string }[];
  candidates: { id: string; name: string }[];
  canManage: boolean;
  busy: boolean;
  onSave: (rules: RequiredReviewerDraft[]) => void;
}) {
  const [draft, setDraft] = useState<RequiredReviewerDraft[]>(() =>
    rules.map((r) => ({ stageId: r.stageId, profileId: r.profileId })),
  );
  // The terminal stage is never a review stage: a verdict is given before it.
  const eligibleStages = stages.filter((s) => !isTerminalStage(s.id, stages));
  const changed = draftKey(draft) !== draftKey(rules);
  const canAdd = candidates.length > 0 && eligibleStages.length > 0;
  const add = () => {
    // Default to the stage before the terminal one — the acceptance boundary
    // on the shipped board — and the first agent that can report a verdict.
    const stageId = eligibleStages[eligibleStages.length - 1]?.id ?? "";
    const profileId = candidates[0]?.id ?? "";
    setDraft((rows) => [...rows, { stageId, profileId }]);
  };
  const update = (i: number, patch: Partial<RequiredReviewerDraft>) =>
    setDraft((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => setDraft((rows) => rows.filter((_, j) => j !== i));
  const agentName = (id: string) => candidates.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="check" />
        <h2>Required reviewers</h2>
        <span className="right sub fine">{countLabel(rules.length, "rule")}</span>
      </div>
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only. Changing the required reviewers needs the{" "}
            <strong>Edit workflow &amp; policy</strong> grant (project admin).
          </span>
        </div>
      )}
      {canManage && candidates.length === 0 && (
        <div className="pol-note">
          <Icon name="alert" />
          <span>
            No deployed agent can report a validation verdict. Grant one{" "}
            <strong>Report a validation verdict</strong> on Agents before
            requiring it here.
          </span>
        </div>
      )}
      {canManage ? (
        <div className="guard-list">
          {draft.map((row, i) => (
            <div className="guard-row rr-row" key={i}>
              <label className="guard-ctl">
                Stage
                <select
                  aria-label={`Rule ${i + 1} stage`}
                  value={row.stageId}
                  disabled={busy}
                  onChange={(e) => update(i, { stageId: e.target.value })}
                >
                  {eligibleStages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="guard-ctl">
                Reviewer
                <select
                  aria-label={`Rule ${i + 1} reviewer`}
                  value={row.profileId}
                  disabled={busy}
                  onChange={(e) => update(i, { profileId: e.target.value })}
                >
                  {/* A rule naming an agent since undeployed keeps its id in
                      the picker so the row is readable and removable, never
                      silently rewritten to the first candidate. */}
                  {!candidates.some((c) => c.id === row.profileId) && (
                    <option value={row.profileId}>{row.profileId} (not deployed)</option>
                  )}
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove rule ${i + 1}: ${agentName(row.profileId)} at ${stageName(stages, row.stageId)}`}
                disabled={busy}
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : rules.length === 0 ? (
        <p className="empty rr-empty">No required reviewers declared.</p>
      ) : (
        <div className="guard-list">
          {rules.map((r) => (
            <div className="guard-row" key={`${r.stageId} ${r.profileId}`}>
              <div className="guard-main">
                <span className="guard-name">{r.agentName}</span>
                <span className="guard-desc">Reviews at {r.stageName}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Ruling 281 (e-settings #4): an empty list is ONE left-aligned row, the
          sentence with Add beside it, and Save arrives with something to save
          (a row, or the clear that removed the last one). The sentence used to
          repeat the note below word for word, centred over right-aligned
          buttons, beside a disabled primary with nothing behind it. */}
      {canManage && (
        <div className="rr-actions">
          {draft.length === 0 && <p className="empty rr-empty">No required reviewers.</p>}
          {canAdd && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={add}>
              <Icon name="plus" />
              Add rule
            </button>
          )}
          {(draft.length > 0 || changed) && (
            <button
              type="button"
              className="btn primary sm"
              disabled={!changed || busy}
              aria-busy={busy || undefined}
              onClick={() => onSave(draft)}
            >
              Save
            </button>
          )}
        </div>
      )}
      <div className="pol-note after last">
        <Icon name="shield" />
        <span>
          A required reviewer must approve the delivered revision before a task
          is accepted, whether or not the operator engaged it; the operator is
          told to run it at its stage. Without a rule, only the reviewers an
          operator engages on a task are required.
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- file leases

/** One lease row as the form holds it. Paths are edited as one line. */
interface FileLeaseDraft {
  paths: string;
  taskKey: string;
  reason: string;
}

/** One lease as the panel saves it: the paths split, the reason trimmed. */
interface SavedLease {
  paths: string[];
  taskKey: string;
  reason: string;
}

const leaseKey = (rows: readonly FileLeaseDraft[]) =>
  JSON.stringify(rows.map((r) => [splitPaths(r.paths), r.taskKey, r.reason.trim()]));

/** The one place the panel turns a typed line into the writer's path list, so
 *  the change check and the save can never disagree about what was typed. */
function splitPaths(line: string): string[] {
  return [...new Set(line.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))];
}

/**
 * Ruling 61 (F39-23): the project's file leases, on a page a person can open.
 *
 * Ruling 60 built leases and gave them no human surface at all. They were
 * declared by one controller tool, read by another, injected into every
 * specialist's prompt, and ENFORCED at delivery — `push-workspace` refuses the
 * push before anything reaches GitHub and says "clear the lease once AX-9 has
 * landed", an instruction with nowhere to carry it out. Live on the ax-clone
 * board the controller, reading the mechanism correctly, wrote into the project
 * knowledge base every agent reads: "Current leases are on the project's
 * settings page." There was no such panel. This is it.
 *
 * Saved WHOLE through one intent, like the required reviewers above it and
 * through the same writer the controller's `set_file_leases` calls, so the two
 * doors cannot validate differently. A role without `edit-policy` reads the
 * leases as text — it still needs to know who owns a file it is about to touch.
 */
export function FileLeasesPanel({
  leases,
  candidates,
  canManage,
  busy,
  onSave,
}: {
  leases: FileLeaseView[];
  candidates: { key: string; title: string }[];
  canManage: boolean;
  busy: boolean;
  onSave: (leases: SavedLease[]) => void;
}) {
  const asDraft = (rows: readonly FileLeaseView[]): FileLeaseDraft[] =>
    rows.map((l) => ({ paths: l.paths.join(" "), taskKey: l.taskKey, reason: l.reason }));
  const [draft, setDraft] = useState<FileLeaseDraft[]>(() => asDraft(leases));
  const changed = leaseKey(draft) !== leaseKey(asDraft(leases));
  const spentCount = leases.filter((l) => l.spent).length;
  const add = () =>
    setDraft((rows) => [
      ...rows,
      { paths: "", taskKey: candidates[0]?.key ?? "", reason: "" },
    ]);
  const update = (i: number, patch: Partial<FileLeaseDraft>) =>
    setDraft((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => setDraft((rows) => rows.filter((_, j) => j !== i));
  /** Ruling 60: a lease whose holder finished binds nobody. Dropping every
   *  spent row at once is the tidy `staleFileLeases` was named for. */
  const clearSpent = () => {
    const spent = new Set(
      leases.filter((l) => l.spent).map((l) => `${l.taskKey} ${l.paths.join(" ")}`),
    );
    onSave(
      draft
        .filter((r) => !spent.has(`${r.taskKey} ${splitPaths(r.paths).join(" ")}`))
        .map((r) => ({ paths: splitPaths(r.paths), taskKey: r.taskKey, reason: r.reason.trim() })),
    );
  };
  return (
    <div className="panel" data-panel="file-leases">
      <div className="panel-head">
        <Icon name="lock" />
        <h2>File leases</h2>
        <span className="right sub fine">{countLabel(leases.length, "lease")}</span>
      </div>
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only. Declaring or clearing a lease needs the{" "}
            <strong>Edit workflow &amp; policy</strong> grant (project admin).
          </span>
        </div>
      )}
      {spentCount > 0 && (
        <div className="pol-note">
          <Icon name="alert" />
          <span>
            {countLabel(spentCount, "lease")} held by a task that has finished.
            {" "}
            {spentCount === 1 ? "It binds" : "They bind"} nobody and can be cleared.
          </span>
        </div>
      )}
      {canManage ? (
        <div className="guard-list">
          {draft.map((row, i) => (
            <div className="guard-row lease-row" key={i} data-lease-row={i}>
              <label className="guard-ctl grow">
                Paths
                <input
                  type="text"
                  aria-label={`Lease ${i + 1} paths`}
                  placeholder="go.mod make/**"
                  value={row.paths}
                  disabled={busy}
                  onChange={(e) => update(i, { paths: e.target.value })}
                />
              </label>
              <label className="guard-ctl">
                Held by
                <select
                  aria-label={`Lease ${i + 1} holder`}
                  value={row.taskKey}
                  disabled={busy}
                  onChange={(e) => update(i, { taskKey: e.target.value })}
                >
                  {/* A lease naming a task off this board keeps its key in the
                      picker so the row is readable and removable, never
                      silently rewritten to another task's name. */}
                  {!candidates.some((c) => c.key === row.taskKey) && (
                    <option value={row.taskKey}>{row.taskKey} (not on this board)</option>
                  )}
                  {candidates.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.key}
                    </option>
                  ))}
                </select>
              </label>
              <label className="guard-ctl grow">
                Why
                <input
                  type="text"
                  aria-label={`Lease ${i + 1} reason`}
                  placeholder="Quoted in every refusal"
                  value={row.reason}
                  disabled={busy}
                  onChange={(e) => update(i, { reason: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove lease ${i + 1} on ${splitPaths(row.paths).join(", ") || "no path"}`}
                disabled={busy}
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : leases.length === 0 ? (
        <p className="empty rr-empty">No file leases declared.</p>
      ) : (
        <div className="guard-list">
          {leases.map((l) => (
            <div className="guard-row" key={`${l.taskKey} ${l.paths.join(" ")}`}>
              <div className="guard-main">
                <span className="guard-name">
                  <code>{l.paths.join(" ")}</code>
                </span>
                <span className="guard-desc">
                  {l.taskKey}
                  {l.taskTitle ? ` · ${l.taskTitle}` : ""}
                  {l.reason ? `: ${l.reason}` : ""}
                  {l.spent ? " (holder finished; binds nobody)" : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Ruling 280: the empty list is one row, as the reviewers' above. */}
      {canManage && (
        <div className="rr-actions">
          {draft.length === 0 && (
            <p className="empty rr-empty">
              No file leases. Every task may change any file its work needs.
            </p>
          )}
          <button type="button" className="btn ghost sm" disabled={busy} onClick={add}>
            <Icon name="plus" />
            Add lease
          </button>
          {spentCount > 0 && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={clearSpent}>
              Clear finished
            </button>
          )}
          {(draft.length > 0 || changed) && (
            <button
              type="button"
              className="btn primary sm"
              disabled={!changed || busy}
              aria-busy={busy || undefined}
              onClick={() =>
                onSave(
                  draft.map((r) => ({
                    paths: splitPaths(r.paths),
                    taskKey: r.taskKey,
                    reason: r.reason.trim(),
                  })),
                )
              }
            >
              Save
            </button>
          )}
        </div>
      )}
      <div className="pol-note after last">
        <Icon name="shield" />
        <span>
          One task owns a shared path until it merges. Another task whose branch
          changes a leased path is refused at delivery, by name, before anything
          reaches GitHub. Globs: <code>*</code> matches within one path segment,{" "}
          <code>**</code> spans segments. Every agent on this project is told
          which paths are leased before it starts.
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- gates

/** One gate row as the form holds it; the timeout is typed as text so an
 *  empty field reads as "the default" rather than as 0. */
interface GateDraft {
  name: string;
  command: string;
  timeout: string;
}

/** One gate as the panel saves it: an empty timeout is null (the default). */
interface SavedGate {
  name: string;
  command: string;
  timeoutSeconds: number | null;
}

const gateDraftOf = (gates: readonly ProjectGate[]): GateDraft[] =>
  gates.map((g) => ({
    name: g.name,
    command: g.command,
    timeout: g.timeoutSeconds === undefined ? "" : String(g.timeoutSeconds),
  }));

/** The rows as the writer receives them. A timeout field that is empty reads
 *  as the default; anything else is sent as typed and the writer refuses a
 *  value that is not a whole number of seconds, by name. */
function gatesOfDraft(rows: readonly GateDraft[]) {
  return rows.map((r) => {
    const timeout = r.timeout.trim();
    return {
      name: r.name.trim(),
      command: r.command.trim(),
      timeoutSeconds: timeout === "" ? null : Number(timeout),
    };
  });
}

/**
 * Ruling 104 (F40-52): the commands Viberr itself runs on every delivered
 * revision.
 *
 * On akinozer-com the gate list lived in the rulings knowledge base as prose,
 * WEB-1's measured set sat under "Proposed (not binding)", every directive
 * re-typed it, and the owner accepted two production deploys on agents'
 * reports of the exit codes. A gate declared here is run by the server, as the
 * task owner, in a checkout of the exact revision, and a plain acceptance
 * waits until every one exited 0 there. Saved WHOLE through one intent, the
 * writer the controller's `set_project_gates` calls. A role without
 * `edit-policy` reads the list as text.
 */
export function ProjectGatesPanel({
  gates,
  canManage,
  busy,
  onSave,
}: {
  gates: ProjectGate[];
  canManage: boolean;
  busy: boolean;
  onSave: (gates: SavedGate[]) => void;
}) {
  const [draft, setDraft] = useState<GateDraft[]>(() => gateDraftOf(gates));
  const changed =
    JSON.stringify(gatesOfDraft(draft)) !== JSON.stringify(gatesOfDraft(gateDraftOf(gates)));
  const add = () => setDraft((rows) => [...rows, { name: "", command: "", timeout: "" }]);
  const update = (i: number, patch: Partial<GateDraft>) =>
    setDraft((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => setDraft((rows) => rows.filter((_, j) => j !== i));
  return (
    <div className="panel" data-panel="project-gates">
      <div className="panel-head">
        <Icon name="check" />
        <h2>Gates</h2>
        <span className="right sub fine">{countLabel(gates.length, "gate")}</span>
      </div>
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only. Changing the gates needs the{" "}
            <strong>Edit workflow &amp; policy</strong> grant (project admin).
          </span>
        </div>
      )}
      {canManage ? (
        <div className="guard-list">
          {draft.map((row, i) => (
            <div className="guard-row lease-row gate-row" key={i} data-gate-row={i}>
              <label className="guard-ctl">
                Name
                <input
                  type="text"
                  aria-label={`Gate ${i + 1} name`}
                  placeholder="build"
                  maxLength={GATE_NAME_MAX_CHARS}
                  value={row.name}
                  disabled={busy}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </label>
              <label className="guard-ctl grow cmd">
                Command
                <input
                  type="text"
                  aria-label={`Gate ${i + 1} command`}
                  placeholder="pnpm build"
                  maxLength={GATE_COMMAND_MAX_CHARS}
                  value={row.command}
                  disabled={busy}
                  onChange={(e) => update(i, { command: e.target.value })}
                />
              </label>
              <label className="guard-ctl">
                Timeout (s)
                <input
                  type="number"
                  aria-label={`Gate ${i + 1} timeout in seconds`}
                  placeholder={String(GATE_DEFAULT_TIMEOUT_SECONDS)}
                  min={1}
                  max={GATE_MAX_TIMEOUT_SECONDS}
                  step={1}
                  value={row.timeout}
                  disabled={busy}
                  onChange={(e) => update(i, { timeout: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Remove gate ${i + 1}${row.name.trim() ? ` (${row.name.trim()})` : ""}`}
                disabled={busy}
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : gates.length === 0 ? (
        <p className="empty rr-empty">No gates declared.</p>
      ) : (
        <div className="guard-list">
          {gates.map((g) => (
            <div className="guard-row" key={g.name}>
              <div className="guard-main">
                <span className="guard-name">{g.name}</span>
                <span className="guard-desc">
                  <code>{g.command}</code> · stopped after{" "}
                  {g.timeoutSeconds ?? GATE_DEFAULT_TIMEOUT_SECONDS} s
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Ruling 280: the empty list is one row, as the reviewers' above. */}
      {canManage && (
        <div className="rr-actions">
          {draft.length === 0 && (
            <p className="empty rr-empty">
              No gates. Acceptance waits only on the reviewers&rsquo; verdicts.
            </p>
          )}
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy || draft.length >= PROJECT_GATES_MAX}
            onClick={add}
          >
            <Icon name="plus" />
            Add gate
          </button>
          {(draft.length > 0 || changed) && (
            <button
              type="button"
              className="btn primary sm"
              disabled={!changed || busy}
              aria-busy={busy || undefined}
              onClick={() => onSave(gatesOfDraft(draft))}
            >
              Save
            </button>
          )}
        </div>
      )}
      <div className="pol-note after last">
        <Icon name="shield" />
        <span>
          Viberr runs each command with <code>sh -c</code>, in order, in a fresh
          checkout of every delivered revision, as the task owner, with no
          credentials. It records each exit code, time and log on the task. A
          task is accepted only once every gate exited 0 on its revision; an
          admin&rsquo;s force accept is recorded as a bypass.
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ members

/** Which invite field a refused submit named. */
type InviteField = "name" | "email";

/**
 * Ruling 323: adding a member is an occasional multi-field action (a few
 * times in a project's life), so it is a button in the panel head that opens a
 * modal, never a form served permanently under the member list. That is also
 * what the org-level twin of this exact action does
 * (`org-settings/users-panel.tsx`: "Allow access").
 *
 * Ruling 288 comes from `MiniModal`: the primary stays enabled until the
 * request is in flight, and an incomplete submit is REFUSED here — the foot
 * alert is re-inserted and the first unmet field is marked and focused. The
 * refusal the toast used to carry ("Enter a name and a valid email") is that
 * alert now.
 *
 * The already-a-member refusal is a fact about a COMPLETE form, so it is not
 * the foot's unmet line — but it cannot be a toast either: `.toast-wrap` is an
 * ordinary fixed element, so it paints UNDER this dialog's backdrop and the
 * open modal makes its live region inert. It is answered INSIDE the dialog, the
 * way `S3TargetModal` answers a server refusal: a `.form-err` alert in the body
 * (re-keyed per refusal, so a repeat is announced as a fresh insertion) with
 * the address field marked and described by it.
 */
function InviteMemberModal({
  members,
  busy,
  onClose,
  onInvite,
}: {
  members: MembershipView[];
  busy: boolean;
  onClose: () => void;
  onInvite: (name: string, email: string) => void;
}) {
  const [nm, setNm] = useState("");
  const [em, setEm] = useState("");
  /** The field a refused submit named; null on a pristine form. */
  const [flagged, setFlagged] = useState<InviteField | null>(null);
  /** The already-a-member refusal, counted so each one re-inserts the alert. */
  const [dupe, setDupe] = useState<{ n: number; email: string } | null>(null);
  // Ruling 284: the box shakes once per refusal, not on each mount.
  const dupeShake = useRefusalShake(dupe?.n ?? null);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
  };
  const name = nm.trim();
  const email = em.trim().toLowerCase();
  const canSave = name !== "" && email.includes("@");
  // Ruling 287: an invite plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);

  const save = () => {
    if (members.some((m) => m.email.toLowerCase() === email)) {
      // D5: a refusal must not render the success tick — and it is answered in
      // the dialog, because a toast behind the backdrop is not an answer.
      setDupe((d) => ({ n: (d?.n ?? 0) + 1, email }));
      setFlagged("email");
      refs.email.current?.focus();
      return;
    }
    onInvite(name, email);
    setDone(true);
  };
  const edit =
    (field: InviteField, set: (value: string) => void) => (value: string) => {
      set(value);
      setDupe(null);
      setFlagged((f) => (f === field ? null : f));
    };
  const mark = (field: InviteField) => ({
    "aria-invalid": flagged === field || undefined,
  });

  return (
    <MiniModal
      icon={<Icon name="user" />}
      title="Add member"
      sub="They join as Viewer; roles are set in Policy"
      onClose={onClose}
      canSave={canSave}
      busy={busy}
      done={done}
      saveLabel="Add member"
      unmetHint="Enter a name and a valid email."
      focusUnmet={() => {
        const first: InviteField = name === "" ? "name" : "email";
        setFlagged(first);
        refs[first].current?.focus();
      }}
      onSave={save}
      screen="Add member dialog"
    >
      {/* Pass-19 UX coherence audit, finding #22: both fields keep a visible
          `.flabel`, not a placeholder that leaves the screen on the first
          keystroke — the same `.field` idiom, and the same two-up row, as the
          org-level twin's local-account branch. */}
      <div className="key-row even">
        <div className="field">
          <label className="flabel" htmlFor="pm-invite-name">
            Full name<span className="req">*</span>
          </label>
          <input
            ref={refs.name}
            id="pm-invite-name"
            type="text"
            placeholder="Full name"
            value={nm}
            data-autofocus
            onChange={(e) => edit("name", setNm)(e.target.value)}
            {...mark("name")}
          />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="pm-invite-email">
            Email<span className="req">*</span>
          </label>
          <input
            ref={refs.email}
            id="pm-invite-email"
            type="text"
            placeholder="email@company.dev"
            value={em}
            aria-describedby={dupe ? "pm-invite-dupe" : undefined}
            onChange={(e) => edit("email", setEm)(e.target.value)}
            {...mark("email")}
          />
        </div>
      </div>
      {dupe && (
        <div
          key={"dupe-" + dupe.n}
          id="pm-invite-dupe"
          className={"form-err" + (dupeShake.shake ? " refused" : "")}
          onAnimationEnd={dupeShake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          <span>{dupe.email} is already a member of this project.</span>
        </div>
      )}
    </MiniModal>
  );
}

export function MembersPanel({
  members,
  meId,
  projectName,
  canManage,
  busy,
  removing = null,
  onInvite,
  onRemove,
  onNavPolicy,
}: {
  members: MembershipView[];
  meId: string | null;
  projectName: string;
  canManage: boolean;
  busy: boolean;
  /** The member whose removal is in flight (ruling 286): only that row's ✕
   *  reads busy; the others, and every row during an invite, only wait. */
  removing?: string | null;
  onInvite: (name: string, email: string) => void;
  onRemove: (member: MembershipView) => void;
  onNavPolicy: () => void;
}) {
  const push = useToast();
  const [inviting, setInviting] = useState(false);
  // D6: removing a person from a project writes a governance audit row and was a
  // single silent click. Confirm it, naming who leaves and what survives.
  const [confirmRemove, setConfirmRemove] = useState<MembershipView | null>(null);

  const remove = (m: MembershipView) => {
    if (m.userId === meId) {
      // D5: a refusal must not render the success tick.
      push(`You can't remove yourself from ${projectName}`, "error");
      return;
    }
    // UI-29: mirror the server's live-account guard (`isLastLiveAdmin`).
    // Counting file entries let a ghost admin satisfy it client-side too. Only
    // the last admin who can sign in is kept: a removed or disabled admin's
    // seat is never that one, so its removal goes (F18-6, ruling 26).
    const liveAdmin = (x: MembershipView) =>
      x.role === "admin" && !x.missing && !x.disabled;
    if (liveAdmin(m) && members.filter(liveAdmin).length <= 1) {
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
  // admin can SEE and REMOVE the stale entry. Ruling 26: nor is a disabled
  // account active, but it is still a member (its row says "disabled"), so the
  // head counts members, as Policy's does.
  const stale = members.filter((m) => m.missing);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Members</h2>
        <span className="right sub fine">
          {countLabel(members.length - stale.length, "member")}
          {stale.length > 0
            ? ` · ${countLabel(stale.length, "removed account")}`
            : ""}
        </span>
        {/* Ruling 323: the panel's one create action sits in its head, the
            same placement the instance-level Users panel gives "Allow access". */}
        {canManage && (
          <span className="right">
            <button
              type="button"
              className="btn sm"
              onClick={() => setInviting(true)}
            >
              <Icon name="plus" />
              Add member
            </button>
          </span>
        )}
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
                // Ruling 283's busy step (.7) on the row whose own removal is
                // in flight; ruling 286: a row that only waits claims nothing.
                aria-busy={removing === m.userId || undefined}
                onClick={() => remove(m)}
              >
                <Icon name="x" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="pol-note after last">
        <Icon name="shield" />
        <span>
          New members join as Viewer. Roles are managed in{" "}
          <button type="button" className="keybtn" onClick={onNavPolicy}>
            Policy → Human access
          </button>
        </span>
      </div>
      {inviting && (
        <InviteMemberModal
          members={members}
          busy={busy}
          onClose={() => setInviting(false)}
          onInvite={onInvite}
        />
      )}
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
          onConfirm={() => onRemove(confirmRemove)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------- repository & credentials

/** What the dialog says it checks the new repository with (ruling 13(b) took
 *  it out of the markup). */
function repoCheckNote(current: string | null, hasCredential: boolean): string {
  return current && hasCredential
    ? "Viberr checks it with the attached credential first. Nothing changes if the check fails."
    : // Rulings 226 and 292: with no credential of the project's to ask
      // with, the change finds a connection's token and binds it.
      (current ? "No credential is attached, so " : "") +
        "Viberr checks it first with the GitHub connection for its owner, or the instance's default one, takes the repository's default branch from GitHub, and binds that connection to this project. Nothing changes if the check fails.";
}

/**
 * Owner ruling 2026-07-26: a project has one repository, and this dialog is
 * the one door that changes which (ruling 226 named it Change: "repair" was
 * the wrong word for pointing a project at the repository it should have had).
 * The human TYPES the new target; the server probes it with the bound
 * credential, or with a connection when none is bound (ruling 226),
 * and refuses misses. The repository itself is never inferred.
 */
function ChangeRepoDialog({
  current,
  footprintTasks,
  hasCredential,
  busy,
  result,
  done,
  onCancel,
  onSubmit,
}: {
  current: string | null;
  footprintTasks: number;
  hasCredential: boolean;
  busy: boolean;
  result: { ok: boolean; error?: string } | undefined;
  /** The change landed: the dialog plays its exit, then onCancel unmounts it
   *  (ruling 287). */
  done: boolean;
  onCancel: () => void;
  onSubmit: (repo: string, confirmFootprint: boolean) => void;
}) {
  // Ruling 288: the primary stays enabled; a refused submit names what is
  // missing, marks it and moves focus there (`useChangeRepoForm`).
  const {
    ref,
    close,
    repo,
    setRepo,
    ack,
    setAck,
    repoRef,
    ackRef,
    refused,
    refusalShake,
    error,
    flagged,
    submit,
  } = useChangeRepoForm({ footprintTasks, busy, result, done, onCancel, onSubmit });
  const verb = current ? "Change" : "Attach";
  return (
    <dialog
      ref={ref}
      className="confirm-card"
      aria-label={verb + " repository"}
      data-screen-label={verb + " repository dialog"}
    >
      {/* colo-7: a primary commit, so the primary wash, not the danger one. */}
      <div className="confirm-icon primary">
        <Icon name="github" />
      </div>
      <h3>{verb} repository</h3>
      {/* Ruling 226: a project with no repository attaches one here. */}
      {current ? (
        <p>
          Currently <code className="mono">{current}</code>. Enter the
          repository to use instead, as <span className="mono">owner/name</span>.
        </p>
      ) : (
        <p>
          This project has no repository. Enter the one to attach, as{" "}
          <span className="mono">owner/name</span>. Agents that hold repo-write
          then deliver through it.
        </p>
      )}
      <div className="field">
        <input
          ref={repoRef}
          type="text"
          className="mono"
          value={repo}
          placeholder="owner/name"
          aria-label="New repository, owner/name"
          aria-invalid={flagged === "repo" || undefined}
          aria-describedby={flagged === "repo" ? "repo-unmet" : undefined}
          onChange={(e) => setRepo(e.target.value)}
          data-autofocus=""
        />
      </div>
      <p className="repo-note">{repoCheckNote(current, hasCredential)}</p>
      {footprintTasks > 0 && (
        <label
          className="cred-warn ack"
        >
          <input
            ref={ackRef}
            type="checkbox"
            checked={ack}
            aria-invalid={flagged === "ack" || undefined}
            aria-describedby={flagged === "ack" ? "repo-unmet" : undefined}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            {countLabel(footprintTasks, "task")} in this project{" "}
            {footprintTasks === 1 ? "carries" : "carry"} branch/PR records
            against {current ? "the current repository" : "a repository this project had before"}.
            They keep their history, but every future sync runs against the new one.
          </span>
        </label>
      )}
      {/* Pass-19 UX audit #20 named this slot too, but it is NOT silent: the
          change rides the repository fetcher, and its `useActionToast` in
          `useRepoPosts` (settings-page-actions.ts) already pushes the failure
          through the app's announcer with the error glyph. This div is the
          "also render it in place" half. Adding `role="alert"` here would
          announce the same refusal twice. */}
      {error && (
        <div className="form-err spaced">
          <Icon name="alert" />
          {error}
        </div>
      )}
      {/* The client-side refusal has no toast, so this one IS the announcer. */}
      {flagged && (
        <div
          className={"form-err spaced" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
          id="repo-unmet"
          key={"refused-" + refused}
        >
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
          {verb} repository
        </button>
      </div>
    </dialog>
  );
}

/**
 * The Repository panel's credential slot (ruling 13(b), the split of
 * `RepoPanel`): the shared CredentialCard with its Re-check scopes and manage
 * actions for a reader who holds `grant-github-scope`, and the lock note for
 * everyone else. Hook-free; the panel renders it only while a repository is
 * attached (see the F21-5 note there).
 */
function RepoCredentialSlot({
  credential,
  canGrant,
  inFlight,
  credInFlight,
  instanceAdmin,
  onGrantScope,
  onSetCredential,
  onClearCredential,
  onOpenTask,
}: {
  credential: SettingsViewData["credential"];
  canGrant: boolean;
  /** The repository fetcher's intent (ruling 286): the scope re-check rides it. */
  inFlight: string | null;
  credInFlight: string | null;
  instanceAdmin: boolean;
  onGrantScope: () => void;
  onSetCredential: () => void;
  onClearCredential: () => void;
  onOpenTask: (taskKey: string) => void;
}) {
  const rechecking = inFlight === "grant-scope";
  return canGrant ? (
    <CredentialCard
      credential={credential}
      onOpenTask={onOpenTask}
      warnActions={
        // "Re-check scopes" re-validates a credential — on the no-credential card
        // it can only no-op into a toast, so it doesn't render there.
        credential.source !== "none" ? (
          <button
            type="button"
            className="btn sm push"
            onClick={onGrantScope}
            disabled={inFlight !== null}
            aria-busy={rechecking || undefined}
            title="Re-check the credential's scopes against GitHub"
          >
            <GlyphSwap rest="check" alt="loader" on={rechecking} spinAlt />
            {rechecking ? "Checking…" : "Re-check scopes"}
          </button>
        ) : undefined
      }
      manageActions={
        <CredentialManageActions
          configured={credential.source === "pat"}
          inFlight={credInFlight}
          replaceHref={
            instanceAdmin ? replaceTokenHref(credential.connectionId) : null
          }
          onSet={onSetCredential}
          onClear={onClearCredential}
        />
      }
    />
  ) : (
    <div className="pol-note after last">
      <Icon name="lock" />
      <span>
        Credential details need the{" "}
        <strong>Manage the GitHub credential</strong> grant (project admin
        or maintainer). The project GitHub page still shows whether this
        repository is reachable.
      </span>
    </div>
  );
}

export function RepoPanel({
  repo,
  credential,
  canGrant,
  inFlight,
  credInFlight,
  canEditPolicy,
  footprintTasks,
  branchCleanup,
  repoBusy,
  changeResult,
  onChangeRepo,
  onRemoveRepo,
  onSetBranchCleanup,
  onGrantScope,
  onSetCredential,
  onClearCredential,
  onOpenTask,
  instanceAdmin = false,
}: {
  repo: string | null;
  credential: SettingsViewData["credential"];
  canGrant: boolean;
  /** Ruling 286: the intent the repository fetcher is carrying (the change,
   *  branch cleanup or the scope re-check), null while it is idle. */
  inFlight: string | null;
  /** The same for the credential fetcher (attach / re-attach / remove). */
  credInFlight: string | null;
  /** `edit-policy` (admin) — the repo is project identity, one tier above the
   *  credential actions. */
  canEditPolicy: boolean;
  footprintTasks: number;
  /** R15-6: delete the task branch on GitHub once its review PR merges. */
  branchCleanup: boolean;
  repoBusy: boolean;
  changeResult: { ok: boolean; toast?: string; error?: string } | undefined;
  onChangeRepo: (repo: string, confirmFootprint: boolean) => void;
  /** Ruling 226: take the repository away from a board that does not write it. */
  onRemoveRepo: () => void;
  onSetBranchCleanup: (enabled: boolean) => void;
  onGrantScope: () => void;
  onSetCredential: () => void;
  onClearCredential: () => void;
  onOpenTask: (taskKey: string) => void;
  /** Ruling 222 (F40-45): the reader is an instance admin, so the credential
   *  row links to the bound connection's Update token (Instance settings is
   *  admin-only; everyone else reads where a token is replaced). */
  instanceAdmin?: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Close the dialog only when a change SUCCEEDS — a probe refusal keeps it
  // open with the typed reason so the owner can correct the input.
  // Ruling 287: through the dialog's exit (`changeDone`), then its onCancel
  // unmounts it.
  const [changeDone, setChangeDone] = useState(false);
  const settled = useRef<unknown>(changeResult);
  // The repository fetcher (`useRepoPosts`) also carries branch cleanup, the
  // scope re-check and Remove, and their ok must not close a dialog opened
  // while they ran. The dialog's
  // primary is disabled while busy, so its change goes out on an idle fetcher
  // and the next new result is that change's answer.
  const changeSent = useRef(false);
  useEffect(() => {
    if (!changeResult || settled.current === changeResult) return;
    settled.current = changeResult;
    if (changeResult.ok && changeSent.current) setChangeDone(true);
    changeSent.current = false;
  }, [changeResult]);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>Repository &amp; credentials</h2>
      </div>
      {/* UXA-3: LV-F2's lock note reached the Project, Stages and Members
          panels but not this one — yet its "delete the task branch on GitHub"
          checkbox is `disabled` for a role without the grant, with the sibling
          Change control hidden entirely. Same silent-disabled defect; same
          remedy, naming the grant this panel actually needs. */}
      {!canEditPolicy && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            {/* F20-16: real grant + tier (see the identity card note). */}
            Read-only. Changing the repository and the after-merge branch
            policy needs the{" "}
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
              // Ruling 224: a standing state, not a missing setting.
              <span className="fine md dim">none · tasks are delivered as files</span>
            )}
            {canEditPolicy && (
              <button
                type="button"
                className="btn ghost sm repo-btn"
                onClick={() => {
                  // A change an earlier opening sent must not close this one:
                  // not one that landed after its Cancel, nor one still in
                  // flight when it is answered.
                  setChangeDone(false);
                  changeSent.current = false;
                  setChanging(true);
                }}
              >
                {repo ? "Change…" : "Attach…"}
              </button>
            )}
            {canEditPolicy && repo && (
              <button
                type="button"
                className="btn ghost sm"
                disabled={repoBusy}
                onClick={() => setRemoving(true)}
              >
                Remove…
              </button>
            )}
          </span>
        </div>
        {/* P13-D-5: a "Task-level override" toggle sat here, claiming "tasks may
            attach a different repo". Nothing ever wrote `task.repo` and no
            enforcement path read the flag, so the switch changed nothing in
            either direction. One project, one repository. The "Task attachment
            · every task uses this repository" row that replaced the toggle was
            a sentence dressed as a setting (design pass 2026-09-08); the
            absence of any per-task control says it. */}
        {/* R15-6: merged task branches piled up on the repo (vib-1..4, 7, 9 were
            still there when the ruling landed). Default ON; the deletion itself
            still refuses the default branch and any branch with an open PR. */}
        {repo && (
        <div className="kv-row">
          <span className="k">After merge</span>
          <span className="v light">
            <label
              className="check-line"
              style={{ cursor: canEditPolicy ? "pointer" : "default" }}
            >
              <input
                type="checkbox"
                checked={branchCleanup}
                disabled={!canEditPolicy || repoBusy}
                onChange={(e) => onSetBranchCleanup(e.target.checked)}
              />
              delete the task branch on GitHub
            </label>
          </span>
        </div>
        )}
      </div>

      {changing && (
        <ChangeRepoDialog
          current={repo}
          footprintTasks={footprintTasks}
          hasCredential={credential.source === "pat"}
          busy={repoBusy}
          result={changeResult}
          done={changeDone}
          onCancel={() => {
            setChanging(false);
            setChangeDone(false);
          }}
          onSubmit={(next, confirmFootprint) => {
            changeSent.current = true;
            onChangeRepo(next, confirmFootprint);
          }}
        />
      )}
      {removing && repo && (
        <ConfirmDialog
          screenLabel="Repository removal dialog"
          title={`Remove ${repo} from this project?`}
body="Tasks are then delivered as the files their agents save on them. The project's credential is unbound and the connection stays in Instance settings. Branch and pull request records on existing tasks stay as history. Viberr refuses while an agent may write the repository, a pull request is still open, or a delivered revision is not yet accepted."
          confirmLabel="Remove repository"
          busy={repoBusy}
          onCancel={() => setRemoving(false)}
          onConfirm={onRemoveRepo}
        />
      )}

      {/* F21-5 (R19-11 / owner ruling Q-V1, PAT half): the credential card is
          the project's token fingerprint, its scope verdicts and its
          re-attach/remove controls. Every one of those actions gates on
          `grant-github-scope` server-side (this route's action), so the card is
          WITHDRAWN below that tier rather than rendered read-only — ruling 27's
          precedent, and byte-for-byte what /projects/:slug/github already does
          with the same component. The /github page fixed this in pass 19 and
          Settings did not, so a project Viewer read the masked tail here. The
          loader redacts the same fields it hides, so the withheld detail never
          reaches the browser at all. Ruling 224: with no repository there is
          no credential to speak of, and attaching one is the row above. */}
      {!repo ? null : (
        <RepoCredentialSlot
          credential={credential}
          canGrant={canGrant}
          inFlight={inFlight}
          credInFlight={credInFlight}
          instanceAdmin={instanceAdmin}
          onGrantScope={onGrantScope}
          onSetCredential={onSetCredential}
          onClearCredential={onClearCredential}
          onOpenTask={onOpenTask}
        />
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
  // Ruling 287: the delete leaves the way Cancel does (`commit`).
  const { ref: dialogRef, close, commit } = useDialog(onCancel);
  const [confirmName, setConfirmName] = useState("");
  const matches = confirmName.trim() === projectName;
  return (
    // Native <dialog>: Escape, backdrop-click light-dismiss, scroll lock, and
    // focus restore come from useDialog + showModal(); role="alertdialog"
    // keeps the stronger semantics. Ruling 287(d): it stays hand-written, since
    // its confirm waits on the typed name, and carries the screen label every
    // dialog does (surfaces.md §4).
    <dialog
      className="confirm-card"
      role="alertdialog"
      aria-label="Delete project"
      data-screen-label="Delete project dialog"
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
          onClick={() => commit(() => onConfirm(confirmName))}
        >
          <Icon name="x" />
          Delete project
        </button>
      </div>
    </dialog>
  );
}

/**
 * Archive and delete. Both check `edit-policy` server-side
 * (settings-actions.server.ts), and SettingsPage renders this panel only for a
 * reader who holds that grant (owner ruling Q-V1), so the panel carries no role
 * gate of its own: everyone who sees it can act on it.
 */
export function DangerZone({
  projectName,
  archived,
  busy,
  inFlight = null,
  onArchive,
  onDelete,
}: {
  projectName: string;
  archived: boolean;
  busy: boolean;
  /** Ruling 286: the intent in flight on the danger fetcher, so the control
   *  that sent it (Archive/Restore, or Delete once its dialog has closed)
   *  shows the work and the other only waits. */
  inFlight?: string | null;
  onArchive: (archived: boolean) => void;
  onDelete: (confirmName: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const archiving = inFlight === "archive-project";
  const deleting = inFlight === "delete-project";

  return (
    <div className="panel danger-panel">
      <div className="panel-head">
        <Icon name="alert" />
        <h2>Danger zone</h2>
      </div>
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
          // Ruling 278: archiving is destructive, so it carries the danger
          // label beside "Delete project" instead of reading as a plain
          // secondary. Restore is a recovery action and stays neutral.
          className={"btn ghost sm" + (archived ? "" : " danger")}
          disabled={busy}
          aria-busy={archiving || undefined}
          onClick={() => onArchive(!archived)}
        >
          {archiving && <Icon name="loader" className="spin" />}
          {archived
            ? archiving
              ? "Restoring…"
              : "Restore"
            : archiving
              ? "Archiving…"
              : "Archive"}
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
          disabled={busy}
          aria-busy={deleting || undefined}
          onClick={() => setConfirming(true)}
        >
          {deleting && <Icon name="loader" className="spin" />}
          {deleting ? "Deleting…" : "Delete project"}
        </button>
      </div>
      {confirming && (
        <DeleteProjectDialog
          projectName={projectName}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={onDelete}
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
  instanceAdmin = false,
}: {
  data: SettingsViewData;
  meId: string | null;
  myRole: string | null;
  /** Ruling 222 (F40-45): the reader's instance role is `admin`. */
  instanceAdmin?: boolean;
}) {
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  // The page's posts (settings-page-actions.ts), each with its fetcher and its
  // toast, in the order the nine fetchers always registered.
  const identityPost = useIdentityPost(csrf);
  const stageEditor = useStageEditor(csrf);
  const memberPosts = useMemberPosts(csrf);
  const repoPosts = useRepoPosts(csrf);
  const credentialPosts = useCredentialPosts(csrf);
  const dangerPosts = useDangerPosts(csrf);
  const reviewerSave = useListSave<RequiredReviewerDraft>(
    csrf,
    "set-required-reviewers",
    "rules",
  );
  // Ruling 303: a lease save answers like every other panel's.
  const leaseSave = useListSave<SavedLease>(csrf, "set-file-leases", "leases");
  const gateSave = useListSave<SavedGate>(csrf, "set-project-gates", "gates");

  // E3: every panel gate names the RbacAction its OWN server mutation checks,
  // never a shared `myRole === "admin"` literal. Project identity, the stage
  // editor and the repo panel (repository change + branch cleanup) all reach
  // `requireProjectAction(..., "edit-policy", ...)` in settings-actions.server;
  // membership CRUD reaches `manage-members`; the credential/scope actions
  // reach `grant-github-scope` (project.github.tsx). `edit-policy` and
  // `manage-members` resolve to the same admin tier TODAY — which is exactly
  // why the literal survived and exactly why it can't stay: re-tier either one
  // and the panels that don't belong to it would have followed along.
  const role = asProjectRole(myRole);
  const canEditPolicy = roleCan(role, "edit-policy");
  const canManageMembers = roleCan(role, "manage-members");
  const canGrant = roleCan(role, "grant-github-scope");
  const slug = data.project.slug;

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
        {/* Ruling 89 put the required reviewers "under the stage editor in the
            same grid cell", and rulings 61 and 104 stacked leases and gates under
            them — but the cell was a third grid item, so it wrapped to row 2 under
            Project and left a 786px hole beside it (ruling 281, e-settings #1).
            Two stacks now, one theme each: the project, its people and its
            repository on the left; the workflow and the policy that names its
            stages on the right. `.profile-col` is the sheet's
            stack-of-panels-in-a-cell (Policy stacks Guardrails the same way),
            and ruling 323 ends the two columns on one line. */}
        <div className="policy-cols">
          <div className="profile-col">
            <ProjectPanel
              // Remount (resetting the edit fields) whenever the loader's
              // identity fields change — replaces the old resync effect.
              key={`${data.project.name}\u0000${data.project.prefix}\u0000${data.project.description}`}
              project={data.project}
              canManage={canEditPolicy}
              busy={identityPost.busy}
              onSave={identityPost.save}
            />
            <MembersPanel
              members={data.members}
              meId={meId}
              projectName={data.project.name}
              canManage={canManageMembers}
              busy={memberPosts.busy}
              removing={memberPosts.removing}
              onInvite={memberPosts.invite}
              onRemove={memberPosts.remove}
              onNavPolicy={onNavPolicy}
            />
            <RepoPanel
              repo={data.project.repo}
              credential={data.credential}
              canGrant={canGrant}
              inFlight={repoPosts.inFlight}
              credInFlight={credentialPosts.inFlight}
              canEditPolicy={canEditPolicy}
              footprintTasks={data.repoFootprintTasks}
              branchCleanup={data.branchCleanupOnMerge}
              repoBusy={repoPosts.busy}
              changeResult={repoPosts.result}
              onChangeRepo={repoPosts.change}
              onRemoveRepo={repoPosts.remove}
              onSetBranchCleanup={repoPosts.setBranchCleanup}
              onGrantScope={repoPosts.grantScope}
              onSetCredential={credentialPosts.set}
              onClearCredential={credentialPosts.clear}
              onOpenTask={onOpenTask}
              instanceAdmin={instanceAdmin}
            />
          </div>
          <div className="profile-col">
            <StagesPanel
              stages={data.stages}
              counts={data.stageCounts}
              canManage={canEditPolicy}
              editingId={stageEditor.editingId}
              setEditingId={stageEditor.setEditingId}
              onRename={stageEditor.rename}
              onReorder={stageEditor.reorder}
              onAdd={stageEditor.add}
              onRemove={stageEditor.remove}
              onRecolor={stageEditor.recolor}
              onNavPolicy={onNavPolicy}
            />
            <RequiredReviewersPanel
              key={`reviewers:${JSON.stringify(data.requiredReviewers)}`}
              rules={data.requiredReviewers}
              stages={data.stages}
              candidates={data.reviewerCandidates}
              canManage={canEditPolicy}
              busy={reviewerSave.busy}
              onSave={reviewerSave.save}
            />
            {/* Ruling 61: a lease names a task and a path, and it is policy in
                the same sense the reviewer rules are, so it stacks in the same
                column under them. */}
            <FileLeasesPanel
              key={`leases:${JSON.stringify(data.fileLeases)}`}
              leases={data.fileLeases}
              candidates={data.leaseCandidates}
              canManage={canEditPolicy}
              busy={leaseSave.busy}
              onSave={leaseSave.save}
            />
            {/* Ruling 104: the gates decide what acceptance waits on, as the
                reviewer rules above do, so they stack in the same column. */}
            <ProjectGatesPanel
              key={`gates:${JSON.stringify(data.gates ?? [])}`}
              gates={data.gates ?? []}
              canManage={canEditPolicy}
              busy={gateSave.busy}
              onSave={gateSave.save}
            />
          </div>
        </div>
        {/* Owner ruling (pass 18, Q-V1): a READ-ONLY viewer must not see the
            Danger zone at all. It used to render for every member with the
            buttons disabled and a "you need the grant" note — honest, but it
            showed a stakeholder a destructive surface they can never use, and
            named archive/delete as if they were on the table. Archive and
            delete are both `edit-policy`, so this one check is the whole gate:
            whoever sees the panel can act on it. */}
        {canEditPolicy && (
        <DangerZone
          projectName={data.project.name}
          archived={data.project.archived}
          busy={dangerPosts.busy}
          inFlight={dangerPosts.inFlight}
          onArchive={dangerPosts.archive}
          onDelete={dangerPosts.deleteProject}
        />
        )}
      </div>
    </div>
  );
}
