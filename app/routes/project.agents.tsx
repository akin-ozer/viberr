import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.agents";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { getProject } from "~/server/projections/board-query.server";
import { listAgentDeployments } from "~/server/projections/agent-deployments.server";
import {
  createAgentProfile,
  deleteAgentProfile,
  updateAgentProfile,
} from "~/features/agents/agent-profile-actions.server";
import { assembleAgentRoster } from "~/features/agents/agents-query.server";
import { AgentsPage } from "~/features/agents/agents-page";

/**
 * /projects/:slug/agents — the agent-governance surface (agents spec),
 * replacing the phase-4 placeholder. Loader: assembled profile roster
 * (org templates ⊕ project.md deployments) + the live-deployment
 * projection (task assignments joined with agent_runs by profile id) +
 * project stages. Actions (POST + CSRF): create/update/delete-profile via
 * the phase-3 project.md writers; toast copy computed server-side
 * (phase-5 pattern). SSE: the workspace shell's project-scope subscription
 * revalidates this loader on project.updated / task.updated /
 * run.state-changed — roster and Live tab stay live with no wiring here.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  requireUser(request);
  const db = getDb();
  const project = getProject(db, params.slug);
  if (!project) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return {
    profiles: assembleAgentRoster(db, params.slug),
    deployments: listAgentDeployments(db, params.slug),
    stages: project.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    })),
    projectName: project.name,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");

  const parsePayload = (): unknown => {
    try {
      return JSON.parse(String(formData.get("payload") ?? "{}"));
    } catch {
      return {};
    }
  };

  try {
    if (intent === "create-profile") {
      const result = await createAgentProfile(
        db,
        { projectSlug: params.slug, form: parsePayload() },
        actor,
      );
      return {
        ok: true as const,
        toast: `Profile "${result.name}" created — available for future assignments`,
        profileId: result.profileId,
      };
    }
    if (intent === "update-profile") {
      const result = await updateAgentProfile(
        db,
        {
          projectSlug: params.slug,
          profileId: String(formData.get("profileId") ?? ""),
          form: parsePayload(),
        },
        actor,
      );
      return {
        ok: true as const,
        toast: `Profile "${result.name}" updated — changes apply to future assignments`,
        profileId: result.profileId,
      };
    }
    if (intent === "delete-profile") {
      const result = await deleteAgentProfile(
        db,
        {
          projectSlug: params.slug,
          profileId: String(formData.get("profileId") ?? ""),
        },
        actor,
      );
      return {
        ok: true as const,
        toast: `Profile "${result.name}" deleted — running threads continue until reassigned`,
        profileId: "operator",
      };
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
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

export default function AgentsView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <AgentsPage
      profiles={loaderData.profiles}
      deployments={loaderData.deployments}
      stages={loaderData.stages}
      projectSlug={layout?.board.project.slug ?? ""}
      projectName={loaderData.projectName}
      myRole={layout?.myRole ?? null}
    />
  );
}
