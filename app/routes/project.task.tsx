import {
  data,
  isRouteErrorResponse,
  Link,
  useParams,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/project.task";
import type { loader as projectLoader } from "./project";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getTaskSummary } from "~/server/projections/task-query.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill, ReadinessPill, ValidationPill } from "~/ui/pill";

/**
 * /projects/:slug/tasks/:key — Phase-4 PLACEHOLDER: a minimal current-state
 * panel (title, stage/readiness/waiting pills, goal, owner, agents, real
 * store path). Phase 5 replaces this module with the full task workspace
 * port of task.jsx. The loader contract Phase 5 inherits: `{ task }` =
 * getTaskSummary shape; the layout's crumbs read `task.key`/`task.title`
 * from this route's data (match id "routes/project.task").
 *
 * Unknown keys 404 into the in-shell ErrorBoundary below (the mock crashed;
 * cross-project notification rows to the stub projects land here too).
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  requireUser(request);
  const db = getDb();
  const task = getTaskSummary(db, params.slug, params.key);
  if (!task) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, {
      status: 404,
    });
  }
  return { task };
}

export function meta({ data, params }: Route.MetaArgs) {
  return [
    { title: data ? `${data.task.key} · ${data.task.title}` : params.key },
  ];
}

function WaitLine({ waiting }: { waiting: string }) {
  if (waiting === "agent") {
    return (
      <span className="wait-tag agent">
        <span className="working" />
        agent working
      </span>
    );
  }
  if (waiting === "human") {
    return (
      <span className="wait-tag human">
        <Icon name="hand" />
        waiting on you
      </span>
    );
  }
  return null;
}

export default function TaskPreview({ loaderData }: Route.ComponentProps) {
  const { task } = loaderData;
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  const stage = layout?.board.project.stages.find((s) => s.id === task.stage);

  return (
    <div className="task-preview" data-screen-label="Task detail — preview">
      <section className="panel">
        <div className="panel-head">
          <h2>
            <span className="mono">{task.key}</span> · {task.title}
          </h2>
        </div>
        <div className="tp-pills">
          <Pill kind="neutral" sm>
            <span
              className="sdot"
              style={stage ? { background: stage.color } : undefined}
            />
            {stage?.name ?? task.stage}
          </Pill>
          <ReadinessPill value={task.displayReadiness} sm />
          <ValidationPill value={task.validation} sm />
          {task.urgent && (
            <Pill kind="risk" sm>
              urgent
            </Pill>
          )}
          <WaitLine waiting={task.waiting} />
        </div>

        <div className="tp-section">
          <div className="tp-label">Goal</div>
          <p className="tp-goal">{task.goal}</p>
        </div>

        <div className="tp-section">
          <div className="tp-label">People &amp; agents</div>
          <div className="tp-chips">
            {task.owner && task.owner.kind === "human" ? (
              <span className="who-chip">
                <Avatar person={task.owner} />
                <span>
                  <span className="nm">{task.owner.name}</span>
                  <div className="sub">owner · review &amp; acceptance</div>
                </span>
              </span>
            ) : (
              <span className="who-chip">
                <span className="avatar" style={{ opacity: 0.5 }}>
                  ?
                </span>
                <span>
                  <span className="nm">No owner</span>
                  <div className="sub">
                    {task.operator ? "awaiting owner" : "unassigned"}
                  </div>
                </span>
              </span>
            )}
            {task.specialist && (
              <span className="who-chip">
                <AgentGlyph backend={task.specialist.backend} />
                <span>
                  <span className="nm">
                    {task.specialist.name} · {task.specialist.role}
                  </span>
                  <div className="sub">primary specialist</div>
                </span>
              </span>
            )}
            {task.operator && (
              <span className="who-chip">
                <AgentGlyph op />
                <span>
                  <span className="nm">Operator</span>
                  <div className="sub">since {task.operator.sinceLabel}</div>
                </span>
              </span>
            )}
          </div>
        </div>

        {task.packet && (
          <div className="tp-section">
            <div className="tp-label">Decision packet</div>
            <p className="tp-goal">
              <Pill kind={task.packet.type === "blocked" ? "blocked" : "input"} sm>
                {task.packet.kind}
              </Pill>{" "}
              {task.packet.title}
            </p>
          </div>
        )}

        <div className="tp-foot">
          <span className="mono tp-path">{task.filePath}</span>
          <span className="tp-note">
            The full task workspace arrives in phase 5.
          </span>
        </div>
      </section>
    </div>
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
