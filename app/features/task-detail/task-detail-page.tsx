import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate, type FetcherWithComponents } from "react-router";
import type { DiagnosticRecord, TaskDetail } from "~/server/projections/task-query.server";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { DecisionPacket } from "./decision-packet";
import {
  ExecutionProfile,
  type DeployedSpecialistView,
  type OwnerAction,
  type TaskMemberView,
} from "./execution-profile";
import { ReleaseConfirm } from "./release-confirm";
import { AgentLogsSlot, LiveRunSlot } from "./runtime-slots";
import { Timeline, type TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { RunView } from "~/features/runtime/runtime-types";
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
  | { ok: true; toast?: string; navigateTo?: string }
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
      push(d.error);
    }
  }, [fetcher.state, fetcher.data, push, navigate]);
}

function GithubTrace({ task }: { task: TaskDetail }) {
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
  // when one exists, else the branch tree. Phase 7 may refine targets.
  const ghHref = task.repo
    ? task.pr
      ? `https://github.com/${task.repo}/pull/${task.pr.number}`
      : task.branch
        ? `https://github.com/${task.repo}/tree/${task.branch}`
        : `https://github.com/${task.repo}`
    : null;
  return (
    <div className="panel flush">
      <div className="gh-bar">
        <Icon name="github" />
        <span className="repo">{task.repo}</span>
        {task.pr ? (
          <Pill kind={task.pr.state === "merged" ? "done" : "info"} sm>
            {task.pr.state === "merged" ? "merged" : "PR #" + task.pr.number}
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
            {task.commits.map((c, i) => (
              <div className="commit" key={i}>
                <span className="sha">{c.sha}</span>
                <span className="msg">{c.msg}</span>
              </div>
            ))}
          </div>
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
}: {
  projectSlug: string;
  myRole: string | null;
}) {
  const admin = myRole === "admin";
  const role = myRole || "viewer";
  const rows: { k: string; v: string; icon: "user" | "flag" | "plus" | "message" | "cpu" | "lock" }[] = [
    { k: "Your role", v: role.charAt(0).toUpperCase() + role.slice(1), icon: "user" },
    { k: "Task owner", v: "Reviews & accepts · that task only", icon: "flag" },
    {
      k: "Ownership",
      v: admin ? "Take / release · admin: anyone" : "Take / release · yours",
      icon: "plus",
    },
    { k: "Comments", v: "Every registered user", icon: "message" },
    { k: "Agent may", v: "Request transition", icon: "cpu" },
    { k: "Transition to done", v: "Human owner only", icon: "lock" },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Permissions</h2>
      </div>
      {rows.map((r, i) => (
        <div className="policy-line" key={i}>
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

/** Parse/inconsistency findings from the projection (tolerant-parsing
 * contract) — compact list, only when the projection carries any. The full
 * diagnostics console arrives in Phase 10. */
function DiagnosticsPanel({ diagnostics }: { diagnostics: DiagnosticRecord[] }) {
  if (diagnostics.length === 0) return null;
  const kind = (severity: string) =>
    severity === "error" ? "blocked" : severity === "warning" ? "input" : "neutral";
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

export function TaskDetailPage({
  task,
  runtime,
  deployedSpecialists,
  runActive,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  members,
  me,
  myRole,
  mentionables,
}: {
  /** Loader detail — `task.timeline` is the bounded newest-first slice. */
  task: TaskDetail;
  /** Per-task run projection (Phase 8). */
  runtime: RunView[];
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** A run for this task is currently running — disables the Run button. */
  runActive: boolean;
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  members: TaskMemberView[];
  me: { id: string; name: string };
  myRole: string | null;
  /** @-mention autocomplete directory for the comment composer (loader). */
  mentionables: Mentionables;
}) {
  const stage = task.stages.find((s) => s.id === task.stage);
  const [logSel, setLogSel] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [ask, setAsk] = useState(0);
  const csrf = useCsrfToken();

  const ownerFetcher = useFetcher<ActionResult>();
  const resolveFetcher = useFetcher<ActionResult>();
  const runFetcher = useFetcher<ActionResult>();
  const specialistFetcher = useFetcher<ActionResult>();
  const reviewerFetcher = useFetcher<ActionResult>();
  useActionFeedback(ownerFetcher);
  useActionFeedback(resolveFetcher);
  useActionFeedback(runFetcher);
  useActionFeedback(specialistFetcher);
  useActionFeedback(reviewerFetcher);
  const ownerBusy = ownerFetcher.state !== "idle";
  const resolveBusy = resolveFetcher.state !== "idle";
  const runBusy = runFetcher.state !== "idle";
  const specialistBusy = specialistFetcher.state !== "idle";
  const reviewerBusy = reviewerFetcher.state !== "idle";

  // Assign a deployed specialist / start a specialist run — admin|maintainer
  // (contracts §3.2); server re-checks RBAC. The ExecutionProfile only renders
  // these affordances when canRunAgents.
  const canRunAgents = myRole === "admin" || myRole === "maintainer";
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
  const canInterrupt = myRole === "admin" || myRole === "maintainer";
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
  const onViewLogs = (id: string) => {
    setLogSel(id);
    // Scroll the logs panel into view (spec §5.2 addition).
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  // BUG 3: commenting an @agent auto-selects that agent's grouped log entry and
  // scrolls the Agent-logs panel into view. The reply run is the group
  // representative → selecting its id shows its live output (streamed by the
  // existing useRunLogStream). Revalidation (fired by the comment fetcher)
  // brings the run into `runtime`; the pending id is kept until it appears so
  // the selection lands after revalidation, not before it.
  const [pendingLogSel, setPendingLogSel] = useState<string | null>(null);
  const onAgentLog = (threadId: string) => {
    setPendingLogSel(threadId);
    setLogSel(threadId);
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  // Once revalidation lands the reply run in `runtime`, confirm the selection
  // (guards against a race where logSel was cleared or the id only just
  // appeared), then clear the pending marker.
  useEffect(() => {
    if (!pendingLogSel) return;
    if (runtime.some((r) => r.id === pendingLogSel)) {
      setLogSel(pendingLogSel);
      setPendingLogSel(null);
    }
  }, [pendingLogSel, runtime]);

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

  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const ownerMine = !!(owner && owner.userId === me.id);

  return (
    <div className="detail" data-screen-label={"Task " + task.key}>
      <div className="detail-main">
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
          <p className="goal">{task.goal}</p>
        </div>

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
            onResolve={onResolve}
            onAsk={() => setAsk((a) => a + 1)}
          />
        )}

        <ExecutionProfile
          task={task}
          meId={me.id}
          myRole={myRole}
          members={members}
          busy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
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
        />

        <AgentLogsSlot
          runtime={runtime}
          logSel={logSel}
          onLogSel={setLogSel}
          linesByThread={linesByThread}
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
        />
      </div>

      <div className="detail-side">
        <GithubTrace task={task} />
        <div className="panel">
          <div className="panel-head">
            <Icon name="bolt" />
            <h2>Current state</h2>
          </div>
          <div className="kv">
            <div className="kv-row">
              <span className="k">Stage</span>
              <span className="v">{stage?.name ?? ""}</span>
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
                    {(ownerMine || myRole === "admin") && (
                      <button
                        type="button"
                        className="own-x"
                        title={
                          ownerMine
                            ? "Release ownership"
                            : "Release " + owner.name.split(" ")[0] + " (admin)"
                        }
                        aria-label="Release owner"
                        onClick={() => setReleasing(true)}
                      >
                        <Icon name="x" />
                      </button>
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="rev-add sm"
                    disabled={ownerBusy}
                    onClick={() => onOwner("take")}
                  >
                    <Icon name="plus" />
                    Assign me
                  </button>
                )}
              </span>
            </div>
            <div className="kv-row">
              <span className="k">Repo</span>
              <span className="v mono">{task.repo}</span>
            </div>
          </div>
        </div>
        <PolicyPanel projectSlug={task.projectSlug} myRole={myRole} />
      </div>

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
