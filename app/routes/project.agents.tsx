import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.agents";
import { pageTitle } from "~/shared/page-title";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { requireVisibleProject } from "./project-visibility.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  getProject,
  listProjectMembers,
} from "~/server/projections/board-query.server";
import { listAgentDeployments } from "~/server/projections/agent-deployments.server";
import { buildResourceCatalog } from "~/server/org/resource-catalog.server";
import {
  connectedUserIds,
  isBackendAvailableFor,
} from "~/server/runtimes/backend-credentials.server";
import {
  createAgentProfile,
  deleteAgentProfile,
  deployAgentProfileFromLibrary,
  updateAgentProfile,
  type ProfileSaveResult,
} from "~/features/agents/agent-profile-actions.server";
import {
  assembleAgentRoster,
  listLibraryProfiles,
} from "~/features/agents/agents-query.server";
import { propagateTemplateResources } from "~/server/org/template-propagation.server";
import {
  assertProjectAction,
  isOrgAdmin,
} from "~/server/auth/project-authority.server";
import { AppError } from "~/server/errors/app-error.server";
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

/** D32-3: "<Page> · <project> · Viberr" — this view used to inherit the bare
 *  project title from the workspace layout. */
export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Agents", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/agents.data?_routes=routes/project.agents` runs this
  // loader ALONE and the layout's membership refusal never executes. The guard
  // answers a non-member with the byte-identical unknown-slug 404 — a 403 here
  // would confirm the project exists (WI-13).
  const { user } = await requireProjectMember(
    request,
    params.slug,
    "view this project's agents",
  );
  const db = getDb();
  const project = getProject(db, params.slug);
  if (!project) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // Ruling 127: "is this backend configured?" has no instance-level answer any
  // more — a run bills a PERSON. So the page gets two person-shaped facts per
  // backend, from the one store every surface reads
  // (`backend-credentials.server`): whether the VIEWER connected it (they are
  // who would press Run, on the tasks they own), and how many of this
  // project's members have — the honest replacement for the old boolean.
  const memberIds = new Set(
    listProjectMembers(db, params.slug).map((m) => m.userId),
  );
  const summary = (backend: "claude" | "codex") => {
    const connected = connectedUserIds(db, backend);
    return {
      backend,
      viewerConnected: isBackendAvailableFor(db, user.id, backend),
      membersConnected: connected.filter((id) => memberIds.has(id)).length,
      membersTotal: memberIds.size,
    };
  };
  const backendHealth = { claude: summary("claude"), codex: summary("codex") };
  return {
    profiles: assembleAgentRoster(db, params.slug),
    // The org-level template LIBRARY, minus what this project already runs
    // (owner ruling 1 / AP-05): the "Add from library" picker's options. Before
    // this, an org-created profile could never reach a project at all.
    library: listLibraryProfiles(db, params.slug),
    deployments: listAgentDeployments(db, params.slug),
    stages: project.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    })),
    // R14-1: eligibility resolves declared stage ids against this board by id
    // AND by structural role (`resolveDeclaredStages`), which needs the workflow
    // graph, not just the stage list. Both the roster's eligible-stage panel and
    // the library picker's stage count read it, so the page can never promise a
    // stage the run guard would refuse (P14-UI-63).
    workflow: project.workflow.map((w) => ({ from: w.from, to: w.to })),
    projectName: project.name,
    // Live store resources for the profile-editor picker (item-2): a skill/MCP/
    // KB created in org settings is grantable to an agent, replacing the
    // hardcoded mock catalog whose items resolved to nothing.
    //
    // The catalog is the registry only: `buildResourceCatalog` skips the
    // reserved `viberr` name for BOTH profile kinds (P14-KM-14), because the
    // in-process governance server is mounted by `buildOperatorToolkit`
    // unconditionally — a toggle for it would be one an admin could flip with no
    // effect. No profile grants it either, as of B7 (pass 16).
    resourceCatalog: buildResourceCatalog(db),
    // Ruling 239: the project's rulings KB is granted by nobody and reaches
    // every profile on this page. Without it here the page would show a
    // profile's `kb` list and be WRONG about what that profile reads — which
    // is the same mistake the capability matrix made about repo-write in
    // pass 27, and the reason that matrix exists.
    // Read from the project FILE rather than the projection: this is one
    // display field, and a projection column for it would mean a baseline
    // change and a rebuild for something the file answers directly.
    rulingsKb: projectRulingsKb(params.slug),
    // Ruling 127: ONE backend answer for this page. The roster line reads the
    // count, and the create/edit modal reads `viewerConnected` for its advisory
    // note. It is deliberately not a second `backendAvailable` pair: authoring a
    // profile is not running one (a run bills the TASK OWNER), so nothing on
    // this page gates the form on the author's own credential.
    backendHealth,
    // Ruling 156 (owner, Q35-8): only an org admin may copy a template's
    // grants onto this project's copy; the page renders the button for them
    // and the divergence marker for everyone.
    viewerIsOrgAdmin: user.role === "admin",
  };
}

/** Any value `JSON.parse` can hand back. The profile form is validated against
 *  the server's own schema INSIDE each mutation — after its RBAC gate — so this
 *  route only decodes the transport, it does not judge the content. */
type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

/** The success reply every profile mutation here answers with. Both notices are
 *  OMITTED unless the save actually produced one — the agents page keys its
 *  extra toasts on the key being there, not on its value. */
interface ProfileMutationSuccess {
  ok: true;
  toast: string;
  profileId: string;
  /** B-AG1: a coupling decision the save had to make (delivery headline, or
   *  web egress under the browser) is NOT a detail for the audit log alone. A
   *  `withheld` notice means the profile was saved exactly as asked and
   *  therefore cannot deliver — the admin sees each decision next to the
   *  success toast instead of discovering it when a run silently refuses. */
  notices?: ProfileSaveResult["notices"];
  /** F20-20: an operator autonomy elevation / direct-accept grant rides its own
   *  governance notice so the toast names what the admin just enabled. */
  governanceNotice?: ProfileSaveResult["governanceNotice"];
}

export async function action({ request, params }: Route.ActionArgs) {
  const { db, formData, actor, intent } = await requireFormAction(request);

  // E2 (pass 16): the layout loader does not run for an action, so the
  // members-only gate is repeated here. Without it a signed-in non-member got
  // the inner guard's 403 — a reply that confirms the project exists — while
  // every other surface answered 404. Same placement as project.board.tsx.
  requireVisibleProject(db, params.slug, actor, "act on this project");

  const parsePayload = (): JsonPayload => {
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
      const created: ProfileMutationSuccess = {
        ok: true,
        toast: `Profile "${result.name}" created · available for future assignments`,
        profileId: result.profileId,
      };
      if (result.notices) created.notices = result.notices;
      return created;
    }
    if (intent === "deploy-profile") {
      const result = await deployAgentProfileFromLibrary(
        db,
        {
          projectSlug: params.slug,
          profileId: String(formData.get("profileId") ?? ""),
        },
        actor,
      );
      const deployed: ProfileMutationSuccess = {
        ok: true,
        toast: `"${result.name}" added from the global library · the operator can assign it now`,
        profileId: result.profileId,
      };
      if (result.notices) deployed.notices = result.notices;
      return deployed;
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
      const updated: ProfileMutationSuccess = {
        ok: true,
        // D32-12 (pass 32, live VIB-2): a run RESUMED after the save mounts the new
        // grants at once, so "future assignments" under-promised; the truthful
        // boundary is the next run (fresh or resumed).
        toast: `Profile "${result.name}" updated · changes apply from the next run`,
        profileId: result.profileId,
      };
      if (result.notices) updated.notices = result.notices;
      if (result.governanceNotice)
        updated.governanceNotice = result.governanceNotice;
      return updated;
    }
    if (intent === "sync-profile-resources") {
      // Ruling 156 (owner, Q35-8): the project's own `manage-agents` gate
      // first (audited like every other profile write), then the org role: a
      // project admin who is not an org admin sees the marker and asks.
      assertProjectAction(
        db,
        "manage-agents",
        params.slug,
        actor,
        "change agent capability policy",
      );
      if (!isOrgAdmin(db, actor.userId)) {
        throw AppError.forbidden(
          "Only an org admin can copy the template's grants onto this project. A project admin sees the difference on the profile and asks.",
        );
      }
      const profileId = String(formData.get("profileId") ?? "");
      const fingerprint = String(formData.get("fingerprint") ?? "");
      const propagateInput: Parameters<typeof propagateTemplateResources>[1] = {
        profileId,
        projectSlugs: [params.slug],
      };
      if (fingerprint) propagateInput.expectFingerprint = fingerprint;
      const copies = await propagateTemplateResources(db, propagateInput, actor);
      const name = copies[0]?.name ?? profileId;
      const synced: ProfileMutationSuccess = {
        ok: true,
        toast: `"${name}" now carries the template's grants · changes apply from the next run`,
        profileId,
      };
      return synced;
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
        toast: `Profile "${result.name}" deleted. Its engagements can't deliver or comment until a replacement is assigned`,
        profileId: "operator",
      };
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function AgentsView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <AgentsPage
      profiles={loaderData.profiles}
      library={loaderData.library}
      deployments={loaderData.deployments}
      stages={loaderData.stages}
      workflow={loaderData.workflow}
      projectSlug={layout?.board.project.slug ?? ""}
      projectName={loaderData.projectName}
      myRole={layout?.myRole ?? null}
      viewerIsOrgAdmin={loaderData.viewerIsOrgAdmin}
      resourceCatalog={loaderData.resourceCatalog}
      backendHealth={loaderData.backendHealth}
      rulingsKb={loaderData.rulingsKb}
    />
  );
}
