import { data, redirect, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.settings";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import {
  runClearCredential,
  runGrantScope,
  runSetCredential,
} from "~/features/github/github-actions.server";
import {
  addStage,
  deleteProject,
  setProjectArchived,
  inviteMember,
  removeMember,
  removeStage,
  renameStage,
  reorderStages,
  setRepoOverride,
  updateProjectIdentity,
} from "~/features/project-settings/settings-actions.server";
import { getSettingsViewData } from "~/features/project-settings/settings-query.server";
import { SettingsPage } from "~/features/project-settings/settings-page";

/**
 * /projects/:slug/settings — the project-admin surface (project-settings
 * spec), replacing the phase-4 placeholder. Loader: identity + stages +
 * per-stage counts + membership (with invite status) + credential health
 * (ruling-5 single fact) + the repo-override flag. Actions (POST + CSRF):
 * identity save, stage editor mutations, membership CRUD, override toggle,
 * grant-scope (phase-7 revalidateProjectCredential — resolves the seeded
 * VIB-142 violation and drops the rail badge), and the danger-zone delete.
 * Toast copy is computed server-side (phase-5 pattern); mutations write
 * project.md → reproject → audit, and the shell's project-scope SSE
 * subscription revalidates open Boards (columns follow stage edits live).
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireProjectMember(request, params.slug, "view this project's settings");
  const db = getDb();
  const view = getSettingsViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return { view };
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");
  const field = (name: string) => String(formData.get(name) ?? "");
  const slug = params.slug;

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
        const result = await addStage(db, { projectSlug: slug }, actor);
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
      case "override": {
        const result = await setRepoOverride(
          db,
          { projectSlug: slug, enabled: field("enabled") === "true" },
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
          ? runSetCredential(db, slug, actor)
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
    if (isAppError(error)) {
      return data(
        { ok: false as const, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
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
