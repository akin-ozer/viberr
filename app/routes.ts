import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  // OAuth is served by better-auth's own handler at /api/auth/callback/*.
  // TEMPORARY admin surface — replaced by the real org settings in phase 9.
  route("org/users", "routes/org.users.tsx"),
  // Placeholder until phase 9 ports the tabbed org-settings surface.
  route("org/settings", "routes/org.settings.tsx"),

  // better-auth request handler (sign-in/out, social, .well-known, getSession).
  // Splat so every /api/auth/* sub-path reaches better-auth's own router.
  route("api/auth/*", "routes/api.auth.$.ts"),

  // URL-addressable PageOverlay routes (shell spec §4.6 / home spec §5.11).
  route("profile", "routes/profile.tsx"),
  route("notifications", "routes/notifications.tsx"),
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
  // Model + effort catalog — the agent create/edit modal fetches this to
  // populate the model and effort (reasoning) pickers per backend.
  route("resources/model-catalog", "routes/resources.model-catalog.ts"),
  // Session export — downloads a bash installer that carries a run's provider
  // transcript so the conversation can be resumed locally (same subscription).
  route("resources/session-export", "routes/resources.session-export.ts"),

  // Workspace shell (rail + topbar) with the seven project views + task.
  route("projects/:slug", "routes/project.tsx", [
    index("routes/project._index.tsx"),
    route("board", "routes/project.board.tsx"),
    route("review", "routes/project.review.tsx"),
    route("agents", "routes/project.agents.tsx"),
    route("policy", "routes/project.policy.tsx"),
    route("github", "routes/project.github.tsx"),
    route("activity", "routes/project.activity.tsx"),
    route("settings", "routes/project.settings.tsx"),
    route("tasks/:key", "routes/project.task.tsx"),
  ]),
] satisfies RouteConfig;
