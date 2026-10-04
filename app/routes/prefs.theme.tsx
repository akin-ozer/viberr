import { data, redirect } from "react-router";
import type { Route } from "./+types/prefs.theme";
import { requireFormAction } from "~/server/auth/form-action.server";
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
  const { refused, auth, db, formData } = await requireFormAction(request);
  if (refused) return refused;
  const theme = String(formData.get("theme") ?? "");
  if (!isThemePreference(theme)) {
    return data({ ok: false as const, error: "Invalid theme." }, { status: 400 });
  }
  updateUserFields(db, auth.user.id, { theme });
  return data(
    { ok: true as const, theme },
    { headers: { "Set-Cookie": serializeThemePreference(theme) } },
  );
}

// Surface the action's Set-Cookie (deepest headers export wins).
export function headers({ actionHeaders }: Route.HeadersArgs) {
  return actionHeaders;
}

export function loader() {
  throw redirect("/");
}
