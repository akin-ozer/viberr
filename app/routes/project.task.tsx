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
  applyRecommendation,
  commentToAgent,
  completeTaskMerge,
  dismissRecommendation,
  forceAcceptCompletion,
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
  listDeployedSpecialists,
  removeReviewer,
  startAgentRun,
} from "~/server/tasks/specialist-run.server";
import { getMentionables } from "~/server/tasks/mention-suggestions.server";
import { githubWebHost } from "~/server/github/github-client.server";
import { interruptRun, listRunsForTask } from "~/server/runtimes/run-service.server";
import { runOperator } from "~/server/runtimes/operator-run.server";
import {
  isBackendAvailable,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import {
  operatorBackendFor,
  type OperatorAutonomy,
} from "~/server/tasks/operator-actions.server";
import { getProject, listProjectMembers } from "~/server/projections/board-query.server";
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
  const runtime = runsVisible
    ? listRunsForTask(db, params.slug, params.key)
    : listRunsForTask(db, params.slug, params.key).map((r) => ({
        ...r,
        sid: null,
        exportable: false,
        lines: [],
        raw: [],
        lineCount: 0,
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
  // Pending scheduled operator re-runs (O-3), rendered as cancellable cards.
  const schedules = (taskFile?.parsed.frontmatter.schedules ?? []).filter(
    (s) => s.status === "pending",
  );

  return {
    task: { ...detail, timeline: slice.events },
    recommendations,
    schedules,
    timelineTotal: slice.total,
    timelineHasMore: slice.hasMore,
    timelineRemaining: slice.remaining,
    timelineNextLimit: slice.nextLimit,
    tlDefault,
    runtime,
    deployedSpecialists,
    // P11-76: the operator's configured backend so the run picker defaults to it.
    operatorBackend: operatorBackendFor({}, params.slug),
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
    githubReconciledAt:
      (
        db
          .prepare(
            `SELECT MAX(observed_at) AS latest FROM provenance
              WHERE action = 'github.reconcile' AND source_path = ?`,
          )
          .get(`projects/${params.slug}/tasks/${params.key}/task.md`) as
          | { latest: string | null }
          | undefined
      )?.latest ?? null,
    // Host for GitHub browse links (PR/branch/repo), derived server-side.
    // UI-11: today this always resolves to `https://github.com` — nothing
    // stores a GHE API base URL — so the value is honest, but the "GHE
    // deployments keep working" claim that used to sit here was not.
    githubHost: githubWebHost(),
  };
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
        const { option } = await resolvePacket(
          db,
          { projectSlug, taskKey, optionIndex, ...(note.trim() ? { note } : {}) },
          actor,
        );
        const retryStarted =
          option.kind === "retry_other_backend" &&
          listRunsForTask(db, projectSlug, taskKey).some(
            (r) => !runIdsBefore.has(r.serverRunId),
          );
        const toast =
          option.kind === "accept_completion"
            ? `Completion accepted · ${taskKey} moved to Done`
            : option.kind === "block_on_policy"
              ? "Task held on policy · opening repository settings"
              : option.kind === "hold_runtime_debug"
                ? "Held for runtime debug — the session is recorded per audit policy"
                : option.kind === "retry_other_backend"
                  ? retryStarted
                    ? `Retrying on ${option.backend === "codex" ? "Codex" : "Claude Code"} · streaming to agent logs`
                    : "Decision recorded, but the retry could NOT start — the reason is on the timeline"
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
      case "force-accept": {
        // Admin-only override of the review gate (DG-2): accept a task wedged on
        // an un-recordable required reviewer or a stale blocked packet. Audited.
        await forceAcceptCompletion(db, { projectSlug, taskKey }, actor);
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
        const started = await runOperator(db, {
          projectSlug,
          taskKey,
          ...(backend ? { backend } : {}),
          ...(autonomy ? { autonomy } : {}),
          // Attribute the run to the human who pressed the button (D8) — the
          // operator's own actions are still audited as the operator, but the
          // "started a run" audit row names the maintainer who launched it.
          actor: { userId: actor.userId, label: actor.label },
        });
        return {
          ok: true as const,
          intent,
          toast: `Operator running · ${started.backend === "claude" ? "Claude Code" : "Codex"} · ${started.autonomy} autonomy`,
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
      operatorBackend={loaderData.operatorBackend}
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
      githubHost={loaderData.githubHost}
      githubReconciledAt={loaderData.githubReconciledAt}
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
