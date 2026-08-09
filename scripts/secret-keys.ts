/**
 * Finish an encryption-key rotation (A9).
 *
 *   npm run keys -- status              how many secrets still open only under
 *                                       a RETIRED key, and whether it is safe
 *                                       to drop VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS
 *   npm run keys -- reseal              re-seal them under the current key
 *   npm run keys -- reseal --dry-run    …list the work without doing it
 *
 * Rotation is lazy: a box that opens under a retired key is re-sealed by
 * whoever reads it. That converges only for secrets somebody READS — a PAT on
 * a dormant project or an MCP credential used by one agent stays on the old
 * key indefinitely, and dropping the retired key then breaks it silently.
 *
 * `status` opens the projection READ-ONLY and takes no lock, so it answers on
 * a live instance. `reseal` writes, so it takes the data-root writer lock and
 * refuses while the app is running.
 */
import { getEnv } from "../app/server/config/env.server";
import { runWithDataRootWriterLock } from "../app/server/db/cli-lock.server";
import {
  getDb,
  getProjectionDbPath,
  openDatabaseReadOnly,
} from "../app/server/db/sqlite.server";
import {
  resealSecrets,
  secretKeyRotationStatus,
} from "../app/server/secrets/key-rotation.server";

const env = getEnv();
const command = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

if (command !== "status" && command !== "reseal") {
  console.error(
    [
      "viberr keys: expected a command.",
      "",
      "  npm run keys -- status              count secrets still on a retired key",
      "  npm run keys -- reseal              re-seal them under the current key",
      "  npm run keys -- reseal --dry-run    list the work without writing",
    ].join("\n"),
  );
  process.exit(1);
}

if (command === "status") {
  const db = openDatabaseReadOnly(getProjectionDbPath());
  try {
    console.log(secretKeyRotationStatus(db).text);
  } finally {
    db.close();
  }
} else {
  await runWithDataRootWriterLock(
    "`npm run keys -- reseal`",
    () => {
      const result = resealSecrets(getDb(), {
        dryRun: process.argv.includes("--dry-run"),
      });
      console.log(result.text);
    },
    {
      dataRoot: env.VIBERR_DATA_ROOT,
      alternative:
        "Re-sealing rewrites stored secrets — stop the app first. `npm run keys -- status` reads the same numbers and is safe while it runs.",
    },
  );
}
