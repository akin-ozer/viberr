import { useId, useRef, useState } from "react";
import { type ProjectRole, roleCan } from "~/shared/rbac";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { holdEntriesSentence, holdRefusal, type DependencyRender } from "~/shared/dependencies";
import { AgentGlyph } from "~/ui/identity";
import { LocalDayDotTime } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { AgentSelect } from "./agent-select";
import {
  resolveDeclaredStages,
  stageEligible,
  stageIneligibilitySentence,
} from "~/shared/workflow/stage-eligibility";
import { stageName } from "~/shared/workflow/stage-roles";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  backendRunRefusal,
  type TaskRunPrincipalView,
} from "./run-principal-view";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * One engagement's LIVE run, as the task loader ships it: which profile, and
 * whether the run is waiting for a runtime slot or executing. Pass 35 U35-7:
 * the engaged-agent card used to see only the profile ids and said "running…"
 * over a run that was still queued (screenshot 65), so the lifecycle travels
 * with the id. A profile appears once per live run it holds.
 */
export interface LiveAgentRun {
  profileId: string;
  lifecycle: "queued" | "running";
}

/**
 * The card's word for an engagement's live run: "running…" when any of its
 * live runs executes, "queued" when every one is still waiting for a slot,
 * null with no live run.
 */
export function liveAgentRunLabel(
  liveAgentRuns: readonly LiveAgentRun[],
  profileId: string,
): "running…" | "queued" | null {
  const own = liveAgentRuns.filter((r) => r.profileId === profileId);
  if (own.length === 0) return null;
  return own.some((r) => r.lifecycle === "running") ? "running…" : "queued";
}

/** Client-safe view of a deployed specialist the run-agent selector offers
 * (mirrors the loader's DeployedSpecialistView — kept here to avoid a server
 * import). */
export interface DeployedSpecialistView {
  id: string;
  name: string;
  role: string;
  backend: "codex" | "claude";
  model: string;
  /** The provider's redacted refusal sentence when a real run showed this
   *  agent's model is not runnable on the account (F20-4). Present ⇒ the run
   *  control warns BEFORE a run is spent. */
  modelUnavailable?: string;
  /** The capability marks the selector rows and the ledger surface (UI-39):
   *  delivery = can own branch/PR delivery; verdict = its verdict gates
   *  acceptance once engaged; askHuman/browser inform the roster. */
  capabilities?: {
    delivery: boolean;
    verdict: boolean;
    askHuman: boolean;
    browser: boolean;
  };
  /** U36-10 (pass 36): stage scope, as the loader's view carries it. Absent in
   *  older fixtures = unknown, and the control pre-refuses nothing. */
  stages?: string[];
  spanAll?: boolean;
}

/**
 * Execution profile panel — dynamic-dispatch rework (2026-08-29).
 *
 * The static "Delivering agent" / "Reviewing agents" slot cells (assign menus,
 * engage menus, per-row Run buttons) are GONE. What replaced them:
 *
 *   - the OPERATOR cell keeps its R21-9 shape (shows the backend, optional
 *     steer, Run) and gains the baked-in schedule affordance;
 *   - a RUN AN AGENT cell — an @-mention-style autocomplete over the deployed
 *     roster + an optional prompt + the same run/schedule control. The
 *     dispatched run always reports back tagging the dispatching human and
 *     @operator (the completion contract), so the operator continues
 *     coordination from the results;
 *   - an ENGAGED AGENTS ledger — the honest record of who is attached
 *     (delivers / gates acceptance / running), read-only except releasing a
 *     supporting engagement;
 *   - the HUMAN OWNER cell, unchanged.
 *
 * Scheduling is INSIDE the two run controls ("no additional button" — owner
 * directive): a when-picker beside Run; a deferred pick turns the button into
 * "Schedule", and pending entries list under the control with cancel.
 */

export type OwnerAction = "take" | "assign" | "release";

/**
 * UX19-12 — an engagement whose profile is no longer deployed. The name is the
 * Agents live table's own wording, used verbatim so one state does not read two
 * ways on two surfaces; the note states the consequence R15-7 (ruling 26)
 * imposes on such a run.
 */
const GHOST_NAME = "profile no longer here";
/** Hunt 2026-08-29: one collapsed note told the DELIVERING row "Release it" —
 *  a control that row deliberately withholds (the deliverer owns the
 *  workspace/branch; the server refuses to release it). Per-posture recovery
 *  copy, like the two notes the pre-rework panel carried. */
const GHOST_SUPPORTING_NOTE =
  "Not deployed on this project any more. Release it, or re-deploy the profile on the Agents page.";
const GHOST_DELIVERING_NOTE =
  "Not deployed on this project any more. Re-deploy the profile on the Agents page, or hand delivery to another agent.";

export interface TaskMemberView {
  userId: string;
  role: string;
  user: { name: string; initials?: string | null; tone?: string | null };
}

function OwnerControl({
  task,
  myRole,
  busy,
  onOwner,
}: {
  task: TaskSummary;
  myRole: string | null;
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
}) {
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  // Q5 tiering (XS-12): only contributor+ may take ownership — a viewer is
  // read + comment only, so its take button would just 403. Gate the control
  // the same way the server does rather than render a button that fails.
  //
  // SAFETY: `myRole` is the project layout loader's own value (routes/project.tsx
  // — `project_members.role`, which 0001_baseline CHECK-constrains to exactly the
  // four project roles, or "admin" for the org-admin override, or null); the prop
  // chain down to here is what widens it to `string`. `roleCan` denies any value
  // outside the four regardless, so the widening can only ever under-grant.
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");

  if (!o) {
    // Only contributor+ may take ownership (Q5) — hide from viewers/non-members.
    // F19-11: the eligibility sentence lives in the cell's VALUE, stated once
    // for every role — this control renders the affordance or nothing.
    // D32-16: an archived task's owner seat is frozen (setOwner refuses), so
    // the control is withheld like every other runtime action on it. E32-9:
    // a CLOSED task's seat is frozen the same way.
    const closed =
      task.displayReadiness === "accepted" ||
      task.displayReadiness === "merged" ||
      task.archived;
    // Ruling 118: an admin may still reassign a CLOSED (not archived) seat for
    // the record — the same tier that releases any owner.
    // SAFETY: same invariant as `canOwn` above — `myRole` is the layout loader's
    // own project role (or "admin"/null), widened to `string` by the prop chain;
    // `roleCan` denies any other value, so the widening can only under-grant.
    const adminSeat =
      !task.archived && roleCan(myRole as ProjectRole | null, "release-any-ownership");
    return canOwn && (!closed || adminSeat) ? (
      <button
        type="button"
        className="rev-add"
        disabled={busy}
        onClick={() => onOwner("take")}
        title="Take ownership: review & acceptance, this task only"
      >
        <Icon name="plus" />
        Assign me
      </button>
    ) : null;
  }

  // OWNED: the cell shows the owner chip alone (owner request 2026-08-21) —
  // release stays one panel away on the Current-state Owner row.
  return null;
}

/** The when-picker baked into both run controls: run now, or schedule. */
const RUN_DELAYS = [
  { value: "now", label: "Now" },
  { value: "5", label: "in 5 min" },
  { value: "60", label: "in 1 hour" },
  { value: "360", label: "in 6 hours" },
  { value: "1440", label: "in 24 hours" },
] as const;
export type RunDelay = (typeof RUN_DELAYS)[number]["value"];

function DelayPicker({
  value,
  disabled,
  label,
  onChange,
}: {
  value: RunDelay;
  disabled: boolean;
  /** Accessible name — the two controls need distinct ones. */
  label: string;
  onChange: (value: RunDelay) => void;
}) {
  return (
    <select
      className="run-when"
      aria-label={label}
      value={value}
      disabled={disabled}
      // SAFETY: the select's options are rendered from RUN_DELAYS alone, so
      // the DOM can only hand back one of its values.
      onChange={(e) => onChange(e.target.value as RunDelay)}
    >
      {RUN_DELAYS.map((d) => (
        <option key={d.value} value={d.value}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

/** Minutes a non-"now" delay stands for (the schedule intent's payload). */
export function delayMinutes(delay: RunDelay): number | null {
  return delay === "now" ? null : Number(delay);
}

/**
 * Pending scheduled runs for ONE control, listed under it (D6: cancelling a
 * queued run — possibly one another member scheduled — confirms first,
 * naming when it was due).
 */
function PendingSchedules({
  schedules,
  agentNameOf,
  canCancel,
  busy,
  moot = false,
  onCancel,
}: {
  schedules: TaskSchedule[];
  /** Resolves a run-agent entry's display name (null → operator entry). */
  agentNameOf: (profileId: string) => string | undefined;
  canCancel: boolean;
  busy: boolean;
  /** Ruling 177: the task is CLOSED, so every entry here will be skipped when
   *  it comes due (`skipped-done` / `skipped-archived`) — never run. Live
   *  (2026-09-12, HLC-19) the controller read two pending entries on a shipped
   *  task and could not tell from the page whether they would fire; the
   *  control beside them already said "Task closed". */
  moot?: boolean;
  onCancel: (scheduleId: string) => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState<TaskSchedule | null>(null);
  if (schedules.length === 0) return null;
  return (
    <>
      {moot && (
        <span className="sub" data-sched-moot>
          {schedules.length === 1 ? "This scheduled run" : "These scheduled runs"} will be
          skipped, not run: the task is closed. Reopen it, or cancel{" "}
          {schedules.length === 1 ? "it" : "them"}.
        </span>
      )}
      <ul className="sched-list">
        {schedules.map((s) => (
        <li key={s.id} className="sched-row">
          <div className="sched-when">
            <Icon name="clock" />
            <span>
              <LocalDayDotTime iso={s.dueAt} />
            </span>
          </div>
          <div className="sched-meta">
            {/* R22: no fixed backend/autonomy — the run resolves the deployed
                profile when it fires. */}
            {s.action === "run-agent"
              ? `${s.profileId ? (agentNameOf(s.profileId) ?? s.profileId) : "agent"} run`
              : "operator re-run"}
            {s.prompt ? ` · ${s.prompt}` : ""}
            {s.createdByLabel ? ` · by ${s.createdByLabel}` : ""}
          </div>
          {canCancel ? (
            /* Ruling 149: cancelling a pending run takes the run away, so the
               trigger wears the danger label its confirm already commits with
               (`.btn.ghost.danger` — red label, neutral face). The wording
               stays "Cancel" so it does not collide with the dialog's own
               "Cancel run". */
            <button
              type="button"
              className="btn ghost sched-cancel danger"
              disabled={busy}
              onClick={() => setConfirmCancel(s)}
            >
              Cancel
            </button>
          ) : null}
        </li>
        ))}
      </ul>
      {confirmCancel && (
        <ConfirmDialog
          screenLabel="Schedule cancel dialog"
          title="Cancel this scheduled run?"
          body={
            <>
              The scheduled run due{" "}
              <strong>
                <LocalDayDotTime iso={confirmCancel.dueAt} />
              </strong>
              {confirmCancel.createdByLabel
                ? ` (scheduled by ${confirmCancel.createdByLabel})`
                : ""}{" "}
              will not fire.
            </>
          }
          confirmLabel="Cancel run"
          cancelLabel="Keep it"
          busy={busy}
          onCancel={() => setConfirmCancel(null)}
          onConfirm={() => {
            onCancel(confirmCancel.id);
            setConfirmCancel(null);
          }}
        />
      )}
    </>
  );
}

/** Single-line run-instruction input shared by both controls: Enter submits
 *  (the search/chat convention), IME-guarded — an Enter that merely confirms a
 *  multibyte candidate must not launch a billable run. `keyCode === 229`
 *  covers WebKit/Safari, which fires compositionend BEFORE the confirming
 *  keydown, so `isComposing` is already false. */
function PromptInput({
  value,
  ariaLabel,
  placeholder,
  disabled,
  maxLength,
  onChange,
  onSubmit,
}: {
  value: string;
  ariaLabel: string;
  placeholder: string;
  disabled: boolean;
  maxLength: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <input
      type="text"
      className="op-steer"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !e.nativeEvent.isComposing &&
          e.nativeEvent.keyCode !== 229
        ) {
          onSubmit();
        }
      }}
      disabled={disabled}
    />
  );
}

/**
 * Operator run control (R21-9): SHOWS the operator's current backend and runs
 * it — no per-run backend/autonomy pickers. An optional steer rides along as
 * the human's directive (recorded as an `@operator` comment). Scheduling is
 * baked in: pick a delay and the same button schedules instead of running
 * (R22: the fired run resolves the live deployed profile). Full autonomy
 * still announces itself (F20-9's mirror); supervised is the quiet default.
 */
/** Ruling 131(d): the run control's hold copy. */
function holdNoteFor(entries: readonly DependencyRender[]): string {
  // Ruling 356: a done entry reads as done, not as still waited on.
  return `Waiting on other work (${holdEntriesSentence(entries)}). A manual run still answers you; the operator will not advance the task or dispatch delivery while it waits.`;
}

function OperatorRunControl({
  busy,
  disabled,
  blockedReason,
  holdNote,
  defaultBackend,
  configuredAutonomy,
  acceptsDirectly = false,
  runRefusal,
  schedules,
  scheduleBusy,
  onRun,
  onCancelSchedule,
}: {
  busy: boolean;
  /** Task is closed (terminal stage) — controls render disabled (G9). */
  disabled?: boolean;
  /** F20-5 (R20-1): a non-structural reason the manual run is refused — an open
   *  decision packet pauses coordination. Rendered copy (a `title` never opens
   *  on a disabled control). */
  blockedReason?: string;
  /** Ruling 131(d): the task waits on other work. Rendered as `sub` copy with
   *  the button left ENABLED: a manual run still answers a person, but the
   *  operator will neither advance the task nor dispatch delivery while it
   *  waits. An open packet's `blockedReason` keeps precedence. */
  holdNote?: string;
  /** The operator profile's configured backend — displayed, not picked; the
   *  run resolves the live profile (P11-76 fall-through). */
  defaultBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy — what this run WILL
   *  use. Full announces itself below; supervised is the quiet default. */
  configuredAutonomy: "supervised" | "full";
  /** F37-65: whether `completion-for-acceptance` really resolves to `direct`.
   *  `gate()` holds it at `recommend` whatever the autonomy unless the grant
   *  says direct (owner ruling Q1), so autonomy alone cannot answer it. */
  acceptsDirectly?: boolean;
  /** P11-41, now per-person (ruling 127): why a run on the operator's backend
   *  would refuse, or null when it would start. An operator drive bills the
   *  task OWNER, so this sentence names them; it disables Run and renders,
   *  instead of the run failing fast after the click. */
  runRefusal: string | null;
  /** Pending run-operator schedules, listed under the control. */
  schedules: TaskSchedule[];
  scheduleBusy: boolean;
  onRun: (steer: string, delayMinutes: number | null) => void;
  onCancelSchedule: (scheduleId: string) => void;
}) {
  const [steer, setSteer] = useState("");
  const [delay, setDelay] = useState<RunDelay>("now");
  const backendLabel = BACKEND_LABEL[defaultBackend];
  // Hunt 2026-08-29: two different kinds of "off". `busy`/`disabled` (closed
  // task) kill the whole control; the open-packet refusal (F20-5) and a backend
  // the owner cannot run (P11-41, ruling 127) refuse a run NOW — but
  // scheduleTaskAction refuses neither (the packet resolves, the owner connects
  // the backend or the seat changes hands, and the fired run resolves the live
  // profile and the live owner anyway), so a picked delay keeps the button
  // alive as "Schedule" instead of blocking the one action that still works.
  const hardOff = busy || !!disabled;
  const runNowBlocked = !!blockedReason || !!runRefusal;
  const off = hardOff || (delay === "now" && runNowBlocked);
  const run = () => {
    if (off) return;
    onRun(steer.trim(), delayMinutes(delay));
    setSteer("");
    setDelay("now");
  };
  return (
    <span className="op-run">
      {/* The backend this run resolves to — the profile's, stated not picked. */}
      <span className="op-backend">{backendLabel}</span>
      <PromptInput
        value={steer}
        ariaLabel="Steer this operator run (optional)"
        placeholder="Optional: tell the operator what this run should focus on"
        disabled={hardOff}
        maxLength={2000}
        onChange={setSteer}
        onSubmit={run}
      />
      <DelayPicker
        value={delay}
        disabled={hardOff}
        label="When the operator run starts"
        onChange={setDelay}
      />
      {/* Pass 30: routine starters are SECONDARY — the page's one solid
          primary is the decision-stakes commit of the current state. */}
      <button
        type="button"
        className="btn sm"
        disabled={off}
        onClick={run}
        title={
          blockedReason ??
          (disabled
            ? "Task is closed (terminal stage). Reopen it to run the operator"
            : delay === "now"
              ? "Run the operator to coordinate this task"
              : "Schedule this operator run")
        }
      >
        <Icon name={delay === "now" ? "shield" : "clock"} />
        {busy ? "Running…" : delay === "now" ? "Run operator" : "Schedule"}
      </button>
      {runRefusal && (
        // P11-41's honesty without a picker: the run would fail fast, so say
        // it here, where the fix is one hop away. Ruling 127 changed WHOSE fix
        // it is — an operator drive bills the task owner's own account, so
        // there is no instance credential to configure and the sentence names
        // the person (`run-principal-view.ts`, the UI voice of the server's
        // `principalRefusalMessage`).
        <span className="sub">{runRefusal}</span>
      )}
      {configuredAutonomy === "full" && !disabled && (
        // F20-9's mirror, kept: full autonomy is the state that lets this run
        // transition stages — it must be visible on the surface that launches
        // it. Supervised needs no caption.
        //
        // F37-65: but it does NOT by itself let the run accept completion.
        // `gate()` holds `completion-for-acceptance` at `recommend` whatever
        // the autonomy unless the grant is explicitly `direct` (owner ruling
        // Q1). This caption claimed otherwise on every task of a board whose
        // operator is `full` + `recommend`, while every acceptance on it was a
        // person pressing the button.
        <span className="sub xs dim">
          {acceptsDirectly
            ? "Full autonomy: this run can move the task and accept completion itself."
            : "Full autonomy: this run can move the task. Accepting completion still needs a person, because the operator's acceptance grant is not direct."}
        </span>
      )}
      {/* P14 ruling: a `title` is unreachable on a DISABLED control, so the
          reason a control is dead has to be rendered copy. F20-5's open-packet
          reason wins over the closed copy. */}
      {blockedReason ? (
        <span className="sub">{blockedReason}</span>
      ) : disabled ? (
        // Ruling 177 (pass 36): every door refuses a closed task — the button,
        // an @operator comment, a schedule, an agent's completion. N20-17's
        // "mentioning @operator still runs it" disclosure described the F36-4
        // hole and is gone with it.
        <span className="sub">Task closed. Reopen it to run the operator.</span>
      ) : holdNote ? (
        <span className="sub" data-hold-note>{holdNote}</span>
      ) : null}
      <PendingSchedules
        schedules={schedules}
        agentNameOf={() => undefined}
        canCancel
        busy={scheduleBusy}
        moot={disabled}
        onCancel={onCancelSchedule}
      />
    </span>
  );
}

/**
 * The manual dispatch (owner directive 2026-08-29): pick ANY deployed agent
 * from the @-style autocomplete, optionally tell it what to do, and run it —
 * now or scheduled. Posture (delivering vs supporting) derives from the
 * agent's own capability grants server-side; the run's report always tags the
 * dispatching human and @operator, and its completion re-invokes the operator.
 */
function AgentRunControl({
  agents,
  taskKey,
  blockedBy,
  stage,
  stages,
  workflow,
  activeProfileIds,
  deliveringProfileId,
  engagedSupportingIds,
  runPrincipal,
  meId,
  busy,
  closed,
  schedules,
  scheduleBusy,
  onRun,
  onCancelSchedule,
}: {
  agents: DeployedSpecialistView[];
  /** Ruling 186 (pass 37): the task key and what it waits on, so a dispatch
   *  onto a HELD task is refused before the click with the server's own
   *  sentence — `holdRefusal` is shared and client-safe for exactly this. */
  taskKey: string;
  blockedBy: readonly DependencyRender[];
  /** U36-10 (pass 36): the task's stage and the board it sits on, so a
   *  stage-ineligible pick is refused BEFORE the click with the server's
   *  own sentence (ruling 133), and never promises a delivering posture. */
  stage: string;
  stages: { id: string; name: string }[];
  workflow: { from: string; to: string }[];
  activeProfileIds: string[];
  /** Ruling 127: whose accounts a dispatch would bill (null = unowned task).
   *  A profile pinned to a backend the owner has not connected is still
   *  pickable — the roster is not a lie — but Run refuses before it is spent
   *  and the row and the control both say why. */
  runPrincipal: TaskRunPrincipalView | null;
  /** The viewer, so the refusal is addressed to the owner in the second
   *  person when they are the one reading it. */
  meId: string;
  /** The current delivering engagement's profile id (null = none yet). */
  deliveringProfileId: string | null;
  /** Profiles already engaged as SUPPORTING — the dispatch keeps an existing
   *  engagement's shape, so the posture line must too (hunt 2026-08-29: a
   *  repo-write profile engaged supporting was promised delivery). */
  engagedSupportingIds: string[];
  busy: boolean;
  /** G9/P14-WL-07: the task is at the terminal stage (or archived). */
  closed: boolean;
  /** Pending run-agent schedules, listed under the control. */
  schedules: TaskSchedule[];
  scheduleBusy: boolean;
  onRun: (profileId: string, prompt: string, delayMinutes: number | null) => void;
  onCancelSchedule: (scheduleId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [delay, setDelay] = useState<RunDelay>("now");
  // Ruling 147: counted, not boolean — each refused start re-inserts the alert,
  // because readers announce an insertion, not a role flip on unchanged text.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const pickRef = useRef<HTMLInputElement>(null);
  const pickErrId = useId();
  // Any pick (or a pick cleared by typing) retires the accusation: the mark
  // belongs to a refused ATTEMPT, never to a form being filled in.
  const selectAgent = (profileId: string | null) => {
    setSelectedId(profileId);
    setRefused(0);
  };
  const agentNameOf = (profileId: string) =>
    agents.find((a) => a.id === profileId)?.name;

  // Hunt 2026-08-29: the early returns below used to swallow the pending
  // schedule rows too — and the deleted Scheduled-re-runs panel was the only
  // other surface that listed them, so an entry scheduled before the task
  // closed (or before the roster emptied) became invisible AND uncancellable
  // while the runner still counted it due. Whatever else the cell says, the
  // pending entries render.
  const pending = (
    <PendingSchedules
      schedules={schedules}
      agentNameOf={agentNameOf}
      canCancel
      busy={scheduleBusy}
      moot={closed}
      onCancel={onCancelSchedule}
    />
  );
  if (closed) {
    // P14-WL-07: a closed task must not offer to start runs.
    return (
      <span className="op-run agent-run">
        <span className="sub">Task closed. Reopen it to run an agent.</span>
        {pending}
      </span>
    );
  }
  if (agents.length === 0) {
    return (
      <span className="op-run agent-run">
        <span className="sub">
          No agents deployed. Deploy one on the Agents page first.
        </span>
        {pending}
      </span>
    );
  }

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const selectedRunning =
    !!selectedId && delay === "now" && activeProfileIds.includes(selectedId);
  // Ruling 127: the picked profile runs on ITS backend, billed to the task
  // owner — so the refusal is per-pick, not per-page. Same split the operator
  // control makes: a run NOW is refused, a SCHEDULED one is not (the owner can
  // connect the backend, or the seat can change hands, before it fires).
  // U36-10 (pass 36): eligibility is resolved here, from the same predicate
  // the dispatch gate applies, so the refusal a person would meet after the
  // click is the one they read before it.
  const ineligible =
    selected &&
    selected.stages !== undefined &&
    !stageEligible({ stages: selected.stages, spanAll: selected.spanAll ?? false }, stage, stages, workflow)
      ? stageIneligibilitySentence(
          selected.name,
          stageName(stages, stage),
          resolveDeclaredStages(selected.stages, stages, workflow)
            .map((id) => stageName(stages, id))
            .join(", "),
        )
      : null;
  // Ruling 186 (pass 37, F37-2): a held task refuses EVERY dispatch server-side,
  // so the control says so before the click. Unlike the per-pick refusals this
  // one does not depend on which agent is chosen — the hold is a fact about the
  // task — so it stands even with nothing picked.
  const held =
    blockedBy.length > 0
      ? // Rulings 355 and 356: the entries carry their states, so the sentence
        // names a dead one as dead and a done one as done.
        holdRefusal(taskKey, blockedBy, "running an agent on it")
      : null;
  const runRefusal = selected
    ? (held ?? ineligible ?? backendRunRefusal(runPrincipal, selected.backend, meId))
    : held;
  // Ruling 147(a): only AVAILABILITY disables the start — a run in flight, a
  // live run on this very profile, or the owner-credential refusal (ruling 127),
  // each of which renders its own reason. An empty pick is validation, so it is
  // refused on the click instead (147(b)); `selectedRunning` and `runRefusal`
  // are both false with nothing picked, so this collapses to `busy` there.
  // `held` rides `runRefusal`, which only bites for a run NOW: a hold can clear
  // on its own (Viberr releases it when the entries finish), so a SCHEDULED run
  // stays offerable exactly as it does for an unconnected backend. If the hold
  // still stands when it fires, `startAgentRun` refuses it there.
  const off = busy || selectedRunning || (delay === "now" && !!runRefusal) || !!ineligible;
  const pickRefused = refused > 0 && !selected;
  const run = () => {
    if (off) return;
    if (!selected) {
      // 147(b): the click is answered in words, the picker is marked and takes
      // focus. This is also the PromptInput's Enter path.
      setRefused((n) => n + 1);
      pickRef.current?.focus();
      return;
    }
    onRun(selected.id, prompt.trim(), delayMinutes(delay));
    setPrompt("");
    setDelay("now");
  };
  // What the dispatch will make of the pick — said BEFORE the run is spent.
  // An EXISTING engagement keeps its shape server-side, so it decides first
  // (hunt 2026-08-29); capability derivation covers only the unengaged case.
  const posture = !selected
    ? null
    : ineligible
      ? null
      : selected.id === deliveringProfileId
      ? "Runs as the delivering agent: it owns the branch and PR."
      : engagedSupportingIds.includes(selected.id)
        ? selected.capabilities?.verdict
          ? "Runs as a reviewer (already engaged): its verdict gates acceptance."
          : "Runs as a supporting agent (already engaged)."
        : selected.capabilities?.delivery === false
          ? selected.capabilities.verdict
            ? "Runs as a reviewer: its verdict gates acceptance."
            : "Runs as a supporting agent (no repo write)."
          : deliveringProfileId === null
            ? "Runs as the delivering agent: it owns the branch and PR."
            : "Runs as a supporting agent (another agent owns delivery).";

  return (
    <span className="op-run agent-run">
      <AgentSelect
        agents={agents}
        activeProfileIds={activeProfileIds}
        selectedId={selectedId}
        runPrincipal={runPrincipal}
        disabled={busy}
        invalid={pickRefused}
        describedBy={pickRefused ? pickErrId : undefined}
        inputRef={pickRef}
        onSelect={selectAgent}
      />
      <PromptInput
        value={prompt}
        ariaLabel="Tell the agent what this run should do (optional)"
        placeholder="Optional: tell it what this run should do"
        disabled={busy}
        maxLength={4000}
        onChange={setPrompt}
        onSubmit={run}
      />
      <DelayPicker
        value={delay}
        disabled={busy}
        label="When the agent run starts"
        onChange={setDelay}
      />
      <button
        type="button"
        className="btn sm"
        disabled={off}
        onClick={run}
        title={
          !selected
            ? "Choose an agent first"
            : selectedRunning
              ? "This agent already has a run in progress on this task"
              : delay === "now"
                ? runRefusal ?? `Run ${selected.name} on this task`
                : `Schedule a ${selected.name} run`
        }
      >
        <Icon name={delay === "now" ? "bolt" : "clock"} />
        {delay === "now" ? "Run" : "Schedule"}
      </button>
      {pickRefused && (
        // Ruling 147: the start stays ENABLED with nothing picked and answers
        // the click here. A new element per refusal (the key) so a second
        // attempt is announced again; it shares the `.sub` slot the refusal and
        // posture lines already use.
        <span
          key={"pick-refused-" + refused}
          id={pickErrId}
          className={"sub err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
        >
          Choose an agent first.
        </span>
      )}
      {runRefusal && (
        // P14: a `title` never opens on a disabled control, so the reason a
        // dispatch is dead is rendered copy. Ruling 127 makes it the OWNER's
        // refusal, named — the run would bill their account, not this
        // deployment's (which no longer has one).
        <span className="sub">{runRefusal}</span>
      )}
      {posture && <span className="sub">{posture}</span>}
      {selected?.modelUnavailable && (
        // F20-4: availability warning BEFORE a run is spent. Informs, does not
        // block (the mark may be stale; the human decides).
        <p className="deny-note">
          <Icon name="alert" />
          <span>
            <strong>
              {BACKEND_LABEL[selected.backend]} reported this
              model unavailable.
            </strong>{" "}
            Switch the profile&rsquo;s backend, or expect the run to fail.
            Provider said: {selected.modelUnavailable}
          </span>
        </p>
      )}
      {/* The dispatch-completion contract, disclosed where the run starts. */}
      <span className="sub xs dim">
        The run reports back tagging you and the operator, which then continues
        coordination.
      </span>
      {pending}
    </span>
  );
}

/**
 * The engagement LEDGER — who is attached to this task and in what capacity.
 * Read-only (runs start from the run-agent control; the operator manages its
 * own dispatches) except for releasing a supporting engagement, which is the
 * recovery for a stale or wrongly-summoned reviewer whose verdict would
 * otherwise gate acceptance forever.
 */
function EngagedAgents({
  task,
  deployedById,
  liveAgentRuns,
  canRunAgents,
  closed,
  releaseBusy,
  onRelease,
}: {
  task: TaskSummary;
  deployedById: Map<string, DeployedSpecialistView>;
  liveAgentRuns: readonly LiveAgentRun[];
  canRunAgents: boolean;
  /** F33-10: the panel's OWN closed fact (terminal stage or archived), passed
   *  down rather than re-derived — the ledger and the run controls must not be
   *  able to disagree about whether this task is closed. */
  closed: boolean;
  releaseBusy: boolean;
  onRelease: (profileId: string) => void;
}) {
  const sp = task.specialist;
  const rows = [
    ...(sp ? [{ agent: sp, delivers: true }] : []),
    ...task.reviewers.map((r) => ({ agent: r, delivers: false })),
  ];
  if (rows.length === 0) {
    return (
      <span className="sub">
        None yet. The operator picks who runs at each stage
        {canRunAgents ? ", or run one yourself above" : ""}.
      </span>
    );
  }
  return (
    <>
      {rows.map(({ agent, delivers }) => {
        const deployed = deployedById.get(agent.profileId);
        const ghost = !deployed;
        // Pass 35 U35-7: "queued" for a run still waiting for a slot,
        // "running…" only once it executes.
        const liveLabel = liveAgentRunLabel(liveAgentRuns, agent.profileId);
        // F28-P2: `modelUnavailable` describes the LIVE deployment's model.
        // When a retry PIN (F27-B1) runs this engagement on the OTHER backend,
        // the flag describes a model this run won't use — suppress it.
        const unavailable =
          deployed && deployed.backend === agent.backend
            ? deployed.modelUnavailable
            : undefined;
        return (
          <div className="rev-agent" key={agent.profileId}>
            <AgentGlyph backend={agent.backend} decorative />
            <span>
              <div className="nm">{deployed ? deployed.name : GHOST_NAME}</div>
              <div className="sub">
                {agent.role} · {BACKEND_LABEL[agent.backend]}
                {delivers ? " · delivers" : ""}
                {/* UC-13/F21-6: "gates acceptance" is a claim about verdict
                    authority — mark it only where it is true. */}
                {!delivers && deployed?.capabilities?.verdict
                  ? " · gates acceptance"
                  : ""}
                {liveLabel ? ` · ${liveLabel}` : ""}
              </div>
              {/* UX19-12: the row that holds the engagement names the state —
                  and its RECOVERY must be one the row actually offers. */}
              {ghost && (
                <div className="sub">
                  {delivers ? GHOST_DELIVERING_NOTE : GHOST_SUPPORTING_NOTE}
                </div>
              )}
              {unavailable && (
                <p className="deny-note">
                  <Icon name="alert" />
                  <span>
                    <strong>
                      {BACKEND_LABEL[agent.backend]} reported
                      this model unavailable.
                    </strong>{" "}
                    Provider said: {unavailable}
                  </span>
                </p>
              )}
            </span>
            {/* F33-10: a closed task's engagements are frozen — the server
                refuses the release at the terminal stage, and every other
                runtime control on this panel is already off. The ✕ was the one
                exception: enabled, titled "Release this agent from the task",
                and refused on click. Ruling 37's precedent settles which way to
                fix it — a WITHDRAWN affordance is honest, a disabled one just
                invites the support question — so the button is simply not
                rendered. The panel head's "task closed" pill and the run cell's
                "Task closed. Reopen it to run an agent." already carry the
                reason; a third copy of it on every row would be noise. */}
            {canRunAgents && !delivers && !closed && (
              <span className="right">
                <button
                  type="button"
                  className="rev-x"
                  disabled={releaseBusy}
                  aria-label={`Release ${agent.role} agent`}
                  title="Release this agent from the task"
                  onClick={() => onRelease(agent.profileId)}
                >
                  <Icon name="x" />
                </button>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

export function ExecutionProfile({
  task,
  meId,
  myRole,
  busy,
  onOwner,
  deployedSpecialists,
  stages,
  workflow,
  operatorBackend,
  operatorAutonomy,
  acceptsDirectly = false,
  runPrincipal,
  canRunAgents,
  liveAgentRuns,
  runBusy,
  onRunAgent,
  releaseBusy,
  onReleaseAgent,
  operatorBusy,
  onRunOperator,
  operatorRunActive,
  schedules,
  scheduleBusy,
  onCancelSchedule,
}: {
  task: TaskSummary;
  meId: string;
  myRole: string | null;
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  /** Deployed specialists the run-agent selector offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** U36-10 (pass 36): the board the task sits on, for pre-click eligibility. */
  stages: { id: string; name: string }[];
  workflow: { from: string; to: string }[];
  /** The operator's configured backend — displayed, not picked (P11-76). */
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** F37-65: threaded down to the caption, which must not infer acceptance
   *  authority from autonomy alone. */
  acceptsDirectly?: boolean;
  /** Ruling 127: whose accounts this task's runs bill, and what those accounts
   *  can run. `null` = no owner (or a seat pointing at a disabled/deleted
   *  account), so nothing can run here at all. P11-41's fail-fast honesty, now
   *  answered per person instead of per deployment. */
  runPrincipal: TaskRunPrincipalView | null;
  /** admin|maintainer — gates the run/schedule affordances (server re-checks). */
  canRunAgents: boolean;
  /** The engagements' live (queued/running) runs, one entry per run. */
  liveAgentRuns: LiveAgentRun[];
  /** A LIVE operator run (queued/running) exists — the only state honest
   * enough for the "operator active" pill (F7-UI1: attachment ≠ activity). */
  operatorRunActive: boolean;
  /** The run-agent fetcher is in flight. */
  runBusy: boolean;
  onRunAgent: (
    profileId: string,
    prompt: string,
    delayMinutes: number | null,
  ) => void;
  /** The release-agent fetcher is in flight. */
  releaseBusy: boolean;
  onReleaseAgent: (profileId: string) => void;
  /** The operator-run fetcher is in flight. */
  operatorBusy: boolean;
  /** Run (or schedule) the operator; the optional steer becomes the run's
   *  human directive. */
  onRunOperator: (steer: string, delayMinutes: number | null) => void;
  /** PENDING scheduled runs on this task (both kinds; split per control). */
  schedules: TaskSchedule[];
  /** The cancel-schedule fetcher is in flight. */
  scheduleBusy: boolean;
  onCancelSchedule: (scheduleId: string) => void;
}) {
  const deployedById = new Map(deployedSpecialists.map((s) => [s.id, s]));
  // The run control gates on "has a live run at all" (F10-04); queued or
  // running makes no difference to a duplicate Now-run refusal.
  const activeAgentProfileIds = liveAgentRuns.map((r) => r.profileId);
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  const mine = !!(o && o.userId === meId);
  // G9: a task at the terminal (Done) stage is closed — its runtime action
  // controls are disabled so a closed task doesn't advertise live controls.
  // F15-11: an ARCHIVED task is out of the flow too.
  const closed =
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged" ||
    task.archived;
  // F20-5 (R20-1): the server refuses a MANUAL operator run while a decision
  // packet is open — coordination is paused by the packet, so a run would burn
  // several turns and take no action.
  const packetOpen = !!task.packet;
  const operatorSchedules = schedules.filter((s) => s.action !== "run-agent");
  const agentSchedules = schedules.filter((s) => s.action === "run-agent");
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Execution profile</h2>
        {(closed || operatorRunActive) && (
          <span className="right">
            {closed && (
              <Pill kind="done" sm>
                task closed
              </Pill>
            )}
            {/* F7-UI1: "operator active" means a LIVE operator run, not mere
                attachment — an attached-but-idle operator shows nothing. */}
            {operatorRunActive && (
              <Pill kind="agent" dot>
                operator active
              </Pill>
            )}
          </span>
        )}
      </div>
      <div className="profile-grid">
        <div className="profile-cell">
          <div className="lbl">Operator</div>
          <div className="val op-val">
            <div className="op-id">
              <span className="agent-glyph">
                <Icon name="shield" />
              </span>
              <span>
                {/* The cell's kicker already says OPERATOR — the value slot
                    promotes what the sub-line carried. */}
                <div className="nm">Coordinator</div>
                {task.operator && <div className="sub">{task.operator.sinceLabel}</div>}
                <div className="sub xs dim">
                  Decides which agent runs at each stage, from the stage the
                  task is at and the one it came from.
                </div>
              </span>
            </div>
            {canRunAgents && (
              <OperatorRunControl
                busy={operatorBusy}
                disabled={closed}
                {...(packetOpen && !closed
                  ? {
                      blockedReason:
                        "Open decision. Resolve it before running the operator.",
                    }
                  : {})}
                {...(!packetOpen && !closed && task.blockedBy.length > 0
                  ? { holdNote: holdNoteFor(task.blockedBy) }
                  : {})}
                defaultBackend={operatorBackend}
                configuredAutonomy={operatorAutonomy}
                acceptsDirectly={acceptsDirectly}
                runRefusal={backendRunRefusal(
                  runPrincipal,
                  operatorBackend,
                  meId,
                )}
                schedules={operatorSchedules}
                scheduleBusy={scheduleBusy}
                onRun={onRunOperator}
                onCancelSchedule={onCancelSchedule}
              />
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Run an agent</div>
          <div className="val op-val">
            {canRunAgents ? (
              <AgentRunControl
                agents={deployedSpecialists}
                taskKey={task.key}
                blockedBy={task.blockedBy}
                stage={task.stage}
                stages={stages}
                workflow={workflow}
                activeProfileIds={activeAgentProfileIds}
                deliveringProfileId={task.specialist?.profileId ?? null}
                engagedSupportingIds={task.reviewers.map((r) => r.profileId)}
                runPrincipal={runPrincipal}
                meId={meId}
                busy={runBusy}
                closed={closed}
                schedules={agentSchedules}
                scheduleBusy={scheduleBusy}
                onRun={onRunAgent}
                onCancelSchedule={onCancelSchedule}
              />
            ) : (
              <span className="sub">
                The operator dispatches agents as the task moves. Running one
                by hand needs the run-agents tier.
              </span>
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Engaged agents</div>
          <div className="val revs">
            <EngagedAgents
              task={task}
              deployedById={deployedById}
              liveAgentRuns={liveAgentRuns}
              canRunAgents={canRunAgents}
              closed={closed}
              releaseBusy={releaseBusy}
              onRelease={onReleaseAgent}
            />
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Human owner · reviews &amp; accepts</div>
          <div className="val">
            <div className="rev-row">
              {o && (
                <span className="rev-chip">
                  <Avatar person={o} />
                  <span className="nm">
                    {o.name}
                    {mine ? " · you" : ""}
                  </span>
                </span>
              )}
              {/* F19-11: name the real tier — `own-task` is contributor+. */}
              {!o && (
                <span className="sub">
                  Unowned. Any contributor or above can take it
                </span>
              )}
              <OwnerControl
                task={task}
                myRole={myRole}
                busy={busy}
                onOwner={onOwner}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
