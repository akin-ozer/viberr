import { Icon } from "./icon";
import { Link } from "react-router";

/** Compact, page-local reminder that archived project data is historical. */
export function ArchivedBadge() {
  return (
    <span className="archived-chip" role="status">
      <Icon name="lock" />
      Archived · read-only
    </span>
  );
}

/** Workspace-wide archive notice. Settings is offered only to users who can
 * actually open that protected project surface. */
export function ArchivedProjectBanner({
  projectSlug,
  canOpenSettings,
}: {
  projectSlug: string;
  canOpenSettings: boolean;
}) {
  return (
    <div className="archived-banner" role="status">
      <strong>Archived · read-only history</strong>
      <span>
        {canOpenSettings
          ? "Restore this project before changing tasks, policy, agents, or integrations."
          : "This project is read-only. Ask a project admin to restore it before making changes."}
      </span>
      {canOpenSettings && (
        <Link to={`/projects/${projectSlug}/settings`}>Open Settings</Link>
      )}
    </div>
  );
}
