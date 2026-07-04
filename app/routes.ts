import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("auth/github", "routes/auth.github.tsx"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  route("auth/google", "routes/auth.google.tsx"),
  route("auth/google/callback", "routes/auth.google.callback.tsx"),
  // TEMPORARY admin surface — replaced by the real org settings in phase 9.
  route("org/users", "routes/org.users.tsx"),
  // Placeholder until phase 9 ports the tabbed org-settings surface.
  route("org/settings", "routes/org.settings.tsx"),

  // URL-addressable PageOverlay routes (shell spec §4.6 / home spec §5.11).
  route("profile", "routes/profile.tsx"),
  route("notifications", "routes/notifications.tsx"),
  // Resource actions (fetcher targets, no UI).
  route("notifications/read", "routes/notifications.read.tsx"),
  route("prefs/theme", "routes/prefs.theme.tsx"),
  // SSE stream (Phase 6) — scoped live updates driving route revalidation.
  route("resources/events", "routes/resources.events.ts"),

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
