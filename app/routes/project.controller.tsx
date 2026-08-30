import { data } from "react-router";
import type { Route } from "./+types/project.controller";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { requireVisibleProject } from "./project-visibility.server";
import { getDb } from "~/server/db/sqlite.server";
import { z } from "zod";
import { PROJECT_ROLES } from "~/schemas/project-file.schema";
import { roleCan } from "~/shared/rbac";
import { createConversation } from "~/server/controller/controller-conversations.server";
import { runControllerTurn } from "~/server/controller/controller-run.server";
import {
  updateGoal,
  type UpdateGoalOp,
} from "~/server/tasks/goal-actions.server";
import { ControllerPage } from "~/features/controller/controller-page";
import { getControllerSurface } from "~/features/controller/controller-query.server";

/**
 * /projects/:slug/controller — the controller addressed INSIDE one project
 * (ruling 99): the same conversation machinery bound to this board, plus the
 * Goals panel where a human sees and redirects every chain.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  // R15-4 on THIS loader, not only the layout's (the F19-28 single-fetch
  // `?_routes=` hole): a non-member gets the unknown-slug 404.
  const ctx = await requireProjectMember(
    request,
    params.slug,
    "talk to the controller about this project",
  );
  const url = new URL(request.url);
  const db = getDb();
  const view = getControllerSurface(
    db,
    { id: ctx.user.id, email: ctx.user.email },
    {
      projectSlug: params.slug,
      conversationId: url.searchParams.get("c"),
      all: url.searchParams.get("all") === "1",
    },
  );
  // The goal redirect controls follow the goal-actions gate (creator OR
  // run-agents); the page only knows the ROLE half — a creator below that tier
  // still gets their own goals' controls honored server-side per submit.
  // SAFETY: the statement selects the single `role` column, TEXT NOT NULL with
  // a CHECK constraint on `project_members` (the safeParse below judges it).
  const roleRow = db
    .prepare(
      `SELECT role FROM project_members WHERE project_slug = ? AND user_id = ?`,
    )
    .get(params.slug, ctx.user.id) as { role: string } | undefined;
  const memberRole = z.enum(PROJECT_ROLES).safeParse(roleRow?.role);
  const canRedirectGoals = memberRole.success
    ? roleCan(memberRole.data, "run-agents")
    : view.viewerIsOrgAdmin;
  return { view, canRedirectGoals };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { auth, db, formData, intent } = await requireFormAction(request);
  requireVisibleProject(db, params.slug, {
    userId: auth.user.id,
    label: auth.user.email,
  }, "talk to the controller about this project");
  try {
    if (intent === "send") {
      const text = String(formData.get("text") ?? "");
      let conversationId = String(formData.get("conversationId") ?? "");
      if (!conversationId) {
        conversationId = createConversation(db, {
          userId: auth.user.id,
          userLabel: auth.user.email,
          projectSlug: params.slug,
        }).id;
      }
      await runControllerTurn(db, {
        conversationId,
        text,
        user: {
          id: auth.user.id,
          email: auth.user.email,
          name: auth.user.name,
          orgRole: auth.user.role,
        },
      });
      return { ok: true as const, conversationId };
    }
    if (intent === "goal-op") {
      const opName = String(formData.get("op") ?? "");
      const index = Number(formData.get("index") ?? 0);
      const reason = String(formData.get("reason") ?? "").trim();
      let op: UpdateGoalOp;
      switch (opName) {
        case "pause":
          op = { op: "pause" };
          break;
        case "resume":
          op = { op: "resume" };
          break;
        case "cancel":
          op = reason ? { op: "cancel", reason } : { op: "cancel" };
          break;
        case "skip_link":
          op = reason ? { op: "skip_link", index, reason } : { op: "skip_link", index };
          break;
        case "retry_link":
          op = { op: "retry_link", index };
          break;
        default:
          return data(
            { ok: false as const, error: "Unknown goal action." },
            { status: 400 },
          );
      }
      const result = await updateGoal(
        db,
        {
          projectSlug: params.slug,
          goalId: String(formData.get("goalId") ?? ""),
          action: op,
        },
        { userId: auth.user.id, label: auth.user.email },
      );
      return { ok: true as const, toast: result.message };
    }
    return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (cause) {
    return appErrorResponse(cause);
  }
}

export default function ProjectControllerRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  return (
    <ControllerPage
      view={loaderData.view}
      projectSlug={params.slug}
      canRedirectGoals={loaderData.canRedirectGoals}
    />
  );
}
