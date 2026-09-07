import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type {
  DiagnosticRecord,
  TaskDetail,
} from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import { Markdown } from "~/ui/markdown";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type LiveAgentRun,
  type OwnerAction,
  type TaskMemberView,
} from "./execution-profile";
import type { TaskRunPrincipalView } from "./run-principal-view";
import { useActionFeedback, type ActionResult } from "./task-detail-hooks";

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
 * The page renders `OperatorRecommendations` directly and routes Apply through
 * `AcceptConfirm` (mode `apply-recommendation`). Do not re-add a local wrapper
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
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const goalErrId = "goal-err";
  const short = draft.trim().length < 3;
  const goalInvalid = refused > 0 && short;
  const goalBusy = goalFetcher.state !== "idle";
  // Surface a failed save as a toast instead of silently leaving the editor
  // open with no explanation (WI-11); on success the effect below closes it.
  useActionFeedback(goalFetcher);
  // Close the editor once a save round-trips successfully. Handled-ref dedup
  // (timeline-composer pattern): `goalFetcher.data` persists after idle, so
  // without it the stale `ok` would instantly close every later re-open.
  const goalSaveHandled = useRef<unknown>(null);
  useEffect(() => {
    if (goalFetcher.state !== "idle" || !goalFetcher.data?.ok) return;
    if (goalSaveHandled.current === goalFetcher.data) return;
    goalSaveHandled.current = goalFetcher.data;
    setRefused(0);
    setEditing(false);
  }, [goalFetcher.state, goalFetcher.data]);
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
  // terminal (task-side-panels.tsx `isTerminal`, task-detail-page.tsx
  // `taskClosed`). The readiness pill stays for a terminal task: its value is
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
        <Pill kind="neutral">
          <span
            className="col-stage-dot sm"
            style={{ background: stage?.color }}
          />
          {stage?.name ?? ""}
        </Pill>
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
            does not re-decide it. */}
        {!archived && <ReadinessPill value={task.displayReadiness} />}
        {/* C2 (⇄ N20-14/UXO-1): the validation pill is a live obligation and is
            withdrawn on every terminal task, not just archived ones — see the
            `terminal` note above. */}
        {!terminal && <ValidationPill value={task.validation} />}
        {/* Ruling 99: this task is one link of a goal chain — the chip names
            the chain and links to the project Controller surface, where the
            whole chain is read and redirected. */}
        {task.goalRef && (
          <Link
            className="pill agent sm hero-goal-chip"
            to={`/projects/${task.projectSlug}/controller`}
          >
            <Icon name="flag" />
            {task.goalRef.goalId} · link {task.goalRef.linkIndex}
          </Link>
        )}
        {/* Ruling 131(a): what this task waits on, each entry a link (the
            task page, or the project Controller page for a goal link) with
            its resolved state when it is not simply open. */}
        {task.blockedBy.map((entry) => (
          <Link
            key={entry.ref}
            className="pill neutral sm hero-goal-chip"
            data-wait-state={entry.state}
            to={
              entry.taskKey
                ? `/projects/${task.projectSlug}/tasks/${entry.taskKey}`
                : `/projects/${task.projectSlug}/controller`
            }
            title={`Waits on ${entry.label} (${entry.state})`}
          >
            <Icon name="lock" />
            {entry.label}
            {entry.state !== "open" ? ` · ${entry.state === "failed" ? "archived" : entry.state}` : ""}
          </Link>
        ))}
        <span className="hero-file">
          <Icon name="file" />
          <span>{task.filePath}</span>
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
                className={refused ? "composer-err" : "fine xs dim"}
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
          <Markdown text={task.goal} />
          {canEditGoal && (
            <button
              type="button"
              className="goal-edit-btn"
              onClick={() => {
                setDraft(task.goal);
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
   TaskDetailsPanel in task-side-panels.tsx — beside Current state and Permissions. */

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
  useActionFeedback(agentFetcher);
  useActionFeedback(operatorFetcher);
  useActionFeedback(releaseFetcher);
  useActionFeedback(cancelFetcher);
  const agentBusy = agentFetcher.state !== "idle";
  const operatorBusy = operatorFetcher.state !== "idle";
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
      task={task}
      meId={meId}
      myRole={myRole}
      busy={ownerBusy}
      onOwner={onOwner}
      deployedSpecialists={deployedSpecialists}
      operatorBackend={operatorBackend}
      operatorAutonomy={operatorAutonomy}
      runPrincipal={runPrincipal}
      canRunAgents={canRunAgents}
      liveAgentRuns={liveAgentRuns}
      operatorRunActive={operatorRunActive}
      runBusy={agentBusy}
      onRunAgent={onRunAgent}
      releaseBusy={releaseBusy}
      onReleaseAgent={onReleaseAgent}
      operatorBusy={operatorBusy}
      onRunOperator={onRunOperator}
      schedules={schedules}
      scheduleBusy={cancelBusy}
      onCancelSchedule={onCancelSchedule}
    />
  );
}
