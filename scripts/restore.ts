/**
 * Restore from a `npm run backup` artefact.
 *
 *   npm run restore -- --from <artefact>                     whole data root
 *   npm run restore -- --from <artefact> --force             …replacing existing data
 *   npm run restore -- --from <artefact> --file projects/<slug>/tasks/<KEY>/task.md
 *
 * WHOLE-ROOT restore replaces `state/projection.sqlite` and the canonical
 * files, so it takes the data-root WRITER lock and refuses while the app is
 * running. Anything it replaces is MOVED ASIDE, never deleted.
 *
 * SINGLE-FILE restore (`--file`) writes one markdown file and touches no
 * SQLite at all — the recovery path for a botched hand-edit that does not roll
 * users, sessions, PATs, audit and notifications back with it. It takes no
 * lock, because writing one canonical file is exactly what the runbook already
 * tells a human to do in their editor; the watcher re-projects it within ~1s.
 */
import { getEnv } from "../app/server/config/env.server";
import {
  restoreBackup,
  restoreStoreFile,
} from "../app/server/db/backup.server";
import { runWithDataRootWriterLock } from "../app/server/db/cli-lock.server";
import { errorMessage } from "../app/shared/errors";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const env = getEnv();
const artefact = flagValue("--from");
const file = flagValue("--file");

if (!artefact) {
  console.error(
    [
      "viberr restore needs an artefact: --from <backup directory>",
      "",
      "  npm run restore -- --from ./backups/viberr-backup-…            whole data root",
      "  npm run restore -- --from ./backups/viberr-backup-… --file projects/<slug>/tasks/<KEY>/task.md",
    ].join("\n"),
  );
  process.exit(1);
}

try {
  if (file) {
    // No lock: this writes one canonical markdown file and nothing else.
    const result = restoreStoreFile({
      artefact,
      dataRoot: env.VIBERR_DATA_ROOT,
      relPath: file,
    });
    console.log(result.text);
  } else {
    await runWithDataRootWriterLock(
      "`npm run restore`",
      () => {
        const result = restoreBackup({
          artefact,
          dataRoot: env.VIBERR_DATA_ROOT,
          force: process.argv.includes("--force"),
        });
        console.log(result.text);
      },
      {
        dataRoot: env.VIBERR_DATA_ROOT,
        alternative:
          "A whole-root restore replaces the database the running app is using — stop the app first. To put back a single canonical file on a live instance, use --file.",
      },
    );
  }
} catch (error) {
  console.error(
    `viberr restore failed: ${errorMessage(error)}`,
  );
  process.exit(1);
}
