/**
 * Consistent snapshot of the data root — WITHOUT stopping the app.
 *
 *   npm run backup                         → ./backups/viberr-backup-<utc>
 *   npm run backup -- --out /mnt/backups   → somewhere else
 *   npm run backup -- --include-runtimes   → also the agent CLI logins
 *
 * This is the only correct way to copy a live data root. `state/projection.sqlite`
 * is a WAL database and it is PRIMARY storage — users, better-auth credentials
 * and sessions, sealed PATs, audit and notifications, none of it rebuildable
 * from the markdown — so a directory copy taken while the app runs captures a
 * main file whose newest transactions are still in the `-wal` beside it. This
 * uses SQLite's own online snapshot (`VACUUM INTO`) instead.
 *
 * It takes NO writer lock, deliberately: it is a reader rather than the second
 * writer B-FD1 refuses, and a backup that would not run against a live instance
 * would be no backup at all. It is not a second CONNECTION to a live root either
 * (ruling 23): while the app holds the writer lock the projection and its WAL
 * are copied next to the store and the snapshot is taken from the copy; the
 * artefact's manifest says which it was.
 */
import { createBackup } from "../app/server/db/backup.server";
import { getEnv } from "../app/server/config/env.server";
import { errorMessage } from "../app/shared/errors";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const env = getEnv();
const destination = flagValue("--out") ?? "./backups";

try {
  const result = createBackup({
    dataRoot: env.VIBERR_DATA_ROOT,
    destination,
    includeRuntimes: process.argv.includes("--include-runtimes"),
  });
  console.log(result.text);
} catch (error) {
  console.error(
    `viberr backup failed: ${errorMessage(error)}`,
  );
  process.exit(1);
}
