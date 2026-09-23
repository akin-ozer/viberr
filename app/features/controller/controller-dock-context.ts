/**
 * Where is the person standing? (ruling 121)
 *
 * The dock mounts once, in root, and derives its scope from the matched
 * routes: a task page anchors it to that task, any workspace view binds it to
 * that board, everything else is instance scope. Pure, so the mapping is
 * testable without a router: the inputs are the shape `useMatches()` and
 * `useLocation()` hand back.
 */

export interface DockContext {
  /** The dock renders nothing here: the page IS the controller, nobody is
   *  signed in, or the surface is a modal overlay the dock could only sit
   *  behind (review finding 5). */
  hidden: boolean;
  /** This surface has no user-scoped SSE stream of its own, so the dock holds
   *  one while it is open (review finding 24). */
  needsOwnStream: boolean;
  projectSlug: string | null;
  taskKey: string | null;
  /** The bound project's display name when the workspace loader has it, so the
   *  trigger is named the same before and after the first open (finding 17). */
  projectName: string | null;
  /** The page, as the transcript records it: pathname + query. */
  surface: string;
  /** One string per scope, the key the dock remembers its selection under. */
  key: string;
}

/**
 * Route ids (from `app/routes.ts`) the dock stays off.
 *
 * The two controller pages and login are obvious: the page is the controller,
 * or nobody is signed in. `/profile` and `/notifications` are here for a
 * different reason (review finding 5): both render their whole page inside a
 * `PageOverlay`, a native `<dialog>` opened with `showModal()`. That puts the
 * page in the top layer and makes everything outside it inert - including the
 * dock, which is mounted in root. It rendered there as a dimmed button that
 * could not be clicked or focused, and a click on it reached the dialog's
 * backdrop and closed the overlay instead. A control that cannot work is worse
 * than no control, so the dock stays off those two surfaces.
 */
export const DOCK_HIDDEN_ROUTE_IDS: readonly string[] = [
  "routes/login",
  "routes/controller",
  "routes/project.controller",
  "routes/profile",
  "routes/notifications",
];

/**
 * The signed-in surfaces that do NOT already subscribe to the `user` SSE
 * scope, and where the dock therefore opens its own stream while the panel is
 * up. Everywhere else one already exists and a second socket would only
 * duplicate revalidations: Home (`routes/_index`) and the workspace layout
 * (`routes/project`) mount `useLiveUpdates` themselves, org settings mounts it
 * in `org-settings-page.tsx`, and `/profile` and `/notifications` are hidden
 * above. `controller-dock-context.test.ts` pins this list against the modules
 * that actually call the hook.
 */
export const DOCK_SELF_STREAM_ROUTE_IDS: readonly string[] = ["routes/insights"];

const WORKSPACE_ROUTE_ID = "routes/project";
const TASK_ROUTE_ID = "routes/project.task";

export interface DockRouteMatch {
  id: string;
  params: Record<string, string | undefined>;
}

export function dockContextFromMatches(
  matches: readonly DockRouteMatch[],
  location: { pathname: string; search: string },
  /** From `projectNameFrom(useRouteLoaderData("routes/project"))`. */
  projectName: string | null = null,
): DockContext {
  const hidden = matches.some((m) => DOCK_HIDDEN_ROUTE_IDS.includes(m.id));
  const needsOwnStream = matches.some((m) =>
    DOCK_SELF_STREAM_ROUTE_IDS.includes(m.id),
  );
  const workspace = matches.find((m) => m.id === WORKSPACE_ROUTE_ID);
  const task = matches.find((m) => m.id === TASK_ROUTE_ID);
  const projectSlug = workspace?.params.slug?.trim() || null;
  // A task key only means something under its project's workspace match.
  const taskKey = projectSlug ? task?.params.key?.trim() || null : null;
  return {
    hidden,
    needsOwnStream,
    projectSlug,
    taskKey,
    // A name only means something when a project is bound.
    projectName: projectSlug ? projectName : null,
    surface: `${location.pathname}${location.search}`,
    key: dockScopeKey({ projectSlug, taskKey }),
  };
}

export function dockScopeKey(scope: {
  projectSlug: string | null;
  taskKey: string | null;
}): string {
  return `${scope.projectSlug ?? ""}|${scope.taskKey ?? ""}`;
}

/** The dock's data URL for a scope and a selection (`null` = the newest
 *  thread here, `"new"` = start empty, an id = that thread). */
export function dockViewUrl(
  scope: { projectSlug: string | null; taskKey: string | null },
  conversationId: string | null,
  /** O39-d: the panel is open, so the transcript this loads is read. */
  seen = false,
): string {
  const params = new URLSearchParams();
  if (scope.projectSlug) params.set("project", scope.projectSlug);
  if (scope.projectSlug && scope.taskKey) params.set("task", scope.taskKey);
  if (conversationId) params.set("c", conversationId);
  if (seen) params.set("seen", "1");
  const qs = params.toString();
  return qs ? `/resources/controller?${qs}` : "/resources/controller";
}
