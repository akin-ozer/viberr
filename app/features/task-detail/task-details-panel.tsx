import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useFetcher, type FetcherWithComponents } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { PRIORITY_VALUES, type TaskPriority } from "~/schemas/task-file.schema";
import type { DependencyRender, DependencyState } from "~/shared/dependencies";
import { Calendar } from "~/ui/calendar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { LabelInput } from "~/ui/label-input";
import { DueDatePill, LabelChips, PriorityFlag } from "~/ui/task-meta";
import { useDismiss } from "~/ui/use-dismiss";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useStableValue } from "~/ui/use-stable-rows";
import { useActionFeedback, type ActionResult } from "./task-detail-hooks";

/**
 * Ruling 501: the task's Details panel (priority, labels, due date and what
 * the task waits on), drawn the way Linear's and GitHub's issue sidebars draw
 * their properties. Each value IS its control: a person who may edit
 * (`edit-task-meta`) clicks the value and edits that one property in a popover
 * anchored under it, as the Stage row in Current state already works. The
 * panel no longer turns into a three-field form, and the "Edit details" and
 * "Edit what it waits on" buttons under it are gone.
 *
 * Every property has its own fetcher and posts only its own field (the route
 * leaves alone an axis the form does not carry), so a save touches exactly
 * what the person changed and shows its own work in flight (ruling 368). An
 * editor seeds from server truth each time it opens (the goal-editor rule),
 * and nothing reads as saved before the server answers: no optimistic UI for
 * governed state. The wait keeps its own form, intent and refusal (ruling
 * 131): a bad reference keeps its editor open beside the error.
 */

type DetailProp = "priority" | "labels" | "due" | "deps";

/** The menu reads most urgent first, the way the flags escalate. */
const PRIORITY_MENU = [...PRIORITY_VALUES].reverse();
const priorityName = (p: TaskPriority) => p.charAt(0).toUpperCase() + p.slice(1);

/** An entry's state as a status ring, the family ruling 499's to-do steps
 *  draw: waiting, done, or a wait that can never complete (ruling 355). */
const WAIT_GLYPH = {
  open: "todo",
  done: "checkcircle",
  failed: "ban",
  missing: "ban",
  cancelled: "ban",
} satisfies Record<DependencyState, IconName>;

type Fetcher = FetcherWithComponents<ActionResult>;

export function TaskDetailsPanel({
  task,
  canEdit,
  labelSuggestions = [],
  queuedQuestions = [],
}: {
  task: TaskDetail;
  canEdit: boolean;
  /** Labels already used in this project, offered as label autocomplete. */
  labelSuggestions?: string[];
  /** Ruling 241: reviewer questions the hold refused, put when it lifts. They
   *  belong under the wait because they ARE what happens when it ends. */
  queuedQuestions?: { id: string; profileId: string; decidedByLabel: string }[];
}) {
  const [open, setOpen] = useState<DetailProp | null>(null);
  // F26-13: an archived task's planning metadata is frozen (the server refuses
  // the write too), so its values read as text, never as controls.
  const editable = canEdit && !task.archived;
  /** Null for a row that is read-only; otherwise whether its editor is open. */
  const openState = (prop: DetailProp) => (editable ? open === prop : null);
  // Ruling 457: a revalidation decodes new arrays for the same labels and the
  // same wait. The rows are memoised on these and on primitives, so a task
  // that did not change re-renders none of them.
  const labels = useStableValue(task.labels);
  const suggestions = useStableValue(labelSuggestions);
  const blockedBy = useStableValue(task.blockedBy);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="sliders" />
        <h2>Details</h2>
      </div>
      <div className="kv props">
        <PriorityRow priority={task.priority} open={openState("priority")} setOpen={setOpen} />
        <LabelsRow labels={labels} suggestions={suggestions} open={openState("labels")} setOpen={setOpen} />
        <DueRow due={task.dueDate ?? null} open={openState("due")} setOpen={setOpen} />
        <WaitRow taskKey={task.key} blockedBy={blockedBy} open={openState("deps")} setOpen={setOpen} />
        {queuedQuestions.length > 0 && (
          // Ruling 241: without this the only trace of a queued question is
          // one timeline note, and a promise a person cannot see is the
          // defect this pass kept finding.
          <div className="kv-row prop-note" data-queued-questions={queuedQuestions.length}>
            <span className="k">When it clears</span>
            <span className="v">
              {queuedQuestions.length === 1
                ? `Viberr puts ${queuedQuestions[0]!.decidedByLabel}'s question to `
                : `Viberr puts ${queuedQuestions.length} queued questions to `}
              {queuedQuestions
                .map((q) => {
                  // Ruling 232: a handle is a NAME. The reviewer's live
                  // profile name, falling back to its role and then to the
                  // profile id, so an undeployed profile still reads as
                  // something a person can act on.
                  const live = [task.specialist, ...task.reviewers].find(
                    (a) => a?.profileId === q.profileId,
                  );
                  return live?.profileName || live?.role || q.profileId;
                })
                .join(", ")}
              {" before the operator gets the task back."}
            </span>
          </div>
        )}
      </div>
      {canEdit && task.archived && (
        <p className="meta-archived-note">
          <Icon name="lock" />
          Archived. Restore this task to edit its details.
        </p>
      )}
    </div>
  );
}

/** What a row's editor is handed: whether it is open, and how to open and
 *  close it. Null for a viewer, whose rows are read-only. */
type EditState = { open: boolean; toggle: () => void; close: () => void } | null;

/** A row's props from the panel: its open state (null when read-only) and
 *  the panel's one setter, both stable, so the memoised row holds still. */
interface RowControl {
  open: boolean | null;
  setOpen: Dispatch<SetStateAction<DetailProp | null>>;
}

function editState(prop: DetailProp, { open, setOpen }: RowControl): EditState {
  if (open === null) return null;
  return {
    open,
    toggle: () => setOpen((current) => (current === prop ? null : prop)),
    close: () => setOpen((current) => (current === prop ? null : current)),
  };
}

/** A property's own fetcher, with its toast or refusal. */
function usePropFetcher(): Fetcher {
  const fetcher = useFetcher<ActionResult>();
  useActionFeedback(fetcher);
  return fetcher;
}

/** A quiet value: the default priority, an empty set, or the invitation to
 *  fill one. Never the loudest thing on the row. */
function Quiet({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="prop-empty">
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

/**
 * One property row. For a viewer the value is text; for an editor it is the
 * trigger that opens `editor` in a popover under it. The trigger is named by
 * the row's label and its value ("Priority urgent"), so the visible label is
 * in the name (WCAG 2.5.3).
 */
function PropRow({
  prop,
  label,
  edit,
  busy,
  popup,
  value,
  editor,
  rowData,
}: {
  prop: DetailProp;
  label: string;
  edit: EditState;
  /** This property's own save is in flight (ruling 368). */
  busy: boolean;
  /** The editor's kind: a menu of choices, a form, or the calendar. */
  popup: "menu" | "form" | "calendar";
  value: ReactNode;
  /** The popover's content, handed the close that gives focus back. */
  editor: (done: () => void) => ReactNode;
  rowData?: Record<`data-${string}`, number>;
}) {
  const labelId = useId();
  const valueId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = edit?.open === true;
  const role = popup === "menu" ? "menu" : "dialog";
  // An outside press, or focus leaving for another control, closes it where
  // the person went; so does Escape, and the effect below then hands focus
  // back to the trigger.
  const popRef = useDismiss<HTMLDivElement>(open, () => edit?.close(), {
    also: [btnRef],
    focus: true,
  });
  const done = () => {
    edit?.close();
    btnRef.current?.focus();
  };

  // Into the editor as it opens, unless it took focus itself (the calendar
  // moves it to its day), and into view when the row sits low on the page.
  useEffect(() => {
    const pop = popRef.current;
    if (!open || !pop) return;
    pop.scrollIntoView?.({ block: "nearest" });
    if (pop.contains(document.activeElement)) return;
    // A menu's checked choice first; otherwise the first field, else button.
    (
      pop.querySelector<HTMLElement>('[aria-checked="true"]') ??
      pop.querySelector<HTMLElement>('input:not([type="hidden"]), button')
    )?.focus({ preventScroll: true });
  }, [open, popRef]);

  // A popover that closed with focus inside it (Escape, a save) leaves focus
  // nowhere; hand it back to the trigger.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && document.activeElement === document.body) {
      btnRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div className="kv-row" data-prop={prop} {...rowData}>
      <span className="k" id={labelId}>
        {label}
      </span>
      <span className="v">
        {edit ? (
          <>
            <button
              ref={btnRef}
              type="button"
              className="prop-btn"
              aria-haspopup={role}
              aria-expanded={open}
              aria-labelledby={`${labelId} ${valueId}`}
              // Ruling 368: the trigger that started a save shows it. It stays
              // focusable while it works (a disabled control drops the
              // keyboard's place) and ignores presses until the server answers.
              aria-busy={busy || undefined}
              onClick={() => {
                if (!busy) edit.toggle();
              }}
            >
              <span className="prop-val" id={valueId}>
                {busy ? (
                  <span className="prop-empty">
                    <Icon name="loader" className="spin" />
                    Saving…
                  </span>
                ) : (
                  value
                )}
              </span>
            </button>
            {open && (
              <div
                ref={popRef}
                className={`prop-pop prop-${popup}`}
                role={role}
                aria-labelledby={labelId}
              >
                {editor(done)}
              </div>
            )}
          </>
        ) : (
          <span className="prop-val">{value}</span>
        )}
      </span>
    </div>
  );
}

const PriorityRow = memo(function PriorityRow({
  priority: current,
  ...control
}: { priority: TaskPriority } & RowControl) {
  const csrf = useCsrfToken();
  const fetcher = usePropFetcher();
  return (
    <PropRow
      prop="priority"
      label="Priority"
      edit={editState("priority", control)}
      busy={fetcher.state !== "idle"}
      popup="menu"
      value={
        // `normal` is the default: the shared flag draws nothing for it, and
        // the row says it quietly rather than in bold.
        current === "normal" ? <Quiet icon="flag">Normal</Quiet> : <PriorityFlag priority={current} sm />
      }
      editor={(done) => (
        <PriorityMenu
          current={current}
          onPick={(p) => {
            done();
            if (p !== current) {
              void fetcher.submit(
                { intent: "set-task-metadata", _csrf: csrf, priority: p },
                { method: "post" },
              );
            }
          }}
        />
      )}
    />
  );
});

/** The priorities as an ARIA menu: roving arrows, Home and End, the current
 *  one checked. */
function PriorityMenu({
  current,
  onPick,
}: {
  current: TaskPriority;
  onPick: (priority: TaskPriority) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const at = items.findIndex((el) => el === document.activeElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : e.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };
  return (
    <div className="prop-menu-list" onKeyDown={onKeyDown}>
      {PRIORITY_MENU.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitemradio"
          aria-checked={p === current}
          className="menu-item"
          data-priority={p}
          onClick={() => onPick(p)}
        >
          <Icon name="flag" />
          {priorityName(p)}
          {p === current && <Icon name="check" className="prop-check" />}
        </button>
      ))}
    </div>
  );
}

const LabelsRow = memo(function LabelsRow({
  labels,
  suggestions,
  ...control
}: { labels: string[]; suggestions: string[] } & RowControl) {
  const fetcher = usePropFetcher();
  const edit = editState("labels", control);
  // While the editor is open its Save shows the work; once it is closed
  // (Cancel mid-save) the trigger does.
  const busy = fetcher.state !== "idle";
  return (
    <PropRow
      prop="labels"
      label="Labels"
      edit={edit}
      busy={busy && !edit?.open}
      popup="form"
      value={
        labels.length > 0 ? (
          <LabelChips labels={labels} max={6} />
        ) : edit ? (
          <Quiet icon="plus">Add labels</Quiet>
        ) : (
          <Quiet>None</Quiet>
        )
      }
      editor={(done) => (
        <LabelsEditor labels={labels} suggestions={suggestions} fetcher={fetcher} done={done} />
      )}
    />
  );
});

/** Mounted each time the editor opens, so its draft starts from the labels
 *  the server holds now. */
function LabelsEditor({
  labels,
  suggestions,
  fetcher,
  done,
}: {
  labels: string[];
  suggestions: string[];
  fetcher: Fetcher;
  done: () => void;
}) {
  const csrf = useCsrfToken();
  const [draft, setDraft] = useState(labels);
  const busy = fetcher.state !== "idle";
  const sent = useSent(fetcher, done);
  return (
    <fetcher.Form
      method="post"
      className="prop-form-body"
      onSubmit={(e) => {
        if (busy) e.preventDefault();
        else if (draft.join("\n") === labels.join("\n")) {
          // Nothing changed: close without a request, or a toast.
          e.preventDefault();
          done();
        } else sent();
      }}
    >
      <input type="hidden" name="intent" value="set-task-metadata" />
      <input type="hidden" name="_csrf" value={csrf} />
      <input type="hidden" name="labels" value={draft.join(",")} />
      <LabelInput value={draft} onChange={setDraft} suggestions={suggestions} />
      <SaveRow busy={busy} onCancel={done} />
    </fetcher.Form>
  );
}

/** Close an editor once the request it sent succeeds. A refusal keeps it open
 *  beside the error toast; a result that was already there when the editor
 *  mounted is not its answer. */
function useSent(fetcher: Fetcher, done: () => void): () => void {
  const pending = useRef(false);
  useFetcherResult(fetcher, (d) => {
    if (!pending.current) return;
    pending.current = false;
    if (d.ok) done();
  });
  return () => {
    pending.current = true;
  };
}

const DueRow = memo(function DueRow({ due, ...control }: { due: string | null } & RowControl) {
  const csrf = useCsrfToken();
  const fetcher = usePropFetcher();
  const edit = editState("due", control);
  const save = (value: string) =>
    void fetcher.submit({ intent: "set-task-metadata", _csrf: csrf, dueDate: value }, { method: "post" });
  return (
    <PropRow
      prop="due"
      label="Due date"
      edit={edit}
      busy={fetcher.state !== "idle"}
      popup="calendar"
      value={
        due ? (
          <DueDatePill dueDate={due} sm />
        ) : edit ? (
          <Quiet icon="clock">Set due date</Quiet>
        ) : (
          <Quiet>None</Quiet>
        )
      }
      editor={(done) => (
        <>
          <Calendar
            selected={due}
            onSelect={(iso) => {
              done();
              if (iso !== due) save(iso);
            }}
          />
          {due && (
            <div className="prop-acts">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  done();
                  save("");
                }}
              >
                <Icon name="x" />
                Clear due date
              </button>
            </div>
          )}
        </>
      )}
    />
  );
});

/** Ruling 131: what the task waits on, each entry with its live state. */
const WaitRow = memo(function WaitRow({
  taskKey,
  blockedBy,
  ...control
}: { taskKey: string; blockedBy: DependencyRender[] } & RowControl) {
  const fetcher = usePropFetcher();
  const edit = editState("deps", control);
  const busy = fetcher.state !== "idle";
  return (
    <PropRow
      prop="deps"
      label="Blocked by"
      edit={edit}
      busy={busy && !edit?.open}
      popup="form"
      rowData={{ "data-blocked-by": blockedBy.length }}
      value={
        blockedBy.length > 0 ? (
          blockedBy.map((e) => <WaitChip key={e.ref} entry={e} />)
        ) : edit ? (
          <Quiet icon="plus">Add dependency</Quiet>
        ) : (
          <Quiet>Nothing</Quiet>
        )
      }
      editor={(done) => (
        <WaitEditor taskKey={taskKey} blockedBy={blockedBy} fetcher={fetcher} done={done} />
      )}
    />
  );
});

/** The wait's own form (ruling 131): the FULL list, prefilled with the
 *  canonical refs rather than the display labels. */
function WaitEditor({
  taskKey,
  blockedBy,
  fetcher,
  done,
}: {
  taskKey: string;
  blockedBy: DependencyRender[];
  fetcher: Fetcher;
  done: () => void;
}) {
  const csrf = useCsrfToken();
  const [text, setText] = useState(() => blockedBy.map((e) => e.ref).join(", "));
  const busy = fetcher.state !== "idle";
  const sent = useSent(fetcher, done);
  // The example keys take this project's own prefix.
  const prefix = taskKey.replace(/-\d+$/, "");
  return (
    <fetcher.Form
      method="post"
      className="prop-form-body"
      data-dependency-form
      onSubmit={(e) => {
        if (busy) e.preventDefault();
        else sent();
      }}
    >
      <input type="hidden" name="intent" value="set-task-dependencies" />
      <input type="hidden" name="_csrf" value={csrf} />
      <label className="field">
        <span className="flabel">Waits on</span>
        <input
          className="mono"
          type="text"
          name="blockedBy"
          value={text}
          placeholder={`${prefix}-12, goal-1 link 3`}
          aria-label="What this task waits on"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="fine">
        Task keys and goal links in this project, comma-separated. Empty clears the wait and releases
        the task.
      </p>
      <SaveRow busy={busy} onCancel={done} />
    </fetcher.Form>
  );
}

/** One entry of the wait: its status ring, its label and, once it is not
 *  simply open, the word for where it stands. */
function WaitChip({ entry }: { entry: DependencyRender }) {
  return (
    <span
      className="label-chip wait-chip"
      data-wait-state={entry.state}
      title={`${entry.label} · ${entry.state}`}
    >
      <Icon name={WAIT_GLYPH[entry.state]} />
      {entry.label}
      {entry.state !== "open" ? ` · ${entry.state === "failed" ? "archived" : entry.state}` : ""}
    </span>
  );
}

/** Cancel and Save, for the two editors that collect a value first. */
function SaveRow({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="prop-acts">
      <button type="button" className="btn sm" onClick={onCancel}>
        Cancel
      </button>
      {/* Ruling 368: the save in flight shows itself here. */}
      <button type="submit" className="btn primary sm" disabled={busy} aria-busy={busy || undefined}>
        {busy && <Icon name="loader" className="spin" />}
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
