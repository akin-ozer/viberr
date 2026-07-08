import { data, redirect } from "react-router";
import type { Route } from "./+types/notifications.read";
import { requireAuth } from "~/server/auth/require-user.server";
import { assertCsrf } from "~/server/auth/csrf.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  markAllNotificationsRead,
  markNotificationsRead,
} from "~/server/projections/notifications.server";

/**
 * POST /notifications/read — the ONE mark-read action behind the bell
 * popover (both shells) and the /notifications page. Intents:
 *   read      — `id` fields (repeatable)
 *   read-all  — everything unread for the session user
 * Idempotent (read state is monotonic). Revalidation refreshes badges.
 */

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const intent = String(formData.get("intent") ?? "read");

  if (intent === "read-all") {
    return { ok: true as const, changed: markAllNotificationsRead(db, ctx.user.id) };
  }
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) {
    return data({ ok: false as const, error: "No notification ids." }, { status: 400 });
  }
  return { ok: true as const, changed: markNotificationsRead(db, ctx.user.id, ids) };
}

export function loader(_: Route.LoaderArgs) {
  throw redirect("/notifications");
}
