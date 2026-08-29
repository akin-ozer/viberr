import { useState } from "react";
import { type ProjectRole, roleCan } from "~/shared/rbac";
import type { TaskSummary } from "~/shared/mapping/task.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { LocalDayDotTime } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { AgentSelect } from "./agent-select";

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
const GHOST_NOTE =
  "Not deployed on this project any more. Release it, or re-deploy the profile on the Agents page.";

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
    return canOwn ? (
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
  onCancel,
}: {
  schedules: TaskSchedule[];
  /** Resolves a run-agent entry's display name (null → operator entry). */
  agentNameOf: (profileId: string) => string | undefined;
  canCancel: boolean;
  busy: boolean;
  onCancel: (scheduleId: string) => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState<TaskSchedule | null>(null);
  if (schedules.length === 0) return null;
  return (
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
            <button
              type="button"
              className="btn ghost sched-cancel"
              disabled={busy}
              onClick={() => setConfirmCancel(s)}
            >
              Cancel
            </button>
          ) : null}
        </li>
      ))}
      {confirmCancel && (
        <ConfirmDialog
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
    </ul>
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
function OperatorRunControl({
  busy,
  disabled,
  blockedReason,
  defaultBackend,
  configuredAutonomy,
  backendAvailable,
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
  /** The operator profile's configured backend — displayed, not picked; the
   *  run resolves the live profile (P11-76 fall-through). */
  defaultBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy — what this run WILL
   *  use. Full announces itself below; supervised is the quiet default. */
  configuredAutonomy: "supervised" | "full";
  /** Which backends are configured (P11-41) — an unconfigured operator backend
   *  disables Run and says so, instead of failing fast after the click. */
  backendAvailable: { claude: boolean; codex: boolean };
  /** Pending run-operator schedules, listed under the control. */
  schedules: TaskSchedule[];
  scheduleBusy: boolean;
  onRun: (steer: string, delayMinutes: number | null) => void;
  onCancelSchedule: (scheduleId: string) => void;
}) {
  const [steer, setSteer] = useState("");
  const [delay, setDelay] = useState<RunDelay>("now");
  const backendLabel = defaultBackend === "claude" ? "Claude" : "Codex";
  const backendMissing = !backendAvailable[defaultBackend];
  // F20-5: an open decision packet is refused server-side just like a closed
  // task is, so it joins `disabled` in switching the control off.
  const off = busy || !!disabled || !!blockedReason || backendMissing;
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
        disabled={off}
        maxLength={2000}
        onChange={setSteer}
        onSubmit={run}
      />
      <DelayPicker
        value={delay}
        disabled={off}
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
      {backendMissing && (
        // P11-41's honesty without a picker: the profile's backend is not
        // configured on this instance, so the run would fail fast — say it
        // here, where the fix (the operator profile, or instance credentials)
        // is one hop away.
        <span className="sub">
          {backendLabel} isn&rsquo;t configured on this instance, so the
          operator can&rsquo;t run. Configure it, or switch the operator
          profile&rsquo;s backend.
        </span>
      )}
      {configuredAutonomy === "full" && !disabled && (
        // F20-9's mirror, kept: full autonomy is the state that lets this run
        // transition stages and accept completion itself — it must be visible
        // on the surface that launches it. Supervised needs no caption.
        <span className="sub xs dim">
          Full autonomy: this run can move the task and accept completion
          itself.
        </span>
      )}
      {/* P14 ruling: a `title` is unreachable on a DISABLED control, so the
          reason a control is dead has to be rendered copy. F20-5's open-packet
          reason wins over the closed copy. */}
      {blockedReason ? (
        <span className="sub">{blockedReason}</span>
      ) : disabled ? (
        // N20-17: the explicit Run-operator button is off on a closed task, but
        // an @operator comment still starts a full operator run — say so, or
        // the two run paths read as silently inconsistent.
        <span className="sub">
          Task closed. Reopen it to run the operator. Mentioning{" "}
          <code>@operator</code> in a comment still runs it.
        </span>
      ) : null}
      <PendingSchedules
        schedules={schedules}
        agentNameOf={() => undefined}
        canCancel
        busy={scheduleBusy}
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
  activeProfileIds,
  deliveringProfileId,
  busy,
  closed,
  schedules,
  scheduleBusy,
  onRun,
  onCancelSchedule,
}: {
  agents: DeployedSpecialistView[];
  activeProfileIds: string[];
  /** The current delivering engagement's profile id (null = none yet). */
  deliveringProfileId: string | null;
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
  const agentNameOf = (profileId: string) =>
    agents.find((a) => a.id === profileId)?.name;

  if (closed) {
    // P14-WL-07: a closed task must not offer to start runs.
    return <span className="sub">Task closed. Reopen it to run an agent.</span>;
  }
  if (agents.length === 0) {
    return (
      <span className="sub">
        No agents deployed. Deploy one on the Agents page first.
      </span>
    );
  }

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const selectedRunning =
    !!selectedId && delay === "now" && activeProfileIds.includes(selectedId);
  const off = busy || !selected || selectedRunning;
  const run = () => {
    if (off || !selected) return;
    onRun(selected.id, prompt.trim(), delayMinutes(delay));
    setPrompt("");
    setDelay("now");
  };
  // What the dispatch will make of the pick — said BEFORE the run is spent.
  const posture = !selected
    ? null
    : selected.capabilities?.delivery === false
      ? selected.capabilities.verdict
        ? "Runs as a reviewer — its verdict gates acceptance."
        : "Runs as a supporting agent (no repo write)."
      : deliveringProfileId === null || deliveringProfileId === selected.id
        ? "Runs as the delivering agent — it owns the branch and PR."
        : "Runs as a supporting agent — another agent owns delivery.";

  return (
    <span className="op-run agent-run">
      <AgentSelect
        agents={agents}
        activeProfileIds={activeProfileIds}
        selectedId={selectedId}
        disabled={busy}
        onSelect={setSelectedId}
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
                ? `Run ${selected.name} on this task`
                : `Schedule a ${selected.name} run`
        }
      >
        <Icon name={delay === "now" ? "bolt" : "clock"} />
        {delay === "now" ? "Run" : "Schedule"}
      </button>
      {posture && <span className="sub">{posture}</span>}
      {selected?.modelUnavailable && (
        // F20-4: availability warning BEFORE a run is spent. Informs, does not
        // block (the mark may be stale; the human decides).
        <p className="deny-note">
          <Icon name="alert" />
          <span>
            <strong>
              {selected.backend === "claude" ? "Claude" : "Codex"} reported this
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
      <PendingSchedules
        schedules={schedules}
        agentNameOf={agentNameOf}
        canCancel
        busy={scheduleBusy}
        onCancel={onCancelSchedule}
      />
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
  activeProfileIds,
  canRunAgents,
  releaseBusy,
  onRelease,
}: {
  task: TaskSummary;
  deployedById: Map<string, DeployedSpecialistView>;
  activeProfileIds: string[];
  canRunAgents: boolean;
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
        const running = activeProfileIds.includes(agent.profileId);
        // F28-P2: `modelUnavailable` describes the LIVE deployment's model.
        // When a retry PIN (F27-B1) runs this engagement on the OTHER backend,
        // the flag describes a model this run won't use — suppress it.
        const unavailable =
          deployed && deployed.backend === agent.backend
            ? deployed.modelUnavailable
            : undefined;
        return (
          <div className="rev-agent" key={agent.profileId}>
            <AgentGlyph backend={agent.backend} />
            <span>
              <div className="nm">{deployed ? deployed.name : GHOST_NAME}</div>
              <div className="sub">
                {agent.role} · {agent.backend === "claude" ? "Claude" : "Codex"}
                {delivers ? " · delivers" : ""}
                {/* UC-13/F21-6: "gates acceptance" is a claim about verdict
                    authority — mark it only where it is true. */}
                {!delivers && deployed?.capabilities?.verdict
                  ? " · gates acceptance"
                  : ""}
                {running ? " · running…" : ""}
              </div>
              {/* UX19-12: the row that holds the engagement names the state. */}
              {ghost && <div className="sub">{GHOST_NOTE}</div>}
              {unavailable && (
                <p className="deny-note">
                  <Icon name="alert" />
                  <span>
                    <strong>
                      {agent.backend === "claude" ? "Claude" : "Codex"} reported
                      this model unavailable.
                    </strong>{" "}
                    Provider said: {unavailable}
                  </span>
                </p>
              )}
            </span>
            {canRunAgents && !delivers && (
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
  operatorBackend,
  operatorAutonomy,
  backendAvailable,
  canRunAgents,
  activeAgentProfileIds,
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
  /** The operator's configured backend — displayed, not picked (P11-76). */
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** Which backends are configured — unavailable ones are disabled (P11-41). */
  backendAvailable: { claude: boolean; codex: boolean };
  /** admin|maintainer — gates the run/schedule affordances (server re-checks). */
  canRunAgents: boolean;
  /** Profile ids of engagements with a live (queued/running) run. */
  activeAgentProfileIds: string[];
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
                defaultBackend={operatorBackend}
                configuredAutonomy={operatorAutonomy}
                backendAvailable={backendAvailable}
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
                activeProfileIds={activeAgentProfileIds}
                deliveringProfileId={task.specialist?.profileId ?? null}
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
              activeProfileIds={activeAgentProfileIds}
              canRunAgents={canRunAgents}
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
