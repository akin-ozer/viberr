import { data, redirect } from "react-router";
import type { Route } from "./+types/notifications.read";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
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
 * Idempotent (read state is monotonic). Revalidation refreshes this tab's
 * badge; the mark-read server layer emits a user-scoped `notification.read`
 * SSE event so every OTHER tab of the same user revalidates too (E12).
 */

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32: `assertCsrf` throws a raw 403 Response. A thrown response from a
  // fetcher renders the nearest error boundary, so a stale token replaced the
  // WHOLE UI with root's "403 Forbidden" page — and the carefully written
  // `{ok:false,error}` toast branches in top-bell.tsx / notifications.tsx
  // ("reports the failure instead of a false success") could never fire. Map it
  // to the same result shape those handlers already read.
  const csrfFailure = await csrfError(request, ctx.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "read");

  if (intent === "read-all") {
    return { ok: true as const, changed: markAllNotificationsRead(db, ctx.user.id) };
  }
  const ids = formData.getAll("id").flatMap((value) => {
    const id = String(value);
    return id ? [id] : [];
  });
  if (ids.length === 0) {
    return data({ ok: false as const, error: "No notification ids." }, { status: 400 });
  }
  return { ok: true as const, changed: markNotificationsRead(db, ctx.user.id, ids) };
}

export function loader() {
  throw redirect("/notifications");
}
