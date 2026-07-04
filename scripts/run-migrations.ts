/**
 * Applies pending SQL migrations to the projection database.
 * Usage: npm run migrate
 */
import { getEnv } from "../app/server/config/env.server";
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from "../app/server/db/migration-runner.server";
import {
  getProjectionDbPath,
  openDatabase,
} from "../app/server/db/sqlite.server";
import { logger } from "../app/server/logging/logger.server";

function main(): void {
  getEnv(); // fail fast on invalid environment
  const dbPath = getProjectionDbPath();
  const db = openDatabase(dbPath);
  try {
    const result = runMigrations(db, DEFAULT_MIGRATIONS_DIR);
    logger.info("migrations complete", {
      dbPath,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied,
    });
  } finally {
    db.close();
  }
}

main();
