import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // React Router's own action-origin check is off; "**" matches any origin
  // host. Since 8.3.1 it compares the browser's Origin with request.url's
  // origin, scheme included, and react-router-serve builds request.url from
  // the socket without Express "trust proxy", so behind the TLS proxy
  // deployment.md requires every https:// form post looked cross-origin.
  // assertTrustedOrigin (app/server/auth/csrf.server.ts) is the origin check
  // for every app action, including plain POSTs to resource routes, which
  // this check never saw: it accepts the configured public origin
  // (BETTER_AUTH_URL) and the request's own. The exception is /api/auth/*,
  // which better-auth checks against its trustedOrigins, built from the same
  // BETTER_AUTH_URL (ruling 683).
  allowedActionOrigins: ["**"],
  future: {
    // Feed route modules to Vite's dep crawler at dev-server startup. Without
    // this, a cold cache discovers server-side dependencies only when the
    // first page renders, then reloads open tabs during re-optimization.
    unstable_optimizeDeps: true,
  },
} satisfies Config;
