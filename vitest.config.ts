import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // *.server.test.ts files (and everything else for now) run under node.
    environment: "node",
    // setup-env seeds the required env secrets so the suite is hermetic (no
    // .env needed — CI has none); jsdom lacks <dialog> methods; the shim
    // no-ops under node.
    setupFiles: ["./test-support/setup-env.ts", "./test-support/setup-dom.ts"],
    include: [
      "app/**/*.test.{ts,tsx}",
      "db/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
});
