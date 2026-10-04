import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { formFiles } from "~/server/files/form-files.server";
import { deliveryToast } from "~/features/task-detail/delivery-toast";
import { goalDraftForOption } from "~/shared/packet-goal-draft";
import {
  causeFanOutDisclosure,
  siblingPacketsSharingCause,
} from "~/server/tasks/packet-fanout.server";
import { similarOpenTasks } from "~/server/tasks/similar-tasks.server";
import {
  data,
  isRouteErrorResponse,
  Link,
  useParams,
  useRouteLoaderData,
} from "react-router";
import { pageTitle } from "~/shared/page-title";
import { countLabel } from "~/shared/text/plural";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import type { Route } from "./+types/project.task";
import type { loader as projectLoader } from "./project";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { AppError } from "~/server/errors/app-error.server";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { taskKeyLinks } from "~/server/projections/task-key-links.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import {
  attachmentProducers,
  getTaskDetail,
  getTaskSummary,
} from "~/server/projections/task-query.server";
import {
  isTaskViewNavigation,
  markTaskNotificationsSeen,
} from "~/server/projections/notifications.server";
import { isDocumentNavigation } from "~/server/http/single-fetch.server";
import { logger } from "~/server/logging/logger.server";
import {
  applyRecommendation,
  dismissRecommendation,
} from "~/server/tasks/task-recommendations.server";
import { appendComment, commentToAgent } from "~/server/tasks/task-comments.server";
import { requestPacketMaintainerDecision, resolvePacket } from "~/server/tasks/task-actions.server";
import { transitionStage } from "~/server/tasks/task-transitions.server";
import { manualDeliverForReview, runProjectGatesByHand } from "~/server/tasks/task-delivery.server";
import {
  completeTaskMerge,
  forceAcceptCompletion,
  refreshAndReview,
  acceptanceStanding,
} from "~/server/tasks/task-acceptance.server";
import { setTaskArchived } from "~/server/tasks/task-archive.server";
import { releaseOwner, setOwner } from "~/server/tasks/task-ownership.server";
import {
  attachTaskFile,
  removeTaskAttachment,
  setTaskMetadata,
  updateTaskGoal,
} from "~/server/tasks/task-edits.server";
import { setTaskDependencies } from "~/server/tasks/dependencies.server";
import { setTasksEpic } from "~/server/tasks/epic-actions.server";
import { listEpicChips } from "~/server/projections/epic-query.server";
import {
  panelReviewNotesText,
  parsePanelReviewNotes,
} from "~/server/tasks/review-notes.server";
import { splitDependencyText } from "~/shared/dependencies";
import { activeWorkRevision, coercePriority, deliveredAsFiles } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  countTaskAttachments,
  listTaskAttachments,
  taskAttachmentExists,
  MAX_UPLOAD_BYTES,
} from "~/server/files/task-attachments.server";
import { completionView } from "~/server/tasks/completion-packet.server";
import {
  directiveDeferredNote,
  listDeployedSpecialists,
  removeReviewer,
  isAgentBusy,
  isDispatchHeld,
  startAgentRun,
} from "~/server/tasks/specialist-run.server";
import { getMentionables } from "~/server/tasks/mention-suggestions.server";
import { userDisplayName } from "~/server/tasks/user-display-name.server";
import { githubWebHost } from "~/server/github/github-client.server";
import {
  createReconcileBehindByLookup,
  latestTaskReconcileAt,
} from "~/server/provenance/provenance-query.server";
import { latestTaskReconcileCheckAt } from "~/server/audit/audit-query.server";
import { taskMergeCollisions } from "~/server/projections/pr-collisions.server";
import type { PrOverlap } from "~/shared/pr-overlaps";
import { interruptRun, listRunsForTask } from "~/server/runtimes/run-service.server";
import { liveRunStateByTask } from "~/server/runtimes/run-store.server";
import { withLiveRun } from "~/shared/mapping/task.server";
import {
  runOperator,
  type RunOperatorInput,
} from "~/server/runtimes/operator-run.server";
import type { DatabaseSync } from "node:sqlite";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { findUserById } from "~/server/auth/user-store.server";
import { unavailableModels } from "~/server/runtimes/model-availability.server";
import {
  operatorAcceptsDirectly,
  operatorAutonomyFor,
  operatorBackendFor,
} from "~/server/tasks/operator-actions.server";
import { parseAcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import {
  completionToast,
  terminalStageNameFor,
} from "~/features/task-detail/completion-toast";
import {
  getProject,
  listProjectLabels,
  listProjectMembers,
} from "~/server/projections/board-query.server";
import {
  requireProjectFormAction,
  requireVisibleProject,
} from "./project-visibility.server";
import {
  requireRunAgents,
  type AuthorityProject,
} from "~/server/auth/project-authority.server";
import {
  cancelScheduledAction,
  SCHEDULE_BOUNDS_SENTENCE,
  SCHEDULE_MAX_MINUTES,
  scheduleTaskAction,
} from "~/server/tasks/schedule.server";
import { TaskDetailPage } from "~/features/task-detail/task-detail-page";
import type { TaskRunPrincipalView } from "~/features/task-detail/run-principal-view";
import type {
  LiveAgentRun,
  TaskMemberView,
} from "~/features/task-detail/execution-profile";
import type { TimelineFilterId } from "~/features/task-detail/timeline";
import {
  clampTimelineLimit,
  timelineSlice,
  timelineWindowSize,
} from "~/features/task-detail/timeline-slice";
import { roleCan } from "~/shared/rbac";
import { stageName } from "~/shared/workflow/stage-roles";
import { Icon } from "~/ui/icon";
import { errorMessage, toError } from "~/shared/errors";

/**
 * /projects/:slug/tasks/:key — the full task workspace (task-detail spec).
 *
 * Loader contract kept from Phase 4: `{ task }` with `task.key`/`task.title`
 * (the layout's crumbs read this route's data by id "routes/project.task").
 * `task.timeline` is a bounded newest-first slice (`?events=` param,
 * progressive disclosure); members/myRole come from the layout loader.
 *
 * Action intents (all CSRF-checked; RBAC inside the phase-3 mutations;
 * TOAST COPY IS THE VERBATIM SPEC §5 CONTRACT — it lives here so every
 * caller shows identical strings):
 *   comment · review-notes · resolve-packet · owner-take · owner-assign · owner-release ·
 *   transition · accept-completion · archive-task · restore-task ·
 *   run-interrupt · run-agent · release-agent · run-operator ·
 *   schedule-action · cancel-schedule · set-task-epic (ruling 503)
 */

/**
 * Ruling 127: WHOSE accounts this task's agent runs would use, and what those
 * accounts can run. The page used to ship one deployment-wide "is this backend
 * configured" boolean; a run bills the task OWNER, so the honest answer is the
 * owner's own health, and the panels render copy that names them
 * (`app/features/task-detail/run-principal-view.ts`).
 *
 * `null` = nobody to bill: no owner, or a seat pointing at an account that is
 * disabled or gone. Never a secret and never a box: `available` plus the
 * store's own actionable sentence, which the page shows only to the owner.
 */
function taskRunPrincipal(
  db: DatabaseSync,
  ownerUserId: string | null,
): TaskRunPrincipalView | null {
  if (!ownerUserId) return null;
  const owner = findUserById(db, ownerUserId);
  // A seat pointing at a deleted or disabled account is not an owner a run can
  // bill, so it reads as unowned here — the same answer `resolveTaskRunPrincipal`
  // gives the run service.
  if (!owner || owner.disabled) return null;
  const health = (backend: "claude" | "codex") => {
    const h = userBackendHealth(db, ownerUserId, backend);
    return { available: h.available, detail: h.detail };
  };
  return {
    ownerUserId,
    ownerName: owner.name,
    claude: health("claude"),
    codex: health("codex"),
  };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  // R15-4 on the READ side of THIS loader, not only the layout's.
  // Single-fetch honors a client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/tasks/<key>.data?_routes=routes/project.task` runs
  // this loader ALONE — the layout's membership refusal never executes. The
  // gate has to live on every loader that serves project content, exactly as
  // it already does on this route's action.
  requireVisibleProject(
    db,
    params.slug,
    { userId: user.id, label: user.email },
    "read this project",
  );
  const limit = clampTimelineLimit(
    new URL(request.url).searchParams.get("events"),
  );
  // Ruling 457: the query reads only the window the page ships; the event
  // count below keeps "Show older" exact.
  const detail = getTaskDetail(db, params.slug, params.key, {
    timelineLimit: timelineWindowSize(limit),
  });
  if (!detail) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, {
      status: 404,
    });
  }
  // R19-15: opening the task IS seeing its notifications — mark this viewer's
  // unread rows for it read here, loader-side. The write is idempotent +
  // monotonic, and the `notification.read` it emits converges — the second pass
  // marks nothing and emits no further event, so no loop can sustain.
  //
  // F20-11: gate it on `isTaskViewNavigation`. This loader does NOT run "only on
  // a real view" as once assumed — single fetch re-runs it as a `.data` GET on
  // every SSE revalidation and after every POST on this page, so a parked
  // background tab used to silently eat any notification that landed on this
  // task (the bell never badged, even for "Blocked — decision needed" packets).
  // Marking only on a genuine document navigation keeps the badge honest.
  // Guarded because viewing a task must never 500 because read-marking hiccuped.
  if (isTaskViewNavigation(request)) {
    try {
      markTaskNotificationsSeen(db, user.id, params.slug, params.key);
    } catch (error) {
      logger.warn("R19-15 task-view read-marking failed", {
        projectSlug: params.slug,
        taskKey: params.key,
        error: toError(error),
      });
    }
  }
  // The total is the projection's event count: the rebuilder writes it from
  // the same parsed timeline, in the same synchronous rebuild, as the rows.
  const slice = timelineSlice(detail.timeline, detail.eventCount, limit);
  const rawDefault = getPref(db, user.id, "tlDefault");
  const tlDefault: TimelineFilterId =
    rawDefault === "typed" || rawDefault === "comment" ? rawDefault : "all";

  // Per-task provider run projection.
  //
  // UI-30: the task page is READABLE app-wide by design (anyone may open a task
  // and comment), but the run projection carries the three most sensitive run
  // artifacts — the console `lines`, the exact stored wire envelopes (`raw`,
  // what the `{ } raw` toggle prints) and the provider `sid`. Both routes that
  // serve the SAME material require project membership
  // (`/resources/run-log`, `/resources/session-export`), so this loader was
  // simultaneously MORE permissive than its own data routes and broken: a
  // non-member saw the full console while the live tail silently 403'd and
  // Export downloaded a 403 body.
  //
  // One policy now: members (and org admins, via the audited D2 override) get
  // the full projection; everyone else keeps the honest run SUMMARY strip —
  // who ran, on what backend, when, and how it ended — with no log content.
  const members = listProjectMembers(db, params.slug);
  const runsVisible = members.some((m) => m.userId === user.id) || user.role === "admin";
  //
  // P13-D-11: the member projection carries a BOUNDED window of each agent
  // group's console (newest lines within `RUN_LOG_WINDOW_*`), not the whole
  // raw execution history — NFR5. `logWindow` carries the cursor the console
  // pages backwards with via `/resources/run-log?before=`.
  //
  // Ruling 457 (owner decision 2, 2026-09-24): and only where a person is
  // arriving. A hard refresh ships the shown agent's window (display lines;
  // the envelopes load when the raw view opens); a revalidation or a client
  // navigation (`.data`) ships no console line at all, and the console fills
  // the thread it shows with one small request. This payload used to carry
  // every agent's window, lines and envelopes, on every revalidation.
  //
  // A non-member's withheld projection bounds no window at all and reports an
  // empty one, so nothing tries to page it.
  const runtime = runsVisible
    ? listRunsForTask(db, params.slug, params.key, {
        console: isDocumentNavigation(request) ? "shown" : "none",
      })
    : listRunsForTask(db, params.slug, params.key, { console: "withheld" }).map((r) => ({
        ...r,
        sid: null,
        exportable: false,
      }));

  // Deployed specialists the "Assign specialist" menu offers. Model-availability
  // marks are threaded so the run control can flag an agent whose model a real
  // run showed is not runnable on the account, BEFORE another run is spent.
  const deployedSpecialists = listDeployedSpecialists(params.slug, undefined, {
    codex: unavailableModels(db, "codex"),
    claude: unavailableModels(db, "claude"),
  });
  // F10-04: per-engagement run gating. The server single-flights only the
  // DELIVERING run; supporting/reviewing runs are read-only and may run
  // concurrently. The run-agent control mirrors this: it warns/disables per
  // profile, from the live run set. Pass 35 U35-7: the lifecycle rides along,
  // so the engaged-agent card can say "queued" for a run that has not started.
  const liveAgentRuns: LiveAgentRun[] = runtime.flatMap((r) =>
    !r.op && r.profileId && (r.lifecycle === "running" || r.lifecycle === "queued")
      ? [{ profileId: r.profileId, lifecycle: r.lifecycle }]
      : [],
  );

  // @-mention autocomplete directory for the comment composer: deployed
  // specialists, registered users, and the reserved backend/role handles —
  // the same targets the server resolves an @mention to when a comment posts.
  const mentionables = getMentionables(db, params.slug);
  // U39-31: the other tasks this page's goal and timeline slice name, as the
  // pages this viewer can open. The task itself is never linked to itself.
  const taskLinks = taskKeyLinks(
    db,
    [detail.goal, ...slice.events.map((e) => e.text)],
    { projectSlug: params.slug, viewerId: user.id, exclude: params.key },
  );

  // Pending operator recommendations live in the task FILE (not the projection);
  // read them here so the task-detail renders them as actionable cards. The
  // loader revalidates on every SSE task change, so applied/dismissed ones drop.
  const taskFile = readTaskFile({ projectSlug: params.slug, taskKey: params.key });
  const recommendations = taskFile?.parsed.frontmatter.recommendations ?? [];
  // R14-3: the archive disposition lives in the task FILE (the projection has no
  // column for it), and the page needs it for the archived banner + the
  // archive/restore control. Read from the same file the recommendations do.
  const archived = taskFile?.parsed.frontmatter.archived === true;
  // Pending scheduled operator re-runs (O-3), rendered as cancellable cards.
  const schedules = (taskFile?.parsed.frontmatter.schedules ?? []).filter(
    (s) => s.status === "pending",
  );
  // Ruling 241: reviewer questions a dependency hold refused, waiting for the
  // release. Read from the FILE beside the recommendations and for the same
  // reason (no projection column). Surfaced because a promise a person made and
  // cannot see is the defect this pass kept finding: the card said the question
  // would be put when the wait clears, and until then the only trace was one
  // timeline note that scrolls.
  const queuedQuestions = (taskFile?.parsed.frontmatter.queuedQuestions ?? []).map((q) => ({
    id: q.id,
    profileId: q.profileId,
    decidedByLabel: q.decidedByLabel,
  }));

  /**
   * Ruling 319: this packet's `cause` says the failure that raised it belongs
   * to an ACCOUNT, not to this task — so confirming here also answers every
   * sibling packet the same failure raised. A decision that reaches four other
   * tasks and says nothing about it on the card is precisely the un-disclosed
   * one-way write ruling 20 exists to stop; the disclosure is computed here,
   * beside the acceptance disclosure, and rendered above the options.
   *
   * Guarded: a search that fails must not 500 the task page over a sentence.
   */
  const packetCause = taskFile?.parsed.packet?.cause;
  let packetAlsoAnswers: string | null = null;
  if (packetCause) {
    try {
      packetAlsoAnswers = causeFanOutDisclosure(
        siblingPacketsSharingCause(db, packetCause, {
          projectSlug: params.slug,
          taskKey: params.key,
        }),
      );
    } catch (error) {
      logger.warn("ruling 319 fan-out disclosure failed", {
        projectSlug: params.slug,
        taskKey: params.key,
        error: toError(error),
      });
    }
  }

  // R15-1: the accept confirm names exactly what merges — the delivered
  // revision (task file) and the merge target (project default branch).
  const workRevisionSha =
    activeWorkRevision(taskFile?.parsed.frontmatter.workRevision)?.headSha ?? null;
  // R17-2: a verified no-change completion (empty branch, no PR) accepts to Done
  // without a merge — the confirm says so instead of implying delivered work.
  const noChanges = taskFile?.parsed.frontmatter.noChanges === true;
  // Ruling 550: a task delivered as files says so in the confirm, rather than
  // a merge it never had and a GitHub re-check that would call it unchanged.
  // Sent only when it applies: every other task's payload stays as it was
  // (ruling 457's console budget measures it).
  const deliveredFm = taskFile?.parsed.frontmatter;
  const filesDelivery =
    deliveredFm && deliveredAsFiles(deliveredFm) && deliveredFm.deliveredAt
      ? { filesDeliveredAt: deliveredFm.deliveredAt }
      : {};
  const project = getProject(db, params.slug);
  const defaultBranch = project?.defaultBranch || "main";

  /**
   * Ruling 324: a `create_task` option creates a real task on the person's
   * confirm, and the card says what it will create without saying what already
   * looks like it. Twice on the shopify-clone board a confirm was one click
   * from a second owner for work a live task already held.
   *
   * Per option index, because a packet can carry more than one, and the person
   * is choosing between them. Guarded for the same reason the fan-out
   * disclosure is: a search must not 500 the task page.
   */
  const packetCreateTaskEchoes: Record<number, { key: string; title: string; stage: string }[]> =
    {};
  for (const [i, opt] of (taskFile?.parsed.packet?.options ?? []).entries()) {
    if (opt.kind !== "create_task" || !opt.newTask) continue;
    try {
      const echoes = similarOpenTasks(db, params.slug, opt.newTask.title, [params.key]);
      if (echoes.length > 0) {
        packetCreateTaskEchoes[i] = echoes.map((e) => ({
          key: e.key,
          title: e.title,
          stage: stageName(project?.stages ?? [], e.stageId),
        }));
      }
    } catch (error) {
      logger.warn("ruling 324 similar-task disclosure failed", {
        projectSlug: params.slug,
        taskKey: params.key,
        error: toError(error),
      });
    }
  }

  // Ruling 475 (F40-55 (c)): the other open PRs this task's merge would likely
  // put in conflict, for the accept dialog. Guarded like the disclosures
  // above: a read that fails must not 500 the task page over a sentence.
  let mergeCollisions: PrOverlap[] = [];
  try {
    mergeCollisions = taskMergeCollisions(db, params.slug, detail);
  } catch (error) {
    logger.warn("ruling 475 merge-collision disclosure failed", {
      projectSlug: params.slug,
      taskKey: params.key,
      error: toError(error),
    });
  }

  // R15-2 safety net (b): manual delivery is maintainer+ (run-agents tier) or
  // the task's own owner — mirror of manualDeliverForReview's server gate.
  const myProjectRole = members.find((m) => m.userId === user.id)?.role ?? null;
  const canDeliver =
    roleCan(myProjectRole, "run-agents") ||
    user.role === "admin" ||
    (taskFile?.parsed.frontmatter.ownerUserId === user.id &&
      roleCan(myProjectRole, "own-task"));

  // R19-19: browser-produced files for this task. Same visibility bar as the
  // run console (a screenshot shows whatever the agent saw) — non-members get
  // an empty list, and the serving route re-checks membership itself.
  const attachments = runsVisible
    ? listTaskAttachments(params.slug, params.key)
    : [];
  // C8 (pass 25): the list is capped (LIST_CAP=100); the panel needs the true
  // total to say "showing 100 of N" instead of hiding the older evidence silently.
  const attachmentsTotal = runsVisible
    ? countTaskAttachments(params.slug, params.key)
    : 0;

  // P14-LV-06: the acceptance affordance, with the project's required-reviewer
  // rules from the same read of project.md (the completion packet below).
  const standing = acceptanceStanding({
    projectSlug: params.slug,
    taskKey: params.key,
    viewerUserId: user.id,
  });
  const ruleReviewerIds = new Set(standing.requiredReviewers.map((r) => r.profileId));

  // Ruling 521: the completion packet, with each reviewer's verdict on the
  // work under review and the change's size, built from what this loader has
  // already read (the task file, the project's rules, the reviewers' and the
  // deployed agents' names). A screenshot rides the attachments' own bar: a
  // viewer who may not see the attachments sees none of it, and one that has
  // left the store is counted, not drawn. Checked by name rather than against
  // the list above, which stops at the newest 100.
  const completion =
    taskFile && !archived
      ? completionView(taskFile.parsed.frontmatter, {
          canSee: runsVisible
            ? (name) => taskAttachmentExists(params.slug, params.key, name)
            : null,
          nameOf: (profileId) => {
            const engaged = detail.reviewers.find((r) => r.profileId === profileId);
            return (
              engaged?.profileName ??
              deployedSpecialists.find((s) => s.id === profileId)?.name ??
              engaged?.role ??
              profileId
            );
          },
          ruleReviewers: standing.requiredReviewers.map((r) => r.profileId),
        })
      : null;

  return {
    // Ruling 349: the hero and the rail read the run row, like the board card.
    task: {
      ...withLiveRun(detail, liveRunStateByTask(db, params.slug).get(params.key) ?? null),
      timeline: slice.events,
    },
    // The project's existing label vocabulary, for the Details panel's label
    // autocomplete — same source the board's New-task modal draws from.
    labelSuggestions: listProjectLabels(db, params.slug),
    // Ruling 503: the project's epics as chips (one statement), for the
    // hero's Epic field and the Details panel's Epic menu.
    epics: listEpicChips(db, params.slug),
    attachments,
    attachmentsTotal,
    /** Ruling 521: the operator's completion packet as the page shows it. */
    completion,
    // Who saved each attachment and when, from the events that claim names —
    // same visibility bar as the list itself.
    attachmentProducers: runsVisible
      ? attachmentProducers(db, params.slug, params.key)
      : {},
    recommendations,
    schedules,
    queuedQuestions,
    /** Ruling 319: what else this packet's confirm answers, or null. */
    packetAlsoAnswers,
    /** Ruling 324: per create_task option, the tasks that already look like it. */
    packetCreateTaskEchoes,
    archived,
    // P14-LV-06: the review queue counted this viewer under "Waiting on your
    // acceptance" while the page rendered acceptance ONLY as an operator
    // recommendation card — so a withdrawn recommendation left the promised
    // decision with no control at all. Acceptance is a standing authority at the
    // review boundary; both surfaces now read it from the same predicate.
    acceptance: standing.affordance,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
    // Ruling 535's `postsFiles` is the operator's delivery signal; the page
    // renders nothing from it, so it stays off the wire (ruling 457).
    deployedSpecialists: deployedSpecialists.map(({ capabilities: { postsFiles: _operatorOnly, ...shown }, ...agent }) => {
      const view: typeof agent & { capabilities: typeof shown; requiredReviewer?: true } = {
        ...agent,
        capabilities: shown,
      };
      // Ruling 556: a project rule's reviewer is engaged to review, never to
      // deliver, so the run control must not promise it the branch. Only
      // where true, so no other agent's bytes grow (ruling 457).
      if (ruleReviewerIds.has(agent.id)) view.requiredReviewer = true;
      return view;
    }),
    // P11-76: the operator's configured backend so the run picker defaults to it.
    operatorBackend: operatorBackendFor({}, params.slug),
    // R19-A: the ceiling, so the run picker offers only what will actually run.
    operatorAutonomy: operatorAutonomyFor({}, params.slug),
    // F37-65: autonomy alone does not say whether the operator can accept
    // completion — `gate()` keeps that capability at `recommend` unless the
    // grant is explicitly `direct`. The caption used to read autonomy only.
    operatorAcceptsDirectly: operatorAcceptsDirectly({}, params.slug),
    // Ruling 127: every agent run on this task bills its OWNER's accounts, so
    // "which backends can run here" is a question about the owner — not about
    // this deployment and not about the viewer. `null` means the task has no
    // owner at all, which is its own refusal (nobody to bill), and the panels
    // say "Own this task to run agents" rather than "backend unavailable".
    runPrincipal: taskRunPrincipal(
      db,
      taskFile?.parsed.frontmatter.ownerUserId ?? null,
    ),
    liveAgentRuns,
    /** UI-30: false → the console content above was withheld (non-member). */
    runsVisible,
    mentionables,
    taskLinks,
    // UI-57: the task's GitHub card (branch / diff / commits / PR) is served
    // from the SAME cached projection the GitHub page labels "Updated 3m ago /
    // Not yet synced" — but here it carried no freshness cue at all, so stale
    // state looked current. Ship the newest reconcile time for this task.
    // P13-D-16: this was the only raw `.prepare(` in any page route — a hand-
    // written provenance query in a loader, against the layering rule in
    // architecture.md. It now goes through app/server/provenance/, which owns
    // the table.
    githubReconciledAt: latestTaskReconcileAt(db, params.slug, params.key),
    // U39-32: how far the branch stood behind the base at the reconciler's
    // last compare, so the accept dialog can say which of its two cases this
    // click is. Null: never compared.
    baseBehindBy: createReconcileBehindByLookup(db)(detail.filePath),
    /** Ruling 475: the open PRs sharing a changed path with this one. */
    mergeCollisions,
    // F19-22: the line above is the last pass that CHANGED something — DG-3
    // deliberately withholds the provenance row when a poller tick finds
    // nothing new (github-reconciler.server.ts), so it drifts to "1h ago" on a
    // task the poller is verifying every five minutes, and the panel rendering
    // it as "Synced" contradicted its own tooltip. The last CHECK is a
    // different fact with a different writer: `github.reconcile.task` is
    // recorded after every early return in `reconcileTaskExclusive`, so a row
    // exists iff a pass completed — changed or not — and audit retention (90d)
    // bounds it. Both ship; the panel renders them as two rows, because one
    // number cannot answer both questions.
    githubCheckedAt: latestTaskReconcileCheckAt(db, params.slug, params.key),
    // R15-1 accept confirm + R15-2 manual-delivery affordance.
    workRevisionSha,
    noChanges,
    ...filesDelivery,
    defaultBranch,
    canDeliver,
    // Host for GitHub browse links (PR/branch/repo), derived server-side.
    // UI-11: today this always resolves to `https://github.com` — nothing
    // stores a GHE API base URL — so the value is honest, but the "GHE
    // deployments keep working" claim that used to sit here was not.
    githubHost: githubWebHost(),
  };
}

/**
 * The toast a comment's result earns, for the `comment` intent and ruling
 * 484's `review-notes` (whose `posted` names the notes). Name the agent when one
 * is picking the comment up; note when a mention was recorded but the run was
 * not triggered (RBAC); an @operator mention that was REFUSED (packet open /
 * task Done) must NOT read as "picking it up" (the run never started): point
 * the human at the action that unblocks it (BUG-2); A8 (pass 23): a
 * SPECIALIST run that FAILED to start after the comment posted says so with its
 * reason, so the commenter knows the comment landed and only the run didn't
 * (was a bare error toast that read as total failure); else the original
 * routed/plain copy (verbatim spec contract).
 */
function commentToast(
  result: Awaited<ReturnType<typeof commentToAgent>>,
  posted: string,
): string {
  return result.triggered && result.agent
    ? `${posted} · @${result.agent.name} is picking it up`
    : result.operatorRefused === "open-packet"
      ? `${posted} · resolve the open decision to continue`
      : result.operatorRefused === "closed"
        ? `${posted} · reopen the task to run the operator`
        : result.runNotStarted && result.agent
          ? `${posted} · @${result.agent.name}'s run did not start: ${result.runNotStarted}`
          : result.runtimeDenied && result.agent
            ? `${posted} · your role can't trigger agent runs`
            : result.toAgent
              ? `${posted} · routed to mentioned agent`
              : posted;
}

/** Optional `backend` form field → a run backend override (D4 retry). Ignores
 *  anything that isn't a real backend so a stray value can't break a run. */
function backendOverride(formData: FormData): { backendOverride?: "claude" | "codex" } {
  const b = String(formData.get("backend") ?? "");
  return b === "claude" || b === "codex" ? { backendOverride: b } : {};
}

/** The `{ slug, memberRoles, archived }` snapshot `requireRunAgents` consumes,
 *  built from the same two projections at every run-agents call site
 *  (run-operator / schedule-action / cancel-schedule). One definition so the
 *  guard-input shape can't drift between the three (RU #8). */
function runAgentsAuthority(
  db: ReturnType<typeof getDb>,
  projectSlug: string,
): AuthorityProject {
  return {
    slug: projectSlug,
    memberRoles: new Map(
      listProjectMembers(db, projectSlug).map((m) => [m.userId, m.role]),
    ),
    archived: getProject(db, projectSlug)?.archived === true,
  };
}

/**
 * F39-6: the largest body this route reads. One attachment at its cap, plus
 * the multipart envelope and the form's other fields; every other intent
 * posts a few kilobytes.
 */
const MAX_TASK_ACTION_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

export async function action({ request, params }: Route.ActionArgs) {
  // Refused before the body is read: `requireFormAction` parses the whole
  // multipart form into memory, and the attachment's own size check runs only
  // after that, so an oversized upload used to be buffered whole first.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_TASK_ACTION_BODY_BYTES) {
    return data(
      {
        ok: false as const,
        error: `That is ${Math.round(declared / 1024 / 1024)} MB; an attachment may be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      },
      { status: 413 },
    );
  }
  const {
    refused,
    auth: ctx,
    db,
    formData,
    actor,
    intent,
  } = await requireProjectFormAction(request, params.slug);
  if (refused) return refused;
  const projectSlug = params.slug;
  const taskKey = params.key;

  try {
    switch (intent) {
      case "comment": {
        // commentToAgent is a superset of appendComment: records the comment,
        // and when an agent is @mentioned (and the commenter is admin|
        // maintainer) resumes THAT agent's session — the agent's reply arrives
        // later as a new agent-authored comment via SSE revalidation.
        // Ruling 573: the files the comment carries, as the task's attachments.
        const result = await commentToAgent(
          db,
          { projectSlug, taskKey, text: String(formData.get("text") ?? ""), files: await formFiles(formData) },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toAgent: result.toAgent,
          agent: result.agent?.name ?? null,
          triggered: result.triggered,
          // BUG 3: the grouped Agent-logs entry to auto-select + stream so the
          // user sees the mentioned agent's live output without hunting for it.
          logThreadId: result.logThreadId,
          toast: commentToast(result, "Comment posted"),
        };
      }
      case "review-notes": {
        // Ruling 484 (F40-54): the Changes panel's line notes, posted as ONE
        // comment addressed `@<deliverer>` that quotes each note's file:line,
        // through the comment door, so the deliverer resumes on it exactly as
        // it would for the same words typed in the composer. Bound to the
        // revision the person read (`headSha`): a newer delivery refuses.
        const notes = parsePanelReviewNotes(formData.get("notes"));
        const text = panelReviewNotesText(
          {},
          {
            projectSlug,
            taskKey,
            headSha: String(formData.get("headSha") ?? ""),
            notes,
          },
        );
        const result = await commentToAgent(db, { projectSlug, taskKey, text }, actor);
        return {
          ok: true as const,
          intent,
          toAgent: result.toAgent,
          agent: result.agent?.name ?? null,
          triggered: result.triggered,
          logThreadId: result.logThreadId,
          toast: commentToast(result, notes.length === 1 ? "Note sent" : `${notes.length} notes sent`),
        };
      }
      case "update-goal": {
        // F35-6 (pass 35): an unchanged save is reported as unchanged; while a
        // requested goal edit is pending the server refuses it out loud.
        const { changed } = await updateTaskGoal(
          db,
          { projectSlug, taskKey, goal: String(formData.get("goal") ?? "") },
          actor,
        );
        return { ok: true as const, intent, toast: changed ? "Goal updated" : "Goal unchanged" };
      }
      case "set-task-metadata": {
        // Ruling 501: the Details panel edits one property at a time, so an
        // axis is written only when the form carries its field; an absent
        // field leaves that axis as it stands (and a concurrent edit to it
        // unclobbered). A present field replaces its axis: an empty labels
        // field clears the set, an empty due date clears the date.
        // `setTaskMetadata` validates priority + due date and normalizes
        // labels; a bad value throws before any write.
        const metaInput: Parameters<typeof setTaskMetadata>[1] = { projectSlug, taskKey };
        const edited: string[] = [];
        if (formData.has("priority")) {
          const priority = coercePriority(String(formData.get("priority") ?? "").trim());
          if (priority) {
            metaInput.priority = priority;
            edited.push("Priority");
          }
        }
        if (formData.has("labels")) {
          metaInput.labels = String(formData.get("labels") ?? "")
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
          edited.push("Labels");
        }
        if (formData.has("dueDate")) {
          metaInput.dueDate = String(formData.get("dueDate") ?? "").trim();
          edited.push("Due date");
        }
        await setTaskMetadata(db, metaInput, actor);
        return {
          ok: true as const,
          intent,
          toast: edited.length === 1 ? `${edited[0]} updated` : "Task metadata updated",
        };
      }
      case "set-task-epic": {
        // Ruling 503: the Details panel's Epic menu. An empty field takes the
        // task out of its epic; `setTasksEpic` checks the grant
        // (`edit-task-meta`), the epic and the task before it writes.
        const epicId = String(formData.get("epic") ?? "").trim();
        const result = await setTasksEpic(
          db,
          { projectSlug, taskKeys: [taskKey], epicId: epicId || null },
          actor,
        );
        return { ok: true as const, intent, toast: result.message };
      }
      case "set-task-dependencies": {
        // Ruling 131: the Details panel's own form. The FULL list is submitted
        // (comma- or newline-separated); an empty field clears the wait, which
        // for a person IS the release. Validation refuses by name before any
        // write, and the refusal surfaces on this form, never swallowed by the
        // metadata form's close-on-success.
        const entries = splitDependencyText(String(formData.get("blockedBy") ?? ""));
        const result = await setTaskDependencies(db, { projectSlug, taskKey, blockedBy: entries }, actor);
        return {
          ok: true as const,
          intent,
          toast: !result.changed
            ? "Dependencies unchanged"
            : result.released && result.blockedBy.length > 0
              ? `Released: ${result.blockedBy.join(", ")} ${result.blockedBy.length === 1 ? "is" : "are"} done`
              : result.blockedBy.length > 0
                ? `Waits on ${result.blockedBy.join(", ")}`
                : "No longer waits on other work",
        };
      }
      case "resolve-packet": {
        const raw = Number(formData.get("option"));
        const optionIndex = Number.isInteger(raw) && raw >= 0 ? raw : -1;
        // Ruling 315: NOT a slice. This field holds a person's own words on the
        // highest-stakes card in the product, and the route used to cut it to
        // 2,000 characters before the request reached the server — no
        // `maxLength`, no counter, no marker, no error, and the tail exists nowhere
        // afterwards. The server refuses over-long input instead, exactly as
        // the `custom` field beside it already does, and as ruling 288 does for
        // a goal and a title ("a contract Viberr will not write half of").
        const note = String(formData.get("note") ?? "");
        // Questionnaire packets (owner request 2026-08-20): the human's own
        // directive instead of a canned option. Non-empty ⇒ the server ignores
        // the option index and resolves through the synthetic `custom` kind.
        // Ruling 315: same reason — the server refuses this one already, so the
        // route must stop quietly cutting it to the exact length that would slip
        // past the refusal.
        const custom = String(formData.get("custom") ?? "");
        // UI-43: the "Retrying on X · streaming to agent logs" toast was
        // computed from the option KIND alone. `resolvePacket` catches a failed
        // `startAgentRun` and merely appends a timeline note ("The retry could
        // not start — …"), so the user was told the retry was streaming when
        // nothing was. Snapshot the run ids and report what actually happened.
        const runIdsBefore = new Set(
          listRunsForTask(db, projectSlug, taskKey).map((r) => r.serverRunId),
        );
        const resolveInput: Parameters<typeof resolvePacket>[1] = {
          projectSlug,
          taskKey,
          optionIndex,
          // Ruling 88: an `accept_completion` option runs the full acceptance
          // contract — Done plus the real, irreversible merge — from a button
          // labelled "Confirm decision", so it is held to the ceremony like
          // every other acceptance door. The key rides on EVERY resolution
          // (this route cannot know the option kind before the server reads the
          // packet); `resolvePacket` consults it on the accepting arm alone, so
          // an ordinary decision stays ack-free. Absent fields ⇒ `null` ⇒ an
          // accepting resolution that skipped the dialog is refused.
          ack: parseAcceptanceDisclosure(formData),
        };
        if (note.trim()) resolveInput.note = note;
        if (custom.trim()) resolveInput.custom = custom;
        const { task: resolvedTask, option } = await resolvePacket(
          db,
          resolveInput,
          actor,
        );
        const retryStarted =
          option.kind === "retry_other_backend" &&
          listRunsForTask(db, projectSlug, taskKey).some(
            (r) => !runIdsBefore.has(r.serverRunId),
          );
        const toast =
          option.kind === "accept_completion"
            ? completionToast("accepted", taskKey, terminalStageNameFor(getProject(db, projectSlug)))
            // Ruling 164 (pass 35, F35-14): the two kinds that PERFORM what
            // their title promises say what happened, in the same words the
            // button and the picker use. A generic "Decision recorded" was the
            // whole defect: the record read like an act.
            : option.kind === "force_accept"
              ? completionToast("forced", taskKey, terminalStageNameFor(getProject(db, projectSlug)))
              : option.kind === "move_stage"
                ? resolvedTask.stage === option.toStage
                  ? `Decision recorded · ${taskKey} moved to ${stageName(
                      getProject(db, projectSlug)?.stages ?? [],
                      resolvedTask.stage,
                    )}`
                  : // Toast honesty: the move runs after the decision and can
                    // refuse (the task moved underneath it, the project froze).
                    // Its reason is the timeline note the resolution wrote.
                    "Decision recorded, but the stage move did NOT complete. The reason is on the timeline"
            : option.kind === "block_on_policy"
              ? // R20-1 (F20-5): the option UNBLOCKS + re-queues the operator now
                // (it used to hold the task and deep-nav to settings).
                "Unblocked · the operator re-runs to re-check"
              : option.kind === "hold_runtime_debug"
                ? "Held for runtime debug · the session is recorded per audit policy"
                : option.kind === "retry_other_backend"
                  ? retryStarted
                    ? `Retrying on ${option.backend ? BACKEND_LABEL[option.backend] : "Claude"} · streaming to agent logs`
                    : "Decision recorded, but the retry could NOT start. The reason is on the timeline"
                  : option.kind === "edit_goal"
                    ? "Decision recorded · type the new goal; the packet clears when it lands"
                    : `Decision recorded: ${option.t}`;
        const resolved = {
          ok: true as const,
          intent,
          kind: option.kind,
          toast,
        };
        // F17-L3: a scoping (edit_goal) decision drops the human into the goal
        // editor — prefill it with the CHOSEN option's draft so they don't
        // have to retype the scope they just picked. Ruling 138: the ONE
        // composition (`goalDraftForOption`) is shared with the reload path,
        // so the editor opens the same text either way. Every other kind
        // ships NO `goalDraft` key at all, which is what tells the editor
        // there is nothing to prefill.
        if (option.kind !== "edit_goal") return resolved;
        return { ...resolved, goalDraft: goalDraftForOption(option) };
      }
      case "request-maintainer-decision": {
        // F20-18: a contributor-OWNER holds no option they can settle on this
        // packet — hand the decision UP. The server notifies the maintainers +
        // admins, records the ask on the timeline, and refuses (with a pointer)
        // if the caller could actually resolve it themselves.
        const note = String(formData.get("note") ?? "").slice(0, 2000);
        const escalateInput: Parameters<
          typeof requestPacketMaintainerDecision
        >[1] = { projectSlug, taskKey };
        if (note.trim()) escalateInput.note = note;
        const { notified } = await requestPacketMaintainerDecision(
          db,
          escalateInput,
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast:
            notified > 0
              ? `Sent to ${countLabel(notified, "maintainer")} · they'll decide`
              : "Sent · a maintainer will decide",
        };
      }
      case "complete-merge": {
        // Run the REAL merge for a PR accepted "merge pending" (D3/S2).
        // admin|maintainer; server re-checks. Reports honestly if still blocked.
        const result = await completeTaskMerge(db, { projectSlug, taskKey }, actor);
        return {
          ok: true as const,
          intent,
          toast: result.merged
            ? result.message
            : `Not merged: ${result.message}`,
        };
      }
      case "accept-completion": {
        // P14-LV-06: the human acceptance the review queue promises, as a
        // first-class control instead of something an operator has to recommend
        // first. A human moving a task INTO the terminal stage IS accepting the
        // completion — `transitionStage` routes that through the full acceptance
        // contract (every gate, the real merge attempt, the completion event),
        // and its `requireAcceptCompletion` carries the owner exception (R6-2),
        // so a contributor who owns the task passes here exactly as the queue
        // said they would.
        const proj = getProject(db, projectSlug);
        const terminal = proj?.stages[proj.stages.length - 1]?.id;
        if (!terminal) {
          return data(
            { ok: false as const, error: "This project has no stages to accept into." },
            { status: 400 },
          );
        }
        const task = await transitionStage(
          db,
          {
            projectSlug,
            taskKey,
            toStageId: terminal,
            manual: true,
            // Ruling 88: the ceremony's echo of what it displayed. Absent ⇒
            // `null` ⇒ the server refuses this accept.
            ack: parseAcceptanceDisclosure(formData),
          },
          actor,
        );
        const toName = stageName(proj?.stages ?? [], task.stage);
        return {
          ok: true as const,
          intent,
          toast: completionToast("accepted", taskKey, toName),
        };
      }
      case "refresh-and-review": {
        // Ruling 449 (O39-c): the accept dialog's safe answer to a reviewed
        // head that is behind the base. The person's refresh, then the
        // re-review of the head that will merge. A refusal of the step
        // itself (a conflict, nothing to re-run) is the toast.
        const result = await refreshAndReview(db, { projectSlug, taskKey }, actor);
        if (result.status !== "refreshed") {
          return data({ ok: false as const, error: result.message }, { status: 409 });
        }
        return { ok: true as const, intent, toast: result.message };
      }
      case "deliver-review": {
        // R15-2 safety net (b): a human performs delivery (push + review PR)
        // directly. Maintainer+ or the task's own owner — enforced (and
        // audited as github.delivery.manual) inside manualDeliverForReview.
        const outcome = await manualDeliverForReview(
          db,
          { projectSlug, taskKey },
          actor,
        );
        return outcome.status === "delivered"
          ? {
              ok: true as const,
              intent,
              // Ruling 134(a): one toast for every human delivery door.
              toast: deliveryToast(outcome),
            }
          : data(
              {
                ok: false as const,
                error: `Delivery did not complete: ${outcome.message}`,
              },
              { status: 409 },
            );
      }
      case "run-gates": {
        // Ruling 482: run the project's gates on the revision under review
        // again. Same tier as a manual delivery (maintainer+ or the owner),
        // enforced and audited inside runProjectGatesByHand; queued, never run
        // on this request.
        const outcome = await runProjectGatesByHand(db, { projectSlug, taskKey }, actor);
        return outcome.status === "not_owed"
          ? data({ ok: false as const, error: outcome.message }, { status: 409 })
          : { ok: true as const, intent, toast: outcome.message };
      }
      case "attach-file": {
        // F39-6: the human writer the attachments panel never had. Multipart,
        // one file per submit; `attachTaskFile` does the authorization
        // (`attach-file`, contributor+), the name/extension/size refusals, the
        // timeline note and the audit row.
        const file = formData.get("file");
        if (!(file instanceof File) || file.size === 0) {
          return data(
            { ok: false as const, error: "Choose a file to attach." },
            { status: 400 },
          );
        }
        const { attachment } = await attachTaskFile(
          db,
          {
            projectSlug,
            taskKey,
            name: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `${attachment.name} attached${attachment.replaced ? " (replaced)" : ""} · agents on this task can read it`,
        };
      }
      case "remove-attachment": {
        // Ruling 582: admin-only (`remove-from-record`), enforced in the writer.
        const { name } = await removeTaskAttachment(
          db,
          {
            projectSlug,
            taskKey,
            name: String(formData.get("name") ?? ""),
            reason: String(formData.get("reason") ?? ""),
          },
          actor,
        );
        return { ok: true as const, intent, toast: `${name} removed from ${taskKey}` };
      }
      case "archive-task":
      case "restore-task": {
        // R14-3: the terminal disposition for abandoned work — the ending the
        // closed-PR guidance has been telling humans to use since pass 13.
        // maintainer+ (`approve-transition`), enforced inside setTaskArchived.
        const result = await setTaskArchived(
          db,
          { projectSlug, taskKey, archived: intent === "archive-task" },
          actor,
        );
        return { ok: true as const, intent, toast: result.toast };
      }
      case "force-accept": {
        // Admin-only override of the review gate (DG-2): accept a task wedged on
        // an un-recordable required reviewer or a stale blocked packet. Audited.
        // Ruling 88: force overrides the GATES, never the disclosure — its
        // ceremony states more, not less, so it echoes on the same terms.
        await forceAcceptCompletion(
          db,
          { projectSlug, taskKey, ack: parseAcceptanceDisclosure(formData) },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: completionToast("forced", taskKey, terminalStageNameFor(getProject(db, projectSlug))),
        };
      }
      case "owner-take": {
        await setOwner(
          db,
          { projectSlug, taskKey, targetUserId: ctx.user.id },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `You own ${taskKey} · review & acceptance`,
        };
      }
      case "owner-assign": {
        const targetUserId = String(formData.get("userId") ?? "");
        const task = await setOwner(
          db,
          { projectSlug, taskKey, targetUserId },
          actor,
        );
        const first =
          task.owner && task.owner.kind === "human"
            ? task.owner.name.split(" ")[0]
            : "the member";
        return {
          ok: true as const,
          intent,
          toast: `Ownership handed to ${first}`,
        };
      }
      case "owner-release": {
        // Capture the seat before it empties (forced = admin releasing
        // someone else — drives the distinct toast copy).
        const before = getTaskSummary(db, projectSlug, taskKey);
        const prev =
          before?.owner && before.owner.kind === "human" ? before.owner : null;
        const forced = !!(prev && prev.userId !== ctx.user.id);
        await releaseOwner(db, { projectSlug, taskKey }, actor);
        return {
          ok: true as const,
          intent,
          forced,
          toast: forced
            ? `${prev!.name.split(" ")[0]} released from ${taskKey} · admin action`
            : `Ownership released on ${taskKey}`,
        };
      }
      case "transition": {
        // Manual stage change from the Current-state dropdown (admin|maintainer).
        // `manual` lets the move cross any stage, not just a governed boundary;
        // the same server rules still post the **Transition:** timeline comment.
        const toStageId = String(formData.get("to") ?? "");
        // F19-37 + ruling 88: a manual move into the LAST stage IS an
        // acceptance (`transitionStage` routes it to `acceptCompletion` — the
        // real, irreversible merge), so this door demands the ceremony's echo
        // exactly like the Accept button does. Every other move is an ordinary
        // transition and carries no acceptance disclosure at all.
        const stages = getProject(db, projectSlug)?.stages ?? [];
        const acceptsCompletion =
          stages.length > 0 && toStageId === stages[stages.length - 1]!.id;
        const move: Parameters<typeof transitionStage>[1] = {
          projectSlug,
          taskKey,
          toStageId,
          manual: true,
        };
        // Ruling 381: why the person moved it. Required going BACKWARD, which
        // the server decides (it is the side that knows the stage order).
        const moveReason = String(formData.get("reason") ?? "").trim();
        if (moveReason) move.reason = moveReason;
        if (acceptsCompletion) move.ack = parseAcceptanceDisclosure(formData);
        // F32-10 (pass 32): a no-op move must not be narrated as a move. The
        // server's idempotent short-circuit now pays the same gate as a real
        // move, so a refusal never reaches here; a permitted same-stage post
        // simply reports that nothing changed (toast-honesty: never claim an
        // event that did not happen).
        const stageBefore = getTaskSummary(db, projectSlug, taskKey)?.stage;
        const task = await transitionStage(db, move, actor);
        const proj = getProject(db, projectSlug);
        const toName = stageName(proj?.stages ?? [], task.stage);
        return {
          ok: true as const,
          intent,
          stage: task.stage,
          toast:
            stageBefore === task.stage
              ? `${taskKey} is already at ${toName} · nothing changed`
              : `Moved ${taskKey} to ${toName}`,
        };
      }
      case "run-interrupt": {
        // Real governed action (runs spec §5.1): RBAC admin|maintainer,
        // writes interrupted state + audit event. Idempotent-safe.
        const result = await interruptRun(
          db,
          { projectSlug, taskKey, runId: String(formData.get("runId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast:
            result.outcome === "interrupted"
              ? "Run interrupted · the thread stays resumable"
              : "That run already finished · nothing to interrupt",
        };
      }
      case "run-agent": {
        // Dynamic-dispatch rework (2026-08-29): the ONE manual dispatch —
        // replaces assign-specialist / run-specialist / assign-reviewer /
        // run-reviewer. Pick any deployed agent (the @-style selector), give it
        // an optional prompt, and run it. Engage-if-needed with
        // capability-derived posture lives in startAgentRun; the optional
        // `backend` is the D4 retry-on-other-backend override. The dispatching
        // human is the completion contract's triggerer: the run's report tags
        // them + @operator, and the completion re-invokes the operator.
        const profileId = String(formData.get("profileId") ?? "");
        if (!profileId) throw AppError.validation("Pick an agent to run.");
        const prompt = String(formData.get("prompt") ?? "").trim();
        if (prompt.length > 4000) {
          throw AppError.validation("Keep the run prompt under 4000 characters.");
        }
        // The DISPLAY name, exactly as the @operator steer path resolves it —
        // the run's report tags "@<name>", and only a known display name chips
        // and notifies (R21-9's live catch: `actor.label` is the email).
        const dispatcherName = userDisplayName(db, actor.userId);
        const dispatch: Parameters<typeof startAgentRun>[1] = {
          projectSlug,
          taskKey,
          profileId,
          triggeredByName: dispatcherName,
          triggeredByUserId: actor.userId,
          ...backendOverride(formData),
        };
        if (prompt) {
          dispatch.directive = prompt;
          dispatch.directiveFrom = dispatcherName;
        }
        // R21-9's law, applied to the dispatch prompt: a directive that reaches
        // an agent off the record is invisible to supervision — record it as the
        // human's own timeline comment addressed to the agent. BEFORE the start
        // (ruling 375): ruling 203's redelivery window is "a human comment
        // addressed to this agent, posted after this run started", and the
        // record used to be written after the start, so every prompted manual
        // dispatch ran twice — the run, then the same words redelivered as an
        // @mention the moment it finished (live, 2026-09-21: two identical
        // replies on BNB-26 and on BNB-28, one session each). Recorded first,
        // the comment predates the run it is the directive of and no window
        // ever holds it. A refused start leaves the person's words on the
        // record with the refusal beside them (below), which is the honest
        // account of what was asked and why nothing ran.
        const handle =
          listDeployedSpecialists(projectSlug).find((sp) => sp.id === profileId)?.name ??
          profileId;
        if (prompt) {
          await appendComment(
            db,
            {
              projectSlug,
              taskKey,
              text: `@${handle} ${prompt}`,
              forceToAgent: true,
            },
            actor,
          );
        }
        let result: Awaited<ReturnType<typeof startAgentRun>>;
        try {
          result = await startAgentRun(db, dispatch, actor);
        } catch (error) {
          // Ruling 452: refused because this agent is already running, the
          // directive recorded above sits inside that run's window, and ruling
          // 203 delivers it when the run finishes. The note and the toast say
          // so; "No run started" beside a 409 telling the person to wait and
          // start another was how the same words got delivered twice.
          if (prompt && isAgentBusy(error) && error.busyProfileId === profileId) {
            await appendComment(
              db,
              { projectSlug, taskKey, text: directiveDeferredNote(handle) },
              actor,
            );
            return {
              ok: true as const,
              intent,
              toast:
                `${handle} is already running on this task, so no second run started. ` +
                "Your prompt is on the timeline and is delivered to it when that run finishes.",
            };
          }
          // Ruling 152(c) (pass 35, G35-4): a hold is not a refusal. The
          // dispatcher already scheduled the retry for the reopen instant and
          // put the prompt on that schedule, so the person reads the hold as
          // the outcome; the recorded directive predates that later run too.
          if (isDispatchHeld(error)) {
            return { ok: true as const, intent, toast: error.userMessage };
          }
          if (prompt) {
            const message = errorMessage(error);
            await appendComment(
              db,
              {
                projectSlug,
                taskKey,
                text: `No run started for ${handle}: ${message}`,
              },
              actor,
            );
          }
          throw error;
        }
        // Ruling 263 (F37-93): the toast said "run started" for a run refused
        // before any process existed, and for one parked behind the cap. The
        // agent-logs half of that sentence is a promise of a stream that a
        // refused run never produces.
        if (result.outcome === "refused") {
          return {
            ok: true as const,
            intent,
            toast: `No run started for ${result.name}: ${result.refusal ?? "it was refused before any process started."}`,
          };
        }
        if (result.outcome === "queued") {
          return {
            ok: true as const,
            intent,
            toast: `${result.name} is queued behind the concurrent-run cap · it starts when a slot frees`,
          };
        }
        return {
          ok: true as const,
          intent,
          toast: `${BACKEND_LABEL[result.backend]} run started for ${result.name} · streaming to agent logs`,
        };
      }
      case "release-agent": {
        // Release a supporting engagement from the task (the delivering
        // engagement is not releasable — it owns the workspace/branch).
        const result = await removeReviewer(
          db,
          { projectSlug, taskKey, profileId: String(formData.get("profileId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.removed ? "Agent released" : "That agent wasn't engaged",
        };
      }
      case "apply-recommendation": {
        // A human accepts an operator recommendation card — executes the
        // recommended assign/reviewer/transition through the governed mutation.
        // Ruling 88 (F19-3, live-proven: one Apply click merged an unreviewed
        // head into main): a card that REACHES acceptance — `accept_completion`,
        // or a transition onto the terminal stage — demands the ceremony's echo.
        // The key rides on every apply; `applyRecommendation` consults it only
        // on the arms that accept, so assigning, running and ordinary re-stages
        // stay ack-free.
        const result = await applyRecommendation(
          db,
          {
            projectSlug,
            taskKey,
            recId: String(formData.get("recId") ?? ""),
            ack: parseAcceptanceDisclosure(formData),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          // Ruling 134(a): an applied delivery card says what moved.
          toast: result.delivery
            ? `Applied · ${deliveryToast(result.delivery)}`
            : `Applied · ${result.label}`,
        };
      }
      case "dismiss-recommendation": {
        const result = await dismissRecommendation(
          db,
          { projectSlug, taskKey, recId: String(formData.get("recId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.label ? `Dismissed · ${result.label}` : "Recommendation dismissed",
        };
      }
      case "run-operator": {
        // Run the operator agent to coordinate the task. Triggering runtime
        // work is the `run-agents` action (single ACTION_ROLES source, pass-4
        // XS-10) resolved through the ONE authority path — org admins pass as
        // the audited D2 override. The operator's OWN capability policy governs
        // what it may then do to the task.
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "run the operator",
        );
        // R21-9 / R22 / F22-01: this run takes NO per-request backend or
        // autonomy — both are resolved from the DEPLOYED operator profile inside
        // `runOperator` (`resolveOperatorAuthority`). The manual run control
        // (R21-9) and the schedule form (R22) both stopped sending them, so the
        // route no longer reads them either: a crafted POST could otherwise run
        // a Codex-configured operator on Claude (autonomy is clamped by ruling
        // 67, but backend was not). The run always follows the live profile.
        const operatorInput: RunOperatorInput = {
          projectSlug,
          taskKey,
          // Attribute the run to the human who pressed the button (D8) — the
          // operator's own actions are still audited as the operator, but the
          // "started a run" audit row names the maintainer who launched it.
          actor: { userId: actor.userId, label: actor.label },
        };
        // Owner request 2026-08-21: an optional steer typed on the Run control.
        // It rides the SAME machinery as an `@operator` comment (the N20-15
        // mention path): recorded on the timeline as the human's own comment —
        // a directive that reaches an agent off the record would be invisible
        // to supervision — and passed as the run's `humanComment`, so the turn
        // doctrine addresses exactly what they asked. The comment is written
        // with the low-level writer, not `commentToAgent`, because THIS call
        // already starts the run — the mention path would start a second one.
        const steer = String(formData.get("steer") ?? "").trim().slice(0, 2000);
        if (steer) {
          operatorInput.trigger = "manual";
          operatorInput.humanComment = steer;
          // The DISPLAY name, exactly as the @operator mention path passes it —
          // the operator tags "@<name>" in its reply, and only a known display
          // name chips and notifies (NEW-4; live-caught: `actor.label` is the
          // email, and "@arda@viberr.dev" notified nobody).
          operatorInput.humanCommentBy = userDisplayName(db, actor.userId);
        }
        const started = await runOperator(db, operatorInput);
        // Record the steer as an @operator timeline comment ONLY once the run is
        // not refused — a directive that reaches an agent off the record would be
        // invisible to supervision, but a refused run (open packet / terminal
        // stage) would otherwise strand the comment with no run to address it.
        // The UI disables the steer input in exactly those states, so this guards
        // the crafted-POST path. `humanComment` still rides the run's input, so a
        // started/queued run addresses the directive.
        if (steer && !started.refused) {
          await appendComment(
            db,
            { projectSlug, taskKey, text: `@operator ${steer}`, forceToAgent: true },
            actor,
          );
        }
        const backendLabel = BACKEND_LABEL[started.backend];
        return {
          ok: true as const,
          intent,
          // A7 (pass 23), BUG-2's sibling on the manual "Run operator" control:
          // runOperator REFUSES with `refused: "open-packet" | "terminal-stage"`
          // (an open decision blocks it; a terminal-stage task is scheduled-only),
          // and this toast branched on `queued` alone — so a refused start toasted
          // "Operator running" for a run that never began. The UI disables the
          // control in those states, so this is the crafted-POST / SSE-race path;
          // it now tells the truth, exactly as commentToAgent does (PR #195).
          // B10 (pass 16): a trigger that lands while a run already holds the
          // lease is QUEUED, not started — it drains when the current run ends.
          toast:
            started.refused === "open-packet"
              ? "Operator not started · resolve the open decision to continue"
              : started.refused === "closed"
                ? `Operator not started · ${started.refusalReason ?? "reopen the task to run the operator"}`
                : started.queued
                  ? `Operator queued · runs when the current run finishes · ${backendLabel} · ${started.autonomy} autonomy`
                  : `Operator running · ${backendLabel} · ${started.autonomy} autonomy`,
        };
      }
      case "schedule-action": {
        // Schedule a future run (O-3, generalized by the dynamic-dispatch
        // rework): the operator, or a chosen agent with a prompt — the same two
        // run controls, deferred. Triggering agent work later is still
        // `run-agents` (maintainer+); the server-side runner fires it.
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "schedule a run",
        );
        // Hunt 2026-08-29: both inputs were unclamped — a crafted delayMinutes
        // (1e15) overflowed Date into a RangeError 500, and the prompt had no
        // cap while its sibling run-agent arm enforces 4000. Same bounds, and
        // a validation refusal instead of a crash. 28 days is the ceiling: a
        // schedule further out than the retention story is a note, not a plan.
        const rawMinutes = Number(formData.get("delayMinutes"));
        if (!Number.isFinite(rawMinutes) || rawMinutes < 1 || rawMinutes > SCHEDULE_MAX_MINUTES) {
          throw AppError.validation(SCHEDULE_BOUNDS_SENTENCE);
        }
        const minutes = Math.round(rawMinutes);
        const schedPrompt = String(formData.get("prompt") ?? "");
        if (schedPrompt.length > 4000) {
          throw AppError.validation("Keep the run prompt under 4000 characters.");
        }
        const dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
        const schedProfileId = String(formData.get("profileId") ?? "").trim();
        // R22: no backend/autonomy — the fired run resolves the LIVE deployed
        // profile (parity with R21-9's manual run control). A profileId is what
        // selects the agent arm; without one the operator re-runs.
        const schedInput: Parameters<typeof scheduleTaskAction>[1] = {
          projectSlug,
          taskKey,
          dueAt,
          prompt: schedPrompt,
        };
        if (schedProfileId) {
          schedInput.action = "run-agent";
          schedInput.profileId = schedProfileId;
        }
        // Display name for the same reason as run-agent above: the scheduler's
        // label becomes the fired run's triggerer tag and the "by <name>" row.
        const sched = await scheduleTaskAction(db, schedInput, {
          userId: actor.userId,
          label: userDisplayName(db, actor.userId),
        });
        return {
          ok: true as const,
          intent,
          toast: schedProfileId
            ? `Scheduled · agent run in ${minutes} min`
            : `Scheduled · operator re-run in ${minutes} min`,
          scheduleId: sched.id,
        };
      }
      case "cancel-schedule": {
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "cancel a scheduled run",
        );
        const result = await cancelScheduledAction(
          db,
          { projectSlug, taskKey, scheduleId: String(formData.get("scheduleId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.cancelled ? "Schedule cancelled" : "That schedule was already resolved",
        };
      }
      default:
        return data(
          { ok: false as const, error: "Unknown action." },
          { status: 400 },
        );
    }
  } catch (error) {
    return appErrorResponse(error);
  }
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  return [
    {
      // D32-3: the product name closes every title.
      title: loaderData
        ? pageTitle(`${loaderData.task.key} · ${loaderData.task.title}`)
        : pageTitle(params.key),
    },
  ];
}

export default function TaskDetailRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;

  const members: TaskMemberView[] = layout.members.map((m) => ({
    userId: m.userId,
    role: m.role,
    user: {
      name: m.user.name,
      initials: m.user.kind === "human" ? m.user.initials : undefined,
      tone: m.user.kind === "human" ? m.user.tone : undefined,
    },
  }));

  return (
    <TaskDetailPage
      // Remount on task switch: resets composer draft, filter, dialogs and
      // log selection (mock `key={task.key}` behavior, spec §1).
      key={loaderData.task.key}
      task={loaderData.task}
      labelSuggestions={loaderData.labelSuggestions}
      epics={loaderData.epics}
      attachments={loaderData.attachments}
      attachmentsTotal={loaderData.attachmentsTotal}
      attachmentProducers={loaderData.attachmentProducers}
      // Ruling 521: the completion packet the acceptance decision shows.
      completion={loaderData.completion}
      attachmentsBase={`/projects/${params.slug}/tasks/${loaderData.task.key}/attachments`}
      // Ruling 484: the Changes panel's read, beside the page it posts notes to.
      changesUrl={`/projects/${params.slug}/tasks/${loaderData.task.key}/changes`}
      // Ruling 548: the Blocked by picker's list of the project's tasks.
      dependencyCandidatesUrl={`/projects/${params.slug}/tasks/${loaderData.task.key}/dependency-candidates`}
      runtime={loaderData.runtime}
      deployedSpecialists={loaderData.deployedSpecialists}
      operatorBackend={loaderData.operatorBackend}
      operatorAutonomy={loaderData.operatorAutonomy}
      operatorAcceptsDirectly={loaderData.operatorAcceptsDirectly}
      // Ruling 127: the run picker's "would fail fast" gate answers for the
      // task OWNER (whose accounts a run bills), and an unowned task can run
      // nothing at all. The panels render the refusal that names the person,
      // so the whole principal travels, not a pair of booleans that could only
      // ever say "no" without saying whose "no" it is.
      runPrincipal={loaderData.runPrincipal}
      liveAgentRuns={loaderData.liveAgentRuns}
      runsVisible={loaderData.runsVisible}
      timelineHasMore={loaderData.timelineHasMore}
      timelineRemaining={loaderData.timelineRemaining}
      timelineNextLimit={loaderData.timelineNextLimit}
      tlDefault={loaderData.tlDefault}
      members={members}
      me={{ id: layout.user.id, name: layout.user.name }}
      myRole={layout.myRole}
      mentionables={loaderData.mentionables}
      taskLinks={loaderData.taskLinks}
      recommendations={loaderData.recommendations}
      schedules={loaderData.schedules}
      // Ruling 320: the loader has read these since ruling 241 and the panel
      // has rendered them since ruling 241, and the two were never joined —
      // the prop defaults to `[]` at both ends, so the row simply never
      // appeared. See the wire test in task-detail-route.server.test.ts.
      queuedQuestions={loaderData.queuedQuestions}
      // Ruling 319: what else this packet's confirm answers.
      packetAlsoAnswers={loaderData.packetAlsoAnswers}
      // Ruling 324: what already looks like what a create_task option would make.
      packetCreateTaskEchoes={loaderData.packetCreateTaskEchoes}
      archived={loaderData.archived}
      acceptance={loaderData.acceptance}
      githubHost={loaderData.githubHost}
      githubReconciledAt={loaderData.githubReconciledAt}
      baseBehindBy={loaderData.baseBehindBy}
      mergeCollisions={loaderData.mergeCollisions}
      githubCheckedAt={loaderData.githubCheckedAt}
      workRevisionSha={loaderData.workRevisionSha}
      noChanges={loaderData.noChanges}
      filesDeliveredAt={loaderData.filesDeliveredAt ?? null}
      defaultBranch={loaderData.defaultBranch}
      canDeliver={loaderData.canDeliver}
    />
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const params = useParams();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="task-preview" data-screen-label="Task detail · not found">
      <section className="panel">
        <div className="panel-head">
          <h2>{notFound ? "Task not found" : "Something went wrong"}</h2>
          <span className="right pill blocked">
            <span className="pdot" />
            {notFound ? "not found" : "error"}
          </span>
        </div>
        <p className="tp-goal">
          {notFound
            ? `${params.key ?? "This task"} isn't in this project's store yet.`
            : "An unexpected error occurred loading this task."}
        </p>
        <div className="tp-foot">
          <Link className="btn" to={`/projects/${params.slug}/board`}>
            <Icon name="board" />
            Back to board
          </Link>
        </div>
      </section>
    </div>
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.task");
