import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type {
  DiagnosticRecord,
  TaskDetail,
} from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import type { TaskLinks } from "~/shared/task-key-links";
import { epicHref } from "~/shared/epic-href";
import { useCsrfToken } from "~/ui/csrf-input";
import { EpicChip, type EpicChipView } from "~/ui/epic-chip";
import { Icon } from "~/ui/icon";
import { inFlightIntent } from "~/ui/in-flight";
import { Pill, ReadinessPill, ValidationPill, validationQuiet } from "~/ui/pill";
import { Markdown } from "~/ui/markdown";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type LiveAgentRun,
  type OwnerAction,
  type RunInFlight,
  type TaskMemberView,
} from "./execution-profile";
import type { TaskRunPrincipalView } from "./run-principal-view";
import type { ActionResult } from "./task-detail-hooks";
import { useActionToast } from "~/ui/use-action-toast";
import { useRefusalShake } from "~/ui/use-refusal-shake";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/**
 * The task-detail MAIN column sections, in their contracted order (spec §2):
 * hero → diagnostics → recommendations → execution profile (scheduling lives
 * INSIDE the execution profile's run controls since the dynamic-dispatch
 * rework, 2026-08-29 — no separate scheduled-actions panel). (The live-run strip, decision packet, agent logs and timeline are
 * their own modules already.) Split out of `task-detail-page.tsx` (pass 16,
 * pure structural refactor — no behaviour or copy change).
 *
 * RECOMMENDATIONS ARE DELIBERATELY NOT HERE. This module used to export a
 * `RecommendationsSection` that owned its own fetcher and submitted
 * `apply-recommendation` straight from the card. F19-3 (live-proven: one Apply
 * click merged an unreviewed head into main) moved the apply path up into
 * `task-detail-page.tsx`, because the click has to reach the page's confirm
 * state — a section that owns its own fetcher structurally CANNOT ask first.
 * The page owns the fetcher (`useRecommendationActions`, ruling 689(d)) and
 * the ceremony, and routes Apply through `AcceptConfirm` (mode
 * `apply-recommendation`); `TaskMainColumn` renders `OperatorRecommendations`
 * with the page's handlers and owns nothing. Do not re-add a local wrapper
 * here: the ceremony lives at the page, and a wrapper is how it gets skipped.
 */

/** Parse/inconsistency findings from the projection (tolerant-parsing
 * contract) — compact list, only when the projection carries any. The full
 * diagnostics console arrives in Phase 10.
 *
 * G2: each finding's pill is its READINESS EFFECT (the same `ReadinessPill`
 * the hero shows), computed server-side from the canonical policy — NOT the
 * raw `severity` word painted with an ad-hoc color. That kept a soft `error`
 * crimson ("blocked") while the hero showed amber "inconsistency risk" for the
 * same finding, and ignored `hardStop` entirely. A finding with no readiness
 * effect (info) is a neutral "heads-up". */
export function DiagnosticsPanel({ diagnostics }: { diagnostics: DiagnosticRecord[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="alert" />
        <h2>Diagnostics</h2>
        <span className="right">
          <Pill kind="neutral" sm>
            {diagnostics.length} finding{diagnostics.length === 1 ? "" : "s"}
          </Pill>
        </span>
      </div>
      <div className="packet-obs flush">
        {diagnostics.map((d) => (
          <div className="obs" key={d.id}>
            <span className="k">
              {d.readinessEffect ? (
                <ReadinessPill value={d.readinessEffect} sm />
              ) : (
                <Pill kind="neutral" sm>
                  heads-up
                </Pill>
              )}
            </span>
            <span>
              <code className="mono">{d.code}</code> · {d.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Hero header — task key, title, stage/readiness/validation meta, goal. */
export function TaskHero({
  task,
  stage,
  canEditGoal,
  archived = false,
  editGoalSignal = 0,
  editGoalDraft = null,
  pendingGoalDraft = null,
  taskLinks,
  epic = null,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  canEditGoal: boolean;
  /** R14-3: archived tasks are off the board and out of the review queue —
   *  say so at the top, or the page reads like ordinary open work. */
  archived?: boolean;
  /** Increments when a packet's `edit_goal` decision is confirmed — opens the
   *  goal editor so the human can start typing immediately. */
  editGoalSignal?: number;
  /** F17-L3: the chosen scoping option's deliverable — the editor prefills with
   *  THIS (not the old vague goal) so the human doesn't retype what they picked.
   *  Null when the decision carried no draft (falls back to the current goal). */
  editGoalDraft?: string | null;
  /** F35-6: the goal a decided `edit_goal` packet asks for, the mapping's one
   *  `packet.goalDraft`. While it is pending the hero's own Edit opens with it
   *  (the decided card's "Edit the goal" opens the same text), so a person who
   *  reloads and takes the nearest door does not save the old goal back and
   *  read "Goal updated" over a packet that still waits. Null when no goal
   *  edit is pending (the editor opens with the current goal). */
  pendingGoalDraft?: string | null;
  /** U39-31: the other tasks the goal names, key to path. */
  taskLinks?: TaskLinks;
  /** Ruling 503: the epic the task belongs to, when it is in one. */
  epic?: EpicChipView | null;
}) {
  const goalFetcher = useFetcher<ActionResult>();
  const csrf = useCsrfToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.goal);
  // Ruling 147: Save goal stays enabled until the request starts, and a draft
  // under the floor is REFUSED here instead of leaving the button dead. The
  // counter (not a boolean) re-inserts the sentence on every refused attempt,
  // because readers announce an insertion, not a role flip on unchanged text.
  // It is reset wherever the editor opens or closes, so a re-opened editor is
  // pristine and never accused.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const goalErrId = "goal-err";
  const short = draft.trim().length < 3;
  const goalInvalid = refused > 0 && short;
  const goalBusy = goalFetcher.state !== "idle";
  // Surface a failed save as a toast instead of silently leaving the editor
  // open with no explanation (WI-11); on success the effect below closes it.
  useActionToast(goalFetcher);
  // Close the editor once a save round-trips successfully. Once per result
  // (`useFetcherResult`): `goalFetcher.data` persists after idle, so without
  // the dedupe the stale `ok` would instantly close every later re-open.
  useFetcherResult(goalFetcher, (d) => {
    if (!d.ok) return;
    setRefused(0);
    setEditing(false);
  });
  // A confirmed edit_goal packet decision drops the human straight into the
  // editor (the textarea's autoFocus scrolls it into view). Once-per-bump ref
  // (timeline `ask` pattern) so a later `canEditGoal` flip can't replay a
  // stale bump.
  const seenEditGoal = useRef(editGoalSignal);
  useEffect(() => {
    if (editGoalSignal > 0 && editGoalSignal !== seenEditGoal.current) {
      seenEditGoal.current = editGoalSignal;
      if (canEditGoal) {
        // UI-57: re-seed from the CURRENT goal. `draft` is seeded once at mount
        // and only the Edit button refreshed it, so a packet-opened editor could
        // save stale text over another user's edit.
        // F17-L3: a scoping decision prefills with the chosen option's
        // deliverable so the human edits from what they picked, not the old goal.
        setDraft(editGoalDraft ?? task.goal);
        setRefused(0);
        setEditing(true);
      }
    }
  }, [editGoalSignal, canEditGoal, task.goal, editGoalDraft]);

  // C2 (⇄ N20-14/UXO-1): the validation pill asserts a LIVE obligation
  // ("awaiting verdict"). UXO-1 withdrew it on archived tasks because abandoned
  // work owes nobody a verdict; the exact same is true of any TERMINAL task —
  // an accepted/merged completion owes nobody one either, and a force-accepted
  // one would otherwise read "accepted · awaiting verdict". Extend the archived
  // predicate to the same accepted/merged pair the rest of the app treats as
  // terminal (task-side-panels.tsx `isTerminal`, task-detail-derive.ts
  // `isClosedForWork`). The readiness pill stays for a terminal task: its value is
  // "accepted"/"merged", a terminal STATUS, not a live claim.
  const terminal =
    archived ||
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged";

  return (
    <div className="task-hero">
      <span className="key">{task.key}</span>
      <h1>{task.title}</h1>
      <div className="hero-meta">
        {archived && (
          <Pill kind="neutral">
            <Icon name="lock" />
            archived
          </Pill>
        )}
        {/* Ruling 169 (owner, 2026-09-09): the stage and the status are FIELDS,
            each under the key the Current state panel gives it. The default
            workflow's second stage is called Ready, so the bare stage pill read
            as a status word — "Ready · blocked · awaiting verdict" was read as
            three statuses that cannot be true at once ("what does ready
            mean?"). C5's status glyph on the readiness chip was not enough to
            tell the two classes apart; the label is. */}
        <span className="hero-field">
          <span className="hero-field-lbl">Stage</span>
          <Pill kind="neutral">
            <span
              className="col-stage-dot sm"
              data-stage-color={stage?.color}
            />
            {stage?.name ?? ""}
          </Pill>
        </span>
        {/* UXO-1: an ARCHIVED task is out of the flow — the archive confirm and
            the acceptance panel both already say so. Its readiness pill kept
            asserting a live obligation ("ready" = someone will act) that is
            false on abandoned work, so it drops and the `archived` pill above
            stands in its place. A terminal (accepted/merged) task keeps its
            readiness pill: that value IS the terminal status, not a live claim.

            R21-8's agent-working yield used to be re-derived here (and again on
            the board card, and again on the list row, with two different
            gates). It is one server-side derivation now —
            `deriveDisplayReadiness` — so this surface renders the value and
            does not re-decide it.

            Ruling 169: ONE status word. Readiness and validation are different
            questions, but the hero drew both as peers, and "blocked" beside
            "awaiting verdict" read as a contradiction (a held task is not up
            for a verdict yet). The readiness value is the status; the one
            quiet validation value that names an obligation — `changed`,
            "awaiting verdict" — takes the slot only when readiness is `ready`
            and so said nothing about what for (and, beside the Ready stage,
            said "ready" twice). The other quiet values — healthy, none —
            describe and stay off the hero, as they do on the card (ruling
            168(b)); a failing validation is a problem and keeps its own pill
            below. */}
        {!archived && (
          <span className="hero-field">
            <span className="hero-field-lbl">Status</span>
            {!terminal &&
            task.displayReadiness === "ready" &&
            task.validation === "changed" ? (
              <ValidationPill value="changed" />
            ) : (
              <ReadinessPill value={task.displayReadiness} />
            )}
          </span>
        )}
        {/* C2 (⇄ N20-14/UXO-1): the validation pill is a live obligation and is
            withdrawn on every terminal task, not just archived ones — see the
            `terminal` note above. Ruling 169: and it renders here only as a
            PROBLEM (the fill tier — "validation failing"); see the status
            slot's note for where "awaiting verdict" went. */}
        {!terminal && !validationQuiet(task.validation) && (
          <ValidationPill value={task.validation} />
        )}
        {/* Ruling 503: the epic is a FIELD, like the stage beside it: the
            body of work this task belongs to, opening the epic's page, where
            its other tasks and its progress are. It replaced ruling 99's goal
            chip, which named one link of a chain. */}
        {epic && (
          <span className="hero-field">
            <span className="hero-field-lbl">Epic</span>
            <EpicChip epic={epic} to={epicHref(task.projectSlug, epic.id)} />
          </span>
        )}
        {/* Ruling 131(a): what this task waits on, each entry a link to the
            task it names, with its resolved state when it is not simply open.
            A key the project does not answer to links nowhere. */}
        {task.blockedBy.map((entry) =>
          entry.taskKey ? (
            <Link
              key={entry.ref}
              className="pill neutral sm hero-wait-chip"
              data-wait-state={entry.state}
              to={`/projects/${task.projectSlug}/tasks/${entry.taskKey}`}
              title={`Waits on ${entry.label} (${entry.state})`}
            >
              <Icon name="lock" />
              {entry.label}
              {entry.state !== "open" ? ` · ${entry.state === "failed" ? "archived" : entry.state}` : ""}
            </Link>
          ) : (
            <span
              key={entry.ref}
              className="pill neutral sm hero-wait-chip"
              data-wait-state={entry.state}
              title={`Waits on ${entry.label} (${entry.state})`}
            >
              <Icon name="lock" />
              {entry.label} · {entry.state}
            </span>
          ),
        )}
        <span className="hero-file">
          <Icon name="file" />
          {/* Ruling 625: one box per segment, its slash included, so a
              narrow line breaks after a slash and never inside the key
              ("tasks/VIB-" | "151/task.md"). */}
          <span>
            {task.filePath.split("/").map((seg, i, all) => (
              <span key={i} className="hero-file-seg">
                {i < all.length - 1 ? `${seg}/` : seg}
              </span>
            ))}
          </span>
        </span>
      </div>
      {editing ? (
        <goalFetcher.Form
          method="post"
          className="goal-edit"
          // Ruling 147: the click AND a keyboard submit both route through the
          // refusal, so a short draft can never become a request.
          onSubmit={(e) => {
            if (goalBusy) {
              e.preventDefault();
              return;
            }
            if (short) {
              e.preventDefault();
              setRefused((n) => n + 1);
              goalRef.current?.focus();
            }
          }}
        >
          {/* P11-47: the editor is already open (`editing` is true here); the
              old onSubmit re-set it to true, a no-op leftover — removed. */}
          <input type="hidden" name="intent" value="update-goal" />
          <input type="hidden" name="_csrf" value={csrf} />
          <textarea
            ref={goalRef}
            name="goal"
            className="goal-textarea"
            defaultValue={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            rows={4}
            aria-label="Task goal and acceptance criteria"
            aria-invalid={goalInvalid || undefined}
            aria-describedby={goalInvalid ? goalErrId : undefined}
            // Focus lands here whether the editor opened via the Edit button
            // or an edit_goal packet decision — the browser scrolls it into view.
            autoFocus
          />
          <div className="goal-edit-actions">
            {/* P13-D-19: was `btn btn-primary`, a class no stylesheet defines —
                it fell back to the plain grey `.btn` and rendered identically to
                the Cancel button beside it. The vocabulary is `btn primary`. */}
            <button
              type="submit"
              className="btn primary"
              disabled={goalBusy}
              aria-busy={goalBusy}
            >
              Save goal
            </button>
            {/* UXA-14: the 3-character floor left a dead button and no reason —
                and a disabled control cannot explain itself via `title`. The
                board's New-task modal already states its own requirement; say
                this one too, and only while it is actually unmet.
                Ruling 147: after a refused submit the same sentence becomes the
                alert, a fresh element per attempt. */}
            {short && (
              <span
                key={refused ? `alert-${refused}` : "hint"}
                id={goalErrId}
                className={refused ? "composer-err" + (refusalShake.shake ? " refused" : "") : "fine dim"}
                onAnimationEnd={refused ? refusalShake.onAnimationEnd : undefined}
                role={refused ? "alert" : undefined}
              >
                A goal needs at least 3 characters.
              </span>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(task.goal);
                setRefused(0);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </goalFetcher.Form>
      ) : (
        <div className="goal md-body">
          {/* Pass 30 (owner-approved): the goal renders as markdown like every
              timeline comment — literal ** and backticks read as unfinished.
              task.md on disk stays canonical; the editor still edits raw text. */}
          <Markdown text={task.goal} {...(taskLinks ? { taskLinks } : {})} />
          {canEditGoal && (
            <button
              type="button"
              className="goal-edit-btn"
              onClick={() => {
                // F35-6: the pending draft, when a decided packet owes one.
                setDraft(pendingGoalDraft ?? task.goal);
                setRefused(0);
                setEditing(true);
              }}
              title="Edit the goal / acceptance criteria"
            >
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* Task metadata (priority/labels/due date) now lives in its own side panel —
   TaskDetailsPanel in task-details-panel.tsx — under Current state and the GitHub trace. */

/** Execution profile plus the run/schedule/release mutations it drives
 * (dynamic-dispatch rework 2026-08-29: one run-agent intent replaced the
 * assign/run specialist+reviewer quartet; scheduling rides the run controls). */
export function ExecutionSection({
  task,
  meId,
  myRole,
  ownerBusy,
  onOwner,
  deployedSpecialists,
  operatorBackend,
  operatorAutonomy,
  operatorAcceptsDirectly = false,
  runPrincipal,
  canRunAgents,
  liveAgentRuns,
  operatorRunActive,
  schedules,
}: {
  task: TaskDetail;
  meId: string;
  myRole: string | null;
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  deployedSpecialists: DeployedSpecialistView[];
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** F37-65: whether acceptance actually resolves to `direct` for this
   *  operator. The caption below used to infer it from autonomy alone. */
  operatorAcceptsDirectly?: boolean;
  /** Ruling 127: the task owner's accounts, which every run here bills
   *  (null = unowned). */
  runPrincipal: TaskRunPrincipalView | null;
  canRunAgents: boolean;
  /** Profile ids of engagements with a live (queued/running) run. */
  liveAgentRuns: LiveAgentRun[];
  /** A live (queued/running) OPERATOR run exists (F7-UI1 pill honesty). */
  operatorRunActive: boolean;
  /** PENDING scheduled runs (both kinds; the profile splits them per control). */
  schedules: TaskSchedule[];
}) {
  const csrf = useCsrfToken();
  const agentFetcher = useFetcher<ActionResult>();
  const operatorFetcher = useFetcher<ActionResult>();
  const releaseFetcher = useFetcher<ActionResult>();
  const cancelFetcher = useFetcher<ActionResult>();
  useActionToast(agentFetcher);
  useActionToast(operatorFetcher);
  useActionToast(releaseFetcher);
  useActionToast(cancelFetcher);
  const agentBusy = agentFetcher.state !== "idle";
  const operatorBusy = operatorFetcher.state !== "idle";
  // Ruling 368: a run control shows which request it sent — a run now or a
  // scheduled one — read off its fetcher, because the control resets its
  // picker to Now on the click.
  const runKind = (intent: string | null): RunInFlight =>
    intent === null ? null : intent === "schedule-action" ? "schedule" : "run";
  const releaseBusy = releaseFetcher.state !== "idle";
  const cancelBusy = cancelFetcher.state !== "idle";

  const submit = (
    fetcher: ReturnType<typeof useFetcher<ActionResult>>,
    fields: Record<string, string>,
  ) => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fetcher.submit(fd, { method: "post" });
  };

  // Run (or schedule) a chosen deployed agent — admin|maintainer (contracts
  // §3.2); the server re-checks RBAC. A deferred delay routes the SAME
  // payload through schedule-action; profileId is what selects the agent arm.
  const onRunAgent = (
    profileId: string,
    prompt: string,
    delayMinutes: number | null,
  ) => {
    if (agentBusy) return;
    if (delayMinutes !== null) {
      submit(agentFetcher, {
        intent: "schedule-action",
        delayMinutes: String(delayMinutes),
        profileId,
        prompt,
      });
      return;
    }
    submit(
      agentFetcher,
      prompt
        ? { intent: "run-agent", profileId, prompt }
        : { intent: "run-agent", profileId },
    );
  };

  // Release a supporting engagement (the ledger's ✕).
  const onReleaseAgent = (profileId: string) => {
    if (releaseBusy) return;
    submit(releaseFetcher, { intent: "release-agent", profileId });
  };

  // Run (or schedule) the operator (admin|maintainer; server re-checks). The
  // run follows the deployed operator profile — backend and autonomy alike
  // (R21-9: the card shows, it does not pick). An optional steer rides along
  // as the human's directive, recorded as an @operator comment.
  const onRunOperator = (steer: string, delayMinutes: number | null) => {
    if (operatorBusy) return;
    if (delayMinutes !== null) {
      submit(operatorFetcher, {
        intent: "schedule-action",
        delayMinutes: String(delayMinutes),
        prompt: steer,
      });
      return;
    }
    submit(
      operatorFetcher,
      steer ? { intent: "run-operator", steer } : { intent: "run-operator" },
    );
  };

  const onCancelSchedule = (scheduleId: string) => {
    if (cancelBusy) return;
    submit(cancelFetcher, { intent: "cancel-schedule", scheduleId });
  };

  return (
    <ExecutionProfile
      stages={task.stages}
      workflow={task.workflow}
      task={task}
      meId={meId}
      myRole={myRole}
      busy={ownerBusy}
      onOwner={onOwner}
      deployedSpecialists={deployedSpecialists}
      operatorBackend={operatorBackend}
      operatorAutonomy={operatorAutonomy}
      acceptsDirectly={operatorAcceptsDirectly}
      runPrincipal={runPrincipal}
      canRunAgents={canRunAgents}
      liveAgentRuns={liveAgentRuns}
      operatorRunActive={operatorRunActive}
      runInFlight={runKind(inFlightIntent(agentFetcher))}
      onRunAgent={onRunAgent}
      releaseBusy={releaseBusy}
      onReleaseAgent={onReleaseAgent}
      operatorInFlight={runKind(inFlightIntent(operatorFetcher))}
      onRunOperator={onRunOperator}
      schedules={schedules}
      scheduleBusy={cancelBusy}
      onCancelSchedule={onCancelSchedule}
    />
  );
}
