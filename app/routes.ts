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
] satisfies RouteConfig;
