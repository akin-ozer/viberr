import { useNavigate, useSearchParams } from "react-router";
import type { OrgSettingsView } from "~/server/org/org-view.server";
import { countLabel } from "~/shared/text/plural";
import { Icon, type IconName } from "~/ui/icon";
import { ConnectionsPanel } from "./connections-panel";
import { ResourcesPanel } from "./resources-panel";
import { SsoPanel } from "./sso-panel";
import { UsersPanel } from "./users-panel";

/**
 * /org/settings page shell (org-settings spec §4.0, markup 1:1): back
 * button + title, tab rail with live counts, active panel. The tab rides
 * the URL (?tab=connections|users|resources — the Home tiles already link
 * this shape); default "connections". Admin-only (route-enforced).
 */

export type OrgSettingsTab = "connections" | "users" | "sso" | "resources";

const SETTINGS_TABS: { id: OrgSettingsTab; label: string; icon: IconName }[] = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  // R19-16: sits next to Users & access — the whitelist decides WHO may sign
  // in, this decides HOW they can.
  { id: "sso", label: "Sign-in & SSO", icon: "lock" },
  { id: "resources", label: "Agent resources", icon: "memory" },
];

function resolveOrgTab(raw: string | null): OrgSettingsTab {
  return raw === "users" || raw === "resources" || raw === "sso"
    ? raw
    : "connections";
}

export function OrgSettingsPage({
  view,
  meId,
  callbackOrigin,
}: {
  view: OrgSettingsView;
  meId: string;
  /** This deployment's origin — the callback URL an OAuth app must carry. */
  callbackOrigin: string;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveOrgTab(searchParams.get("tab"));
  // The badge counts RESOURCES — knowledge bases, MCP servers, skills. It used
  // to fold agent templates in too, so the same concept was counted two ways one
  // click apart: the Home tile presents "N agent profiles" separately from the
  // KB/MCP/skill line. Profiles are disclosed in the tooltip instead of being
  // silently added to a number labelled "Agent resources".
  const resourceCount = view.kbs.length + view.mcps.length + view.skills.length;
  const counts = {
    connections: view.connections.length,
    users: view.users.length,
    // The count is LIVE methods, not configured rows: a provider saved but not
    // switched on grants nothing, and a badge that counted it would say the
    // opposite of the card underneath.
    sso: view.authProviders.filter((p) => p.active).length,
    resources: resourceCount,
  } satisfies Record<OrgSettingsTab, number>;
  const countHint = {
    connections: countLabel(view.connections.length, "GitHub connection"),
    users: countLabel(view.users.length, "user"),
    sso: countLabel(
      view.authProviders.filter((p) => p.active).length,
      "live sign-in method",
    ),
    // The KB/MCP/skill triple was hardcoded plural, so a one-of-each instance
    // advertised "1 knowledge bases · 1 MCP · 1 skills" — the same disagreement
    // as the Users tab's "1 instance accounts", three times in one string.
    resources: [
      countLabel(view.kbs.length, "knowledge base"),
      countLabel(view.mcps.length, "MCP server"),
      countLabel(view.skills.length, "skill"),
    ].join(" · ") +
      `, plus ${countLabel(view.gagents.length, "agent profile")}`,
  } satisfies Record<OrgSettingsTab, string>;

  return (
    <main className="home-shell" data-screen-label="Instance settings">
      <div className="set-head">
        <button type="button" className="btn ghost sm" onClick={() => navigate("/")}>
          <Icon name="arrow" className="r180" />
          Projects
        </button>
        <div>
          {/* R15-13: was "Viberr settings", which collides with a PROJECT
              named Viberr — the surface that is not about that project was the
              one saying its name. Every other surface in the app names its own
              scope; these two were the exception in both directions. */}
          <h1>Instance settings</h1>
          <p className="sub">
            Instance level, shared by every project and board. Board-level workflow
            &amp; policy live inside each project.
          </p>
        </div>
      </div>
      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              className={"nav-item" + (tab === t.id ? " active" : "")}
              aria-current={tab === t.id ? "true" : undefined}
              onClick={() => setSearchParams({ tab: t.id })}
            >
              <Icon name={t.icon} className="ico" />
              {t.label}
              <span className="count" title={countHint[t.id]}>
                {counts[t.id]}
              </span>
            </button>
          ))}
        </nav>
        <div className="set-content">
          {tab === "connections" && <ConnectionsPanel connections={view.connections} />}
          {tab === "users" && (
            <UsersPanel
              users={view.users}
              domains={view.domains}
              meId={meId}
              providers={view.providers}
            />
          )}
          {tab === "sso" && (
            <SsoPanel
              providers={view.authProviders}
              callbackOrigin={callbackOrigin}
            />
          )}
          {tab === "resources" && (
            <ResourcesPanel
              kbs={view.kbs}
              mcps={view.mcps}
              skills={view.skills}
              gagents={view.gagents}
              projectGrants={view.projectGrants}
              stages={view.stages}
            />
          )}
        </div>
      </div>
    </main>
  );
}
