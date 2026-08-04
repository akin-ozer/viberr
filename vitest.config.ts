import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite 8 resolves the tsconfig "paths" alias (~/*) natively; the
    // vite-tsconfig-paths plugin is no longer needed.
    tsconfigPaths: true,
  },
  test: {
    // *.server.test.ts files (and everything else for now) run under node.
    environment: "node",
    // setup-env seeds the required env secrets so the suite is hermetic (no
    // .env needed — CI has none); jsdom lacks <dialog> methods; the shim
    // no-ops under node.
    setupFiles: ["./test-support/setup-env.ts", "./test-support/setup-dom.ts"],
    // `db/**/*.test.ts` was here and had matched ZERO files since the
    // migrations were squashed — `db/` holds only 0001_baseline.sql. Dropped
    // (G10) because a glob matching nothing still advertises a convention: the
    // runner's own test lives at app/server/db/migration-runner.server.test.ts,
    // and schema behaviour belongs to the projection suites that own the tables.
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
