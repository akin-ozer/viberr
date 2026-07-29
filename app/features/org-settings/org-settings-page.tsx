import { useNavigate, useSearchParams } from "react-router";
import type { OrgSettingsView } from "~/server/org/org-view.server";
import { Icon, type IconName } from "~/ui/icon";
import { ConnectionsPanel } from "./connections-panel";
import { ResourcesPanel } from "./resources-panel";
import { UsersPanel } from "./users-panel";

/**
 * /org/settings page shell (org-settings spec §4.0, markup 1:1): back
 * button + title, tab rail with live counts, active panel. The tab rides
 * the URL (?tab=connections|users|resources — the Home tiles already link
 * this shape); default "connections". Admin-only (route-enforced).
 */

export type OrgSettingsTab = "connections" | "users" | "resources";

const SETTINGS_TABS: { id: OrgSettingsTab; label: string; icon: IconName }[] = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  { id: "resources", label: "Agent resources", icon: "memory" },
];

function resolveOrgTab(raw: string | null): OrgSettingsTab {
  return raw === "users" || raw === "resources" ? raw : "connections";
}

export function OrgSettingsPage({
  view,
  meId,
}: {
  view: OrgSettingsView;
  meId: string;
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
  const counts: Record<OrgSettingsTab, number> = {
    connections: view.connections.length,
    users: view.users.length,
    resources: resourceCount,
  };
  const countHint: Record<OrgSettingsTab, string> = {
    connections: `${view.connections.length} GitHub connection${view.connections.length === 1 ? "" : "s"}`,
    users: `${view.users.length} user${view.users.length === 1 ? "" : "s"}`,
    resources: `${view.kbs.length} knowledge bases · ${view.mcps.length} MCP · ${view.skills.length} skills — plus ${view.gagents.length} agent profile${view.gagents.length === 1 ? "" : "s"}`,
  };

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
            Instance level — shared by every project and board. Board-level workflow
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
            <UsersPanel users={view.users} domains={view.domains} meId={meId} />
          )}
          {tab === "resources" && (
            <ResourcesPanel
              kbs={view.kbs}
              mcps={view.mcps}
              skills={view.skills}
              gagents={view.gagents}
              stages={view.stages}
            />
          )}
        </div>
      </div>
    </main>
  );
}
