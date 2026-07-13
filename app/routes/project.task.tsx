import {
  data,
  isRouteErrorResponse,
  Link,
  useParams,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/project.task";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import {
  getTaskDetail,
  getTaskSummary,
} from "~/server/projections/task-query.server";
import {
  applyRecommendation,
  commentToAgent,
  completeTaskMerge,
  dismissRecommendation,
  missingReviewerApprovalProfileIds,
  releaseOwner,
  recordHumanValidation,
  resolvePacket,
  setOwner,
  transitionStage,
  updateTaskGoal,
} from "~/server/tasks/task-actions.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  assignReviewer,
  assignSpecialist,
  hasRunningRun,
  listDeployedSpecialists,
  removeReviewer,
  startReviewerRun,
  startSpecialistRun,
} from "~/server/tasks/specialist-run.server";
import { getMentionables } from "~/server/tasks/mention-suggestions.server";
import { githubWebHost } from "~/server/github/github-client.server";
import {
  interruptRunAndWait,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { runOperator } from "~/server/runtimes/operator-run.server";
import { getOperatorDispatchStatus } from "~/server/runtimes/operator-dispatch.server";
import { resolveOperatorAuthority } from "~/server/tasks/operator-actions.server";
import {
  getProject,
  listProjectMembers,
} from "~/server/projections/board-query.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { resumeSeededRunningRuns } from "~/server/runtimes/seed-resumer.server";
import { TaskDetailPage } from "~/features/task-detail/task-detail-page";
import type { TaskMemberView } from "~/features/task-detail/execution-profile";
import { resolveOperatorExecutionStatus } from "~/features/task-detail/operator-execution-status";
import type { TimelineFilterId } from "~/features/task-detail/timeline";
import {
  clampTimelineLimit,
  sliceTimeline,
} from "~/features/task-detail/timeline-slice";
import { Icon } from "~/ui/icon";
import { authorizeProjectAction } from "~/shared/rbac";
import { withProjectAuditAuthority } from "~/server/audit/audit-recorder.server";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import {
  hasCurrentHumanValidation,
  repositoryReviewEvidenceReady,
} from "~/server/tasks/review-evidence.server";

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
 *   transition · run-interrupt · assign-specialist · run-specialist ·
 *   assign-reviewer · run-reviewer · remove-reviewer
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const detail = getTaskDetail(db, params.slug, params.key);
  if (!detail) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, {
      status: 404,
    });
  }
  const limit = clampTimelineLimit(
    new URL(request.url).searchParams.get("events"),
  );
  const slice = sliceTimeline(detail.timeline, limit);
  const rawDefault = getPref<string>(db, user.id, "tlDefault");
  const tlDefault: TimelineFilterId =
    rawDefault === "typed" || rawDefault === "comment" ? rawDefault : "all";

  // Runtime (Phase 8): the per-task run projection + kick the seed-resumer so
  // seeded "running" runs drip their live lines over SSE on first subscribe.
  resumeSeededRunningRuns(db, params.slug, params.key);
  const runtime = listRunsForTask(db, params.slug, params.key);
  const operatorRun = runtime.find((run) => run.op === true) ?? null;
  const operatorDispatch = getOperatorDispatchStatus(
    db,
    params.slug,
    params.key,
  );
  const operatorConfigured = resolveOperatorAuthority({}, params.slug).deployed;
  const operatorStatus = resolveOperatorExecutionStatus({
    runLifecycle: operatorRun?.lifecycle ?? null,
    dispatchState: operatorDispatch?.state ?? null,
    engaged: !!detail.operator,
    configured: operatorConfigured,
  });

  // Deployed specialists the "Assign specialist" menu offers; runActive
  // disables the Run button while a run for this task is already running.
  const deployedSpecialists = listDeployedSpecialists(db, params.slug);
  const runActive = hasRunningRun(db, params.slug, params.key);

  // @-mention autocomplete directory for the comment composer: deployed
  // specialists, registered users, and the reserved backend/role handles —
  // the same targets the server resolves an @mention to when a comment posts.
  const mentionables = getMentionables(db, params.slug, params.key);

  // Pending operator recommendations live in the task FILE (not the projection);
  // read them here so the task-detail renders them as actionable cards. The
  // loader revalidates on every SSE task change, so applied/dismissed ones drop.
  const taskFile = readTaskFile({
    projectSlug: params.slug,
    taskKey: params.key,
  });
  const recommendations = taskFile?.parsed.frontmatter.recommendations ?? [];
  const project = getProject(db, params.slug);
  const reviewStageId = project
    ? resolveStageRoles(project.stages, project.workflow).reviewId
    : null;
  const completionEvidence = (() => {
    if (!taskFile || !project) {
      return {
        repositoryReady: false,
        humanValidationCurrent: false,
        reviewerApprovalsCurrent: false,
        ready: false,
      };
    }
    const parsed = taskFile.parsed;
    const repositoryReady = repositoryReviewEvidenceReady(
      parsed,
      project.repo,
    );
    const humanValidationCurrent = hasCurrentHumanValidation(
      parsed,
      project.repo,
    );
    const reviewerApprovalsCurrent =
      parsed.frontmatter.reviewers.length > 0 &&
      missingReviewerApprovalProfileIds(parsed, project.repo).length === 0;
    return {
      repositoryReady,
      humanValidationCurrent,
      reviewerApprovalsCurrent,
      ready:
        repositoryReady &&
        (parsed.frontmatter.reviewers.length === 0
          ? humanValidationCurrent
          : reviewerApprovalsCurrent),
    };
  })();

  return {
    task: { ...detail, timeline: slice.events },
    recommendations,
    reviewStageId,
    completionEvidence,
    timelineTotal: slice.total,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
    operatorStatus,
    deployedSpecialists,
    runActive,
    mentionables,
    // Host for browse links, aligned with the supported github.com API/clone.
    githubHost: githubWebHost(),
  };
}

/** Optional `backend` form field → a run backend override (D4 retry). Ignores
 *  anything that isn't a real backend so a stray value can't break a run. */
function backendOverride(formData: FormData): {
  backendOverride?: "claude" | "codex";
} {
  const b = String(formData.get("backend") ?? "");
  return b === "claude" || b === "codex" ? { backendOverride: b } : {};
}

function assignmentBackend(formData: FormData): "claude" | "codex" {
  const backend = String(formData.get("backend") ?? "");
  if (backend === "claude" || backend === "codex") return backend;
  throw AppError.validation(
    "Choose a declared Claude Code or Codex backend for this assignment.",
  );
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = {
    userId: ctx.user.id,
    label: ctx.user.email,
    orgRole: ctx.user.role,
  };
  const intent = String(formData.get("intent") ?? "");
  const projectSlug = params.slug;
  const taskKey = params.key;

  try {
    assertProjectActive(db, projectSlug);
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
        const { option, completion } = await resolvePacket(
          db,
          { projectSlug, taskKey, optionIndex },
          actor,
        );
        const toast =
          option.kind === "accept_completion"
            ? completion?.mergePending
              ? `Completion accepted · ${taskKey} stays in Review until its PR is merged`
              : `Completion accepted · ${taskKey} moved to Done`
            : option.kind === "block_on_policy"
              ? "Task held on policy · opening repository settings"
              : option.kind === "hold_runtime_debug"
                ? "Held for runtime debug — the session is recorded per audit policy"
                : `Decision recorded: ${option.t}`;
        return {
          ok: true as const,
          intent,
          kind: option.kind,
          toast,
          // Mock flow: blocking on policy opens the repository settings.
          ...(option.kind === "block_on_policy"
            ? { navigateTo: `/projects/${projectSlug}/settings` }
            : {}),
        };
      }
      case "accept-completion": {
        // Packet-independent owner acceptance. transitionStage routes a human
        // terminal transition through the same acceptance contract used by
        // packets/recommendations, including healthy-review and PR checks.
        const project = getProject(db, projectSlug);
        const terminalStageId = project
          ? resolveStageRoles(project.stages, project.workflow).terminalId
          : null;
        if (!project || !terminalStageId) {
          throw AppError.validation(
            "This project has no terminal stage for completion.",
          );
        }
        const task = await transitionStage(
          db,
          { projectSlug, taskKey, toStageId: terminalStageId },
          actor,
        );
        const completed = task.stage === terminalStageId;
        const currentStageName =
          project.stages.find((stage) => stage.id === task.stage)?.name ??
          task.stage;
        return {
          ok: true as const,
          intent,
          toast: completed
            ? `Completion accepted · ${taskKey} moved to Done`
            : `Completion accepted · ${taskKey} stays in ${currentStageName} until its PR is merged`,
        };
      }
      case "record-human-validation": {
        await recordHumanValidation(
          db,
          { projectSlug, taskKey },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Validation recorded · ${taskKey} is ready for separate acceptance`,
        };
      }
      case "complete-merge": {
        // Run the REAL merge for a PR accepted "merge pending" (D3/S2).
        // Server re-checks task-owner/project/org authority and reports
        // honestly if the merge is still blocked.
        const result = await completeTaskMerge(
          db,
          { projectSlug, taskKey },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.merged
            ? result.message
            : `Not merged — ${result.message}`,
          // A blocked merge still returns ok:true (the action ran); flag it as an
          // error so useActionFeedback does not render a green success toast for
          // a merge that did not happen.
          ...(result.merged ? {} : { toastKind: "error" as const }),
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
        const requestedStage = String(formData.get("to") ?? "");
        const task = await transitionStage(
          db,
          {
            projectSlug,
            taskKey,
            toStageId: requestedStage,
            manual: true,
          },
          actor,
        );
        const proj = getProject(db, projectSlug);
        const toName =
          proj?.stages.find((s) => s.id === task.stage)?.name ?? task.stage;
        const requestedTerminal = proj?.stages.at(-1)?.id === requestedStage;
        return {
          ok: true as const,
          intent,
          stage: task.stage,
          toast:
            requestedTerminal && task.stage !== requestedStage
              ? `Completion accepted · ${taskKey} stays in ${toName} until its PR is merged`
              : `Moved ${taskKey} to ${toName}`,
        };
      }
      case "run-interrupt": {
        // Real governed action (runs spec §5.1): RBAC admin|maintainer,
        // writes interrupted state + audit event. Idempotent-safe.
        const result = await interruptRunAndWait(
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
              : result.outcome === "interrupting"
                ? "Interrupt requested — waiting for runtime acknowledgement"
                : "That run already finished — nothing to interrupt",
          ...(result.outcome === "interrupting"
            ? { toastKind: "info" as const }
            : {}),
        };
      }
      case "assign-specialist": {
        // Deploy a project specialist as the task's primary (contracts §3.2
        // "Open agent runtime sessions" — admin|maintainer, enforced server-side).
        const result = await assignSpecialist(
          db,
          {
            projectSlug,
            taskKey,
            profileId: String(formData.get("profileId") ?? ""),
            backend: assignmentBackend(formData),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: `Deployed ${result.name} as specialist`,
        };
      }
      case "run-specialist": {
        // Start a real run when configured, otherwise an explicitly simulated
        // demo run that cannot become governance or delivery evidence.
        // An optional `backend` forces the run onto the other engine — the
        // "retry on the other backend" affordance after an availability/quota
        // failure (D4).
        const result = await startSpecialistRun(
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
          {
            projectSlug,
            taskKey,
            profileId: String(formData.get("profileId") ?? ""),
            backend: assignmentBackend(formData),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.alreadyEngaged
            ? `${result.name} is already a reviewer`
            : `Engaged ${result.name} as a reviewer`,
        };
      }
      case "run-reviewer": {
        // Start a run for a specific engaged reviewer (optional `backend`
        // override for the retry-on-other-backend affordance — D4).
        const result = await startReviewerRun(
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
          {
            projectSlug,
            taskKey,
            profileId: String(formData.get("profileId") ?? ""),
          },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toast: result.removed
            ? "Reviewer released"
            : "That reviewer wasn't engaged",
        };
      }
      case "apply-recommendation": {
        // A human accepts an operator recommendation card — executes the
        // recommended assign/reviewer/transition through the governed mutation.
        const result = await applyRecommendation(
          db,
          { projectSlug, taskKey, recId: String(formData.get("recId") ?? "") },
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
          toast: result.label
            ? `Dismissed · ${result.label}`
            : "Recommendation dismissed",
        };
      }
      case "run-operator": {
        // Run the operator agent to coordinate the task. Triggering runtime
        // work is admin|maintainer (contracts §3.2) — the operator's OWN
        // capability policy governs what it may then do to the task. The
        // backend (claude|codex) and autonomy (supervised|full) are chosen for
        // this run; full autonomy lets the operator drive to Done.
        const role =
          listProjectMembers(db, projectSlug).find(
            (m) => m.userId === actor.userId,
          )?.role ?? null;
        // `run-agents` in the single ACTION_ROLES source (admin|maintainer) —
        // not a hardcoded tier (pass-4 XS-10).
        const authority = authorizeProjectAction(
          role,
          ctx.user.role,
          "run-agents",
        );
        if (!authority.allowed) {
          throw new AppError({
            code: ERROR_CODES.FORBIDDEN,
            status: 403,
            userMessage:
              "Running the operator requires the admin or maintainer role.",
            kind: "user",
          });
        }
        const backend =
          String(formData.get("backend") ?? "claude") === "codex"
            ? "codex"
            : "claude";
        const autonomy =
          String(formData.get("autonomy") ?? "supervised") === "full"
            ? "full"
            : "supervised";
        const result = await runOperator(db, {
          projectSlug,
          taskKey,
          backend,
          autonomy,
          // Attribute the run to the human who pressed the button (D8) — the
          // operator's own actions are still audited as the operator, but the
          // "started a run" audit row names the maintainer who launched it.
          actor: withProjectAuditAuthority(actor, authority.source),
        });
        return {
          ok: true as const,
          intent,
          toast:
            `Operator ${result.disposition === "started" ? "running" : "queued"} · ${result.backend === "claude" ? "Claude Code" : "Codex"} · ${result.autonomy} autonomy` +
            (result.mode === "scripted" ? " (scripted)" : ""),
        };
      }
      default:
        return data(
          { ok: false as const, error: "Unknown action." },
          { status: 400 },
        );
    }
  } catch (error) {
    if (isAppError(error)) {
      return data(
        { ok: false as const, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
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

export default function TaskDetailRoute({ loaderData }: Route.ComponentProps) {
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
      runtime={loaderData.runtime}
      operatorStatus={loaderData.operatorStatus}
      deployedSpecialists={loaderData.deployedSpecialists}
      runActive={loaderData.runActive}
      timelineHasMore={loaderData.timelineHasMore}
      timelineRemaining={loaderData.timelineRemaining}
      timelineNextLimit={loaderData.timelineNextLimit}
      tlDefault={loaderData.tlDefault}
      members={members}
      me={{ id: layout.user.id, name: layout.user.name }}
      myRole={layout.myRole}
      projectRole={layout.projectRole}
      mentionables={loaderData.mentionables}
      recommendations={loaderData.recommendations}
      reviewStageId={loaderData.reviewStageId}
      completionEvidence={loaderData.completionEvidence}
      githubHost={loaderData.githubHost}
      readOnly={layout.board.project.archived}
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
