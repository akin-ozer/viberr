import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/_index";
import type { loader as rootLoader } from "../root";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { heldDataRootLock } from "~/server/db/data-root-lock.server";
import { getEnv } from "~/server/config/env.server";
import { bellCounts } from "~/server/projections/notifications.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { rebuildProjections } from "~/server/projections/rebuild.server";
import {
  REBUILD_MIN_INTERVAL_MS,
  RESCAN_MIN_INTERVAL_MS,
  runSingleFlight,
  throttledMessage,
} from "~/server/projections/single-flight.server";
import { getHomePrefs, patchHomePrefs } from "~/server/prefs/user-prefs.server";
import {
  getHomeOrgSummary,
  getHomeSetup,
  listHomeProjectsForUser,
} from "~/features/home/home-query.server";
import {
  createProject,
  type CreateProjectInput,
} from "~/features/home/project-create.server";
import { HomePage } from "~/features/home/home-page";
import { sseScopes } from "~/features/live-updates/event-types";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";

// Home — multi-project landing (home spec). Route: `/`.

export function meta() {
  return [
    { title: "Viberr" },
    { name: "description", content: "Collaborative AI software delivery." },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const hour = new Date().getHours();
  const greet =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const viewer = { id: user.id, role: user.role };
  const projects = listHomeProjectsForUser(db, viewer);
  return {
    user,
    greet,
    projects,
    // Ruling 532: the setup checklist's steps, null once all are done.
    setup: getHomeSetup(db, viewer, projects.length),
    prefs: getHomePrefs(db, user.id),
    org: getHomeOrgSummary(db),
    // Ruling 457 (FL-4): the bell's counts; the bell loads its own list.
    ...bellCounts(db, user.id),
    // B-FD4: `VIBERR_DATA_ROOT` is a HOST filesystem path. It exists here only
    // for the New-project modal's "creates …/projects/<slug>/" hint, and every
    // control that acts on the store is org-admin gated — so a member gets the
    // store-relative form of the same hint and no host layout. Loader-side, not
    // a render-time hide.
    storeRoot: user.role === "admin" ? getEnv().VIBERR_DATA_ROOT : null,
    // F18-5: the single-writer lock holder, so an admin can SEE (not just infer
    // from a health probe) which process owns this data root — the human-facing
    // half of the fail-closed guard. Admin-only, like storeRoot.
    lockHolder:
      user.role === "admin"
        ? (() => {
            const h = heldDataRootLock()?.holder;
            return h
              ? { pid: h.pid, hostname: h.hostname, startedAt: h.startedAt }
              : null;
          })()
        : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const {
    refused,
    auth: ctx,
    db,
    formData,
    actor,
    intent,
  } = await requireFormAction(request);
  if (refused) return refused;

  try {
    // UI-06: both pref intents echo the intent back so the client can toast
    // from the SETTLED result instead of at submit time (the star used to
    // report "Pinned" and then silently revert on a CSRF/session failure).
    if (intent === "pin") {
      const slug = String(formData.get("slug") ?? "");
      const pinned = formData.get("pinned") === "1";
      const prefs = getHomePrefs(db, ctx.user.id);
      patchHomePrefs(db, ctx.user.id, {
        stars: { ...prefs.stars, [slug]: pinned },
      });
      return { ok: true as const, intent: "pin" as const, pinned };
    }
    if (intent === "view") {
      patchHomePrefs(db, ctx.user.id, {
        view: formData.get("view") === "list" ? "list" : "grid",
      });
      return { ok: true as const, intent: "view" as const };
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
      // P13-D-33: a whole-store re-scan re-parses every project and task file.
      // It had no limiter of any kind, so holding the button burned one full
      // sweep per click. A skipped sweep is always safe here — the file watcher
      // and the boot rescan converge anyway.
      const flight = runSingleFlight(
        "projections:rescan",
        () => rescanProjections(db, { actor }),
        { minIntervalMs: RESCAN_MIN_INTERVAL_MS },
      );
      if (flight.status === "throttled") {
        return data(
          {
            ok: false as const,
            error: throttledMessage("The store re-scan", flight.retryAfterMs),
          },
          { status: 429 },
        );
      }
      return { ok: true as const, ...flight.result };
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
      // P13-D-33: heavier than the re-scan (drop + re-project everything), so a
      // longer cooldown. Same reasoning: a refused rebuild costs nothing.
      const flight = runSingleFlight(
        "projections:rebuild",
        () => rebuildProjections(db, { actor }),
        { minIntervalMs: REBUILD_MIN_INTERVAL_MS },
      );
      if (flight.status === "throttled") {
        return data(
          {
            ok: false as const,
            error: throttledMessage(
              "The projection rebuild",
              flight.retryAfterMs,
            ),
          },
          { status: 429 },
        );
      }
      return { ok: true as const, ...flight.result };
    }
    if (intent === "create-project") {
      // RBAC decision (deliberate, pinned by test): project creation is
      // self-serve for ANY signed-in org member — no org-admin gate. The
      // creator is seeded as the new project's admin (project-create.server.ts).
      // Org role is intentionally NOT consulted here; the only guard is the
      // requireAuth at the top of this action.
      const input: CreateProjectInput = {
        name: String(formData.get("name") ?? ""),
        key: String(formData.get("key") ?? ""),
        owner: String(formData.get("owner") ?? ""),
        repoName: String(formData.get("repoName") ?? ""),
        // P13-AP-04: the "Lightweight · 3 stages" preset was deleted (owner
        // ruling 2) — the Standard 5-stage board is the only template, so
        // there is no `template` field to read.
        policy:
          formData.get("policy") === "strict"
            ? "strict"
            : formData.get("policy") === "auto"
              ? "auto"
              : "balanced",
      };
      // Ruling 462: the modal's "Create this repository on GitHub if it does
      // not exist" choice, carrying its visibility; absent (or anything else)
      // asks for no creation.
      const createRepository = formData.get("createRepository");
      if (createRepository === "private" || createRepository === "public") {
        input.createRepository = { private: createRepository === "private" };
      }
      const result = await createProject(db, input, actor);
      return { ok: true as const, ...result };
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  // Live updates (Phase 6): `user` scope = own notification.created/read
  // (bell) + projection.rebuilt broadcasts; `projects` scope = every
  // project/task change so the landing cards refresh without a manual
  // re-scan (E2 — `[user]` alone never saw task/project events).
  const live = useLiveUpdates([sseScopes.user(), sseScopes.allProjects()]);
  return (
    <HomePage
      data={loaderData}
      theme={rootData?.theme ?? "system"}
      // UI-03: surface a dead stream instead of freezing the cards silently.
      livePaused={live.paused}
      onReconnect={live.reconnect}
    />
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/_index");
