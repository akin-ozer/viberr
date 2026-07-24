import { data, redirect } from "react-router";
import type { Route } from "./+types/prefs.theme";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { updateUserFields } from "~/server/auth/user-store.server";
import {
  isThemePreference,
  serializeThemePreference,
} from "~/server/theme/theme-cookie.server";

/**
 * POST /prefs/theme — theme cycling from the user menu / profile panel.
 * Persists to the user row (users.theme) AND the viberr_theme cookie so the
 * next SSR paints correctly (docs/architecture/decisions.md theme rule). The client applies
 * data-theme optimistically before this returns (personal UI state).
 */

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32: a thrown CSRF Response blew the whole app to the root boundary;
  // user-menu.tsx already handles `{ok:false,error}` correctly.
  const csrfFailure = await csrfError(request, ctx.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const theme = String(formData.get("theme") ?? "");
  if (!isThemePreference(theme)) {
    return data({ ok: false as const, error: "Invalid theme." }, { status: 400 });
  }
  updateUserFields(db, ctx.user.id, { theme });
  return data(
    { ok: true as const, theme },
    { headers: { "Set-Cookie": serializeThemePreference(theme) } },
  );
}

// Surface the action's Set-Cookie (deepest headers export wins).
export function headers({ actionHeaders }: Route.HeadersArgs) {
  return actionHeaders;
}

export function loader(_: Route.LoaderArgs) {
  throw redirect("/");
}
