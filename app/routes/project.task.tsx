import {
  data,
  isRouteErrorResponse,
  Link,
  useParams,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/project.task";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import {
  getTaskDetail,
  getTaskSummary,
} from "~/server/projections/task-query.server";
import {
  isTaskViewNavigation,
  markTaskNotificationsSeen,
} from "~/server/projections/notifications.server";
import { logger } from "~/server/logging/logger.server";
import {
  applyRecommendation,
  commentToAgent,
  completeTaskMerge,
  dismissRecommendation,
  forceAcceptCompletion,
  manualDeliverForReview,
  releaseOwner,
  requestPacketMaintainerDecision,
  resolveAcceptanceAffordance,
  resolvePacket,
  setOwner,
  setTaskArchived,
  transitionStage,
  updateTaskGoal,
} from "~/server/tasks/task-actions.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listTaskAttachments } from "~/server/files/task-attachments.server";
import {
  assignReviewer,
  assignSpecialist,
  listDeployedSpecialists,
  removeReviewer,
  startAgentRun,
} from "~/server/tasks/specialist-run.server";
import { getMentionables } from "~/server/tasks/mention-suggestions.server";
import { githubWebHost } from "~/server/github/github-client.server";
import { latestTaskReconcileAt } from "~/server/provenance/provenance-query.server";
import { latestTaskReconcileCheckAt } from "~/server/audit/audit-query.server";
import { interruptRun, listRunsForTask } from "~/server/runtimes/run-service.server";
import {
  runOperator,
  type RunOperatorInput,
} from "~/server/runtimes/operator-run.server";
import {
  isBackendAvailable,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import {
  operatorAutonomyFor,
  operatorBackendFor,
  type OperatorAutonomy,
} from "~/server/tasks/operator-actions.server";
import { parseAcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { getProject, listProjectMembers } from "~/server/projections/board-query.server";
import { requireVisibleProject } from "./project-visibility.server";
import {
  requireRunAgents,
  type AuthorityProject,
} from "~/server/auth/project-authority.server";
import {
  cancelScheduledAction,
  scheduleTaskAction,
} from "~/server/tasks/schedule.server";
import { TaskDetailPage } from "~/features/task-detail/task-detail-page";
import type { TaskMemberView } from "~/features/task-detail/execution-profile";
import type { TimelineFilterId } from "~/features/task-detail/timeline";
import {
  clampTimelineLimit,
  sliceTimeline,
} from "~/features/task-detail/timeline-slice";
import { roleCan } from "~/shared/rbac";
import { Icon } from "~/ui/icon";

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
 *   comment · resolve-packet · owner-take · owner-assign · owner-release ·
 *   transition · accept-completion · archive-task · restore-task ·
 *   run-interrupt · assign-specialist · run-specialist ·
 *   assign-reviewer · run-reviewer · remove-reviewer
 */

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
  const detail = getTaskDetail(db, params.slug, params.key);
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
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  const limit = clampTimelineLimit(
    new URL(request.url).searchParams.get("events"),
  );
  const slice = sliceTimeline(detail.timeline, limit);
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
  const runsMembership = new Set(
    listProjectMembers(db, params.slug).map((m) => m.userId),
  );
  const runsVisible = runsMembership.has(user.id) || user.role === "admin";
  //
  // P13-D-11: the member projection ships a BOUNDED window of each agent
  // group's console (newest lines within `RUN_LOG_WINDOW_*`), not the whole
  // raw execution history — NFR5. `logWindow` carries the cursor the console
  // pages backwards with via `/resources/run-log?before=`. A non-member's
  // withheld projection reports an empty window so nothing tries to page it.
  const runtime = runsVisible
    ? listRunsForTask(db, params.slug, params.key)
    : listRunsForTask(db, params.slug, params.key).map((r) => ({
        ...r,
        sid: null,
        exportable: false,
        lines: [],
        raw: [],
        lineCount: 0,
        logWindow: {
          totalLines: 0,
          hasMore: false,
          runIds: [],
          oldest: null,
          headSeq: -1,
        },
      }));

  // Deployed specialists the "Assign specialist" menu offers.
  const deployedSpecialists = listDeployedSpecialists(params.slug);
  // F10-04: per-engagement run gating. The server single-flights only the
  // DELIVERING run; supporting/reviewing runs are read-only and may run
  // concurrently. So the delivering Run button disables only on an active
  // delivering run, and each reviewer's Run button disables only on ITS OWN
  // active run — not on any run anywhere (the old `runActive` boolean disabled
  // every button whenever a single run was live, contradicting the server).
  const activeRuns = runtime.filter(
    (r) => r.lifecycle === "running" || r.lifecycle === "queued",
  );
  const deliveringActive = activeRuns.some((r) => r.kind === "primary" && !r.op);
  const activeReviewerIds = activeRuns.flatMap((r) =>
    r.kind === "reviewer" && r.profileId ? [r.profileId] : [],
  );

  // @-mention autocomplete directory for the comment composer: deployed
  // specialists, registered users, and the reserved backend/role handles —
  // the same targets the server resolves an @mention to when a comment posts.
  const mentionables = getMentionables(db, params.slug, params.key);

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

  // R15-1: the accept confirm names exactly what merges — the delivered
  // revision (task file) and the merge target (project default branch).
  const workRevisionSha =
    taskFile?.parsed.frontmatter.workRevision?.headSha ?? null;
  // R17-2: a verified no-change completion (empty branch, no PR) accepts to Done
  // without a merge — the confirm says so instead of implying delivered work.
  const noChanges = taskFile?.parsed.frontmatter.noChanges === true;
  const project = getProject(db, params.slug);
  const defaultBranch = project?.defaultBranch || "main";
  // R15-2 safety net (b): manual delivery is maintainer+ (run-agents tier) or
  // the task's own owner — mirror of manualDeliverForReview's server gate.
  const myProjectRole =
    listProjectMembers(db, params.slug).find((m) => m.userId === user.id)
      ?.role ?? null;
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

  return {
    task: { ...detail, timeline: slice.events },
    attachments,
    recommendations,
    schedules,
    archived,
    // P14-LV-06: the review queue counted this viewer under "Waiting on your
    // acceptance" while the page rendered acceptance ONLY as an operator
    // recommendation card — so a withdrawn recommendation left the promised
    // decision with no control at all. Acceptance is a standing authority at the
    // review boundary; both surfaces now read it from the same predicate.
    acceptance: resolveAcceptanceAffordance({
      projectSlug: params.slug,
      taskKey: params.key,
      viewerUserId: user.id,
    }),
    timelineTotal: slice.total,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
    deployedSpecialists,
    // P11-76: the operator's configured backend so the run picker defaults to it.
    operatorBackend: operatorBackendFor({}, params.slug),
    // R19-A: the ceiling, so the run picker offers only what will actually run.
    operatorAutonomy: operatorAutonomyFor({}, params.slug),
    // P11-41: which backends are actually configured, so the run picker can
    // disable an option that would fail fast rather than offering it blindly.
    backendAvailable: {
      claude: isBackendAvailable("claude"),
      codex: isBackendAvailable("codex"),
    },
    deliveringActive,
    activeReviewerIds,
    /** UI-30: false → the console content above was withheld (non-member). */
    runsVisible,
    mentionables,
    // UI-57: the task's GitHub card (branch / diff / commits / PR) is served
    // from the SAME cached projection the GitHub page labels "Updated 3m ago /
    // Not yet synced" — but here it carried no freshness cue at all, so stale
    // state looked current. Ship the newest reconcile time for this task.
    // P13-D-16: this was the only raw `.prepare(` in any page route — a hand-
    // written provenance query in a loader, against the layering rule in
    // architecture.md. It now goes through app/server/provenance/, which owns
    // the table.
    githubReconciledAt: latestTaskReconcileAt(db, params.slug, params.key),
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
 * Ruling 88 (F21-2) — the acceptance disclosure this POST carries, or `null`
 * when it carries none.
 *
 * `null` is deliberately passed THROUGH to the server rather than swallowed
 * here: it is the difference between "an HTTP caller sent no acknowledgment"
 * (refused — the bare POST F21-2 found accepting silently) and "an in-process
 * caller carries its own disclosure contract" (omitted). This route is the one
 * HTTP door onto the human acceptance paths, so every one of them passes an
 * explicit value.
 */
function acceptanceAck(formData: FormData) {
  // Same field read as every other intent in this action: an absent field
  // becomes "", which the parser reads as "no disclosure" rather than a value.
  return parseAcceptanceDisclosure((field) => String(formData.get(field) ?? ""));
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

export async function action({ request, params }: Route.ActionArgs) {
  const {
    auth: ctx,
    db,
    formData,
    actor,
    intent,
  } = await requireFormAction(request);
  const projectSlug = params.slug;
  const taskKey = params.key;
  // R15-4: the layout loader's membership refusal does NOT cover this action —
  // React Router runs a child action without its parent's loader. Outside the
  // try so the refusal stays a thrown 404 Response (the unknown-slug body),
  // never an `appErrorResponse` 403 that would confirm the project exists.
  requireVisibleProject(db, projectSlug, actor, "act on this project");

  try {
    switch (intent) {
      case "comment": {
        // commentToAgent is a superset of appendComment: records the comment,
        // and when an agent is @mentioned (and the commenter is admin|
        // maintainer) resumes THAT agent's session — the agent's reply arrives
        // later as a new agent-authored comment via SSE revalidation.
        const result = await commentToAgent(
          db,
          { projectSlug, taskKey, text: String(formData.get("text") ?? "") },
          actor,
        );
        // Toast copy: name the agent when one is picking the comment up;
        // note when a mention was recorded but the run was not triggered (RBAC);
        // else the original routed/plain copy (verbatim spec contract).
        const toast =
          result.triggered && result.agent
            ? `Comment posted · @${result.agent.name} is picking it up`
            : result.runtimeDenied && result.agent
              ? "Comment posted · your role can't trigger agent runs"
              : result.toAgent
                ? "Comment posted · routed to mentioned agent"
                : "Comment posted";
        return {
          ok: true as const,
          intent,
          toAgent: result.toAgent,
          agent: result.agent?.name ?? null,
          triggered: result.triggered,
          // BUG 3: the grouped Agent-logs entry to auto-select + stream so the
          // user sees the mentioned agent's live output without hunting for it.
          logThreadId: result.logThreadId,
          toast,
        };
      }
      case "update-goal": {
        await updateTaskGoal(
          db,
          { projectSlug, taskKey, goal: String(formData.get("goal") ?? "") },
          actor,
        );
        return { ok: true as const, intent, toast: "Goal updated" };
      }
      case "resolve-packet": {
        const raw = Number(formData.get("option"));
        const optionIndex = Number.isInteger(raw) && raw >= 0 ? raw : -1;
        const note = String(formData.get("note") ?? "").slice(0, 2000);
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
          ack: acceptanceAck(formData),
        };
        if (note.trim()) resolveInput.note = note;
        const { option } = await resolvePacket(db, resolveInput, actor);
        const retryStarted =
          option.kind === "retry_other_backend" &&
          listRunsForTask(db, projectSlug, taskKey).some(
            (r) => !runIdsBefore.has(r.serverRunId),
          );
        const toast =
          option.kind === "accept_completion"
            ? `Completion accepted · ${taskKey} moved to Done`
            : option.kind === "block_on_policy"
              ? // R20-1 (F20-5): the option UNBLOCKS + re-queues the operator now
                // (it used to hold the task and deep-nav to settings).
                "Policy / credential updated · the operator re-runs to re-check"
              : option.kind === "hold_runtime_debug"
                ? "Held for runtime debug — the session is recorded per audit policy"
                : option.kind === "retry_other_backend"
                  ? retryStarted
                    ? `Retrying on ${option.backend === "codex" ? "Codex" : "Claude Code"} · streaming to agent logs`
                    : "Decision recorded, but the retry could NOT start — the reason is on the timeline"
                  : option.kind === "edit_goal"
                    ? "Decision recorded — type the new goal; the packet clears when it lands"
                    : `Decision recorded: ${option.t}`;
        const resolved = {
          ok: true as const,
          intent,
          kind: option.kind,
          toast,
        };
        // F17-L3: a scoping (edit_goal) decision drops the human into the goal
        // editor — prefill it with the CHOSEN option's deliverable so they
        // don't have to retype the scope they just picked. The option title is
        // the headline; its description carries the deliverable + acceptance.
        // Every other kind ships NO `goalDraft` key at all, which is what tells
        // the editor there is nothing to prefill.
        if (option.kind !== "edit_goal") return resolved;
        return {
          ...resolved,
          goalDraft: option.d?.trim()
            ? `${option.t}\n\n${option.d.trim()}`
            : option.t,
        };
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
              ? `Sent to ${notified} maintainer${notified === 1 ? "" : "s"} — they'll decide`
              : "Sent — a maintainer will decide",
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
            : `Not merged — ${result.message}`,
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
            ack: acceptanceAck(formData),
          },
          actor,
        );
        const toName =
          proj?.stages.find((s) => s.id === task.stage)?.name ?? task.stage;
        return {
          ok: true as const,
          intent,
          toast: `Completion accepted · ${taskKey} moved to ${toName}`,
        };
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
              toast: outcome.created
                ? `Delivered · opened review PR #${outcome.prNumber}`
                : `Delivered · reusing open review PR #${outcome.prNumber}`,
            }
          : data(
              {
                ok: false as const,
                error: `Delivery did not complete — ${outcome.message}`,
              },
              { status: 409 },
            );
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
          { projectSlug, taskKey, ack: acceptanceAck(formData) },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Force-accepted ${taskKey} — moved to Done (review gate overridden)`,
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
        if (acceptsCompletion) move.ack = acceptanceAck(formData);
        const task = await transitionStage(db, move, actor);
        const proj = getProject(db, projectSlug);
        const toName =
          proj?.stages.find((s) => s.id === task.stage)?.name ?? task.stage;
        return {
          ok: true as const,
          intent,
          stage: task.stage,
          toast: `Moved ${taskKey} to ${toName}`,
        };
      }
      case "run-interrupt": {
        // Real governed action (runs spec §5.1): RBAC admin|maintainer,
        // writes interrupted state + audit event. Idempotent-safe.
        const result = interruptRun(
          db,
          { projectSlug, taskKey, runId: String(formData.get("runId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast:
            result.outcome === "interrupted"
              ? "Run interrupted — the thread stays resumable"
              : "That run already finished — nothing to interrupt",
        };
      }
      case "assign-specialist": {
        // Deploy a project specialist as the task's primary (contracts §3.2
        // "Open agent runtime sessions" — admin|maintainer, enforced server-side).
        const result = await assignSpecialist(
          db,
          { projectSlug, taskKey, profileId: String(formData.get("profileId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Deployed ${result.name} as specialist`,
        };
      }
      case "run-specialist": {
        // Start a provider run for the assigned specialist. An optional
        // `backend` forces the run onto the other engine — the
        // "retry on the other backend" affordance after an availability/quota
        // failure (D4).
        const result = await startAgentRun(
          db,
          { projectSlug, taskKey, ...backendOverride(formData) },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `${result.backend === "claude" ? "Claude Code" : "Codex"} run started · streaming to agent logs`,
        };
      }
      case "assign-reviewer": {
        // Engage a deployed specialist as a reviewer (admin|maintainer).
        const result = await assignReviewer(
          db,
          { projectSlug, taskKey, profileId: String(formData.get("profileId") ?? "") },
          actor,
        );
        // F21-6: "reviewer" is a claim about AUTHORITY — acceptance waits for a
        // reviewer's approval. This toast made that claim for every supporting
        // engagement, including a profile with verdict=Off that no gate will ever
        // wait on, while the timeline event (fixed with the tool half) said
        // "supporting agent" about the very same click. One fact, one word.
        const capacity = result.verdictCapable ? "a reviewer" : "a supporting agent";
        return {
          ok: true as const,
          intent,
          toast: result.alreadyEngaged
            ? `${result.name} is already engaged as ${capacity}`
            : `Engaged ${result.name} as ${capacity}`,
        };
      }
      case "run-reviewer": {
        // Start a run for a specific engaged reviewer (optional `backend`
        // override for the retry-on-other-backend affordance — D4).
        const result = await startAgentRun(
          db,
          {
            projectSlug,
            taskKey,
            profileId: String(formData.get("profileId") ?? ""),
            ...backendOverride(formData),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `${result.backend === "claude" ? "Claude Code" : "Codex"} reviewer run started · streaming to agent logs`,
        };
      }
      case "remove-reviewer": {
        // Release a reviewer from the task.
        const result = await removeReviewer(
          db,
          { projectSlug, taskKey, profileId: String(formData.get("profileId") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.removed ? "Reviewer released" : "That reviewer wasn't engaged",
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
            ack: acceptanceAck(formData),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Applied · ${result.label}`,
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
        // what it may then do to the task. The backend (claude|codex) and
        // autonomy (supervised|full) are chosen for this run; full autonomy
        // lets the operator drive to Done.
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "run the operator",
        );
        // P11-76: only OVERRIDE the backend/autonomy when the form explicitly
        // asks for one. An absent field must fall through to the operator
        // profile's configured backend (resolveOperatorAuthority applies the
        // deployment default) — a hardcoded "claude" default silently ran a
        // Codex-configured operator on Claude.
        const backendField = String(formData.get("backend") ?? "");
        const backend: RealBackend | undefined =
          backendField === "codex"
            ? "codex"
            : backendField === "claude"
              ? "claude"
              : undefined;
        const autonomyField = String(formData.get("autonomy") ?? "");
        const autonomy: OperatorAutonomy | undefined =
          autonomyField === "full"
            ? "full"
            : autonomyField === "supervised"
              ? "supervised"
              : undefined;
        const operatorInput: RunOperatorInput = {
          projectSlug,
          taskKey,
          // Attribute the run to the human who pressed the button (D8) — the
          // operator's own actions are still audited as the operator, but the
          // "started a run" audit row names the maintainer who launched it.
          actor: { userId: actor.userId, label: actor.label },
        };
        if (backend) operatorInput.backend = backend;
        if (autonomy) operatorInput.autonomy = autonomy;
        const started = await runOperator(db, operatorInput);
        const backendLabel =
          started.backend === "claude" ? "Claude Code" : "Codex";
        return {
          ok: true as const,
          intent,
          // B10 (pass 16): a trigger that lands while a run already holds the
          // lease is QUEUED, not started — it drains when the current run ends.
          // "Operator running" for both left the human watching for a run that
          // had not begun; `queued` now distinguishes them.
          toast: started.queued
            ? `Operator queued · runs when the current run finishes · ${backendLabel} · ${started.autonomy} autonomy`
            : `Operator running · ${backendLabel} · ${started.autonomy} autonomy`,
        };
      }
      case "schedule-action": {
        // Schedule a future operator re-run (O-3). Triggering agent work later
        // is still `run-agents` (maintainer+); the server-side runner fires it.
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "schedule an operator re-run",
        );
        const minutes = Math.max(1, Math.round(Number(formData.get("delayMinutes")) || 0));
        const dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
        const sched = await scheduleTaskAction(
          db,
          {
            projectSlug,
            taskKey,
            dueAt,
            backend: String(formData.get("backend") ?? "claude") === "codex" ? "codex" : "claude",
            autonomy: String(formData.get("autonomy") ?? "supervised") === "full" ? "full" : "supervised",
            note: String(formData.get("note") ?? ""),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Scheduled · operator re-run in ${minutes} min`,
          scheduleId: sched.id,
        };
      }
      case "cancel-schedule": {
        requireRunAgents(
          db,
          runAgentsAuthority(db, projectSlug),
          actor,
          "cancel a scheduled operator re-run",
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
      title: loaderData
        ? `${loaderData.task.key} · ${loaderData.task.title}`
        : params.key,
    },
  ];
}

export default function TaskDetailRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;

  const members: TaskMemberView[] = layout.board.members.map((m) => ({
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
      attachments={loaderData.attachments}
      attachmentsBase={`/projects/${params.slug}/tasks/${loaderData.task.key}/attachments`}
      runtime={loaderData.runtime}
      deployedSpecialists={loaderData.deployedSpecialists}
      operatorBackend={loaderData.operatorBackend}
      operatorAutonomy={loaderData.operatorAutonomy}
      backendAvailable={loaderData.backendAvailable}
      deliveringActive={loaderData.deliveringActive}
      activeReviewerIds={loaderData.activeReviewerIds}
      runsVisible={loaderData.runsVisible}
      timelineHasMore={loaderData.timelineHasMore}
      timelineRemaining={loaderData.timelineRemaining}
      timelineNextLimit={loaderData.timelineNextLimit}
      tlDefault={loaderData.tlDefault}
      members={members}
      me={{ id: layout.user.id, name: layout.user.name }}
      myRole={layout.myRole}
      mentionables={loaderData.mentionables}
      recommendations={loaderData.recommendations}
      schedules={loaderData.schedules}
      archived={loaderData.archived}
      acceptance={loaderData.acceptance}
      githubHost={loaderData.githubHost}
      githubReconciledAt={loaderData.githubReconciledAt}
      githubCheckedAt={loaderData.githubCheckedAt}
      workRevisionSha={loaderData.workRevisionSha}
      noChanges={loaderData.noChanges}
      defaultBranch={loaderData.defaultBranch}
      canDeliver={loaderData.canDeliver}
    />
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const params = useParams();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="task-preview" data-screen-label="Task detail — not found">
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
