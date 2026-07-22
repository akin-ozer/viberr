import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    // Feed route modules to Vite's dep crawler at dev-server startup. Without
    // this, a cold cache discovers server-side dependencies only when the
    // first page renders, then reloads open tabs during re-optimization.
    unstable_optimizeDeps: true,
  },
} satisfies Config;
