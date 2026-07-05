import { seedInitialAdmin } from "./auth/seed-admin.server";
import {
  startSessionSweeper,
  sweepExpiredSessions,
} from "./auth/session.server";
import { getEnv } from "./config/env.server";
import { getDb } from "./db/sqlite.server";
import { startEventPublisher } from "./events/event-publisher.server";
import { ensureDataRootDirs } from "./files/file-store-root.server";
import { startFileWatcher } from "./files/file-watch.service.server";
import { logger } from "./logging/logger.server";
import { registerSeededLiveFromData } from "./runtimes/seed-resumer.server";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

/**
 * One-time server startup: validates the environment (fail fast with a
 * clear message), opens the database (applying pending migrations), seeds
 * the initial admin when the users table is empty, and sweeps expired
 * sessions (once now + daily interval).
 * Called from entry.server.tsx module scope; safe to call repeatedly.
 */
export function bootServer(): void {
  const cache = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (cache[BOOT_KEY]) return;

  const env = getEnv();
  ensureDataRootDirs();
  const db = getDb();

  seedInitialAdmin(db, {
    email: env.VIBERR_SEED_ADMIN_EMAIL,
    password: env.VIBERR_SEED_ADMIN_PASSWORD,
  });

  const swept = sweepExpiredSessions(db);
  if (swept > 0) logger.info("expired sessions swept at boot", { swept });
  startSessionSweeper(db);

  // SSE bridge FIRST (Phase 6): projection emitter → broker, so watcher
  // reprojects and every mutation reach connected clients from the start.
  startEventPublisher();

  // File-native store watcher (dev AND prod) — drives incremental
  // projection rebuilds when project.md / task.md files change on disk.
  startFileWatcher();

  // Seed running-run resumer (Phase 8): re-register the seeded "running"
  // runs' live lines in THIS process so the first client subscribe drips
  // them over SSE (the seed's own registration ran in a separate process).
  registerSeededLiveFromData(db);

  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
