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
  // PageOverlays (shell spec §4.6 / home spec §5.11). Without this wrapper the
  // ⌘K palette — which `home-page.tsx` calls "one shortcut app-wide" — never
  // reached them: a viewer on /profile had to navigate back to a shell first.
  // The pathless layout keeps their URLs unchanged and mounts only the shortcut
  // + palette; Home and the workspace mount it themselves, so nothing
  // double-registers.
  layout("routes/palette-shell.tsx", [
    // The real tabbed org-settings surface (org profile, members, resources).
    route("org/settings", "routes/org.settings.tsx"),
    // Ruling 99: the instance controller — every signed-in user converses;
    // what it answers and applies is gated per tool call on that user's own
    // authority.
    route("controller", "routes/controller.tsx"),
    // Audit-log download (CSV/JSON) — org-admin gated file response.
    route("org/settings/audit-export", "routes/org.settings.audit-export.ts"),
    // Instance-wide agent-run analytics (org-admin).
    route("insights", "routes/insights.tsx"),
    route("profile", "routes/profile.tsx"),
    route("notifications", "routes/notifications.tsx"),
  ]),

  // Resource actions (fetcher targets, no UI).
  route("notifications/read", "routes/notifications.read.tsx"),
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
  // Model + effort catalog — the agent create/edit modal fetches this to
  // populate the model and effort (reasoning) pickers per backend.
  route("resources/model-catalog", "routes/resources.model-catalog.ts"),
  // Session export — downloads a bash installer that carries a run's provider
  // transcript so the conversation can be resumed locally (same subscription).
  route("resources/session-export", "routes/resources.session-export.ts"),

  // R19-19: one task attachment (browser-produced screenshot/PDF). A resource
  // route OUTSIDE the workspace layout — it serves raw bytes, member-only.
  route(
    "projects/:slug/tasks/:key/attachments/:file",
    "routes/task-attachment.ts",
  ),

  // Bare /projects → home (the project list lives at `/`), not a 404 (N5).
  route("projects", "routes/projects.tsx"),
  // Workspace shell (rail + topbar) with the seven project views + task.
  route("projects/:slug", "routes/project.tsx", [
    index("routes/project._index.tsx"),
    route("board", "routes/project.board.tsx"),
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
