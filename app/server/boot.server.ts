import { getEnv } from "./config/env.server";
import { getDb } from "./db/sqlite.server";
import { logger } from "./logging/logger.server";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

/**
 * One-time server startup: validates the environment (fail fast with a
 * clear message) and opens the database, applying pending migrations.
 * Called from entry.server.tsx module scope; safe to call repeatedly.
 */
export function bootServer(): void {
  const cache = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (cache[BOOT_KEY]) return;

  const env = getEnv();
  getDb();
  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
