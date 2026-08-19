import { useRef } from "react";
import {
  data,
  useFetcher,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import { z } from "zod";
import type { Route } from "./+types/profile";
import type { loader as rootLoader } from "../root";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { getProfileView } from "~/features/profile/profile-query.server";
import {
  changeOwnPassword,
  disconnectGithubIdentity,
  setMotionPref,
  setNotifRoutingPref,
  setTimelineDefaultPref,
  updateProfileIdentity,
} from "~/features/profile/profile-actions.server";
import {
  ProfilePage,
  type ProfileActionData,
} from "~/features/profile/profile-page";
import { applyThemePreference } from "~/features/shell/theme-preference";
import { useCsrfToken } from "~/ui/csrf-input";
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/**
 * /profile — URL-addressable PageOverlay route (phase-4 shell decision,
 * kept). Phase 9C fills it with the full profile.jsx surface: identity,
 * notification routing, MOUNTED Appearance panel (ruling 13), read-only
 * RBAC access view, GitHub identity, self-serve password change.
 *
 * Theme still goes through the existing /prefs/theme action (cookie +
 * users.theme); motion/tlDefault/notifs live in user_prefs via this
 * route's action.
 */

export function meta() {
  return [{ title: "Profile & preferences · Viberr" }];
}

/** Overlay routes are opened from the shell with the path to return to in
 *  history state (top-bell, user-menu). Browser history state survives reloads
 *  and back/forward and is not the app's to trust, so it is parsed here rather
 *  than asserted. */
const overlayReturnState = z
  .object({ returnTo: z.string().optional().catch(undefined) })
  .catch({});

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const profile = getProfileView(db, user.id);
  if (!profile) throw data("Account not found.", { status: 404 });
  return { profile };
}

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32: `assertCsrf` used to throw here, OUTSIDE the try below — a thrown
  // Response renders the nearest boundary, so an expired token replaced the
  // profile overlay (and everything else) with root's 403 page instead of the
  // `{ok:false,error}` toast this action's own catch produces for every other
  // failure.
  const csrfFailure = await csrfError(request, ctx.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  const actor = { userId: ctx.user.id, label: ctx.user.email };

  try {
    switch (intent) {
      case "identity": {
        const { toast } = updateProfileIdentity(db, actor, {
          name: String(formData.get("name") ?? ""),
          title: String(formData.get("title") ?? ""),
        });
        return { ok: true as const, intent, toast };
      }
      case "set-notif": {
        setNotifRoutingPref(
          db,
          ctx.user.id,
          String(formData.get("category") ?? ""),
          formData.get("on") === "1",
        );
        return { ok: true as const, intent };
      }
      case "set-motion": {
        setMotionPref(db, ctx.user.id, String(formData.get("motion") ?? ""));
        return { ok: true as const, intent };
      }
      case "set-tl-default": {
        setTimelineDefaultPref(
          db,
          ctx.user.id,
          String(formData.get("tlDefault") ?? ""),
        );
        return { ok: true as const, intent };
      }
      case "change-password": {
        const { toast } = await changeOwnPassword(
          db,
          { ...actor, sessionId: ctx.sessionId },
          {
            current: String(formData.get("current") ?? ""),
            next: String(formData.get("next") ?? ""),
            confirm: String(formData.get("confirm") ?? ""),
          },
        );
        return { ok: true as const, intent, toast };
      }
      case "github-disconnect": {
        const { toast } = disconnectGithubIdentity(db, actor);
        return { ok: true as const, intent, toast };
      }
      default:
        return data(
          { ok: false as const, intent, error: "Unknown action." },
          { status: 400 },
        );
    }
  } catch (error) {
    // Map ALL AppErrors to the fetcher's `{ ok:false }` shape (WI-13/WI-14):
    // an infrastructure-kind AppError otherwise crashed the overlay's error
    // boundary instead of surfacing inline like every sibling route.
    if (isAppError(error)) {
      return data(
        { ok: false as const, intent, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
  }
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const { profile } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const theme = rootData?.theme ?? "system";
  const navigate = useNavigate();
  const location = useLocation();
  const csrf = useCsrfToken();
  const push = useToast();
  const themeFetcher = useFetcher<{ ok: boolean; error?: string }>();

  const identityFetcher = useFetcher<ProfileActionData>();
  const prefsFetcher = useFetcher<ProfileActionData>();
  // UI-56: Appearance gets its own fetcher. Sharing `prefsFetcher` meant a
  // notification flip immediately followed by a motion flip never delivered the
  // `set-notif` result, stranding that panel's rollback snapshot so a LATER
  // failure rolled back to stale state.
  const appearanceFetcher = useFetcher<ProfileActionData>();
  const passwordFetcher = useFetcher<ProfileActionData>();
  const githubFetcher = useFetcher<ProfileActionData>();

  const close = () => {
    const { returnTo } = overlayReturnState.parse(location.state);
    navigate(returnTo ?? "/");
  };

  const submitWith =
    (fetcher: typeof identityFetcher) => (fields: Record<string, string>) => {
      const fd = new FormData();
      fd.set("_csrf", csrf);
      for (const [key, value] of Object.entries(fields)) fd.set(key, value);
      fetcher.submit(fd, { method: "post", action: "/profile" });
    };

  // UI-31: the theme toast fired at SUBMIT time and no handler read the result,
  // so a rejected POST (expired session / stale CSRF) left the page claiming the
  // theme was saved while the next revalidation reverted it. Settle on the
  // result and roll the applied preference back on failure.
  const themePending = useRef<{ toast: string; rollback: ThemePreference } | null>(
    null,
  );
  useFetcherResult(themeFetcher, (result) => {
    const p = themePending.current;
    themePending.current = null;
    if (!p) return;
    if (result.ok) {
      push(p.toast);
    } else {
      applyThemePreference(p.rollback);
      push(result.error ?? "Theme not saved — reload and try again", "error");
    }
  });

  const onTheme = (next: ThemePreference, label: string) => {
    // RU-1: re-selecting the active theme is a no-op — don't re-submit or toast.
    if (next === theme) return;
    themePending.current = {
      toast: "Theme · " + label + (next === "system" ? " (follows your OS)" : ""),
      rollback: theme,
    };
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    themeFetcher.submit(fd, { method: "post", action: "/prefs/theme" });
  };

  return (
    <PageOverlay label="Profile & preferences" onClose={close}>
      <ProfilePage
        key={profile.user.id}
        data={profile}
        theme={theme}
        onTheme={onTheme}
        fetchers={{
          identity: identityFetcher,
          prefs: prefsFetcher,
          appearance: appearanceFetcher,
          password: passwordFetcher,
          github: githubFetcher,
        }}
        submitWith={submitWith}
      />
    </PageOverlay>
  );
}
