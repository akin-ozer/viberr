import {
  data,
  useFetcher,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/profile";
import type { loader as rootLoader } from "../root";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { assertCsrf } from "~/server/auth/csrf.server";
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
import { applyThemePreference } from "~/features/shell/user-menu";
import { useCsrfToken } from "~/ui/csrf-input";
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";

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

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile & preferences · Viberr" }];
}

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
  await assertCsrf(request, ctx.sessionId, formData);
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
        const { toast } = changeOwnPassword(
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
    if (isAppError(error) && error.kind === "user") {
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
  const themeFetcher = useFetcher();

  const identityFetcher = useFetcher<ProfileActionData>();
  const prefsFetcher = useFetcher<ProfileActionData>();
  const passwordFetcher = useFetcher<ProfileActionData>();
  const githubFetcher = useFetcher<ProfileActionData>();

  const close = () => {
    const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
    navigate(returnTo ?? "/");
  };

  const submitWith =
    (fetcher: typeof identityFetcher) => (fields: Record<string, string>) => {
      const fd = new FormData();
      fd.set("_csrf", csrf);
      for (const [key, value] of Object.entries(fields)) fd.set(key, value);
      fetcher.submit(fd, { method: "post", action: "/profile" });
    };

  const onTheme = (next: ThemePreference, label: string) => {
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    themeFetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    push("Theme · " + label + (next === "system" ? " (follows your OS)" : ""));
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
          password: passwordFetcher,
          github: githubFetcher,
        }}
        submitWith={submitWith}
      />
    </PageOverlay>
  );
}
