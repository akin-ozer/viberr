import { Link, NavLink, useLocation } from "react-router";
import { Icon } from "~/ui/icon";
import { WORKSPACE_NAV, workspaceViewFromPathname } from "./nav";

/**
 * Left workspace rail (shell spec §4.1). Live counts from the layout
 * loader: board = ALL tasks incl. Done (deliberate keep, ruling 16),
 * review = review-stage tasks, settings = open policy violations (only
 * rendered when > 0). Nav items are real links; an open task keeps the
 * Board item active (task view is "inside" Board).
 */
export function Rail({
  projectSlug,
  projectName,
  projectRepo,
  membersCount,
  boardCount,
  reviewCount,
  violations,
}: {
  projectSlug: string;
  projectName: string;
  projectRepo: string | null;
  membersCount: number;
  boardCount: number;
  reviewCount: number;
  violations: number;
}) {
  const location = useLocation();
  const activeView = workspaceViewFromPathname(location.pathname);
  return (
    <nav className="rail" aria-label="Primary">
      <Link className="project-switch" to="/" title="All projects">
        <span>
          <div className="pj-name">{projectName}</div>
          <div className="pj-meta">
            {(projectRepo ? projectRepo + " · " : "") + membersCount + " members"}
          </div>
        </span>
        <Icon name="chevron" />
      </Link>

      <div className="rail-label">Workspace</div>
      {WORKSPACE_NAV.map((n) => (
        <NavLink
          key={n.id}
          to={`/projects/${projectSlug}/${n.id}`}
          className={"nav-item" + (activeView === n.id ? " active" : "")}
        >
          <Icon name={n.icon} className="ico" />
          {n.label}
          {n.id === "board" && <span className="count">{boardCount}</span>}
          {n.id === "review" && <span className="count">{reviewCount}</span>}
          {n.id === "settings" && violations > 0 && (
            <span
              className="count"
              style={{ color: "var(--coral-dark)", fontWeight: 700 }}
            >
              {violations}
            </span>
          )}
        </NavLink>
      ))}

      <div className="rail-spacer" />
    </nav>
  );
}
