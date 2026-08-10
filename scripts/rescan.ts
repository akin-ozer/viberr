/**
 * Manual projection rescan: reconciles the file-native store under
 * ${VIBERR_DATA_ROOT}/projects with the SQLite projections.
 *
 *   npm run rescan             — content-hash short-circuit (fast)
 *   npm run rescan -- --force  — reproject everything regardless of hashes
 *
 * Takes the data-root WRITER lock first (B-FD1) and refuses to run while
 * another Viberr process holds it — this command writes the same
 * `state/projection.sqlite` the server writes, and two writers on one root is
 * the failure that has already eaten this project's WAL. While the app is up,
 * use the in-app equivalent instead: Home → store strip → "Re-scan store",
 * which runs inside the locked server process.
 */
import { getEnv } from "../app/server/config/env.server";
import { runWithDataRootWriterLock } from "../app/server/db/cli-lock.server";
import { getDb } from "../app/server/db/sqlite.server";
import { untrustedFileReport } from "../app/server/files/store-check.server";
import { rescanProjections } from "../app/server/projections/rescan.server";

const env = getEnv();
const force = process.argv.includes("--force");

await runWithDataRootWriterLock(
  "`npm run rescan`",
  () => {
    const db = getDb();
    const summary = rescanProjections(db, {
      dataRoot: env.VIBERR_DATA_ROOT,
      force,
    });

    console.log(
      `viberr rescan complete: ${summary.projects} projects, ${summary.tasks} tasks — ` +
        `${summary.changed} changed, ${summary.unchanged} unchanged, ` +
        `${summary.removed} removed, ${summary.errors} errors (${summary.durationMs}ms)`,
    );

    // `errors` counts files the rebuild THREW on — which a malformed task.md
    // never does, because parsing is deliberately tolerant. So a rescan over a
    // file the app can no longer trust printed "0 errors" and said nothing.
    // Surface the untrusted files by name here, on the one command the runbook
    // tells an operator to run when the store looks wrong (gap 22).
    const report = untrustedFileReport(db);
    if (report.files.length > 0) console.log(`\n${report.text}`);
  },
  {
    dataRoot: env.VIBERR_DATA_ROOT,
    alternative:
      'The safe equivalent while the app is running is in the app: Home → store strip → "Re-scan store".',
  },
);
