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
  appendComment,
  releaseOwner,
  resolvePacket,
  setOwner,
  transitionStage,
} from "~/server/tasks/task-actions.server";
import { interruptRun, listRunsForTask } from "~/server/runtimes/run-service.server";
import { resumeSeededRunningRuns } from "~/server/runtimes/seed-resumer.server";
import { TaskDetailPage } from "~/features/task-detail/task-detail-page";
import type { TaskMemberView } from "~/features/task-detail/execution-profile";
import type { TimelineFilterId } from "~/features/task-detail/timeline";
import {
  clampTimelineLimit,
  sliceTimeline,
} from "~/features/task-detail/timeline-slice";
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
 *   transition
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = requireUser(request);
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

  return {
    task: { ...detail, timeline: slice.events },
    timelineTotal: slice.total,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = requireAuth(request);
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
        const result = await appendComment(
          db,
          { projectSlug, taskKey, text: String(formData.get("text") ?? "") },
          actor,
        );
        return {
          ok: true as const,
          intent,
          toAgent: result.toAgent,
          toast: result.toAgent
            ? "Comment posted · routed to mentioned agent"
            : "Comment posted",
        };
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
        // No mock affordance renders this on task detail yet (packets carry
        // the governed decisions); the intent exists so future surfaces and
        // automations hit the same server-enforced boundary rules.
        const task = await transitionStage(
          db,
          { projectSlug, taskKey, toStageId: String(formData.get("to") ?? "") },
          actor,
        );
        return { ok: true as const, intent, stage: task.stage };
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

export function meta({ data, params }: Route.MetaArgs) {
  return [
    { title: data ? `${data.task.key} · ${data.task.title}` : params.key },
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
      timelineHasMore={loaderData.timelineHasMore}
      timelineRemaining={loaderData.timelineRemaining}
      timelineNextLimit={loaderData.timelineNextLimit}
      tlDefault={loaderData.tlDefault}
      members={members}
      me={{ id: layout.user.id, name: layout.user.name }}
      myRole={layout.myRole}
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
