import { Link } from "react-router";
import type { Route } from "./+types/org.settings";
import { requireUser } from "~/server/auth/require-user.server";
import { Icon } from "~/ui/icon";

/**
 * /org/settings — PLACEHOLDER so the Home settings tiles are real links
 * (no dead ends). Phase 9 ports the full tabbed org-settings.jsx surface
 * here (tab comes from ?tab=connections|users|resources — already passed
 * by the Home tiles). Until then, admins are pointed at the phase-2 temp
 * user admin page.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Viberr settings" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = requireUser(request);
  return { isAdmin: user.role === "admin" };
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  return (
    <main className="app-splash" data-screen-label="Org settings — placeholder">
      <section className="panel">
        <div className="panel-head">
          <h2>Viberr settings</h2>
          <span className="right pill neutral">phase 9</span>
        </div>
        <p className="detail-line">
          Instance settings (GitHub connections, users &amp; access, agent
          resources) arrive in phase 9.
          {loaderData.isAdmin
            ? " Until then, admins can manage users at the temporary page below."
            : ""}
        </p>
        {loaderData.isAdmin && (
          <Link className="btn" to="/org/users">
            <Icon name="user" />
            Org users (temp)
          </Link>
        )}
        <Link className="btn ghost" to="/">
          <Icon name="arrow" />
          Back to projects
        </Link>
      </section>
    </main>
  );
}
