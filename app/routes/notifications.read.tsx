import { data, redirect } from "react-router";
import type { Route } from "./+types/notifications.read";
import { requireFormAction } from "~/server/auth/form-action.server";
import {
  markAllNotificationsRead,
  markNotificationsRead,
} from "~/server/projections/notifications.server";

/**
 * POST /notifications/read — the ONE mark-read action behind the bell
 * popover (both shells) and the /notifications page. Intents:
 *   read      — `id` fields (repeatable)
 *   read-all  — everything unread for the session user
 * Idempotent (read state is monotonic). Revalidation refreshes this tab's
 * badge; the mark-read server layer emits a user-scoped `notification.read`
 * SSE event so every OTHER tab of the same user revalidates too (E12).
 */

export async function action({ request }: Route.ActionArgs) {
  const { refused, auth, db, formData, intent } = await requireFormAction(request);
  if (refused) return refused;

  if (intent === "read-all") {
    return { ok: true as const, changed: markAllNotificationsRead(db, auth.user.id) };
  }
  const ids = formData.getAll("id").flatMap((value) => {
    const id = String(value);
    return id ? [id] : [];
  });
  if (ids.length === 0) {
    return data({ ok: false as const, error: "No notification ids." }, { status: 400 });
  }
  return { ok: true as const, changed: markNotificationsRead(db, auth.user.id, ids) };
}

export function loader() {
  throw redirect("/notifications");
}
