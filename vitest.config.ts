import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // *.server.test.ts files (and everything else for now) run under node.
    environment: "node",
    include: [
      "app/**/*.test.{ts,tsx}",
      "db/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
});
