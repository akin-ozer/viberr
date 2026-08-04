import { Link, useLocation } from "react-router";
import { Icon } from "~/ui/icon";
import { boardHref, WORKSPACE_NAV, workspaceViewFromPathname } from "./nav";

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
            {(projectRepo ? projectRepo + " · " : "") +
              membersCount +
              (membersCount === 1 ? " member" : " members")}
          </div>
        </span>
        <Icon name="chevron" />
      </Link>

      <div className="rail-label">Workspace</div>
      {WORKSPACE_NAV.map((n) => (
        <Link
          key={n.id}
          // P13-D-35: the Board item is the one nav target that owns URL state
          // (filter/view/search); a bare path reset it every time it was
          // clicked from a filtered board. Every other view is stateless.
          to={
            n.id === "board"
              ? boardHref(projectSlug, location)
              : `/projects/${projectSlug}/${n.id}`
          }
          className={"nav-item" + (activeView === n.id ? " active" : "")}
          // P13-D-37 (WCAG 1.3.1): the active item was marked with a
          // hand-computed class ALONE. This was a `NavLink`, but NavLink only
          // emits `aria-current` when its own `to` matches the URL — and
          // `/projects/x/tasks/VIB-1` never matches `to=".../board"`. So on
          // every task-detail page, the product's deepest surface, Board was
          // visually highlighted with no programmatic signal, and passing
          // `aria-current` to NavLink would still have been gated by that same
          // match. `activeView` (which maps `tasks` → board) is the real source
          // of truth, so this is a plain Link that states it.
          aria-current={activeView === n.id ? "page" : undefined}
        >
          <Icon name={n.icon} className="ico" />
          {n.label}
          {n.id === "board" && <span className="count">{boardCount}</span>}
          {n.id === "review" && <span className="count">{reviewCount}</span>}
          {n.id === "settings" && violations > 0 && (
            <span
              className="count violations"
            >
              {violations}
            </span>
          )}
        </Link>
      ))}

      <div className="rail-spacer" />
    </nav>
  );
}
