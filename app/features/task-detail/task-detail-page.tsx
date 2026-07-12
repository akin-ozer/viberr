import { useEffect, useRef, useState } from "react";
import {
  Link,
  useFetcher,
  useNavigate,
  type FetcherWithComponents,
} from "react-router";
import type {
  DiagnosticRecord,
  TaskDetail,
} from "~/server/projections/task-query.server";
import { Avatar } from "~/ui/avatar";
import { ArchivedBadge } from "~/ui/archived-badge";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import { StageMenu } from "~/ui/stage-menu";
import { useToast } from "~/ui/toast";
import { DecisionPacket } from "./decision-packet";
import {
  type OperatorExecutionStatus,
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
import { AgentLogsSlot, LiveRunSlot } from "./runtime-slots";
import { Timeline, type TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { RunView } from "~/features/runtime/runtime-types";
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
  | {
      ok: true;
      toast?: string;
      toastKind?: "success" | "info";
      navigateTo?: string;
    }
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
      if (d.toast) push({ kind: d.toastKind ?? "success", text: d.toast });
      if (d.navigateTo) navigate(d.navigateTo);
    } else if (d.error) {
      // E.g. "This packet was already resolved." — revalidation has already
      // refreshed the panel; surface the reason, never crash (spec §7).
      push({ kind: "error", text: d.error });
    }
  }, [fetcher.state, fetcher.data, push, navigate]);
}

export function GithubTrace({
  task,
  githubHost,
  onCompleteMerge,
  merging,
}: {
  task: TaskDetail;
  /** github.com web host for browse links. */
  githubHost?: string;
  /** Run the real merge for an accepted (merge-pending) PR (S2). */
  onCompleteMerge?: () => void;
  merging?: boolean;
}) {
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
      </div>
    );
  }
  // Real external link (spec §4.9: the prototype toast goes away): the PR
  // when one exists, else the branch tree. Host comes from the loader
  // supplied by the server so every GitHub browse link shares one host.
  const host = githubHost ?? "https://github.com";
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
          <Pill kind={task.pr.state === "merged" ? "done" : "info"} sm>
            {task.pr.state === "merged"
              ? "merged"
              : task.pr.state === "accepted"
                ? `PR #${task.pr.number} · merge pending`
                : "PR #" + task.pr.number}
          </Pill>
        ) : (
          <Pill kind="neutral" sm>
            no PR
          </Pill>
        )}
      </div>
      <div className="gh-body">
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
              {task.changed.files} files ·{" "}
              <span style={{ color: "var(--teal-dark)" }}>
                +{task.changed.add}
              </span>{" "}
              <span style={{ color: "var(--coral-dark)" }}>
                −{task.changed.del}
              </span>
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
        {(task.pr?.state === "accepted" || task.pr?.state === "merged") &&
          onCompleteMerge && (
            <button
              type="button"
              className="btn primary sm"
              style={{ marginTop: ".8rem", width: "100%" }}
              disabled={merging}
              onClick={onCompleteMerge}
              title={
                task.pr.state === "merged"
                  ? "Finalize this externally merged, accepted completion"
                  : "Run the real GitHub merge for this accepted PR (needs a valid project credential)"
              }
            >
              <Icon name="check" />
              Complete merge
            </button>
          )}
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
  canAcceptCompletion,
}: {
  projectSlug: string;
  myRole: string | null;
  canAcceptCompletion: boolean;
}) {
  const admin = myRole === "admin";
  const r = (myRole as ProjectRole | null) ?? null;
  const role = myRole || "viewer";
  // Render exactly what the canonical matrix (app/shared/rbac.ts) enforces for
  // THIS viewer's role — no aspirational copy that the server would 403.
  const rows: {
    k: string;
    v: string;
    icon: "user" | "flag" | "plus" | "message" | "cpu" | "lock";
  }[] = [
    {
      k: "Your role",
      v: role.charAt(0).toUpperCase() + role.slice(1),
      icon: "user",
    },
    { k: "Comments", v: "Every registered user", icon: "message" },
    {
      k: "Task ownership",
      v: roleCan(r, "own-task")
        ? admin
          ? "Take / release · admin releases anyone"
          : "Take / release your own seat"
        : "View only — contributor+ to own",
      icon: "plus",
    },
    {
      k: "Accept completion",
      v: canAcceptCompletion
        ? roleCan(r, "accept-completion")
          ? "You can accept → Done"
          : "You can accept tasks you own → Done"
        : "Maintainer or admin only",
      icon: "flag",
    },
    {
      k: "Run agents",
      v: roleCan(r, "run-agents")
        ? "You can run agents"
        : "Maintainer or admin only",
      icon: "cpu",
    },
    {
      k: "Review → Done",
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
          style={{ fontSize: ".72rem", color: "var(--faint)" }}
        >
          V1 rules
        </span>
      </div>
      <p
        style={{
          margin: "0 0 .55rem",
          fontSize: ".74rem",
          lineHeight: 1.4,
          color: "var(--faint)",
        }}
      >
        Fixed platform rules — identical for every task. This task's live stage,
        owner and waiting-on are in <b>Current state</b> above.
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

/** Packet-independent acceptance control for a healthy task at the governed
 * Review boundary. Operator packets and recommendations can still offer the
 * same decision, but they are not required for an owner to act. */
export function CompletionAcceptance({
  taskKey,
  busy,
  onAccept,
}: {
  taskKey: string;
  busy: boolean;
  onAccept: () => void;
}) {
  return (
    <section
      className="panel completion-acceptance"
      aria-label="Completion acceptance"
    >
      <div className="panel-head">
        <Icon name="check" />
        <h2>Ready for acceptance</h2>
        <span className="right">
          <Pill kind="done" dot>
            validation healthy
          </Pill>
        </span>
      </div>
      <div className="completion-acceptance-body">
        <div>
          <strong>The Review boundary is ready.</strong>
          <p>
            Accept {taskKey} directly. Repository-backed work stays in Review
            until the linked pull request is merged.
          </p>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={onAccept}
        >
          <Icon name="check" />
          Accept completion
        </button>
      </div>
    </section>
  );
}

/** Diagnostic severity → pill kind (pure; module scope so it isn't rebuilt per render). */
const kind = (severity: string) =>
  severity === "error"
    ? "blocked"
    : severity === "warning"
      ? "input"
      : "neutral";

/** Parse/inconsistency findings from the projection (tolerant-parsing
 * contract) — compact list, only when the projection carries any. The full
 * diagnostics console arrives in Phase 10. */
function DiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: DiagnosticRecord[];
}) {
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
function TaskHero({
  task,
  stage,
  canEditGoal,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  canEditGoal: boolean;
}) {
  const goalFetcher = useFetcher<ActionResult>();
  const csrf = useCsrfToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.goal);
  // Surface a failed save as a toast instead of silently leaving the editor
  // open with no explanation (WI-11); on success the effect below closes it.
  useActionFeedback(goalFetcher);
  // Close the editor once a save round-trips successfully.
  useEffect(() => {
    if (goalFetcher.state === "idle" && goalFetcher.data?.ok && editing) {
      setEditing(false);
    }
  }, [goalFetcher.state, goalFetcher.data, editing]);

  return (
    <div className="task-hero">
      <span className="key">{task.key}</span>
      <h1>{task.title}</h1>
      <div className="hero-meta">
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
        <ReadinessPill value={task.displayReadiness} />
        <ValidationPill value={task.validation} />
        <span className="hero-file">
          <Icon name="file" />
          <span>{task.filePath}</span>
        </span>
      </div>
      {editing && canEditGoal ? (
        <goalFetcher.Form
          method="post"
          className="goal-edit"
          onSubmit={() => setEditing(true)}
        >
          <input type="hidden" name="intent" value="update-goal" />
          <input type="hidden" name="_csrf" value={csrf} />
          <textarea
            name="goal"
            className="goal-textarea"
            defaultValue={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            rows={4}
            aria-label="Task goal and acceptance criteria"
          />
          <div className="goal-edit-actions">
            <button
              type="submit"
              className="btn btn-primary"
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
  canApplyCompletion,
}: {
  recommendations: RecommendationView[];
  canApply: boolean;
  canApplyCompletion: boolean;
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
      canApplyCompletion={canApplyCompletion}
      busy={recBusy}
      onApply={onApplyRec}
      onDismiss={onDismissRec}
    />
  );
}

/** Execution profile plus the specialist / reviewer / operator mutations it drives. */
function ExecutionSection({
  task,
  meId,
  myRole,
  canOwnTasks,
  members,
  ownerBusy,
  onOwner,
  onRelease,
  deployedSpecialists,
  canRunAgents,
  runActive,
  operatorStatus,
}: {
  task: TaskDetail;
  meId: string;
  myRole: string | null;
  canOwnTasks: boolean;
  members: TaskMemberView[];
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
  deployedSpecialists: DeployedSpecialistView[];
  canRunAgents: boolean;
  runActive: boolean;
  operatorStatus: OperatorExecutionStatus;
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
    if (specialistBusy || runActive) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-specialist");
    specialistFetcher.submit(fd, { method: "post" });
  };

  // Reviewer engagement (admin|maintainer; server re-checks). Assign a deployed
  // specialist as a reviewer, run a specific reviewer (gated on runActive so
  // one run streams at a time, same as the primary), or release one.
  const onAssignReviewer = (profileId: string) => {
    if (reviewerBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "assign-reviewer");
    fd.set("profileId", profileId);
    reviewerFetcher.submit(fd, { method: "post" });
  };
  const onRunReviewer = (profileId: string) => {
    if (reviewerBusy || runActive) return;
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
      canOwnTasks={canOwnTasks}
      members={members}
      busy={ownerBusy}
      onOwner={onOwner}
      onRelease={onRelease}
      deployedSpecialists={deployedSpecialists}
      canRunAgents={canRunAgents}
      runActive={runActive}
      runBusy={specialistBusy}
      onAssignSpecialist={onAssignSpecialist}
      onRunSpecialist={onRunSpecialist}
      reviewerBusy={reviewerBusy}
      onAssignReviewer={onAssignReviewer}
      onRunReviewer={onRunReviewer}
      onRemoveReviewer={onRemoveReviewer}
      operatorBusy={
        operatorBusy ||
        operatorStatus === "queued" ||
        operatorStatus === "running"
      }
      operatorStatus={operatorStatus}
      onRunOperator={onRunOperator}
    />
  );
}

/** Sidebar "Current state" panel — stage (with governed transition menu),
 * waiting-on, owner controls, repo. */
function CurrentStatePanel({
  task,
  stage,
  meId,
  myRole,
  projectRole,
  ownerBusy,
  onOwner,
  onRelease,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  meId: string;
  myRole: string | null;
  projectRole: string | null;
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
}) {
  const csrf = useCsrfToken();
  const transitionFetcher = useFetcher<ActionResult>();
  useActionFeedback(transitionFetcher);

  // Manual stage change from the Current-state dropdown (admin|maintainer; the
  // server re-checks). Goes through the same governed transition that an applied
  // operator recommendation does, so it posts the **Transition:** timeline
  // comment and hands the task to the operator at its new stage.
  const canTransition = roleCan(
    myRole as ProjectRole | null,
    "approve-transition",
  );
  const canOwn = roleCan(projectRole as ProjectRole | null, "own-task");
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

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bolt" />
        <h2>Current state</h2>
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
              <span style={{ color: "var(--blue-pressed)" }}>
                Human decision
              </span>
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
                {((ownerMine && canOwn) || myRole === "admin") && (
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
    </div>
  );
}

export function TaskDetailPage({
  task,
  runtime,
  deployedSpecialists,
  runActive,
  operatorStatus,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  members,
  me,
  myRole,
  projectRole,
  mentionables,
  recommendations,
  reviewStageId,
  githubHost,
  readOnly = false,
}: {
  /** Loader detail — `task.timeline` is the bounded newest-first slice. */
  task: TaskDetail;
  /** Per-task run projection (Phase 8). */
  runtime: RunView[];
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** A run for this task is currently running — disables the Run button. */
  runActive: boolean;
  /** Configured/engaged is not active; only a live run receives that label. */
  operatorStatus: OperatorExecutionStatus;
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  members: TaskMemberView[];
  me: { id: string; name: string };
  myRole: string | null;
  /** Explicit membership role; unlike myRole it never includes org override. */
  projectRole?: string | null;
  /** @-mention autocomplete directory for the comment composer (loader). */
  mentionables: Mentionables;
  /** Pending operator recommendation cards (loader — from the task file). */
  recommendations: RecommendationView[];
  /** Governed stage whose workflow edge enters the terminal stage. */
  reviewStageId: string | null;
  /** github.com web host for browse links. */
  githubHost?: string;
  /** Archived task history stays navigable but exposes no mutations. */
  readOnly?: boolean;
}) {
  const stage = task.stages.find((s) => s.id === task.stage);
  const [logSel, setLogSel] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
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
  const runFetcher = useFetcher<ActionResult>();
  useActionFeedback(ownerFetcher);
  useActionFeedback(resolveFetcher);
  useActionFeedback(runFetcher);
  const ownerBusy = ownerFetcher.state !== "idle";
  const resolveBusy = resolveFetcher.state !== "idle";
  const runBusy = runFetcher.state !== "idle";

  // Agent affordances (assign/run specialist, reviewers, operator, apply
  // recommendation) are admin|maintainer (contracts §3.2); server re-checks
  // RBAC. The mutations themselves live in ExecutionSection /
  // RecommendationsSection below.
  const explicitProjectRole = projectRole === undefined ? myRole : projectRole;
  const canRunAgents =
    !readOnly && roleCan(myRole as ProjectRole | null, "run-agents");
  const canOwn =
    roleCan(explicitProjectRole as ProjectRole | null, "own-task") && !readOnly;
  // The viewer may resolve THIS packet when they're admin|maintainer OR the
  // task owner (M2 / owner ruling Q2). Completion is also task-scoped: the
  // active contributor+ owner may accept this task, but no other contributor
  // gains project-wide completion authority.
  // The owner bypass requires `own-task` (contributor+): the server's owner
  // check does too, so a demoted viewer-owner must NOT be shown resolve options
  // that would 403 (matches releaseOwner's own-task gate).
  const isOwner =
    task.owner?.kind === "human" && task.owner.userId === me.id && canOwn;
  const canResolvePacket = canRunAgents || isOwner;
  const canAcceptCompletion = canRunAgents || isOwner;
  const atCompletionBoundary =
    reviewStageId !== null && task.stage === reviewStageId;
  const hasAcceptanceArtifact =
    task.packet?.options.some(
      (option) => option.kind === "accept_completion",
    ) ||
    recommendations.some(
      (recommendation) => recommendation.kind === "accept_completion",
    );
  const completionAlreadyAccepted =
    task.pr?.state === "accepted" || task.pr?.state === "merged";
  const offerDirectAcceptance =
    canAcceptCompletion &&
    atCompletionBoundary &&
    task.validation === "healthy" &&
    !hasAcceptanceArtifact &&
    !completionAlreadyAccepted;

  // Dedicated run-log SSE consumer (own EventSource; NOT useLiveUpdates —
  // phase-6 report). Seeds from the loader's runtime[].lines + raw; tails
  // live lines via run.log-appended; revalidates on run.state-changed.
  const { linesByThread } = useRunLogStream({
    projectSlug: task.projectSlug,
    taskKey: task.key,
    threads: runtime.map((r) => ({
      threadId: r.id,
      runId: r.serverRunId,
      lines: r.lines.map((display, i) => ({ display, raw: r.raw[i] ?? "" })),
    })),
  });

  // Interrupt is admin|maintainer (contracts §3.2); the button hides for
  // everyone else. Server re-checks RBAC regardless.
  const canInterrupt = canRunAgents;
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
  // Retry the assigned specialist on the OTHER backend after a backend
  // availability / quota failure (D4). admin|maintainer; server re-checks.
  const onRetryBackend =
    canRunAgents && !runActive
      ? (backend: "claude" | "codex") => {
          if (runBusy) return;
          const fd = new FormData();
          fd.set("_csrf", csrf);
          fd.set("intent", "run-specialist");
          fd.set("backend", backend);
          runFetcher.submit(fd, { method: "post" });
        }
      : undefined;
  // Complete/finalize accepted repository work. The same task-scoped owner
  // authority that accepts completion also applies after a merge is pending or
  // GitHub reports that the accepted PR was merged externally.
  const canMerge = canAcceptCompletion && atCompletionBoundary;
  const onCompleteMerge = canMerge
    ? () => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "complete-merge");
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  // BUG 3: commenting an @agent auto-selects that agent's grouped log entry and
  // scrolls the Agent-logs panel into view. The reply run is the group
  // representative → selecting its id shows its live output (streamed by the
  // existing useRunLogStream). Revalidation (fired by the comment fetcher)
  // brings the run into `runtime`; the pending id is kept until it appears so
  // the selection lands after revalidation, not before it.
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

  const onResolve = (optionIndex: number) => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", String(optionIndex));
    resolveFetcher.submit(fd, { method: "post" });
  };

  const onAcceptCompletion = () => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "accept-completion");
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
        {readOnly && <ArchivedBadge />}
        <TaskHero task={task} stage={stage} canEditGoal={canRunAgents} />

        <LiveRunSlot
          runtime={runtime}
          onViewLogs={onViewLogs}
          onInterrupt={onInterrupt}
          canInterrupt={canInterrupt}
          interrupting={runBusy}
        />

        <DiagnosticsPanel diagnostics={task.diagnostics} />

        {task.packet && (
          <DecisionPacket
            packet={task.packet}
            busy={resolveBusy}
            canResolve={canResolvePacket}
            canResolveCompletion={canRunAgents || isOwner}
            canAsk={!readOnly}
            onResolve={onResolve}
            onAsk={() => setAsk((a) => a + 1)}
          />
        )}

        {offerDirectAcceptance && (
          <CompletionAcceptance
            taskKey={task.key}
            busy={resolveBusy}
            onAccept={onAcceptCompletion}
          />
        )}

        <RecommendationsSection
          recommendations={recommendations}
          canApply={canRunAgents}
          canApplyCompletion={isOwner}
        />

        <ExecutionSection
          task={task}
          meId={me.id}
          myRole={readOnly ? null : myRole}
          canOwnTasks={canOwn}
          members={members}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
          deployedSpecialists={deployedSpecialists}
          canRunAgents={canRunAgents}
          runActive={runActive}
          operatorStatus={operatorStatus}
        />

        <AgentLogsSlot
          runtime={runtime}
          logSel={shownLogSel}
          onLogSel={selectLog}
          linesByThread={linesByThread}
          {...(onRetryBackend ? { onRetryBackend } : {})}
          retrying={runBusy}
        />

        <Timeline
          events={task.timeline}
          hasMore={timelineHasMore}
          remaining={timelineRemaining}
          nextLimit={timelineNextLimit}
          tlDefault={tlDefault}
          ask={ask}
          mentionables={mentionables}
          onAgentLog={onAgentLog}
          readOnly={readOnly}
        />
      </div>

      <div className="detail-side">
        <GithubTrace
          task={task}
          {...(githubHost ? { githubHost } : {})}
          {...(onCompleteMerge ? { onCompleteMerge } : {})}
          merging={runBusy}
        />
        <CurrentStatePanel
          task={task}
          stage={stage}
          meId={me.id}
          myRole={readOnly ? null : myRole}
          projectRole={readOnly ? null : explicitProjectRole}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
        />
        <PolicyPanel
          projectSlug={task.projectSlug}
          myRole={myRole}
          canAcceptCompletion={!readOnly && canAcceptCompletion}
        />
      </div>

      {releasing && !readOnly && (
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
