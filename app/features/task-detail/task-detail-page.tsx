import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate, type FetcherWithComponents } from "react-router";
import type { DiagnosticRecord, TaskDetail } from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { AcceptConfirm } from "./accept-confirm";
import { ArchiveConfirm } from "./archive-confirm";
import { DecisionPacket } from "./decision-packet";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type OwnerAction,
  type TaskMemberView,
} from "./execution-profile";
import { ReleaseConfirm } from "./release-confirm";
import {
  OperatorRecommendations,
  type RecommendationView,
} from "./operator-recommendations";
import { Timeline, type TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { checksPill, prStatePill, reviewPill } from "~/features/github/github-pills";
import type { RunView } from "~/features/runtime/runtime-types";
import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import { LocalDayDotTime, LocalRelative } from "~/ui/local-time";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";

/**
 * Task detail workspace — port of TaskDetail (task.jsx). Operator-first
 * layout order is a contract (spec §2): hero → live run strip → decision
 * packet → execution profile → agent logs → timeline; sidebar: GitHub
 * trace → current state → permissions. All mutations are route actions
 * (revalidation, no optimistic governed state); toast copy comes back from
 * the action (verbatim spec §5 strings).
 */

type ActionResult =
  | { ok: true; toast?: string; navigateTo?: string; kind?: string }
  | { ok: false; error: string };

/** Toast + optional redirect once per completed fetcher submission. */
function useActionFeedback(fetcher: FetcherWithComponents<ActionResult>) {
  const push = useToast();
  const navigate = useNavigate();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.navigateTo) navigate(d.navigateTo);
    } else if (d.error) {
      // E.g. "This packet was already resolved." — revalidation has already
      // refreshed the panel; surface the reason, never crash (spec §7).
      // P13-D-10: `push` defaults to the "success" kind, so every failure on
      // this page rendered under a green tick.
      push(d.error, "error");
    }
  }, [fetcher.state, fetcher.data, push, navigate]);
}

export function GithubTrace({
  task,
  githubHost,
  reconciledAt = null,
  onCompleteMerge,
  onForceAccept,
  onDeliver,
  delivering = false,
  merging,
}: {
  task: TaskDetail;
  /** GitHub web host for browse links — always the loader's `githubWebHost()`
   *  (P14-UI-11: no client-side default, so the literal lives in one place). */
  githubHost: string;
  /** UI-57: ISO of the newest `github.reconcile` for THIS task, or null when it
   *  has never been synced. Diff/commits/PR below are a CACHE — the GitHub page
   *  discloses its freshness and this card did not. */
  reconciledAt?: string | null;
  /** Run the real merge for an accepted (merge-pending) PR (S2). */
  onCompleteMerge?: () => void;
  /** Admin override of a stuck acceptance gate (DG-2); admin-only, undefined otherwise. */
  onForceAccept?: () => void;
  /** R15-2 safety net (b): perform delivery (push + review PR) by hand —
   *  maintainer+ or the task owner; undefined hides the control. */
  onDeliver?: () => void;
  delivering?: boolean;
  merging?: boolean;
}) {
  // Admin escape hatch (DG-2): acceptance is wedged either by the required-reviewer
  // gate (task.blockReason) OR by an open blocked decision packet a crashed run left
  // behind. Surfaced for admins (onForceAccept present) regardless of branch/PR, so a
  // no-branch pre-work wedge is still escapable.
  const forceAcceptReason =
    task.blockReason ??
    (task.packet?.type === "blocked"
      ? "An open blocked decision is holding this task."
      : null);
  const forceAcceptRow =
    forceAcceptReason && onForceAccept ? (
      <div style={{ marginTop: ".8rem" }}>
        {/* P13-D-19: `.hint` used to exist only as `.pj-new .hint`, so this line
            rendered as an unstyled <p>; it is a global utility now. */}
        <p className="hint" style={{ margin: "0 0 .4rem" }}>
          Acceptance is blocked: {forceAcceptReason}
        </p>
        <button
          type="button"
          className="btn ghost sm"
          style={{ width: "100%" }}
          disabled={merging}
          onClick={onForceAccept}
          title="Admin override: accept this task into Done past the review gate. Audited."
        >
          <Icon name="shield" />
          Force accept (override review gate)
        </button>
      </div>
    ) : null;
  if (!task.branch && !task.pr) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="github" />
          <h2>GitHub</h2>
        </div>
        <div className="empty" style={{ padding: "1rem .5rem" }}>
          No branch yet. A task-key branch is created when execution starts.
        </div>
        {forceAcceptRow}
      </div>
    );
  }
  // Real external link (spec §4.9: the prototype toast goes away): the PR when
  // one exists, else the branch tree.
  //
  // P14-UI-11 residual: this used to carry its own `?? "https://github.com"`
  // fallback, so the app held the host literal in TWO places while the fix note
  // in `github-query.server.ts` designated ONE thread-through point for a real
  // GHE base URL. The loader always sends `githubWebHost()`, so the prop is
  // required and the second literal is gone.
  const host = githubHost;
  const ghHref = task.repo
    ? task.pr
      ? `${host}/${task.repo}/pull/${task.pr.number}`
      : task.branch
        ? `${host}/${task.repo}/tree/${task.branch}`
        : `${host}/${task.repo}`
    : null;
  return (
    <div className="panel flush">
      <div className="gh-bar">
        <Icon name="github" />
        <span className="repo">{task.repo}</span>
        {task.pr ? (
          // UI-36: reuse the shared PR-state mapping. This branched only on
          // `merged`/`accepted`, so a PR CLOSED WITHOUT MERGING (a rejected
          // one — a first-class state since NEW-1) rendered as a blue "PR #14",
          // visually identical to a PR still in review. The GitHub page and the
          // review queue have always rendered it correctly.
          <Pill kind={prStatePill(task.pr.state).kind} sm>
            {task.pr.state === "merged"
              ? "merged"
              : `PR #${task.pr.number} · ${prStatePill(task.pr.state).label}`}
          </Pill>
        ) : (
          <Pill kind="neutral" sm>
            no PR
          </Pill>
        )}
        {/* P13-D-28: the two GitHub facts the app fetched (or could have) and
            never showed. Check-runs were summarized on every reconcile pass and
            read by nothing; review state was never read at all, so a teammate
            approving or requesting changes on GitHub was invisible here and a
            merge blocked by required reviews surfaced only as a late 405. */}
        {task.prChecks && (
          <Pill kind={checksPill(task.prChecks).kind} sm>
            {checksPill(task.prChecks).label}
          </Pill>
        )}
        {task.prReview && (
          <Pill kind={reviewPill(task.prReview).kind} sm>
            {reviewPill(task.prReview).label}
          </Pill>
        )}
      </div>
      <div className="gh-body">
        <div className="kv-row">
          <span className="k">Synced</span>
          <span className="v sub" title="Branch, diff, commits and PR state below are served from the cached projection; a background poller refreshes it every 5 minutes.">
            {reconciledAt ? (
              <time dateTime={reconciledAt}>
                <LocalRelative iso={reconciledAt} />
              </time>
            ) : task.pr || task.commits.length > 0 ? (
              // F15-02: PR/commit facts on screen came from delivery-time
              // writes, not a reconcile pass — "not yet synced" next to a live
              // PR read as a contradiction. Say what is actually true.
              "recorded at delivery — no background sync pass yet"
            ) : (
              "not yet synced with GitHub"
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Branch</span>
          <span className="v">
            <Icon name="branch" />
            <span className="mono">{task.branch}</span>
          </span>
        </div>
        {task.changed && (
          <div className="kv-row">
            <span className="k">Diff</span>
            <span className="v mono">
              {/* LV-09: "Diff 1 files" */}
              {task.changed.files} {task.changed.files === 1 ? "file" : "files"} ·{" "}
              <span style={{ color: "var(--teal-dark)" }}>+{task.changed.add}</span>{" "}
              <span style={{ color: "var(--coral-dark)" }}>−{task.changed.del}</span>
            </span>
          </div>
        )}
        {task.commits.length > 0 && (
          <div style={{ marginTop: ".7rem" }}>
            <div
              className="lbl"
              style={{
                fontSize: ".68rem",
                fontWeight: 900,
                letterSpacing: ".05em",
                textTransform: "uppercase",
                color: "var(--placeholder)",
                marginBottom: ".3rem",
              }}
            >
              Commits
            </div>
            {task.commits.map((c) => (
              <div className="commit" key={c.sha}>
                <span className="sha">{c.sha}</span>
                <span className="msg">{c.msg}</span>
              </div>
            ))}
          </div>
        )}
        {/* R15-2 safety net (b): with delivery now an operator decision, a
            human with authority can always ship the branch by hand — shown when
            no live PR stands (none yet, or the last one closed/merged). */}
        {onDeliver &&
          (!task.pr ||
            task.pr.state === "closed" ||
            task.pr.state === "merged") && (
            <button
              type="button"
              className="btn primary sm"
              style={{ marginTop: ".8rem", width: "100%" }}
              disabled={delivering}
              onClick={onDeliver}
              title="Push the delivering agent's branch and open the review PR (audited)"
            >
              <Icon name="branch" />
              {delivering ? "Delivering…" : "Deliver branch & open PR"}
            </button>
          )}
        {task.pr?.state === "accepted" && onCompleteMerge && (
          <button
            type="button"
            className="btn primary sm"
            style={{ marginTop: ".8rem", width: "100%" }}
            disabled={merging}
            onClick={onCompleteMerge}
            title="Run the real GitHub merge for this accepted PR (needs a valid project credential)"
          >
            <Icon name="check" />
            Complete merge
          </button>
        )}
        {forceAcceptRow}
        {ghHref && (
          <a
            className="btn ghost sm"
            style={{ marginTop: ".8rem", width: "100%" }}
            href={ghHref}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="ext" />
            Open on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function PolicyPanel({
  projectSlug,
  myRole,
  stages,
  ownsTask,
}: {
  projectSlug: string;
  myRole: string | null;
  /** UI-15/UI-49 family: the boundary row names the project's OWN review and
   *  terminal stages instead of the literals "Review → Done". */
  stages: TaskDetail["stages"];
  /** P14-GV-04: this viewer holds the task's owner seat. The acceptance row is
   *  the one platform rule that is NOT identical for every task — R6-2 gives the
   *  owner acceptance authority whatever their project role — and this panel
   *  told a contributor-owner "Maintainer or admin only" while the server let
   *  them accept and the review queue counted them as the one who must. */
  ownsTask: boolean;
}) {
  const reviewName =
    stages.length >= 2 ? stages[stages.length - 2]!.name : "the review stage";
  const terminalName =
    stages.length >= 1 ? stages[stages.length - 1]!.name : "the final stage";
  const r = (myRole as ProjectRole | null) ?? null;
  const role = myRole || "viewer";
  // Render exactly what the canonical matrix (app/shared/rbac.ts) enforces for
  // THIS viewer's role — no aspirational copy that the server would 403.
  const rows: { k: string; v: string; icon: "user" | "flag" | "plus" | "message" | "cpu" | "lock" }[] = [
    { k: "Your role", v: role.charAt(0).toUpperCase() + role.slice(1), icon: "user" },
    {
      // E1: this was hardcoded "Every registered user" — false, and false on a
      // surface whose whole job is stating what the server enforces. A
      // signed-in non-member 404s on this page and on the comment POST;
      // membership is the gate, and every project role holds `comment` inside
      // it. Read from the matrix like every other row so it cannot drift again.
      k: "Comments",
      v: roleCan(r, "comment")
        ? "You can comment — every project member can"
        : "Project members only",
      icon: "message",
    },
    {
      k: "Task ownership",
      v: roleCan(r, "own-task")
        ? roleCan(r, "release-any-ownership")
          ? "Take / release · you can release anyone"
          : "Take / release your own seat"
        : "View only — contributor+ to own",
      icon: "plus",
    },
    {
      k: "Accept completion",
      v: roleCan(r, "accept-completion")
        ? "You can accept → Done"
        : ownsTask
          ? "You own this task — you can accept it → Done"
          : "Maintainer, admin, or the task's own owner",
      icon: "flag",
    },
    {
      k: "Run agents",
      v: roleCan(r, "run-agents") ? "You can run agents" : "Maintainer or admin only",
      icon: "cpu",
    },
    {
      k: `${reviewName} → ${terminalName}`,
      v: "Human decision, locked at the review boundary",
      icon: "lock",
    },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Permissions</h2>
        <span
          className="right sub"
          style={{ fontSize: ".75rem", color: "var(--faint)" }}
        >
          V1 rules
        </span>
      </div>
      <p
        style={{
          margin: "0 0 .55rem",
          fontSize: ".75rem",
          lineHeight: 1.4,
          color: "var(--faint)",
        }}
      >
        Platform rules as they apply to <b>you on this task</b> — role grants,
        plus the owner authority R6-2 adds. This task's live stage, owner and
        waiting-on are in <b>Current state</b> above.
      </p>
      {rows.map((r) => (
        <div className="policy-line" key={r.k}>
          <span className="k">
            <Icon name={r.icon} />
            {r.k}
          </span>
          <span className="v">{r.v}</span>
        </div>
      ))}
      <Link
        className="btn ghost sm"
        style={{ width: "100%", marginTop: ".8rem" }}
        to={`/projects/${projectSlug}/policy`}
      >
        <Icon name="shield" />
        View project policy
      </Link>
    </div>
  );
}

/** Diagnostic severity → pill kind (pure; module scope so it isn't rebuilt per render). */
const kind = (severity: string) =>
  severity === "error" ? "blocked" : severity === "warning" ? "input" : "neutral";

/** Parse/inconsistency findings from the projection (tolerant-parsing
 * contract) — compact list, only when the projection carries any. The full
 * diagnostics console arrives in Phase 10. */
function DiagnosticsPanel({ diagnostics }: { diagnostics: DiagnosticRecord[] }) {
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
      <div className="packet-obs" style={{ margin: 0 }}>
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
        setDraft(task.goal);
        setEditing(true);
      }
    }
  }, [editGoalSignal, canEditGoal, task.goal]);

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
            className="col-stage-dot"
            style={{
              background: stage?.color,
              width: ".5rem",
              height: ".5rem",
            }}
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
function RecommendationsSection({
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
        <p className="empty" style={{ padding: ".4rem 0" }}>
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
function ExecutionSection({
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

/** Sidebar "Current state" panel — stage (with governed transition menu),
 * waiting-on, owner controls, repo, and the two dispositions a human decides
 * here: accepting the completion (P14-LV-06) and archiving (R14-3). */
function CurrentStatePanel({
  task,
  stage,
  meId,
  myRole,
  archived,
  acceptance,
  ownerBusy,
  onOwner,
  onRelease,
  onArchive,
  onAccept,
  acceptBusy: acceptSubmitting,
  dispositionBusy,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  meId: string;
  myRole: string | null;
  /** R14-3: this task is archived — the panel offers Restore instead. */
  archived: boolean;
  /** P14-LV-06: what this viewer may do about accepting, resolved server-side
   *  by the same predicate the review queue counts with. */
  acceptance: AcceptanceAffordance;
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
  /** Open the archive confirm (archived === false) or restore immediately. */
  onArchive: () => void;
  /** F15-10: opens the accept CONFIRM dialog (the page owns the submission —
   *  accepting merges the PR, so it never fires on a bare click any more). */
  onAccept: () => void;
  /** The accept submission is in flight (page-owned fetcher). */
  acceptBusy: boolean;
  /** An accept / archive / restore submission is in flight. */
  dispositionBusy: boolean;
}) {
  const csrf = useCsrfToken();
  const transitionFetcher = useFetcher<ActionResult>();
  useActionFeedback(transitionFetcher);

  // Manual stage change from the Current-state dropdown (admin|maintainer; the
  // server re-checks). Goes through the same governed transition that an applied
  // operator recommendation does, so it posts the **Transition:** timeline
  // comment and hands the task to the operator at its new stage.
  const canTransition = roleCan(myRole as ProjectRole | null, "approve-transition");
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");
  // E3: releasing SOMEONE ELSE's seat is `release-any-ownership`, which is what
  // `releaseOwner` enforces — this asked `myRole === "admin"`, a hardcoded copy
  // of one row of the matrix.
  const canReleaseAnyOwner = roleCan(
    myRole as ProjectRole | null,
    "release-any-ownership",
  );
  const transitionBusy = transitionFetcher.state !== "idle";
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "transition");
    fd.set("to", toStageId);
    transitionFetcher.submit(fd, { method: "post" });
  };

  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const ownerMine = !!(owner && owner.userId === meId);
  const acceptBusy = acceptSubmitting || dispositionBusy;
  const terminalName =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.name : "Done";

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bolt" />
        <h2>Current state</h2>
        {archived && (
          <span className="right">
            <Pill kind="neutral" sm>
              archived
            </Pill>
          </span>
        )}
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Stage</span>
          <span className="v">
            {canTransition ? (
              <StageMenu
                stages={task.stages}
                currentStageId={task.stage}
                onSelect={onTransition}
                busy={transitionBusy}
              />
            ) : (
              <span className="stage-static">
                <span
                  className="col-stage-dot"
                  style={{
                    background: stage?.color,
                    width: ".5rem",
                    height: ".5rem",
                  }}
                />
                {stage?.name ?? ""}
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Waiting on</span>
          <span className="v">
            {task.waiting === "human" ? (
              <span style={{ color: "var(--blue-pressed)" }}>Human decision</span>
            ) : task.waiting === "agent" ? (
              <span style={{ color: "var(--agent-dark)" }}>Agent work</span>
            ) : (
              "Nothing"
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Owner</span>
          <span className="v">
            {owner ? (
              <span
                className="rev-stack"
                title="Human owner — reviews & accepts, this task only"
              >
                <Avatar person={owner} />
                <span className="rs-names">
                  {owner.name.split(" ")[0]}
                  {ownerMine ? " (you)" : ""}
                </span>
                {((ownerMine && canOwn) || canReleaseAnyOwner) && (
                  <button
                    type="button"
                    className="own-x"
                    title={
                      ownerMine
                        ? "Release ownership"
                        : "Release " + owner.name.split(" ")[0] + " (admin)"
                    }
                    aria-label="Release owner"
                    onClick={onRelease}
                  >
                    <Icon name="x" />
                  </button>
                )}
              </span>
            ) : canOwn ? (
              // Q5 clean tiering: only contributor+ may hold the owner seat
              // (setOwner enforces `own-task`). Viewers are read + comment, so
              // hide "Assign me" rather than render a button that 403s.
              <button
                type="button"
                className="rev-add sm"
                disabled={ownerBusy}
                onClick={() => onOwner("take")}
              >
                <Icon name="plus" />
                Assign me
              </button>
            ) : (
              <span className="v sub">Unowned</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Repo</span>
          <span className="v mono">{task.repo}</span>
        </div>
      </div>
      {/* P14-LV-06: the acceptance the review queue promises. It renders for a
          viewer who HOLDS acceptance authority here (maintainer+, or this task's
          own owner per R6-2/R14-2) once the task stands at the boundary a
          completion can be accepted from — never as an inert button, and never
          silently absent while the queue says "waiting on your acceptance".
          F15-19: the refusal TEXT renders whenever one exists, boundary or not —
          a silent refusal is how an unreviewed merge looked like a hang. */}
      {acceptance.hasAuthority &&
        !archived &&
        (acceptance.atBoundary || acceptance.blockedReason) && (
          <div className="state-acts">
            {acceptance.atBoundary && (
              <button
                type="button"
                className="btn primary sm"
                style={{ width: "100%" }}
                disabled={!acceptance.canAccept || acceptBusy}
                onClick={onAccept}
              >
                <Icon name="check" />
                {acceptBusy
                  ? "Accepting — merging the review PR…"
                  : `Accept completion → ${terminalName}`}
              </button>
            )}
            {acceptance.blockedReason && (
              // The reason has to be TEXT, not a `title`: a disabled control gets
              // no pointer events, so a tooltip on it never opens (P14-LV-08).
              <p className="deny-note">
                <Icon name="alert" />
                <span>
                  {/* R16-3: "Not acceptable yet" is the right frame for a
                      process gate and the wrong one for a closed PR — nothing
                      about waiting makes that acceptable. The reason itself is
                      the server's (one source); only the framing and the
                      pointer at the recovery decision are this surface's. */}
                  <strong>
                    {acceptance.terminallyBlocked
                      ? "Acceptance is closed."
                      : "Not acceptable yet."}
                  </strong>{" "}
                  {acceptance.blockedReason}
                  {acceptance.terminallyBlocked && task.packet && (
                    <> The decision on this task carries the recovery paths.</>
                  )}
                </span>
              </p>
            )}
          </div>
        )}
      {/* R14-3: the honest ending for abandoned work — the one the closed-PR
          guidance has been naming since pass 13. Board-management authority
          (`approve-transition`), the same tier that moves a task between
          stages; hidden for everyone else rather than rendered inert. */}
      {canTransition && (
        <div className="state-acts">
          <button
            type="button"
            className="btn ghost sm"
            style={{ width: "100%" }}
            disabled={dispositionBusy}
            onClick={onArchive}
          >
            <Icon name={archived ? "refresh" : "lock"} />
            {archived ? "Restore from archive" : "Archive task"}
          </button>
          <p className="hint" style={{ margin: ".35rem 0 0" }}>
            {archived
              ? "Archived — off the board and out of the review queue. Restoring puts it back where it stood, waiting on a human."
              : "Keeps the record, takes the task off the board and out of the review queue. Reversible."}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Run-control mutations (interrupt / retry-on-other-backend / complete the
 * real merge). One fetcher backs all three, so a single in-flight run action
 * disables the others.
 */
function useRunControls({
  csrf,
  runtime,
  myRole,
  canRunAgents,
  acceptanceTerminallyBlocked,
}: {
  csrf: string;
  runtime: RunView[];
  myRole: string | null;
  canRunAgents: boolean;
  /** R16-3: a closed, unmerged PR blocks acceptance terminally — no override. */
  acceptanceTerminallyBlocked: boolean;
}) {
  const runFetcher = useFetcher<ActionResult>();
  useActionFeedback(runFetcher);
  const runBusy = runFetcher.state !== "idle";
  // Any live (queued/running) run — the D4 backend-retry affordance stays gated
  // on "nothing currently in flight" (F10-04 keeps this coarse gate; per-
  // engagement gating applies to the primary/reviewer Run buttons only).
  const anyRunActive = runtime.some(
    (r) => r.lifecycle === "running" || r.lifecycle === "queued",
  );
  // Interrupt is admin|maintainer (contracts §3.2); the button hides for
  // everyone else. Server re-checks RBAC regardless.
  const canInterrupt = roleCan(myRole as ProjectRole | null, "run-agents");
  const onInterrupt = (runThreadId: string) => {
    if (runBusy) return;
    const run = runtime.find((r) => r.id === runThreadId);
    if (!run) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-interrupt");
    fd.set("runId", run.serverRunId);
    runFetcher.submit(fd, { method: "post" });
  };
  // Retry the failed run's agent on the OTHER backend after a backend
  // availability / quota failure (D4). Routes by the failed run's kind —
  // a reviewer retries as THAT reviewer, not as the primary. The override
  // also persists to the assignment snapshot server-side, so the operator's
  // next prompt follows the switched backend. admin|maintainer; server
  // re-checks.
  const onRetryBackend =
    canRunAgents && !anyRunActive
      ? (backend: "claude" | "codex", run: RunView) => {
          if (runBusy) return;
          const fd = new FormData();
          fd.set("_csrf", csrf);
          fd.set(
            "intent",
            run.kind === "reviewer" ? "run-reviewer" : "run-specialist",
          );
          if (run.kind === "reviewer") {
            fd.set("profileId", run.profileId);
          }
          fd.set("backend", backend);
          runFetcher.submit(fd, { method: "post" });
        }
      : undefined;
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  // admin|maintainer only; server re-checks.
  const canMerge = roleCan(myRole as ProjectRole | null, "accept-completion");
  const onCompleteMerge = canMerge
    ? () => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "complete-merge");
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  // Admin-only override of a stuck acceptance gate (DG-2). Server re-checks the
  // admin role AND re-derives the block; this only wires the affordance.
  //
  // R16-3: force-accept exists for a WEDGED gate — a verdict that can no longer
  // be recorded, a stale packet. A PR closed unmerged is not wedged, it is
  // decided: forcing past it moves the task to Done over a rejection and stamps
  // `pr.state: accepted` on a PR GitHub has already closed. Live (H10) the rail
  // offered exactly that while the recovery packet beside it said otherwise, so
  // the affordance is withheld entirely and the packet is the path.
  const canForceAccept =
    roleCan(myRole as ProjectRole | null, "force-accept-completion") &&
    !acceptanceTerminallyBlocked;
  const onForceAccept = canForceAccept
    ? () => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "force-accept");
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  return {
    runBusy,
    canInterrupt,
    onInterrupt,
    onRetryBackend,
    onCompleteMerge,
    onForceAccept,
  };
}

/**
 * BUG 3: commenting an @agent auto-selects that agent's grouped log entry and
 * scrolls the Agent-logs panel into view. The reply run is the group
 * representative → selecting its id shows its live output (streamed by the
 * existing useRunLogStream). Revalidation (fired by the comment fetcher)
 * brings the run into `runtime`; the pending id is kept until it appears so
 * the selection lands after revalidation, not before it.
 */
function useLogSelection(runtime: RunView[]) {
  const [logSel, setLogSel] = useState<string | null>(null);
  const [pendingLogSel, setPendingLogSel] = useState<string | null>(null);
  // Derived selection (no confirm-effect): once revalidation lands the pending
  // reply run in `runtime` it wins over `logSel`; until then the user's own
  // selection shows. A manual pick made after the pending run landed evicts
  // the pending marker so it can't snap the selection back later.
  const pendingLogReady =
    pendingLogSel !== null && runtime.some((r) => r.id === pendingLogSel);
  const shownLogSel = pendingLogReady ? pendingLogSel : logSel;
  const selectLog = (id: string | null) => {
    if (pendingLogReady) setPendingLogSel(null);
    setLogSel(id);
  };
  const onViewLogs = (id: string) => {
    selectLog(id);
    // Scroll the logs panel into view (spec §5.2 addition).
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const onAgentLog = (threadId: string) => {
    setPendingLogSel(threadId);
    setLogSel(threadId);
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  return { shownLogSel, selectLog, onViewLogs, onAgentLog };
}

export function TaskDetailPage({
  task,
  runtime,
  deployedSpecialists,
  operatorBackend,
  backendAvailable,
  deliveringActive,
  activeReviewerIds,
  runsVisible = true,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  members,
  me,
  myRole,
  mentionables,
  recommendations,
  schedules,
  archived = false,
  acceptance,
  githubHost,
  githubReconciledAt = null,
  workRevisionSha = null,
  defaultBranch = "main",
  canDeliver = false,
}: {
  /** Loader detail — `task.timeline` is the bounded newest-first slice. */
  task: TaskDetail;
  /** Per-task run projection (Phase 8). */
  runtime: RunView[];
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** The operator's configured backend — the run picker's default (P11-76). */
  operatorBackend: "claude" | "codex";
  /** P11-41: which backends are configured, for the run picker. */
  backendAvailable: { claude: boolean; codex: boolean };
  /** A DELIVERING run is active — disables the delivering Run button (F10-04). */
  deliveringActive: boolean;
  /** Reviewer profile ids with an active run — disables only that reviewer. */
  activeReviewerIds: string[];
  /** UI-30: false → the viewer is not a project member, so `lines`/`raw`/`sid`
   *  were withheld by the loader and the console renders an honest gate notice
   *  instead of an empty panel. */
  runsVisible?: boolean;
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  members: TaskMemberView[];
  me: { id: string; name: string };
  myRole: string | null;
  /** @-mention autocomplete directory for the comment composer (loader). */
  mentionables: Mentionables;
  /** Pending operator recommendation cards (loader — from the task file). */
  recommendations: RecommendationView[];
  /** Pending scheduled operator re-runs (O-3, loader — from the task file). */
  schedules: TaskSchedule[];
  /** R14-3: the task's archive disposition (loader — from the task file, which
   *  is where it lives; the projection has no column for it). */
  archived?: boolean;
  /** P14-LV-06: the viewer's acceptance authority + the exact refusal, resolved
   *  server-side by the predicate the review queue also counts with. */
  acceptance: AcceptanceAffordance;
  /** GitHub web host for browse links — the loader's `githubWebHost()`. */
  githubHost: string;
  /** UI-57: newest `github.reconcile` for this task (freshness cue). */
  githubReconciledAt?: string | null;
  /** R15-1: the delivered revision's head sha (task file) for the confirm. */
  workRevisionSha?: string | null;
  /** The merge target named in the accept confirm — the project's default branch. */
  defaultBranch?: string;
  /** R15-2 safety net (b): the viewer may deliver by hand (maintainer+ or owner). */
  canDeliver?: boolean;
}) {
  const stage = task.stages.find((s) => s.id === task.stage);
  const [releasing, setReleasing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [ask, setAsk] = useState(0);
  const csrf = useCsrfToken();

  // G7: the page body is overflow:hidden and `.detail` is the actual scroll
  // container, so keyboard scrolling (Space / PageDown / arrows) is dead until
  // `.detail` holds focus. It's kept out of the tab order (tabIndex=-1) and
  // focused on mount so the workspace is keyboard-scrollable immediately.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
  }, []);

  const ownerFetcher = useFetcher<ActionResult>();
  const resolveFetcher = useFetcher<ActionResult>();
  // R14-3: its own fetcher — an archive/restore must not be able to strand or be
  // stranded by an ownership submission sharing one fetcher (UI-56's lesson).
  const archiveFetcher = useFetcher<ActionResult>();
  useActionFeedback(ownerFetcher);
  useActionFeedback(resolveFetcher);
  useActionFeedback(archiveFetcher);
  const ownerBusy = ownerFetcher.state !== "idle";
  const resolveBusy = resolveFetcher.state !== "idle";
  const archiveBusy = archiveFetcher.state !== "idle";
  // A confirmed edit_goal packet decision drops the human straight into the
  // goal editor (TaskHero opens + focuses it on this signal).
  const [editGoalSignal, setEditGoalSignal] = useState(0);
  useEffect(() => {
    if (
      resolveFetcher.state === "idle" &&
      resolveFetcher.data?.ok &&
      resolveFetcher.data.kind === "edit_goal"
    ) {
      setEditGoalSignal((n) => n + 1);
    }
  }, [resolveFetcher.state, resolveFetcher.data]);

  // Agent affordances (assign/run specialist, reviewers, operator, apply
  // recommendation) are admin|maintainer (contracts §3.2); server re-checks
  // RBAC. The mutations themselves live in ExecutionSection /
  // RecommendationsSection below.
  const canRunAgents = roleCan(myRole as ProjectRole | null, "run-agents");
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");
  // E3: ask for the action the SERVER enforces, not a neighbouring one.
  // `updateTaskGoal` requires `update-goal`; this read `run-agents`, which
  // agrees today only because the matrix happens to line up — a role change to
  // either row silently desyncs the button from the endpoint behind it.
  const canEditGoal = roleCan(myRole as ProjectRole | null, "update-goal");
  // The viewer may resolve THIS packet when they're admin|maintainer OR the
  // task owner (M2 / owner ruling Q2, WIDENED by R14-2). The owner bypass
  // requires `own-task` (contributor+): the server's owner check does too, so a
  // demoted viewer-owner must NOT be shown resolve options that would 403
  // (matches releaseOwner's own-task gate).
  const isOwner =
    task.owner?.kind === "human" && task.owner.userId === me.id && canOwn;
  const canResolvePacket = canRunAgents || isOwner;
  // P14-GV-01/R14-2: acceptance carries the owner exception (R6-2) on the
  // server, and since R14-2 so do apply/dismiss — the owner governs EVERY
  // decision on their own task. This flag used to be `canRunAgents` alone, so a
  // contributor-owner was counted "waiting on you" by the decisions inbox and
  // then shown a blocked Accept option and disabled recommendation buttons.
  const canDecideOwned = canRunAgents || isOwner;
  // An `archive_task` packet option runs the R14-3 archive, whose authority is
  // the board-management tier (`approve-transition`) — NOT the packet-resolver
  // set. A contributor-owner may resolve the packet but not this option, so the
  // card blocks it with the reason instead of 403ing on click (same treatment
  // as edit_goal / accept_completion).
  const canArchiveViaPacket = roleCan(
    myRole as ProjectRole | null,
    "approve-transition",
  );

  // F7-UI1: "operator active" reflects a LIVE operator run (queued/running),
  // never mere attachment. The runtime projection already carries kind+state.
  const operatorRunActive = runtime.some(
    (r) =>
      r.kind === "operator" &&
      (r.lifecycle === "running" || r.lifecycle === "queued"),
  );
  // Any live run (operator, specialist, or reviewer) drives the working pill.
  // `waiting` also covers the short window before a runtime row exists.
  const anyRunLive =
    task.waiting === "agent" ||
    runtime.some(
      (r) => r.lifecycle === "running" || r.lifecycle === "queued",
    );
  // Terminal-stage OR archived task — closed for new work (comments stay open,
  // R7-6). F15-11: archived tasks used to keep every live control.
  const taskClosed =
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged" ||
    archived;

  // F15-10/R15-1: accepting merges the PR — it fires only through the confirm
  // dialog (which states PR, revision, verdict state and target branch), for
  // BOTH plain accept and the admin force-accept.
  const [confirmAccept, setConfirmAccept] = useState<null | "accept" | "force">(
    null,
  );
  const acceptFetcher = useFetcher<ActionResult>();
  useActionFeedback(acceptFetcher);
  const acceptBusy = acceptFetcher.state !== "idle";
  const submitAccept = () => {
    if (acceptBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "accept-completion");
    acceptFetcher.submit(fd, { method: "post" });
  };

  // R15-2 safety net (b): manual delivery from the GitHub panel.
  const deliverFetcher = useFetcher<ActionResult>();
  useActionFeedback(deliverFetcher);
  const deliverBusy = deliverFetcher.state !== "idle";
  const onDeliver = () => {
    if (deliverBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "deliver-review");
    deliverFetcher.submit(fd, { method: "post" });
  };

  // Dedicated run-log SSE consumer (own EventSource; NOT useLiveUpdates —
  // phase-6 report). Seeds from the loader's runtime[].lines + raw; tails
  // live lines via run.log-appended; revalidates on run.state-changed.
  const { linesByThread, streamError, olderByThread, loadOlder } = useRunLogStream({
    projectSlug: task.projectSlug,
    taskKey: task.key,
    threads: runtime.map((r) => ({
      threadId: r.id,
      runId: r.serverRunId,
      lines: r.lines.map((display, i) => ({ display, raw: r.raw[i] ?? "" })),
      // P13-D-11: the loader ships a BOUNDED window of each agent group's
      // console (NFR5). The window carries the live-tail seed (`headSeq`) and
      // the backward cursor the console pages the rest of the history with.
      window: r.logWindow,
    })),
    // F22: bounds a stale "running" strip if a finalize event is missed.
    hasActiveRun: runtime.some((r) => r.state === "running"),
    // UI-30: a non-member's tail requests 403 — don't open a stream that can
    // only fail (it used to 403 silently on every appended line).
    enabled: runsVisible,
  });

  const {
    runBusy,
    canInterrupt,
    onInterrupt,
    onRetryBackend,
    onCompleteMerge,
    onForceAccept,
  } = useRunControls({
    csrf,
    runtime,
    myRole,
    canRunAgents,
    acceptanceTerminallyBlocked: acceptance.terminallyBlocked,
  });
  const { shownLogSel, selectLog, onViewLogs, onAgentLog } =
    useLogSelection(runtime);

  const onOwner = (action: OwnerAction, member?: TaskMemberView) => {
    if (ownerBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    if (action === "assign" && member) {
      fd.set("intent", "owner-assign");
      fd.set("userId", member.userId);
    } else if (action === "release") {
      fd.set("intent", "owner-release");
    } else {
      fd.set("intent", "owner-take");
    }
    ownerFetcher.submit(fd, { method: "post" });
  };

  // R14-3: archiving asks first (it withdraws the open decision); restoring is
  // additive and reversible, so it submits straight away.
  const submitArchive = (nextArchived: boolean) => {
    if (archiveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", nextArchived ? "archive-task" : "restore-task");
    archiveFetcher.submit(fd, { method: "post" });
  };

  const onResolve = (optionIndex: number, note = "") => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", String(optionIndex));
    if (note.trim()) fd.set("note", note);
    resolveFetcher.submit(fd, { method: "post" });
  };

  return (
    <div
      className="detail"
      ref={detailRef}
      tabIndex={-1}
      data-screen-label={"Task " + task.key}
    >
      <div className="detail-main">
        <TaskHero
          task={task}
          stage={stage}
          canEditGoal={canEditGoal}
          archived={archived}
          agentWorking={anyRunLive}
          editGoalSignal={editGoalSignal}
        />

        {runtime.length > 0 ? (
          <LiveRunPanel
            runtime={runtime}
            onViewLogs={onViewLogs}
            onInterrupt={onInterrupt}
            canInterrupt={canInterrupt}
            interrupting={runBusy}
          />
        ) : null}

        <DiagnosticsPanel diagnostics={task.diagnostics} />

        {task.packet && (
          <DecisionPacket
            packet={task.packet}
            busy={resolveBusy}
            canResolve={canResolvePacket}
            canResolveCompletion={canDecideOwned}
            // UI-42: an owner-only resolver must not be offered a decision they
            // cannot then carry out — so this asks for `update-goal`, the grant
            // `updateTaskGoal` itself enforces (E3).
            canEditGoal={canEditGoal}
            canArchive={canArchiveViaPacket}
            onResolve={onResolve}
            onAsk={() => setAsk((a) => a + 1)}
          />
        )}

        <RecommendationsSection
          recommendations={recommendations}
          canApply={canDecideOwned}
        />

        <ScheduledActions
          schedules={schedules}
          canRunAgents={canRunAgents}
          taskClosed={taskClosed}
        />

        <ExecutionSection
          task={task}
          meId={me.id}
          myRole={myRole}
          members={members}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
          deployedSpecialists={deployedSpecialists}
          operatorBackend={operatorBackend}
          backendAvailable={backendAvailable}
          canRunAgents={canRunAgents}
          deliveringActive={deliveringActive}
          activeReviewerIds={activeReviewerIds}
          operatorRunActive={operatorRunActive}
        />

        {runtime.length > 0 && runsVisible ? (
          <AgentLogsPanel
            runtime={runtime}
            sel={shownLogSel}
            onSel={selectLog}
            linesByThread={linesByThread}
            {...(onRetryBackend ? { onRetryBackend } : {})}
            retrying={runBusy}
            streamError={streamError}
            olderByThread={olderByThread}
            onLoadOlder={loadOlder}
          />
        ) : null}
        {/* UI-30: raw console output, the `{ } raw` wire envelopes and the
            provider session id are project-member material (the two routes that
            serve the same data require membership). Say so rather than render an
            empty console or, as before, hand them to any signed-in user. */}
        {runtime.length > 0 && !runsVisible ? (
          <section className="panel" data-comment-anchor="agent-logs">
            <div className="panel-head">
              <Icon name="cpu" />
              <h2>Agent logs</h2>
            </div>
            <p className="empty" style={{ padding: "1rem .5rem" }}>
              Raw agent output, wire envelopes and provider session ids are
              limited to project members. The run summary above is public to
              signed-in users.
            </p>
          </section>
        ) : null}

        <Timeline
          events={task.timeline}
          hasMore={timelineHasMore}
          remaining={timelineRemaining}
          nextLimit={timelineNextLimit}
          tlDefault={tlDefault}
          ask={ask}
          mentionables={mentionables}
          onAgentLog={onAgentLog}
          taskClosed={taskClosed}
        />
      </div>

      <div className="detail-side">
        <GithubTrace
          task={task}
          githubHost={githubHost}
          reconciledAt={githubReconciledAt}
          {...(onCompleteMerge ? { onCompleteMerge } : {})}
          {...(onForceAccept
            ? { onForceAccept: () => setConfirmAccept("force") }
            : {})}
          {...(canDeliver && !taskClosed ? { onDeliver } : {})}
          delivering={deliverBusy}
          merging={runBusy}
        />
        <CurrentStatePanel
          task={task}
          stage={stage}
          meId={me.id}
          myRole={myRole}
          archived={archived}
          acceptance={acceptance}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
          onArchive={() => (archived ? submitArchive(false) : setArchiving(true))}
          onAccept={() => setConfirmAccept("accept")}
          acceptBusy={acceptBusy}
          dispositionBusy={archiveBusy}
        />
        <PolicyPanel
          projectSlug={task.projectSlug}
          myRole={myRole}
          stages={task.stages}
          ownsTask={isOwner}
        />
      </div>

      {confirmAccept && (
        <AcceptConfirm
          task={task}
          workRevisionSha={workRevisionSha}
          defaultBranch={defaultBranch}
          force={confirmAccept === "force"}
          blockedReason={
            confirmAccept === "force"
              ? (task.blockReason ??
                acceptance.blockedReason ??
                (task.packet?.type === "blocked"
                  ? "An open blocked decision is holding this task."
                  : null))
              : acceptance.blockedReason
          }
          busy={acceptBusy || runBusy}
          onCancel={() => setConfirmAccept(null)}
          onConfirm={() => {
            const mode = confirmAccept;
            setConfirmAccept(null);
            if (mode === "force") onForceAccept?.();
            else submitAccept();
          }}
        />
      )}

      {archiving && (
        <ArchiveConfirm
          task={task}
          pendingRecommendations={recommendations.length}
          busy={archiveBusy}
          onCancel={() => setArchiving(false)}
          onConfirm={() => {
            setArchiving(false);
            submitArchive(true);
          }}
        />
      )}

      {releasing && (
        <ReleaseConfirm
          task={task}
          me={me}
          members={members}
          busy={ownerBusy}
          onCancel={() => setReleasing(false)}
          onConfirm={() => {
            setReleasing(false);
            onOwner("release");
          }}
          onOwner={onOwner}
        />
      )}
    </div>
  );
}
