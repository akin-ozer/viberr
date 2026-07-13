import { useEffect, useRef } from "react";
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
  orgAdminOverride,
  canViewProtected = true,
  mobile = false,
  open = false,
  onClose,
}: {
  projectSlug: string;
  projectName: string;
  projectRepo: string | null;
  membersCount: number;
  boardCount: number;
  reviewCount: number;
  violations: number;
  orgAdminOverride?: boolean;
  /** Review/config surfaces are member-only, except org-admin emergency access. */
  canViewProtected?: boolean;
  mobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}) {
  const location = useLocation();
  const activeView = workspaceViewFromPathname(location.pathname);
  const navRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mobileClosed = mobile && !open;

  // Focus the close button only when the drawer opens. Keyed on mobile/open
  // alone — depending on onClose (recreated every parent render) would re-run
  // this on every SSE-driven revalidation and yank focus back off the nav links.
  useEffect(() => {
    if (!mobile || !open) return;
    closeRef.current?.focus();
  }, [mobile, open]);

  useEffect(() => {
    if (!mobile || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile, onClose, open]);

  const trapTab = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!mobile || !open || event.key !== "Tab") return;
    const focusable = [...(navRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {mobile && open && (
        <button
          type="button"
          className="rail-scrim"
          aria-label="Close project navigation"
          onClick={onClose}
        />
      )}
      <nav
        id="project-rail"
        ref={navRef}
        className={`rail${mobile ? " mobile" : ""}${open ? " open" : ""}`}
        aria-label="Primary"
        aria-hidden={mobileClosed || undefined}
        inert={mobileClosed || undefined}
        onKeyDown={trapTab}
      >
        {mobile && (
          <button
            type="button"
            className="rail-close icon-btn"
            aria-label="Close project navigation"
            onClick={onClose}
            ref={closeRef}
          >
            <Icon name="x" />
          </button>
        )}
        <Link
          className="project-switch"
          to="/"
          title="All projects"
          onClick={mobile ? onClose : undefined}
        >
          <span>
            <div className="pj-name">{projectName}</div>
            <div className="pj-meta">
              {(projectRepo ? projectRepo + " · " : "") +
                membersCount +
                (membersCount === 1 ? " member" : " members") +
                (orgAdminOverride ? " · org admin override" : "")}
            </div>
          </span>
          <Icon name="chevron" />
        </Link>

        <div className="rail-label">Workspace</div>
        {WORKSPACE_NAV.filter(
          (item) => item.id === "board" || canViewProtected,
        ).map((n) => (
          <NavLink
            key={n.id}
            to={`/projects/${projectSlug}/${n.id}`}
            className={"nav-item" + (activeView === n.id ? " active" : "")}
            onClick={mobile ? onClose : undefined}
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
    </>
  );
}
