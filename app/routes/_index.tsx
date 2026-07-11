import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/_index";
import type { loader as rootLoader } from "../root";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { assertCsrf } from "~/server/auth/csrf.server";
import { getDb } from "~/server/db/sqlite.server";
import { getEnv } from "~/server/config/env.server";
import { isAppError } from "~/server/errors/app-error.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { rebuildProjections } from "~/server/projections/rebuild.server";
import { getHomePrefs, patchHomePrefs } from "~/server/prefs/user-prefs.server";
import {
  getHomeOrgSummary,
  listHomeProjectsForUser,
} from "~/features/home/home-query.server";
import { createProject } from "~/features/home/project-create.server";
import { HomePage } from "~/features/home/home-page";
import { sseScopes } from "~/features/live-updates/event-types";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";

// Home — multi-project landing (home spec). Route: `/`.

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Viberr" },
    { name: "description", content: "Governed AI software delivery." },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const hour = new Date().getHours();
  const greet =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return {
    user,
    greet,
    projects: listHomeProjectsForUser(db, { id: user.id, role: user.role }),
    prefs: getHomePrefs(db, user.id),
    org: getHomeOrgSummary(db),
    notifications: listNotifications(db, user.id, { limit: 100 }),
    unread: countUnreadNotifications(db, user.id),
    storeRoot: getEnv().VIBERR_DATA_ROOT,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "pin") {
      const slug = String(formData.get("slug") ?? "");
      const pinned = formData.get("pinned") === "1";
      const prefs = getHomePrefs(db, ctx.user.id);
      patchHomePrefs(db, ctx.user.id, {
        stars: { ...prefs.stars, [slug]: pinned },
      });
      return { ok: true as const };
    }
    if (intent === "view") {
      const view = formData.get("view") === "list" ? "list" : ("grid" as const);
      patchHomePrefs(db, ctx.user.id, { view: view as "grid" | "list" });
      return { ok: true as const };
    }
    if (intent === "rescan") {
      // A global re-scan reprojects EVERY project from files — an
      // instance-maintenance action, so it is org-admin only (D7; consistent
      // with the board rescan's admin|maintainer project gate and with
      // rebuild-projections below). It used to be ungated for any signed-in user.
      if (ctx.user.role !== "admin") {
        return data(
          {
            ok: false as const,
            error: "Re-scanning the store requires the org admin role.",
          },
          { status: 403 },
        );
      }
      const summary = rescanProjections(db, { actor });
      return { ok: true as const, ...summary };
    }
    if (intent === "rebuild-projections") {
      // Phase 10 recovery: drop + re-project everything from files.
      // Admin-only (instance maintenance beyond the everyday re-scan).
      if (ctx.user.role !== "admin") {
        return data(
          {
            ok: false as const,
            error: "Rebuilding projections requires the org admin role.",
          },
          { status: 403 },
        );
      }
      const summary = rebuildProjections(db, { actor });
      return { ok: true as const, ...summary };
    }
    if (intent === "create-project") {
      // RBAC decision (deliberate, pinned by test): project creation is
      // self-serve for ANY signed-in org member — no org-admin gate. The
      // creator is seeded as the new project's admin (project-create.server.ts).
      // Org role is intentionally NOT consulted here; the only guard is the
      // requireAuth at the top of this action.
      const result = await createProject(
        db,
        {
          name: String(formData.get("name") ?? ""),
          key: String(formData.get("key") ?? ""),
          owner: String(formData.get("owner") ?? ""),
          repoName: String(formData.get("repoName") ?? ""),
          template: formData.get("template") === "light" ? "light" : "governed",
          policy:
            formData.get("policy") === "strict"
              ? "strict"
              : formData.get("policy") === "auto"
                ? "auto"
                : "balanced",
        },
        actor,
      );
      return { ok: true as const, ...result };
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

export default function Index({ loaderData }: Route.ComponentProps) {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  // Live updates (Phase 6): `user` scope = own notification.created/read
  // (bell) + projection.rebuilt broadcasts; `projects` scope = every
  // project/task change so the landing cards refresh without a manual
  // re-scan (E2 — `[user]` alone never saw task/project events).
  useLiveUpdates([sseScopes.user(), sseScopes.allProjects()]);
  return <HomePage data={loaderData} theme={rootData?.theme ?? "system"} />;
}
