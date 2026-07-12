import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    // Feed route modules to Vite's dep crawler at dev-server startup. Without
    // this, a cold cache discovers the server-side CJS deps (better-sqlite3,
    // better-auth, dotenv, yaml, the agent SDKs) only when the first page
    // renders; the mid-session re-optimize then pushes "optimized
    // dependencies changed. reloading" to every open tab — a reload that
    // aborts in-flight fetches and resets form state (observed as e2e
    // 02-packet submitting the DEFAULT packet option after the reload wiped
    // its radio selection, wrongly moving VIB-142 to Done).
    unstable_optimizeDeps: true,
  },
} satisfies Config;
