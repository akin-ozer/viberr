import type { TaskDetail } from "~/server/projections/task-query.server";
import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { TASK_RECOMMENDATIONS_ANCHOR, TASK_TIMELINE_ANCHOR } from "~/shared/page-anchors";
import type { TaskLinks } from "~/shared/task-key-links";
import { Icon } from "~/ui/icon";
import type { RunView } from "~/features/runtime/runtime-types";
import { LiveRunPanel } from "~/features/runtime/runs-panels";
import { AttachmentsPanel } from "./attachments-panel";
import { SourcesPanel } from "./sources-panel";
import type { TaskSourceRow } from "~/server/tasks/task-sources.server";
import { ChangesPanel } from "./changes-slot";
import type { CompletionDiff } from "./completion-packet";
import { ContinuityRecoveryPanel } from "./continuity-recovery";
import type { DeployedSpecialistView, LiveAgentRun } from "./execution-profile";
import { OperatorRecommendations, type RecommendationView } from "./operator-recommendations";
import type { TaskRunPrincipalView } from "./run-principal-view";
import type { OwnerControl, RecommendationActions, RunConsole } from "./task-detail-actions";
import type { TaskPermissions } from "./task-detail-derive";
import { DiagnosticsPanel, ExecutionSection } from "./task-main-sections";
import { Timeline, type TimelineFilterId } from "./timeline";

/**
 * U35-2: `.detail-main`, the task page's main column (ruling 695(d), the pilot
 * split of `task-detail-page.tsx`): the live run, diagnostics, continuity,
 * recommendations, the run controls, the console, the changes, the
 * attachments and the timeline. It calls no hook: the page owns every fetcher
 * and the console's store and hands them in, so the memoised run card and
 * console get the same references they always did, and no id React derives
 * from the tree moves. Every prop is required; the page holds the defaults.
 */
export function TaskMainColumn({
  task,
  runtime,
  runsVisible,
  runConsole,
  can,
  recs,
  recommendations,
  owner,
  ask,
  onAsk,
  regionMark,
  acceptanceRefusal,
  terminalStageId,
  taskClosed,
  meId,
  myRole,
  deployedSpecialists,
  operatorBackend,
  operatorAutonomy,
  operatorAcceptsDirectly,
  runPrincipal,
  liveAgentRuns,
  schedules,
  changesReader,
  attachmentsBase,
  attachments,
  attachmentsTotal,
  attachmentProducers,
  sources,
  sourcesTotal,
  sourcesBase,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  mentionables,
  taskLinks,
}: {
  task: TaskDetail;
  /** The page's stable run projection (ruling 457, `useStableRows`). */
  runtime: RunView[];
  runsVisible: boolean;
  runConsole: RunConsole;
  can: TaskPermissions;
  recs: RecommendationActions;
  recommendations: RecommendationView[];
  owner: OwnerControl;
  /** The timeline composer's focus signal; `onAsk` raises it. */
  ask: number;
  onAsk: () => void;
  /** Ruling 497: the anchor a notification's link landed on, or null. */
  regionMark: string | null;
  acceptanceRefusal: AcceptanceAffordance["blockedReason"];
  terminalStageId: string | null;
  taskClosed: boolean;
  meId: string;
  myRole: string | null;
  deployedSpecialists: DeployedSpecialistView[];
  operatorBackend: "claude" | "codex";
  operatorAutonomy: "supervised" | "full";
  operatorAcceptsDirectly: boolean;
  runPrincipal: TaskRunPrincipalView | null;
  liveAgentRuns: LiveAgentRun[];
  schedules: TaskSchedule[];
  /** Ruling 484: the Changes panel's reader, or null while it hides. */
  changesReader: CompletionDiff | null;
  attachmentsBase: string | null;
  attachments: TaskAttachmentEntry[];
  attachmentsTotal: number | undefined;
  attachmentProducers: Record<string, { actor: string; occurredAt: string }>;
  /** Ruling 690: the sources the task keeps, newest first. */
  sources: TaskSourceRow[];
  sourcesTotal: number;
  /** The sources route, or null to show no Sources panel. */
  sourcesBase: string | null;
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  mentionables: Mentionables;
  taskLinks: TaskLinks;
}) {
  // F7-UI1: "operator active" reflects a LIVE operator run (queued/running),
  // never mere attachment. The runtime projection already carries kind+state.
  const operatorRunActive = runtime.some(
    (r) =>
      r.kind === "operator" &&
      (r.lifecycle === "running" || r.lifecycle === "queued"),
  );
  return (
    <div className="detail-main">
      {runtime.length > 0 ? (
        <LiveRunPanel
          runtime={runtime}
          onViewLogs={runConsole.onViewLogs}
          // D6: the button opens a confirm instead of interrupting on the click.
          onInterrupt={runConsole.askInterrupt}
          canInterrupt={runConsole.canInterrupt}
          interrupting={runConsole.runBusy}
          interruptingRunId={runConsole.interruptingRunId}
          consoleOpen={runConsole.consoleOpen}
          console={runsVisible ? runConsole.agentLogs : null}
          store={runConsole.runLog}
        />
      ) : null}

      <DiagnosticsPanel diagnostics={task.diagnostics} />

      {/* D18: with Diagnostics, ahead of the recommendations and the
          timeline. The Operator Desk order canon names is "current state,
          execution truth, latest packet, steering actions above timeline
          depth": degraded continuity is execution TRUTH, so it sits with
          Diagnostics. U35-2 moved the open packet into `.detail-head` above
          every column, so this no longer precedes the decision it may
          explain; it still precedes every steering action. It renders
          itself away when there is nothing to report. */}
      <ContinuityRecoveryPanel
        timeline={task.timeline}
        runtime={runtime}
        agents={deployedSpecialists}
        runsVisible={runsVisible}
        canRunAgents={can.canRunAgents}
        // Ruling 380: the run card's `onViewLogs` is a Show/Hide toggle; from
        // this panel the console is elsewhere, so its door travels instead.
        {...(runsVisible ? { onOpenConsole: runConsole.onAgentLog } : {})}
        onAsk={onAsk}
      />

      <OperatorRecommendations
        targeted={regionMark === TASK_RECOMMENDATIONS_ANCHOR}
        inFlight={recs.inFlight}
        recommendations={recommendations}
        canApply={can.canDecideOwned}
        busy={recs.busy}
        onApply={recs.onApply}
        onDismiss={recs.onDismiss}
        // Ruling 162: the same gate verdict the sidebar and the accept
        // dialog read, so an acceptance card never offers a refused click.
        acceptanceRefusal={acceptanceRefusal}
        terminalStageId={terminalStageId}
      />

      {/* Scheduling lives INSIDE the two run controls (dynamic-dispatch
          rework — no separate scheduled-actions panel or disclosure button);
          pending entries render under the control that scheduled them. */}
      <ExecutionSection
        task={task}
        meId={meId}
        myRole={myRole}
        ownerBusy={owner.busy}
        onOwner={owner.onOwner}
        deployedSpecialists={deployedSpecialists}
        operatorBackend={operatorBackend}
        operatorAutonomy={operatorAutonomy}
        operatorAcceptsDirectly={operatorAcceptsDirectly}
        runPrincipal={runPrincipal}
        canRunAgents={can.canRunAgents}
        liveAgentRuns={liveAgentRuns}
        operatorRunActive={operatorRunActive}
        schedules={schedules}
      />

      {/* The archive. While a run streams, its console is disclosed on the
          run card above instead — one console either way, never two. */}
      {runtime.length > 0 && runsVisible && !runConsole.liveRun ? runConsole.agentLogs : null}
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
          <p className="empty sm">
            Raw agent output, wire envelopes and provider session ids are
            limited to project members. The run summary above is public to
            signed-in users.
          </p>
        </section>
      ) : null}

      {/* Ruling 484 (F40-54): the Changes panel (`changesPanelReader`). */}
      {changesReader ? (
        <ChangesPanel
          url={changesReader.url}
          githubHost={changesReader.githubHost}
          prNumber={changesReader.prNumber}
          revisionSha={changesReader.revisionSha}
          delivererName={changesReader.delivererName}
        />
      ) : null}

      {attachmentsBase ? (
        <AttachmentsPanel
          base={attachmentsBase}
          attachments={attachments}
          {...(attachmentsTotal !== undefined ? { total: attachmentsTotal } : {})}
          producers={attachmentProducers}
          // D8: show an empty state (not nothing) when a browser-capable agent
          // is deployed — its runs are what fill this panel.
          browserExpected={deployedSpecialists.some(
            (s) => s.capabilities?.browser,
          )}
          // F39-6: who may attach (`taskPermissions`).
          canAttach={can.canAttach}
        />
      ) : null}

      {/* Ruling 690: what the work rests on, under the files of the work.
          Nothing on a task that keeps no sources. */}
      {sourcesBase && sources.length > 0 ? (
        <SourcesPanel base={sourcesBase} sources={sources} total={sourcesTotal} />
      ) : null}

      <Timeline
        landed={regionMark === TASK_TIMELINE_ANCHOR}
        events={task.timeline}
        hasMore={timelineHasMore}
        remaining={timelineRemaining}
        nextLimit={timelineNextLimit}
        tlDefault={tlDefault}
        ask={ask}
        mentionables={mentionables}
        taskLinks={taskLinks}
        runPrincipal={runPrincipal}
        onAgentLog={runConsole.onAgentLog}
        taskClosed={taskClosed}
        // Ruling 573: a comment carries files for whoever may attach one
        // (the attachments panel's own rule, F39-6).
        canAttach={can.canAttach}
        // U33-1 was inert: the Timeline accepted `runLive` and no production
        // caller ever passed it, so a task whose loop HAS started but has not
        // reported yet still read "this task hasn't started its operator
        // loop" — directly under the Live-run strip saying otherwise. Same
        // condition that renders that strip, so the two cannot disagree.
        runLive={runtime.length > 0}
        // Rulings 483 and 498: a proposal or a correction links to the
        // project's Controller page, where its panel lists them.
        knowledgeHref={`/projects/${encodeURIComponent(task.projectSlug)}/controller`}
        {...(attachmentsBase
          ? {
              attachmentNames: attachments.map((a) => a.name),
              attachmentsBase,
            }
          : {})}
      />
    </div>
  );
}
