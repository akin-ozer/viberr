import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type {
  DiagnosticRecord,
  TaskDetail,
} from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import { LocalDayDotTime } from "~/ui/local-time";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type OwnerAction,
  type TaskMemberView,
} from "./execution-profile";
import {
  OperatorRecommendations,
  type RecommendationView,
} from "./operator-recommendations";
import { useActionFeedback, type ActionResult } from "./task-detail-hooks";

/**
 * The task-detail MAIN column sections, in their contracted order (spec §2):
 * hero → diagnostics → recommendations → scheduled actions → execution
 * profile. (The live-run strip, decision packet, agent logs and timeline are
 * their own modules already.) Split out of `task-detail-page.tsx` (pass 16,
 * pure structural refactor — no behaviour or copy change).
 */

/** Diagnostic severity → pill kind (pure; module scope so it isn't rebuilt per render). */
const kind = (severity: string) =>
  severity === "error" ? "blocked" : severity === "warning" ? "input" : "neutral";

/** Parse/inconsistency findings from the projection (tolerant-parsing
 * contract) — compact list, only when the projection carries any. The full
 * diagnostics console arrives in Phase 10. */
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
              <Pill kind={kind(d.severity)} sm>
                {d.severity}
              </Pill>
            </span>
            <span>
              <code className="mono">{d.code}</code> — {d.message}
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
  agentWorking = false,
  editGoalSignal = 0,
  editGoalDraft = null,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  canEditGoal: boolean;
  /** R14-3: archived tasks are off the board and out of the review queue —
   *  say so at the top, or the page reads like ordinary open work. */
  archived?: boolean;
  /** A live run is in flight — the triage "input required" pill would read as
   *  "waiting on you RIGHT NOW", which is false mid-run, so it yields to an
   *  agent-working pill. Real states (blocked / risk) still show. */
  agentWorking?: boolean;
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
        setEditing(true);
      }
    }
  }, [editGoalSignal, canEditGoal, task.goal, editGoalDraft]);

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
        {agentWorking && task.displayReadiness === "input_required" ? (
          <Pill kind="agent" dot>
            agent working
          </Pill>
        ) : (
          <ReadinessPill value={task.displayReadiness} />
        )}
        <ValidationPill value={task.validation} />
        <span className="hero-file">
          <Icon name="file" />
          <span>{task.filePath}</span>
        </span>
      </div>
      {editing ? (
        <goalFetcher.Form method="post" className="goal-edit">
          {/* P11-47: the editor is already open (`editing` is true here); the
              old onSubmit re-set it to true, a no-op leftover — removed. */}
          <input type="hidden" name="intent" value="update-goal" />
          <input type="hidden" name="_csrf" value={csrf} />
          <textarea
            name="goal"
            className="goal-textarea"
            defaultValue={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            rows={4}
            aria-label="Task goal and acceptance criteria"
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
              disabled={goalFetcher.state !== "idle" || draft.trim().length < 3}
            >
              Save goal
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(task.goal);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </goalFetcher.Form>
      ) : (
        <p className="goal">
          {task.goal}
          {canEditGoal && (
            <button
              type="button"
              className="goal-edit-btn"
              onClick={() => {
                setDraft(task.goal);
                setEditing(true);
              }}
              title="Edit the goal / acceptance criteria"
            >
              Edit
            </button>
          )}
        </p>
      )}
    </div>
  );
}


/** Operator recommendation cards plus their apply/dismiss mutations. */
export function RecommendationsSection({
  recommendations,
  canApply,
}: {
  recommendations: RecommendationView[];
  canApply: boolean;
}) {
  const csrf = useCsrfToken();
  const recFetcher = useFetcher<ActionResult>();
  useActionFeedback(recFetcher);
  const recBusy = recFetcher.state !== "idle";

  // Apply / dismiss an operator recommendation card (apply is admin|maintainer;
  // server re-checks). Apply executes the recommended assign/reviewer/transition.
  const onApplyRec = (recId: string) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "apply-recommendation");
    fd.set("recId", recId);
    recFetcher.submit(fd, { method: "post" });
  };
  const onDismissRec = (recId: string) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "dismiss-recommendation");
    fd.set("recId", recId);
    recFetcher.submit(fd, { method: "post" });
  };

  return (
    <OperatorRecommendations
      recommendations={recommendations}
      canApply={canApply}
      busy={recBusy}
      onApply={onApplyRec}
      onDismiss={onDismissRec}
    />
  );
}

/** O-3: pending scheduled operator re-runs + a form to schedule one. Scheduling
 *  and cancelling are `run-agents` (maintainer+); the server re-checks. Hidden
 *  entirely for viewers/contributors with nothing scheduled. */
export function ScheduledActions({
  schedules,
  canRunAgents,
  taskClosed,
}: {
  schedules: TaskSchedule[];
  canRunAgents: boolean;
  taskClosed: boolean;
}) {
  const csrf = useCsrfToken();
  const fetcher = useFetcher<ActionResult>();
  useActionFeedback(fetcher);
  const busy = fetcher.state !== "idle";
  const canSchedule = canRunAgents && !taskClosed;

  // Nothing to show: no pending schedules AND the viewer can't create one.
  if (schedules.length === 0 && !canSchedule) return null;

  const submit = (fields: Record<string, string>) => {
    if (busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <section className="panel" data-testid="scheduled-actions">
      {/* P13-D-38: the icon used to be nested inside the <h2>, the only one of
          ~48 panel heads that did — `.panel-head` is a flex row whose `.6rem`
          gap collapsed to a JSX space and baseline-aligned the SVG. Sibling
          form, as everywhere else. */}
      <div className="panel-head">
        <Icon name="clock" />
        <h2>Scheduled re-runs</h2>
        {schedules.length > 0 ? (
          <span className="right muted">{schedules.length} pending</span>
        ) : null}
      </div>

      {schedules.length === 0 ? (
        <p className="empty flush">
          No scheduled operator re-runs.
        </p>
      ) : (
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
                operator · {s.autonomy} · {s.backend === "claude" ? "Claude Code" : "Codex"}
                {s.note ? ` — ${s.note}` : ""}
                {s.createdByLabel ? ` · by ${s.createdByLabel}` : ""}
              </div>
              {/* P13-D-19: `btn btn-ghost` -> `btn ghost`. */}
              {canRunAgents ? (
                <button
                  type="button"
                  className="btn ghost sched-cancel"
                  disabled={busy}
                  onClick={() => submit({ intent: "cancel-schedule", scheduleId: s.id })}
                >
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canSchedule ? (
        <fetcher.Form
          method="post"
          className="sched-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            submit({
              intent: "schedule-action",
              delayMinutes: String(f.get("delayMinutes") ?? "60"),
              backend: String(f.get("backend") ?? "claude"),
              autonomy: String(f.get("autonomy") ?? "supervised"),
              note: String(f.get("note") ?? ""),
            });
          }}
        >
          <div className="sched-controls">
            <label className="flabel">
              In
              <select name="delayMinutes" defaultValue="60">
                <option value="5">5 min</option>
                <option value="60">1 hour</option>
                <option value="360">6 hours</option>
                <option value="1440">24 hours</option>
              </select>
            </label>
            <label className="flabel">
              Backend
              <select name="backend" defaultValue="claude">
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="flabel">
              Autonomy
              <select name="autonomy" defaultValue="supervised">
                <option value="supervised">Supervised</option>
                <option value="full">Full</option>
              </select>
            </label>
          </div>
          <input
            className="sched-note"
            name="note"
            type="text"
            placeholder="Why re-run later? (optional)"
            maxLength={140}
          />
          {/* P13-D-19: `btn btn-primary` -> `btn primary` (see Save goal). */}
          <button type="submit" className="btn primary" disabled={busy}>
            <Icon name="clock" /> Schedule operator re-run
          </button>
        </fetcher.Form>
      ) : null}
    </section>
  );
}

/** Execution profile plus the specialist / reviewer / operator mutations it drives. */
export function ExecutionSection({
  task,
  meId,
  myRole,
  members,
  ownerBusy,
  onOwner,
  onRelease,
  deployedSpecialists,
  operatorBackend,
  backendAvailable,
  canRunAgents,
  deliveringActive,
  activeReviewerIds,
  operatorRunActive,
}: {
  task: TaskDetail;
  meId: string;
  myRole: string | null;
  members: TaskMemberView[];
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
  deployedSpecialists: DeployedSpecialistView[];
  operatorBackend: "claude" | "codex";
  backendAvailable: { claude: boolean; codex: boolean };
  canRunAgents: boolean;
  /** A DELIVERING run is active — disables the delivering Run button (F10-04). */
  deliveringActive: boolean;
  /** Reviewer profile ids with an active run — disables only that reviewer. */
  activeReviewerIds: string[];
  /** A live (queued/running) OPERATOR run exists (F7-UI1 pill honesty). */
  operatorRunActive: boolean;
}) {
  const csrf = useCsrfToken();
  const specialistFetcher = useFetcher<ActionResult>();
  const reviewerFetcher = useFetcher<ActionResult>();
  const operatorFetcher = useFetcher<ActionResult>();
  useActionFeedback(specialistFetcher);
  useActionFeedback(reviewerFetcher);
  useActionFeedback(operatorFetcher);
  const specialistBusy = specialistFetcher.state !== "idle";
  const reviewerBusy = reviewerFetcher.state !== "idle";
  const operatorBusy = operatorFetcher.state !== "idle";

  // Assign a deployed specialist / start a specialist run — admin|maintainer
  // (contracts §3.2); server re-checks RBAC. The ExecutionProfile only renders
  // these affordances when canRunAgents.
  const onAssignSpecialist = (profileId: string) => {
    if (specialistBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "assign-specialist");
    fd.set("profileId", profileId);
    specialistFetcher.submit(fd, { method: "post" });
  };
  const onRunSpecialist = () => {
    if (specialistBusy || deliveringActive) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-specialist");
    specialistFetcher.submit(fd, { method: "post" });
  };

  // Reviewer engagement (admin|maintainer; server re-checks). Assign a deployed
  // specialist as a reviewer, run a specific reviewer (gated on THAT reviewer's
  // own active run — supporting runs are read-only and concurrent, F10-04), or
  // release one.
  const onAssignReviewer = (profileId: string) => {
    if (reviewerBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "assign-reviewer");
    fd.set("profileId", profileId);
    reviewerFetcher.submit(fd, { method: "post" });
  };
  const onRunReviewer = (profileId: string) => {
    if (reviewerBusy || activeReviewerIds.includes(profileId)) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-reviewer");
    fd.set("profileId", profileId);
    reviewerFetcher.submit(fd, { method: "post" });
  };
  const onRemoveReviewer = (profileId: string) => {
    if (reviewerBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "remove-reviewer");
    fd.set("profileId", profileId);
    reviewerFetcher.submit(fd, { method: "post" });
  };

  // Run the operator agent (admin|maintainer; server re-checks). The operator
  // coordinates the task under its capability policy; backend + autonomy are
  // chosen for this run (full autonomy lets it drive to Done).
  const onRunOperator = (backend: string, autonomy: string) => {
    if (operatorBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-operator");
    fd.set("backend", backend);
    fd.set("autonomy", autonomy);
    operatorFetcher.submit(fd, { method: "post" });
  };

  return (
    <ExecutionProfile
      task={task}
      meId={meId}
      myRole={myRole}
      members={members}
      busy={ownerBusy}
      onOwner={onOwner}
      onRelease={onRelease}
      deployedSpecialists={deployedSpecialists}
      operatorBackend={operatorBackend}
      backendAvailable={backendAvailable}
      canRunAgents={canRunAgents}
      deliveringActive={deliveringActive}
      activeReviewerIds={activeReviewerIds}
      operatorRunActive={operatorRunActive}
      runBusy={specialistBusy}
      onAssignSpecialist={onAssignSpecialist}
      onRunSpecialist={onRunSpecialist}
      reviewerBusy={reviewerBusy}
      onAssignReviewer={onAssignReviewer}
      onRunReviewer={onRunReviewer}
      onRemoveReviewer={onRemoveReviewer}
      operatorBusy={operatorBusy}
      onRunOperator={onRunOperator}
    />
  );
}
