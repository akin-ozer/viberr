import type { IconName } from "~/ui/icon";

/**
 * Workspace rail nav model — order and copy are exact (shell spec §4.1).
 */

export interface WorkspaceNavItem {
  id:
    | "board"
    | "review"
    | "agents"
    | "policy"
    | "github"
    | "activity"
    | "settings";
  label: string;
  icon: IconName;
}

export const WORKSPACE_NAV: readonly WorkspaceNavItem[] = [
  { id: "board", label: "Board", icon: "board" },
  { id: "review", label: "Review queue", icon: "inbox" },
  { id: "agents", label: "Agents", icon: "agents" },
  { id: "policy", label: "Policy", icon: "shield" },
  { id: "github", label: "GitHub", icon: "github" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

/**
 * Current workspace view id from the pathname (`/projects/:slug/<view>`);
 * the board index and task routes both count as "board" (the task view is
 * "inside" Board for crumb/rail purposes — shell spec §7).
 */
export function workspaceViewFromPathname(pathname: string): WorkspaceNavItem["id"] {
  const m = pathname.match(/^\/projects\/[^/]+(?:\/([^/]+))?/);
  const segment = m?.[1];
  if (!segment || segment === "tasks") return "board";
  const known = WORKSPACE_NAV.find((n) => n.id === segment);
  return known ? known.id : "board";
}

/** Crumb / rail label for the current view. */
export function workspaceViewLabel(view: WorkspaceNavItem["id"]): string {
  return WORKSPACE_NAV.find((n) => n.id === view)?.label ?? "Board";
}
