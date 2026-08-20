import { data, redirect, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.settings";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { requireVisibleProject } from "./project-visibility.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  runClearCredential,
  runGrantScope,
  runSetCredential,
} from "~/features/github/github-actions.server";
import {
  credentialGrantHolder,
  withoutCredentialDetail,
} from "~/features/github/credential-visibility.server";
import {
  addStage,
  deleteProject,
  setProjectArchived,
  inviteMember,
  removeMember,
  removeStage,
  renameStage,
  reorderStages,
  repairProjectRepo,
  setBranchCleanup,
  updateProjectIdentity,
} from "~/features/project-settings/settings-actions.server";
import { getSettingsViewData } from "~/features/project-settings/settings-query.server";
import { SettingsPage } from "~/features/project-settings/settings-page";

/**
 * /projects/:slug/settings — the project-admin surface (project-settings
 * spec), replacing the phase-4 placeholder. Loader: identity + stages +
 * per-stage counts + membership (with invite status) + credential health
 * (ruling-5 single fact). Actions (POST + CSRF):
 * identity save, stage editor mutations, membership CRUD,
 * grant-scope (phase-7 revalidateProjectCredential — resolves the seeded
 * VIB-142 violation and drops the rail badge), and the danger-zone delete.
 * Toast copy is computed server-side (phase-5 pattern); mutations write
 * project.md → reproject → audit, and the shell's project-scope SSE
 * subscription revalidates open Boards (columns follow stage edits live).
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/settings.data?_routes=routes/project.settings` runs
  // this loader ALONE and the layout's membership refusal never executes. The
  // guard answers a non-member with the byte-identical unknown-slug 404 — a 403
  // here would confirm the project exists (WI-13).
  const { user } = await requireProjectMember(
    request,
    params.slug,
    "view this project's settings",
  );
  const db = getDb();
  const view = getSettingsViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // R19-11 / F21-5: the same credential redaction /github has applied since
  // pass 19 — this page renders the SAME `CredentialCard` from the SAME
  // `getProjectCredentialHealth` fact, and shipped a project Viewer the token's
  // label, masked tail and per-scope verdicts. The rule is shared rather than
  // repeated (features/github/credential-visibility.server), so the two routes
  // cannot answer differently; the render gate in `SettingsPage` asks
  // `roleCan(myRole, "grant-github-scope")`, which is this same ACTION_ROLES
  // entry, and the credential mutations below enforce it server-side.
  return {
    view: credentialGrantHolder(db, params.slug, user.id)
      ? view
      : { ...view, credential: withoutCredentialDetail(view.credential) },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { db, formData, actor, intent } = await requireFormAction(request);
  const field = (name: string) => String(formData.get(name) ?? "");
  const slug = params.slug;

  // E2 (pass 16): the layout loader does not run for an action, so the
  // members-only gate is repeated here — otherwise a signed-in non-member got a
  // 403 that confirms the project exists while every other surface answered 404.
  requireVisibleProject(db, slug, actor, "act on this project");

  try {
    switch (intent) {
      case "save-project": {
        const result = await updateProjectIdentity(
          db,
          {
            projectSlug: slug,
            name: field("name"),
            prefix: field("prefix"),
            description: field("description"),
          },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "rename-stage": {
        const result = await renameStage(
          db,
          { projectSlug: slug, stageId: field("stageId"), name: field("name") },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "add-stage": {
        const result = await addStage(
          db,
          { projectSlug: slug, name: field("name") },
          actor,
        );
        return {
          ok: true as const,
          toast: result.toast,
          stageId: result.stageId,
        };
      }
      case "remove-stage": {
        const result = await removeStage(
          db,
          { projectSlug: slug, stageId: field("stageId") },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "reorder-stages": {
        const result = await reorderStages(
          db,
          {
            projectSlug: slug,
            orderedIds: field("orderedIds").split(",").filter(Boolean),
          },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "invite": {
        const result = await inviteMember(
          db,
          { projectSlug: slug, name: field("name"), email: field("email") },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "remove-member": {
        const result = await removeMember(
          db,
          { projectSlug: slug, targetUserId: field("userId") },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      // P13-D-5: the "override" intent (task-level repo override) is gone. It
      // persisted a flag and audited a change that no enforcement path ever
      // consulted, next to copy on three surfaces promising a capability
      // nothing could write. One project, one repository.
      //
      // Owner ruling 2026-07-26: …and one explicit REPAIR path for the repo
      // misconfigured at creation. The human types the corrected owner/name;
      // the server probes it with the bound credential and refuses misses.
      case "repair-repo": {
        const result = await repairProjectRepo(
          db,
          {
            projectSlug: slug,
            repo: field("repo"),
            confirmFootprint: field("confirmFootprint") === "1",
          },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      // R15-6: post-merge branch cleanup, per project (default on).
      case "set-branch-cleanup": {
        const result = await setBranchCleanup(
          db,
          { projectSlug: slug, enabled: field("enabled") === "1" },
          actor,
        );
        return { ok: true as const, toast: result.toast };
      }
      case "grant-scope": {
        // The single guard path consulting the ACTION_ROLES source:
        // `grant-github-scope` (maintainer+), same as the GitHub view's action
        // (pass-4 XS-10); org admins pass as the audited D2 override. The archived
        // read-only gate IS enforced (R8-5): no credential hygiene on a frozen
        // project — restore it first.
        assertProjectAction(db, "grant-github-scope", slug, actor, "re-check the credential");
        return await runGrantScope(db, slug, actor);
      }
      case "set-credential":
      case "clear-credential": {
        // Attach/rotate + remove the credential — `grant-github-scope` tier.
        // Archived read-only gate enforced (R8-5).
        assertProjectAction(db, "grant-github-scope", slug, actor, "change the credential");
        return intent === "set-credential"
          ? await runSetCredential(db, slug, actor)
          : runClearCredential(db, slug, actor);
      }
      case "archive-project": {
        const result = await setProjectArchived(
          db,
          { projectSlug: slug, archived: field("archived") !== "false" },
          actor,
        );
        return { ok: true as const, toast: result.toast, archived: result.archived };
      }
      case "delete-project": {
        await deleteProject(
          db,
          { projectSlug: slug, confirmName: field("confirmName") },
          actor,
        );
        return redirect("/");
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

export default function SettingsView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <SettingsPage
      data={loaderData.view}
      meId={layout?.user.id ?? null}
      myRole={layout?.myRole ?? null}
    />
  );
}
