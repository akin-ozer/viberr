import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),

  // better-auth request handler (sign-in/out, social, .well-known, getSession).
  // Splat so every /api/auth/* sub-path reaches better-auth's own router.
  // (OAuth callbacks are served by better-auth at /api/auth/callback/*.)
  route("api/auth/*", "routes/api.auth.$.ts"),

  // F20-30: the top-level authenticated surfaces that render OUTSIDE the
  // workspace layout — the org-settings tabs and the two URL-addressable
  // PageOverlays (docs/ui/surfaces.md). Without this wrapper the
  // ⌘K palette — which `home-page.tsx` calls "one shortcut app-wide" — never
  // reached them: a viewer on /profile had to navigate back to a shell first.
  // The pathless layout keeps their URLs unchanged; Home and the workspace
  // mount the shortcut themselves, so nothing double-registers.
  //
  // Ruling 294 gave it a second job: the app header the standalone PAGES were
  // missing (`palette-shell.tsx` renders it for the routes `standalonePageLabel`
  // names — today /org/settings, /controller (ruling 321) and /insights).
  layout("routes/palette-shell.tsx", [
    // The real tabbed org-settings surface (org profile, members, resources).
    route("org/settings", "routes/org.settings.tsx"),
    // Ruling 247: the instance controller — every signed-in user converses;
    // what it answers and applies is gated per tool call on that user's own
    // authority.
    route("controller", "routes/controller.tsx"),
    // Instance-wide agent-run analytics (org-admin).
    route("insights", "routes/insights.tsx"),
    route("profile", "routes/profile.tsx"),
    route("notifications", "routes/notifications.tsx"),
  ]),
  // Audit-log download (CSV/JSON) — org-admin gated file response. OUTSIDE the
  // layout above: it renders no component (the loader answers with the file
  // itself), so the shortcut and the header it mounts have nothing to do here.
  route("org/settings/audit-export", "routes/org.settings.audit-export.ts"),
  // Ruling 32: one board as a board file, for the Import & export tab's
  // Export buttons. Org-admin gated, outside the layout for the same reason.
  route("org/settings/board-export", "routes/org.settings.board-export.ts"),

  // Resource actions (fetcher targets, no UI).
  route("notifications/read", "routes/notifications.read.tsx"),
  // Ruling 300: the bell popover's list, loaded by the bell on intent (pages
  // carry only its counts).
  route("resources/notifications", "routes/resources.notifications.ts"),
  // Ruling 74: the unread decisions a tab's title counts and a desktop
  // notification announces, read by the root-mounted attention watcher.
  route("resources/attention", "routes/resources.attention.ts"),
  route("prefs/theme", "routes/prefs.theme.tsx"),
  // SSE stream (Phase 6) — scoped live updates driving route revalidation.
  route("resources/events", "routes/resources.events.ts"),
  // Run-log tail (Phase 8) — the dedicated logs consumer fetches lines since
  // a seq after a run.log-appended SSE reference.
  route("resources/run-log", "routes/resources.run-log.ts"),
  // Ops health probe (Phase 10) — { ok, projections, watcher }.
  route("resources/health", "routes/resources.health.ts"),
  // ⌘K palette query (R15-5) — tasks/branches/agents/projects across the
  // viewer's VISIBLE projects.
  route("resources/search", "routes/resources.search.ts"),
  // Ruling 256: the controller DOCK's data route — the view for the scope the
  // person is standing in (GET) and the send (POST). Mounted in root, so it is
  // a resource route rather than a page.
  route("resources/controller", "routes/resources.controller.ts"),
  route("resources/controller-unseen", "routes/resources.controller-unseen.ts"),
  // Ruling 258: one file a person sent with a controller message, to the two
  // who may read its conversation.
  route("resources/controller-file/:id", "routes/resources.controller-file.ts"),
  // Model + effort catalog — the agent create/edit modal fetches this to
  // populate the model and effort (reasoning) pickers per backend.
  route("resources/model-catalog", "routes/resources.model-catalog.ts"),
  // Session export — downloads a bash installer that carries a run's provider
  // transcript so the conversation can be resumed locally (same subscription).
  route("resources/session-export", "routes/resources.session-export.ts"),
  // Ruling 137: the signed-in viewer's OWN hosted sign-in session plus their
  // backend health. Profile → Agent accounts polls it while a `claude auth
  // login` / `codex login --device-auth` child is running, because that process
  // lives on the server and the browser has no other way to see what the vendor
  // printed. Keyed by the session user; it reads nobody else's sign-in.
  route("resources/backend-login", "routes/resources.backend-login.ts"),
  // Ruling 192: where an MCP server's authorization server sends an org
  // admin's browser back after an OAuth sign-in started in Instance settings.
  // A resource route: it seals the tokens and answers a plain page.
  route("resources/mcp-oauth/callback", "routes/resources.mcp-oauth.callback.ts"),

  // R19-19: one task attachment (browser-produced screenshot/PDF). A resource
  // route OUTSIDE the workspace layout — it serves raw bytes, member-only.
  route(
    "projects/:slug/tasks/:key/attachments/:file",
    "routes/task-attachment.ts",
  ),
  // Ruling 317: one kept source of a task, by its id. The same kind of route
  // as an attachment's: raw bytes, member-only, outside the workspace layout.
  route("projects/:slug/tasks/:key/sources/:id", "routes/task-source.ts"),
  // Ruling 315: the task page's Changes panel read (the delivered revision's
  // files and patches), loaded by the panel itself, member-only.
  route("projects/:slug/tasks/:key/changes", "routes/task-changes.ts"),
  // Ruling 59: the Blocked by picker's list of the project's other tasks,
  // loaded by the picker itself, member-only.
  route(
    "projects/:slug/tasks/:key/dependency-candidates",
    "routes/task-dependency-candidates.ts",
  ),

  // Bare /projects → home (the project list lives at `/`), not a 404 (N5).
  route("projects", "routes/projects.tsx"),
  // Workspace shell (rail + topbar) with the nine project views + task (the
  // rail order lives in features/shell/nav.ts and is pinned by nav.test.ts).
  route("projects/:slug", "routes/project.tsx", [
    index("routes/project._index.tsx"),
    route("board", "routes/project.board.tsx"),
    // Ruling 325: the project's epics, and one epic's page.
    route("epics", "routes/project.epics.tsx"),
    route("epics/:epicId", "routes/project.epic.tsx"),
    route("review", "routes/project.review.tsx"),
    route("controller", "routes/project.controller.tsx"),
    route("agents", "routes/project.agents.tsx"),
    route("policy", "routes/project.policy.tsx"),
    route("github", "routes/project.github.tsx"),
    route("activity", "routes/project.activity.tsx"),
    route("settings", "routes/project.settings.tsx"),
    route("tasks/:key", "routes/project.task.tsx"),
  ]),
] satisfies RouteConfig;
