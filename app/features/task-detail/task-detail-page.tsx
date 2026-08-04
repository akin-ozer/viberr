import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { AcceptConfirm } from "./accept-confirm";
import { ArchiveConfirm } from "./archive-confirm";
import { DecisionPacket } from "./decision-packet";
import type {
  DeployedSpecialistView,
  OwnerAction,
  TaskMemberView,
} from "./execution-profile";
import { ReleaseConfirm } from "./release-confirm";
import type { RecommendationView } from "./operator-recommendations";
import { Timeline, type TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import {
  useActionFeedback,
  useLogSelection,
  useRunControls,
  type ActionResult,
} from "./task-detail-hooks";
import {
  CurrentStatePanel,
  GithubTrace,
  PolicyPanel,
} from "./task-side-panels";
import {
  DiagnosticsPanel,
  ExecutionSection,
  RecommendationsSection,
  ScheduledActions,
  TaskHero,
} from "./task-main-sections";

/**
 * Task detail workspace — port of TaskDetail (task.jsx). Operator-first
 * layout order is a contract (spec §2): hero → live run strip → decision
 * packet → execution profile → agent logs → timeline; sidebar: GitHub
 * trace → current state → permissions. All mutations are route actions
 * (revalidation, no optimistic governed state); toast copy comes back from
 * the action (verbatim spec §5 strings).
 *
 * Pass 16 split this file (1811 lines) along that same contract — a pure
 * structural refactor, no behaviour or copy change. What stayed here is the
 * composition and the 13 fetchers; the pieces live in `task-detail-hooks.ts`,
 * `task-main-sections.tsx` and `task-side-panels.tsx`.
 */

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
