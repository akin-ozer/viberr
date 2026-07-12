import { reactRouter } from "@react-router/dev/vite";
import dotenv from "dotenv";
import { defineConfig } from "vite";

// Load .env so PORT (and the rest of the app env) is available in dev.
// Values already present in the real environment always win.
dotenv.config({ quiet: true });

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    // Vite 8 resolves the tsconfig "paths" alias (~/*) natively; the
    // vite-tsconfig-paths plugin is no longer needed.
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  },
});
