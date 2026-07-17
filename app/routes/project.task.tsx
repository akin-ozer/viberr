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
  releaseOwner,
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
import { interruptRun, listRunsForTask } from "~/server/runtimes/run-service.server";
import { runOperator } from "~/server/runtimes/operator-run.server";
import { getProject, listProjectMembers } from "~/server/projections/board-query.server";
import { requireProjectAuthority } from "~/server/auth/project-authority.server";
import { TaskDetailPage } from "~/features/task-detail/task-detail-page";
import type { TaskMemberView } from "~/features/task-detail/execution-profile";
import type { TimelineFilterId } from "~/features/task-detail/timeline";
import {
  clampTimelineLimit,
  sliceTimeline,
} from "~/features/task-detail/timeline-slice";
import { Icon } from "~/ui/icon";
import { rolesForAction } from "~/shared/rbac";

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

  // Runtime (Phase 8): the per-task run projection (the seed-resumer wiring
  // was removed with the simulated-run seed data — R7-2 / F7-VEST1).
  const runtime = listRunsForTask(db, params.slug, params.key);

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
  const taskFile = readTaskFile({ projectSlug: params.slug, taskKey: params.key });
  const recommendations = taskFile?.parsed.frontmatter.recommendations ?? [];

  return {
    task: { ...detail, timeline: slice.events },
    recommendations,
    timelineTotal: slice.total,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
    deployedSpecialists,
    runActive,
    mentionables,
    // Host for GitHub browse links (PR/branch/repo) — derived server-side so
    // the client never hardcodes github.com (GHE deployments keep working).
    githubHost: githubWebHost(),
  };
}

/** Optional `backend` form field → a run backend override (D4 retry). Ignores
 *  anything that isn't a real backend so a stray value can't break a run. */
function backendOverride(formData: FormData): { backendOverride?: "claude" | "codex" } {
  const b = String(formData.get("backend") ?? "");
  return b === "claude" || b === "codex" ? { backendOverride: b } : {};
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");
  const projectSlug = params.slug;
  const taskKey = params.key;

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
        const { option } = await resolvePacket(
          db,
          { projectSlug, taskKey, optionIndex },
          actor,
        );
        const toast =
          option.kind === "accept_completion"
            ? `Completion accepted · ${taskKey} moved to Done`
            : option.kind === "block_on_policy"
              ? "Task held on policy · opening repository settings"
              : option.kind === "hold_runtime_debug"
                ? "Held for runtime debug — the session is recorded per audit policy"
                : option.kind === "retry_other_backend"
                  ? `Retrying on ${option.backend === "codex" ? "Codex" : "Claude Code"} · streaming to agent logs`
                  : option.kind === "edit_goal"
                    ? "Decision recorded — type the new goal; the packet clears when it lands"
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
        const task = await transitionStage(
          db,
          {
            projectSlug,
            taskKey,
            toStageId: String(formData.get("to") ?? ""),
            manual: true,
          },
          actor,
        );
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
        // Start a real (or simulated-fallback) run for the assigned specialist.
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
          { projectSlug, taskKey, profileId: String(formData.get("profileId") ?? "") },
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
        requireProjectAuthority(
          db,
          {
            slug: projectSlug,
            memberRoles: new Map(
              listProjectMembers(db, projectSlug).map((m) => [m.userId, m.role]),
            ),
          },
          actor,
          rolesForAction("run-agents"),
          { action: "run-agents", what: "run the operator" },
        );
        const backend =
          String(formData.get("backend") ?? "claude") === "codex" ? "codex" : "claude";
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
          actor: { userId: actor.userId, label: actor.label },
        });
        return {
          ok: true as const,
          intent,
          toast:
            `Operator running · ${backend === "claude" ? "Claude Code" : "Codex"} · ${autonomy} autonomy` +
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
      deployedSpecialists={loaderData.deployedSpecialists}
      runActive={loaderData.runActive}
      timelineHasMore={loaderData.timelineHasMore}
      timelineRemaining={loaderData.timelineRemaining}
      timelineNextLimit={loaderData.timelineNextLimit}
      tlDefault={loaderData.tlDefault}
      members={members}
      me={{ id: layout.user.id, name: layout.user.name }}
      myRole={layout.myRole}
      mentionables={loaderData.mentionables}
      recommendations={loaderData.recommendations}
      githubHost={loaderData.githubHost}
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
