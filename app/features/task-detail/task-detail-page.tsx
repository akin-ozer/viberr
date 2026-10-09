import { useState } from "react";
import { AttachmentLightboxProvider } from "./attachment-lightbox";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { TASK_DECISION_ANCHOR } from "~/shared/page-anchors";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { useCsrfToken } from "~/ui/csrf-input";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type {
  DeployedSpecialistView,
  LiveAgentRun,
  TaskMemberView,
} from "./execution-profile";
import type { RecommendationView } from "./operator-recommendations";
import type { TaskRunPrincipalView } from "./run-principal-view";
import type { CompletionView } from "~/server/tasks/completion-packet.server";
import type { TookCard } from "~/server/tasks/what-it-took.server";
import type { TaskSourceRow } from "~/server/tasks/task-sources.server";
import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import type { TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { useStableRows } from "~/ui/use-stable-rows";
import type { PrOverlap } from "~/shared/pr-overlaps";
import { CurrentStatePanel, GithubTrace } from "./task-side-panels";
import { TaskDetailsPanel } from "./task-details-panel";
import type { EpicOption } from "~/ui/epic-chip";
import { TaskHero } from "./task-main-sections";
import {
  useAcceptCompletion,
  useArchiveControl,
  useIntentPost,
  useOwnerControl,
  usePacketResolution,
  useRecommendationActions,
  useRegionLanding,
  useRunConsole,
  useStageTransition,
  useWorkspaceFocus,
  type PendingAccept,
} from "./task-detail-actions";
import {
  changesPanelReader,
  completionPlacement,
  completionReader,
  epicOf,
  filesDeliveryOf,
  githubTraceDoors,
  isClosedForWork,
  lastStageId,
  taskPermissions,
} from "./task-detail-derive";
import { TaskAcceptConfirm, TaskDecisionRegion } from "./task-detail-regions";
import { TaskMainColumn } from "./task-main-column";

/**
 * Task detail workspace — port of TaskDetail (task.jsx). Operator-first
 * layout order is a contract (spec §2): hero → live run strip → decision
 * packet → execution profile → agent logs → timeline; sidebar: GitHub
 * trace → current state → permissions. All mutations are route actions
 * (revalidation, no optimistic governed state); toast copy comes back from
 * the action (verbatim spec §5 strings).
 *
 * Pass 16 split this file (1811 lines) along that same contract, and ruling
 * 13(b) piloted the split of the large components on it; both are pure
 * structural refactors, no behaviour or copy change. What stays here is the
 * composition: the page's props and defaults, its hooks in the order its 10
 * fetchers register, and the regions of `.detail` in source order. The posts,
 * each with its fetcher, toast, local state and confirm, live in
 * `task-detail-actions.tsx`; what the page reads off its props in
 * `task-detail-derive.ts`; the decision region and the acceptance ceremony in
 * `task-detail-regions.tsx`; the main column in `task-main-column.tsx`; the
 * run controls in `task-detail-hooks.ts`, and the panels in
 * `task-main-sections.tsx` and `task-side-panels.tsx`.
 */

/** A run group's identity in the projection (`useStableRows`' key). */
function runThreadKey(run: RunView): string {
  return run.id;
}

/** Ruling 317: a task that keeps no sources, as one list every render. */
const NO_SOURCES: TaskSourceRow[] = [];

interface TaskDetailPageProps {
  /** Loader detail — `task.timeline` is the bounded newest-first slice. */
  task: TaskDetail;
  /** The project's existing label vocabulary, for the Details panel's label
   *  autocomplete. */
  labelSuggestions?: string[];
  /** Ruling 325: the project's epics, for the hero's Epic field and the
   *  Details panel's Epic menu. Empty in a project with none. */
  epics?: EpicOption[];
  /** R19-19: browser-produced files (loader). */
  attachments?: TaskAttachmentEntry[];
  /** Attachment name → who saved it and when (from the events that claim
   *  names). Names no event claims are absent — the panel omits the line. */
  attachmentProducers?: Record<string, { actor: string; occurredAt: string }>;
  /** C8 (pass 25): true total attachment count, so the panel can disclose the
   *  100-item list cap ("showing 100 of N") instead of hiding older evidence. */
  attachmentsTotal?: number;
  /** `/projects/<slug>/tasks/<KEY>/attachments` — the serving route's base,
   *  built by the route component (the one place that knows the params).
   *  Null hides the panel and the evidence links (e.g. bare test renders). */
  attachmentsBase?: string | null;
  /** Ruling 317: the sources the task keeps (loader; absent for a task that
   *  keeps none), newest first. */
  sources?: TaskSourceRow[];
  /** How many it keeps in all: the list stops at the newest hundred. */
  sourcesTotal?: number;
  /** `/projects/<slug>/tasks/<KEY>/sources`, the route that serves one by
   *  its id, built by the route component. Null draws no source as a link. */
  sourcesBase?: string | null;
  /** Ruling 246: `/projects/<slug>/tasks/<KEY>/changes`, the Changes panel's
   *  read, built by the route component. Null hides the panel. */
  changesUrl?: string | null;
  /** Ruling 59: `/projects/<slug>/tasks/<KEY>/dependency-candidates`, the
   *  Blocked by picker's read, built by the route component. Null offers no
   *  list; a key typed in full still goes in. */
  dependencyCandidatesUrl?: string | null;
  /** Ruling 103: the completion packet as the loader read it (Operator's
   *  summary and screenshots, each reviewer's verdict, the change's size);
   *  null while nothing is delivered. */
  completion?: CompletionView | null;
  /** Ruling 83: what the task took, as the completion card prints it; null
   *  when the loader shipped none (nothing delivered, or a viewer who may not
   *  see the runs). */
  whatItTook?: TookCard | null;
  /** Per-task run projection (Phase 8). */
  runtime: RunView[];
  /** Deployed specialists the run-agent selector offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** The operator's configured backend — the run picker's default (P11-76). */
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** F37-65: whether the operator's `completion-for-acceptance` grant actually
   *  resolves to `direct` at this autonomy. Autonomy alone does not say. */
  operatorAcceptsDirectly?: boolean;
  /** Ruling 137: whose accounts this task's agent runs bill (the OWNER's) and
   *  what those accounts can run. `null` = unowned, so nothing runs here.
   *  P11-41's "would fail fast" gate, answered per person. */
  runPrincipal: TaskRunPrincipalView | null;
  /** The engagements' live (queued/running) runs (per-agent gating, and the
   *  engaged-agent card's "queued"/"running…" word). */
  liveAgentRuns: LiveAgentRun[];
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  members: TaskMemberView[];
  me: { id: string; name: string };
  myRole: string | null;
  /** @-mention autocomplete directory for the comment composer (loader). */
  mentionables: Mentionables;
  /** U39-31: the other tasks the goal and the timeline name, key to path. */
  taskLinks?: TaskLinks;
  /** Pending operator recommendation cards (loader — from the task file). */
  recommendations: RecommendationView[];
  /** Pending scheduled runs (O-3 generalized, loader — from the task file).
   *  Rendered inside the execution profile's run controls. */
  schedules: TaskSchedule[];
  /** Ruling 66: reviewer questions a dependency hold refused. Optional with
   *  an empty default, like `labelSuggestions`: all but a handful of tasks have
   *  none, and a render built by hand should not have to say so. */
  queuedQuestions?: { id: string; profileId: string; decidedByLabel: string }[];
  /** Ruling 65: what else the open packet's confirm answers, or null. */
  packetAlsoAnswers?: string | null;
  /** Ruling 67: per create_task option index, the tasks that already look
   *  like the one it would create. */
  packetCreateTaskEchoes?: Record<number, { key: string; title: string; stage: string }[]>;
  /** R14-3: the task's archive disposition (loader — from the task file, which
   *  is where it lives; the projection has no column for it). */
  archived?: boolean;
  /** P14-LV-06: the viewer's acceptance authority + the exact refusal, resolved
   *  server-side by the predicate the review queue also counts with. */
  acceptance: AcceptanceAffordance;
  /** GitHub web host for browse links — the loader's `githubWebHost()`. */
  githubHost: string;
  /** UI-57: newest `github.reconcile` for this task (freshness cue) — the last
   *  pass that CHANGED something, see the prop docs on `GithubTrace`. */
  githubReconciledAt?: string | null;
  /** U39-32: base commits the branch lacked at the reconciler's last
   *  compare; null when never compared. */
  baseBehindBy?: number | null;
  /** Ruling 244: the other open PRs this task's merge would likely put in
   *  conflict, for the accept dialog. */
  mergeCollisions?: readonly PrOverlap[];
  /** F19-22: newest COMPLETED reconcile pass for this task (`github.reconcile.task`
   *  audit row). The panel needs both — one number could never say both "the
   *  poller is alive" and "nothing has moved since Tuesday". */
  githubCheckedAt?: string | null;
  /** R15-1: the delivered revision's head sha (task file) for the confirm. */
  workRevisionSha?: string | null;
  /** R17-2: a verified no-change completion (empty branch, no PR). */
  noChanges?: boolean;
  /** Ruling 316: when the task was delivered as files on it, the delivery's time. */
  filesDeliveredAt?: string | null;
  /** The merge target named in the accept confirm — the project's default branch. */
  defaultBranch?: string;
  /** R15-2 safety net (b): the viewer may deliver by hand (maintainer+ or owner). */
  canDeliver?: boolean;
}

/**
 * The task page. Image evidence anywhere on it — timeline thumbnails, inline
 * markdown embeds, the Attachments panel, cited evidence filenames — opens in
 * the in-app lightbox the provider renders (owner request 2026-08-21) instead
 * of a raw-file tab. A markdown attachment renders there, its pictures
 * resolved against the task's files (ruling 317).
 *
 * U35-2 (pass 35): source order IS the reading order at every width,
 * so a screen reader, the Tab key and the one-column phone stack all
 * meet the page in the same sequence. Below 1100px the grid placement
 * drops (app.css) and the DOM order is the stack:
 *   1. `.detail-head`: the task's name and goal. Before this the side
 *      rail came first (U7 chose it for "current state, latest packet,
 *      next action, then the timeline"), but the title and the packet
 *      lived in the main column, so on a 390px viewport a person read
 *      the GitHub card, Current state, Details and Permissions before
 *      the task's name (y=1659 on KNC-6) or the question it asked
 *      (y=2070).
 *   2. `.detail-packet`: the open decision packet, the page's most
 *      important object. Owner, 2026-09-08: its own region, not part of
 *      the head — on desktop it sits at the top of the MAIN column, the
 *      same width as the panels under it, and the side column rises to
 *      sit beside it (a head-wide packet pushed Current state under
 *      the packet). Rendered only while a packet is open, so without
 *      one the two columns meet at the same row as before.
 *   3. `.detail-side`: the GitHub trace first (owner, 2026-09-09,
 *      ruling 308: on desktop it sits at the top right, beside the
 *      goal, where the cell used to be empty), then Current state (the
 *      next action and the acceptance button), then Details. The
 *      Permissions panel that closed the column is gone (owner,
 *      2026-09-08, ruling 308). One order everywhere: the right column
 *      reads GitHub, Current state, Details on desktop, and so does the
 *      phone stack — placement may not reorder what the DOM says.
 *   4. `.detail-main`: the live run, diagnostics, continuity,
 *      recommendations, the run controls, the console and the timeline.
 * On desktop `.detail-head` opens the main column, the side column
 * spans every row beside it, and the regions keep their cells by
 * PLACEMENT (`grid-column`/`grid-row` in app.css), never by `order`,
 * which U7 found re-splits what the eye and the focus ring see (WCAG
 * 2.2 SC 1.3.2 / 2.4.3).
 *
 * Ruling 13(b): each region that is a component of its own (the decision
 * region, the main column, the acceptance ceremony) takes the one slot its
 * markup held here and calls no hook, so `.detail` keeps its ten children and
 * the ids React derives from the tree do not move; the other confirms are
 * elements their hooks build, placed in the order they always stood.
 */
export function TaskDetailPage({
  task,
  labelSuggestions = [],
  epics = [],
  attachments = [],
  attachmentsTotal,
  attachmentProducers = {},
  attachmentsBase = null,
  sources = NO_SOURCES,
  sourcesTotal = 0,
  sourcesBase = null,
  changesUrl = null,
  dependencyCandidatesUrl = null,
  completion = null,
  whatItTook = null,
  runtime: loadedRuntime,
  deployedSpecialists,
  operatorBackend,
  operatorAutonomy,
  operatorAcceptsDirectly = false,
  runPrincipal,
  liveAgentRuns,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  members,
  me,
  myRole,
  mentionables,
  taskLinks = {},
  recommendations,
  schedules,
  queuedQuestions = [],
  packetAlsoAnswers = null,
  packetCreateTaskEchoes = {},
  archived = false,
  acceptance,
  githubHost,
  githubReconciledAt = null,
  baseBehindBy = null,
  mergeCollisions = [],
  githubCheckedAt = null,
  workRevisionSha = null,
  noChanges = false,
  filesDeliveredAt = null,
  defaultBranch = "main",
  canDeliver = false,
}: TaskDetailPageProps) {
  // Ruling 11 (TASK-4): the run projection keeps its objects while their
  // content is unchanged, so a revalidation that moved nothing in it leaves
  // the memoised run card and console alone.
  const runtime = useStableRows(loadedRuntime, runThreadKey);
  const stage = task.stages.find((s) => s.id === task.stage);
  const epic = epicOf(task, epics);
  const [ask, setAsk] = useState(0);
  const onAsk = () => setAsk((a) => a + 1);
  // The acceptance ceremony's pending door (`PendingAccept`): every writer
  // that ends in "Done + real merge" opens it instead of posting.
  const [pendingAccept, setPendingAccept] = useState<PendingAccept | null>(null);
  const csrf = useCsrfToken();
  const detailRef = useWorkspaceFocus();
  const regionMark = useRegionLanding(task.packet, recommendations.length > 0);
  const can = taskPermissions(myRole, task, me.id, archived);

  // The posts, in the order their fetchers have always registered.
  const owner = useOwnerControl(csrf, task, me, members);
  const resolution = usePacketResolution(csrf, task.packet, setPendingAccept);
  const archive = useArchiveControl(csrf, task, archived, recommendations.length);
  const accept = useAcceptCompletion(csrf);
  // R15-2 safety net (b): manual delivery from the GitHub panel.
  const [deliverBusy, onDeliver] = useIntentPost("deliver-review", csrf);
  // Ruling 104: run the project's gates on the revision under review again,
  // from the PR card. Same tier as the manual delivery above.
  const [gatesBusy, onRunGates] = useIntentPost("run-gates", csrf);
  const taskClosed = isClosedForWork(task, archived);
  const terminalStageId = lastStageId(task);
  const runConsole = useRunConsole({
    csrf,
    task,
    runtime,
    myRole,
    canRunAgents: can.canRunAgents,
    runPrincipal,
    acceptance,
  });
  // F20-18: the escalation to a maintainer, offered where
  // `can.canEscalatePacket` says the viewer is stranded on the packet.
  const [escalateBusy, onRequestMaintainer] = useIntentPost("request-maintainer-decision", csrf);
  const recs = useRecommendationActions(csrf, recommendations, terminalStageId, setPendingAccept);
  const transition = useStageTransition(csrf, task, stage, terminalStageId, setPendingAccept);
  const placement = completionPlacement(
    task,
    completion,
    recommendations,
    acceptance,
    taskClosed,
    terminalStageId,
  );
  const completionDiff = completionReader(
    task,
    placement.card !== null,
    changesUrl,
    workRevisionSha,
    githubHost,
  );

  return (
    <AttachmentLightboxProvider
      removable={can.canRemoveFromRecord}
      attachmentNames={attachments.map((a) => a.name)}
      attachmentsBase={attachmentsBase}
    >
    <div
      className="detail"
      ref={detailRef}
      tabIndex={-1}
      data-screen-label={"Task " + task.key}
    >
      <div className="detail-head">
        <TaskHero
          task={task}
          stage={stage}
          canEditGoal={can.canEditGoal}
          archived={archived}
          editGoalSignal={resolution.editGoalSignal}
          editGoalDraft={resolution.editGoalDraft}
          pendingGoalDraft={resolution.pendingGoalDraft}
          taskLinks={taskLinks}
          epic={epic}
        />
      </div>

      {task.packet || placement.card ? (
        <TaskDecisionRegion
          task={task}
          targeted={regionMark === TASK_DECISION_ANCHOR}
          placement={placement}
          diff={completionDiff}
          attachmentsBase={attachmentsBase}
          sourcesBase={sourcesBase}
          took={whatItTook}
          githubHost={githubHost}
          acceptance={acceptance}
          resolution={resolution}
          can={can}
          alsoAnswers={packetAlsoAnswers}
          createTaskEchoes={packetCreateTaskEchoes}
          pendingRecommendations={recommendations.length}
          onRequestMaintainer={onRequestMaintainer}
          escalateBusy={escalateBusy}
          onAsk={onAsk}
        />
      ) : null}

      <div className="detail-side">
        <GithubTrace
          task={task}
          githubHost={githubHost}
          acceptance={acceptance}
          reconciledAt={githubReconciledAt}
          checkedAt={githubCheckedAt}
          {...githubTraceDoors({
            canCompleteMerge: runConsole.onCompleteMerge !== undefined,
            canForceAccept: runConsole.onForceAccept !== undefined,
            canDeliver,
            taskClosed,
            filesDeliveredAt,
            openCeremony: setPendingAccept,
            onRunGates,
            onDeliver,
          })}
          delivering={deliverBusy}
          runIntent={runConsole.runIntent}
          runningGates={gatesBusy}
          attachmentsBase={attachmentsBase}
          filesDelivery={filesDeliveryOf(task, filesDeliveredAt, deployedSpecialists)}
        />
        <CurrentStatePanel
          task={task}
          runtime={runtime}
          stage={stage}
          meId={me.id}
          myRole={myRole}
          archived={archived}
          acceptance={acceptance}
          ownerBusy={owner.busy}
          onOwner={owner.onOwner}
          onRelease={owner.openRelease}
          onArchive={archive.onArchive}
          onAccept={() => setPendingAccept({ mode: "accept" })}
          onTransition={transition.onTransition}
          transitionBusy={transition.busy}
          acceptInFlight={accept.inFlight}
          dispositionBusy={archive.busy}
        />
        <TaskDetailsPanel
          queuedQuestions={queuedQuestions}
          task={task}
          canEdit={can.canEditMeta}
          labelSuggestions={labelSuggestions}
          epics={epics}
          dependencyCandidatesUrl={dependencyCandidatesUrl}
        />
      </div>

      <TaskMainColumn
        task={task}
        runtime={runtime}
        runConsole={runConsole}
        can={can}
        recs={recs}
        recommendations={recommendations}
        owner={owner}
        ask={ask}
        onAsk={onAsk}
        regionMark={regionMark}
        acceptanceRefusal={acceptance.blockedReason}
        terminalStageId={terminalStageId}
        taskClosed={taskClosed}
        meId={me.id}
        myRole={myRole}
        deployedSpecialists={deployedSpecialists}
        operatorBackend={operatorBackend}
        operatorAutonomy={operatorAutonomy}
        operatorAcceptsDirectly={operatorAcceptsDirectly}
        runPrincipal={runPrincipal}
        liveAgentRuns={liveAgentRuns}
        schedules={schedules}
        changesReader={changesPanelReader(
          task,
          changesUrl,
          workRevisionSha,
          githubHost,
          completionDiff,
        )}
        attachmentsBase={attachmentsBase}
        attachments={attachments}
        attachmentsTotal={attachmentsTotal}
        attachmentProducers={attachmentProducers}
        sources={sources}
        sourcesTotal={sourcesTotal}
        sourcesBase={sourcesBase}
        timelineHasMore={timelineHasMore}
        timelineRemaining={timelineRemaining}
        timelineNextLimit={timelineNextLimit}
        tlDefault={tlDefault}
        mentionables={mentionables}
        taskLinks={taskLinks}
      />

      {transition.moveBackDialog}
      {pendingAccept && (
        <TaskAcceptConfirm
          pending={pendingAccept}
          task={task}
          acceptance={acceptance}
          workRevisionSha={workRevisionSha}
          baseBehindBy={baseBehindBy}
          mergeCollisions={mergeCollisions}
          noChanges={noChanges}
          filesDeliveredAt={filesDeliveredAt}
          defaultBranch={defaultBranch}
          accept={accept}
          run={runConsole}
          recs={recs}
          resolution={resolution}
          transition={transition}
          onCancel={() => setPendingAccept(null)}
        />
      )}
      {archive.dialog}
      {owner.releaseDialog}
      {runConsole.interruptDialog}
      {recs.dismissDialog}
    </div>
    </AttachmentLightboxProvider>
  );
}
