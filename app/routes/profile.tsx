import { useLocation, useNavigate, useRouteLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/profile";
import type { loader as rootLoader } from "../root";
import { requireUser } from "~/server/auth/require-user.server";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Avatar, initialsOf } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { PageOverlay } from "~/ui/page-overlay";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { applyThemePreference } from "~/features/shell/user-menu";

/**
 * /profile — URL-addressable PageOverlay route (shell spec §4.6 porting
 * decision, documented in the phase-4 report): in-app openers pass
 * `state.returnTo` so Close returns to the view underneath; direct loads
 * close to `/`. Phase 4 ships a MINIMAL identity + theme panel; Phase 9
 * ports the full profile.jsx surface into this route.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Profile & preferences · Viberr" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = requireUser(request);
  return { user };
}

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

export default function Profile({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const theme = rootData?.theme ?? "system";
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher();
  const csrf = useCsrfToken();
  const push = useToast();

  const close = () => {
    const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
    navigate(returnTo ?? "/");
  };

  const setTheme = (next: ThemePreference) => {
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    fetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    push(
      "Theme · " +
        (next === "system"
          ? "System (follows your OS)"
          : next === "dark"
            ? "Dark"
            : "Light"),
    );
  };

  return (
    <PageOverlay label="Profile & preferences" onClose={close}>
      <div className="task-preview">
        <section className="panel">
          <div className="panel-head">
            <h2>Profile &amp; preferences</h2>
            <span className="right pill neutral">{user.role}</span>
          </div>
          <span className="who-chip">
            <Avatar
              person={{ initials: initialsOf(user.name), tone: user.avatarTone }}
              xl
            />
            <span>
              <span className="nm">{user.name}</span>
              <div className="sub">
                {(user.title ? user.title + " · " : "") + user.email}
              </div>
            </span>
          </span>

          <div className="tp-section">
            <div className="tp-label">Appearance</div>
            <div className="pick-chips">
              {THEME_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  className={"pick-chip" + (theme === o.id ? " on" : "")}
                  onClick={() => setTheme(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="tp-foot">
            <span className="tp-note">
              Notification routing, access view and GitHub identity arrive in
              phase 9.
            </span>
          </div>
        </section>
      </div>
    </PageOverlay>
  );
}
