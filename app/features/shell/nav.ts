import type { IconName } from "~/ui/icon";

/**
 * Workspace rail nav model — order and copy are exact (shell spec §4.1).
 */

export interface WorkspaceNavItem {
  id:
    | "board"
    | "review"
    | "controller"
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
  // Ruling 99: the instance controller, addressed inside this project.
  { id: "controller", label: "Controller", icon: "cpu" },
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

/**
 * P13-D-35 (UX-7): "Filters, queue position, and recent focus should not reset
 * unnecessarily" (ux-design-specification.md:824-825). The board's filter,
 * layout and search live ONLY in URL params — there is no sessionStorage — so
 * every in-app link written as the bare path `/projects/:slug/board` resets them
 * to `filter=all, view=stage, q=""` (React Router drops `search` for an absolute
 * path string). That includes the rail's own Board item and the project crumb,
 * both of which are reachable *while looking at a filtered board*.
 *
 * The search string is only meaningful inside that project's board context: a
 * task route's params (or another project's) describe something else entirely,
 * so pasting them onto a board URL would invent state the user never chose.
 * Hence the exact-pathname guard — off the board this returns the bare path.
 */
export function boardHref(
  projectSlug: string,
  location: { pathname: string; search: string },
): string {
  const path = `/projects/${projectSlug}/board`;
  return location.pathname === path && location.search
    ? path + location.search
    : path;
}

/** Crumb / rail label for the current view. */
export function workspaceViewLabel(view: WorkspaceNavItem["id"]): string {
  return WORKSPACE_NAV.find((n) => n.id === view)?.label ?? "Board";
}
