/**
 * Manual projection rescan: reconciles the file-native store under
 * ${VIBERR_DATA_ROOT}/projects with the SQLite projections.
 *
 *   npm run rescan             — content-hash short-circuit (fast)
 *   npm run rescan -- --force  — reproject everything regardless of hashes
 */
import { getEnv } from "../app/server/config/env.server";
import { getDb } from "../app/server/db/sqlite.server";
import { rescanProjections } from "../app/server/projections/rescan.server";

const env = getEnv();
const force = process.argv.includes("--force");

const summary = rescanProjections(getDb(), {
  dataRoot: env.VIBERR_DATA_ROOT,
  force,
});

console.log(
  `viberr rescan complete: ${summary.projects} projects, ${summary.tasks} tasks — ` +
    `${summary.changed} changed, ${summary.unchanged} unchanged, ` +
    `${summary.removed} removed, ${summary.errors} errors (${summary.durationMs}ms)`,
);
