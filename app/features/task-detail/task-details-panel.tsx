import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useFetcher, type FetcherWithComponents } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { PRIORITY_VALUES, type TaskPriority } from "~/schemas/task-file.schema";
import {
  isDeadDependencyState,
  joinDependencyEntries,
  type DependencyRender,
} from "~/shared/dependencies";
import { EPIC_STATUS_LABEL, isEpicOpen } from "~/shared/task-refs";
import { epicHref } from "~/shared/epic-href";
import { Calendar } from "~/ui/calendar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { EpicChip, type EpicOption } from "~/ui/epic-chip";
import { Icon, type IconName } from "~/ui/icon";
import { LabelInput } from "~/ui/label-input";
import { DueDatePill, LabelChips, PriorityFlag } from "~/ui/task-meta";
import { useDismiss } from "~/ui/use-dismiss";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useStableValue } from "~/ui/use-stable-rows";
import type { DependencyCandidatesView } from "~/routes/task-dependency-candidates";
import { useActionFeedback, type ActionResult } from "./task-detail-hooks";
import { WaitChip } from "./wait-chip";

/**
 * Ruling 501: the task's Details panel (priority, labels, epic, due date and
 * what the task waits on), drawn the way Linear's and GitHub's issue sidebars draw
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

type DetailProp = "priority" | "labels" | "epic" | "due" | "deps";

/** The menu reads most urgent first, the way the flags escalate. */
const PRIORITY_MENU = [...PRIORITY_VALUES].reverse();
const priorityName = (p: TaskPriority) => p.charAt(0).toUpperCase() + p.slice(1);

type Fetcher = FetcherWithComponents<ActionResult>;

export function TaskDetailsPanel({
  task,
  canEdit,
  labelSuggestions = [],
  epics = [],
  queuedQuestions = [],
  dependencyCandidatesUrl = null,
}: {
  task: TaskDetail;
  canEdit: boolean;
  /** Labels already used in this project, offered as label autocomplete. */
  labelSuggestions?: string[];
  /** Ruling 503: the project's epics, for the Epic row's menu. */
  epics?: EpicOption[];
  /** Ruling 241: reviewer questions the hold refused, put when it lifts. They
   *  belong under the wait because they ARE what happens when it ends. */
  queuedQuestions?: { id: string; profileId: string; decidedByLabel: string }[];
  /** Ruling 548: the Blocked by picker's read, built by the route component.
   *  Null offers no list; a key typed in full still goes in. */
  dependencyCandidatesUrl?: string | null;
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
  const epicList = useStableValue(epics);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="sliders" />
        <h2>Details</h2>
      </div>
      <div className="kv props">
        <PriorityRow priority={task.priority} open={openState("priority")} setOpen={setOpen} />
        <LabelsRow labels={labels} suggestions={suggestions} open={openState("labels")} setOpen={setOpen} />
        <EpicRow
          projectSlug={task.projectSlug}
          epicId={task.epicId ?? null}
          epics={epicList}
          open={openState("epic")}
          setOpen={setOpen}
        />
        <DueRow due={task.dueDate ?? null} open={openState("due")} setOpen={setOpen} />
        <WaitRow
          taskKey={task.key}
          candidatesUrl={dependencyCandidatesUrl}
          blockedBy={blockedBy}
          open={openState("deps")}
          setOpen={setOpen}
        />
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
  onIntent,
  lead,
  triggerRef,
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
  /** The pointer or the focus reached the trigger: an editor in its own
   *  chunk starts fetching it (ruling 548). */
  onIntent?: () => void;
  /** Ruling 548: for an editor, what stands before the trigger rather than in
   *  it (the wait's chips, each with a remove cross, which a button cannot
   *  hold); the trigger is then the compact one after them. */
  lead?: ReactNode;
  /** The trigger, for a row that hands the focus back to it itself. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const labelId = useId();
  const valueId = useId();
  const ownRef = useRef<HTMLButtonElement>(null);
  const btnRef = triggerRef ?? ownRef;
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
            {lead}
            <button
              ref={btnRef}
              type="button"
              className={lead ? "prop-btn prop-add" : "prop-btn"}
              aria-haspopup={role}
              aria-expanded={open}
              aria-labelledby={`${labelId} ${valueId}`}
              // Ruling 368: the trigger that started a save shows it. It stays
              // focusable while it works (a disabled control drops the
              // keyboard's place) and ignores presses until the server answers.
              aria-busy={busy || undefined}
              onPointerEnter={onIntent}
              onFocus={onIntent}
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

/**
 * Ruling 503: the epic this task belongs to. The menu offers "No epic" and
 * every OPEN epic, with the current one kept even when it is closed, so the
 * person sees where the task stands before moving it. A pick posts the one
 * field (`set-task-epic`), and the server writes the move on the task's
 * timeline and on both epics' histories (`setTasksEpic`). A viewer reads the
 * chip, which opens the epic's page.
 */
const EpicRow = memo(function EpicRow({
  projectSlug,
  epicId,
  epics,
  ...control
}: { projectSlug: string; epicId: string | null; epics: EpicOption[] } & RowControl) {
  const csrf = useCsrfToken();
  const fetcher = usePropFetcher();
  const edit = editState("epic", control);
  const current = epicId ? (epics.find((e) => e.id === epicId) ?? null) : null;
  const offered = epics.filter((e) => isEpicOpen(e.status) || e.id === epicId);
  // A project with no open epic has nothing to offer, so the row reads as
  // text: a menu holding only "No epic" would be a control that does nothing.
  return (
    <PropRow
      prop="epic"
      label="Epic"
      edit={offered.length > 0 || current ? edit : null}
      busy={fetcher.state !== "idle"}
      popup="menu"
      value={
        current ? (
          edit ? (
            <EpicChip epic={current} inLabelledControl />
          ) : (
            <EpicChip epic={current} to={epicHref(projectSlug, current.id)} />
          )
        ) : epicId ? (
          // A stale id the project's epics no longer answer to.
          <Quiet>{epicId}</Quiet>
        ) : edit && offered.length > 0 ? (
          <Quiet icon="plus">Add to epic</Quiet>
        ) : (
          <Quiet>None</Quiet>
        )
      }
      editor={(done) => (
        <EpicMenu
          epics={offered}
          current={epicId}
          onPick={(next) => {
            done();
            if (next !== epicId) {
              void fetcher.submit(
                { intent: "set-task-epic", _csrf: csrf, epic: next ?? "" },
                { method: "post" },
              );
            }
          }}
        />
      )}
    />
  );
});

/** The epics as an ARIA menu, "No epic" first: roving arrows, Home and End,
 *  the current one checked. A closed epic is marked, so a pick into one is a
 *  choice the person saw. */
function EpicMenu({
  epics,
  current,
  onPick,
}: {
  epics: EpicOption[];
  current: string | null;
  onPick: (epicId: string | null) => void;
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
    <div className="prop-menu-list epic-menu" onKeyDown={onKeyDown}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        className="menu-item"
        onClick={() => onPick(null)}
      >
        <Icon name="x" />
        No epic
        {current === null && <Icon name="check" className="prop-check" />}
      </button>
      {epics.map((epic) => (
        <button
          key={epic.id}
          type="button"
          role="menuitemradio"
          aria-checked={epic.id === current}
          className="menu-item"
          data-epic={epic.id}
          onClick={() => onPick(epic.id)}
        >
          <span className="epic-dot" data-stage-color={epic.color} aria-hidden="true" />
          <span className="epic-menu-title">{epic.title}</span>
          {!isEpicOpen(epic.status) && (
            <span className="fine xs dim"> · {EPIC_STATUS_LABEL[epic.status]}</span>
          )}
          {epic.id === current && <Icon name="check" className="prop-check" />}
        </button>
      ))}
    </div>
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

let pickerModule: Promise<typeof import("./dependency-picker")> | null = null;
let loadedPicker: (typeof import("./dependency-picker"))["DependencyPicker"] | null = null;

/** Starts (once) fetching the wait editor's picker, its own chunk (ruling
 *  548). A failed fetch is forgotten, so the next intent retries. */
function loadPicker(): Promise<typeof import("./dependency-picker")> {
  if (!pickerModule) {
    const pending = import("./dependency-picker");
    pickerModule = pending;
    pending.then(
      (module) => {
        loadedPicker = module.DependencyPicker;
      },
      () => {
        pickerModule = null;
      },
    );
  }
  return pickerModule;
}

const preloadPicker = () => void loadPicker().catch(() => undefined);

/** A task key in running text, kept whole: Chromium breaks "VIB-153" after its
 *  hyphen (ruling 520's `.hold-ref`). */
const keyRef = (key: string) => <span className="hold-ref">{key}</span>;

/** What the picker is told where no read is wired (a bare render). */
const NO_TASK_LIST: DependencyCandidatesView = { ok: false, reason: "No task list is offered here." };

/** Ruling 131: what the task waits on, each entry with its live state.
 *  Ruling 548: for an editor each entry's chip carries the Owner row's remove
 *  cross, which saves the wait without it at once, and the trigger is the plus
 *  after the chips. A cross that leaves nothing still open is the release
 *  (ruling 131(e)), so that one asks first, as the Owner row's does. */
const WaitRow = memo(function WaitRow({
  taskKey,
  candidatesUrl,
  blockedBy,
  ...control
}: { taskKey: string; candidatesUrl: string | null; blockedBy: DependencyRender[] } & RowControl) {
  const csrf = useCsrfToken();
  const fetcher = usePropFetcher();
  const edit = editState("deps", control);
  const busy = fetcher.state !== "idle";
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The entry a cross is taking out while its save runs (until the server
  // answers), and the one whose cross is waiting on the release's confirm.
  const [removing, setRemoving] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<DependencyRender | null>(null);
  // The cross that had the focus leaves with its chip once the wait comes
  // back without it; the trigger takes the focus rather than the page. A
  // refused save keeps the chip, and the cross keeps the focus.
  const handoff = useRef<string | null>(null);
  useFetcherResult(fetcher, (result) => {
    setRemoving(null);
    if (!result.ok) handoff.current = null;
  });
  useEffect(() => {
    const gone = handoff.current;
    if (gone === null || blockedBy.some((e) => e.ref === gone)) return;
    handoff.current = null;
    if (document.activeElement === document.body) triggerRef.current?.focus({ preventScroll: true });
  }, [blockedBy]);
  const remove = (entry: DependencyRender) => {
    setRemoving(entry.ref);
    handoff.current = entry.ref;
    void fetcher.submit(
      {
        intent: "set-task-dependencies",
        _csrf: csrf,
        blockedBy: blockedBy
          .filter((e) => e.ref !== entry.ref)
          .map((e) => e.ref)
          .join(", "),
      },
      { method: "post" },
    );
  };
  const onRemove = (entry: DependencyRender) => {
    // One save at a time: a second cross would post a list without the
    // first's answer in it.
    if (busy) return;
    if (blockedBy.every((e) => e.ref === entry.ref || e.state === "done")) setReleasing(entry);
    else remove(entry);
  };
  const rest = releasing ? blockedBy.filter((e) => e.ref !== releasing.ref) : [];
  return (
    <>
      <PropRow
        prop="deps"
        label="Blocked by"
        // A cross's save holds the editor shut until it answers, so no draft
        // starts from the list it is changing.
        edit={edit && removing !== null ? { ...edit, toggle: () => undefined } : edit}
        busy={busy && !edit?.open && removing === null}
        popup="form"
        rowData={{ "data-blocked-by": blockedBy.length }}
        onIntent={preloadPicker}
        triggerRef={triggerRef}
        lead={
          edit && blockedBy.length > 0
            ? blockedBy.map((e) => (
                <WaitChip key={e.ref} entry={e} onRemove={() => onRemove(e)} removing={removing === e.ref} />
              ))
            : null
        }
        value={
          blockedBy.length > 0 ? (
            edit ? (
              <Quiet icon="plus">
                <span className="vh">Add dependency</span>
              </Quiet>
            ) : (
              blockedBy.map((e) => <WaitChip key={e.ref} entry={e} />)
            )
          ) : edit ? (
            <Quiet icon="plus">Add dependency</Quiet>
          ) : (
            <Quiet>Nothing</Quiet>
          )
        }
        editor={(done) => (
          <WaitEditor
            taskKey={taskKey}
            candidatesUrl={candidatesUrl}
            blockedBy={blockedBy}
            fetcher={fetcher}
            done={done}
          />
        )}
      />
      {releasing && (
        <ConfirmDialog
          title={`Release ${taskKey}?`}
          body={
            <>
              {rest.length === 0 ? (
                <>
                  {keyRef(releasing.label)} is the last task {keyRef(taskKey)} waits on.
                </>
              ) : (
                <>Everything else {keyRef(taskKey)} waits on is done.</>
              )}{" "}
              Taking {keyRef(releasing.label)} off releases {keyRef(taskKey)}: it can move again, and
              Viberr hands it to the operator.
            </>
          }
          confirmLabel={`Release ${taskKey}`}
          cancelLabel="Keep the wait"
          tone="primary"
          busy={busy}
          screenLabel="Release wait dialog"
          onCancel={() => setReleasing(null)}
          onConfirm={() => remove(releasing)}
        />
      )}
    </>
  );
});

/** The wait's own form (ruling 131): the FULL list, posted as its canonical
 *  refs. Ruling 548: its entries are chips with a remove cross and its field
 *  finds the project's tasks (`DependencyPicker`, loaded here as a chunk while
 *  the editor reads the tasks it offers); mounted each time the editor opens,
 *  so the draft and the tasks start from what the server holds now. */
function WaitEditor({
  taskKey,
  candidatesUrl,
  blockedBy,
  fetcher,
  done,
}: {
  taskKey: string;
  candidatesUrl: string | null;
  blockedBy: DependencyRender[];
  fetcher: Fetcher;
  done: () => void;
}) {
  const csrf = useCsrfToken();
  const [draft, setDraft] = useState(blockedBy);
  const busy = fetcher.state !== "idle";
  const sent = useSent(fetcher, done);
  const refs = draft.map((e) => e.ref);
  const read = useFetcher<DependencyCandidatesView>();
  const loadRead = read.load;
  useEffect(() => {
    if (candidatesUrl) void loadRead(candidatesUrl);
  }, [loadRead, candidatesUrl]);
  // The writer refuses the whole list while it holds an entry that can never
  // complete (ruling 355), so the editor says so before Save does.
  const dead = draft.filter((e) => isDeadDependencyState(e.state)).map((e) => e.label);
  const [Picker, setPicker] = useState(() => loadedPicker);
  const [chunkFailed, setChunkFailed] = useState(false);
  useEffect(() => {
    if (Picker) return;
    let live = true;
    loadPicker().then(
      (module) => {
        if (live) setPicker(() => module.DependencyPicker);
      },
      () => {
        if (live) setChunkFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [Picker]);
  return (
    <fetcher.Form
      method="post"
      className="prop-form-body"
      data-dependency-form
      onSubmit={(e) => {
        if (busy) e.preventDefault();
        else if (refs.join("\n") === blockedBy.map((e) => e.ref).join("\n")) {
          // Nothing changed: close without a request, or a toast.
          e.preventDefault();
          done();
        } else sent();
      }}
    >
      <input type="hidden" name="intent" value="set-task-dependencies" />
      <input type="hidden" name="_csrf" value={csrf} />
      <input type="hidden" name="blockedBy" value={refs.join(", ")} />
      <div className="dep-field">
        <span className="flabel">Waits on</span>
        {Picker ? (
          <Picker
            view={candidatesUrl ? read.data : NO_TASK_LIST}
            taskKey={taskKey}
            initial={blockedBy}
            value={draft}
            onChange={setDraft}
          />
        ) : chunkFailed ? (
          // Offline, or a deploy that retired the chunk: a browser may keep a
          // failed module load for the page's life, so only a reload is sure.
          <p className="form-err" role="alert">
            <Icon name="alert" />
            The task picker could not be loaded. Reload the page to try again.
          </p>
        ) : (
          <p className="fine">Loading…</p>
        )}
      </div>
      {dead.length > 0 && (
        <p className="deny-note">
          <Icon name="alert" />
          <span>
            {joinDependencyEntries(dead)} can never complete: take {dead.length === 1 ? "it" : "them"} out to save.
          </span>
        </p>
      )}
      <p className="fine">Tasks in this project. Empty clears the wait and releases the task.</p>
      <SaveRow busy={busy} onCancel={done} />
    </fetcher.Form>
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
