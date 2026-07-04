import { reactRouter } from "@react-router/dev/vite";
import dotenv from "dotenv";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Load .env so PORT (and the rest of the app env) is available in dev.
// Values already present in the real environment always win.
dotenv.config({ quiet: true });

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  },
});
